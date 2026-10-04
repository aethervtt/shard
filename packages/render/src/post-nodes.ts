import {
  defineResource,
  defineSystem,
  type Entity,
  mat4,
  ProfilerResource,
  type World,
} from '@aethervtt/shard-core'
import { Time } from '@aethervtt/shard-runtime'
import { Exposure } from './camera'
import { addRenderFeatures } from './features'
import { drawMaterials, ForwardStateResource, PASS_PREPASS, viewBindGroup } from './forward'
import { type NodeDescriptor, RenderPhase, type RenderView } from './graph'
import { Graph, Views } from './plugin'
import { AutoExposure, cocParams, hasEffect, needsPrepass, PostEffect } from './post'
import {
  beginPass,
  depthTex,
  forwardView,
  HDR,
  idOf,
  PostCache,
  sampler,
  scratch,
  tex,
  uniform,
} from './post-common'
import { RenderCounters } from './stats'
import { type CameraData, cameraOf } from './view'

// --- prepass -----------------------------------------------------------------------------------

/** Depth, normals, and velocity of opaque geometry, for TAA, motion blur, and forward SSAO. */
const prepassNode: NodeDescriptor = {
  kind: 'render',
  phase: RenderPhase.Prepass,
  enabled: needsPrepass,
  reads: ['culled'],
  writes: ['prepass-normal', 'velocity', 'prepass-depth'],
  color: [
    { resource: 'prepass-normal', clear: { r: 0, g: 0, b: 0, a: 0 } },
    { resource: 'velocity', clear: { r: 0, g: 0, b: 0, a: 0 } },
  ],
  depth: { resource: 'prepass-depth', clear: 0 },
  run: (ctx) => {
    const v = forwardView(ctx)
    if (!v) return
    const state = ctx.world.resource(ForwardStateResource)
    drawMaterials(ctx, state, v.pv, v.cam, v.cam.draws, PASS_PREPASS)
    if (v.cam.deferred) drawMaterials(ctx, state, v.pv, v.cam, v.cam.forwardOnly, PASS_PREPASS)
  },
}

// --- SSAO --------------------------------------------------------------------------------------

/** The fog pipeline's cache keys: alpha output (1), interior view layout (2). */
const FOG_KEYS = ['post/fog', 'post/fog/alpha', 'post/fog/interior', 'post/fog/alpha/interior']

/** Slice directions × steps per side, per quality. */
const SSAO_STEPS = [
  [1, 4],
  [2, 4],
  [3, 6],
] as const
const invProj = mat4.create()

function ssaoNode(phase: number, deferred: boolean): NodeDescriptor {
  const cache = new PostCache()
  let layouts: { gtao: GPUBindGroupLayout; up: GPUBindGroupLayout } | undefined
  let layoutGen = -1
  return {
    kind: 'raw',
    phase,
    enabled: (view) => {
      const cam = cameraOf(view)
      return (
        cam !== undefined && cam.deferred === deferred && (cam.post.effects & PostEffect.Ssao) !== 0
      )
    },
    reads: ['ssao-normal', 'ssao-depth'],
    writes: ['ssao', 'ssao-half'],
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      if (!layouts || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layouts = {
          gtao: gpu.layouts.bindGroupLayout({
            label: 'ssao/gtao',
            entries: [uniform(0), depthTex(gpu, 1), tex(2, 'unfilterable-float'), uniform(3)],
          }),
          up: gpu.layouts.bindGroupLayout({
            label: 'ssao/upsample',
            entries: [uniform(0), depthTex(gpu, 1), uniform(3), tex(4, 'unfilterable-float')],
          }),
        }
      }
      const gtao = cache.render(
        ctx,
        'ssao/gtao',
        'shard::post::ssao',
        'gtao',
        [layouts.gtao],
        [{ format: 'rg16float' }],
      )
      const up = cache.render(
        ctx,
        'ssao/upsample',
        'shard::post::ssao',
        'upsample',
        [layouts.up],
        [{ format: 'r8unorm' }],
      )
      if (!gtao || !up) return
      const { cam, pv } = v
      const s = cam.post.ssao
      const steps = SSAO_STEPS[s.quality] ?? SSAO_STEPS[1]
      scratch[0] = s.radius
      scratch[1] = s.intensity
      scratch[2] = steps[0]
      scratch[3] = steps[1]
      // Pixels per meter at 1 m: the projection's y scale times half the height.
      scratch[4] = cam.proj[5]! * cam.height * 0.5
      scratch[5] = scratch[6] = scratch[7] = 0
      mat4.invert(invProj, cam.proj)
      scratch.set(invProj, 8)
      const params = cache.buffer(gpu, `${ctx.view.name}/ssao`, 96)
      params.write(scratch, 0, 0, 24)
      const depth = ctx.texture('ssao-depth')
      const normal = ctx.texture('ssao-normal')
      const half = ctx.texture('ssao-half')
      const out = ctx.texture('ssao')
      const g1 = cache.group(
        gpu,
        `${ctx.view.name}/gtao`,
        `${idOf(depth)}/${idOf(normal)}/${pv.uniform.version}/${params.version}`,
        layouts.gtao,
        () => [
          { binding: 0, resource: { buffer: pv.uniform.buffer } },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: normal.createView() },
          { binding: 3, resource: { buffer: params.buffer } },
        ],
      )
      let pass = beginPass(ctx, 'ssao', half.createView())
      pass.setPipeline(gtao)
      pass.setBindGroup(0, g1)
      pass.draw(3)
      pass.end()
      const g2 = cache.group(
        gpu,
        `${ctx.view.name}/ssao-up`,
        `${idOf(depth)}/${idOf(half)}/${pv.uniform.version}/${params.version}`,
        layouts.up,
        () => [
          { binding: 0, resource: { buffer: pv.uniform.buffer } },
          { binding: 1, resource: depth.createView() },
          { binding: 3, resource: { buffer: params.buffer } },
          { binding: 4, resource: half.createView() },
        ],
      )
      pass = beginPass(ctx, 'ssao/upsample', out.createView())
      pass.setPipeline(up)
      pass.setBindGroup(0, g2)
      pass.draw(3)
      pass.end()
      pv.ao = out
    },
  }
}

// --- fog ---------------------------------------------------------------------------------------

function fogNode(): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  return {
    kind: 'render',
    phase: RenderPhase.Post,
    enabled: hasEffect(PostEffect.Fog),
    reads: ['fog-in', 'depth', 'environment', 'clusters'],
    writes: ['fog-out'],
    color: [{ resource: 'fog-out', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      const state = ctx.world.resource(ForwardStateResource)
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'fog',
          entries: [tex(0, 'unfilterable-float'), depthTex(gpu, 1), uniform(2)],
        })
      }
      const alpha = v.cam.alphaOutput
      // Group 0 grows while interior lighting is on (0069): its own pipeline then.
      const pipeline = cache.render(
        ctx,
        FOG_KEYS[(alpha ? 1 : 0) + (state.interiorMode !== 0 ? 2 : 0)]!,
        'shard::post::fog',
        'fs',
        [state.layouts.view, layout],
        HDR,
        { TRANSPARENT: alpha },
      )
      if (!pipeline) return
      const f = v.cam.post.fog
      scratch.set(f.color, 0)
      scratch[4] = f.density
      scratch[5] = f.heightFalloff
      scratch[6] = f.start
      scratch[7] = f.sunScattering
      const params = cache.buffer(gpu, `${ctx.view.name}/fog`, 32)
      params.write(scratch, 0, 0, 8)
      const input = ctx.texture('fog-in')
      const depth = ctx.texture('depth')
      const group = cache.group(
        gpu,
        `${ctx.view.name}/fog`,
        `${idOf(input)}/${idOf(depth)}/${params.version}`,
        layout,
        () => [
          { binding: 0, resource: input.createView() },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: { buffer: params.buffer } },
        ],
      )
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewBindGroup(gpu, ctx.world, v.pv, v.cam))
      pass.setBindGroup(1, group)
      pass.draw(3)
    },
  }
}

// --- TAA ---------------------------------------------------------------------------------------

interface History {
  textures: GPUTexture[]
  index: number
  valid: boolean
  generation: number
}

function taaNode(): NodeDescriptor {
  const cache = new PostCache()
  const histories = new Map<string, History>()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  return {
    kind: 'raw',
    phase: RenderPhase.Post + 10,
    enabled: hasEffect(PostEffect.Taa),
    reads: ['taa-in', 'depth', 'velocity'],
    writes: ['taa-out'],
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'taa',
          entries: [
            uniform(0),
            tex(1, 'unfilterable-float'),
            depthTex(gpu, 2),
            tex(3, 'unfilterable-float'),
            tex(4),
            sampler(5),
            uniform(6),
          ],
        })
        histories.clear()
      }
      const alpha = cameraOf(ctx.view)?.alphaOutput === true
      const pipeline = cache.render(
        ctx,
        alpha ? 'post/taa/alpha' : 'post/taa',
        'shard::post::taa',
        'fs',
        [layout],
        [{ format: 'rgba16float' }, { format: 'rgba16float' }],
        { TRANSPARENT: alpha },
      )
      if (!pipeline) return
      const input = ctx.texture('taa-in')
      const out = ctx.texture('taa-out')
      let h = histories.get(ctx.view.name)
      if (
        !h ||
        h.generation !== gpu.generation ||
        h.textures[0]!.width !== input.width ||
        h.textures[0]!.height !== input.height
      ) {
        for (const t of h?.textures ?? []) t.destroy()
        const make = (i: number) =>
          gpu.device.createTexture({
            label: `${ctx.view.name}/taa-history-${i}`,
            size: [input.width, input.height],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          })
        h = { textures: [make(0), make(1)], index: 0, valid: false, generation: gpu.generation }
        histories.set(ctx.view.name, h)
      }
      // A camera's first frame (new, or active again) has no history worth keeping.
      if (v.cam.frames === 1) h.valid = false
      const read = h.textures[h.index]!
      const write = h.textures[1 - h.index]!
      scratch[0] = 0.1
      scratch[1] = h.valid ? 0 : 1
      // Only a new, resized, or lost history starts over; an origin shift moves it (spec 0040).
      if (!h.valid) ctx.world.initResource(RenderCounters).taaResets++
      scratch[2] = scratch[3] = 0
      const params = cache.buffer(gpu, `${ctx.view.name}/taa`, 16)
      params.write(scratch, 0, 0, 4)
      const depth = ctx.texture('depth')
      const velocity = ctx.texture('velocity')
      const group = cache.group(
        gpu,
        `${ctx.view.name}/taa/${h.index}`,
        `${idOf(input)}/${idOf(depth)}/${idOf(velocity)}/${idOf(read)}/${v.pv.uniform.version}/${params.version}`,
        layout,
        () => [
          { binding: 0, resource: { buffer: v.pv.uniform.buffer } },
          { binding: 1, resource: input.createView() },
          { binding: 2, resource: depth.createView() },
          { binding: 3, resource: velocity.createView() },
          { binding: 4, resource: read.createView() },
          { binding: 5, resource: cache.sampler(gpu) },
          { binding: 6, resource: { buffer: params.buffer } },
        ],
      )
      const pass = ctx.encoder.beginRenderPass({
        label: `${ctx.view.name}/taa`,
        colorAttachments: [
          { view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
          { view: write.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
        timestampWrites: ctx.timestamps('post/taa'),
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
      pass.end()
      h.index = 1 - h.index
      h.valid = true
    },
  }
}

// --- motion blur -------------------------------------------------------------------------------

function motionBlurNode(): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  return {
    kind: 'render',
    phase: RenderPhase.Post + 20,
    enabled: hasEffect(PostEffect.MotionBlur),
    reads: ['motion-blur-in', 'depth', 'velocity'],
    writes: ['motion-blur-out'],
    color: [{ resource: 'motion-blur-out', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'motion-blur',
          entries: [
            uniform(0),
            tex(1),
            depthTex(gpu, 2),
            tex(3, 'unfilterable-float'),
            uniform(4),
            sampler(5),
          ],
        })
      }
      const pipeline = cache.render(
        ctx,
        'post/motion-blur',
        'shard::post::motion_blur',
        'fs',
        [layout],
        HDR,
      )
      if (!pipeline) return
      const m = v.cam.post.motionBlur
      scratch[0] = m.shutter
      scratch[1] = m.maxBlur * v.cam.height
      scratch[2] = m.samples
      scratch[3] = 0
      const params = cache.buffer(gpu, `${ctx.view.name}/motion-blur`, 16)
      params.write(scratch, 0, 0, 4)
      const input = ctx.texture('motion-blur-in')
      const depth = ctx.texture('depth')
      const velocity = ctx.texture('velocity')
      const group = cache.group(
        gpu,
        `${ctx.view.name}/motion-blur`,
        `${idOf(input)}/${idOf(depth)}/${idOf(velocity)}/${v.pv.uniform.version}/${params.version}`,
        layout,
        () => [
          { binding: 0, resource: { buffer: v.pv.uniform.buffer } },
          { binding: 1, resource: input.createView() },
          { binding: 2, resource: depth.createView() },
          { binding: 3, resource: velocity.createView() },
          { binding: 4, resource: { buffer: params.buffer } },
          { binding: 5, resource: cache.sampler(gpu) },
        ],
      )
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
    },
  }
}

// --- depth of field ----------------------------------------------------------------------------

function dofNode(): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  const cocScratch = new Float32Array(4)
  return {
    kind: 'raw',
    phase: RenderPhase.Post + 30,
    enabled: hasEffect(PostEffect.DepthOfField),
    reads: ['dof-in', 'depth'],
    writes: ['dof-out', 'dof-half', 'dof-blur'],
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'dof',
          entries: [uniform(0), tex(1), depthTex(gpu, 2), uniform(3), tex(4), sampler(5)],
        })
      }
      const prepare = cache.render(ctx, 'dof/prepare', 'shard::post::dof', 'prepare', [layout], HDR)
      const gather = cache.render(ctx, 'dof/gather', 'shard::post::dof', 'gather', [layout], HDR)
      const composite = cache.render(
        ctx,
        'dof/composite',
        'shard::post::dof',
        'composite',
        [layout],
        HDR,
      )
      if (!prepare || !gather || !composite) return
      const params = cache.buffer(gpu, `${ctx.view.name}/dof`, 16)
      params.write(cocParams(v.cam, cocScratch))
      const input = ctx.texture('dof-in')
      const depth = ctx.texture('depth')
      const half = ctx.texture('dof-half')
      const blur = ctx.texture('dof-blur')
      const out = ctx.texture('dof-out')
      const group = (slot: string, secondary: GPUTexture) =>
        cache.group(
          gpu,
          `${ctx.view.name}/dof/${slot}`,
          `${idOf(input)}/${idOf(depth)}/${idOf(secondary)}/${v.pv.uniform.version}/${params.version}`,
          layout!,
          () => [
            { binding: 0, resource: { buffer: v.pv.uniform.buffer } },
            { binding: 1, resource: input.createView() },
            { binding: 2, resource: depth.createView() },
            { binding: 3, resource: { buffer: params.buffer } },
            { binding: 4, resource: secondary.createView() },
            { binding: 5, resource: cache.sampler(gpu) },
          ],
        )
      const run = (
        name: string,
        pipeline: GPURenderPipeline,
        target: GPUTexture,
        bound: GPUTexture,
      ) => {
        const pass = beginPass(ctx, name, target.createView())
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group(name, bound))
        pass.draw(3)
        pass.end()
      }
      run('post/dof', prepare, half, blur)
      run('post/dof-gather', gather, blur, half)
      run('post/dof-composite', composite, out, blur)
    },
  }
}

// --- bloom -------------------------------------------------------------------------------------

/** Mip levels of a view's bloom chain: `radius` spreads it from 3 levels to the whole view. */
export function bloomLevels(cam: CameraData): number {
  const max = Math.max(1, Math.floor(Math.log2(Math.min(cam.width, cam.height) / 2)) - 1)
  return Math.max(1, Math.min(max, Math.round(3 + cam.post.bloom.radius * (max - 3))))
}

function bloomNode(): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  const params = new Float32Array(64 * 20)
  return {
    kind: 'raw',
    phase: RenderPhase.Post + 40,
    enabled: hasEffect(PostEffect.Bloom),
    reads: ['bloom-in'],
    writes: ['bloom-out', 'bloom'],
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'bloom',
          entries: [tex(0), sampler(1), uniform(2), tex(3, 'unfilterable-float')],
        })
      }
      const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
      const prefilter = cache.render(
        ctx,
        'bloom/prefilter',
        'shard::post::bloom',
        'prefilter',
        [layout],
        HDR,
      )
      const down = cache.render(
        ctx,
        'bloom/downsample',
        'shard::post::bloom',
        'downsample',
        [layout],
        HDR,
      )
      const up = cache.render(
        ctx,
        'bloom/upsample',
        'shard::post::bloom',
        'upsample',
        [layout],
        [{ format: 'rgba16float', blend: { color: add, alpha: add } }],
      )
      const composite = cache.render(
        ctx,
        'bloom/composite',
        'shard::post::bloom',
        'composite',
        [layout],
        HDR,
      )
      if (!prefilter || !down || !up || !composite) return
      const { cam } = v
      const b = cam.post.bloom
      const input = ctx.texture('bloom-in')
      const chain = ctx.texture('bloom')
      const out = ctx.texture('bloom-out')
      const levels = Math.min(chain.mipLevelCount, bloomLevels(cam))
      // One uniform slot per pass, 256 bytes apart: texel size of what it samples.
      const buffer = cache.buffer(gpu, `${ctx.view.name}/bloom`, 256 * 20)
      const slot = (i: number, w: number, h: number) => {
        const o = i * 64
        params[o] = b.threshold * cam.exposure
        params[o + 1] = b.knee * b.threshold * cam.exposure
        params[o + 2] = 1 / w
        params[o + 3] = 1 / h
        params[o + 4] = b.intensity
        params[o + 5] = levels
        params[o + 6] = b.threshold > 0 ? 0 : 1
        params[o + 7] = 0
      }
      const mipSize = (k: number) => [Math.max(1, chain.width >> k), Math.max(1, chain.height >> k)]
      let n = 0
      slot(n++, input.width, input.height) // prefilter samples the input
      for (let k = 1; k < levels; k++) slot(n++, ...(mipSize(k - 1) as [number, number]))
      for (let k = levels - 2; k >= 0; k--) slot(n++, ...(mipSize(k + 1) as [number, number]))
      slot(n++, chain.width, chain.height) // composite samples level 0
      buffer.write(params, 0, 0, n * 64)
      const view = (k: number) => chain.createView({ baseMipLevel: k, mipLevelCount: 1 })
      const group = (i: number, source: GPUTexture, mip: number) =>
        cache.group(
          gpu,
          `${ctx.view.name}/bloom/${i}`,
          `${idOf(source)}/${mip}/${idOf(input)}/${buffer.version}`,
          layout!,
          () => [
            { binding: 0, resource: source === chain ? view(mip) : source.createView() },
            { binding: 1, resource: cache.sampler(gpu) },
            { binding: 2, resource: { buffer: buffer.buffer, offset: i * 256, size: 32 } },
            { binding: 3, resource: input.createView() },
          ],
        )
      let i = 0
      const draw = (
        name: string,
        pipeline: GPURenderPipeline,
        target: GPUTextureView,
        source: GPUTexture,
        mip: number,
        load = false,
      ) => {
        const pass = beginPass(ctx, name, target, load)
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group(i++, source, mip))
        pass.draw(3)
        pass.end()
      }
      draw('post/bloom', prefilter, view(0), input, 0)
      for (let k = 1; k < levels; k++) draw('post/bloom-down', down, view(k), chain, k - 1)
      for (let k = levels - 2; k >= 0; k--) draw('post/bloom-up', up, view(k), chain, k + 1, true)
      draw('post/bloom-composite', composite, out.createView(), chain, 0)
    },
  }
}

// --- auto exposure -----------------------------------------------------------------------------

/** Metered EV100 per camera (from the GPU histogram, a frame or two late) and the adapted EV. */
export interface ExposureState {
  metered: number | undefined
  /** Histogram readings landed so far. Each lands a few frames after its own, when the GPU gets to it. */
  readings: number
  /** Readbacks issued for this camera, one per metered frame (numbered from 1). */
  submitted: number
  /** Which readback `metered` came from. Older readings that land late are ignored. */
  reading: number
  ev: number
  started: boolean
}

/** Histogram readbacks in flight per camera. A frame whose readbacks are all still mapping isn't metered. */
export const METER_READBACKS = 3

export const ExposureMeters = defineResource<Map<Entity, ExposureState>>('render/ExposureMeters', {
  description: 'Auto exposure per camera: the last metered EV100 and the adapted one.',
  init: () => new Map(),
})

/** EV of histogram bin 0, and bins per EV: 256 bins cover EV −8 to 24, 1/8 EV each. */
const METER_MIN_EV = -8
const METER_BINS_PER_EV = 8
const METER_BYTES = 256 * 4

/**
 * The mean EV of a histogram, ignoring the darkest 10% and brightest 2% of the weight so a few
 * dark or blown-out pixels don't swing the exposure.
 */
export function histogramEv(bins: Uint32Array): number | undefined {
  let total = 0
  for (let i = 0; i < bins.length; i++) total += bins[i]!
  if (total === 0) return undefined
  const lo = total * 0.1
  const hi = total * 0.98
  let seen = 0
  let sum = 0
  let weight = 0
  for (let i = 0; i < bins.length; i++) {
    const n = bins[i]!
    const a = Math.max(seen, lo)
    const b = Math.min(seen + n, hi)
    if (b > a) {
      sum += (b - a) * (METER_MIN_EV + (i + 0.5) / METER_BINS_PER_EV)
      weight += b - a
    }
    seen += n
  }
  return weight > 0 ? sum / weight : undefined
}

/**
 * Records a metered EV that landed: the newest reading wins, older ones that land late don't.
 */
function landReading(
  meters: Map<Entity, ExposureState>,
  entity: Entity,
  index: number,
  ev: number | undefined,
): void {
  const m = meters.get(entity)
  if (m && ev !== undefined && index > m.reading) {
    m.metered = ev
    m.reading = index
    m.readings++
  }
}

/**
 * Auto exposure's meter: a GPU histogram read back a frame or two late. On baseline (0064), without
 * compute, a small meter image binned into the same histogram on the CPU (baseline/exposure.ts).
 */
function autoExposureNode(
  baseline: typeof import('./baseline/exposure') | undefined,
): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  const perView = new Map<
    string,
    { histogram: GPUBuffer; readbacks: GPUBuffer[]; busy: boolean[]; generation: number }
  >()
  const meterViews = new Map<string, import('./baseline/exposure').MeterView>()
  const zero = new Uint32Array(256)
  const bins = new Uint32Array(256)
  return {
    kind: 'raw',
    phase: RenderPhase.Post + 50,
    enabled: hasEffect(PostEffect.AutoExposure),
    reads: ['post-hdr'],
    sideEffects: true,
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      if (baseline) {
        const layout = baseline.meterLayout(gpu)
        const pipeline = cache.render(
          ctx,
          'post/exposure-meter',
          'shard::post::baseline::meter',
          'main',
          [layout],
          [{ format: 'rg16float' }],
        )
        if (!pipeline) return
        let m = meterViews.get(ctx.view.name)
        if (!m || m.generation !== gpu.generation) {
          m = baseline.meterView(gpu, ctx.view.name, METER_READBACKS)
          meterViews.set(ctx.view.name, m)
        }
        const input = ctx.texture('post-hdr')
        const key = `${idOf(input)}/${v.pv.uniform.version}`
        if (!m.group || m.groupKey !== key) {
          m.groupKey = key
          m.group = gpu.device.createBindGroup({
            label: `${ctx.view.name}/exposure`,
            layout,
            entries: [
              { binding: 0, resource: { buffer: v.pv.uniform.buffer } },
              { binding: 1, resource: input.createView() },
              { binding: 2, resource: { buffer: m.params } },
            ],
          })
        }
        scratch[0] = METER_MIN_EV
        scratch[1] = METER_BINS_PER_EV
        scratch[2] = v.cam.post.exposure.metering
        scratch[3] = 0
        const k = baseline.renderMeter(ctx, m, pipeline, m.group, scratch.subarray(0, 4))
        if (k === undefined) return
        const meters = ctx.world.resource(ExposureMeters)
        const entity = v.cam.entity
        const meter = meters.get(entity)
        const index = meter ? ++meter.submitted : 0
        const readback = m.readbacks[k]!
        const busy = m.busy
        ctx.afterSubmit(() => {
          readback.mapAsync(GPUMapMode.READ).then(
            () => {
              baseline.binMeter(readback.getMappedRange(), METER_MIN_EV, METER_BINS_PER_EV, bins)
              readback.unmap()
              busy[k] = false
              landReading(meters, entity, index, histogramEv(bins))
            },
            () => {
              busy[k] = false
            },
          )
        })
        return
      }
      const C = GPUShaderStage.COMPUTE
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'exposure',
          entries: [
            uniform(0, C),
            { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
            { binding: 2, visibility: C, buffer: { type: 'storage' } },
            uniform(3, C),
          ],
        })
        perView.clear()
      }
      const pipeline = cache.compute(ctx, 'post/exposure', 'shard::post::exposure', 'meter', [
        layout,
      ])
      if (!pipeline) return
      let state = perView.get(ctx.view.name)
      if (!state || state.generation !== gpu.generation) {
        state = {
          histogram: gpu.device.createBuffer({
            label: `${ctx.view.name}/exposure-histogram`,
            size: METER_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          }),
          readbacks: Array.from({ length: METER_READBACKS }, (_, i) =>
            gpu.device.createBuffer({
              label: `${ctx.view.name}/exposure-readback-${i}`,
              size: METER_BYTES,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }),
          ),
          busy: Array.from({ length: METER_READBACKS }, () => false),
          generation: gpu.generation,
        }
        perView.set(ctx.view.name, state)
      }
      const e = v.cam.post.exposure
      scratch[0] = METER_MIN_EV
      scratch[1] = METER_BINS_PER_EV
      scratch[2] = e.metering
      scratch[3] = 0
      const params = cache.buffer(gpu, `${ctx.view.name}/exposure`, 16)
      params.write(scratch, 0, 0, 4)
      const input = ctx.texture('post-hdr')
      const histogram = state.histogram
      const group = cache.group(
        gpu,
        `${ctx.view.name}/exposure`,
        `${idOf(input)}/${idOf(histogram)}/${v.pv.uniform.version}/${params.version}`,
        layout,
        () => [
          { binding: 0, resource: { buffer: v.pv.uniform.buffer } },
          { binding: 1, resource: input.createView() },
          { binding: 2, resource: { buffer: histogram } },
          { binding: 3, resource: { buffer: params.buffer } },
        ],
      )
      gpu.device.queue.writeBuffer(histogram, 0, zero)
      const pass = ctx.encoder.beginComputePass({
        label: `${ctx.view.name}/exposure`,
        timestampWrites: ctx.timestamps('post/exposure'),
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(input.width / 64), Math.ceil(input.height / 64))
      pass.end()
      const k = state.busy.indexOf(false)
      if (k < 0) return
      const readback = state.readbacks[k]!
      ctx.encoder.copyBufferToBuffer(histogram, 0, readback, 0, METER_BYTES)
      state.busy[k] = true
      const busy = state.busy
      const meters = ctx.world.resource(ExposureMeters)
      const entity = v.cam.entity
      const meter = meters.get(entity)
      const index = meter ? ++meter.submitted : 0
      ctx.afterSubmit(() => {
        readback.mapAsync(GPUMapMode.READ).then(
          () => {
            const ev = histogramEv(new Uint32Array(readback.getMappedRange().slice(0)))
            readback.unmap()
            busy[k] = false
            landReading(meters, entity, index, ev)
          },
          () => {
            busy[k] = false
          },
        )
      })
    },
  }
}

/**
 * Moves each AutoExposure camera's Exposure.ev100 toward its metered EV (minus compensation,
 * within bounds) at its adaptation speed. Starts from the camera's own exposure.
 */
export const adaptExposure = defineSystem({
  name: 'render/auto-exposure',
  description: 'Adapts Exposure.ev100 of AutoExposure cameras toward their metered brightness.',
  setup: (world) => ({ q: world.query({ with: [AutoExposure, Exposure] }) }),
  run: ({ q }, world) => {
    const meters = world.resource(ExposureMeters)
    const dt = world.resource(Time).delta
    for (const table of q.tables) {
      const ev = table.column(Exposure, 'ev100')
      const minEv = table.column(AutoExposure, 'minEv')
      const maxEv = table.column(AutoExposure, 'maxEv')
      const comp = table.column(AutoExposure, 'compensation')
      const upSpeed = table.column(AutoExposure, 'speedUp')
      const downSpeed = table.column(AutoExposure, 'speedDown')
      for (let i = 0; i < table.count; i++) {
        const entity = table.entities[i]!
        let m = meters.get(entity)
        if (!m) {
          m = {
            metered: undefined,
            readings: 0,
            submitted: 0,
            reading: 0,
            ev: ev[i]!,
            started: true,
          }
          meters.set(entity, m)
        }
        if (m.metered !== undefined) {
          const target = Math.min(maxEv[i]!, Math.max(minEv[i]!, m.metered - comp[i]!))
          const speed = target > m.ev ? upSpeed[i]! : downSpeed[i]!
          const step = speed * dt
          const d = target - m.ev
          m.ev += Math.abs(d) <= step ? d : Math.sign(d) * step
        }
        ev[i] = m.ev
      }
      table.markChanged(Exposure)
    }
  },
})

// --- install -----------------------------------------------------------------------------------

/** Graph node names of the post chain, in order (for describe and tests). */
export const POST_NODES = [
  ['post/fog', PostEffect.Fog],
  ['post/taa', PostEffect.Taa],
  ['post/motion-blur', PostEffect.MotionBlur],
  ['post/dof', PostEffect.DepthOfField],
  ['post/bloom', PostEffect.Bloom],
  ['post/exposure', PostEffect.AutoExposure],
  ['post/fxaa', PostEffect.Fxaa],
] as const

const halfSize = { divide: 2 }

/** Adds the prepass, SSAO, and the post chain to the graph. */
/** The post chain's nodes. `baseline`: the baseline tier's exposure meter (0064), when on one. */
export function addPostNodes(world: World, baseline?: typeof import('./baseline/exposure')): void {
  const graph = world.resource(Graph)
  world.initResource(ExposureMeters)
  graph.declare({ name: 'prepass-normal', format: 'rgba16float' })
  graph.declare({ name: 'velocity', format: 'rg16float' })
  graph.declare({ name: 'prepass-depth', format: 'depth32float' })
  graph.declare({ name: 'ssao', format: 'r8unorm' })
  graph.declare({ name: 'ssao-half', format: 'rg16float', size: halfSize })
  graph.declare({ name: 'post-a', format: 'rgba16float' })
  graph.declare({ name: 'post-b', format: 'rgba16float' })
  graph.declare({ name: 'dof-half', format: 'rgba16float', size: halfSize })
  graph.declare({ name: 'dof-blur', format: 'rgba16float', size: halfSize })
  graph.declare({
    name: 'bloom',
    format: 'rgba16float',
    size: halfSize,
    mipLevelCount: (view: RenderView) => {
      const cam = cameraOf(view)
      return cam ? bloomLevels(cam) : 1
    },
  })
  addRenderFeatures(world, {
    name: 'render/post',
    description: 'The prepass, SSAO, fog, TAA, motion blur, depth of field and bloom.',
    nodes: [
      'prepass',
      'ssao',
      'ssao-deferred',
      'post/fog',
      'post/taa',
      'post/motion-blur',
      'post/dof',
      'post/bloom',
    ],
    baseline: { strategy: 'The same fragment passes' },
  })
  addRenderFeatures(world, {
    name: 'render/auto-exposure',
    description: 'Automatic exposure from a luminance histogram.',
    nodes: ['post/exposure'],
    baseline: {
      strategy: 'A 64×36 meter image read back and binned into the same histogram on the CPU',
    },
  })
  graph.addNode('prepass', prepassNode)
  graph.addNode('ssao', ssaoNode(RenderPhase.Prepass + 50, false))
  graph.addNode('ssao-deferred', ssaoNode(RenderPhase.Opaque + 20, true))
  graph.addNode('post/fog', fogNode())
  graph.addNode('post/taa', taaNode())
  graph.addNode('post/motion-blur', motionBlurNode())
  graph.addNode('post/dof', dofNode())
  graph.addNode('post/bloom', bloomNode())
  graph.addNode('post/exposure', autoExposureNode(baseline))
}

// --- describe ----------------------------------------------------------------------------------

/** Effects in the order they run: node name prefix (for GPU time), effect bit. */
const DESCRIBED = [
  ['ssao', 'ssao', PostEffect.Ssao],
  ['fog', 'post/fog', PostEffect.Fog],
  ['taa', 'post/taa', PostEffect.Taa],
  ['motion-blur', 'post/motion-blur', PostEffect.MotionBlur],
  ['dof', 'post/dof', PostEffect.DepthOfField],
  ['bloom', 'post/bloom', PostEffect.Bloom],
  ['auto-exposure', 'post/exposure', PostEffect.AutoExposure],
  ['color-grading', 'tonemap', PostEffect.Grading],
  ['vignette', 'tonemap', PostEffect.Vignette],
  ['fxaa', 'post/fxaa', PostEffect.Fxaa],
] as const

/** GPU milliseconds of every pass whose name is `prefix` or starts with it plus '-' or '/'. */
function gpuMs(timings: Record<string, { avg: number }>, prefix: string): number | undefined {
  let total: number | undefined
  const key = `gpu:${prefix}`
  for (const name in timings) {
    if (name === key || name.startsWith(`${key}-`) || name.startsWith(`${key}/`)) {
      total = (total ?? 0) + timings[name]!.avg
    }
  }
  return total
}

/** The post section of `render.describe`: per view, active effects in order with GPU time. */
export function describePost(world: World) {
  const profiler = world.tryResource(ProfilerResource)
  const timings = profiler?.all() ?? {}
  const meters = world.tryResource(ExposureMeters)
  const views: Record<string, unknown> = {}
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    if (!cam) continue
    const effects = []
    for (const [name, node, bit] of DESCRIBED) {
      if ((cam.post.effects & bit) === 0) continue
      // Grading and the vignette ride in the tonemap pass: no time of their own.
      const shared = node === 'tonemap'
      effects.push({ name, gpuMs: shared ? undefined : gpuMs(timings, node) })
    }
    const meter = meters?.get(cam.entity)
    views[view.name] = {
      effects,
      antialiasing:
        cam.post.effects & PostEffect.Taa
          ? 'taa'
          : cam.post.effects & PostEffect.Fxaa
            ? 'fxaa'
            : cam.msaa > 1
              ? `msaa x${cam.msaa}`
              : 'none',
      prepass: needsPrepass(view),
      ev100: cam.ev100,
      meteredEv100: meter?.metered,
      // Per-pass times overlap on tile-based GPUs; these spans don't.
      gpuMs: {
        prepass: timings['gpu:prepass']?.avg,
        ssao: timings['gpu:span/ssao']?.avg,
        post: timings['gpu:span/post']?.avg,
      },
    }
  }
  return { views }
}
