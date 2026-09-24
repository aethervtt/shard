import type { AudioDistanceModel } from '@shard/platform'

/**
 * Web Audio's distance gain for a PannerNode (spec formulas, including the edge cases), so the
 * headless backend records what a browser plays. `linear` reaches 0 at `max`; `inverse` and
 * `exponential` never do (they ignore `max`).
 */
export function distanceGain(
  model: AudioDistanceModel,
  distance: number,
  ref: number,
  max: number,
  rolloff: number,
): number {
  distanceGainInto(model, distance, ref, max, rolloff, scratch)
  return scratch[0]!
}

const scratch = new Float64Array(1)

/** `distanceGain` into `out[0]`, for per-frame code (a returned double can allocate). */
export function distanceGainInto(
  model: AudioDistanceModel,
  distance: number,
  ref: number,
  max: number,
  rolloff: number,
  out: Float64Array,
): void {
  if (model === 'linear') {
    const f = rolloff < 0 ? 0 : rolloff > 1 ? 1 : rolloff
    if (max <= ref) {
      out[0] = 1 - f
      return
    }
    const d = distance < ref ? ref : distance > max ? max : distance
    out[0] = 1 - (f * (d - ref)) / (max - ref)
  } else if (ref <= 0) out[0] = 0
  else {
    const d = distance < ref ? ref : distance
    out[0] = model === 'inverse' ? ref / (ref + rolloff * (d - ref)) : (d / ref) ** -rolloff
  }
}

/** Whether a distance model can reach silence (and so a far source can go virtual). */
export function reachesZero(model: AudioDistanceModel, rolloff: number): boolean {
  return model === 'linear' && rolloff >= 1
}

/**
 * Where a point sits for a listener: writes the distance to `out[0]` and the equal-power pan to
 * `out[1]` (-1 left, 0 ahead or behind, +1 right). The pan is Web Audio's: azimuth in the
 * listener's horizontal plane, folded front to back, scaled to ±90° → ±1. `listener` is an
 * affine 3x4 world matrix, row by row (right is column 0, up column 1, back column 2).
 */
export function listenerRelative(
  listener: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const rx = x - listener[3]!
  const ry = y - listener[7]!
  const rz = z - listener[11]!
  out[0] = Math.sqrt(rx * rx + ry * ry + rz * rz)
  const r0 = listener[0]!
  const r1 = listener[4]!
  const r2 = listener[8]!
  const b0 = listener[2]!
  const b1 = listener[6]!
  const b2 = listener[10]!
  const rightLen = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2) || 1
  const backLen = Math.sqrt(b0 * b0 + b1 * b1 + b2 * b2) || 1
  const side = (rx * r0 + ry * r1 + rz * r2) / rightLen
  const back = (rx * b0 + ry * b1 + rz * b2) / backLen
  if (Math.abs(side) < 1e-9 && Math.abs(back) < 1e-9) {
    out[1] = 0
    return
  }
  let azimuth = Math.atan2(side, -back)
  const half = Math.PI / 2
  if (azimuth > half) azimuth = Math.PI - azimuth
  else if (azimuth < -half) azimuth = -Math.PI - azimuth
  out[1] = azimuth / half
}

/** Equal-power channel gains for a mono source at `pan`: writes left to `out[0]`, right to `out[1]`. */
export function equalPowerGains(pan: number, out: Float64Array): void {
  const p = ((pan < -1 ? -1 : pan > 1 ? 1 : pan) + 1) / 2
  out[0] = Math.cos((p * Math.PI) / 2)
  out[1] = Math.sin((p * Math.PI) / 2)
}
