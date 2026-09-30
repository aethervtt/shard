import type { Settle, SettleRule, TrackPhase } from '@aethervtt/shard-physics/track'

// The `dice-settle` rule (0054), on its own so the dice worker carries nothing else: it runs in a
// worker with no registries, so everything it knows about the dice arrives as data.

export interface DiceTray {
  /** Half the tray's width (x) and depth (z), in world units. */
  halfWidth: number
  halfDepth: number
}

/** What `dice-settle` needs about each body. */
export interface DiceSettleParams {
  tray: DiceTray
  bodies: {
    /** Unit directions (x y z each) whose value reads when up: face normals, or the d4's vertices. */
    directions: number[]
    /** Collider points, scaled (hulls), for floor clearance. */
    points?: number[]
    /** Ball radius. */
    radius?: number
  }[]
}

export const DICE_SETTLE_RULE = 'dice-settle'
/** The step a track still not settled runs its one cleanup phase. */
export const DICE_CLEANUP_STEP = 240

const FLAT_ALIGNMENT = 0.995
const FLOOR_CLEARANCE = 0.035
/** Settling isn't checked before this step: dice sleep briefly at the top of a bounce. */
const MIN_SETTLE_STEP = 45
/** A ball's damping after its first bounce: angular ramps up over `steps`, linear jumps. */
export const BALL_DAMPING = { from: 0.2, to: 8, steps: 20, linear: 2.4 }

/** Collision groups: dice touch dice, walls and the floor; walls and floor touch dice. */
export const DICE_GROUPS = {
  dice: { layers: 1, mask: 1 | 2 | 4 },
  walls: { layers: 2, mask: 1 },
  floor: { layers: 4, mask: 1 },
}

/** The cleanup phase: walls off, dice stop touching each other, everyone wakes. */
const CLEANUP: TrackPhase = {
  groups: { dice: { layers: 1, mask: 4 } },
  disableGroups: ['walls'],
  wake: true,
}

/** Outside the tray for good: below the floor, or past a wall. */
export function outsideTray(p: ArrayLike<number>, tray: DiceTray): boolean {
  return (
    p[1]! < -0.5 || Math.abs(p[0]!) > tray.halfWidth + 0.3 || Math.abs(p[2]!) > tray.halfDepth + 0.3
  )
}

/** The y component of (x, y, z) rotated by q. */
function rotatedY(q: ArrayLike<number>, x: number, y: number, z: number): number {
  const qx = q[0]!
  const qy = q[1]!
  const qz = q[2]!
  const qw = q[3]!
  const tx = 2 * (qy * z - qz * y)
  const tz = 2 * (qx * y - qy * x)
  return y + qw * (2 * (qz * x - qx * z)) + (qz * tx - qx * tz)
}

/** A body at rest reading a value: flat (a face, or the d4's vertex, up) and on the floor. */
export function restingFlat(
  body: DiceSettleParams['bodies'][number],
  pos: ArrayLike<number>,
  rot: ArrayLike<number>,
): boolean {
  if (body.radius !== undefined) return pos[1]! - body.radius <= FLOOR_CLEARANCE
  let up = Number.NEGATIVE_INFINITY
  const d = body.directions
  for (let i = 0; i < d.length; i += 3)
    up = Math.max(up, rotatedY(rot, d[i]!, d[i + 1]!, d[i + 2]!))
  if (up < FLAT_ALIGNMENT) return false
  let low = Number.POSITIVE_INFINITY
  const p = body.points!
  for (let i = 0; i < p.length; i += 3) {
    low = Math.min(low, rotatedY(rot, p[i]!, p[i + 1]!, p[i + 2]!))
  }
  return pos[1]! + low <= FLOOR_CLEARANCE
}

/**
 * Done once every die in the tray sleeps resting flat (dice that left the tray are the placed
 * fallback's). Every body asleep with one cocked, or step 240 unsettled, runs the cleanup phase
 * once. A ball's angular damping ramps up after its first bounce, so it settles when the others do.
 */
export const diceSettle: SettleRule = (raw): Settle => {
  const params = raw as DiceSettleParams
  const n = params.bodies.length
  const pos = new Float64Array(3)
  const rot = new Float64Array(4)
  const bounced = new Uint8Array(n)
  const damping = new Float64Array(n)
  let cleaned = false
  return (view) => {
    let phase: TrackPhase | undefined
    for (let i = 0; i < n; i++) {
      const body = params.bodies[i]!
      if (body.radius === undefined) continue
      view.pose(i, pos, rot)
      if (!bounced[i] && pos[1]! - body.radius < 0.02) {
        bounced[i] = 1
        damping[i] = BALL_DAMPING.from
      }
      if (bounced[i] && damping[i]! < BALL_DAMPING.to) {
        damping[i] = Math.min(
          BALL_DAMPING.to,
          damping[i]! + (BALL_DAMPING.to - BALL_DAMPING.from) / BALL_DAMPING.steps,
        )
        phase ??= { damping: [] }
        phase.damping!.push({ body: i, angular: damping[i]!, linear: BALL_DAMPING.linear })
      }
    }
    if (view.step >= MIN_SETTLE_STEP) {
      let asleep = true
      let flat = true
      for (let i = 0; i < n && asleep; i++) {
        view.pose(i, pos, rot)
        if (outsideTray(pos, params.tray)) continue
        if (view.sleeping[i] === 0) asleep = false
        else if (flat && !restingFlat(params.bodies[i]!, pos, rot)) flat = false
      }
      if (asleep && flat) return 'done'
      if ((asleep || view.step >= DICE_CLEANUP_STEP) && !cleaned) {
        cleaned = true
        phase = { ...phase, ...CLEANUP }
      }
    }
    return phase ?? 'continue'
  }
}
