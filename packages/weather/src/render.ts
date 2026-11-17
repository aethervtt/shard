import { affine, defineResource, defineSystem, type World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import {
  cameraOf,
  ForwardStateResource,
  type NodeContext,
  type NodeDescriptor,
  RenderPhase,
  ShaderData,
  Shaders,
  sceneColor,
  viewBindGroup,
} from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { CH, WeatherMaskBrush, WeatherState } from './components'
import { LightningState, MAX_SEGMENTS, SEGMENT_FLOATS } from './lightning'
import { MAX_BRUSHES } from './shaders'

/** Most raindrops, near drops, snowflakes and splashes drawn at full intensity. */
const MAX_RAIN = 20000
const MAX_NEAR_RAIN = 1800
const MAX_SNOW = 14000
const MAX_SPLASHES = 1400

export class WeatherGpu {
  generation = -1
  /** First shard::shader_data slot of the weather block, or -1. */
  slot = -1
  layouts: Record<string, GPUBindGroupLayout> = {}
  rain: GpuBuffer | undefined
  near: GpuBuffer | undefined
  snow: GpuBuffer | undefined
  splash: GpuBuffer | undefined
  bolt: GpuBuffer | undefined
  segments: GpuBuffer | undefined
  rainGroup: GPUBindGroup | undefined
  nearGroup: GPUBindGroup | undefined
  snowGroup: GPUBindGroup | undefined
  /** Splashes read the scene's depth: a group per depth texture. */
  splashGroup: GPUBindGroup | undefined
  splashDepth: GPUTexture | undefined
  boltGroup: GPUBindGroup | undefined
  readonly pipelines = new Map<unknown, Map<string, GPURenderPipeline>>()

  ensure(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.generation = gpu.generation
    this.pipelines.clear()
    const V = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    const uniform = (label: string) =>
      new GpuBuffer(gpu, { label, usage: GPUBufferUsage.UNIFORM, size: 64 })
    this.rain = uniform('weather/rain')
    this.near = uniform('weather/rain-near')
    this.snow = uniform('weather/snow')
    this.splash = uniform('weather/splash')
    this.splashGroup = undefined
    this.splashDepth = undefined
    this.bolt = uniform('weather/bolt')
    this.segments = new GpuBuffer(gpu, {
      label: 'weather/bolt-segments',
      usage: GPUBufferUsage.STORAGE,
      size: MAX_SEGMENTS * SEGMENT_FLOATS * 4,
    })
    this.layouts = {
      precip: gpu.layouts.bindGroupLayout({
        label: 'weather/precip',
        entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform' } }],
      }),
      splash: gpu.layouts.bindGroupLayout({
        label: 'weather/splash',
        entries: splashEntries(V, false),
      }),
      splashMsaa: gpu.layouts.bindGroupLayout({
        label: 'weather/splash-msaa',
        entries: splashEntries(V, true),
      }),
      bolt: gpu.layouts.bindGroupLayout({
        label: 'weather/bolt',
        entries: [
          { binding: 0, visibility: V, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      }),
    }
    const group = (buffer: GpuBuffer) =>
      gpu.device.createBindGroup({
        label: 'weather/precip',
        layout: this.layouts.precip!,
        entries: [{ binding: 0, resource: { buffer: buffer.buffer } }],
      })
    this.rainGroup = group(this.rain)
    this.nearGroup = group(this.near)
    this.snowGroup = group(this.snow)
    this.boltGroup = gpu.device.createBindGroup({
      label: 'weather/bolt',
      layout: this.layouts.bolt!,
      entries: [
        { binding: 0, resource: { buffer: this.bolt.buffer } },
        { binding: 1, resource: { buffer: this.segments.buffer } },
      ],
    })
  }
}

function splashEntries(V: number, msaa: boolean): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 0, visibility: V, buffer: { type: 'uniform' } },
    {
      binding: 1,
      visibility: GPUShaderStage.VERTEX,
      texture: { sampleType: 'depth', multisampled: msaa },
    },
  ]
}

export const WeatherGpuResource = defineResource<WeatherGpu>('weather/Gpu', {
  description: "Rain, snow and lightning's uniforms and pipelines (0133).",
  init: () => new WeatherGpu(),
})

const inverse = new Float32Array(12)
const matrix = new Float32Array(12)

/**
 * Writes the weather block of shard::shader_data (0134): the surfaces' state, rain and snow, and
 * the mask brushes, for surface weather and precipitation.
 */
export const uploadWeather = defineSystem({
  name: 'weather/upload',
  description: 'Writes the weather block of shard::shader_data: state and mask brushes (0134).',
  setup: (world) => ({ brushes: world.query({ with: [WeatherMaskBrush, GlobalTransform] }) }),
  run: ({ brushes }, world) => {
    const gpu = world.resource(WeatherGpuResource)
    const data = world.tryResource(ShaderData)
    if (gpu.slot < 0 || !data) return
    const s = world.resource(WeatherState)
    const v = data.values
    const o = gpu.slot * 4
    v[o] = s.wetness
    v[o + 1] = s.snowCover
    v[o + 2] = s.dustCover
    v[o + 3] = s.channels[CH.rain]!
    v[o + 4] = world.tryResource(Time)?.elapsed ?? 0
    v[o + 5] = s.channels[CH.snow]!
    v[o + 6] = s.channels[CH.wind]!
    v[o + 8] = 0.55
    v[o + 9] = 0.45
    v[o + 10] = 0.3
    v[o + 11] = 1
    let n = 0
    for (const table of brushes.tables) {
      const g = table.column(GlobalTransform, 'matrix')
      const edge = table.column(WeatherMaskBrush, 'edge')
      for (let i = 0; i < table.count && n < MAX_BRUSHES; i++) {
        for (let k = 0; k < 12; k++) matrix[k] = g[i * 12 + k]!
        if (!affine.invert(inverse, matrix)) continue
        const b = o + 16 + n * 16
        for (let k = 0; k < 12; k++) v[b + k] = inverse[k]!
        v[b + 12] = edge[i]!
        n++
      }
    }
    v[o + 7] = n
    // Spring, summer, autumn, winter: weather_season() for materials that change with the year.
    v[o + 12] = s.seasons[0]!
    v[o + 13] = s.seasons[1]!
    v[o + 14] = s.seasons[2]!
    v[o + 15] = s.seasons[3]!
  },
})

const params = new Float32Array(16)

function pipeline(
  ctx: NodeContext,
  s: WeatherGpu,
  view: GPUBindGroupLayout,
  root: string,
  layout: string,
  msaa: number,
  sky: boolean,
  blend: GPUBlendState,
  splash = false,
): GPURenderPipeline | undefined {
  let byLayout = s.pipelines.get(view)
  if (!byLayout) {
    byLayout = new Map()
    s.pipelines.set(view, byLayout)
  }
  const key = `${root}/${msaa}/${sky ? 1 : 0}/${splash ? 1 : 0}`
  const cached = byLayout.get(key)
  if (cached) return cached
  const module = ctx.world.resource(Shaders).module(ctx.gpu, {
    root,
    defines: { SKY_OCCLUSION: sky, SPLASH: splash, MSAA: msaa > 1 },
  })
  if (!module) {
    ctx.gpu.pipelines.skipped++
    return undefined
  }
  const p = ctx.gpu.pipelines.render({
    label: root,
    layout: ctx.gpu.layouts.pipelineLayout({
      label: root,
      bindGroupLayouts: [view, s.layouts[layout]!],
    }),
    vertex: { module, entryPoint: splash ? 'vs_splash' : 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend }] },
    // Reversed-Z: drawn only in front of the scene, never writing depth.
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' },
    multisample: { count: msaa },
  })
  if (p) byLayout.set(key, p)
  return p
}

const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
}
const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
}

function active(world: World): boolean {
  const s = world.resource(WeatherState)
  return (
    s.channels[CH.rain]! > 0.01 ||
    s.channels[CH.snow]! > 0.01 ||
    world.resource(LightningState).bolt > 0.01
  )
}

/** Rain, snow and lightning bolts (0133), after transparent objects, lit like the scene. */
export function precipitationNode(world: World): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Transparent + 5,
    // Its own pass, with depth read-only: splashes sample the depth they're tested against.
    ownPass: true,
    writes: ['scene-color', 'hdr'],
    color: (view) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    enabled: (view) => cameraOf(view) !== undefined && active(world),
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      const state = ctx.world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      if (!cam || !pv) return
      const gpu = ctx.gpu
      const s = ctx.world.resource(WeatherGpuResource)
      s.ensure(gpu)
      const weather = ctx.world.resource(WeatherState)
      const wind = ctx.world.tryResource(Wind)
      const time = ctx.world.tryResource(Time)?.elapsed ?? 0
      const wx = wind ? wind.direction[0] * wind.speed : 0
      const wz = wind ? wind.direction[2] * wind.speed : 0
      const view = state.layouts.view
      const sky = state.skyOcclusion
      const pass = ctx.renderPass!
      const group0 = viewBindGroup(gpu, ctx.world, pv, cam)
      const precip = () =>
        pipeline(ctx, s, view, 'shard::weather::precip', 'precip', cam.msaa, sky, PREMULTIPLIED)
      const layer = (
        kind: 'rain' | 'near' | 'snow',
        amount: number,
        buffer: GpuBuffer,
        group: GPUBindGroup,
      ) => {
        if (amount <= 0.01) return
        const snow = kind === 'snow'
        const near = kind === 'near'
        const max = snow ? MAX_SNOW : near ? MAX_NEAR_RAIN : MAX_RAIN
        const count = Math.ceil(max * Math.min(1, amount))
        const box = snow ? 30 : near ? 9 : 40
        params[0] = cam.position[0]!
        params[1] = cam.position[1]!
        params[2] = cam.position[2]!
        params[3] = time
        params[4] = box
        params[5] = snow ? 18 : near ? 9 : 24
        params[6] = box
        params[7] = count
        params[8] = wx * (snow ? 0.7 : 0.45)
        params[9] = snow ? -1.2 : -9.5
        params[10] = wz * (snow ? 0.7 : 0.45)
        // Near drops cross the frame fast: a longer streak is their motion blur.
        params[11] = near ? 0.045 : 0.03
        params[12] = snow ? 0.022 : near ? 0.004 : 0.0055
        params[13] = snow ? 1 : 0
        params[14] = snow ? 0.9 : near ? 0.5 : 0.42
        params[15] = snow ? 0.35 : 0
        buffer.write(params)
        const p = precip()
        if (!p) return
        pass.setPipeline(p)
        pass.setBindGroup(0, group0)
        pass.setBindGroup(1, group)
        pass.draw(6, count)
      }
      const rain = weather.channels[CH.rain]!
      layer('rain', rain, s.rain!, s.rainGroup!)
      layer('near', rain, s.near!, s.nearGroup!)
      layer('snow', weather.channels[CH.snow]!, s.snow!, s.snowGroup!)
      if (rain > 0.01) {
        const msaa = cam.msaa > 1
        const p = pipeline(
          ctx,
          s,
          view,
          'shard::weather::precip',
          msaa ? 'splashMsaa' : 'splash',
          cam.msaa,
          sky,
          PREMULTIPLIED,
          true,
        )
        const depth = ctx.texture('scene-depth')
        if (p) {
          if (!s.splashGroup || s.splashDepth !== depth) {
            s.splashGroup = gpu.device.createBindGroup({
              label: 'weather/splash',
              layout: msaa ? s.layouts.splashMsaa! : s.layouts.splash!,
              entries: [
                { binding: 0, resource: { buffer: s.splash!.buffer } },
                { binding: 1, resource: depth.createView() },
              ],
            })
            s.splashDepth = depth
          }
          const count = Math.ceil(MAX_SPLASHES * Math.min(1, rain))
          params[3] = time
          params[7] = count
          params[13] = 2
          params[14] = 0.55
          s.splash!.write(params)
          pass.setPipeline(p)
          pass.setBindGroup(0, group0)
          pass.setBindGroup(1, s.splashGroup)
          pass.draw(6, count * 3)
        }
      }
      const lightning = ctx.world.resource(LightningState)
      if (lightning.count > 0 && lightning.ground && lightning.bolt > 0.01) {
        const p = pipeline(ctx, s, view, 'shard::weather::bolt', 'bolt', cam.msaa, sky, ADDITIVE)
        if (!p) return
        params[0] = 2e5 * Math.min(1.5, lightning.bolt)
        s.bolt!.write(params, 0, 0, 4)
        s.segments!.write(lightning.segments, 0, 0, lightning.count * SEGMENT_FLOATS)
        pass.setPipeline(p)
        pass.setBindGroup(0, group0)
        pass.setBindGroup(1, s.boltGroup!)
        pass.draw(6, lightning.count)
      }
    },
  }
}
