import { defineComponent, hashSeed, mix32, ShardError, t } from '@aethervtt/shard-core'
import { sinCos } from '@aethervtt/shard-mesh'

// The sea's spectrum (0098): JONSWAP with Kitaigorodskii's TMA depth correction and Donelan–Banner
// directional spreading, a wind sea plus an optional swell, sampled into cascades of wavenumbers.
// Everything here runs on the CPU when the spectrum changes, never per frame: the GPU evolves the
// amplitudes in time, and the CPU evaluator reads the strongest of them.

export const GRAVITY = 9.81
/** The sea repeats exactly every REPEAT seconds: every ω is a multiple of 2π / REPEAT. */
export const REPEAT = 8192
export const OMEGA_0 = (2 * Math.PI) / REPEAT
/** Cascades at most. */
export const MAX_CASCADES = 4
export const RESOLUTIONS = [128, 256, 512] as const
/** Ticks a spectrum change crossfades over. */
export const CROSSFADE_TICKS = 120
/** Each cascade keeps wavenumbers below `BAND × 2π / L_next` (gasgiant's edge). */
export const BAND = 6

export const OceanWaves = defineComponent(
  'water/OceanWaves',
  {
    seed: t.u32({
      default: 1,
      description: 'Picks the sea’s phases: the same seed, the same sea.',
    }),
    wind: t.enum(['body', 'own'], {
      default: 'body',
      description:
        'body: the body’s wind (its own, or wind/Wind). own: windSpeed and windDirection here.',
    }),
    windSpeed: t.f32({ default: 10, min: 0, unit: 'm/s', description: 'With wind: own.' }),
    windDirection: t.vec3({ default: [1, 0, 0], description: 'With wind: own; where it blows.' }),
    fetch: t.f32({
      default: 100,
      min: 0.1,
      unit: 'km',
      description:
        'How far the wind has blown over water: short fetch is chop, long fetch builds big seas.',
    }),
    gamma: t.f32({
      default: 3.3,
      min: 1,
      max: 10,
      description: 'JONSWAP peak enhancement: higher is a sharper, more regular peak.',
    }),
    spread: t.f32({
      default: 1,
      min: 0,
      max: 1,
      description:
        'Directional spreading: 1 Donelan–Banner (waves fan out), 0 waves from all ways.',
    }),
    swell: t.bool({ default: false, description: 'Adds a swell from far away.' }),
    swellHeight: t.f32({
      default: 1,
      min: 0,
      unit: 'm',
      description: 'The swell’s significant wave height.',
    }),
    swellPeriod: t.f32({ default: 11, min: 1, unit: 's', description: 'The swell’s peak period.' }),
    swellDirection: t.vec3({ default: [1, 0, 0], description: 'Where the swell travels.' }),
    swellSpread: t.f32({ default: 0.3, min: 0, max: 1, description: 'The swell’s spreading.' }),
    depth: t.f32({
      default: 0,
      min: 0,
      unit: 'm',
      description:
        '0: deep water, with waves shrinking near shores by the info texture’s depth. Above 0: TMA reshapes the whole spectrum for water this deep.',
    }),
    choppiness: t.f32({
      default: 1,
      min: 0,
      max: 2,
      description: 'Horizontal displacement λ: 0 rolling, 1 sharp crests.',
    }),
    cascades: t.list(
      t.struct({ length: t.f32({ default: 250, unit: 'm', description: 'Patch length.' }) }),
      {
        description:
          'Patch lengths of the FFT cascades, largest first (1–4). Default 250, 17 and 5 m: not integer ratios, so no repeat shows.',
      },
    ),
    resolution: t.u32({ default: 256, description: 'Texels per cascade side: 128, 256 or 512.' }),
    foamThreshold: t.f32({
      default: 0.2,
      description:
        'Foam grows where a cascade folds past this (1 − its Jacobian): 0.2 gives scattered whitecaps in a breeze and many in a gale.',
    }),
    foamGrowth: t.f32({ default: 2, min: 0, description: 'Foam added a second where it folds.' }),
    foamDecay: t.f32({ default: 0.35, min: 0, description: 'Foam lost a second elsewhere.' }),
    changedAt: t.i32({
      default: -1,
      description:
        'The tick the spectrum last changed (the server stamps it): every client crossfades from it.',
    }),
  },
  {
    description:
      'Waves on an ocean or lake (0098): a JONSWAP wind sea and an optional swell, simulated by FFT cascades on the GPU and summed on the CPU for waterAt.',
  },
)

export const DEFAULT_CASCADES = [250, 17, 5]

/** What a spectrum is built from, resolved (the body's wind looked up). */
export interface SpectrumParams {
  seed: number
  windSpeed: number
  /** Unit, horizontal. */
  windX: number
  windZ: number
  /** Metres. */
  fetch: number
  gamma: number
  spread: number
  swell: boolean
  swellHeight: number
  swellPeriod: number
  swellX: number
  swellZ: number
  swellSpread: number
  depth: number
  choppiness: number
  lengths: number[]
  resolution: number
}

/** The values a spectrum depends on, flat, to tell when it changed without allocating. */
export const PARAM_FLOATS = 17 + MAX_CASCADES

export function packParams(p: SpectrumParams, out: Float64Array): void {
  out[0] = p.seed
  out[1] = p.windSpeed
  out[2] = p.windX
  out[3] = p.windZ
  out[4] = p.fetch
  out[5] = p.gamma
  out[6] = p.spread
  out[7] = p.swell ? 1 : 0
  out[8] = p.swellHeight
  out[9] = p.swellPeriod
  out[10] = p.swellX
  out[11] = p.swellZ
  out[12] = p.swellSpread
  out[13] = p.depth
  out[14] = p.choppiness
  out[15] = p.resolution
  out[16] = p.lengths.length
  for (let i = 0; i < MAX_CASCADES; i++) out[17 + i] = p.lengths[i] ?? 0
}

/** `water/bad-cascades` for lengths that aren't 1–4 decreasing positive numbers, or a bad resolution. */
export function checkCascades(entity: number, lengths: number[], resolution: number): void {
  const bad = (message: string) =>
    new ShardError('water/bad-cascades', `OceanWaves on ${entity}: ${message}`, {
      hint: 'Give 1–4 cascades, largest first, e.g. [{ "length": 250 }, { "length": 17 }, { "length": 5 }], and a resolution of 128, 256 or 512.',
      path: `${entity}/water/OceanWaves`,
    })
  if (lengths.length < 1 || lengths.length > MAX_CASCADES)
    throw bad(`${lengths.length} cascades; it takes 1 to ${MAX_CASCADES}`)
  for (let i = 0; i < lengths.length; i++) {
    if (!(lengths[i]! > 0)) throw bad(`cascade ${i}'s length is ${lengths[i]}`)
    if (i > 0 && !(lengths[i]! < lengths[i - 1]!))
      throw bad(`cascade lengths must decrease (${lengths.join(', ')})`)
  }
  if (!(RESOLUTIONS as readonly number[]).includes(resolution))
    throw bad(`resolution ${resolution}; it takes 128, 256 or 512`)
}

/** JONSWAP's α and peak frequency (rad/s) for a wind speed (m/s) and fetch (m). */
export function jonswapPeak(speed: number, fetch: number): { alpha: number; omegaP: number } {
  const u = Math.max(speed, 0.1)
  return {
    alpha: 0.076 * ((u * u) / (fetch * GRAVITY)) ** 0.22,
    omegaP: 22 * ((GRAVITY * GRAVITY) / (u * fetch)) ** (1 / 3),
  }
}

/** JONSWAP S(ω) (m²·s), with α and ω_p given. */
export function jonswap(omega: number, alpha: number, omegaP: number, gamma: number): number {
  if (omega <= 0) return 0
  const sigma = omega <= omegaP ? 0.07 : 0.09
  const d = omega - omegaP
  const r = Math.exp(-(d * d) / (2 * sigma * sigma * omegaP * omegaP))
  const ratio = omegaP / omega
  return (
    ((alpha * GRAVITY * GRAVITY) / omega ** 5) *
    Math.exp(-1.25 * ratio * ratio * ratio * ratio) *
    gamma ** r
  )
}

/** Kitaigorodskii's TMA factor for water `depth` metres deep (1 in deep water, or depth 0). */
export function tma(omega: number, depth: number): number {
  if (depth <= 0) return 1
  const wh = omega * Math.sqrt(depth / GRAVITY)
  if (wh <= 1) return 0.5 * wh * wh
  if (wh < 2) return 1 - 0.5 * (2 - wh) * (2 - wh)
  return 1
}

/** Donelan–Banner spreading at angle θ from the mean direction, blended toward uniform by 1 − spread. */
export function spreading(omega: number, omegaP: number, theta: number, spread: number): number {
  const r = omega / omegaP
  let beta: number
  if (r < 0.95) beta = 2.61 * r ** 1.3
  else if (r < 1.6) beta = 2.28 * r ** -1.3
  else beta = 10 ** (-0.4 + 0.8393 * Math.exp(-0.567 * Math.log(r * r)))
  const s = 1 / Math.cosh(beta * theta)
  const db = (beta / (2 * Math.tanh(beta * Math.PI))) * s * s
  return spread * db + (1 - spread) / (2 * Math.PI)
}

/** ω for wavenumber k in water `depth` deep (0: deep), snapped to a multiple of 2π / REPEAT. */
export function dispersion(k: number, depth: number): number {
  const w = Math.sqrt(GRAVITY * k * (depth > 0 ? Math.tanh(k * depth) : 1))
  return Math.round(w / OMEGA_0) * OMEGA_0
}

/** dω/dk (unsnapped). */
function groupFactor(k: number, depth: number): number {
  if (depth <= 0) return 0.5 * Math.sqrt(GRAVITY / Math.max(k, 1e-9))
  const th = Math.tanh(k * depth)
  const w = Math.sqrt(GRAVITY * k * th)
  const sech = 1 / Math.cosh(k * depth)
  return (GRAVITY * (th + k * depth * sech * sech)) / (2 * Math.max(w, 1e-9))
}

/** S(kx, kz) per unit wavenumber area: the wind sea plus the swell, in water `depth` deep. */
export function spectrumAt(p: SpectrumParams, kx: number, kz: number): number {
  const k = Math.sqrt(kx * kx + kz * kz)
  if (k < 1e-6) return 0
  const omega = Math.sqrt(GRAVITY * k * (p.depth > 0 ? Math.tanh(k * p.depth) : 1))
  const jacobian = groupFactor(k, p.depth) / k
  const along = Math.atan2(kz, kx)
  let s = 0
  if (p.windSpeed > 0) {
    const { alpha, omegaP } = jonswapPeak(p.windSpeed, p.fetch)
    const theta = wrapAngle(along - Math.atan2(p.windZ, p.windX))
    s +=
      jonswap(omega, alpha, omegaP, p.gamma) *
      tma(omega, p.depth) *
      spreading(omega, omegaP, theta, p.spread)
  }
  if (p.swell && p.swellHeight > 0) {
    const omegaP = (2 * Math.PI) / p.swellPeriod
    const alpha = swellAlpha(p, omegaP)
    const theta = wrapAngle(along - Math.atan2(p.swellZ, p.swellX))
    s +=
      jonswap(omega, alpha, omegaP, p.gamma) *
      tma(omega, p.depth) *
      spreading(omega, omegaP, theta, p.swellSpread)
  }
  return s * jacobian
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

const swellAlphas = new Map<string, number>()
/** The α that gives a swell's peak shape its significant height: (Hs / 4)² = m0. */
function swellAlpha(p: SpectrumParams, omegaP: number): number {
  const key = `${omegaP}/${p.gamma}/${p.swellHeight}`
  let a = swellAlphas.get(key)
  if (a === undefined) {
    let m0 = 0
    const dw = omegaP / 400
    for (let w = dw * 0.5; w < omegaP * 12; w += dw) m0 += jonswap(w, 1, omegaP, p.gamma) * dw
    a = ((p.swellHeight / 4) * (p.swellHeight / 4)) / m0
    swellAlphas.set(key, a)
  }
  return a
}

/** The spectrum's own significant wave height, 4√m0, and peak period (s): what describe reports. */
export function spectrumStats(p: SpectrumParams): { hs: number; tp: number } {
  let m0 = 0
  let tp = 0
  if (p.windSpeed > 0) {
    const { alpha, omegaP } = jonswapPeak(p.windSpeed, p.fetch)
    const dw = omegaP / 400
    for (let w = dw * 0.5; w < omegaP * 12; w += dw)
      m0 += jonswap(w, alpha, omegaP, p.gamma) * tma(w, p.depth) * dw
    tp = (2 * Math.PI) / omegaP
  }
  if (p.swell && p.swellHeight > 0) {
    const omegaP = (2 * Math.PI) / p.swellPeriod
    const alpha = swellAlpha(p, omegaP)
    const dw = omegaP / 400
    let swell = 0
    for (let w = dw * 0.5; w < omegaP * 12; w += dw)
      swell += jonswap(w, alpha, omegaP, p.gamma) * tma(w, p.depth) * dw
    m0 += swell
    if (swell > m0 - swell) tp = p.swellPeriod
  }
  return { hs: 4 * Math.sqrt(m0), tp }
}

/** One cascade of a spectrum, as the GPU evolves it. */
export interface Cascade {
  length: number
  /** Wavenumbers kept: [kMin, kMax). */
  kMin: number
  kMax: number
  /**
   * Per texel (row z, column x; k = 2π/L × (index − N/2)): h0(k) re, im, conj(h0(−k)) re, im.
   */
  h0: Float32Array
  /** Per texel: ω (snapped), k x, k z, and the cascade's choppiness. */
  omega: Float32Array
  /** The variance it carries (m²). */
  variance: number
  /** Per texel in f64, for the CPU: |h0| and its phase. */
  amplitude: Float64Array
  phase: Float64Array
}

/** A sea's spectrum sampled into its cascades, with what the CPU evaluator sums. */
export interface Sea {
  params: SpectrumParams
  cascades: Cascade[]
  /** Strongest components: kx, kz, amplitude, phase, ω, cascade (6 each). */
  components: Float64Array
  componentCount: number
  /** The spectrum's significant wave height and peak period. */
  hs: number
  tp: number
  /** The sampled sea's own Hs (all cascades), and the evaluator's (its components only). */
  sampledHs: number
  evaluatorHs: number
}

export const COMPONENT_FLOATS = 6
/**
 * Components the CPU evaluator sums, by default. 64 left 5.4% of a 15 m/s, 300 km sea's height
 * out (its spectrum has a long tail of small waves); 128 leave 4%.
 */
export const DEFAULT_COMPONENTS = 128

const sc = new Float64Array(2)

/** A wave's phase (radians) from its cascade's seed and its wavenumber indices: integer hashing only. */
export function phaseOf(seed: number, i: number, j: number): number {
  const h = mix32((seed ^ Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(j | 0, 0x85ebca77)) >>> 0)
  return (h / 4294967296) * 2 * Math.PI
}

/**
 * Samples a spectrum into its cascades (0098). Each texel's amplitude is the spectrum's (the
 * cosine it makes has variance S(k)Δk²), not a Gaussian draw, and its phase is a hash of the seed,
 * the cascade and the wave's own indices: so a seed's sea has the spectrum's height, every machine
 * draws the same one, and a coarser or finer grid keeps the same waves.
 */
export function buildSea(p: SpectrumParams, componentCount = DEFAULT_COMPONENTS): Sea {
  const n = p.resolution
  const cascades: Cascade[] = []
  for (let c = 0; c < p.lengths.length; c++) {
    const length = p.lengths[c]!
    const dk = (2 * Math.PI) / length
    const next = p.lengths[c + 1]
    const kMin = c === 0 ? 0 : (BAND * 2 * Math.PI) / length
    const kMax = next !== undefined ? (BAND * 2 * Math.PI) / next : Math.PI * (n / length)
    // Waves shorter than the cascade's texels fold back as noise: a soft roll-off above.
    const cutoff = length / n
    const cascadeSeed = hashSeed(p.seed, c)
    const amp = new Float64Array(n * n)
    const phase = new Float64Array(n * n)
    let variance = 0
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const kx = (i - n / 2) * dk
        const kz = (j - n / 2) * dk
        const k = Math.sqrt(kx * kx + kz * kz)
        if (k < kMin || k >= kMax || k < 1e-6) continue
        const s = spectrumAt(p, kx, kz) * Math.exp(-k * k * cutoff * cutoff)
        // |h0| = A / 2: the texel's wave, amplitude A = √(2 S Δk²), has variance S Δk².
        const a = Math.sqrt(2 * s * dk * dk) / 2
        amp[j * n + i] = a
        phase[j * n + i] = phaseOf(cascadeSeed, i - n / 2, j - n / 2)
        variance += 2 * a * a
      }
    }
    const h0 = new Float32Array(n * n * 4)
    const omega = new Float32Array(n * n * 4)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 4
        sinCos(phase[j * n + i]!, sc)
        const a = amp[j * n + i]!
        h0[o] = a * sc[1]!
        h0[o + 1] = a * sc[0]!
        // conj(h0(−k)): the mirrored texel (index n − i, wrapping n/2's own mirror onto itself).
        const mi = (n - i) % n
        const mj = (n - j) % n
        const ma = amp[mj * n + mi]!
        sinCos(phase[mj * n + mi]!, sc)
        h0[o + 2] = ma * sc[1]!
        h0[o + 3] = -ma * sc[0]!
        const kx = (i - n / 2) * dk
        const kz = (j - n / 2) * dk
        omega[o] = dispersion(Math.sqrt(kx * kx + kz * kz), p.depth)
        omega[o + 1] = kx
        omega[o + 2] = kz
        omega[o + 3] = p.choppiness
      }
    }
    cascades.push({ length, kMin, kMax, h0, omega, variance, amplitude: amp, phase })
  }
  const { components, count, variance } = strongest(cascades, n, componentCount, p.depth)
  const stats = spectrumStats(p)
  let total = 0
  for (const c of cascades) total += c.variance
  return {
    params: p,
    cascades,
    components,
    componentCount: count,
    hs: stats.hs,
    tp: stats.tp,
    sampledHs: 4 * Math.sqrt(total),
    evaluatorHs: 4 * Math.sqrt(variance),
  }
}

/**
 * The `count` strongest texels over every cascade, as waves: a·cos(k·x − ωt + φ), with a = 2|h0|
 * (a texel and its mirror make one real wave), sorted strongest first and ties by position, so the
 * order is the same everywhere.
 */
function strongest(cascades: Cascade[], n: number, count: number, depth: number) {
  const all: { a: number; c: number; t: number }[] = []
  for (let c = 0; c < cascades.length; c++) {
    const amplitude = cascades[c]!.amplitude
    for (let t = 0; t < n * n; t++) {
      const a = 2 * amplitude[t]!
      if (a > 0) all.push({ a, c, t })
    }
  }
  all.sort((x, y) => y.a - x.a || x.c - y.c || x.t - y.t)
  const k = Math.min(count, all.length)
  const out = new Float64Array(k * COMPONENT_FLOATS)
  let variance = 0
  for (let i = 0; i < k; i++) {
    const { a, c, t } = all[i]!
    const cascade = cascades[c]!
    const o = i * COMPONENT_FLOATS
    // k and ω again in f64 (the texture holds f32): ω stays a whole number of turns per REPEAT.
    const dk = (2 * Math.PI) / cascade.length
    const kx = ((t % n) - n / 2) * dk
    const kz = (Math.floor(t / n) - n / 2) * dk
    out[o] = kx
    out[o + 1] = kz
    out[o + 2] = a
    out[o + 3] = cascade.phase[t]!
    out[o + 4] = dispersion(Math.sqrt(kx * kx + kz * kz), depth)
    out[o + 5] = c
    variance += (a * a) / 2
  }
  return { components: out, count: k, variance }
}
