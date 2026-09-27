/**
 * The atmosphere model on the CPU (spec 0044): the same density profiles, transmittance, and
 * multiple-scattering approximation (Hillaire 2020) the shaders in `atmosphere-shaders.ts` use, so
 * sun light, `sunTransmittanceAt`, and `atmosphere.sample` work headless and agree with the GPU.
 *
 * Everything is in kilometres, relative to the atmosphere's center. Coefficients are per km.
 */

/** Atmosphere parameters in shader units (km, 1/km). */
export interface AtmosphereModel {
  /** Visible surface (or cloud top), top of the atmosphere, and the LUTs' floor (bottom − deck). */
  bottom: number
  top: number
  ground: number
  rayleigh: Float64Array
  rayleighInvScale: number
  mieScattering: number
  mieAbsorption: number
  mieInvScale: number
  /** Per channel Cornette-Shanks asymmetry. */
  mieG: Float64Array
  absorption: Float64Array
  absorptionCenter: number
  absorptionWidth: number
  albedo: Float64Array
  intensity: number
}

export function createModel(): AtmosphereModel {
  return {
    bottom: 6360,
    top: 6420,
    ground: 6360,
    rayleigh: new Float64Array(3),
    rayleighInvScale: 1 / 8,
    mieScattering: 0,
    mieAbsorption: 0,
    mieInvScale: 1 / 1.2,
    mieG: new Float64Array(3),
    absorption: new Float64Array(3),
    absorptionCenter: 25,
    absorptionWidth: 30,
    albedo: new Float64Array(3),
    intensity: 1,
  }
}

export const TRANSMITTANCE_W = 256
export const TRANSMITTANCE_H = 64
export const MULTISCATTER_SIZE = 32
/** Steps for the transmittance LUT and for sun transmittance on the CPU. */
export const TRANSMITTANCE_STEPS = 40
const MS_STEPS = 20
const MS_DIRS = 8

/** Scratch medium: scattering and extinction at a point. */
export interface Medium {
  rayleigh: Float64Array
  mie: number
  scattering: Float64Array
  extinction: Float64Array
}

export function createMedium(): Medium {
  return {
    rayleigh: new Float64Array(3),
    mie: 0,
    scattering: new Float64Array(3),
    extinction: new Float64Array(3),
  }
}

/** The medium at altitude `h` km above the bottom (negative inside a gas giant's deck). */
export function mediumAt(m: AtmosphereModel, h: number, out: Medium): Medium {
  const hc = Math.max(h, m.ground - m.bottom)
  const dr = Math.exp(-hc * m.rayleighInvScale)
  const dm = Math.exp(-hc * m.mieInvScale)
  const da = Math.max(0, 1 - Math.abs(hc - m.absorptionCenter) / (0.5 * m.absorptionWidth))
  const mieS = m.mieScattering * dm
  const mieE = mieS + m.mieAbsorption * dm
  out.mie = mieS
  for (let c = 0; c < 3; c++) {
    const r = m.rayleigh[c]! * dr
    out.rayleigh[c] = r
    out.scattering[c] = r + mieS
    out.extinction[c] = r + mieE + m.absorption[c]! * da
  }
  return out
}

/** Near and far distances along a unit ray to a sphere at the origin; NaN when it misses. */
export function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  r: number,
  out: Float64Array,
): boolean {
  const b = ox * dx + oy * dy + oz * dz
  const c = ox * ox + oy * oy + oz * oz - r * r
  const disc = b * b - c
  if (disc < 0) {
    out[0] = Number.NaN
    out[1] = Number.NaN
    return false
  }
  const s = Math.sqrt(disc)
  out[0] = -b - s
  out[1] = -b + s
  return true
}

const hit = new Float64Array(2)
const med = createMedium()

/**
 * Transmittance from a point along a unit direction to the top of the atmosphere, integrated in
 * `steps` midpoint steps. Zero when the ground (the LUT floor) is in the way.
 */
export function transmittanceToTop(
  m: AtmosphereModel,
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
  out: Float64Array,
  steps = TRANSMITTANCE_STEPS,
): Float64Array {
  if (raySphere(px, py, pz, dx, dy, dz, m.ground, hit) && hit[0]! > 0) {
    out[0] = out[1] = out[2] = 0
    return out
  }
  if (!raySphere(px, py, pz, dx, dy, dz, m.top, hit) || hit[1]! <= 0) {
    out[0] = out[1] = out[2] = 1
    return out
  }
  const t0 = Math.max(0, hit[0]!)
  const dt = (hit[1]! - t0) / steps
  let tr = 0
  let tg = 0
  let tb = 0
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i + 0.5) * dt
    const x = px + dx * t
    const y = py + dy * t
    const z = pz + dz * t
    mediumAt(m, Math.sqrt(x * x + y * y + z * z) - m.bottom, med)
    tr += med.extinction[0]! * dt
    tg += med.extinction[1]! * dt
    tb += med.extinction[2]! * dt
  }
  out[0] = Math.exp(-tr)
  out[1] = Math.exp(-tg)
  out[2] = Math.exp(-tb)
  return out
}

// --- LUT parameterizations (shared with the shaders) --------------------------------------------

/** Transmittance LUT unit coordinates (x_mu, x_r) of altitude radius r and view zenith cosine mu. */
export function transmittanceUnit(m: AtmosphereModel, r: number, mu: number, out: Float64Array) {
  const rb = m.ground
  const rt = m.top
  const H = Math.sqrt(Math.max(0, rt * rt - rb * rb))
  const rho = Math.sqrt(Math.max(0, r * r - rb * rb))
  const disc = r * r * (mu * mu - 1) + rt * rt
  const d = Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)))
  const dMin = rt - r
  const dMax = rho + H
  out[0] = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0
  out[1] = H > 0 ? rho / H : 0
  return out
}

/** The inverse: (r, mu) of transmittance LUT unit coordinates. */
export function transmittanceRMu(m: AtmosphereModel, xMu: number, xR: number, out: Float64Array) {
  const rb = m.ground
  const rt = m.top
  const H = Math.sqrt(Math.max(0, rt * rt - rb * rb))
  const rho = H * xR
  const r = Math.sqrt(rho * rho + rb * rb)
  const dMin = rt - r
  const dMax = rho + H
  const d = dMin + xMu * (dMax - dMin)
  const mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d)
  out[0] = r
  out[1] = Math.min(1, Math.max(-1, mu))
  return out
}

/** A LUT of `w × h` rgb texels, sampled bilinearly with texel centers at unit 0 and 1. */
export interface Lut {
  width: number
  height: number
  data: Float32Array
}

function sampleLut(lut: Lut, x: number, y: number, out: Float64Array): Float64Array {
  const fx = Math.min(1, Math.max(0, x)) * (lut.width - 1)
  const fy = Math.min(1, Math.max(0, y)) * (lut.height - 1)
  const x0 = Math.min(lut.width - 2, Math.floor(fx))
  const y0 = Math.min(lut.height - 2, Math.floor(fy))
  const ax = fx - x0
  const ay = fy - y0
  const d = lut.data
  const w = lut.width
  for (let c = 0; c < 3; c++) {
    const a = d[(y0 * w + x0) * 3 + c]!
    const b = d[(y0 * w + x0 + 1) * 3 + c]!
    const e = d[((y0 + 1) * w + x0) * 3 + c]!
    const f = d[((y0 + 1) * w + x0 + 1) * 3 + c]!
    out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (e * (1 - ax) + f * ax) * ay
  }
  return out
}

const unit = new Float64Array(2)
const rmu = new Float64Array(2)
const t3 = new Float64Array(3)

/** The transmittance LUT, computed like `shard::atmosphere::transmittance_lut`. */
export function transmittanceLut(m: AtmosphereModel): Lut {
  const w = TRANSMITTANCE_W
  const h = TRANSMITTANCE_H
  const data = new Float32Array(w * h * 3)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      transmittanceRMu(m, i / (w - 1), j / (h - 1), rmu)
      const r = rmu[0]!
      const mu = rmu[1]!
      transmittanceToTop(m, 0, r, 0, Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0, t3)
      data.set(t3, (j * w + i) * 3)
    }
  }
  return { width: w, height: h, data }
}

/** Transmittance from radius r toward zenith cosine mu, from the LUT (the ground is not tested). */
export function lookupTransmittance(
  m: AtmosphereModel,
  lut: Lut,
  r: number,
  mu: number,
  out: Float64Array,
): Float64Array {
  transmittanceUnit(m, r, mu, unit)
  return sampleLut(lut, unit[0]!, unit[1]!, out)
}

/** Transmittance toward a sun from a point: zero in the planet's shadow. */
function sunTransmittance(
  m: AtmosphereModel,
  lut: Lut,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  out: Float64Array,
): Float64Array {
  if (raySphere(x, y, z, sx, sy, sz, m.ground, hit) && hit[0]! > 0) {
    out[0] = out[1] = out[2] = 0
    return out
  }
  const r = Math.sqrt(x * x + y * y + z * z)
  return lookupTransmittance(m, lut, r, (x * sx + y * sy + z * sz) / r, out)
}

const sunT = new Float64Array(3)
const msAcc = new Float64Array(6)

/**
 * Hillaire's multiple-scattering LUT: for each altitude and sun zenith, the isotropic
 * second-order luminance L2 over 64 directions and the transfer f_ms, stored as L2 / (1 − f_ms)
 * (per unit illuminance, per unit scattering).
 */
export function multiscatterLut(m: AtmosphereModel, tlut: Lut): Lut {
  const n = MULTISCATTER_SIZE
  const data = new Float32Array(n * n * 3)
  const isotropic = 1 / (4 * Math.PI)
  for (let j = 0; j < n; j++) {
    const r = m.ground + (j / (n - 1)) * (m.top - m.ground)
    const rr = Math.max(r, m.ground + 1e-3)
    for (let i = 0; i < n; i++) {
      const cs = (i / (n - 1)) * 2 - 1
      const sx = 0
      const sy = cs
      const sz = Math.sqrt(Math.max(0, 1 - cs * cs))
      msAcc.fill(0)
      for (let a = 0; a < MS_DIRS; a++) {
        for (let b = 0; b < MS_DIRS; b++) {
          const ct = 1 - (2 * (a + 0.5)) / MS_DIRS
          const st = Math.sqrt(Math.max(0, 1 - ct * ct))
          const phi = (2 * Math.PI * (b + 0.5)) / MS_DIRS
          const dx = st * Math.cos(phi)
          const dy = ct
          const dz = st * Math.sin(phi)
          const hitsGround = raySphere(0, rr, 0, dx, dy, dz, m.ground, hit) && hit[0]! > 0
          const tGround = hit[0]!
          raySphere(0, rr, 0, dx, dy, dz, m.top, hit)
          const tMax = hitsGround ? tGround : hit[1]!
          const dt = tMax / MS_STEPS
          let thr = 1
          let thg = 1
          let thb = 1
          for (let k = 0; k < MS_STEPS; k++) {
            const t = (k + 0.5) * dt
            const x = dx * t
            const y = rr + dy * t
            const z = dz * t
            mediumAt(m, Math.sqrt(x * x + y * y + z * z) - m.bottom, med)
            sunTransmittance(m, tlut, x, y, z, sx, sy, sz, sunT)
            for (let c = 0; c < 3; c++) {
              const ext = Math.max(med.extinction[c]!, 1e-9)
              const stepT = Math.exp(-ext * dt)
              const sc = med.scattering[c]!
              const th = c === 0 ? thr : c === 1 ? thg : thb
              msAcc[c] = msAcc[c]! + (th * (sunT[c]! * sc * isotropic * (1 - stepT))) / ext
              msAcc[3 + c] = msAcc[3 + c]! + (th * (sc * (1 - stepT))) / ext
              if (c === 0) thr *= stepT
              else if (c === 1) thg *= stepT
              else thb *= stepT
            }
          }
          if (hitsGround) {
            const x = dx * tMax
            const y = rr + dy * tMax
            const z = dz * tMax
            const len = Math.sqrt(x * x + y * y + z * z)
            const ndl = Math.max(0, (x * sx + y * sy + z * sz) / len)
            sunTransmittance(m, tlut, x * 1.00001, y * 1.00001, z * 1.00001, sx, sy, sz, sunT)
            msAcc[0] = msAcc[0]! + (thr * sunT[0]! * ndl * m.albedo[0]!) / Math.PI
            msAcc[1] = msAcc[1]! + (thg * sunT[1]! * ndl * m.albedo[1]!) / Math.PI
            msAcc[2] = msAcc[2]! + (thb * sunT[2]! * ndl * m.albedo[2]!) / Math.PI
          }
        }
      }
      const count = MS_DIRS * MS_DIRS
      for (let c = 0; c < 3; c++) {
        const l2 = msAcc[c]! / count
        const fms = msAcc[3 + c]! / count
        data[(j * n + i) * 3 + c] = l2 / Math.max(1 - fms, 1e-4)
      }
    }
  }
  return { width: n, height: n, data }
}

/** Multiple-scattering luminance factor at radius r for a sun at zenith cosine cs. */
export function lookupMultiscatter(
  m: AtmosphereModel,
  lut: Lut,
  r: number,
  cs: number,
  out: Float64Array,
): Float64Array {
  return sampleLut(lut, cs * 0.5 + 0.5, (r - m.ground) / (m.top - m.ground), out)
}

/** Rayleigh phase. */
export const rayleighPhase = (mu: number): number => (3 / (16 * Math.PI)) * (1 + mu * mu)

/** Cornette-Shanks phase with asymmetry g. */
export function miePhase(mu: number, g: number): number {
  const g2 = g * g
  return (
    ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu))) / ((2 + g2) * (1 + g2 - 2 * g * mu) ** 1.5)
  )
}

/** A sun as the model sees it: direction toward it (unit) and illuminance (lux) per channel. */
export interface ModelSun {
  direction: ArrayLike<number>
  illuminance: ArrayLike<number>
}

export interface SkySample {
  /** In-scattered radiance (cd/m²) along the ray, plus the lit ground where it ends on it. */
  radiance: Float64Array
  /** Transmittance along the ray to where it leaves the atmosphere (0 if it hits the ground). */
  transmittance: Float64Array
  hitsGround: boolean
  /** Distance (km) the ray travels through the atmosphere. */
  length: number
}

export function createSkySample(): SkySample {
  return {
    radiance: new Float64Array(3),
    transmittance: new Float64Array(3),
    hitsGround: false,
    length: 0,
  }
}

const ms3 = new Float64Array(3)

/**
 * Radiance along a ray from `p` (km, relative to the center) in unit direction `d`, up to
 * `maxT` km: single scattering of every sun, the multiple-scattering LUT, and the lit ground.
 * Same integration as `shard::atmosphere::integrate` (quadratic step distribution).
 */
export function integrateSky(
  m: AtmosphereModel,
  tlut: Lut,
  mslut: Lut,
  p: ArrayLike<number>,
  d: ArrayLike<number>,
  suns: readonly ModelSun[],
  out: SkySample,
  steps = 32,
  maxT = Number.POSITIVE_INFINITY,
): SkySample {
  const px = p[0]!
  const py = p[1]!
  const pz = p[2]!
  const dx = d[0]!
  const dy = d[1]!
  const dz = d[2]!
  out.radiance.fill(0)
  out.transmittance.fill(1)
  out.hitsGround = false
  out.length = 0
  if (!raySphere(px, py, pz, dx, dy, dz, m.top, hit) || hit[1]! <= 0) return out
  const t0 = Math.max(0, hit[0]!)
  let t1 = hit[1]!
  let ground = false
  if (raySphere(px, py, pz, dx, dy, dz, m.ground, hit) && hit[0]! > 0 && hit[0]! < t1) {
    t1 = hit[0]!
    ground = true
  }
  if (maxT < t1) {
    t1 = maxT
    ground = false
  }
  if (t1 <= t0) return out
  out.length = t1 - t0
  const T = out.transmittance
  const L = out.radiance
  // Like the shader: samples bunch near the start from inside, near the end from space.
  const fromSpace = t0 > 0
  const bunch = (s: number) => (fromSpace ? 1 - (1 - s) * (1 - s) : s * s)
  for (let k = 0; k < steps; k++) {
    const a = t0 + (t1 - t0) * bunch(k / steps)
    const b = t0 + (t1 - t0) * bunch((k + 1) / steps)
    const t = t0 + (t1 - t0) * bunch((k + 0.5) / steps)
    const dt = b - a
    const x = px + dx * t
    const y = py + dy * t
    const z = pz + dz * t
    const r = Math.sqrt(x * x + y * y + z * z)
    mediumAt(m, r - m.bottom, med)
    for (let c = 0; c < 3; c++) ms3[c] = 0
    // Scattered light at this point, per channel, from every sun.
    let sr = 0
    let sg = 0
    let sb = 0
    for (const sun of suns) {
      const sx = sun.direction[0]!
      const sy = sun.direction[1]!
      const sz = sun.direction[2]!
      const mu = dx * sx + dy * sy + dz * sz
      const pr = rayleighPhase(mu)
      sunTransmittance(m, tlut, x, y, z, sx, sy, sz, sunT)
      lookupMultiscatter(m, mslut, r, (x * sx + y * sy + z * sz) / r, ms3)
      for (let c = 0; c < 3; c++) {
        const e = sun.illuminance[c]!
        const single =
          (med.rayleigh[c]! * pr + med.mie * miePhase(mu, m.mieG[c]!)) * sunT[c]! +
          ms3[c]! * med.scattering[c]!
        const v = single * e
        if (c === 0) sr += v
        else if (c === 1) sg += v
        else sb += v
      }
    }
    for (let c = 0; c < 3; c++) {
      const ext = Math.max(med.extinction[c]!, 1e-9)
      const stepT = Math.exp(-ext * dt)
      const S = c === 0 ? sr : c === 1 ? sg : sb
      L[c] = L[c]! + (T[c]! * S * (1 - stepT)) / ext
      T[c] = T[c]! * stepT
    }
  }
  if (ground) {
    out.hitsGround = true
    const x = px + dx * t1
    const y = py + dy * t1
    const z = pz + dz * t1
    const len = Math.sqrt(x * x + y * y + z * z)
    for (const sun of suns) {
      const sx = sun.direction[0]!
      const sy = sun.direction[1]!
      const sz = sun.direction[2]!
      const ndl = Math.max(0, (x * sx + y * sy + z * sz) / len)
      if (ndl <= 0) continue
      const k = 1.00001
      sunTransmittance(m, tlut, x * k, y * k, z * k, sx, sy, sz, sunT)
      for (let c = 0; c < 3; c++) {
        L[c] = L[c]! + (T[c]! * sun.illuminance[c]! * sunT[c]! * ndl * m.albedo[c]!) / Math.PI
      }
    }
    T.fill(0)
  }
  for (let c = 0; c < 3; c++) L[c] = L[c]! * m.intensity
  return out
}
