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

/** Sizes (and keeps) a PixelPerfect camera's low-resolution target for the target it shows on. */
export function pixelPerfectLayout(
  world: World,
  entity: Entity,
  shown: RenderTarget,
  orthoHeight: number,
  pixelsPerUnit: number,
  snap: boolean,
): PixelPerfectLayout {
  const texels = Math.max(1, Math.round(orthoHeight * pixelsPerUnit))
  const scale = Math.max(1, Math.floor(shown.height / texels))
  const width = Math.max(1, Math.floor(shown.width / scale))
  const height = Math.max(1, Math.floor(shown.height / scale))
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
  layout.offsetX = Math.floor((shown.width - width * scale) / 2)
  layout.offsetY = Math.floor((shown.height - height * scale) / 2)
  return layout
}
