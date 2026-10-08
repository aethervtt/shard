import { defineComponent, defineResource, type Table, t } from '@aethervtt/shard-core'
import { Camera3d, PhysicalCamera } from './camera'
import type { RenderView } from './graph'
import { type CameraData, cameraOf, isScaled } from './view'

// --- components ------------------------------------------------------------------------------

export const Bloom = defineComponent(
  'render/Bloom',
  {
    intensity: t.f32({
      default: 0.15,
      min: 0,
      max: 1,
      presets: { subtle: 0.08, strong: 0.3 },
      description:
        'How much of the blurred image mixes in. With threshold 0 the mix conserves energy. Presets: subtle 0.08, strong 0.3.',
    }),
    threshold: t.f32({
      min: 0,
      unit: 'cd/m²',
      description:
        'Only luminance above this blooms (0: everything, the physically based default). Set it for a stylized glow on emissive panels.',
    }),
    knee: t.f32({
      default: 0.5,
      min: 0,
      max: 1,
      description: 'Softness of the threshold, as a fraction of it.',
    }),
    radius: t.f32({
      default: 0.8,
      min: 0,
      max: 1,
      description: 'Spread: 0 keeps the glow tight, 1 spreads it over the whole view.',
    }),
  },
  {
    description:
      'Light bleeding around bright areas, from a downsampled blur chain. Add to a camera.',
    requires: [Camera3d],
  },
)

export const METERING_MODES = ['average', 'center', 'spot'] as const

export const AutoExposure = defineComponent(
  'render/AutoExposure',
  {
    minEv: t.f32({
      default: -2,
      presets: { indoor: 3, outdoor: 9 },
      description: 'Darkest exposure it adapts to (EV100). Presets: indoor 3, outdoor 9.',
    }),
    maxEv: t.f32({
      default: 16,
      presets: { indoor: 10, outdoor: 16 },
      description: 'Brightest exposure it adapts to (EV100). Presets: indoor 10, outdoor 16.',
    }),
    compensation: t.f32({
      description: 'EV stops added to the metered brightness: +1 is twice as bright.',
    }),
    speedUp: t.f32({
      default: 3,
      min: 0.01,
      unit: 'EV/s',
      description: 'Adaptation speed when the scene gets brighter.',
    }),
    speedDown: t.f32({
      default: 1,
      min: 0.01,
      unit: 'EV/s',
      description: 'Adaptation speed when the scene gets darker.',
    }),
    metering: t.enum(METERING_MODES, {
      description:
        'average: the whole view; center: weighted toward the middle; spot: the middle 10% only.',
    }),
  },
  {
    description:
      "Adapts Exposure.ev100 to the scene's measured brightness each frame, starting from the camera's exposure (PhysicalCamera included).",
    requires: [Camera3d],
  },
)

export const DepthOfField = defineComponent(
  'render/DepthOfField',
  {
    mode: t.enum(['gaussian', 'bokeh'], {
      description: 'gaussian: soft; bokeh: disc-shaped highlights like a real lens.',
    }),
    focusDistance: t.f32({
      default: 10,
      min: 0.01,
      unit: 'm',
      description: 'Distance that is in focus.',
    }),
    maxBlur: t.f32({
      default: 0.02,
      min: 0,
      max: 0.1,
      description: 'Largest blur radius, as a fraction of the view height.',
    }),
  },
  {
    description:
      "Defocus blur from the thin-lens circle of confusion: PhysicalCamera's aperture and focal length (without one: f/2.8 at the lens matching fovY).",
    requires: [Camera3d],
  },
)

export const MotionBlur = defineComponent(
  'render/MotionBlur',
  {
    samples: t.u32({ default: 8, min: 2, max: 32, description: 'Samples along the motion.' }),
    maxBlur: t.f32({
      default: 0.05,
      min: 0,
      max: 0.25,
      description: 'Longest blur, as a fraction of the view height.',
    }),
  },
  {
    description:
      'Blur along screen motion, for the time the shutter is open: PhysicalCamera.shutterSpeed (without one, half a frame).',
    requires: [Camera3d],
  },
)

export const ANTIALIASING_MODES = ['none', 'fxaa', 'taa', 'msaa'] as const

export const Antialiasing = defineComponent(
  'render/Antialiasing',
  {
    mode: t.enum(ANTIALIASING_MODES, {
      default: 'msaa',
      description:
        'msaa: 4 samples, forward views only; fxaa: cheap edge smoothing after tonemapping; taa: jittered frames blended over time (smoothest, also cleans shading); none.',
    }),
  },
  {
    description:
      'Anti-aliasing for a camera. Without it: MSAA in forward views (per forwardPlugin), none in deferred ones.',
    requires: [Camera3d],
  },
)

export const SSAO_QUALITIES = ['low', 'medium', 'high'] as const

export const Ssao = defineComponent(
  'render/Ssao',
  {
    radius: t.f32({
      default: 0.5,
      min: 0.01,
      unit: 'm',
      description: 'How far occluders count.',
    }),
    intensity: t.f32({ default: 1, min: 0, max: 4, description: 'Strength of the darkening.' }),
    quality: t.enum(SSAO_QUALITIES, {
      default: 'medium',
      description: 'Slice directions × steps searched: low 1×4, medium 2×4, high 3×6.',
    }),
  },
  {
    description:
      'Screen-space ambient occlusion: darkens ambient and environment light in creases and contact areas.',
    requires: [Camera3d],
  },
)

export const Fog = defineComponent(
  'render/Fog',
  {
    color: t.color({
      default: [0.6, 0.7, 0.85, 1],
      description: "Fog albedo: tints the sky's and sun's light it scatters (linear).",
    }),
    density: t.f32({
      default: 0.02,
      min: 0,
      unit: '1/m',
      description: 'Extinction at height 0: 0.02 hides things ~150 m away.',
    }),
    heightFalloff: t.f32({
      default: 0.1,
      min: 0,
      unit: '1/m',
      description: 'How fast fog thins with height (0: uniform).',
    }),
    start: t.f32({ min: 0, unit: 'm', description: 'Clear distance from the camera.' }),
    sunScattering: t.f32({
      default: 0.5,
      min: 0,
      max: 1,
      description: 'Glow toward the sun (forward scattering).',
    }),
    mode: t.enum(['default', 'add'], {
      description:
        "default: fog for flat scenes, ignored inside a planet's Atmosphere (render/fog-with-atmosphere); add: extra ground fog on top of the atmosphere's haze.",
    }),
  },
  {
    description:
      'Exponential height fog along world Y, lit by the environment (or ambient light) and the sun. Applied to everything, sky included. On planets, Atmosphere hazes distance instead.',
    requires: [Camera3d],
  },
)

export const ColorGrading = defineComponent(
  'render/ColorGrading',
  {
    temperature: t.f32({
      min: -1,
      max: 1,
      description: 'White balance: -1 cool (blue), +1 warm (orange).',
    }),
    tint: t.f32({ min: -1, max: 1, description: 'White balance: -1 green, +1 magenta.' }),
    saturation: t.f32({ default: 1, min: 0, max: 2, description: '0 gray, 1 unchanged.' }),
    contrast: t.f32({ default: 1, min: 0, max: 2, description: 'Around mid gray; 1 unchanged.' }),
    lift: t.vec3({ description: 'Added to shadows (per channel).' }),
    gamma: t.vec3({ default: [1, 1, 1], min: 0.01, description: 'Midtone power (per channel).' }),
    gain: t.vec3({
      default: [1, 1, 1],
      min: 0,
      description: 'Highlight multiplier (per channel).',
    }),
    lut: t.handle('Texture', {
      description:
        'A 32³ look-up table as a 1024×32 PNG strip (32 slices of red × green, blue across slices), applied after tonemapping.',
    }),
  },
  {
    description:
      'The look: white balance, saturation, contrast, lift/gamma/gain in HDR before the tonemap curve, then an optional LUT.',
    requires: [Camera3d],
  },
)

export const Vignette = defineComponent(
  'render/Vignette',
  {
    intensity: t.f32({
      default: 0.3,
      min: 0,
      max: 1,
      description: 'Darkening at the corners.',
    }),
    smoothness: t.f32({
      default: 0.5,
      min: 0.01,
      max: 1,
      description: 'How gradually it falls off.',
    }),
  },
  { description: 'Darkens the edges of the image.', requires: [Camera3d] },
)

// --- per-camera settings -----------------------------------------------------------------------

/** Effect bits, in chain order. */
export const PostEffect = {
  Fog: 1,
  Taa: 2,
  MotionBlur: 4,
  DepthOfField: 8,
  Bloom: 16,
  AutoExposure: 32,
  Fxaa: 64,
  Ssao: 128,
  Grading: 256,
  Vignette: 512,
  /** Aerial perspective of the camera's atmospheres (spec 0044). */
  Atmosphere: 1024,
} as const

/** Effects that are part of the tonemap pass, so every 3D view has them. */
export const CORE_EFFECTS = PostEffect.Grading | PostEffect.Vignette

/**
 * The effects whose passes are installed: the tonemap's always, then what postPlugin and fxaaPlugin
 * add. A camera asking for one that isn't installed renders without it (render/feature-missing).
 */
export const PostFeatures = defineResource<{ effects: number }>('render/PostFeatures', {
  description: 'Post effects whose passes are installed (bits of PostEffect).',
  init: () => ({ effects: CORE_EFFECTS }),
})

/** The HDR effects that each read the previous one's output, in the fixed order. */
export const HDR_CHAIN = [
  ['atmosphere', PostEffect.Atmosphere],
  ['fog', PostEffect.Fog],
  ['taa', PostEffect.Taa],
  ['motion-blur', PostEffect.MotionBlur],
  ['dof', PostEffect.DepthOfField],
  ['bloom', PostEffect.Bloom],
] as const

/** A camera's post settings, read from its components each frame. Allocated once per camera. */
export interface PostSettings {
  effects: number
  bloom: { intensity: number; threshold: number; knee: number; radius: number }
  exposure: {
    minEv: number
    maxEv: number
    compensation: number
    speedUp: number
    speedDown: number
    metering: number
  }
  dof: {
    mode: number
    focusDistance: number
    maxBlur: number
    /** f-number. */
    aperture: number
    /** mm. */
    focalLength: number
    /** Sensor height, mm. */
    sensor: number
  }
  motionBlur: { samples: number; maxBlur: number; shutter: number }
  ssao: { radius: number; intensity: number; quality: number }
  fog: {
    color: Float32Array
    density: number
    heightFalloff: number
    start: number
    sunScattering: number
    /** 0 default, 1 add. */
    mode: number
  }
  grading: {
    temperature: number
    tint: number
    saturation: number
    contrast: number
    lift: Float32Array
    gamma: Float32Array
    gain: Float32Array
    lut: unknown
  }
  vignette: { intensity: number; smoothness: number }
  /** TAA: this frame's sub-pixel jitter in pixels, and the frame index it came from. */
  jitter: Float32Array
}

export function createPostSettings(): PostSettings {
  return {
    effects: 0,
    bloom: { intensity: 0, threshold: 0, knee: 0, radius: 0 },
    exposure: { minEv: 0, maxEv: 0, compensation: 0, speedUp: 1, speedDown: 1, metering: 0 },
    dof: { mode: 0, focusDistance: 10, maxBlur: 0, aperture: 2.8, focalLength: 50, sensor: 24 },
    motionBlur: { samples: 8, maxBlur: 0, shutter: 0.5 },
    ssao: { radius: 0.5, intensity: 1, quality: 1 },
    fog: {
      color: new Float32Array(4),
      density: 0,
      heightFalloff: 0,
      start: 0,
      sunScattering: 0,
      mode: 0,
    },
    grading: {
      temperature: 0,
      tint: 0,
      saturation: 1,
      contrast: 1,
      lift: new Float32Array(3),
      gamma: new Float32Array([1, 1, 1]),
      gain: new Float32Array([1, 1, 1]),
      lut: null,
    },
    vignette: { intensity: 0, smoothness: 0.5 },
    jitter: new Float32Array(2),
  }
}

const vec = (out: Float32Array, column: ArrayLike<number>, row: number, n: number) => {
  for (let k = 0; k < n; k++) out[k] = column[row * n + k]!
}

/** The Antialiasing mode index of a camera's table row, or -1 without the component. */
export function antialiasingOf(table: Table, row: number): number {
  return table.has(Antialiasing) ? table.column(Antialiasing, 'mode')[row]! : -1
}

/**
 * Reads a camera's effect components into its post settings. Frame time comes in for motion blur
 * (the shutter covers a fraction of a frame). Only `installed` effects turn on; returns the ones the
 * camera asked for that aren't.
 */
export function extractPost(
  table: Table,
  row: number,
  cam: CameraData,
  delta: number,
  taaAllowed: boolean,
  installed: number = CORE_EFFECTS,
): number {
  const post = cam.post
  let effects = 0
  if (table.has(Bloom)) {
    effects |= PostEffect.Bloom
    post.bloom.intensity = table.column(Bloom, 'intensity')[row]!
    post.bloom.threshold = table.column(Bloom, 'threshold')[row]!
    post.bloom.knee = table.column(Bloom, 'knee')[row]!
    post.bloom.radius = table.column(Bloom, 'radius')[row]!
  }
  if (table.has(AutoExposure)) {
    effects |= PostEffect.AutoExposure
    const e = post.exposure
    e.minEv = table.column(AutoExposure, 'minEv')[row]!
    e.maxEv = table.column(AutoExposure, 'maxEv')[row]!
    e.compensation = table.column(AutoExposure, 'compensation')[row]!
    e.speedUp = table.column(AutoExposure, 'speedUp')[row]!
    e.speedDown = table.column(AutoExposure, 'speedDown')[row]!
    e.metering = table.column(AutoExposure, 'metering')[row]!
  }
  const physical = table.has(PhysicalCamera)
  if (table.has(DepthOfField)) {
    effects |= PostEffect.DepthOfField
    const d = post.dof
    d.mode = table.column(DepthOfField, 'mode')[row]!
    d.focusDistance = table.column(DepthOfField, 'focusDistance')[row]!
    d.maxBlur = table.column(DepthOfField, 'maxBlur')[row]!
    // Without a physical camera: f/2.8, at the focal length of a 24 mm sensor matching fovY.
    const sensor = physical ? table.column(PhysicalCamera, 'sensorHeight')[row]! : 24
    const focal = physical ? table.column(PhysicalCamera, 'focalLength')[row]! : 0
    d.aperture = physical ? table.column(PhysicalCamera, 'aperture')[row]! : 2.8
    d.focalLength = focal > 0 ? focal : sensor / (2 * Math.tan(cam.fovY / 2))
    d.sensor = sensor
  }
  if (table.has(MotionBlur)) {
    effects |= PostEffect.MotionBlur
    post.motionBlur.samples = table.column(MotionBlur, 'samples')[row]!
    post.motionBlur.maxBlur = table.column(MotionBlur, 'maxBlur')[row]!
    // The fraction of the frame the shutter is open (a 180° shutter without a physical camera).
    const shutter = physical ? table.column(PhysicalCamera, 'shutterSpeed')[row]! : 0
    post.motionBlur.shutter = shutter > 0 && delta > 0 ? Math.min(1, shutter / delta) : 0.5
  }
  if (table.has(Ssao)) {
    effects |= PostEffect.Ssao
    post.ssao.radius = table.column(Ssao, 'radius')[row]!
    post.ssao.intensity = table.column(Ssao, 'intensity')[row]!
    post.ssao.quality = table.column(Ssao, 'quality')[row]!
  }
  if (table.has(Fog)) {
    effects |= PostEffect.Fog
    const f = post.fog
    vec(f.color, table.column(Fog, 'color'), row, 4)
    f.density = table.column(Fog, 'density')[row]!
    f.heightFalloff = table.column(Fog, 'heightFalloff')[row]!
    f.start = table.column(Fog, 'start')[row]!
    f.sunScattering = table.column(Fog, 'sunScattering')[row]!
    f.mode = table.column(Fog, 'mode')[row]!
  }
  if (table.has(ColorGrading)) {
    effects |= PostEffect.Grading
    const g = post.grading
    g.temperature = table.column(ColorGrading, 'temperature')[row]!
    g.tint = table.column(ColorGrading, 'tint')[row]!
    g.saturation = table.column(ColorGrading, 'saturation')[row]!
    g.contrast = table.column(ColorGrading, 'contrast')[row]!
    vec(g.lift, table.column(ColorGrading, 'lift'), row, 3)
    vec(g.gamma, table.column(ColorGrading, 'gamma'), row, 3)
    vec(g.gain, table.column(ColorGrading, 'gain'), row, 3)
    g.lut = table.column(ColorGrading, 'lut')[row] ?? null
  }
  if (table.has(Vignette)) {
    effects |= PostEffect.Vignette
    post.vignette.intensity = table.column(Vignette, 'intensity')[row]!
    post.vignette.smoothness = table.column(Vignette, 'smoothness')[row]!
  }
  const aa = antialiasingOf(table, row)
  if (aa === 1) effects |= PostEffect.Fxaa
  if (aa === 2 && taaAllowed) effects |= PostEffect.Taa
  post.effects = effects & installed
  return effects & ~installed
}

/**
 * Thin-lens circle of confusion radius in pixels, for an object at `distance` meters: the blur
 * disc's diameter on the sensor is A · |d − s| / d · f / (s − f), with A = f / N.
 */
export function cocRadiusPixels(cam: CameraData, distance: number): number {
  const d = cam.post.dof
  const f = d.focalLength / 1000
  const s = Math.max(d.focusDistance, f * 1.001)
  const aperture = f / d.aperture
  const diameter = (aperture * Math.abs(distance - s) * f) / (distance * (s - f))
  const sensor = d.sensor / 1000
  const radius = (diameter / sensor) * cam.height * 0.5
  return Math.min(radius, d.maxBlur * cam.height)
}

/** Parameters of the thin-lens CoC for the shader: signed radius px = x / depth + y, capped at z. */
export function cocParams(cam: CameraData, out: Float32Array): Float32Array {
  const d = cam.post.dof
  const f = d.focalLength / 1000
  const s = Math.max(d.focusDistance, f * 1.001)
  const sensor = d.sensor / 1000
  // diameter = A f / (s - f) · (1 - s / d); radius px = diameter / sensor · height / 2, so
  // radius = k − k·s / d: negative in front of the focus plane.
  const k = (((f / d.aperture) * f) / (s - f) / sensor) * cam.height * 0.5
  out[0] = -k * s
  out[1] = k
  out[2] = d.maxBlur * cam.height
  out[3] = d.mode
  return out
}

// --- the chain -------------------------------------------------------------------------------

const aliasCache = new Map<number, Readonly<Record<string, string>>>()

/**
 * The aliases a view's post chain needs: each active HDR effect reads what the one before it
 * wrote, alternating between two textures, and the tonemap reads the last. Cached per
 * configuration, so views don't allocate per frame.
 */
export function postAliases(
  cam: CameraData,
  base: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const effects = cam.post.effects
  const chain = (effects & 0xff) | (effects & PostEffect.Atmosphere ? 0x100 : 0)
  const key = chain * 8 + (cam.msaa > 1 ? 1 : 0) + (cam.deferred ? 2 : 0) + (isScaled(cam) ? 4 : 0)
  let aliases = aliasCache.get(key)
  if (!aliases) {
    const out: Record<string, string> = { ...base }
    let current = 'hdr'
    let flip = false
    for (const [name, bit] of HDR_CHAIN) {
      if ((effects & bit) === 0) continue
      // Fog rides in the aerial-perspective pass when both are on (one trip through memory).
      if (name === 'fog' && effects & PostEffect.Atmosphere) continue
      out[`${name}-in`] = current
      // TAA writes its history, kept across frames, which later effects read in place.
      if (name === 'taa') {
        out['taa-out'] = 'taa-history'
        current = 'taa-history'
        continue
      }
      const next = flip ? 'post-b' : 'post-a'
      flip = !flip
      out[`${name}-out`] = next
      current = next
    }
    out['post-hdr'] = current
    if (effects & PostEffect.Fxaa) out.ldr = 'fxaa-in'
    // SSAO's inputs: the G-buffer in deferred views, the prepass in forward ones.
    out['ssao-normal'] = cam.deferred ? 'gbuffer1' : 'prepass-normal'
    out['ssao-depth'] = cam.deferred ? 'scene-depth' : 'prepass-depth'
    aliases = Object.freeze(out)
    aliasCache.set(key, aliases)
  }
  return aliases
}

/** Whether a view runs an effect. */
export const hasEffect = (bit: number) => (view: RenderView) =>
  ((cameraOf(view)?.post.effects ?? 0) & bit) !== 0

/** Views that need the velocity prepass: TAA and motion blur read it, forward SSAO its normals. */
export function needsPrepass(view: RenderView): boolean {
  const cam = cameraOf(view)
  if (!cam) return false
  const e = cam.post.effects
  return (
    (e & (PostEffect.Taa | PostEffect.MotionBlur)) !== 0 ||
    (!cam.deferred && (e & PostEffect.Ssao) !== 0)
  )
}
