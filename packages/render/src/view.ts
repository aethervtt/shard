import {
  affine,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  frustum,
  mat4,
  t,
  vec3,
} from '@shard/core'
import { Time } from '@shard/runtime'
import { GlobalTransform } from '@shard/transform'
import { RenderTargets } from './assets'
import { Camera3d, Exposure, exposureScale } from './camera'
import type { RenderView } from './graph'
import { createDrawList, type DrawList } from './instances'
import { PixelPerfect, type PixelPerfectLayout, pixelPerfectLayout } from './pixel-perfect'
import { Views, Window } from './plugin'
import {
  antialiasingOf,
  createPostSettings,
  extractPost,
  PostEffect,
  type PostSettings,
  postAliases,
} from './post'
import type { RenderTarget } from './target'

export const TONEMAP_CURVES = ['aces', 'agx', 'pbr-neutral', 'reinhard', 'none'] as const
export type TonemapCurve = (typeof TONEMAP_CURVES)[number]

/** The curve for cameras without a Tonemapping component. */
export const DEFAULT_CURVE: TonemapCurve = 'agx'

export const Tonemapping = defineComponent(
  'render/Tonemapping',
  {
    curve: t.enum(TONEMAP_CURVES, {
      default: DEFAULT_CURVE,
      description:
        'How HDR becomes display color. agx: saturated highlights (glows, lava, neon) keep their hue; aces: punchy filmic contrast; pbr-neutral: faithful product colors (Khronos); reinhard: simple, soft; none: clamp only, for measuring.',
    }),
    dither: t.bool({ default: true, description: 'Adds ±1 LSB noise against banding.' }),
  },
  {
    description:
      'Tonemapping for a camera. Without it, cameras use the default curve with dithering.',
  },
)

export const RenderPath = defineComponent(
  'render/RenderPath',
  {
    mode: t.enum(['forward', 'deferred'], {
      description:
        'forward: simpler, supports MSAA, fine up to a few hundred lights. deferred: lights each pixel once (heavy overdraw, many lights) and gives G-buffer effects; anti-alias with FXAA or TAA.',
    }),
  },
  {
    description:
      'How a camera shades opaque geometry. Materials work in both; custom-lit and transparent ones always draw forward.',
  },
)

/** Camera data a view carries for the passes that draw it. */
export interface CameraData {
  entity: Entity
  /** World → view. */
  view: Float32Array
  proj: Float32Array
  viewProj: Float32Array
  invViewProj: Float32Array
  /** viewProj without the TAA jitter (motion vectors). Same as viewProj without TAA. */
  viewProjNoJitter: Float32Array
  /** Last frame's unjittered viewProj (motion vectors, TAA). */
  prevViewProj: Float32Array
  position: Float32Array
  /** Unit vector the camera looks along (-Z of its transform). */
  forward: Float32Array
  frustum: Float32Array
  orthographic: boolean
  near: number
  /** Far plane for orthographic; 0 for perspective (infinite). */
  far: number
  fovY: number
  orthoHeight: number
  aspect: number
  width: number
  height: number
  /** Scene luminance → pre-exposed HDR. */
  exposure: number
  ev100: number
  /** Linear clear color, as displayed before the tonemap curve. */
  clear: GPUColor
  msaa: number
  curve: number
  dither: boolean
  /** Culled draws of this camera, rebuilt each frame. */
  draws: DrawList
  /** Blended draws, back to front. */
  transparent: DrawList
  /** Deferred views: opaque draws the G-buffer can't take (custom lighting), drawn forward. */
  forwardOnly: DrawList
  /** Renders through the G-buffer (RenderPath deferred). */
  deferred: boolean
  /** G-buffer channel to show for a capture (-1: none), also forcing a G-buffer in forward views. */
  gbufferDebug: number
  /** LOD level per instance slot for this camera (CPU culling), and the slot capacity it needs. */
  lodState: Uint8Array
  lodCapacity: number
  /** A frozen culling frustum and eye (debug view 'culling'): culling stays put as you fly. */
  frozenFrustum: Float32Array | undefined
  frozenPosition: Float32Array | undefined
  /** Frames this camera has rendered. */
  frames: number
  /** Debug view: 0 off, 1 light-cluster heat map, 2 cascades tinted by index, 3 LOD levels. */
  debug: number
  /** Post-processing effects and their settings, from the camera's components. */
  post: PostSettings
  /** Set for PixelPerfect cameras: the low-resolution target and how it scales up. */
  pixelPerfect: PixelPerfectLayout | undefined
}

export const Cameras = defineResource<Map<Entity, CameraData>>('render/Cameras', {
  description: 'Per-camera render data by entity, extracted each frame.',
  init: () => new Map(),
})

/** Global render settings the camera extraction applies to every view. */
export const ViewSettings = defineResource<{ msaa: number }>('render/ViewSettings', {
  description: 'Render settings shared by all views: MSAA sample count.',
  init: () => ({ msaa: 4 }),
})

const scratchProj = mat4.create()
const scratchSnap = affine.create()
const scratchView = affine.create()

/** The resources that are the same texture in a view without MSAA. */
const NO_MSAA_ALIASES = Object.freeze({
  'scene-color': 'hdr',
  'scene-depth': 'depth',
  ldr: 'view-target',
})
const MSAA_ALIASES = Object.freeze({ ldr: 'view-target' })

/** Picks the aliases for a view from its camera data. Other plugins (FXAA) replace this. */
export function viewAliases(cam: CameraData): Readonly<Record<string, string>> {
  return cam.msaa > 1 ? MSAA_ALIASES : NO_MSAA_ALIASES
}

export const extractCameras = defineSystem({
  name: 'render/extract-cameras',
  description: 'Turns Camera3d entities into render views with matrices, frustums, and exposure.',
  setup: (world) => ({ q: world.query({ with: [Camera3d, GlobalTransform, Exposure] }) }),
  run: ({ q }, world) => {
    const cameras = world.resource(Cameras)
    const views = world.resource(Views).list
    const window = world.tryResource(Window)
    const targets = world.resource(RenderTargets)
    const settings = world.resource(ViewSettings)
    const delta = world.resource(Time).delta
    for (const table of q.tables) {
      const projection = table.column(Camera3d, 'projection')
      const fovY = table.column(Camera3d, 'fovY')
      const near = table.column(Camera3d, 'near')
      const far = table.column(Camera3d, 'far')
      const orthoHeight = table.column(Camera3d, 'orthoHeight')
      const order = table.column(Camera3d, 'order')
      const clear = table.column(Camera3d, 'clearColor')
      const target = table.column(Camera3d, 'target')
      const g = table.column(GlobalTransform, 'matrix')
      const ev = table.column(Exposure, 'ev100')
      const path = table.has(RenderPath) ? table.column(RenderPath, 'mode') : undefined
      const hasTonemap = table.has(Tonemapping)
      const curve = hasTonemap ? table.column(Tonemapping, 'curve') : undefined
      const dither = hasTonemap ? table.column(Tonemapping, 'dither') : undefined
      const pixel = table.has(PixelPerfect)
      const ppu = pixel ? table.column(PixelPerfect, 'pixelsPerUnit') : undefined
      const snap = pixel ? table.column(PixelPerfect, 'snap') : undefined
      for (let i = 0; i < table.count; i++) {
        const shown = target[i] ? targets.get(target[i]) : window
        if (!shown) continue // e.g. headless with no target
        let rt: RenderTarget = shown
        const entity = table.entities[i]!
        let cam = cameras.get(entity)
        if (!cam) {
          cam = {
            entity,
            view: mat4.create(),
            proj: mat4.create(),
            viewProj: mat4.create(),
            viewProjNoJitter: mat4.create(),
            invViewProj: mat4.create(),
            prevViewProj: mat4.create(),
            position: vec3.create(),
            forward: vec3.create(0, 0, -1),
            frustum: frustum.create(),
            orthographic: false,
            near: 0.1,
            far: 0,
            fovY: 1,
            orthoHeight: 10,
            aspect: 1,
            width: 1,
            height: 1,
            exposure: 1,
            ev100: 0,
            clear: { r: 0, g: 0, b: 0, a: 1 },
            msaa: 1,
            curve: 1,
            dither: true,
            draws: createDrawList(),
            transparent: createDrawList(),
            forwardOnly: createDrawList(),
            deferred: false,
            gbufferDebug: -1,
            lodState: new Uint8Array(0),
            lodCapacity: 0,
            frozenFrustum: undefined,
            frozenPosition: undefined,
            frames: 0,
            debug: 0,
            post: createPostSettings(),
            pixelPerfect: undefined,
          }
          cameras.set(entity, cam)
        }
        cam.orthographic = projection[i] !== 0
        let height = orthoHeight[i]!
        cam.pixelPerfect = undefined
        if (ppu && cam.orthographic) {
          // Render at one texel per pixel, then scale up by a whole number (letterboxed).
          const p = pixelPerfectLayout(world, entity, shown, height, ppu[i]!, snap![i] !== 0)
          rt = p.target
          height = p.height / p.pixelsPerUnit
          cam.pixelPerfect = p
        }
        cam.width = rt.width
        cam.height = rt.height
        const aspect = rt.width / Math.max(1, rt.height)
        cam.aspect = aspect
        cam.near = near[i]!
        cam.fovY = (fovY[i]! * Math.PI) / 180
        cam.orthoHeight = height
        if (!cam.orthographic) {
          mat4.perspectiveReversedZ(scratchProj, cam.fovY, aspect, near[i]!)
          cam.far = 0
        } else {
          const h = height / 2
          mat4.orthographicReversedZ(scratchProj, -h * aspect, h * aspect, -h, h, near[i]!, far[i]!)
          cam.far = far[i]!
        }
        cam.deferred = path ? path[i] === 1 : false
        extractPost(table, i, cam, delta, true)
        const world_ = g.subarray(i * 12, i * 12 + 12)
        if (cam.pixelPerfect?.snap) {
          // The camera moves in whole texels, so the picture doesn't shimmer as it scrolls.
          scratchSnap.set(world_)
          const u = cam.pixelPerfect.pixelsPerUnit
          scratchSnap[3] = Math.round(scratchSnap[3]! * u) / u
          scratchSnap[7] = Math.round(scratchSnap[7]! * u) / u
          affine.invert(scratchView, scratchSnap)
        } else {
          affine.invert(scratchView, world_)
        }
        affine.toMat4(cam.view, scratchView)
        if (cam.frames > 0) mat4.copy(cam.prevViewProj, cam.viewProjNoJitter)
        mat4.multiply(cam.viewProjNoJitter, scratchProj, cam.view)
        if (cam.frames === 0) mat4.copy(cam.prevViewProj, cam.viewProjNoJitter)
        const jitter = cam.post.jitter
        if (cam.post.effects & PostEffect.Taa) {
          // Halton (2, 3) over 8 frames: sub-pixel offsets in (-0.5, 0.5) pixels.
          const k = (cam.frames % 8) + 1
          jitter[0] = halton(k, 2) - 0.5
          jitter[1] = halton(k, 3) - 0.5
          const jx = (2 * jitter[0]) / rt.width
          const jy = (-2 * jitter[1]) / rt.height
          // Offsets clip x/y by w: the projection's third column (perspective) or translation (ortho).
          if (cam.orthographic) {
            scratchProj[12] = scratchProj[12]! + jx
            scratchProj[13] = scratchProj[13]! + jy
          } else {
            scratchProj[8] = scratchProj[8]! - jx
            scratchProj[9] = scratchProj[9]! - jy
          }
        } else {
          jitter[0] = 0
          jitter[1] = 0
        }
        mat4.copy(cam.proj, scratchProj)
        mat4.multiply(cam.viewProj, scratchProj, cam.view)
        mat4.invert(cam.invViewProj, cam.viewProj)
        frustum.fromViewProjection(cam.frustum, cam.viewProj)
        affine.getTranslationAt(cam.position, g, i * 12)
        const o = i * 12
        // -Z column of the world matrix, normalized.
        const fx = -g[o + 2]!
        const fy = -g[o + 6]!
        const fz = -g[o + 10]!
        const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
        cam.forward[0] = fx / fl
        cam.forward[1] = fy / fl
        cam.forward[2] = fz / fl
        cam.ev100 = ev[i]!
        cam.exposure = exposureScale(ev[i]!)
        const c = i * 4
        cam.clear = { r: clear[c]!, g: clear[c + 1]!, b: clear[c + 2]!, a: clear[c + 3]! }
        // The G-buffer is single-sampled; deferred views anti-alias in post (FXAA, TAA).
        const aa = antialiasingOf(table, i)
        cam.msaa = cam.deferred ? 1 : aa < 0 ? settings.msaa : aa === 3 ? 4 : 1
        cam.curve = curve ? curve[i]! : TONEMAP_CURVES.indexOf(DEFAULT_CURVE)
        cam.dither = dither ? dither[i] !== 0 : true
        cam.frames++
        const view: RenderView = {
          name: `camera:${entity}`,
          target: rt,
          order: order[i]!,
          data: { camera: cam },
        }
        view.aliases = postAliases(cam, viewAliases(cam))
        views.push(view)
        if (cam.pixelPerfect) {
          // A second view shows the low-resolution image on the real target.
          views.push({
            name: `pixel-perfect:${entity}`,
            target: shown,
            order: order[i]! + 0.5,
            data: { upscale: cam.pixelPerfect },
          })
        }
      }
    }
  },
})

/** `m · translate(x, y, z)` in place (column-major mat4). */
function translateRight(m: Float32Array, x: number, y: number, z: number): void {
  for (let r = 0; r < 4; r++) m[12 + r] = m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!
}

/**
 * The floating origin moved by `offset` (spec 0040): last frame's camera now lives in the new frame,
 * so reprojection (motion vectors, TAA) lines up instead of seeing a cell-sized jump. A point `p` in
 * the new frame was `p − offset` in the old one, so the old view-projection gains `translate(−offset)`.
 * `viewProjNoJitter` becomes next extraction's `prevViewProj`; a frozen culling frustum moves too.
 */
export function shiftCameraHistory(cam: CameraData, x: number, y: number, z: number): void {
  translateRight(cam.viewProjNoJitter, -x, -y, -z)
  translateRight(cam.prevViewProj, -x, -y, -z)
  const fp = cam.frozenPosition
  if (fp) {
    fp[0] = fp[0]! + x
    fp[1] = fp[1]! + y
    fp[2] = fp[2]! + z
  }
  const ff = cam.frozenFrustum
  if (ff) {
    // n · p + d = 0 in the old frame is n · p + (d − n · offset) = 0 in the new one.
    for (let p = 0; p < ff.length; p += 4) {
      ff[p + 3] = ff[p + 3]! - (ff[p]! * x + ff[p + 1]! * y + ff[p + 2]! * z)
    }
  }
}

/** The radical inverse of k in a base: the Halton sequence. */
function halton(k: number, base: number): number {
  let f = 1
  let r = 0
  let i = k
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

/** The camera data of a view, if it's a camera view. */
export function cameraOf(view: RenderView): CameraData | undefined {
  return view.data.camera as CameraData | undefined
}
