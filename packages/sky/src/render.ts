import { defineResource, type Entity, mat4, type World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import {
  AtmosphereGpuResource,
  type CameraAtmosphere,
  type CameraData,
  cameraOf,
  type NodeContext,
  type NodeDescriptor,
  RenderPhase,
  type RenderView,
  Shaders,
  SkyOcclusion,
  sceneColor,
} from '@aethervtt/shard-render'
import { SkyFrame } from './celestial'
import { Clouds } from './components'
import { CloudMotion } from './motion'
import { DETAIL_SIZE, SHADOW_EXTENT, SHADOW_SIZE, SHAPE_SIZE } from './shaders'

/** Per camera: the half-resolution march, its history, and uniforms. */
interface CloudCamera {
  width: number
  height: number
  march: GPUTexture | undefined
  history: [GPUTexture | undefined, GPUTexture | undefined]
  /** Which history the next resolve writes. */
  index: number
  params: GpuBuffer
  resolve: GpuBuffer
  celestial: GpuBuffer
  /** Last frame's view-projection without translation, and whether it's set. */
  prev: Float32Array
  hasPrev: boolean
  marchGroup: GPUBindGroup | undefined
  marchBound: unknown[]
  resolveGroups: [GPUBindGroup | undefined, GPUBindGroup | undefined]
  composite: [GPUBindGroup | undefined, GPUBindGroup | undefined]
  celestialGroup: GPUBindGroup | undefined
  celestialBound: unknown[]
}

export class SkyGpu {
  generation = -1
  shape: GPUTexture | undefined
  detail: GPUTexture | undefined
  /** The cloud shadow map (r: transmittance), shared by every camera; and the frame it was drawn. */
  shadow: GPUTexture | undefined
  shadowFrame = -1
  /** Whether SkyOcclusion.map holds this device's shadow map. */
  mapSet = false
  noiseReady = false
  noiseSampler!: GPUSampler
  linear!: GPUSampler
  layouts: Record<string, GPUBindGroupLayout> = {}
  readonly pipelines = new Map<string, GPUComputePipeline | GPURenderPipeline>()
  readonly cameras = new Map<Entity, CloudCamera>()
  frame = 0

  ensure(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.generation = gpu.generation
    this.pipelines.clear()
    this.cameras.clear()
    this.noiseReady = false
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    this.shape = gpu.device.createTexture({
      label: 'sky/shape-noise',
      size: [SHAPE_SIZE, SHAPE_SIZE, SHAPE_SIZE],
      dimension: '3d',
      format: 'rgba8unorm',
      usage,
    })
    this.detail = gpu.device.createTexture({
      label: 'sky/detail-noise',
      size: [DETAIL_SIZE, DETAIL_SIZE, DETAIL_SIZE],
      dimension: '3d',
      format: 'rgba8unorm',
      usage,
    })
    this.shadow = gpu.device.createTexture({
      label: 'sky/cloud-shadows',
      size: [SHADOW_SIZE, SHADOW_SIZE],
      format: 'rgba8unorm',
      usage,
    })
    this.shadowFrame = -1
    this.mapSet = false
    this.noiseSampler = gpu.layouts.sampler({
      label: 'sky/noise',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    })
    this.linear = gpu.layouts.sampler({
      label: 'sky/linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    const C = GPUShaderStage.COMPUTE
    const F = GPUShaderStage.FRAGMENT
    const L = gpu.layouts
    this.layouts = {
      noise: L.bindGroupLayout({
        label: 'sky/noise',
        entries: [0, 1].map((binding) => ({
          binding,
          visibility: C,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' },
        })),
      }),
      march: L.bindGroupLayout({
        label: 'sky/march',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'uniform' } },
          { binding: 1, visibility: C, buffer: { type: 'uniform' } },
          { binding: 2, visibility: C, texture: { viewDimension: '2d-array' } },
          { binding: 3, visibility: C, sampler: { type: 'filtering' } },
          { binding: 4, visibility: C, texture: {} },
          { binding: 5, visibility: C, sampler: { type: 'filtering' } },
          { binding: 6, visibility: C, texture: { viewDimension: '3d' } },
          { binding: 7, visibility: C, texture: { viewDimension: '3d' } },
          { binding: 8, visibility: C, sampler: { type: 'filtering' } },
          {
            binding: 9,
            visibility: C,
            storageTexture: { access: 'write-only', format: 'rgba16float' },
          },
          {
            binding: 10,
            visibility: C,
            storageTexture: { access: 'write-only', format: 'rgba8unorm' },
          },
        ],
      }),
      resolve: L.bindGroupLayout({
        label: 'sky/resolve',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'uniform' } },
          { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: C, texture: {} },
          { binding: 3, visibility: C, sampler: { type: 'filtering' } },
          {
            binding: 4,
            visibility: C,
            storageTexture: { access: 'write-only', format: 'rgba16float' },
          },
        ],
      }),
      composite: L.bindGroupLayout({
        label: 'sky/composite',
        entries: [
          { binding: 0, visibility: F, texture: {} },
          { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        ],
      }),
      celestial: L.bindGroupLayout({
        label: 'sky/celestial',
        entries: [
          { binding: 0, visibility: F, buffer: { type: 'uniform' } },
          { binding: 1, visibility: F, texture: { viewDimension: '2d-array' } },
          { binding: 2, visibility: F, sampler: { type: 'filtering' } },
          { binding: 3, visibility: F, buffer: { type: 'uniform' } },
        ],
      }),
    }
  }

  camera(gpu: GpuContext, entity: Entity): CloudCamera {
    let c = this.cameras.get(entity)
    if (!c) {
      const buffer = (label: string, floats: number) =>
        new GpuBuffer(gpu, { label, usage: GPUBufferUsage.UNIFORM, size: floats * 4 })
      c = {
        width: 0,
        height: 0,
        march: undefined,
        history: [undefined, undefined],
        index: 0,
        params: buffer('sky/clouds', PARAM_FLOATS),
        resolve: buffer('sky/resolve', RESOLVE_FLOATS),
        celestial: buffer('sky/celestial', CELESTIAL_FLOATS),
        prev: new Float32Array(16),
        hasPrev: false,
        marchGroup: undefined,
        marchBound: [],
        resolveGroups: [undefined, undefined],
        composite: [undefined, undefined],
        celestialGroup: undefined,
        celestialBound: [],
      }
      this.cameras.set(entity, c)
    }
    return c
  }
}

export const SkyGpuResource = defineResource<SkyGpu>('sky/Gpu', {
  description: "The sky's GPU state: noise volumes, per-camera cloud targets, and pipelines.",
  init: () => new SkyGpu(),
})

const PARAM_FLOATS = 40
const RESOLVE_FLOATS = 40
const CELESTIAL_FLOATS = 28
const params = new Float32Array(PARAM_FLOATS)
const resolveData = new Float32Array(RESOLVE_FLOATS)
const celestialData = new Float32Array(CELESTIAL_FLOATS)
const rotView = mat4.create()
const relViewProj = mat4.create()
const relInverse = mat4.create()

/** Steps and the march's resolution divisor by quality. */
const QUALITY = { low: [48, 3], medium: [72, 2], high: [110, 2] } as const

function skyActive(world: World): boolean {
  const frame = world.resource(SkyFrame)
  return frame.entity >= 0
}

function cloudsActive(world: World, view: RenderView): boolean {
  const frame = world.resource(SkyFrame)
  if (frame.entity < 0 || frame.mode === 'none') return false
  if (!world.has(frame.entity as Entity, Clouds)) return false
  return view.data.atmosphere !== undefined
}

function pipeline(
  ctx: NodeContext,
  s: SkyGpu,
  key: string,
  make: (module: GPUShaderModule) => GPUComputePipeline | GPURenderPipeline | undefined,
  root: string,
): GPUComputePipeline | GPURenderPipeline | undefined {
  const cached = s.pipelines.get(key)
  if (cached) return cached
  const module = ctx.world.resource(Shaders).module(ctx.gpu, { root })
  if (!module) {
    ctx.gpu.pipelines.skipped++
    return undefined
  }
  const p = make(module)
  if (p) s.pipelines.set(key, p)
  return p
}

function computePipeline(
  ctx: NodeContext,
  s: SkyGpu,
  key: string,
  root: string,
  layout: string,
  entryPoint = 'main',
): GPUComputePipeline | undefined {
  return pipeline(
    ctx,
    s,
    key,
    (module) =>
      ctx.gpu.pipelines.compute({
        label: `sky/${key}`,
        layout: ctx.gpu.layouts.pipelineLayout({
          label: `sky/${key}`,
          bindGroupLayouts: [s.layouts[layout]!],
        }),
        compute: { module, entryPoint },
      }),
    root,
  ) as GPUComputePipeline | undefined
}

/** A fullscreen pass over the sky (depth 0 only), blending into scene color. */
function skyPipeline(
  ctx: NodeContext,
  s: SkyGpu,
  key: string,
  root: string,
  layout: string,
  msaa: number,
  blend: GPUBlendState,
): GPURenderPipeline | undefined {
  return pipeline(
    ctx,
    s,
    `${key}/x${msaa}`,
    (module) =>
      ctx.gpu.pipelines.render({
        label: `sky/${key}`,
        layout: ctx.gpu.layouts.pipelineLayout({
          label: `sky/${key}`,
          bindGroupLayouts: [s.layouts[layout]!],
        }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend }] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
        multisample: { count: msaa },
      }),
    root,
  ) as GPURenderPipeline | undefined
}

function relativeViewProj(cam: CameraData, out: Float32Array): Float32Array {
  mat4.copy(rotView, cam.view)
  rotView[12] = 0
  rotView[13] = 0
  rotView[14] = 0
  return mat4.multiply(out, cam.proj, rotView)
}

function same(bound: unknown[], ...values: unknown[]): boolean {
  let ok = bound.length === values.length
  for (let i = 0; i < values.length; i++) {
    if (bound[i] !== values[i]) ok = false
    bound[i] = values[i]
  }
  bound.length = values.length
  return ok
}

function targets(gpu: GpuContext, c: CloudCamera, width: number, height: number): void {
  if (c.march && c.width === width && c.height === height) return
  c.march?.destroy()
  c.history[0]?.destroy()
  c.history[1]?.destroy()
  const make = (label: string) =>
    gpu.device.createTexture({
      label,
      size: [width, height],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
  c.march = make('sky/clouds-march')
  c.history = [make('sky/clouds-history0'), make('sky/clouds-history1')]
  c.width = width
  c.height = height
  c.hasPrev = false
  c.marchGroup = undefined
  c.marchBound.length = 0
  c.resolveGroups = [undefined, undefined]
  c.composite = [undefined, undefined]
}

/** Noise once, then this frame's clouds: the march at reduced resolution and the resolve. */
export function cloudsMarchNode(): NodeDescriptor {
  return {
    kind: 'compute',
    phase: RenderPhase.Setup + 50,
    reads: ['atmosphere-view'],
    sideEffects: true,
    enabled: (view) => cameraOf(view) !== undefined && cloudsActiveFor(view),
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      const ca = ctx.view.data.atmosphere as CameraAtmosphere | undefined
      if (!cam || !ca) return
      const world = ctx.world
      const s = world.resource(SkyGpuResource)
      const gpu = ctx.gpu
      s.ensure(gpu)
      const atmos = world.resource(AtmosphereGpuResource)
      const ac = atmos.cameras.get(cam.entity)
      if (!ac?.skyView || !ac.packed) return
      const pass = ctx.computePass!
      if (!s.noiseReady) {
        const shape = computePipeline(ctx, s, 'noise-shape', 'shard::sky::noise', 'noise', 'shape')
        const detail = computePipeline(
          ctx,
          s,
          'noise-detail',
          'shard::sky::noise',
          'noise',
          'detail',
        )
        if (!shape || !detail) return
        const group = gpu.device.createBindGroup({
          label: 'sky/noise',
          layout: s.layouts.noise!,
          entries: [
            { binding: 0, resource: s.shape!.createView() },
            { binding: 1, resource: s.detail!.createView() },
          ],
        })
        pass.setBindGroup(0, group)
        pass.setPipeline(shape)
        pass.dispatchWorkgroups(SHAPE_SIZE / 4, SHAPE_SIZE / 4, SHAPE_SIZE / 4)
        pass.setPipeline(detail)
        pass.dispatchWorkgroups(DETAIL_SIZE / 4, DETAIL_SIZE / 4, DETAIL_SIZE / 4)
        s.noiseReady = true
      }
      const march = computePipeline(ctx, s, 'march', 'shard::sky::march', 'march')
      const resolve = computePipeline(ctx, s, 'resolve', 'shard::sky::resolve', 'resolve')
      if (!march || !resolve) return
      const frame = world.resource(SkyFrame)
      const clouds = world.get(frame.entity as Entity, Clouds)
      const [steps, divisor] = QUALITY[clouds.quality]
      const width = Math.max(1, Math.ceil(cam.width / divisor))
      const height = Math.max(1, Math.ceil(cam.height / divisor))
      const c = s.camera(gpu, cam.entity)
      targets(gpu, c, width, height)
      const motion = world.resource(CloudMotion)
      const R = ca.primary ? ca.primary.model.bottom * 1000 : 6360000
      params[0] = clouds.bottom
      params[1] = clouds.bottom + clouds.thickness
      params[2] = R
      params[3] = clouds.density
      params[4] = clouds.coverage
      params[5] = clouds.type
      params[6] = clouds.shapeScale
      params[7] = clouds.detailScale
      params[8] = motion.offset[0]! + clouds.phase
      params[9] = motion.offset[1]!
      params[10] = motion.evolution
      params[11] = clouds.mapScale
      params[12] = cam.position[0]!
      params[13] = cam.position[1]!
      params[14] = cam.position[2]!
      params[15] = s.frame % 1024
      params[16] = width
      params[17] = height
      params[18] = 1 / width
      params[19] = 1 / height
      params[20] = clouds.albedo
      params[21] = steps
      params[22] = ca.skyViewSize[0]
      params[23] = ca.skyViewSize[1]
      params[24] = cam.exposure
      params[25] = ca.primary && ca.inside ? 1 : 0
      params[26] = 0
      params[27] = frame.mode === '2d' ? 1 : 0
      params[28] = motion.shadowCenter[0]!
      params[29] = motion.shadowCenter[1]!
      params[30] = SHADOW_EXTENT
      params[31] = SHADOW_SIZE
      const light = frame.shadows === 'moon' ? frame.celestial.moon : frame.celestial.sun
      params[32] = light[0]!
      params[33] = light[1]!
      params[34] = light[2]!
      params[35] = clouds.shadows && frame.shadows !== 'none' ? 1 : 0
      // Toon (0108): the Clouds' own bands, or the camera's.
      params[36] = clouds.bands > 0 ? clouds.bands : cam.toon.tones
      params[37] = cam.toon.softness
      c.params.write(params)
      if (
        !c.marchGroup ||
        !same(c.marchBound, ac.uniform.buffer, ac.skyView, atmos.transmittanceArray, c.march)
      ) {
        c.marchGroup = gpu.device.createBindGroup({
          label: 'sky/march',
          layout: s.layouts.march!,
          entries: [
            { binding: 0, resource: { buffer: c.params.buffer } },
            { binding: 1, resource: { buffer: ac.uniform.buffer } },
            { binding: 2, resource: atmos.transmittanceArray },
            { binding: 3, resource: atmos.clamp },
            { binding: 4, resource: ac.skyView.createView() },
            { binding: 5, resource: atmos.repeat },
            { binding: 6, resource: s.shape!.createView() },
            { binding: 7, resource: s.detail!.createView() },
            { binding: 8, resource: s.noiseSampler },
            { binding: 9, resource: c.march!.createView() },
            { binding: 10, resource: s.shadow!.createView() },
          ],
        })
      }
      pass.setPipeline(march)
      pass.setBindGroup(0, c.marchGroup)
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
      // The cloud shadow map, once a frame (whichever camera gets here first).
      const shadow = computePipeline(ctx, s, 'shadow', 'shard::sky::march', 'march', 'shadow')
      if (shadow && s.shadowFrame !== s.frame) {
        s.shadowFrame = s.frame
        pass.setPipeline(shadow)
        pass.dispatchWorkgroups(SHADOW_SIZE / 8, SHADOW_SIZE / 8)
        const occlusion = world.tryResource(SkyOcclusion)
        if (occlusion && !s.mapSet) {
          occlusion.map = s.shadow!.createView()
          s.mapSet = true
        }
      }

      // Resolve into the history the composite reads this frame.
      relativeViewProj(cam, relViewProj)
      mat4.invert(relInverse, relViewProj)
      resolveData.set(c.prev, 0)
      resolveData.set(relInverse, 16)
      resolveData[32] = width
      resolveData[33] = height
      resolveData[34] = 1 / width
      resolveData[35] = 1 / height
      resolveData[36] = 0.9
      resolveData[37] = c.hasPrev ? 1 : 0
      c.resolve.write(resolveData)
      c.prev.set(relViewProj)
      c.hasPrev = true
      const out = c.index
      const from = 1 - out
      let group = c.resolveGroups[out]
      if (!group) {
        group = gpu.device.createBindGroup({
          label: 'sky/resolve',
          layout: s.layouts.resolve!,
          entries: [
            { binding: 0, resource: { buffer: c.resolve.buffer } },
            { binding: 1, resource: c.march!.createView() },
            { binding: 2, resource: c.history[from]!.createView() },
            { binding: 3, resource: s.linear },
            { binding: 4, resource: c.history[out]!.createView() },
          ],
        })
        c.resolveGroups[out] = group
      }
      pass.setPipeline(resolve)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
      c.index = from
      s.frame++
    },
  }
}

/** Whether the camera has clouds this frame (the composite's and march's `enabled`). */
let cloudsActiveFor: (view: RenderView) => boolean = () => false
let celestialActiveFor: (view: RenderView) => boolean = () => false

export function bindActivity(world: World): void {
  cloudsActiveFor = (view) => cloudsActive(world, view)
  celestialActiveFor = (view) => skyActive(world) && view.data.atmosphere !== undefined
}

/** The clouds over the sky, from the history the march just resolved. */
export function cloudsCompositeNode(): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Sky + 2,
    after: ['sky/clouds-march', 'sky/celestial'],
    writes: ['scene-color', 'hdr'],
    color: (view) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    enabled: (view) => cameraOf(view) !== undefined && cloudsActiveFor(view),
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      if (!cam) return
      const s = ctx.world.resource(SkyGpuResource)
      const c = s.cameras.get(cam.entity)
      if (!c?.march) return
      // The march flipped the index after writing: the latest is the other one.
      const latest = 1 - c.index
      const p = skyPipeline(ctx, s, 'composite', 'shard::sky::composite', 'composite', cam.msaa, {
        color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      })
      if (!p) return
      let group = c.composite[latest]
      if (!group) {
        group = ctx.gpu.device.createBindGroup({
          label: 'sky/composite',
          layout: s.layouts.composite!,
          entries: [
            { binding: 0, resource: c.history[latest]!.createView() },
            { binding: 1, resource: s.linear },
          ],
        })
        c.composite[latest] = group
      }
      const pass = ctx.renderPass!
      pass.setPipeline(p)
      pass.setBindGroup(0, group)
      pass.draw(3)
    },
  }
}

/** Stars, the Milky Way, the moon and aurora over the atmosphere's sky. */
export function celestialNode(): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Sky + 1,
    after: ['atmosphere/sky'],
    reads: ['atmosphere-luts', 'atmosphere-view'],
    writes: ['scene-color', 'hdr'],
    color: (view) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    enabled: (view) => cameraOf(view) !== undefined && celestialActiveFor(view),
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      if (!cam) return
      const world = ctx.world
      const s = world.resource(SkyGpuResource)
      s.ensure(ctx.gpu)
      const atmos = world.resource(AtmosphereGpuResource)
      const ac = atmos.cameras.get(cam.entity)
      if (!ac?.packed) return
      const p = skyPipeline(ctx, s, 'celestial', 'shard::sky::celestial', 'celestial', cam.msaa, {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      })
      if (!p) return
      const frame = world.resource(SkyFrame)
      const cel = frame.celestial
      const c = s.camera(ctx.gpu, cam.entity)
      const st = cel.stars
      celestialData[0] = st[0]!
      celestialData[1] = st[1]!
      celestialData[2] = st[2]!
      celestialData[4] = st[3]!
      celestialData[5] = st[4]!
      celestialData[6] = st[5]!
      celestialData[8] = st[6]!
      celestialData[9] = st[7]!
      celestialData[10] = st[8]!
      celestialData[12] = cel.moon[0]!
      celestialData[13] = cel.moon[1]!
      celestialData[14] = cel.moon[2]!
      celestialData[15] = ((0.52 * frame.moonSize) / 2) * (Math.PI / 180)
      celestialData[16] = cel.sun[0]!
      celestialData[17] = cel.sun[1]!
      celestialData[18] = cel.sun[2]!
      celestialData[19] = cel.illuminated
      celestialData[20] = frame.nightBrightness
      celestialData[21] = frame.stars
      celestialData[22] = frame.milkyWay
      celestialData[23] = frame.aurora
      celestialData[24] = frame.time
      celestialData[25] = frame.twinkle
      celestialData[26] = frame.moonDisk
      celestialData[27] = cam.fovY / Math.max(1, cam.height)
      c.celestial.write(celestialData)
      if (
        !c.celestialGroup ||
        !same(c.celestialBound, ac.uniform.buffer, atmos.transmittanceArray)
      ) {
        c.celestialGroup = ctx.gpu.device.createBindGroup({
          label: 'sky/celestial',
          layout: s.layouts.celestial!,
          entries: [
            { binding: 0, resource: { buffer: ac.uniform.buffer } },
            { binding: 1, resource: atmos.transmittanceArray },
            { binding: 2, resource: atmos.clamp },
            { binding: 3, resource: { buffer: c.celestial.buffer } },
          ],
        })
      }
      const pass = ctx.renderPass!
      pass.setPipeline(p)
      pass.setBindGroup(0, c.celestialGroup)
      pass.draw(3)
    },
  }
}
