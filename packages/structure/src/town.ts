import { type Entity, Rng, type World } from '@aethervtt/shard-core'
import { Floor, Opening, Wall } from './components'

// The town fixture (0112): a Project Zomboid-sized grid of small buildings on one ground floor, for
// colliders, nav and their budgets. It spawns structure components only, so it runs headless.

/** One building's entities. */
export interface TownBuilding {
  /** Its footprint: x0, z0, x1, z1. */
  bounds: [number, number, number, number]
  walls: Entity[]
  /** Front door first, then interior doors. */
  doors: Entity[]
  windows: Entity[]
  /** Its exterior walls: front (z0), back (z1), left (x0), right (x1). */
  front: Entity
  back: Entity
  left: Entity
  right: Entity
}

export interface Town {
  ground: Entity
  buildings: TownBuilding[]
  /** The whole town: x0, z0, x1, z1. */
  bounds: [number, number, number, number]
}

export interface TownOptions {
  seed?: number
  /** How many buildings (default 200). */
  buildings?: number
  /** Lot size, m (default 20). */
  lot?: number
}

/**
 * Spawns a town: buildings of one to three rooms on 20 m lots, each with 0.2 m walls 3 m tall, a
 * 1 m front door, 0.9 m interior doors and a window in each side wall; one in five has an arched
 * back wall. A ground floor covers every lot.
 */
export function town(world: World, options: TownOptions = {}): Town {
  const rng = new Rng(options.seed ?? 1)
  const count = options.buildings ?? 200
  const lot = options.lot ?? 20
  const cols = Math.ceil(Math.sqrt((count * 15) / 14))
  const rows = Math.ceil(count / cols)
  const x1 = cols * lot
  const z1 = rows * lot
  const ground = world.spawn([
    Floor,
    {
      points: [
        [0, 0],
        [x1, 0],
        [x1, z1],
        [0, z1],
      ],
    },
  ])
  const wall = (a: [number, number], b: [number, number], extra: Record<string, unknown> = {}) =>
    world.spawn([Wall, { a, b, height: 3, thickness: 0.2, ...extra }])
  const opening = (host: Entity, value: Record<string, unknown>) =>
    world.spawn([Opening, { wall: host, ...value }])
  const buildings: TownBuilding[] = []
  for (let i = 0; i < count; i++) {
    const lx = (i % cols) * lot
    const lz = Math.floor(i / cols) * lot
    const w = 8 + rng.float() * 4
    const d = 7 + rng.float() * 4
    const rooms = 1 + Math.min(2, Math.floor(rng.float() * 3))
    const arched = rng.float() < 0.2
    const x0 = lx + 4
    const z0 = lz + 4
    const xe = x0 + w
    const ze = z0 + d
    const front = wall([x0, z0], [xe, z0])
    // Arched back walls bow away from the building (to the right of travel from xe to x0 is +z).
    const back = wall([xe, ze], [x0, ze], arched ? { shape: 'arc', bow: -1.5 } : {})
    const left = wall([x0, ze], [x0, z0])
    const right = wall([xe, z0], [xe, ze])
    const b: TownBuilding = {
      bounds: [x0, z0, xe, ze],
      walls: [front, back, left, right],
      doors: [opening(front, { kind: 'door', offset: w / 2 - 0.5, width: 1, height: 2.1 })],
      windows: [
        opening(left, { kind: 'window', offset: d / 2 - 0.6, width: 1.2, height: 1.2, sill: 0.9 }),
        opening(right, { kind: 'window', offset: d / 2 - 0.6, width: 1.2, height: 1.2, sill: 0.9 }),
      ],
      front,
      back,
      left,
      right,
    }
    for (let r = 1; r < rooms; r++) {
      const x = x0 + (w * r) / rooms
      const inner = wall([x, z0], [x, ze])
      b.walls.push(inner)
      b.doors.push(opening(inner, { kind: 'door', offset: d / 2 - 0.45, width: 0.9, height: 2.1 }))
    }
    buildings.push(b)
  }
  return { ground, buildings, bounds: [0, 0, x1, z1] }
}
