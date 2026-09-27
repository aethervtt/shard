import { defineResource, defineSystem, type World } from '@aethervtt/shard-core'
import { DisplayRate, Time } from '@aethervtt/shard-runtime'
import { Gpu, Graph, Views } from './plugin'
import type { CameraData } from './view'

export interface RenderScaleValue {
  /** auto: the controller moves `scale` to hold the frame budget. fixed: `scale` stays as set. */
  mode: 'auto' | 'fixed'
  /** Render resolution as a fraction of the window's backing size. The controller writes it. */
  scale: number
  /** Bounds for auto mode. */
  min: number
  max: number
  /**
   * Frame budget auto mode holds, in ms. 0 (the default): one refresh of the display
   * (DisplayRate), so a 120 Hz screen gets 8.3 ms, but never faster than `maxHz`.
   */
  targetMs: number
  /** With targetMs 0: the fastest refresh rate worth holding; above it, frames get this budget. */
  maxHz: number
  /** The budget auto mode is holding now, in ms. Read-only. */
  budgetMs: number
  /** Contrast-adaptive sharpening of the upscale, 0–1. */
  sharpen: number
  /** Window cameras the scale applied to last frame. Read-only. */
  windowViews: number
  /** What auto mode measures: GPU frame time, the frame interval, or nothing. Read-only. */
  signal: 'gpu' | 'frame' | 'none'
  /** The smoothed measurement, in ms. Read-only. */
  measuredMs: number
}

export const RenderScale = defineResource<RenderScaleValue>('render/RenderScale', {
  description:
    'Render resolution of window cameras (0051): the scene renders at scale × the window size and is upscaled, UI stays native. auto moves the scale between min and max to hold the frame budget: targetMs, or one display refresh (DisplayRate) when it is 0.',
  init: () => ({
    mode: 'auto',
    scale: 1,
    min: 0.5,
    max: 1,
    targetMs: 0,
    maxHz: 144,
    budgetMs: 1000 / 60,
    sharpen: 0.25,
    windowViews: 0,
    signal: 'none',
    measuredMs: 0,
  }),
})

/** Scales snap to this (1 / STEPS), so the texture pool sees few sizes. */
export const SCALE_STEP = 0.05
const STEPS = 20
const LOWEST = 0.25
const HIGHEST = 2

/** A size at a render scale, in whole pixels. Scales outside 0.25–2 are clamped. */
export function scaledSize(size: number, scale: number): number {
  return Math.max(1, Math.round(size * clamp(scale, LOWEST, HIGHEST)))
}

const snapDown = (s: number) => Math.floor(s * STEPS + 1e-6) / STEPS
const snap = (s: number) => Math.round(s * STEPS) / STEPS
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** What the controller reads from the GPU timer. */
export interface FrameTimings {
  readonly enabled: boolean
  readonly frameMs: number
  readonly frameSamples: number
}

/** Frames it averages after a change before deciding anything. */
const SETTLE_SAMPLES = 10
/** Seconds after a change during which samples are dropped (readbacks of the old size). */
const COOLDOWN = 0.3

/**
 * Dynamic resolution. With GPU timings it steps straight toward the budget (cost ∝ scale²); on
 * the frame interval alone it drops on overruns, undoes a run of drops that didn't help at all
 * (CPU-bound), and probes upward, backing off after failed probes. Vsync makes the interval move
 * in whole refresh periods, so a single drop often shows nothing: runs of drops are judged together.
 */
export class RenderScaleController {
  private ema = 0
  private samples = 0
  private cooldown = 0
  private under = 0
  private lastSample = -1
  /** Frame mode: the measurement and scale before the current run of drops (0: none). */
  private runEma = 0
  private runFrom = 0
  /** Frame mode: the interval found CPU-bound; overruns no worse than it are left alone. */
  private cpuEma = 0
  /** Frame mode: the scale before an upward probe, while it's being verified. */
  private probeFrom = 0
  private probeAge = 0
  private probeWait = 3
  private hold = 0

  /**
   * One frame. `skip`: pipelines are compiling, so the frame says nothing about steady cost.
   * `displayMs`: one refresh of the display, the budget when `targetMs` is 0.
   */
  update(
    s: RenderScaleValue,
    dt: number,
    timings: FrameTimings,
    skip: boolean,
    displayMs = 1000 / 60,
  ): void {
    const lo = clamp(s.min, LOWEST, HIGHEST)
    const hi = clamp(s.max, lo, HIGHEST)
    s.budgetMs = s.targetMs > 0 ? s.targetMs : Math.max(displayMs, 1000 / Math.max(1, s.maxHz))
    if (s.mode !== 'auto' || s.windowViews === 0) {
      s.signal = 'none'
      this.reset()
      return
    }
    const clamped = clamp(snap(s.scale), lo, hi)
    if (clamped !== s.scale) this.set(s, clamped)
    const gpu = timings.enabled && timings.frameSamples > 0
    s.signal = gpu ? 'gpu' : 'frame'
    if (this.cooldown > 0) {
      this.cooldown -= dt
      this.lastSample = timings.frameSamples
      return
    }
    if (skip || dt >= 0.2) return
    let sample: number
    if (gpu) {
      if (timings.frameSamples === this.lastSample) return
      this.lastSample = timings.frameSamples
      sample = timings.frameMs
    } else {
      sample = dt * 1000
    }
    this.ema = this.samples === 0 ? sample : this.ema * 0.9 + sample * 0.1
    this.samples++
    s.measuredMs = this.ema
    if (this.samples < SETTLE_SAMPLES) return
    if (gpu) this.gpuStep(s, lo, hi, dt)
    else this.frameStep(s, lo, hi, dt)
  }

  private gpuStep(s: RenderScaleValue, lo: number, hi: number, dt: number): void {
    const t = s.budgetMs
    const ema = this.ema
    if (ema > t * 0.95) {
      this.under = 0
      const next = Math.max(
        lo,
        Math.min(snapDown(s.scale * Math.sqrt((0.8 * t) / ema)), s.scale - SCALE_STEP),
      )
      if (next < s.scale) this.set(s, next)
    } else if (s.scale < hi && ema * ((s.scale + SCALE_STEP) / s.scale) ** 2 < t * 0.8) {
      // Headroom for at least one step up, predicted from cost ∝ scale²: it lands under 80% of
      // the budget, clear of the drop threshold, so rising can't start an oscillation.
      this.under += dt
      if (this.under < 1) return
      const want = snapDown(s.scale * Math.sqrt((0.8 * t) / ema))
      const next = Math.min(hi, s.scale + 0.1, Math.max(want, s.scale + SCALE_STEP))
      this.set(s, snap(next))
    } else {
      this.under = 0
    }
  }

  private frameStep(s: RenderScaleValue, lo: number, hi: number, dt: number): void {
    const t = s.budgetMs
    const ema = this.ema
    if (this.hold > 0) {
      this.hold -= dt
      return
    }
    if (this.probeFrom > 0) {
      if (ema > t * 1.15) {
        const back = this.probeFrom
        this.probeFrom = 0
        this.probeWait = Math.min(this.probeWait * 2, 30)
        this.set(s, back)
        return
      }
      this.probeAge += dt
      if (this.probeAge >= 2) {
        this.probeFrom = 0
        this.probeWait = 3
      }
    }
    if (ema > t * 1.15) {
      this.under = 0
      if (this.cpuEma > 0 && ema < this.cpuEma * 1.1) return
      if (this.runEma === 0) {
        this.runEma = ema
        this.runFrom = s.scale
      } else if (
        s.scale < this.runFrom &&
        (s.scale <= this.runFrom * 0.71 + 1e-6 || s.scale <= lo) &&
        ema > this.runEma * 0.95
      ) {
        // Half the pixels and not one refresh period shorter: halving a GPU-bound frame's cost
        // always is, so the CPU is the bottleneck.
        const from = this.runFrom
        this.cpuEma = this.runEma
        this.runEma = 0
        this.set(s, from)
        this.hold = 10
        return
      }
      if (s.scale <= lo) return
      this.probeFrom = 0
      this.set(s, snap(Math.max(lo, s.scale - 2 * SCALE_STEP)))
    } else if (ema <= t * 1.05) {
      this.runEma = 0
      this.cpuEma = 0
      this.under += dt
      if (this.under >= this.probeWait && s.scale < hi && this.probeFrom === 0) {
        this.probeFrom = s.scale
        this.probeAge = 0
        this.set(s, snap(Math.min(hi, s.scale + SCALE_STEP)))
      }
    } else {
      this.under = 0
    }
  }

  private set(s: RenderScaleValue, scale: number): void {
    s.scale = scale
    this.ema = 0
    this.samples = 0
    this.under = 0
    this.cooldown = COOLDOWN
  }

  private reset(): void {
    this.ema = 0
    this.samples = 0
    this.under = 0
    this.cooldown = 0
    this.runEma = 0
    this.cpuEma = 0
    this.probeFrom = 0
    this.probeWait = 3
    this.hold = 0
  }
}

export const updateRenderScale = defineSystem({
  name: 'render/update-render-scale',
  description: 'Dynamic resolution: moves RenderScale.scale to hold the frame budget (auto mode).',
  setup: () => ({ controller: new RenderScaleController() }),
  run: ({ controller }, world) => {
    const s = world.tryResource(RenderScale)
    const gpu = world.tryResource(Gpu)
    const graph = world.tryResource(Graph)
    if (!s || !gpu || !graph) return
    const display = world.tryResource(DisplayRate)?.periodMs
    controller.update(
      s,
      world.resource(Time).delta,
      graph.timer,
      gpu.pipelines.pending > 0,
      display,
    )
  },
})

/** The renderScale section of `render.describe`. */
export function describeRenderScale(world: World) {
  const s = world.tryResource(RenderScale)
  if (!s) return undefined
  const views: Record<string, { render: [number, number]; display: [number, number] }> = {}
  for (const v of world.resource(Views).list) {
    const cam = v.data.camera as CameraData | undefined
    if (!cam || !v.target.renderScale) continue
    views[v.name] = {
      render: [cam.width, cam.height],
      display: [cam.displayWidth, cam.displayHeight],
    }
  }
  return {
    mode: s.mode,
    scale: s.scale,
    min: s.min,
    max: s.max,
    targetMs: s.targetMs,
    maxHz: s.maxHz,
    budgetMs: Math.round(s.budgetMs * 100) / 100,
    displayHz: world.tryResource(DisplayRate)?.hz,
    sharpen: s.sharpen,
    signal: s.signal,
    measuredMs: s.signal === 'none' ? undefined : Math.round(s.measuredMs * 100) / 100,
    views,
  }
}
