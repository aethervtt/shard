import { defineResource, type World } from '@aethervtt/shard-core'
import { DisplayRate } from '@aethervtt/shard-runtime'
import { Views } from './plugin'
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
export const STEPS = 20
export const LOWEST = 0.25
export const HIGHEST = 2

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** A size at a render scale, in whole pixels. Scales outside 0.25–2 are clamped. */
export function scaledSize(size: number, scale: number): number {
  return Math.max(1, Math.round(size * clamp(scale, LOWEST, HIGHEST)))
}

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
