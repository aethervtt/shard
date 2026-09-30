import {
  affine,
  defineComponent,
  defineEvent,
  defineResource,
  defineSystem,
  type Entity,
  frustum,
  mat4,
  t,
  vec3,
  type World,
} from '@aethervtt/shard-core'
import { LogResource, Time } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { RenderTargets } from './assets'
import { Camera3d, Exposure, exposureScale } from './camera'
import type { RenderView } from './graph'
import { createDrawList, type DrawList } from './instances'
import { Lens, LensPath } from './lens'
import {
  PixelPerfect,
  type PixelPerfectLayout,
  PixelPerfectPath,
  pixelPerfectLayout,
} from './pixel-perfect'
import { Views, Window } from './plugin'
import {
  antialiasingOf,
  CORE_EFFECTS,
  createPostSettings,
  extractPost,
  PostEffect,
  PostFeatures,
  type PostSettings,
  postAliases,
} from './post'
import { RenderScale, scaledSize } from './render-scale'
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

/** Present when deferredPlugin is installed: cameras with RenderPath deferred use the G-buffer. */
export const DeferredPath = defineResource<{ installed: true }>('render/DeferredPath', {
  description: 'Present when the deferred path (deferredPlugin) is installed.',
})

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
  /** Render resolution (0051): the size of the view's scene textures. */
  width: number
  height: number
  /** Display resolution: the target's size, which screen overlays (UI, screen text) draw at. */
  displayWidth: number
  displayHeight: number
  /**
   * The target's pixels per CSS pixel (devicePixelRatio on the window, else 1). Pixel thresholds
   * meant for the eye (terrain LOD) use `displayHeight / pixelRatio`: the same on every display
   * and at every render scale.
   */
  pixelRatio: number
  /** Scene luminance → pre-exposed HDR. */
  exposure: number
  ev100: number
  /** Linear clear color, as displayed before the tonemap curve, premultiplied by its alpha. */
  clear: GPUColor
  /**
   * Clears to an alpha below 1 (0052): the passes carry alpha to the target, the sky and the
   * environment background aren't drawn, and light raises alpha, so the view composites over
   * whatever is under its surface.
   */
  alphaOutput: boolean
  msaa: number
  curve: number
  dither: boolean
  /** Culled draws of this camera, rebuilt each frame. */
  draws: DrawList
  /** Blended draws, back to front. */
  transparent: DrawList
  /** Deferred views: opaque draws the G-buffer can't take (custom lighting), drawn forward. */
  forwardOnly: DrawList
  /** Ground draws (0057): coplanar bands in (band, order) order, after opaque geometry. */
  ground: DrawList
  /** Render layers this camera draws (Camera3d.layers). */
  layers: number
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
  /** The display size and pixel ratio the last CameraMoved was sent for. */
  movedWidth: number
  movedHeight: number
  movedRatio: number
}

/**
 * Sent after extraction, once per camera whose projection moved this frame (its unjittered view-
 * projection, display size or pixel ratio changed), and on its first frame (0057).
 */
export const CameraMoved = defineEvent<{ camera: Entity }>('render/CameraMoved', {
  description: 'A camera moved or its view resized: DOM overlays following the scene reposition.',
})

function sameMatrix(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false
  return true
}

export const Cameras = defineResource<Map<Entity, CameraData>>('render/Cameras', {
  description: 'Per-camera render data by entity, extracted each frame.',
  init: () => new Map(),
})

/** Global render settings the camera extraction applies to every view. */
export interface ViewSettingsValue {
  /** MSAA samples for forward cameras without an Antialiasing component. */
  msaa: number
  /**
   * Displays this dense or denser (pixels per CSS pixel) skip that default MSAA: their pixels are
   * too small for stair-stepping to show, and 4 samples of a Retina frame cost about a third of
   * it. 0: always use `msaa`. An Antialiasing component still wins.
   */
  msaaMaxPixelRatio: number
}

export const ViewSettings = defineResource<ViewSettingsValue>('render/ViewSettings', {
  description:
    'Render settings shared by all views: the default MSAA sample count, and the display density past which it is skipped.',
  init: () => ({ msaa: 4, msaaMaxPixelRatio: 1.5 }),
  hostWritable: true,
})

const scratchProj = mat4.create()
const scratchSnap = affine.create()
const scratchView = affine.create()

/** The resources that are the same texture in a view without MSAA. */
const NO_MSAA_ALIASES = Object.freeze({
  'scene-color': 'hdr',
  'scene-depth': 'depth',
  ldr: 'view-target',
  display: 'view-target',
})
const MSAA_ALIASES = Object.freeze({ ldr: 'view-target', display: 'view-target' })
/** A scaled view (0051) keeps `display` at render resolution; the upscale writes the target. */
const SCALED_NO_MSAA_ALIASES = Object.freeze({
  'scene-color': 'hdr',
  'scene-depth': 'depth',
  ldr: 'display',
})
const SCALED_MSAA_ALIASES = Object.freeze({ ldr: 'display' })

/** Whether a camera renders below (or above) its target's resolution and needs the upscale. */
export function isScaled(cam: CameraData): boolean {
  return cam.width !== cam.displayWidth || cam.height !== cam.displayHeight
}

/** Picks the aliases for a view from its camera data. Other plugins (FXAA) replace this. */
export function viewAliases(cam: CameraData): Readonly<Record<string, string>> {
  if (isScaled(cam)) return cam.msaa > 1 ? SCALED_MSAA_ALIASES : SCALED_NO_MSAA_ALIASES
  return cam.msaa > 1 ? MSAA_ALIASES : NO_MSAA_ALIASES
}

/** Effects already reported as missing, per world, so each shows once. */
const reportedEffects = new WeakMap<World, number>()

/** Worlds already told that deferred cameras render forward without deferredPlugin. */
const reportedDeferred = new WeakSet<World>()

function warnMissingDeferred(world: World): void {
  if (reportedDeferred.has(world)) return
  reportedDeferred.add(world)
  world
    .tryResource(LogResource)
    ?.log(
      'warn',
      "A camera asks for RenderPath deferred, but deferredPlugin isn't installed; it renders forward",
      {
        code: 'render/feature-missing',
        hint: "Add deferredPlugin from '@aethervtt/shard-render' (forwardPlugin includes it).",
      },
    )
}

const reportedPixel = new WeakSet<World>()

function warnMissingPixelPerfect(world: World): void {
  if (reportedPixel.has(world)) return
  reportedPixel.add(world)
  world
    .tryResource(LogResource)
    ?.log(
      'warn',
      "A camera has PixelPerfect, but pixelPerfectPlugin isn't installed; it renders at full resolution",
      {
        code: 'render/feature-missing',
        hint: "Add pixelPerfectPlugin from '@aethervtt/shard-render' (forwardPlugin includes it).",
      },
    )
}

const reportedLens = new WeakSet<World>()

function warnMissingLens(world: World): void {
  if (reportedLens.has(world)) return
  reportedLens.add(world)
  world
    .tryResource(LogResource)
    ?.log('warn', "A camera has Lens, but lensPlugin isn't installed; it renders unbent", {
      code: 'render/feature-missing',
      hint: "Add lensPlugin from '@aethervtt/shard-render' (forwardPlugin includes it).",
    })
}

/** Logs render/feature-missing once per effect a camera asked for whose plugin isn't installed. */
function warnMissingEffects(world: World, missing: number): void {
  const reported = reportedEffects.get(world) ?? 0
  const fresh = missing & ~reported
  if (fresh === 0) return
  reportedEffects.set(world, reported | fresh)
  const names = Object.entries(PostEffect)
    .filter(([, bit]) => (fresh & bit) !== 0)
    .map(([name]) => name)
  const plugin = fresh & PostEffect.Fxaa && fresh === PostEffect.Fxaa ? 'fxaaPlugin' : 'postPlugin'
  world
    .tryResource(LogResource)
    ?.log(
      'warn',
      `A camera asks for ${names.join(', ')}, but ${plugin} isn't installed; it renders without them`,
      {
        code: 'render/feature-missing',
        hint: `Add ${plugin} from '@aethervtt/shard-render' (forwardPlugin includes it).`,
      },
    )
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
    const scale = world.tryResource(RenderScale)
    if (scale) scale.windowViews = 0
    const delta = world.resource(Time).delta
    const installed = world.tryResource(PostFeatures)?.effects ?? CORE_EFFECTS
    const deferredInstalled = world.hasResource(DeferredPath)
    const pixelInstalled = world.hasResource(PixelPerfectPath)
    const lensInstalled = world.hasResource(LensPath)
    for (const table of q.tables) {
      const projection = table.column(Camera3d, 'projection')
      const fovY = table.column(Camera3d, 'fovY')
      const near = table.column(Camera3d, 'near')
      const far = table.column(Camera3d, 'far')
      const orthoHeight = table.column(Camera3d, 'orthoHeight')
      const order = table.column(Camera3d, 'order')
      const clear = table.column(Camera3d, 'clearColor')
      const target = table.column(Camera3d, 'target')
      const active = table.column(Camera3d, 'active')
      const layers = table.column(Camera3d, 'layers')
      const g = table.column(GlobalTransform, 'matrix')
      const ev = table.column(Exposure, 'ev100')
      const path = table.has(RenderPath) ? table.column(RenderPath, 'mode') : undefined
      const hasTonemap = table.has(Tonemapping)
      const curve = hasTonemap ? table.column(Tonemapping, 'curve') : undefined
      const dither = hasTonemap ? table.column(Tonemapping, 'dither') : undefined
      if (table.has(PixelPerfect) && !pixelInstalled) warnMissingPixelPerfect(world)
      if (table.has(Lens) && !lensInstalled) warnMissingLens(world)
      const pixel = pixelInstalled && table.has(PixelPerfect)
      const ppu = pixel ? table.column(PixelPerfect, 'pixelsPerUnit') : undefined
      const snap = pixel ? table.column(PixelPerfect, 'snap') : undefined
      for (let i = 0; i < table.count; i++) {
        if (active[i] === 0) {
          // Back from inactive, it starts over: no motion vectors or TAA history from before.
          const idle = cameras.get(table.entities[i]!)
          if (idle) idle.frames = 0
          continue
        }
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
            displayWidth: 1,
            displayHeight: 1,
            pixelRatio: 1,
            exposure: 1,
            ev100: 0,
            clear: { r: 0, g: 0, b: 0, a: 1 },
            alphaOutput: false,
            msaa: 1,
            curve: 1,
            dither: true,
            draws: createDrawList(),
            transparent: createDrawList(),
            forwardOnly: createDrawList(),
            ground: createDrawList(),
            layers: 0xffffffff,
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
            movedWidth: 0,
            movedHeight: 0,
            movedRatio: 0,
          }
          cameras.set(entity, cam)
        }
        cam.orthographic = projection[i] !== 0
        cam.layers = layers[i]!
        let height = orthoHeight[i]!
        cam.pixelPerfect = undefined
        if (ppu && cam.orthographic) {
          // Render at one texel per pixel, then scale up by a whole number (letterboxed).
          const p = pixelPerfectLayout(world, entity, shown, height, ppu[i]!, snap![i] !== 0)
          rt = p.target
          height = p.height / p.pixelsPerUnit
          cam.pixelPerfect = p
        }
        cam.displayWidth = rt.width
        cam.displayHeight = rt.height
        cam.pixelRatio = rt.pixelRatio ?? 1
        cam.width = rt.width
        cam.height = rt.height
        // Window cameras render at the render scale and are upscaled at Display (0051).
        if (scale && !cam.pixelPerfect && rt.renderScale) {
          cam.width = scaledSize(rt.width, scale.scale)
          cam.height = scaledSize(rt.height, scale.scale)
          scale.windowViews++
        }
        const aspect = cam.width / Math.max(1, cam.height)
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
        const wantsDeferred = path ? path[i] === 1 : false
        cam.deferred = wantsDeferred && deferredInstalled
        if (wantsDeferred && !deferredInstalled) warnMissingDeferred(world)
        const missing = extractPost(table, i, cam, delta, true, installed)
        if (missing !== 0) warnMissingEffects(world, missing)
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
        // Hosts reposition DOM handles on this, not every frame (0057).
        if (
          cam.frames === 0 ||
          !sameMatrix(cam.viewProjNoJitter, cam.prevViewProj) ||
          cam.displayWidth !== cam.movedWidth ||
          cam.displayHeight !== cam.movedHeight ||
          cam.pixelRatio !== cam.movedRatio
        ) {
          cam.movedWidth = cam.displayWidth
          cam.movedHeight = cam.displayHeight
          cam.movedRatio = cam.pixelRatio
          world.send(CameraMoved, { camera: entity })
        }
        const jitter = cam.post.jitter
        if (cam.post.effects & PostEffect.Taa) {
          // Halton (2, 3) over 8 frames: sub-pixel offsets in (-0.5, 0.5) pixels.
          const k = (cam.frames % 8) + 1
          jitter[0] = halton(k, 2) - 0.5
          jitter[1] = halton(k, 3) - 0.5
          const jx = (2 * jitter[0]) / cam.width
          const jy = (-2 * jitter[1]) / cam.height
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
        // Scene color is premultiplied: a clear alpha scales its color too (1 for opaque views).
        const ca = Math.min(1, Math.max(0, clear[c + 3]!))
        cam.clear = { r: clear[c]! * ca, g: clear[c + 1]! * ca, b: clear[c + 2]! * ca, a: ca }
        cam.alphaOutput = ca < 1
        // The G-buffer is single-sampled; deferred views anti-alias in post (FXAA, TAA).
        const aa = antialiasingOf(table, i)
        // The default follows the display, not the render scale, so the scale can't flip it.
        const dense = settings.msaaMaxPixelRatio > 0 && cam.pixelRatio >= settings.msaaMaxPixelRatio
        cam.msaa = cam.deferred ? 1 : aa < 0 ? (dense ? 1 : settings.msaa) : aa === 3 ? 4 : 1
        cam.curve = curve ? curve[i]! : TONEMAP_CURVES.indexOf(DEFAULT_CURVE)
        cam.dither = dither ? dither[i] !== 0 : true
        cam.frames++
        const view: RenderView = {
          name: `camera:${entity}`,
          target: rt,
          order: order[i]!,
          data: { camera: cam },
        }
        if (isScaled(cam)) {
          view.width = cam.width
          view.height = cam.height
        }
        view.aliases = postAliases(cam, viewAliases(cam))
        views.push(view)
        if (cam.pixelPerfect) {
          // A second view shows the low-resolution image on the real target.
          views.push({
            name: `pixel-perfect:${entity}`,
            target: shown,
            order: order[i]! + 0.5,
            data: { upscale: cam.pixelPerfect, alphaOutput: cam.alphaOutput },
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
