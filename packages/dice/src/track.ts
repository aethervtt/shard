import { quat as quatMath, Rng, ShardError } from '@aethervtt/shard-core'
import type {
  Track,
  TrackBody,
  TrackCollider,
  TrackContactOptions,
  TrackScene,
} from '@aethervtt/shard-physics/track'
import { type DieGeometry, dieGeometry, requireDie } from './definition'
import { restingHeight } from './landing'
import { hashString, type Q4, type V3 } from './math'
import {
  BALL_DAMPING,
  DICE_GROUPS,
  type DiceSettleParams,
  type DiceTray,
  outsideTray,
  restingFlat,
} from './settle'

// Dice as physics tracks (0054): a request becomes a 0053 TrackScene, deterministic in its inputs.
// The result isn't one of them, so a track can be recorded before it's known and reused for any.

export const LAUNCH_EDGES = ['left', 'right', 'top', 'bottom'] as const
export type LaunchEdge = (typeof LAUNCH_EDGES)[number]

export interface DiceTrackDie {
  /** A registered definition's id. */
  definition: string
  /** World scale of the unit-radius die. */
  scale: number
  /** Dropped dice are heavier on friction and lighter on bounce. */
  dropped?: boolean
}

export interface DiceTrackRequest {
  /** Every random choice (edge, lanes, velocities, spin, starting orientations) derives from it. */
  seed: string | number
  tray: DiceTray
  dice: DiceTrackDie[]
  /** The tray edge the dice come in from; chosen from the seed when omitted. */
  launch?: LaunchEdge
}

export const DICE_STEP = 1 / 60
export const DICE_MAX_STEPS = 480
/** The steps a placed die takes to drop into its spot. */
export const PLACED_DROP_STEPS = 20
export const DICE_GRAVITY = -18.5
/** Contacts as the impact synth hears them. */
export const DICE_CONTACTS: TrackContactOptions = { minForce: 0.24, dedupeSteps: 3, max: 1024 }
export const MAX_DICE = 32

function checkRequest(request: DiceTrackRequest): void {
  const { tray, dice } = request
  if (!(tray.halfWidth >= 1) || !(tray.halfDepth >= 1)) {
    throw new ShardError('dice/invalid-roll', 'The tray is smaller than 1 × 1 half-extents', {
      path: 'tray',
      hint: 'Pass the tray the camera shows, e.g. { halfWidth: 5.4, halfDepth: 3.15 }.',
    })
  }
  if (dice.length < 1 || dice.length > MAX_DICE) {
    throw new ShardError('dice/invalid-roll', `A roll has 1 to ${MAX_DICE} physical dice`, {
      path: 'dice',
    })
  }
  dice.forEach((d, i) => {
    if (!(d.scale > 0.05 && d.scale < 4))
      throw new ShardError('dice/invalid-roll', `dice[${i}].scale is out of range`, {
        path: `dice[${i}].scale`,
      })
  })
}

export const seedOf = (seed: string | number): number =>
  typeof seed === 'number' ? seed >>> 0 : hashString(seed)

const signed = (rng: Rng) => rng.float() * 2 - 1

/**
 * A uniformly random rotation from +, −, ×, ÷ and √ only: a point in the 4D ball, normalized. Every
 * JS engine rounds those the same (IEEE 754); Math.sin and Math.cos they don't, and a starting
 * rotation one bit off records another track on another machine.
 */
function randomRotation(rng: Rng): Q4 {
  for (;;) {
    const x = signed(rng)
    const y = signed(rng)
    const z = signed(rng)
    const w = signed(rng)
    const d = x * x + y * y + z * z + w * w
    if (d > 1 || d < 0.04) continue
    const l = Math.sqrt(d)
    return [x / l, y / l, z / l, w / l]
  }
}

/** Aether's launch lanes: rows of dice along the launch edge, thrown inward. */
function spawnFor(index: number, count: number, tray: DiceTray, edge: LaunchEdge, rng: Rng) {
  const alongX = edge === 'left' || edge === 'right'
  const normalHalf = alongX ? tray.halfWidth : tray.halfDepth
  const tangentHalf = alongX ? tray.halfDepth : tray.halfWidth
  const spacing = count > 16 ? 0.54 : 0.72
  const capacity = Math.max(2, Math.floor((tangentHalf * 2 * 0.76) / spacing))
  const columns = Math.min(count, capacity)
  const column = index % columns
  const row = Math.floor(index / columns)
  const sign = edge === 'left' || edge === 'top' ? -1 : 1
  const span = Math.min(tangentHalf * 1.48, Math.max(0, columns - 1) * spacing)
  const tangent = columns === 1 ? signed(rng) * 0.18 : -span / 2 + (column / (columns - 1)) * span
  const normal = sign * (normalHalf - 0.28 - row * 0.34) + signed(rng) * 0.08
  const inward = alongX ? 5.8 + rng.float() * 1.7 : 4.25 + rng.float() * 1.45
  const across = -tangent * (0.34 + rng.float() * 0.16) + signed(rng) * 1.35
  const y = 1.55 + row * 0.18 + rng.float() * 0.52
  const vy = 1.65 + rng.float() * 1.7
  return {
    position: (alongX ? [normal, y, tangent] : [tangent, y, normal]) as V3,
    velocity: (alongX ? [-sign * inward, vy, across] : [across, vy, -sign * inward]) as V3,
  }
}

function tray(t: DiceTray): TrackCollider[] {
  const surface = { friction: 0.62, restitution: 0.24, density: 1 }
  const wall = (x: number, z: number, hx: number, hz: number): TrackCollider => ({
    shape: 'cuboid',
    halfExtents: [hx, 1.35, hz],
    translation: [x, 1.16, z],
    ...surface,
    group: 'walls',
  })
  const { halfWidth: hw, halfDepth: hd } = t
  return [
    {
      shape: 'cuboid',
      halfExtents: [hw, 0.16, hd],
      translation: [0, -0.16, 0],
      ...surface,
      group: 'floor',
    },
    wall(-hw - 0.12, 0, 0.16, hd),
    wall(hw + 0.12, 0, 0.16, hd),
    wall(0, -hd - 0.12, hw, 0.16),
    wall(0, hd + 0.12, hw, 0.16),
  ]
}

function colliderOf(g: DieGeometry, scale: number, dropped: boolean): TrackCollider {
  const surface = {
    density: dropped ? 0.82 : 1.1,
    friction: dropped ? 0.72 : 0.54,
    restitution: dropped ? 0.18 : 0.34,
    group: 'dice',
  }
  if (g.definition.collider === 'ball') return { shape: 'ball', radius: scale, ...surface }
  const points = new Float32Array(g.points.length * 3)
  g.points.forEach((p, i) => {
    points[i * 3] = p[0] * scale
    points[i * 3 + 1] = p[1] * scale
    points[i * 3 + 2] = p[2] * scale
  })
  return { shape: 'convex', points, ...surface }
}

/** The launch edge a request's seed picks (or the one it names). */
export function launchEdgeOf(request: DiceTrackRequest): LaunchEdge {
  return request.launch ?? new Rng(seedOf(request.seed)).pick(LAUNCH_EDGES)
}

/**
 * The 0053 scene of a throw: a walled tray, and the dice thrown in from one edge in lanes. Every
 * number comes from the seed; the definitions' geometry and scales shape the colliders, so the
 * scene hash covers them and the tray too.
 */
export function diceTrackScene(request: DiceTrackRequest): TrackScene {
  checkRequest(request)
  const rng = new Rng(seedOf(request.seed))
  const picked = rng.pick(LAUNCH_EDGES)
  const edge = request.launch ?? picked
  const bodies: TrackBody[] = request.dice.map((die, i) => {
    const g = dieGeometry(requireDie(die.definition))
    const spawn = spawnFor(i, request.dice.length, request.tray, edge, rng)
    const angular: V3 = [
      signed(rng) * (8.5 + rng.float() * 10),
      signed(rng) * (7 + rng.float() * 11),
      signed(rng) * (8.5 + rng.float() * 10),
    ]
    return {
      id: `${i}:${die.definition}`,
      translation: spawn.position,
      rotation: randomRotation(rng),
      linear: spawn.velocity,
      angular,
      colliders: [colliderOf(g, die.scale, die.dropped ?? false)],
      ccd: true,
      linearDamping: 0.16,
      angularDamping: g.definition.collider === 'ball' ? BALL_DAMPING.from : 0.2,
    }
  })
  return {
    version: 1,
    dim: 3,
    step: DICE_STEP,
    maxSteps: DICE_MAX_STEPS,
    gravity: [0, DICE_GRAVITY, 0],
    groups: DICE_GROUPS,
    fixed: tray(request.tray),
    bodies,
  }
}

/** The data `dice-settle` needs about a request's dice. */
export function diceSettleParams(request: DiceTrackRequest): DiceSettleParams {
  return {
    tray: { ...request.tray },
    bodies: request.dice.map((die) => {
      const g = dieGeometry(requireDie(die.definition))
      if (g.definition.collider === 'ball') return { directions: [], radius: die.scale }
      return {
        directions: g.frames.flatMap((f) => f.normal),
        points: g.points.flatMap((p) => [p[0] * die.scale, p[1] * die.scale, p[2] * die.scale]),
      }
    }),
  }
}

// --- landing: which dice the track can't show, and where they go instead ----------------------

export type UnlandedReason = 'outside' | 'cocked'

/**
 * Per die, why the track can't show it landed: it ended outside the tray, or not resting flat
 * (a track that hit maxSteps). Null for a die that landed.
 */
export function unlandedDice(track: Track, request: DiceTrackRequest): (UnlandedReason | null)[] {
  const params = diceSettleParams(request)
  const n = track.bodyCount
  const o = track.steps * n
  return request.dice.map((_, i) => {
    const p = track.positions.subarray((o + i) * 3, (o + i) * 3 + 3)
    const r = track.rotations.subarray((o + i) * 4, (o + i) * 4 + 4)
    if (outsideTray(p, request.tray)) return 'outside'
    return restingFlat(params.bodies[i]!, p, r) ? null : 'cocked'
  })
}

/** How far apart two dice sit in a lane: the larger footprint, with room between. */
function laneSpacing(request: { readonly dice: readonly DiceTrackDie[] }): number {
  let widest = 0
  for (const d of request.dice) {
    const g = dieGeometry(requireDie(d.definition))
    widest = Math.max(widest, g.footprint * d.scale)
  }
  return widest * 1.18
}

/** Spots on a grid over the tray, `spacing` apart, kept `margin` from the walls. */
function gridSpots(t: DiceTray, spacing: number, margin: number): V3[] {
  const spots: V3[] = []
  const nx = Math.max(1, Math.floor((2 * (t.halfWidth - margin)) / spacing) + 1)
  const nz = Math.max(1, Math.floor((2 * (t.halfDepth - margin)) / spacing) + 1)
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      spots.push([(ix - (nx - 1) / 2) * spacing, 0, (iz - (nz - 1) / 2) * spacing])
    }
  }
  return spots
}

/**
 * Where reduced motion puts each die: rows centered in the tray, in roll order, left to right and
 * far to near.
 */
export function laneLayout(request: DiceTrackRequest): V3[] {
  const spacing = laneSpacing(request)
  const n = request.dice.length
  const maxColumns = Math.max(1, Math.floor((2 * request.tray.halfWidth - spacing) / spacing) + 1)
  const columns = Math.min(n, maxColumns, Math.max(1, Math.ceil(Math.sqrt(n * 2.2))))
  const rows = Math.ceil(n / columns)
  return request.dice.map((_, i) => {
    const row = Math.floor(i / columns)
    const inRow = row === rows - 1 ? n - row * columns : columns
    const col = i % columns
    return [(col - (inRow - 1) / 2) * spacing, 0, (row - (rows - 1) / 2) * spacing]
  })
}

/**
 * Free spots for the dice the track can't show: for each, the grid spot nearest to where it
 * ended (clamped into the tray) that no landed or already placed die is near.
 */
export function placementSpots(
  track: Track,
  request: DiceTrackRequest,
  unlanded: readonly (UnlandedReason | null)[],
): (V3 | null)[] {
  const spacing = laneSpacing(request)
  const t = request.tray
  const margin = spacing * 0.6
  const spots = gridSpots(t, spacing, margin)
  const o = track.steps * track.bodyCount
  const taken: V3[] = []
  unlanded.forEach((reason, i) => {
    if (reason) return
    const p = track.positions
    taken.push([p[(o + i) * 3]!, 0, p[(o + i) * 3 + 2]!])
  })
  return unlanded.map((reason, i) => {
    if (!reason) return null
    const p = track.positions
    const want: V3 = [
      Math.max(-t.halfWidth + margin, Math.min(t.halfWidth - margin, p[(o + i) * 3]!)),
      0,
      Math.max(-t.halfDepth + margin, Math.min(t.halfDepth - margin, p[(o + i) * 3 + 2]!)),
    ]
    const free = spots
      .filter((s) =>
        taken.every((q) => (s[0] - q[0]) ** 2 + (s[2] - q[2]) ** 2 >= spacing ** 2 * 0.81),
      )
      .sort(
        (a, b) =>
          (a[0] - want[0]) ** 2 +
          (a[2] - want[2]) ** 2 -
          ((b[0] - want[0]) ** 2 + (b[2] - want[2]) ** 2),
      )
    const spot = free[0] ?? want
    taken.push(spot)
    return spot
  })
}

/**
 * Where dice that aren't in the physics land (0065's entrance dice): for each wanted point (tray
 * coordinates), the grid spot nearest it that none of `taken` (where the physical dice ended) and no
 * earlier entrance die is near. `dice` are every die on the tray, for the spacing.
 */
export function entranceSpots(
  tray: DiceTray,
  dice: readonly DiceTrackDie[],
  taken: readonly V3[],
  wants: readonly V3[],
): V3[] {
  const spacing = laneSpacing({ dice })
  const margin = spacing * 0.6
  const spots = gridSpots(tray, spacing, margin)
  const occupied = taken.slice()
  return wants.map((w) => {
    const want: V3 = [
      Math.max(-tray.halfWidth + margin, Math.min(tray.halfWidth - margin, w[0])),
      0,
      Math.max(-tray.halfDepth + margin, Math.min(tray.halfDepth - margin, w[2])),
    ]
    let best: V3 | undefined
    let bestD = Number.POSITIVE_INFINITY
    for (const s of spots) {
      if (occupied.some((q) => (s[0] - q[0]) ** 2 + (s[2] - q[2]) ** 2 < spacing ** 2 * 0.81))
        continue
      const d = (s[0] - want[0]) ** 2 + (s[2] - want[2]) ** 2
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    const spot = best ?? want
    occupied.push(spot)
    return spot
  })
}

/**
 * Rewrites a die's last steps so it drops straight down into `spot`, resting at `rotation`: the
 * placed fallback, honest and deterministic. Earlier steps are the physics as recorded.
 */
export function placeDie(
  track: Track,
  body: number,
  spot: V3,
  rotation: Q4,
  geometry: DieGeometry,
  scale: number,
): void {
  const n = track.bodyCount
  const rest = restingHeight(geometry, rotation, scale)
  const from = Math.max(0, track.steps - PLACED_DROP_STEPS)
  const drop = 1.4
  const q = quatMath.normalize([0, 0, 0, 1], rotation) as Q4
  for (let s = from; s <= track.steps; s++) {
    const t = track.steps === from ? 1 : (s - from) / (track.steps - from)
    const o3 = (s * n + body) * 3
    const o4 = (s * n + body) * 4
    track.positions[o3] = spot[0]
    track.positions[o3 + 1] = rest + drop * (1 - t * t)
    track.positions[o3 + 2] = spot[2]
    track.rotations[o4] = q[0]
    track.rotations[o4 + 1] = q[1]
    track.rotations[o4 + 2] = q[2]
    track.rotations[o4 + 3] = q[3]
  }
}

/** The step a placed die starts dropping at. */
export const placedFrom = (track: Track) => Math.max(0, track.steps - PLACED_DROP_STEPS)
