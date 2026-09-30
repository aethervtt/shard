// Small f64 vector and quaternion helpers for die geometry: definitions are analyzed once and
// cached, so these may allocate. Per-frame code (playback) inlines its math instead.

export type V3 = [number, number, number]
/** x y z w. */
export type Q4 = [number, number, number, number]

export const EPSILON = 1e-5

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const length = (a: V3): number => Math.sqrt(dot(a, a))

export function normalize(a: V3): V3 {
  const l = length(a)
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}

export const distance = (a: V3, b: V3): number => length(sub(a, b))

/** The part of `a` perpendicular to unit `n`, normalized. */
export function tangentOf(a: V3, n: V3): V3 {
  return normalize(sub(a, scale(n, dot(a, n))))
}

/** A unit tangent of unit `n` that doesn't depend on anything else (Aether's convention). */
export function stableTangent(n: V3): V3 {
  const axis: V3 = Math.abs(n[1]) < 0.82 ? [0, 1, 0] : [1, 0, 0]
  return tangentOf(axis, n)
}

export const qIdentity = (): Q4 => [0, 0, 0, 1]

export function qMul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export const qConj = (q: Q4): Q4 => [-q[0], -q[1], -q[2], q[3]]

export function qNormalize(q: Q4): Q4 {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

export function qRotate(q: Q4, v: V3): V3 {
  const [qx, qy, qz, qw] = q
  const tx = 2 * (qy * v[2] - qz * v[1])
  const ty = 2 * (qz * v[0] - qx * v[2])
  const tz = 2 * (qx * v[1] - qy * v[0])
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ]
}

export function qAxisAngle(axis: V3, radians: number): Q4 {
  const n = normalize(axis)
  const s = Math.sin(radians / 2)
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(radians / 2)]
}

/** The rotation whose matrix has these columns (an orthonormal, right-handed basis). */
export function qFromBasis(x: V3, y: V3, z: V3): Q4 {
  const m00 = x[0]
  const m11 = y[1]
  const m22 = z[2]
  const trace = m00 + m11 + m22
  let q: Q4
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]
  }
  return qNormalize(q)
}

/**
 * The rotation taking the frame (n, b) to (n2, b2): n and n2 unit normals, b ⟂ n and b2 ⟂ n2 unit
 * "up" directions. Exact when the angle between n and b equals the one between n2 and b2.
 */
export function qFromFrames(n: V3, b: V3, n2: V3, b2: V3): Q4 {
  const t = cross(b, n)
  const t2 = cross(b2, n2)
  // R = [t2 b2 n2] · [t b n]ᵀ
  const from = qFromBasis(t, b, n)
  const to = qFromBasis(t2, b2, n2)
  return qNormalize(qMul(to, qConj(from)))
}

/** Canonical sign (first non-zero of w, x, y, z positive), so equal rotations compare equal. */
export function qCanonical(q: Q4): Q4 {
  const pivot = [q[3], q[0], q[1], q[2]].find((v) => Math.abs(v) > 1e-8) ?? 1
  const s = pivot < 0 ? -1 : 1
  return [round(q[0] * s), round(q[1] * s), round(q[2] * s), round(q[3] * s)]
}

export const qKey = (q: Q4): string =>
  qCanonical(q)
    .map((v) => v.toFixed(6))
    .join(':')

/** Rounds away float noise, so hull output and frames are stable across platforms. */
export function round(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(9))
}

/** The angle between two unit vectors, in radians. */
export function angleBetween(a: V3, b: V3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b))))
}

/** FNV-1a over a string, finished with a 32-bit mix: a stable seed from a roll id. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}
