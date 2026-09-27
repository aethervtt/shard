import { defineResource, defineSystem, type Entity, mat4, type World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { type AtmosphereRecord, Atmospheres, type CameraAtmosphere } from './atmosphere'
import { MULTISCATTER_SIZE, TRANSMITTANCE_H, TRANSMITTANCE_W } from './atmosphere-model'
import {
  type CameraEnvironment,
  type Environment,
  Environments,
  environmentBakers,
} from './environment'
import { ForwardStateResource, sceneColor } from './forward'
import { type NodeContext, type NodeDescriptor, RenderPhase, type RenderView } from './graph'
import { Gpu, Graph, Shaders, Views } from './plugin'
import { hasEffect, PostEffect } from './post'
import { type CameraData, cameraOf } from './view'

/** Atmospheres whose LUTs stay on the GPU at once (layers of the LUT arrays). */
export const LUT_LAYERS = 8

/** AtmosphereView uniform: 4 atmospheres, 2 suns, info, frame, froxels, inverse view-projection. */
const PARAMS_FLOATS = 32
const VIEW_FLOATS = 184
const O_SUNS = 128
const O_INFO = 144
const O_FRAME = 148
const O_FROXELS = 160
const O_INV = 164
const O_CAMERA = 180

/** Per camera: its uniform, sky-view LUT, and aerial-perspective froxels. */
interface CameraGpu {
  uniform: GpuBuffer
  data: Float32Array
  skyView: GPUTexture | undefined
  scatter: GPUTexture | undefined
  transmittance: GPUTexture | undefined
  /** The frame the sky-view and froxels were last computed. */
  computed: number
  generation: number
  seen: number
}

export class AtmosphereGpu {
  generation = -1
  transmittance!: GPUTexture
  multiscatter!: GPUTexture
  transmittanceArray!: GPUTextureView
  multiscatterArray!: GPUTextureView
  clamp!: GPUSampler
  repeat!: GPUSampler
  /** The record in each layer, and the frame it was last listed. */
  readonly owners: (AtmosphereRecord | undefined)[] = new Array(LUT_LAYERS).fill(undefined)
  readonly used = new Int32Array(LUT_LAYERS).fill(-1000)
  readonly params: GpuBuffer[] = []
  readonly cameras = new Map<Entity, CameraGpu>()
  /** LUT recomputations so far (describe, and tests that nothing recomputes per frame). */
  lutComputes = 0
  lutFrame = -1
  frame = 0
  readonly pipelines = new Map<string, GPUComputePipeline | GPURenderPipeline>()
  layouts: Record<string, GPUBindGroupLayout> | undefined
  private readonly groups = new Map<string, { key: string; group: GPUBindGroup }>()

  ensure(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.generation = gpu.generation
    const usage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
    this.transmittance = gpu.device.createTexture({
      label: 'atmosphere/transmittance',
      size: [TRANSMITTANCE_W, TRANSMITTANCE_H, LUT_LAYERS],
      format: 'rgba16float',
      usage,
    })
    this.multiscatter = gpu.device.createTexture({
      label: 'atmosphere/multiscatter',
      size: [MULTISCATTER_SIZE, MULTISCATTER_SIZE, LUT_LAYERS],
      format: 'rgba16float',
      usage,
    })
    this.transmittanceArray = this.transmittance.createView({ dimension: '2d-array' })
    this.multiscatterArray = this.multiscatter.createView({ dimension: '2d-array' })
    this.clamp = gpu.device.createSampler({
      label: 'atmosphere/clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    })
    this.repeat = gpu.device.createSampler({
      label: 'atmosphere/repeat-u',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    })
    this.params.length = 0
    for (let i = 0; i < LUT_LAYERS; i++) {
      this.params.push(
        new GpuBuffer(gpu, {
          label: `atmosphere/params${i}`,
          usage: GPUBufferUsage.UNIFORM,
          size: PARAMS_FLOATS * 4,
        }),
      )
    }
    this.owners.fill(undefined)
    this.cameras.clear()
    this.pipelines.clear()
    this.groups.clear()
    this.layouts = undefined
  }

  /** A layer for a record: its own, a free one, or the least recently used. */
  assign(rec: AtmosphereRecord): void {
    if (rec.layer >= 0 && this.owners[rec.layer] === rec) {
      this.used[rec.layer] = this.frame
      return
    }
    let best = 0
    for (let i = 0; i < LUT_LAYERS; i++) {
      if (!this.owners[i]) {
        best = i
        break
      }
      if (this.used[i]! < this.used[best]!) best = i
    }
    const old = this.owners[best]
    if (old) old.layer = -1
    this.owners[best] = rec
    this.used[best] = this.frame
    rec.layer = best
    rec.layerVersion = -1
  }

  camera(gpu: GpuContext, entity: Entity): CameraGpu {
    let c = this.cameras.get(entity)
    if (!c) {
      c = {
        uniform: new GpuBuffer(gpu, {
          label: `atmosphere/view${entity}`,
          usage: GPUBufferUsage.UNIFORM,
          size: VIEW_FLOATS * 4,
        }),
        data: new Float32Array(VIEW_FLOATS),
        skyView: undefined,
        scatter: undefined,
        transmittance: undefined,
        computed: -1,
        generation: gpu.generation,
        seen: 0,
      }
      this.cameras.set(entity, c)
    }
    c.seen = this.frame
    return c
  }

  group(
    gpu: GpuContext,
    slot: string,
    key: string,
    layout: GPUBindGroupLayout,
    entries: () => GPUBindGroupEntry[],
  ): GPUBindGroup {
    let g = this.groups.get(slot)
    if (!g || g.key !== key) {
      g = { key, group: gpu.device.createBindGroup({ label: slot, layout, entries: entries() }) }
      this.groups.set(slot, g)
    }
    return g.group
  }
}

export const AtmosphereGpuResource = defineResource<AtmosphereGpu>('render/AtmosphereGpu', {
  description: 'Atmosphere LUTs, per-camera sky-view LUTs and froxels, and their pipelines.',
  init: () => new AtmosphereGpu(),
})

// --- packing ---------------------------------------------------------------------------------

/** Writes a record's parameters (and the camera's origin in it) at `o`. */
function packParams(
  rec: AtmosphereRecord,
  out: Float32Array,
  o: number,
  origin: Float64Array | undefined,
  oi: number,
): void {
  const m = rec.model
  out[o] = m.bottom
  out[o + 1] = m.top
  out[o + 2] = m.ground
  out[o + 3] = m.intensity
  out[o + 4] = m.rayleigh[0]!
  out[o + 5] = m.rayleigh[1]!
  out[o + 6] = m.rayleigh[2]!
  out[o + 7] = m.rayleighInvScale
  out[o + 8] = m.mieScattering
  out[o + 9] = m.mieAbsorption
  out[o + 10] = m.mieInvScale
  out[o + 11] = Math.max(rec.layer, 0)
  out[o + 12] = m.mieG[0]!
  out[o + 13] = m.mieG[1]!
  out[o + 14] = m.mieG[2]!
  out[o + 15] = 0
  out[o + 16] = m.absorption[0]!
  out[o + 17] = m.absorption[1]!
  out[o + 18] = m.absorption[2]!
  out[o + 19] = m.absorptionCenter
  out[o + 20] = m.absorptionWidth
  out[o + 21] = 0
  out[o + 22] = 0
  out[o + 23] = 0
  out[o + 24] = m.albedo[0]!
  out[o + 25] = m.albedo[1]!
  out[o + 26] = m.albedo[2]!
  out[o + 27] = 0
  out[o + 28] = origin ? origin[oi]! : 0
  out[o + 29] = origin ? origin[oi + 1]! : 0
  out[o + 30] = origin ? origin[oi + 2]! : 0
  out[o + 31] = origin ? origin[oi + 3]! : 0
}

const paramScratch = new Float32Array(PARAMS_FLOATS)
const rotView = mat4.create()
const relViewProj = mat4.create()
const relInverse = mat4.create()

/**
 * The inverse of the view-projection without the camera's translation: it maps clip space to
 * camera-relative positions, precise however far the camera is from the origin.
 */
function relativeInverse(cam: CameraData, out: Float32Array): Float32Array {
  mat4.copy(rotView, cam.view)
  rotView[12] = 0
  rotView[13] = 0
  rotView[14] = 0
  mat4.multiply(relViewProj, cam.proj, rotView)
  return mat4.invert(out, relViewProj) ?? out
}

function packView(ca: CameraAtmosphere, cam: CameraData, c: CameraGpu, out: Float32Array): void {
  out.fill(0)
  // Nothing until every LUT has been computed once (the first frame, and while shaders compile).
  for (const rec of ca.list) if (rec.layerVersion < 0) return
  const n = Math.min(ca.list.length, 4)
  for (let i = 0; i < n; i++) packParams(ca.list[i]!, out, i * PARAMS_FLOATS, ca.origins, i * 4)
  out.set(ca.suns.data.subarray(0, 16), O_SUNS)
  const primary = ca.primary ? ca.list.indexOf(ca.primary) : -1
  out[O_INFO] = n
  out[O_INFO + 1] = primary
  out[O_INFO + 2] = ca.suns.count
  // Aerial perspective from inside needs the froxels computed at least once.
  out[O_INFO + 3] = ca.aerialPerspective && (!ca.inside || c.computed >= 0) ? 1 : 0
  for (let k = 0; k < 3; k++) {
    out[O_FRAME + k] = ca.frame[k]!
    out[O_FRAME + 4 + k] = ca.frame[3 + k]!
    out[O_FRAME + 8 + k] = ca.frame[6 + k]!
  }
  const maxD = ca.maxDistance / 1000
  const d0 = maxD / 64
  out[O_FROXELS] = ca.inside ? maxD : 0
  out[O_FROXELS + 1] = d0
  out[O_FROXELS + 2] = ca.froxels[2]
  out[O_FROXELS + 3] = 1 / Math.log(1 + maxD / d0)
  out.set(relativeInverse(cam, relInverse), O_INV)
  out[O_CAMERA] = cam.position[0]!
  out[O_CAMERA + 1] = cam.position[1]!
  out[O_CAMERA + 2] = cam.position[2]!
  out[O_CAMERA + 3] = cam.exposure
}

/**
 * Gives every listed atmosphere a LUT layer and uploads each camera's AtmosphereView uniform, and
 * its sky-view and froxel textures at the right sizes.
 */
export const uploadAtmospheres = defineSystem({
  name: 'render/atmosphere-upload',
  description: "Assigns atmosphere LUT layers and uploads each camera's atmosphere uniform.",
  run: (_, world) => {
    const gpuState = world.resource(AtmosphereGpuResource)
    const store = world.resource(Atmospheres)
    const gpu = world.tryResource(Gpu)
    if (!gpu) return
    gpuState.ensure(gpu)
    gpuState.frame++
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      const ca = view.data.atmosphere as CameraAtmosphere | undefined
      if (!cam || !ca) continue
      for (const rec of ca.list) gpuState.assign(rec)
      const c = gpuState.camera(gpu, cam.entity)
      packView(ca, cam, c, c.data)
      c.uniform.write(c.data)
      if (ca.primary && ca.inside) ensureViewTextures(gpu, c, ca)
    }
    for (const [e, c] of gpuState.cameras) {
      if (gpuState.frame - c.seen > 120 || !store.cameras.has(e)) {
        c.uniform.destroy()
        c.skyView?.destroy()
        c.scatter?.destroy()
        c.transmittance?.destroy()
        gpuState.cameras.delete(e)
      }
    }
  },
})

function ensureViewTextures(gpu: GpuContext, c: CameraGpu, ca: CameraAtmosphere): void {
  const [sw, sh] = ca.skyViewSize
  if (
    !c.skyView ||
    c.generation !== gpu.generation ||
    c.skyView.width !== sw ||
    c.skyView.height !== sh
  ) {
    c.skyView?.destroy()
    c.skyView = gpu.device.createTexture({
      label: 'atmosphere/sky-view',
      size: [sw, sh],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
  }
  const [fx, fy, fz] = ca.froxels
  if (
    !c.scatter ||
    c.generation !== gpu.generation ||
    c.scatter.width !== fx ||
    c.scatter.height !== fy ||
    c.scatter.depthOrArrayLayers !== fz
  ) {
    c.scatter?.destroy()
    c.transmittance?.destroy()
    const desc: GPUTextureDescriptor = {
      label: 'atmosphere/froxels',
      size: [fx, fy, fz],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    }
    c.scatter = gpu.device.createTexture(desc)
    c.transmittance = gpu.device.createTexture({
      ...desc,
      label: 'atmosphere/froxel-transmittance',
    })
  }
  c.generation = gpu.generation
}

// --- pipelines -------------------------------------------------------------------------------

function layouts(gpu: GpuContext, s: AtmosphereGpu): Record<string, GPUBindGroupLayout> {
  if (s.layouts) return s.layouts
  const C = GPUShaderStage.COMPUTE
  const F = GPUShaderStage.FRAGMENT
  const uniform = (binding: number, visibility: number) => ({
    binding,
    visibility,
    buffer: { type: 'uniform' as const },
  })
  const array = (binding: number, visibility: number) => ({
    binding,
    visibility,
    texture: { sampleType: 'float' as const, viewDimension: '2d-array' as const },
  })
  const filtering = (binding: number, visibility: number) => ({
    binding,
    visibility,
    sampler: { type: 'filtering' as const },
  })
  const storage = (binding: number, viewDimension: GPUTextureViewDimension) => ({
    binding,
    visibility: C,
    storageTexture: {
      access: 'write-only' as const,
      format: 'rgba16float' as const,
      viewDimension,
    },
  })
  s.layouts = {
    transmittance: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/transmittance',
      entries: [uniform(0, C), storage(1, '2d')],
    }),
    multiscatter: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/multiscatter',
      entries: [uniform(0, C), array(1, C), filtering(2, C), storage(3, '2d')],
    }),
    skyView: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/sky-view',
      entries: [uniform(0, C), array(1, C), array(2, C), filtering(3, C), storage(4, '2d')],
    }),
    aerial: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/aerial',
      entries: [
        uniform(0, C),
        array(1, C),
        array(2, C),
        filtering(3, C),
        storage(4, '3d'),
        storage(5, '3d'),
      ],
    }),
    bake: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/bake',
      entries: [uniform(0, C), array(1, C), array(2, C), filtering(3, C), storage(4, '2d-array')],
    }),
    composite: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/composite',
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: F, texture: { sampleType: 'depth' } },
        uniform(2, F),
        array(3, F),
        array(4, F),
        filtering(5, F),
        { binding: 6, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 7, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
      ],
    }),
    viewOnly: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/view',
      entries: [uniform(0, GPUShaderStage.VERTEX | F)],
    }),
    sky: gpu.layouts.bindGroupLayout({
      label: 'atmosphere/sky',
      entries: [
        uniform(0, F),
        array(1, F),
        array(2, F),
        filtering(3, F),
        { binding: 4, visibility: F, texture: { sampleType: 'float' } },
        filtering(5, F),
        { binding: 6, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
        uniform(7, F),
      ],
    }),
  }
  return s.layouts
}

function compute(
  ctx: NodeContext,
  s: AtmosphereGpu,
  name: string,
  root: string,
): GPUComputePipeline | undefined {
  const cached = s.pipelines.get(name) as GPUComputePipeline | undefined
  if (cached) return cached
  const gpu = ctx.gpu
  const module = ctx.world.resource(Shaders).module(gpu, { root })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const layout = layouts(gpu, s)[name]!
  const p = gpu.pipelines.compute({
    label: `atmosphere/${name}`,
    layout: gpu.layouts.pipelineLayout({ label: `atmosphere/${name}`, bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'main' },
  })
  if (p) s.pipelines.set(name, p)
  return p
}

// --- nodes -----------------------------------------------------------------------------------

const hasAtmosphere = (view: RenderView) => view.data.atmosphere !== undefined

/**
 * Transmittance and multiple-scattering LUTs for every atmosphere whose parameters changed (or
 * that just got a layer). Once per frame, before the environment bake and any view.
 */
function lutNode(): NodeDescriptor {
  return {
    kind: 'raw',
    phase: RenderPhase.Setup,
    enabled: hasAtmosphere,
    writes: ['atmosphere-luts'],
    run: (ctx) => {
      const s = ctx.world.resource(AtmosphereGpuResource)
      if (s.lutFrame === s.frame) return
      let dirty = false
      for (const rec of s.owners) if (rec && rec.layerVersion !== rec.version) dirty = true
      if (!dirty) {
        s.lutFrame = s.frame
        return
      }
      const t = compute(ctx, s, 'transmittance', 'shard::atmosphere::transmittance_lut')
      const m = compute(ctx, s, 'multiscatter', 'shard::atmosphere::multiscatter_lut')
      if (!t || !m) return
      s.lutFrame = s.frame
      const gpu = ctx.gpu
      const l = layouts(gpu, s)
      const pass = ctx.encoder.beginComputePass({
        label: 'atmosphere/luts',
        timestampWrites: ctx.timestamps('atmosphere/luts'),
      })
      for (let i = 0; i < LUT_LAYERS; i++) {
        const rec = s.owners[i]
        if (!rec || rec.layerVersion === rec.version) continue
        packParams(rec, paramScratch, 0, undefined, 0)
        s.params[i]!.write(paramScratch)
        const layer = (texture: GPUTexture) =>
          texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 })
        pass.setPipeline(t)
        pass.setBindGroup(
          0,
          gpu.device.createBindGroup({
            layout: l.transmittance!,
            entries: [
              { binding: 0, resource: { buffer: s.params[i]!.buffer } },
              { binding: 1, resource: layer(s.transmittance) },
            ],
          }),
        )
        pass.dispatchWorkgroups(TRANSMITTANCE_W / 8, TRANSMITTANCE_H / 8)
        pass.setPipeline(m)
        pass.setBindGroup(
          0,
          gpu.device.createBindGroup({
            layout: l.multiscatter!,
            entries: [
              { binding: 0, resource: { buffer: s.params[i]!.buffer } },
              { binding: 1, resource: s.transmittanceArray },
              { binding: 2, resource: s.clamp },
              { binding: 3, resource: layer(s.multiscatter) },
            ],
          }),
        )
        pass.dispatchWorkgroups(MULTISCATTER_SIZE / 8, MULTISCATTER_SIZE / 8)
        rec.layerVersion = rec.version
        s.lutComputes++
      }
      pass.end()
    },
  }
}

/** The primary's sky-view LUT and aerial-perspective froxels, for a camera inside it. */
function viewNode(): NodeDescriptor {
  return {
    kind: 'raw',
    phase: RenderPhase.Setup,
    enabled: (view) => {
      const ca = view.data.atmosphere as CameraAtmosphere | undefined
      return ca !== undefined && ca.primary !== undefined && ca.inside
    },
    reads: ['atmosphere-luts'],
    writes: ['atmosphere-view'],
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      const ca = ctx.view.data.atmosphere as CameraAtmosphere | undefined
      if (!cam || !ca?.primary) return
      const s = ctx.world.resource(AtmosphereGpuResource)
      const c = s.cameras.get(cam.entity)
      if (!c?.skyView || !c.scatter || !c.transmittance) return
      if (ca.primary.layerVersion !== ca.primary.version) return
      const sky = compute(ctx, s, 'skyView', 'shard::atmosphere::sky_view')
      const aerial = compute(ctx, s, 'aerial', 'shard::atmosphere::aerial')
      if (!sky || !aerial) return
      const gpu = ctx.gpu
      const l = layouts(gpu, s)
      const common = (): GPUBindGroupEntry[] => [
        { binding: 0, resource: { buffer: c.uniform.buffer } },
        { binding: 1, resource: s.transmittanceArray },
        { binding: 2, resource: s.multiscatterArray },
        { binding: 3, resource: s.clamp },
      ]
      const base = `${gpu.generation}/${c.uniform.version}/${idOf(s.transmittance)}`
      let pass = ctx.encoder.beginComputePass({
        label: `${ctx.view.name}/atmosphere/sky-view`,
        timestampWrites: ctx.timestamps('atmosphere/sky-view'),
      })
      pass.setPipeline(sky)
      pass.setBindGroup(
        0,
        s.group(gpu, `${cam.entity}/sky-view`, `${base}/${idOf(c.skyView)}`, l.skyView!, () => [
          ...common(),
          { binding: 4, resource: c.skyView!.createView() },
        ]),
      )
      pass.dispatchWorkgroups(Math.ceil(c.skyView.width / 8), Math.ceil(c.skyView.height / 8))
      pass.end()
      if (ca.aerialPerspective) {
        pass = ctx.encoder.beginComputePass({
          label: `${ctx.view.name}/atmosphere/aerial`,
          timestampWrites: ctx.timestamps('atmosphere/aerial'),
        })
        pass.setPipeline(aerial)
        pass.setBindGroup(
          0,
          s.group(
            gpu,
            `${cam.entity}/aerial`,
            `${base}/${idOf(c.scatter)}/${idOf(c.transmittance)}`,
            l.aerial!,
            () => [
              ...common(),
              { binding: 4, resource: c.scatter!.createView() },
              { binding: 5, resource: c.transmittance!.createView() },
            ],
          ),
        )
        pass.dispatchWorkgroups(Math.ceil(c.scatter.width / 8), Math.ceil(c.scatter.height / 8))
        pass.end()
      }
      c.computed = s.frame
    },
  }
}

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (id === undefined) {
    id = nextId++
    ids.set(o, id)
  }
  return id
}

/** 1×1 stand-ins for a camera outside its primary (no sky-view or froxels). */
let empty: { generation: number; d2: GPUTexture; d3: GPUTexture } | undefined
function emptyTextures(gpu: GpuContext) {
  if (!empty || empty.generation !== gpu.generation) {
    const usage = GPUTextureUsage.TEXTURE_BINDING
    empty = {
      generation: gpu.generation,
      d2: gpu.device.createTexture({
        label: 'atmosphere/empty',
        size: [1, 1],
        format: 'rgba16float',
        usage,
      }),
      d3: gpu.device.createTexture({
        label: 'atmosphere/empty-3d',
        size: [1, 1, 1],
        dimension: '3d',
        format: 'rgba16float',
        usage,
      }),
    }
  }
  return empty
}

/**
 * The sky where no geometry was drawn: the environment map behind (a star field) and the sun
 * disks, through every atmosphere far to near. The primary reads its sky-view LUT from inside.
 */
function skyNode(): NodeDescriptor {
  const bgData = new Float32Array(8)
  const bgBuffers = new Map<Entity, GpuBuffer>()
  return {
    kind: 'render',
    phase: RenderPhase.Sky,
    enabled: (view) => {
      const entry = view.data.environment as CameraEnvironment | undefined
      return hasAtmosphere(view) && entry?.sky === true && entry.background >= 0
    },
    reads: ['environment', 'atmosphere-luts', 'atmosphere-view'],
    writes: ['scene-color', 'hdr'],
    color: (view) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      const ca = ctx.view.data.atmosphere as CameraAtmosphere | undefined
      const entry = ctx.view.data.environment as CameraEnvironment
      if (!cam || !ca) return
      const s = ctx.world.resource(AtmosphereGpuResource)
      const c = s.cameras.get(cam.entity)
      if (!c) return
      for (const rec of ca.list) if (rec.layerVersion !== rec.version) return
      const gpu = ctx.gpu
      const shaders = ctx.world.resource(Shaders)
      const module = shaders.module(gpu, { root: 'shard::atmosphere::sky' })
      if (!module) {
        gpu.pipelines.skipped++
        return
      }
      const l = layouts(gpu, s)
      const key = `sky/x${cam.msaa}`
      let pipeline = s.pipelines.get(key) as GPURenderPipeline | undefined
      if (!pipeline) {
        pipeline = gpu.pipelines.render({
          label: `atmosphere/${key}`,
          layout: gpu.layouts.pipelineLayout({
            label: 'atmosphere/sky',
            bindGroupLayouts: [l.viewOnly!, l.sky!],
          }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
          multisample: { count: cam.msaa },
        })
        if (!pipeline) return
        s.pipelines.set(key, pipeline)
      }
      const pv = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)
      if (!pv) return
      const envs = ctx.world.resource(Environments)
      const backdrop = entry.backdrop
      const env: Environment | undefined =
        backdrop && backdrop.environment.bakes > 0 ? backdrop.environment : undefined
      let bg = bgBuffers.get(cam.entity)
      if (!bg) {
        bg = new GpuBuffer(gpu, {
          label: 'atmosphere/background',
          usage: GPUBufferUsage.UNIFORM,
          size: bgData.byteLength,
        })
        bgBuffers.set(cam.entity, bg)
      }
      bgData[0] = env ? backdrop!.intensity * entry.background : 0
      bgData[1] = Math.cos(backdrop?.rotation ?? 0)
      bgData[2] = Math.sin(backdrop?.rotation ?? 0)
      bgData[3] = env ? 1 : 0
      bgData[4] = ca.skyViewSize[0]
      bgData[5] = ca.skyViewSize[1]
      bg.write(bgData)
      const e = emptyTextures(gpu)
      const skyView = ca.inside && c.skyView ? c.skyView : e.d2
      const cube = env?.sourceView ?? envs.emptyView!
      const group = s.group(
        gpu,
        `${cam.entity}/sky`,
        `${gpu.generation}/${c.uniform.version}/${bg.version}/${idOf(skyView)}/${env ? idOf(env.source) : 0}/${idOf(s.transmittance)}`,
        l.sky!,
        () => [
          { binding: 0, resource: { buffer: c.uniform.buffer } },
          { binding: 1, resource: s.transmittanceArray },
          { binding: 2, resource: s.multiscatterArray },
          { binding: 3, resource: s.clamp },
          { binding: 4, resource: skyView.createView() },
          { binding: 5, resource: s.repeat },
          { binding: 6, resource: cube },
          { binding: 7, resource: { buffer: bg!.buffer } },
        ],
      )
      const viewGroup = s.group(
        gpu,
        `${cam.entity}/view`,
        `${gpu.generation}/${pv.uniform.version}`,
        l.viewOnly!,
        () => [{ binding: 0, resource: { buffer: pv.uniform.buffer } }],
      )
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewGroup)
      pass.setBindGroup(1, group)
      pass.draw(3)
    },
  }
}

/** Aerial perspective over geometry, in the post chain where fog would be. */
function compositeNode(): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Post,
    enabled: hasEffect(PostEffect.Atmosphere),
    reads: ['atmosphere-in', 'depth', 'atmosphere-luts', 'atmosphere-view'],
    writes: ['atmosphere-out'],
    color: [{ resource: 'atmosphere-out', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      const ca = ctx.view.data.atmosphere as CameraAtmosphere | undefined
      const s = ctx.world.resource(AtmosphereGpuResource)
      const c = cam ? s.cameras.get(cam.entity) : undefined
      const pv = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)
      if (!cam || !ca || !c || !pv) return
      const gpu = ctx.gpu
      const l = layouts(gpu, s)
      let pipeline = s.pipelines.get('composite') as GPURenderPipeline | undefined
      if (!pipeline) {
        const shaders = ctx.world.resource(Shaders)
        const fs = shaders.module(gpu, { root: 'shard::atmosphere::composite' })
        const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
        if (!fs || !vs) {
          gpu.pipelines.skipped++
          return
        }
        pipeline = gpu.pipelines.render({
          label: 'atmosphere/composite',
          layout: gpu.layouts.pipelineLayout({
            label: 'atmosphere/composite',
            bindGroupLayouts: [l.viewOnly!, l.composite!],
          }),
          vertex: { module: vs, entryPoint: 'vs' },
          fragment: { module: fs, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        })
        if (!pipeline) return
        s.pipelines.set('composite', pipeline)
      }
      const input = ctx.texture('atmosphere-in')
      const depth = ctx.texture('depth')
      const e = emptyTextures(gpu)
      const inside = ca.inside && c.computed === s.frame
      const scatter = inside && c.scatter ? c.scatter : e.d3
      const trans = inside && c.transmittance ? c.transmittance : e.d3
      // Until every LUT exists the uniform lists no atmospheres, and this passes the image through.
      const group = s.group(
        gpu,
        `${cam.entity}/composite`,
        `${gpu.generation}/${idOf(input)}/${idOf(depth)}/${c.uniform.version}/${idOf(scatter)}/${idOf(trans)}/${idOf(s.transmittance)}`,
        l.composite!,
        () => [
          { binding: 0, resource: input.createView() },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: { buffer: c.uniform.buffer } },
          { binding: 3, resource: s.transmittanceArray },
          { binding: 4, resource: s.multiscatterArray },
          { binding: 5, resource: s.clamp },
          { binding: 6, resource: scatter.createView() },
          { binding: 7, resource: trans.createView() },
        ],
      )
      const viewGroup = s.group(
        gpu,
        `${cam.entity}/view`,
        `${gpu.generation}/${pv.uniform.version}`,
        l.viewOnly!,
        () => [{ binding: 0, resource: { buffer: pv.uniform.buffer } }],
      )
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewGroup)
      pass.setBindGroup(1, group)
      pass.draw(3)
    },
  }
}

/** Bakes a camera's atmosphere into its environment's source cube (level 0). */
function bakeAtmosphere(
  ctx: NodeContext,
  pass: GPUComputePassEncoder,
  env: Environment,
  level0: GPUTextureView,
): boolean {
  const ca = env.atmosphere
  const s = ctx.world.resource(AtmosphereGpuResource)
  const primary = ca?.primary
  if (!ca || !primary || primary.layerVersion !== primary.version) return false
  const c = s.cameras.get(ca.camera)
  if (!c) return false
  const pipeline = compute(ctx, s, 'bake', 'shard::atmosphere::bake')
  if (!pipeline) return false
  const gpu = ctx.gpu
  pass.setPipeline(pipeline)
  pass.setBindGroup(
    0,
    gpu.device.createBindGroup({
      layout: layouts(gpu, s).bake!,
      entries: [
        { binding: 0, resource: { buffer: c.uniform.buffer } },
        { binding: 1, resource: s.transmittanceArray },
        { binding: 2, resource: s.multiscatterArray },
        { binding: 3, resource: s.clamp },
        { binding: 4, resource: level0 },
      ],
    }),
  )
  pass.dispatchWorkgroups(env.size / 8, env.size / 8, 6)
  return true
}

/**
 * The LUT pass and per-view sky-view/froxel pass (registered before the environment prefilter,
 * which bakes atmospheres into IBL), the sky pass, and the aerial-perspective composite.
 */
export function addAtmosphereNodes(world: World): void {
  const graph = world.resource(Graph)
  world.initResource(AtmosphereGpuResource)
  environmentBakers.set('atmosphere', bakeAtmosphere)
  graph.addNode('atmosphere/luts', lutNode())
  graph.addNode('atmosphere/view', viewNode())
  graph.addNode('atmosphere/sky', skyNode())
  graph.addNode('post/atmosphere', compositeNode())
}
