import { type DieDefinition, type DieGeometry, dieGeometry, frameOf } from './definition'
import {
  angleBetween,
  dot,
  EPSILON,
  length,
  normalize,
  type Q4,
  qConj,
  qFromFrames,
  qMul,
  qNormalize,
  qRotate,
  sub,
  type V3,
} from './math'

// Landing on a supplied result (0054): the track is the physics as simulated; the mesh is rotated
// by a symmetry of its own collider so the host's value is the one on top.

const UP: V3 = [0, 1, 0]

const geometryOf = (die: DieDefinition | DieGeometry): DieGeometry =>
  'frames' in die ? die : dieGeometry(die)

const quat = (q: ArrayLike<number>): Q4 => qNormalize([q[0]!, q[1]!, q[2]!, q[3]!])

/** Screen-up as a direction on the floor (the camera's up, flattened). */
export function floorUp(screenUp: ArrayLike<number>): V3 {
  const flat: V3 = [screenUp[0]!, 0, screenUp[2]!]
  const l = length(flat)
  return l > 1e-6 ? [flat[0] / l, 0, flat[2] / l] : [0, 0, -1]
}

/** The value on top for a body rotation: the one whose direction points most nearly up. */
export function naturalValue(
  die: DieDefinition | DieGeometry,
  rotation: ArrayLike<number>,
): number {
  const g = geometryOf(die)
  const q = quat(rotation)
  let best = g.frames[0]!.value
  let height = Number.NEGATIVE_INFINITY
  for (const frame of g.frames) {
    const y = qRotate(q, frame.normal)[1]
    if (y > height) {
      height = y
      best = frame.value
    }
  }
  return best
}

/** How nearly the top value's direction points up: 1 when it's exactly vertical. */
export function topAlignment(
  die: DieDefinition | DieGeometry,
  rotation: ArrayLike<number>,
): number {
  const g = geometryOf(die)
  if (g.definition.collider === 'ball') return 1
  const q = quat(rotation)
  let height = Number.NEGATIVE_INFINITY
  for (const frame of g.frames) height = Math.max(height, qRotate(q, frame.normal)[1])
  return height
}

/**
 * The angle (radians) between a value's mark-up on screen and screen-up, both flattened onto the
 * floor, for a die shown at `rotation`.
 */
export function markAngle(
  die: DieDefinition | DieGeometry,
  rotation: ArrayLike<number>,
  value: number,
  screenUp: ArrayLike<number> = [0, 0, -1],
): number {
  const g = geometryOf(die)
  const b = qRotate(quat(rotation), frameOf(g, value).bitangent)
  return angleBetween(normalize([b[0], 0, b[2]]), floorUp(screenUp))
}

/**
 * The correction for a die that came to rest at `finalRotation`: a symmetry C of its collider,
 * post-multiplied onto every sampled rotation (shown = rotation · C), that puts `target` where the
 * natural value is. Among the symmetries that do, it's the one whose mark reads closest to
 * screen-up. A ball's group is every rotation, so its target ends exactly up and upright. Throws
 * `dice/invalid-value` for a value the die can't show.
 */
export function landingCorrection(
  die: DieDefinition | DieGeometry,
  finalRotation: ArrayLike<number>,
  target: number,
  screenUp: ArrayLike<number> = [0, 0, -1],
): Q4 {
  const g = geometryOf(die)
  const frame = frameOf(g, target)
  const r = quat(finalRotation)
  const up = floorUp(screenUp)
  if (g.definition.collider === 'ball') {
    // rotation · C maps the target cell to up, its mark to screen-up.
    return qNormalize(qMul(qConj(r), qFromFrames(frame.normal, frame.bitangent, UP, up)))
  }
  const natural = frameOf(g, naturalValue(g, r))
  let best: Q4 | undefined
  let score = Number.NEGATIVE_INFINITY
  for (const c of g.symmetries) {
    if (length(sub(qRotate(c, frame.normal), natural.normal)) > EPSILON * 10) continue
    const b = qRotate(r, qRotate(c, frame.bitangent))
    const s = dot(normalize([b[0], 0, b[2]]), up)
    if (s > score + 1e-9) {
      score = s
      best = c
    }
  }
  // Every definition's frames were built by carrying one frame with its own symmetries.
  return best ?? [0, 0, 0, 1]
}

/**
 * A rotation that rests `target` on top with its mark exactly toward screen-up: reduced motion,
 * placed dice and thumbnails. The face opposite rests on the floor (a d4 rests on the face
 * opposite its vertex).
 */
export function restRotation(
  die: DieDefinition | DieGeometry,
  target: number,
  screenUp: ArrayLike<number> = [0, 0, -1],
): Q4 {
  const g = geometryOf(die)
  const frame = frameOf(g, target)
  return qFromFrames(frame.normal, frame.bitangent, UP, floorUp(screenUp))
}

/** The height of the die's center above the floor at `rotation`: its lowest point touches it. */
export function restingHeight(
  die: DieDefinition | DieGeometry,
  rotation: ArrayLike<number>,
  scale: number,
): number {
  const g = geometryOf(die)
  if (g.definition.collider === 'ball') return scale
  const q = quat(rotation)
  let low = 0
  for (const p of g.points) low = Math.min(low, qRotate(q, p)[1])
  return -low * scale
}
