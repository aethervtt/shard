import { defineResource, type World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import {
  bindingDimension,
  type CameraData,
  cameraOf,
  ForwardStateResource,
  type NodeContext,
  type NodeDescriptor,
  OPAQUE_COPY_PHASE,
  type RenderView,
  Shaders,
  sceneColor,
  viewBindGroup,
} from '@aethervtt/shard-render'
import type { WaterBodiesState } from './bodies'
import { MAX_WATER_BODIES } from './bodies'
import {
  type InfoClipmap,
  levelTexel,
  placeRings,
  ringCell,
  ringLevel,
  SurfaceRings,
} from './clipmap'
import { bakeRipples, RIPPLE_SIZE } from './ripples'
import {
  INFO_LEVELS,
  INFO_SIZE,
  MAX_RINGS,
  NO_GROUND,
  NO_WATER,
  RING_CELLS,
  WATER_UNIFORM_VEC4S,
} from './shaders'

/** The water pass: after the opaque copy, before transparent objects (0097). */
export const WATER_PHASE = OPAQUE_COPY_PHASE + 10

/** Two triangles past any clipmap level: an unbounded ocean's raster. */
const EVERYWHERE = [-1e7, -1e7, 1e7, -1e7, -1e7, 1e7, 1e7, -1e7, 1e7, 1e7, -1e7, 1e7]

/** Floats of each info level's uniform: origin (x, z, texel, level), wrap (x, z). */
const LEVEL_FLOATS = 8

/** The surface rings' index ranges: [0] the full grid (ring 0), [1 + v] a ring with hole variant v. */
function ringMesh(): {
  vertices: Float32Array
  indices: Uint16Array
  first: number[]
  count: number[]
} {
  const n = RING_CELLS
  const side = n + 1
  const vertices = new Float32Array(side * side * 2)
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      vertices[(j * side + i) * 2] = i
      vertices[(j * side + i) * 2 + 1] = j
    }
  }
  const indices: number[] = []
  const first: number[] = []
  const count: number[] = []
  const quad = (i: number, j: number) => {
    const a = j * side + i
    // Alternating diagonals, so the grid has no preferred direction.
    if ((i + j) % 2 === 0) indices.push(a, a + side, a + 1, a + 1, a + side, a + side + 1)
    else indices.push(a, a + side + 1, a + 1, a, a + side, a + side + 1)
  }
  const range = (hole: (i: number, j: number) => boolean) => {
    first.push(indices.length)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!hole(i, j)) quad(i, j)
    count.push(indices.length - first[first.length - 1]!)
  }
  range(() => false)
  const q = n / 4
  for (let v = 0; v < 4; v++) {
    const dx = v & 1
    const dz = v >> 1
    range((i, j) => i >= q + dx && i < 3 * q + dx && j >= q + dz && j < 3 * q + dz)
  }
  return { vertices, indices: Uint16Array.from(indices), first, count }
}

/** What one view keeps between frames: its rings, uniform and bind group. */
interface ViewWater {
  rings: SurfaceRings
  uniform: GpuBuffer
  data: Float32Array
  group: GPUBindGroup | undefined
  /** What the group binds: uniform version, info, opaque color, opaque depth. */
  bound: [number, unknown, unknown, unknown]
}

/** The water's GPU objects, per device: info texture, ground, meshes, ripples, pipelines. */
export class WaterGpu {
  generation = -1
  info!: GPUTexture
  bodies!: GPUTexture
  ground!: GPUTexture
  infoViews: GPUTextureView[] = []
  bodyViews: GPUTextureView[] = []
  infoArray!: GPUTextureView
  bodyArray!: GPUTextureView
  groundArray!: GPUTextureView
  levelUniforms: GpuBuffer[] = []
  levelGroups: GPUBindGroup[] = []
  levelData = new Float32Array(LEVEL_FLOATS)
  bodyVertices!: GpuBuffer
  bodyVertexCount = 0
  bodyVersion = -1
  ringVertices!: GPUBuffer
  ringIndices!: GPUBuffer
  variantFirst: number[] = []
  variantCount: number[] = []
  ripples!: GPUTexture
  repeat!: GPUSampler
  clamp!: GPUSampler
  infoLayout!: GPUBindGroupLayout
  waterLayout!: GPUBindGroupLayout
  readonly pipelines = new Map<string, GPURenderPipeline>()
  readonly views = new Map<string, ViewWater>()
  private bodyScratch = new Float32Array(0)
  /** GPU time of the last water pass (ms), when the device has timestamps. */
  lastFrame = -1

  ensure(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.generation = gpu.generation
    this.pipelines.clear()
    this.views.clear()
    this.bodyVersion = -1
    const device = gpu.device
    const array = (label: string, format: GPUTextureFormat, usage: number) =>
      device.createTexture({
        label,
        size: [INFO_SIZE, INFO_SIZE, INFO_LEVELS],
        format,
        usage,
        ...bindingDimension(gpu, '2d-array'),
      })
    const target =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    this.info = array('water/info', 'rgba32float', target)
    this.bodies = array('water/bodies', 'rg8unorm', target)
    this.ground = array(
      'water/ground',
      'r32float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    )
    const layer = (t: GPUTexture, l: number) =>
      t.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 })
    this.infoViews = []
    this.bodyViews = []
    for (let l = 0; l < INFO_LEVELS; l++) {
      this.infoViews.push(layer(this.info, l))
      this.bodyViews.push(layer(this.bodies, l))
    }
    this.infoArray = this.info.createView({ dimension: '2d-array' })
    this.bodyArray = this.bodies.createView({ dimension: '2d-array' })
    this.groundArray = this.ground.createView({ dimension: '2d-array' })
    const F = GPUShaderStage.FRAGMENT
    const V = GPUShaderStage.VERTEX
    this.infoLayout = gpu.layouts.bindGroupLayout({
      label: 'water/info',
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: F,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
      ],
    })
    this.waterLayout = gpu.layouts.bindGroupLayout({
      label: 'water/surface',
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: V | F,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        {
          binding: 2,
          visibility: F,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        { binding: 3, visibility: F, texture: { sampleType: 'float' } },
        { binding: 4, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: F, texture: { sampleType: 'float' } },
        { binding: 6, visibility: F, sampler: { type: 'filtering' } },
        { binding: 7, visibility: F, sampler: { type: 'filtering' } },
      ],
    })
    this.levelUniforms = []
    this.levelGroups = []
    for (let l = 0; l < INFO_LEVELS; l++) {
      const u = new GpuBuffer(gpu, {
        label: `water/info/${l}`,
        usage: GPUBufferUsage.UNIFORM,
        size: LEVEL_FLOATS * 4,
      })
      this.levelUniforms.push(u)
      this.levelGroups.push(
        device.createBindGroup({
          label: `water/info/${l}`,
          layout: this.infoLayout,
          entries: [
            { binding: 0, resource: { buffer: u.buffer } },
            { binding: 1, resource: this.groundArray },
          ],
        }),
      )
    }
    this.bodyVertices = new GpuBuffer(gpu, {
      label: 'water/body-triangles',
      usage: GPUBufferUsage.VERTEX,
      size: 1024,
    })
    const mesh = ringMesh()
    this.ringVertices = device.createBuffer({
      label: 'water/rings',
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(this.ringVertices, 0, mesh.vertices)
    this.ringIndices = device.createBuffer({
      label: 'water/rings',
      size: Math.ceil(mesh.indices.byteLength / 4) * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    // Six indices a quad: always a whole number of 4-byte words.
    device.queue.writeBuffer(this.ringIndices, 0, mesh.indices)
    this.variantFirst = mesh.first
    this.variantCount = mesh.count
    const levels = bakeRipples()
    this.ripples = device.createTexture({
      label: 'water/ripples',
      size: [RIPPLE_SIZE, RIPPLE_SIZE],
      format: 'rgba8unorm',
      mipLevelCount: levels.length,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    for (let k = 0; k < levels.length; k++) {
      const w = Math.max(1, RIPPLE_SIZE >> k)
      device.queue.writeTexture(
        { texture: this.ripples, mipLevel: k },
        levels[k]!,
        { bytesPerRow: w * 4 },
        [w, w],
      )
    }
    this.repeat = gpu.layouts.sampler({
      label: 'water/repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    })
    this.clamp = gpu.layouts.sampler({
      label: 'water/clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    // The ground starts unknown everywhere.
    const blank = new Float32Array(INFO_SIZE * INFO_SIZE).fill(NO_GROUND)
    for (let l = 0; l < INFO_LEVELS; l++) this.uploadGround(gpu, l, blank)
  }

  uploadGround(gpu: GpuContext, level: number, data: Float32Array): void {
    gpu.device.queue.writeTexture(
      { texture: this.ground, origin: [0, 0, level] },
      data,
      { bytesPerRow: INFO_SIZE * 4, rowsPerImage: INFO_SIZE },
      [INFO_SIZE, INFO_SIZE, 1],
    )
  }

  /** The bodies' triangles in draw order (x, z, level, slot), on change only. */
  uploadBodies(state: WaterBodiesState): void {
    if (state.version === this.bodyVersion) return
    this.bodyVersion = state.version
    let floats = 0
    for (let i = 0; i < state.count; i++) {
      const s = state.sorted[i]!.shape
      floats += s ? (s.triangles.length / 2) * 4 : 6 * 4
    }
    if (this.bodyScratch.length < floats) this.bodyScratch = new Float32Array(floats * 2)
    const out = this.bodyScratch
    let o = 0
    for (let i = 0; i < state.count; i++) {
      const r = state.sorted[i]!
      const t = r.shape?.triangles
      if (!t) {
        // An unbounded ocean covers everything: two triangles far past any level.
        for (let k = 0; k < 12; k += 2) {
          out[o++] = EVERYWHERE[k]!
          out[o++] = EVERYWHERE[k + 1]!
          out[o++] = r.level
          out[o++] = i
        }
        continue
      }
      for (let k = 0; k < t.length; k += 2) {
        out[o++] = t[k]!
        out[o++] = t[k + 1]!
        out[o++] = r.level
        out[o++] = i
      }
    }
    this.bodyVertexCount = o / 4
    if (o > 0) this.bodyVertices.write(out, 0, 0, o)
  }

  view(gpu: GpuContext, name: string): ViewWater {
    let v = this.views.get(name)
    if (!v) {
      const data = new Float32Array(WATER_UNIFORM_VEC4S * 4)
      v = {
        rings: new SurfaceRings(),
        uniform: new GpuBuffer(gpu, {
          label: `water/${name}`,
          usage: GPUBufferUsage.UNIFORM,
          size: data.byteLength,
        }),
        data,
        group: undefined,
        bound: [-1, undefined, undefined, undefined],
      }
      this.views.set(name, v)
    }
    return v
  }
}

/** Writes a level's info uniform: its corner, texel size, index, and the ground's toroidal offset. */
function writeLevel(water: WaterGpu, clip: InfoClipmap, l: number): void {
  const d = water.levelData
  const ox = clip.origin[l * 2]!
  const oz = clip.origin[l * 2 + 1]!
  d[0] = clip.corner(l, 0)
  d[1] = clip.corner(l, 1)
  d[2] = levelTexel(l)
  d[3] = l
  d[4] = ((ox % INFO_SIZE) + INFO_SIZE) % INFO_SIZE
  d[5] = ((oz % INFO_SIZE) + INFO_SIZE) % INFO_SIZE
  d[6] = 0
  d[7] = 0
  water.levelUniforms[l]!.write(d)
}

const infoColor: GPURenderPassColorAttachment = {
  view: undefined as unknown as GPUTextureView,
  loadOp: 'clear',
  clearValue: { r: NO_WATER, g: NO_GROUND, b: 0, a: 0 },
  storeOp: 'store',
}
const bodyColor: GPURenderPassColorAttachment = {
  view: undefined as unknown as GPUTextureView,
  loadOp: 'clear',
  clearValue: { r: 0, g: 0, b: 0, a: 0 },
  storeOp: 'store',
}
const infoPass: GPURenderPassDescriptor = {
  label: 'water/info',
  colorAttachments: [infoColor, bodyColor],
}

function infoPipelines(ctx: NodeContext, water: WaterGpu) {
  const gpu = ctx.gpu
  let ground = water.pipelines.get('info/ground')
  let bodies = water.pipelines.get('info/bodies')
  if (ground && bodies) return { ground, bodies }
  const shaders = ctx.world.resource(Shaders)
  const fs = shaders.module(gpu, { root: 'water::info' })
  const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
  if (!fs || !vs) {
    gpu.pipelines.skipped++
    return undefined
  }
  const layout = gpu.layouts.pipelineLayout({
    label: 'water/info',
    bindGroupLayouts: [water.infoLayout],
  })
  ground ??= gpu.pipelines.render({
    label: 'water/info/ground',
    layout,
    vertex: { module: vs, entryPoint: 'vs' },
    fragment: {
      module: fs,
      entryPoint: 'ground_copy',
      // Both targets whole: compatibility mode (0064) wants one write mask for every target, and
      // this is the level's first draw after its clear.
      targets: [{ format: 'rgba32float' }, { format: 'rg8unorm' }],
    },
  })
  bodies ??= gpu.pipelines.render({
    label: 'water/info/bodies',
    layout,
    vertex: {
      module: fs,
      entryPoint: 'body_vs',
      buffers: [
        {
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        },
      ],
    },
    fragment: {
      module: fs,
      entryPoint: 'body_fs',
      targets: [
        { format: 'rgba32float', writeMask: GPUColorWrite.RED },
        { format: 'rg8unorm', writeMask: GPUColorWrite.RED },
      ],
    },
  })
  if (ground) water.pipelines.set('info/ground', ground)
  if (bodies) water.pipelines.set('info/bodies', bodies)
  return ground && bodies ? { ground, bodies } : undefined
}

/**
 * Draws the info texture's levels that changed (0097): each cleared to no water, the ground
 * copied in, then every body's triangles in priority order (later ones overwrite), writing the
 * surface height and the body's slot. Once a frame, for every view.
 */
export function infoNode(
  water: WaterGpu,
  clip: InfoClipmap,
  bodies: () => WaterBodiesState,
  active: (view: RenderView) => boolean,
): NodeDescriptor {
  return {
    kind: 'raw',
    phase: 0,
    enabled: active,
    writes: ['water-info'],
    run: (ctx) => {
      const gpu = ctx.gpu
      water.ensure(gpu)
      const state = bodies()
      for (let l = 0; l < INFO_LEVELS; l++) {
        if (!clip.groundChanged[l]) continue
        clip.groundChanged[l] = 0
        water.uploadGround(gpu, l, clip.ground[l]!)
      }
      let any = false
      for (let l = 0; l < INFO_LEVELS; l++) if (clip.dirty[l]) any = true
      if (!any) return
      const p = infoPipelines(ctx, water)
      if (!p) return
      water.uploadBodies(state)
      let rebuilt = 0
      for (let l = 0; l < INFO_LEVELS; l++) {
        if (!clip.dirty[l]) continue
        clip.dirty[l] = 0
        rebuilt++
        writeLevel(water, clip, l)
        infoColor.view = water.infoViews[l]!
        bodyColor.view = water.bodyViews[l]!
        infoPass.timestampWrites = rebuilt === 1 ? ctx.timestamps('water/info') : undefined
        const pass = ctx.encoder.beginRenderPass(infoPass)
        pass.setBindGroup(0, water.levelGroups[l]!)
        pass.setPipeline(p.ground)
        pass.draw(3)
        if (water.bodyVertexCount > 0) {
          pass.setPipeline(p.bodies)
          pass.setVertexBuffer(0, water.bodyVertices.buffer)
          pass.draw(water.bodyVertexCount)
        }
        pass.end()
      }
      clip.rebuilds += rebuilt
      clip.totalRebuilds += rebuilt
    },
  }
}

/**
 * Fills a view's water uniform: its rings, the info levels, the far surface, and every drawn
 * body's optics. No allocation.
 */
function writeUniform(
  v: ViewWater,
  cam: CameraData,
  clip: InfoClipmap,
  state: WaterBodiesState,
  mips: number,
): void {
  const d = v.data
  const rings = v.rings
  placeRings(rings, state, cam.position[0]!, cam.position[2]!)
  for (let k = 0; k < MAX_RINGS; k++) {
    const o = k * 8
    const s = ringCell(k)
    d[o] = rings.centre[k * 2]!
    d[o + 1] = rings.centre[k * 2 + 1]!
    d[o + 2] = s
    d[o + 3] = k === rings.last ? 1 : 0
    d[o + 4] = ringLevel(s)
    d[o + 5] = 0
    d[o + 6] = 0
    d[o + 7] = 0
  }
  let o = MAX_RINGS * 8
  for (let l = 0; l < INFO_LEVELS; l++) {
    const t = levelTexel(l)
    d[o] = clip.corner(l, 0)
    d[o + 1] = clip.corner(l, 1)
    d[o + 2] = t
    d[o + 3] = 1 / t
    o += 4
  }
  let far = -1
  for (let i = 0; i < state.count; i++) if (!state.sorted[i]!.shape) far = i
  d[o] = far >= 0 ? state.farLevel : NO_WATER
  d[o + 1] = state.lowest - 20
  d[o + 2] = RING_CELLS
  d[o + 3] = far
  d[o + 4] = mips
  d.fill(0, o + 5, o + 16)
  o += 16
  for (let i = 0; i < MAX_WATER_BODIES; i++) {
    const r = i < state.count ? state.sorted[i]! : undefined
    if (!r) {
      d.fill(0, o, o + 16)
      o += 16
      continue
    }
    const x = r.optics
    d[o] = x.absorption[0]
    d[o + 1] = x.absorption[1]
    d[o + 2] = x.absorption[2]
    d[o + 3] = x.phase
    d[o + 4] = x.scattering[0]
    d[o + 5] = x.scattering[1]
    d[o + 6] = x.scattering[2]
    d[o + 7] = x.roughness
    const w = r.windDirection
    const len = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2])
    const k = r.windOwn && len > 0 ? r.windSpeed / len : 0
    d[o + 8] = w[0] * k
    d[o + 9] = w[1] * k
    d[o + 10] = w[2] * k
    d[o + 11] = r.windOwn ? 1 : 0
    d[o + 12] = x.ripples
    d[o + 13] = r.level
    d[o + 14] = 0
    d[o + 15] = 0
    o += 16
  }
}

function surfacePipeline(
  ctx: NodeContext,
  water: WaterGpu,
  viewLayout: GPUBindGroupLayout,
  msaa: number,
  alpha: boolean,
  depthOnly: boolean,
): GPURenderPipeline | undefined {
  const key = depthOnly ? 'surface/depth' : `surface/${msaa}${alpha ? '/alpha' : ''}`
  const cached = water.pipelines.get(key)
  if (cached) return cached
  const gpu = ctx.gpu
  const module = ctx.world.resource(Shaders).module(gpu, { root: 'water::surface' })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const pipeline = gpu.pipelines.render({
    label: `water/${key}`,
    layout: gpu.layouts.pipelineLayout({
      label: 'water/surface',
      bindGroupLayouts: [viewLayout, water.waterLayout],
    }),
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
      ],
    },
    fragment: depthOnly
      ? { module, entryPoint: 'fs_depth', targets: [] }
      : {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format: 'rgba16float',
              // Alpha is how much water there is: thin water fades into what's under it.
              blend: {
                color: {
                  srcFactor: 'src-alpha',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
                alpha: alpha
                  ? { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                  : { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: depthOnly ? 1 : msaa },
  })
  if (pipeline) water.pipelines.set(key, pipeline)
  return pipeline
}

function drawRings(pass: GPURenderPassEncoder, water: WaterGpu, rings: SurfaceRings): void {
  pass.setVertexBuffer(0, water.ringVertices)
  pass.setIndexBuffer(water.ringIndices, 'uint16')
  for (let i = 0; i < rings.count; i++) {
    const k = rings.draws[i]!
    const v = rings.variant[k]! + 1
    pass.drawIndexed(water.variantCount[v]!, 1, water.variantFirst[v]!, 0, k)
  }
}

/** The view's water bind group, rebuilt when what it binds changes. */
function surfaceGroup(ctx: NodeContext, water: WaterGpu, v: ViewWater): GPUBindGroup {
  const color = ctx.texture('opaque-color')
  const depth = ctx.texture('opaque-depth')
  const b = v.bound
  if (
    !v.group ||
    b[0] !== v.uniform.version ||
    b[1] !== water.info ||
    b[2] !== color ||
    b[3] !== depth
  ) {
    b[0] = v.uniform.version
    b[1] = water.info
    b[2] = color
    b[3] = depth
    v.group = ctx.gpu.device.createBindGroup({
      label: `water/${ctx.view.name}`,
      layout: water.waterLayout,
      entries: [
        { binding: 0, resource: { buffer: v.uniform.buffer } },
        { binding: 1, resource: water.infoArray },
        { binding: 2, resource: water.bodyArray },
        { binding: 3, resource: color.createView() },
        { binding: 4, resource: depth.createView() },
        { binding: 5, resource: water.ripples.createView() },
        { binding: 6, resource: water.repeat },
        { binding: 7, resource: water.clamp },
      ],
    })
  }
  return v.group
}

/**
 * The water pass (0097): the shared surface for every body, shaded completely (refraction of the
 * opaque copy, absorption and scattering over the water's thickness, Fresnel reflection of the
 * environment, each sun's highlight and shadow, wind ripples), writing depth so fog and aerial
 * perspective haze it by its own distance. After the opaque copy, before transparent objects.
 */
export function waterNode(
  water: WaterGpu,
  clip: InfoClipmap,
  bodies: () => WaterBodiesState,
  active: (view: RenderView) => boolean,
): NodeDescriptor {
  return {
    kind: 'render',
    phase: WATER_PHASE,
    // Its own render pass, so its GPU time is its own (gpu:water).
    ownPass: true,
    enabled: active,
    reads: ['opaque-color', 'opaque-depth', 'water-info', 'environment', 'shadow-cascades'],
    writes: ['scene-color', 'scene-depth', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth' },
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      const state = ctx.world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      if (!cam || !pv) return
      const gpu = ctx.gpu
      water.ensure(gpu)
      const pipeline = surfacePipeline(
        ctx,
        water,
        state.layouts.view,
        cam.msaa,
        cam.alphaOutput,
        false,
      )
      if (!pipeline) return
      const v = water.view(gpu, ctx.view.name)
      writeUniform(v, cam, clip, bodies(), ctx.texture('opaque-color').mipLevelCount)
      v.uniform.write(v.data)
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewBindGroup(gpu, ctx.world, pv, cam))
      pass.setBindGroup(1, surfaceGroup(ctx, water, v))
      drawRings(pass, water, v.rings)
    },
  }
}

/**
 * Baseline (0064) with MSAA: later passes read `depth` from the single-sample prepass, which has no
 * water in it. This draws the surface's depth into it too, so fog and aerial perspective see the
 * water there as well. Only when something reads `depth`.
 */
export function waterDepthNode(
  water: WaterGpu,
  baseline: boolean,
  active: (view: RenderView) => boolean,
): NodeDescriptor {
  return {
    kind: 'render',
    phase: WATER_PHASE,
    enabled: (view: RenderView) => baseline && (cameraOf(view)?.msaa ?? 1) > 1 && active(view),
    reads: ['water-info', 'opaque-color', 'opaque-depth'],
    writes: ['depth'],
    after: ['water'],
    depth: { resource: 'depth' },
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      const state = ctx.world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      if (!cam || !pv) return
      const gpu = ctx.gpu
      water.ensure(gpu)
      const pipeline = surfacePipeline(ctx, water, state.layouts.view, 1, false, true)
      if (!pipeline) return
      // The surface pass wrote this view's uniform and group earlier in the frame.
      const v = water.views.get(ctx.view.name)
      if (!v?.group) return
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewBindGroup(gpu, ctx.world, pv, cam))
      pass.setBindGroup(1, v.group)
      drawRings(pass, water, v.rings)
    },
  }
}

export interface WaterRenderState {
  gpu: WaterGpu
  clip: InfoClipmap
}

export const WaterRender = defineResource<WaterRenderState>('water/Render', {
  description:
    'The water’s render side (0097): the info clipmap around the camera, its GPU textures, the surface rings and ripples.',
})

/** The water's render side, when the app renders. */
export function waterRenderOf(world: World): WaterRenderState | undefined {
  return world.tryResource(WaterRender)
}
