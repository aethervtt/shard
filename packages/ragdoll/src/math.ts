/**
 * Quaternion and rigid-pose helpers for the per-frame paths: arrays with offsets, out-parameters,
 * no allocation. Quaternions are (x, y, z, w).
 */

type Arr = { [i: number]: number }

/** out[o] = a[ao] · b[bo]. `out` may alias either input. */
export function qmul(out: Arr, o: number, a: Arr, ao: number, b: Arr, bo: number): void {
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const aw = a[ao + 3]!
  const bx = b[bo]!
  const by = b[bo + 1]!
  const bz = b[bo + 2]!
  const bw = b[bo + 3]!
  out[o] = aw * bx + ax * bw + ay * bz - az * by
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz
}

/** out = conj(a) · b: b relative to a. */
export function qmulConj(out: Arr, o: number, a: Arr, ao: number, b: Arr, bo: number): void {
  const ax = -a[ao]!
  const ay = -a[ao + 1]!
  const az = -a[ao + 2]!
  const aw = a[ao + 3]!
  const bx = b[bo]!
  const by = b[bo + 1]!
  const bz = b[bo + 2]!
  const bw = b[bo + 3]!
  out[o] = aw * bx + ax * bw + ay * bz - az * by
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz
}

/** out = a · conj(b). */
export function qmulByConj(out: Arr, o: number, a: Arr, ao: number, b: Arr, bo: number): void {
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const aw = a[ao + 3]!
  const bx = -b[bo]!
  const by = -b[bo + 1]!
  const bz = -b[bo + 2]!
  const bw = b[bo + 3]!
  out[o] = aw * bx + ax * bw + ay * bz - az * by
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz
}

export function qnormalize(q: Arr, o: number): void {
  const x = q[o]!
  const y = q[o + 1]!
  const z = q[o + 2]!
  const w = q[o + 3]!
  const len = Math.sqrt(x * x + y * y + z * z + w * w)
  if (len === 0) {
    q[o] = q[o + 1] = q[o + 2] = 0
    q[o + 3] = 1
    return
  }
  q[o] = x / len
  q[o + 1] = y / len
  q[o + 2] = z / len
  q[o + 3] = w / len
}

/** Shortest-arc slerp from a toward b by t into out. */
export function qslerp(out: Arr, o: number, a: Arr, ao: number, b: Arr, bo: number, t: number) {
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const aw = a[ao + 3]!
  let bx = b[bo]!
  let by = b[bo + 1]!
  let bz = b[bo + 2]!
  let bw = b[bo + 3]!
  let cos = ax * bx + ay * by + az * bz + aw * bw
  if (cos < 0) {
    cos = -cos
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let ka = 1 - t
  let kb = t
  if (cos < 0.9995) {
    const angle = Math.acos(cos)
    const s = Math.sin(angle)
    ka = Math.sin((1 - t) * angle) / s
    kb = Math.sin(t * angle) / s
  }
  out[o] = ax * ka + bx * kb
  out[o + 1] = ay * ka + by * kb
  out[o + 2] = az * ka + bz * kb
  out[o + 3] = aw * ka + bw * kb
  qnormalize(out, o)
}

/** Rotates the vector v[vo] by q[qo] into out[o]. `out` may alias v. */
export function qrotate(out: Arr, o: number, q: Arr, qo: number, v: Arr, vo: number): void {
  const qx = q[qo]!
  const qy = q[qo + 1]!
  const qz = q[qo + 2]!
  const qw = q[qo + 3]!
  const vx = v[vo]!
  const vy = v[vo + 1]!
  const vz = v[vo + 2]!
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  out[o] = vx + qw * tx + (qy * tz - qz * ty)
  out[o + 1] = vy + qw * ty + (qz * tx - qx * tz)
  out[o + 2] = vz + qw * tz + (qx * ty - qy * tx)
}

/** Rotates v by conj(q): into q's frame. */
export function qrotateInv(out: Arr, o: number, q: Arr, qo: number, v: Arr, vo: number): void {
  const qx = -q[qo]!
  const qy = -q[qo + 1]!
  const qz = -q[qo + 2]!
  const qw = q[qo + 3]!
  const vx = v[vo]!
  const vy = v[vo + 1]!
  const vz = v[vo + 2]!
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  out[o] = vx + qw * tx + (qy * tz - qz * ty)
  out[o + 1] = vy + qw * ty + (qz * tx - qx * tz)
  out[o + 2] = vz + qw * tz + (qx * ty - qy * tx)
}

/**
 * The rotation part of a 3x4 row-major affine (12 floats at o), scale removed, as a quaternion.
 * Also returns the mean axis scale.
 */
export function quatFromRows(out: Arr, oo: number, m: Arr, o: number): number {
  let m00 = m[o]!
  let m01 = m[o + 1]!
  let m02 = m[o + 2]!
  let m10 = m[o + 4]!
  let m11 = m[o + 5]!
  let m12 = m[o + 6]!
  let m20 = m[o + 8]!
  let m21 = m[o + 9]!
  let m22 = m[o + 10]!
  const sx = Math.sqrt(m00 * m00 + m10 * m10 + m20 * m20) || 1
  const sy = Math.sqrt(m01 * m01 + m11 * m11 + m21 * m21) || 1
  const sz = Math.sqrt(m02 * m02 + m12 * m12 + m22 * m22) || 1
  m00 /= sx
  m10 /= sx
  m20 /= sx
  m01 /= sy
  m11 /= sy
  m21 /= sy
  m02 /= sz
  m12 /= sz
  m22 /= sz
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    out[oo + 3] = 0.25 / s
    out[oo] = (m21 - m12) * s
    out[oo + 1] = (m02 - m20) * s
    out[oo + 2] = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    out[oo + 3] = (m21 - m12) / s
    out[oo] = 0.25 * s
    out[oo + 1] = (m01 + m10) / s
    out[oo + 2] = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    out[oo + 3] = (m02 - m20) / s
    out[oo] = (m01 + m10) / s
    out[oo + 1] = 0.25 * s
    out[oo + 2] = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    out[oo + 3] = (m10 - m01) / s
    out[oo] = (m02 + m20) / s
    out[oo + 1] = (m12 + m21) / s
    out[oo + 2] = 0.25 * s
  }
  qnormalize(out, oo)
  return (sx + sy + sz) / 3
}

/**
 * A rotation's axis times its angle (the shortest way) into out: what turns by q in one second.
 */
export function qlog(out: Arr, o: number, q: Arr, qo: number): void {
  let x = q[qo]!
  let y = q[qo + 1]!
  let z = q[qo + 2]!
  let w = q[qo + 3]!
  if (w < 0) {
    x = -x
    y = -y
    z = -z
    w = -w
  }
  const s = Math.sqrt(x * x + y * y + z * z)
  if (s < 1e-9) {
    out[o] = 2 * x
    out[o + 1] = 2 * y
    out[o + 2] = 2 * z
    return
  }
  const angle = 2 * Math.atan2(s, w)
  out[o] = (x / s) * angle
  out[o + 1] = (y / s) * angle
  out[o + 2] = (z / s) * angle
}

/** The angle (rad) between two rotations. */
export function qangle(a: Arr, ao: number, b: Arr, bo: number): number {
  const d = Math.abs(
    a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!,
  )
  return 2 * Math.acos(Math.min(1, d))
}

/** The rotation turning unit vector a onto unit vector b. */
export function qfromTo(out: Arr, o: number, a: Arr, ao: number, b: Arr, bo: number): void {
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const bx = b[bo]!
  const by = b[bo + 1]!
  const bz = b[bo + 2]!
  const d = ax * bx + ay * by + az * bz
  if (d < -0.999999) {
    // Opposite: any axis perpendicular to a.
    let px = 0
    let py = -az
    let pz = ay
    if (py * py + pz * pz < 1e-6) {
      px = az
      py = 0
      pz = -ax
    }
    const l = Math.sqrt(px * px + py * py + pz * pz)
    out[o] = px / l
    out[o + 1] = py / l
    out[o + 2] = pz / l
    out[o + 3] = 0
    return
  }
  out[o] = ay * bz - az * by
  out[o + 1] = az * bx - ax * bz
  out[o + 2] = ax * by - ay * bx
  out[o + 3] = 1 + d
  qnormalize(out, o)
}

/** A rotation whose x axis is `x` and whose z axis is as near `z` as x allows. */
export function qfromAxes(out: Arr, o: number, x: Arr, xo: number, z: Arr, zo: number): void {
  let x0 = x[xo]!
  let x1 = x[xo + 1]!
  let x2 = x[xo + 2]!
  let l = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2) || 1
  x0 /= l
  x1 /= l
  x2 /= l
  // z made perpendicular to x.
  let z0 = z[zo]!
  let z1 = z[zo + 1]!
  let z2 = z[zo + 2]!
  const d = z0 * x0 + z1 * x1 + z2 * x2
  z0 -= d * x0
  z1 -= d * x1
  z2 -= d * x2
  l = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2)
  if (l < 1e-6) {
    // z along x: any perpendicular.
    z0 = -x1
    z1 = x0
    z2 = 0
    if (Math.abs(x2) > 0.9) {
      z0 = 0
      z1 = -x2
      z2 = x1
    }
    l = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2)
  }
  z0 /= l
  z1 /= l
  z2 /= l
  // y = z × x.
  const y0 = z1 * x2 - z2 * x1
  const y1 = z2 * x0 - z0 * x2
  const y2 = z0 * x1 - z1 * x0
  // Columns x, y, z.
  const rows = [x0, y0, z0, 0, x1, y1, z1, 0, x2, y2, z2, 0]
  quatFromRows(out, o, rows, 0)
}
