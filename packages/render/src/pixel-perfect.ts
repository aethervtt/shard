import { defineComponent, defineResource, type Entity, t, type World } from '@aethervtt/shard-core'
import { Gpu } from './plugin'
import { OffscreenTarget, type RenderTarget } from './target'

export const PixelPerfect = defineComponent(
  'render/PixelPerfect',
  {
    pixelsPerUnit: t.f32({
      default: 16,
      min: 0.01,
      description: 'Texels per world unit: the art resolution (16 for 16-px tiles one unit wide).',
    }),
    snap: t.bool({
      default: true,
      description: 'Moves the camera and sprites in whole texels, so scrolling never shimmers.',
    }),
  },
  {
    description:
      "Crisp pixel art on an orthographic camera: renders at one texel per pixel (Camera3d.orthoHeight × pixelsPerUnit tall), then scales up by the largest whole number that fits the target, with nearest sampling. The camera's orthoHeight is adjusted to fill the letterboxed area exactly.",
  },
)

/** How a PixelPerfect camera renders: its low-resolution target and the integer scale up. */
export interface PixelPerfectLayout {
  target: OffscreenTarget
  pixelsPerUnit: number
  snap: boolean
  /** Whole-number magnification. */
  scale: number
  /** Low-resolution size, in texels. */
  width: number
  height: number
  /** Top-left of the scaled image on the real target (letterbox), in pixels. */
  offsetX: number
  offsetY: number
}

/** Present when pixelPerfectPlugin is installed; without it PixelPerfect cameras render normally. */
export const PixelPerfectPath = defineResource<{ installed: true }>('render/PixelPerfectPath', {
  description: 'Present when pixel-perfect cameras (pixelPerfectPlugin) are installed.',
})

export const PixelTargets = defineResource<Map<Entity, PixelPerfectLayout>>('render/PixelTargets', {
  description: 'Low-resolution targets of PixelPerfect cameras.',
  init: () => new Map(),
})

/** Where a PixelPerfect camera's image lands on a target: see `pixelPerfectFit`. */
export interface PixelPerfectFit {
  scale: number
  width: number
  height: number
  offsetX: number
  offsetY: number
}

/**
 * The integer scale, low-resolution size (texels), and letterbox offset (target pixels) of a
 * PixelPerfect camera shown on a `targetWidth` × `targetHeight` target. Its projection covers
 * `height / pixelsPerUnit` units, not quite `orthoHeight`. Pure, so CPU code (UI anchors) can
 * place things where extraction will draw them.
 */
export function pixelPerfectFit(
  targetWidth: number,
  targetHeight: number,
  orthoHeight: number,
  pixelsPerUnit: number,
  out: PixelPerfectFit,
): PixelPerfectFit {
  const texels = Math.max(1, Math.round(orthoHeight * pixelsPerUnit))
  const scale = Math.max(1, Math.floor(targetHeight / texels))
  const width = Math.max(1, Math.floor(targetWidth / scale))
  const height = Math.max(1, Math.floor(targetHeight / scale))
  out.scale = scale
  out.width = width
  out.height = height
  out.offsetX = Math.floor((targetWidth - width * scale) / 2)
  out.offsetY = Math.floor((targetHeight - height * scale) / 2)
  return out
}

const fit: PixelPerfectFit = { scale: 1, width: 1, height: 1, offsetX: 0, offsetY: 0 }

/** Sizes (and keeps) a PixelPerfect camera's low-resolution target for the target it shows on. */
export function pixelPerfectLayout(
  world: World,
  entity: Entity,
  shown: RenderTarget,
  orthoHeight: number,
  pixelsPerUnit: number,
  snap: boolean,
): PixelPerfectLayout {
  const { scale, width, height } = pixelPerfectFit(
    shown.width,
    shown.height,
    orthoHeight,
    pixelsPerUnit,
    fit,
  )
  const targets = world.initResource(PixelTargets)
  let layout = targets.get(entity)
  if (!layout) {
    layout = {
      target: new OffscreenTarget(world.resource(Gpu), {
        label: `pixel-perfect:${entity}`,
        width,
        height,
        format: shown.format,
      }),
      pixelsPerUnit,
      snap,
      scale,
      width,
      height,
      offsetX: 0,
      offsetY: 0,
    }
    targets.set(entity, layout)
  }
  if (layout.target.width !== width || layout.target.height !== height) {
    layout.target.resize(width, height)
  }
  layout.pixelsPerUnit = pixelsPerUnit
  layout.snap = snap
  layout.scale = scale
  layout.width = width
  layout.height = height
  layout.offsetX = fit.offsetX
  layout.offsetY = fit.offsetY
  return layout
}
