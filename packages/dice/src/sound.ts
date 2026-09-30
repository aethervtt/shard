import { type AudioClipAsset, audioClip } from '@aethervtt/shard-audio'
import type { ImpactSound } from './skin'

// Dice sounds (0054): synthesized, not sampled. An impact is modal: the die's own few high modes,
// excited through a contact that's shorter (so brighter) the harder the hit, a short band-passed
// clack, and on the tray a low knock. Each material bakes three strength layers of six variations
// to WAV once; playback picks one and varies pitch and level (0035's ranges), so no two sound alike.
// Accent cues are small sine chords, as Aether's.

const RATE = 32000

/** Mono 16-bit PCM WAV. */
export function wavBytes(samples: Float32Array, rate = RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return bytes
}

function noise(seed: number, n: number): Float32Array {
  const out = new Float32Array(n)
  let state = seed | 1
  for (let i = 0; i < n; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out[i] = (state >>> 0) / 0x80000000 - 1
  }
  return out
}

/** Uniform numbers in [0, 1) from a seed (xorshift), for a variation's jitter. */
function jitter(seed: number): () => number {
  let state = seed | 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

/** An RBJ biquad over `x` in place: 'low' (lowpass) or 'band' (bandpass). */
function biquad(x: Float32Array, kind: 'low' | 'band', freq: number, q: number): void {
  const w = (2 * Math.PI * Math.min(freq, RATE * 0.45)) / RATE
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  let b0: number
  let b1: number
  let b2: number
  if (kind === 'low') {
    b0 = (1 - cos) / 2
    b1 = 1 - cos
    b2 = (1 - cos) / 2
  } else {
    b0 = alpha
    b1 = 0
    b2 = -alpha
  }
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    x[i] = y0
  }
}

/**
 * Adds a damped sine, amp·e^(−t/decay)·sin(2πft + phase), by its two-term recurrence: no
 * transcendental per sample, so a clip's dozen modes bake in well under a millisecond.
 */
function damped(x: Float32Array, hz: number, decay: number, amp: number, phase: number): void {
  const w = (2 * Math.PI * Math.min(hz, RATE * 0.45)) / RATE
  const r = Math.exp(-1 / (decay * RATE))
  const c = 2 * r * Math.cos(w)
  const r2 = r * r
  let y2 = amp * Math.sin(phase)
  let y1 = amp * r * Math.sin(w + phase)
  x[0] = x[0]! + y2
  if (x.length > 1) x[1] = x[1]! + y1
  for (let i = 2; i < x.length; i++) {
    const y = c * y1 - r2 * y2
    x[i] = x[i]! + y
    y2 = y1
    y1 = y
  }
}

function normalizePeak(x: Float32Array, peak = 0.9): Float32Array {
  let m = 0
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!))
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i]! / m) * peak
  return x
}

interface ImpactRecipe {
  /** The die's own ringing: [Hz, decay (s), level] per mode. */
  modes: [number, number, number][]
  /** The clack: noise through a band-pass at hz, dying over decay (s). */
  clack: { hz: number; q: number; decay: number; level: number }
  /** The tray under a die landing on it: a low knock, [Hz, decay (s), level]. */
  knock: [number, number, number]
  /** Contact time of a hard hit, in seconds: soft hits touch longer, so ring duller. */
  contact: number
  seconds: number
}

const IMPACTS: Record<ImpactSound, ImpactRecipe> = {
  resin: {
    modes: [
      [3150, 0.016, 1],
      [4870, 0.011, 0.7],
      [6420, 0.008, 0.5],
      [8350, 0.006, 0.32],
    ],
    clack: { hz: 3400, q: 0.9, decay: 0.0035, level: 0.55 },
    knock: [165, 0.014, 0.5],
    contact: 0.00008,
    seconds: 0.14,
  },
  wood: {
    modes: [
      [1650, 0.009, 1],
      [2710, 0.007, 0.6],
      [4050, 0.005, 0.4],
    ],
    clack: { hz: 2100, q: 0.8, decay: 0.004, level: 0.7 },
    knock: [140, 0.016, 0.6],
    contact: 0.00012,
    seconds: 0.12,
  },
  metal: {
    modes: [
      [5230, 0.19, 1],
      [7940, 0.13, 0.6],
      [9870, 0.085, 0.45],
      [12260, 0.055, 0.3],
    ],
    clack: { hz: 5200, q: 1.4, decay: 0.002, level: 0.4 },
    knock: [180, 0.011, 0.35],
    contact: 0.00005,
    seconds: 0.45,
  },
  glass: {
    modes: [
      [4310, 0.07, 1],
      [6480, 0.05, 0.62],
      [8870, 0.034, 0.42],
      [11240, 0.022, 0.28],
    ],
    clack: { hz: 4600, q: 1.8, decay: 0.0018, level: 0.38 },
    knock: [170, 0.011, 0.35],
    contact: 0.00006,
    seconds: 0.32,
  },
}

/** Strength layers baked per material: soft, medium, hard. */
export const IMPACT_LAYERS = 3
/** Variations baked per layer. */
export const IMPACT_VARIATIONS = 6

/** Per layer, soft to hard: contact time (× the recipe's), clack and knock levels, clack brightness. */
const CONTACT = [4.4, 2, 1]
const CLACK = [0.5, 0.8, 1]
const KNOCK = [1.3, 1, 0.85]
const BRIGHT = [0.6, 0.85, 1]

/** The strength layer (0 soft, 1 medium, 2 hard) for a contact's strength (0..1). */
export function impactLayer(strength: number): number {
  return strength < 0.33 ? 0 : strength < 0.66 ? 1 : 2
}

/**
 * One impact clip's samples: a material, on the tray or die-to-die, a strength layer (0 soft to 2
 * hard) and a variation. Die-to-die rings two bodies and has no knock.
 */
export function impactSamples(
  sound: ImpactSound,
  category: 'tray' | 'dice',
  layer: number,
  variation: number,
): Float32Array {
  const r = IMPACTS[sound]
  const n = Math.round(r.seconds * RATE)
  const x = new Float32Array(n)
  const seed = 0x51f15e + variation * 7919 + layer * 104729 + (category === 'dice' ? 1299709 : 0)
  const rand = jitter(seed)
  const contact = r.contact * CONTACT[layer]!
  // A contact of duration T passes little above 1 / 2T: longer touches ring the high modes less.
  const through = (hz: number) => 1 / (1 + (2 * hz * contact) ** 2)
  const bodies = category === 'dice' ? 2 : 1
  for (let body = 0; body < bodies; body++) {
    const shift = body === 0 ? 1 : 1.07
    for (const [hz, decay, level] of r.modes) {
      const f = hz * shift * (0.9 + rand() * 0.2)
      const a = level * (0.75 + rand() * 0.5) * through(f) * (body === 0 ? 1 : 0.8)
      damped(x, f, decay * (0.85 + rand() * 0.3), a, rand() * Math.PI * 2)
    }
  }
  const clack = noise(seed ^ 0x9e3779b9, n)
  const k = Math.exp(-1 / (r.clack.decay * RATE))
  let env = r.clack.level * CLACK[layer]!
  for (let i = 0; i < n; i++) {
    clack[i] = clack[i]! * env
    env *= k
  }
  biquad(
    clack,
    'band',
    r.clack.hz * (0.9 + rand() * 0.2) * (category === 'dice' ? 1.25 : 1) * BRIGHT[layer]!,
    r.clack.q,
  )
  for (let i = 0; i < n; i++) x[i] = x[i]! + clack[i]!
  if (category === 'tray') {
    const [hz, decay, level] = r.knock
    damped(x, hz * (0.92 + rand() * 0.16), decay, level * KNOCK[layer]!, 0)
    // The felt under it: a breath of low noise.
    const felt = noise(seed ^ 0x85ebca6b, n)
    const kf = Math.exp(-1 / (0.008 * RATE))
    let ef = 0.3 * KNOCK[layer]!
    for (let i = 0; i < n; i++) {
      felt[i] = felt[i]! * ef
      ef *= kf
    }
    biquad(felt, 'low', 450, 0.7)
    for (let i = 0; i < n; i++) x[i] = x[i]! + felt[i]!
  }
  // The touch ramps in over the contact time; the tail fades over the last 4 ms; no DC.
  const fade = Math.round(0.004 * RATE)
  let dc = 0
  let prev = 0
  const hp = Math.exp((-2 * Math.PI * 30) / RATE)
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const v = x[i]! * (1 - Math.exp(-t / contact)) * Math.min(1, (n - 1 - i) / fade)
    dc = v - prev + hp * dc
    prev = v
    x[i] = dc
  }
  return normalizePeak(x)
}

export const ACCENT_CUES = ['resin-chime', 'arcane-spark', 'void-whump'] as const
export type AccentCue = (typeof ACCENT_CUES)[number]

/** An accent cue: two partials (chimes and sparks), or a falling sine with breath (the whump). */
export function accentSamples(cue: AccentCue): Float32Array {
  const whump = cue === 'void-whump'
  const seconds = whump ? 0.5 : 0.36
  const n = Math.round(seconds * RATE)
  const x = new Float32Array(n)
  if (whump) {
    let phase = 0
    const breath = noise(0x5eed, n)
    biquad(breath, 'low', 380, 0.7)
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const hz = 185 * (48 / 185) ** Math.min(1, t / 0.42)
      phase += (2 * Math.PI * hz) / RATE
      const env = Math.min(1, t / 0.016) * Math.exp(-t / 0.13)
      x[i] = (Math.sin(phase) + 0.5 * breath[i]!) * env
    }
  } else {
    const [a, b] = cue === 'resin-chime' ? [740, 1110] : [980, 1470]
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const env = Math.min(1, t / 0.012) * Math.exp(-t / 0.09)
      const late = t > 0.018 ? Math.exp(-(t - 0.018) / 0.09) : 0
      // A sine and a triangle an instant later, as Aether's cue.
      const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * b * t))
      x[i] = Math.sin(2 * Math.PI * a * t) * env + 0.6 * tri * late
    }
  }
  return normalizePeak(x, 0.8)
}

/**
 * Impact clips per material (layers × variations, tray and die-to-die) and accent cues, baked on
 * first use. `prepare` bakes a material's impacts ahead of a roll, so the tumble only plays them.
 */
export class DiceSoundBank {
  private readonly impacts = new Map<string, AudioClipAsset>()
  private readonly accents = new Map<AccentCue, AudioClipAsset>()

  impact(
    sound: ImpactSound,
    category: 'tray' | 'dice',
    layer: number,
    variation: number,
  ): AudioClipAsset {
    const key = `${sound}:${category}:${layer}:${variation}`
    let clip = this.impacts.get(key)
    if (!clip) {
      clip = audioClip(wavBytes(impactSamples(sound, category, layer, variation)), {
        id: `dice:impact/${key}`,
      })
      this.impacts.set(key, clip)
    }
    return clip
  }

  /** Every impact clip of a material, baked now; `each` sees each (to preload it). */
  prepare(sound: ImpactSound, each?: (clip: AudioClipAsset) => void): void {
    for (const category of ['tray', 'dice'] as const) {
      for (let layer = 0; layer < IMPACT_LAYERS; layer++) {
        for (let v = 0; v < IMPACT_VARIATIONS; v++) {
          const key = `${sound}:${category}:${layer}:${v}`
          const fresh = !this.impacts.has(key)
          const clip = this.impact(sound, category, layer, v)
          if (fresh) each?.(clip)
        }
      }
    }
  }

  accent(cue: AccentCue): AudioClipAsset {
    let clip = this.accents.get(cue)
    if (!clip) {
      clip = audioClip(wavBytes(accentSamples(cue)), { id: `dice:accent/${cue}` })
      this.accents.set(cue, clip)
    }
    return clip
  }
}

/** How strong a contact of this force is, 0..1 (Aether's curve). */
export function impactStrength(force: number): number {
  return Math.min(1, Math.log1p(Math.max(0, force)) / 5.4)
}
