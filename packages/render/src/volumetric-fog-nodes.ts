import { defineResource, type Entity } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { ForwardStateResource, sceneColor, viewBindGroup } from './forward'
import { type NodeContext, type NodeDescriptor, RenderPhase, type RenderView } from './graph'
import { Shaders } from './plugin'
import { forwardView } from './post-common'
import { cameraOf } from './view'
import { FogVolumes, MAX_FOG_VOLUMES, VOLUME_FLOATS } from './volumetric-fog'

/** A camera's VolumetricFog, as extraction leaves it in `view.data.volumetricFog`. */
interface FogSettings {
  distance: number
  quality: 'low' | 'medium' | 'high'
  depthCurve: number
  anisotropy: number
  temporal: number
  lights: boolean
  ambient: number
}

/** Froxel size (px) and slices per quality. */
const QUALITY = { low: [16, 32], medium: [8, 64], high: [4, 128] } as const
const FRAME_FLOATS = 24

interface FogCamera {
  grid: [number, number, number]
  /** Lit froxels, ping-ponged: this frame's light pass reads the other as history. */
  lit: [GPUTexture | undefined, GPUTexture | undefined]
  volume: GPUTexture | undefined
  index: number
  hasHistory: boolean
  frame: GpuBuffer
  far: GpuBuffer
  lightGroups: [GPUBindGroup | undefined, GPUBindGroup | undefined]
  integrateGroups: [GPUBindGroup | undefined, GPUBindGroup | undefined]
  applyGroup: GPUBindGroup | undefined
  applyBound: unknown[]
}

export class VolumetricFogGpu {
  generation = -1
  layouts: Record<string, GPUBindGroupLayout> = {}
  linear!: GPUSampler
  volumes: GpuBuffer | undefined
  volumesVersion = -1
  readonly pipelines = new Map<unknown, GPUComputePipeline | GPURenderPipeline>()
  readonly cameras = new Map<Entity, FogCamera>()
  frames = 0

  ensure(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.generation = gpu.generation
    this.pipelines.clear()
    this.cameras.clear()
    this.volumesVersion = -1
    const C = GPUShaderStage.COMPUTE
    const F = GPUShaderStage.FRAGMENT
    const L = gpu.layouts
    this.linear = L.sampler({
      label: 'volumetric-fog/linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    })
    this.volumes = new GpuBuffer(gpu, {
      label: 'volumetric-fog/volumes',
      usage: GPUBufferUsage.STORAGE,
      size: MAX_FOG_VOLUMES * VOLUME_FLOATS * 4,
    })
    const storage3d = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' },
    })
    this.layouts = {
      light: L.bindGroupLayout({
        label: 'volumetric-fog/light',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'uniform' } },
          { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: C, texture: { viewDimension: '3d' } },
          { binding: 3, visibility: C, sampler: { type: 'filtering' } },
          storage3d(4),
        ],
      }),
      integrate: L.bindGroupLayout({
        label: 'volumetric-fog/integrate',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'uniform' } },
          {
            binding: 1,
            visibility: C,
            texture: { viewDimension: '3d', sampleType: 'unfilterable-float' },
          },
          storage3d(2),
        ],
      }),
      apply: L.bindGroupLayout({
        label: 'volumetric-fog/apply',
        entries: applyEntries(F, false),
      }),
      applyMsaa: L.bindGroupLayout({
        label: 'volumetric-fog/apply-msaa',
        entries: applyEntries(F, true),
      }),
    }
  }

  camera(gpu: GpuContext, entity: Entity): FogCamera {
    let c = this.cameras.get(entity)
    if (!c) {
      c = {
        grid: [0, 0, 0],
        lit: [undefined, undefined],
        volume: undefined,
        index: 0,
        hasHistory: false,
        frame: new GpuBuffer(gpu, {
          label: 'volumetric-fog/frame',
          usage: GPUBufferUsage.UNIFORM,
          size: FRAME_FLOATS * 4,
        }),
        far: new GpuBuffer(gpu, {
          label: 'volumetric-fog/far',
          usage: GPUBufferUsage.UNIFORM,
          size: 32,
        }),
        lightGroups: [undefined, undefined],
        integrateGroups: [undefined, undefined],
        applyGroup: undefined,
        applyBound: [],
      }
      this.cameras.set(entity, c)
    }
    return c
  }
}

function applyEntries(F: number, msaa: boolean): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 0, visibility: F, buffer: { type: 'uniform' } },
    { binding: 1, visibility: F, texture: { viewDimension: '3d' } },
    { binding: 2, visibility: F, sampler: { type: 'filtering' } },
    { binding: 3, visibility: F, texture: { sampleType: 'depth', multisampled: msaa } },
    { binding: 4, visibility: F, buffer: { type: 'uniform' } },
  ]
}

export const VolumetricFogGpuResource = defineResource<VolumetricFogGpu>(
  'render/VolumetricFogGpu',
  {
    description: "Volumetric fog's froxel volumes, uniforms and pipelines per camera (0132).",
    init: () => new VolumetricFogGpu(),
  },
)

const frameData = new Float32Array(FRAME_FLOATS)
const farData = new Float32Array(8)

const active = (view: RenderView) =>
  cameraOf(view) !== undefined && view.data.volumetricFog !== undefined

function sized(gpu: GpuContext, c: FogCamera, w: number, h: number, d: number): void {
  if (c.volume && c.grid[0] === w && c.grid[1] === h && c.grid[2] === d) return
  c.lit[0]?.destroy()
  c.lit[1]?.destroy()
  c.volume?.destroy()
  const make = (label: string) =>
    gpu.device.createTexture({
      label,
      size: [w, h, d],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
  c.lit = [make('volumetric-fog/lit0'), make('volumetric-fog/lit1')]
  c.volume = make('volumetric-fog/volume')
  c.grid = [w, h, d]
  c.hasHistory = false
  c.lightGroups = [undefined, undefined]
  c.integrateGroups = [undefined, undefined]
  c.applyGroup = undefined
}

function compute(
  ctx: NodeContext,
  s: VolumetricFogGpu,
  view: GPUBindGroupLayout,
  root: string,
  layout: string,
  defines: Record<string, boolean>,
): GPUComputePipeline | undefined {
  const key = `${root}/${defines.SKY_OCCLUSION ? 1 : 0}`
  let byLayout = s.pipelines.get(view) as unknown as Map<string, GPUComputePipeline> | undefined
  if (!byLayout) {
    byLayout = new Map()
    s.pipelines.set(view, byLayout as never)
  }
  const cached = byLayout.get(key)
  if (cached) return cached
  const module = ctx.world.resource(Shaders).module(ctx.gpu, { root, defines })
  if (!module) {
    ctx.gpu.pipelines.skipped++
    return undefined
  }
  const p = ctx.gpu.pipelines.compute({
    label: root,
    layout: ctx.gpu.layouts.pipelineLayout({
      label: root,
      bindGroupLayouts: [view, s.layouts[layout]!],
    }),
    compute: { module, entryPoint: 'main' },
  })
  if (p) byLayout.set(key, p)
  return p
}

/** Lights this frame's froxels (with last frame's reprojected in), then integrates them. */
export function volumetricFogLightNode(): NodeDescriptor {
  return {
    kind: 'compute',
    phase: RenderPhase.Shadows + 50,
    reads: ['shadow-cascades', 'shadow-local', 'clusters', 'environment'],
    sideEffects: true,
    enabled: active,
    run: (ctx) => {
      const v = forwardView(ctx)
      const settings = ctx.view.data.volumetricFog as FogSettings | undefined
      if (!v || !settings) return
      const { cam, pv } = v
      const world = ctx.world
      const gpu = ctx.gpu
      const s = world.resource(VolumetricFogGpuResource)
      s.ensure(gpu)
      const state = world.resource(ForwardStateResource)
      const viewLayout = state.layouts.view
      const defines = { SKY_OCCLUSION: state.skyOcclusion }
      const light = compute(ctx, s, viewLayout, 'shard::volumetric_fog::light', 'light', defines)
      const integrate = compute(
        ctx,
        s,
        viewLayout,
        'shard::volumetric_fog::integrate',
        'integrate',
        {},
      )
      if (!light || !integrate) return
      const [px, slices] = QUALITY[settings.quality]
      const w = Math.max(1, Math.ceil(cam.width / px))
      const h = Math.max(1, Math.ceil(cam.height / px))
      const c = s.camera(gpu, cam.entity)
      sized(gpu, c, w, h, slices)

      const volumes = world.resource(FogVolumes)
      if (s.volumesVersion !== volumes.version) {
        s.volumes!.write(volumes.data, 0, 0, Math.max(1, volumes.count) * VOLUME_FLOATS)
        s.volumesVersion = volumes.version
      }
      const fog = cam.post.fog
      const medium = ctx.view.data.volumetricFogMedium === true
      s.frames++
      frameData[0] = w
      frameData[1] = h
      frameData[2] = slices
      frameData[3] = settings.distance
      frameData[4] = settings.depthCurve
      frameData[5] = settings.anisotropy
      frameData[6] = settings.temporal
      frameData[7] = c.hasHistory ? 1 : 0
      frameData[8] = fog.density
      frameData[9] = fog.heightFalloff
      frameData[10] = fog.start
      frameData[11] = medium ? 1 : 0
      frameData[12] = fog.color[0]!
      frameData[13] = fog.color[1]!
      frameData[14] = fog.color[2]!
      frameData[15] = settings.ambient
      frameData[16] = volumes.count
      frameData[17] = settings.lights ? 1 : 0
      // Slices are jittered in depth each frame; the history averages them.
      frameData[18] = (s.frames * 0.618034) % 1
      frameData[19] = cam.near
      frameData[20] = volumes.time
      // Depth from view depth for this projection (reversed-Z; A is 0 with an infinite far plane).
      frameData[21] = cam.proj[10]!
      frameData[22] = cam.proj[14]!
      c.frame.write(frameData)

      const out = c.index
      const history = 1 - out
      let lightGroup = c.lightGroups[out]
      if (!lightGroup) {
        lightGroup = gpu.device.createBindGroup({
          label: 'volumetric-fog/light',
          layout: s.layouts.light!,
          entries: [
            { binding: 0, resource: { buffer: c.frame.buffer } },
            { binding: 1, resource: { buffer: s.volumes!.buffer } },
            { binding: 2, resource: c.lit[history]!.createView() },
            { binding: 3, resource: s.linear },
            { binding: 4, resource: c.lit[out]!.createView() },
          ],
        })
        c.lightGroups[out] = lightGroup
      }
      let integrateGroup = c.integrateGroups[out]
      if (!integrateGroup) {
        integrateGroup = gpu.device.createBindGroup({
          label: 'volumetric-fog/integrate',
          layout: s.layouts.integrate!,
          entries: [
            { binding: 0, resource: { buffer: c.frame.buffer } },
            { binding: 1, resource: c.lit[out]!.createView() },
            { binding: 2, resource: c.volume!.createView() },
          ],
        })
        c.integrateGroups[out] = integrateGroup
      }
      const group0 = viewBindGroup(gpu, world, pv, cam)
      const pass = ctx.computePass!
      pass.setBindGroup(0, group0)
      pass.setPipeline(light)
      pass.setBindGroup(1, lightGroup)
      pass.dispatchWorkgroups(Math.ceil(w / 4), Math.ceil(h / 4), Math.ceil(slices / 4))
      pass.setPipeline(integrate)
      pass.setBindGroup(1, integrateGroup)
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8), 1)
      c.index = history
      c.hasHistory = true

      // The analytic fog past the volume: the camera's Fog, starting where the volume ends.
      farData.set(fog.color, 0)
      farData[4] = fog.density
      farData[5] = fog.heightFalloff
      farData[6] = Math.max(fog.start, settings.distance)
      farData[7] = fog.sunScattering
      c.far.write(farData)
    },
  }
}

/** The fog over the scene, after transparent objects (they take the fog of what's behind them). */
export function volumetricFogApplyNode(): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Fog - 1,
    after: ['volumetric-fog/light'],
    reads: ['scene-depth'],
    writes: ['scene-color', 'hdr'],
    color: (view) => sceneColor(view),
    enabled: active,
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const { cam, pv } = v
      const world = ctx.world
      const gpu = ctx.gpu
      const s = world.resource(VolumetricFogGpuResource)
      const c = s.cameras.get(cam.entity)
      if (!c?.volume) return
      const state = world.resource(ForwardStateResource)
      const viewLayout = state.layouts.view
      const msaa = cam.msaa > 1
      const key = `apply/${msaa ? 1 : 0}/${cam.msaa}`
      let byLayout = s.pipelines.get(viewLayout) as unknown as
        | Map<string, GPURenderPipeline>
        | undefined
      if (!byLayout) {
        byLayout = new Map()
        s.pipelines.set(viewLayout, byLayout as never)
      }
      let pipeline = byLayout.get(key)
      if (!pipeline) {
        const module = world.resource(Shaders).module(gpu, {
          root: 'shard::volumetric_fog::apply',
          defines: { MSAA: msaa, TRANSPARENT: true },
        })
        if (!module) {
          gpu.pipelines.skipped++
          return
        }
        pipeline = gpu.pipelines.render({
          label: 'volumetric-fog/apply',
          layout: gpu.layouts.pipelineLayout({
            label: 'volumetric-fog/apply',
            bindGroupLayouts: [viewLayout, msaa ? s.layouts.applyMsaa! : s.layouts.apply!],
          }),
          vertex: { module, entryPoint: 'vs' },
          fragment: {
            module,
            entryPoint: 'fs',
            targets: [
              {
                format: 'rgba16float',
                blend: {
                  color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
                  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                },
              },
            ],
          },
          multisample: { count: cam.msaa },
        })
        if (!pipeline) return
        byLayout.set(key, pipeline)
      }
      const depth = ctx.texture('scene-depth')
      const bound = c.applyBound
      if (!c.applyGroup || bound[0] !== depth || bound[1] !== c.volume || bound[2] !== msaa) {
        c.applyGroup = gpu.device.createBindGroup({
          label: 'volumetric-fog/apply',
          layout: msaa ? s.layouts.applyMsaa! : s.layouts.apply!,
          entries: [
            { binding: 0, resource: { buffer: c.frame.buffer } },
            { binding: 1, resource: c.volume.createView() },
            { binding: 2, resource: s.linear },
            { binding: 3, resource: depth.createView() },
            { binding: 4, resource: { buffer: c.far.buffer } },
          ],
        })
        bound[0] = depth
        bound[1] = c.volume
        bound[2] = msaa
      }
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewBindGroup(gpu, world, pv, cam))
      pass.setBindGroup(1, c.applyGroup)
      pass.draw(3)
    },
  }
}
