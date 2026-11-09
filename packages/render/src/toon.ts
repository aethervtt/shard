import {
  defineComponent,
  defineResource,
  onAdd,
  type Table,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Camera3d } from './camera'
import { warnFeatureMissing } from './features'

// Toon shading and ink (0108). The components are core; the shading code and the ink pass are
// `toonPlugin`, which forwardPlugin includes. Without it, Toon and Ink log render/feature-missing.

/** Tones a Toon ramp holds at most (they ride in the view uniform). */
export const MAX_TOON_TONES = 8

export const Toon = defineComponent(
  'render/Toon',
  {
    bands: t.u32({
      default: 2,
      min: 2,
      max: MAX_TOON_TONES,
      description:
        'Tones light falls into, the shadow side included: 2 is lit and shadow, 3 adds a half-lit band. Their edges are evenly spaced over how directly a surface faces each light.',
    }),
    softness: t.f32({
      default: 0.05,
      min: 0,
      max: 1,
      description:
        "Width of each band's edge, in light amount (0–1): 0 is a hard step, 1 blends the bands into a smooth ramp.",
    }),
    shadowColor: t.color({
      default: [0, 0, 0, 1],
      description:
        'What a light still gives the side facing away from it, or in its shadow, as a fraction of the lit side (linear). Black: only ambient light there; a dim violet tints comic shadows.',
    }),
    ramp: t.list(t.color(), {
      description:
        'Explicit tones, darkest first (2–8): each light picks one by how directly the surface faces it. Replaces bands and shadowColor.',
    }),
  },
  {
    description:
      "Cel shading for a camera's view: each light's diffuse falls into hard bands on the models' own colors and textures, without specular. Shadows, ambient light, SSAO and emissive are kept. Other cameras are unaffected.",
    requires: [Camera3d],
  },
)

export const Ink = defineComponent(
  'render/Ink',
  {
    width: t.f32({
      default: 1.5,
      min: 0.5,
      max: 8,
      unit: 'px',
      description: 'Line width in CSS pixels (texels on a PixelPerfect camera).',
    }),
    color: t.color({
      default: [0.02, 0.02, 0.03, 1],
      description:
        'Line color (linear), with alpha. Mixed in before tonemapping, so it is graded with the scene; black stays black.',
    }),
    depthThreshold: t.f32({
      default: 0.1,
      min: 0,
      unit: 'm',
      description:
        'How far a surface must fall back behind the plane of its neighbours to draw a line (silhouettes, an arm across a body). Planes never draw one, at any slant.',
    }),
    normalThreshold: t.f32({
      default: 35,
      min: 0,
      max: 180,
      unit: '°',
      description:
        'How sharply surface direction must turn between neighbouring pixels to draw a line (creases, a box edge facing the camera).',
    }),
  },
  {
    description:
      'Comic ink for a camera: lines where depth or surface direction jumps, on silhouettes and inside them, from the depth and normals of opaque geometry. Stable as the camera moves, orthographic included.',
    requires: [Camera3d],
  },
)

/** Set by `toonPlugin`: Toon shades and Ink draws. */
export const ToonPath = defineResource<{ installed: true }>('render/ToonPath', {
  description: 'Present when toon shading and the ink pass are installed.',
})

/** A camera's toon settings, read from its Toon each frame. Allocated once per camera. */
export interface ToonSettings {
  /** Tones in the ramp; 0 without Toon. */
  tones: number
  softness: number
  /** Up to MAX_TOON_TONES tones, darkest first, as rgba. */
  ramp: Float32Array
  /** Views of `ramp`'s first and last four tones (the view uniform's two matrices). */
  rampLow: Float32Array
  rampHigh: Float32Array
}

export function createToonSettings(): ToonSettings {
  const ramp = new Float32Array(MAX_TOON_TONES * 4)
  return { tones: 0, softness: 0, ramp, rampLow: ramp.subarray(0, 16), rampHigh: ramp.subarray(16) }
}

/**
 * Reads a camera's Toon into its settings (tones 0 without one). The ramp: the explicit one when it
 * has 2 or more tones, else `bands` tones from shadowColor to white.
 */
export function extractToon(table: Table, row: number, out: ToonSettings): void {
  if (!table.has(Toon)) {
    out.tones = 0
    return
  }
  out.softness = table.column(Toon, 'softness')[row]!
  const ramp = table.column(Toon, 'ramp')[row] as readonly (readonly number[])[]
  const r = out.ramp
  if (ramp.length >= 2) {
    const n = Math.min(ramp.length, MAX_TOON_TONES)
    for (let k = 0; k < n; k++) for (let c = 0; c < 4; c++) r[k * 4 + c] = ramp[k]![c]!
    out.tones = n
    return
  }
  const n = Math.min(Math.max(table.column(Toon, 'bands')[row]!, 2), MAX_TOON_TONES)
  const shadow = table.column(Toon, 'shadowColor')
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1)
    for (let c = 0; c < 3; c++) r[k * 4 + c] = shadow[row * 4 + c]! * (1 - f) + f
    r[k * 4 + 3] = 1
  }
  out.tones = n
}

/** Warns once per world about a Toon without toonPlugin (render/feature-missing). */
export function observeToonWithoutPlugin(world: World): void {
  world.observe(onAdd(Toon), ({ world: w }) => {
    if (!w.hasResource(ToonPath))
      warnFeatureMissing(w, 'A camera has Toon', 'toonPlugin', 'it shades physically based')
  })
}
