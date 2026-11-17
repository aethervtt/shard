// Sun, moon and star positions (0130). World axes: +X east, +Y up, -Z north (south is +Z); `yaw`
// turns the sky about up. Directions point from the viewer toward the body.

const RAD = Math.PI / 180
/** Mean synodic month, days. */
export const SYNODIC_MONTH = 29.530589

export interface SkyPathSettings {
  path: 'simple' | 'real'
  yaw: number
  tilt: number
  latitude: number
  longitude: number
  timeZone: number
}

export interface CelestialState {
  /** Toward the sun and the moon, world space, unit. */
  sun: Float64Array
  moon: Float64Array
  /** Elevations, degrees. */
  sunElevation: number
  moonElevation: number
  /** Sun–moon elongation, radians (0 new, π full), and the moon's illuminated fraction. */
  elongation: number
  illuminated: number
  /** World → celestial (equatorial) frame, rows: d_cel[i] = dot(row i, d_world). */
  stars: Float64Array
}

export function createCelestial(): CelestialState {
  return {
    sun: new Float64Array(3),
    moon: new Float64Array(3),
    sunElevation: 0,
    moonElevation: 0,
    elongation: 0,
    illuminated: 0,
    stars: new Float64Array(9),
  }
}

/** East, up, north components into world space, turned by yaw (degrees) about up. */
function enuToWorld(e: number, u: number, n: number, yaw: number, out: Float64Array, o = 0): void {
  const c = Math.cos(yaw * RAD)
  const s = Math.sin(yaw * RAD)
  // Unturned: east +X, north -Z.
  const x = e
  const z = -n
  out[o] = c * x + s * z
  out[o + 1] = u
  out[o + 2] = -s * x + c * z
}

/** The simple path's arc: θ 0 at sunrise (east), π/2 at the peak (tilted south), π at sunset. */
function arc(theta: number, tilt: number, yaw: number, out: Float64Array): void {
  const t = tilt * RAD
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  // east·cos θ + peak·sin θ, the peak being up tilted toward the south (−north).
  enuToWorld(c, s * Math.cos(t), -s * Math.sin(t), yaw, out)
}

/** Day angle on the simple path: 0..π between dawn and dusk, π..2π through the night. */
function dayAngle(hours: number, dawn: number, dusk: number): number {
  const h = hours - Math.floor(hours / 24) * 24
  if (h >= dawn && h < dusk) return (Math.PI * (h - dawn)) / (dusk - dawn)
  const since = h >= dusk ? h - dusk : h + 24 - dusk
  return Math.PI + (Math.PI * since) / (24 - (dusk - dawn))
}

/** Julian day of a Gregorian date at UT hours. */
function julianDay(year: number, month: number, day: number, ut: number): number {
  let y = year
  let m = month
  if (m <= 2) {
    y -= 1
    m += 12
  }
  const a = Math.floor(y / 100)
  const b = 2 - a + Math.floor(a / 4)
  return (
    Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5 + ut / 24
  )
}

/**
 * Equatorial unit vector (x toward the equinox, z toward the pole) into world space at a local
 * sidereal time (degrees) and latitude: H = LST − α.
 */
function equatorialToWorld(
  x: number,
  y: number,
  z: number,
  lst: number,
  lat: number,
  yaw: number,
  out: Float64Array,
  o = 0,
): void {
  const cl = Math.cos(lst * RAD)
  const sl = Math.sin(lst * RAD)
  const cp = Math.cos(lat * RAD)
  const sp = Math.sin(lat * RAD)
  const e = -sl * x + cl * y
  const u = cp * cl * x + cp * sl * y + sp * z
  const n = -sp * cl * x - sp * sl * y + cp * z
  enuToWorld(e, u, n, yaw, out, o)
}

const axis = new Float64Array(9)

/** Rows of the world → equatorial rotation: the equatorial axes seen in world space. */
function starFrame(lst: number, lat: number, yaw: number, out: Float64Array): void {
  equatorialToWorld(1, 0, 0, lst, lat, yaw, axis, 0)
  equatorialToWorld(0, 1, 0, lst, lat, yaw, axis, 3)
  equatorialToWorld(0, 0, 1, lst, lat, yaw, axis, 6)
  out.set(axis)
}

function elevation(d: Float64Array): number {
  return Math.asin(Math.max(-1, Math.min(1, d[1]!))) / RAD
}

const eq = new Float64Array(6)

/**
 * The sun and moon (0130) at a clock reading. Simple: an arc between dawn and dusk, with the moon
 * trailing by its phase. Real: the sun from its apparent longitude (NOAA/Meeus, about 0.01°) and
 * the moon from Meeus' main lunar terms (about 0.3°), placed with the local sidereal time.
 */
export function computeCelestial(
  sky: SkyPathSettings,
  clock: {
    hours: number
    day: number
    dawn: number
    dusk: number
    startDate: { year: number; month: number; day: number }
  },
  out: CelestialState,
): CelestialState {
  if (sky.path === 'real') {
    const ut = clock.hours - sky.timeZone
    const jd =
      julianDay(clock.startDate.year, clock.startDate.month, clock.startDate.day, ut) + clock.day
    const d = jd - 2451545
    const T = d / 36525
    // Sun: apparent ecliptic longitude.
    const L0 = 280.46646 + T * (36000.76983 + 0.0003032 * T)
    const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * RAD
    const C =
      Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
      Math.sin(2 * M) * (0.019993 - 0.000101 * T) +
      Math.sin(3 * M) * 0.000289
    const omega = (125.04 - 1934.136 * T) * RAD
    const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD
    const eps =
      (23 +
        (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 +
        0.00256 * Math.cos(omega)) *
      RAD
    eq[0] = Math.cos(lambda)
    eq[1] = Math.cos(eps) * Math.sin(lambda)
    eq[2] = Math.sin(eps) * Math.sin(lambda)
    // Moon: Meeus' largest terms in longitude and latitude.
    const Lm = (218.316 + 13.176396 * d) * RAD
    const Mm = (134.963 + 13.064993 * d) * RAD
    const F = (93.272 + 13.22935 * d) * RAD
    const D = (297.85 + 12.190749 * d) * RAD
    const Ms = (357.529 + 0.98560028 * d) * RAD
    const lm =
      Lm +
      (6.289 * Math.sin(Mm) -
        1.274 * Math.sin(Mm - 2 * D) +
        0.658 * Math.sin(2 * D) +
        0.214 * Math.sin(2 * Mm) -
        0.186 * Math.sin(Ms) -
        0.114 * Math.sin(2 * F)) *
        RAD
    const bm =
      (5.128 * Math.sin(F) +
        0.281 * Math.sin(Mm + F) +
        0.278 * Math.sin(Mm - F) +
        0.173 * Math.sin(2 * D - F)) *
      RAD
    const cb = Math.cos(bm)
    eq[3] = cb * Math.cos(lm)
    eq[4] = Math.cos(eps) * cb * Math.sin(lm) - Math.sin(eps) * Math.sin(bm)
    eq[5] = Math.sin(eps) * cb * Math.sin(lm) + Math.cos(eps) * Math.sin(bm)
    // Local sidereal time (degrees).
    const lst = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T + sky.longitude
    equatorialToWorld(eq[0]!, eq[1]!, eq[2]!, lst, sky.latitude, sky.yaw, out.sun)
    equatorialToWorld(eq[3]!, eq[4]!, eq[5]!, lst, sky.latitude, sky.yaw, out.moon)
    const cosE = eq[0]! * eq[3]! + eq[1]! * eq[4]! + eq[2]! * eq[5]!
    out.elongation = Math.acos(Math.max(-1, Math.min(1, cosE)))
    starFrame(lst, sky.latitude, sky.yaw, out.stars)
  } else {
    const theta = dayAngle(clock.hours, clock.dawn, clock.dusk)
    arc(theta, sky.tilt, sky.yaw, out.sun)
    // The moon's age: day 0 starts two days before full, so the first nights are moonlit.
    const age = (clock.day + clock.hours / 24 + 12.8) % SYNODIC_MONTH
    out.elongation = (2 * Math.PI * age) / SYNODIC_MONTH
    arc(theta - out.elongation, sky.tilt, sky.yaw, out.moon)
    if (out.elongation > Math.PI) out.elongation = 2 * Math.PI - out.elongation
    // Stars turn once a day, plus a degree a day against the sun.
    const lst = (clock.hours - 12) * 15 + clock.day * 0.9856 + 180
    starFrame(lst, sky.latitude, sky.yaw, out.stars)
  }
  out.illuminated = (1 - Math.cos(out.elongation)) / 2
  out.sunElevation = elevation(out.sun)
  out.moonElevation = elevation(out.moon)
  return out
}
