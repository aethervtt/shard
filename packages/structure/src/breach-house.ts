import type { Entity, World } from '@aethervtt/shard-core'
import { Breach, Floor, Opening, Wall } from './components'

// The breach house (0114): one house for breaching tests, with the openings and spans each one
// needs. It spawns structure components only, so it runs headless.

type Point = [number, number, number]

export interface BreachHouseOptions {
  /** Where its south-west corner stands, (x, z) (default the origin). */
  at?: [number, number]
  /** A back door in the north wall, behind the front door (default false). */
  backDoor?: boolean
  /** A window (sill 0.9 m) in the east wall, into the east room (default false). */
  window?: boolean
  /** A 1.5 m Breach span in the west wall, into the west room (default false). */
  breach?: boolean
  /** A ground floor 20 m past the house on every side (default true). */
  ground?: boolean
}

export interface BreachHouse {
  ground: Entity | null
  front: Entity
  back: Entity
  west: Entity
  east: Entity
  inner: Entity
  /** The 1 m front door, south, into the west room (x 1.5 to 2.5 from the corner). */
  door: Entity
  backDoor: Entity | null
  window: Entity | null
  breach: Entity | null
  /** Room middles, and points 4 m outside the south, east and west walls. */
  westRoom: Point
  eastRoom: Point
  south: Point
  eastSide: Point
  westSide: Point
}

/**
 * A 10 × 6 m house of 0.2 m walls, 3 m tall, split at x = 5 into a west and an east room joined by
 * an open 1 m door. The front door is closed. Options add a back door, a window and a Breach span.
 */
export function breachHouse(world: World, options: BreachHouseOptions = {}): BreachHouse {
  const [x, z] = options.at ?? [0, 0]
  const ground =
    options.ground === false
      ? null
      : world.spawn([
          Floor,
          {
            points: [
              [x - 20, z - 20],
              [x + 30, z - 20],
              [x + 30, z + 26],
              [x - 20, z + 26],
            ],
          },
        ])
  const wall = (a: [number, number], b: [number, number]) =>
    world.spawn([Wall, { a: [x + a[0], z + a[1]], b: [x + b[0], z + b[1]], height: 3 }])
  const front = wall([0, 0], [10, 0])
  const back = wall([10, 6], [0, 6])
  const west = wall([0, 6], [0, 0])
  const east = wall([10, 0], [10, 6])
  const inner = wall([5, 0], [5, 6])
  const opening = (host: Entity, value: Record<string, unknown>) =>
    world.spawn([Opening, { wall: host, ...value }])
  const door = opening(front, { kind: 'door', offset: 1.5, width: 1, height: 2.1 })
  opening(inner, { kind: 'door', offset: 2.5, width: 1, height: 2.1, state: 'open' })
  // The back wall runs east to west: offset 7.5 puts the door at x 1.5 to 2.5, behind the front one.
  const backDoor = options.backDoor
    ? opening(back, { kind: 'door', offset: 7.5, width: 1, height: 2.1 })
    : null
  const window = options.window
    ? opening(east, { kind: 'window', offset: 2.4, width: 1.2, height: 1.2, sill: 0.9 })
    : null
  // The west wall runs north to south: offset 2.25 puts the span at z 3.75 down to 2.25.
  const breach = options.breach
    ? world.spawn([Breach, { wall: west, offset: 2.25, width: 1.5 }])
    : null
  return {
    ground,
    front,
    back,
    west,
    east,
    inner,
    door,
    backDoor,
    window,
    breach,
    westRoom: [x + 2.5, 0, z + 3],
    eastRoom: [x + 7.5, 0, z + 3],
    south: [x + 2, 0, z - 4],
    eastSide: [x + 14, 0, z + 3],
    westSide: [x - 4, 0, z + 3],
  }
}
