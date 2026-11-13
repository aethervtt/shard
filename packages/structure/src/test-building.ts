import type { Entity, World } from '@aethervtt/shard-core'
import { Floor, Opening, Wall } from './components'

// Shared by structure's nav tests (0112): a ground floor and a two-room building.

export const OUTSIDE: [number, number, number] = [1.5, 0, -3]
export const BACK_ROOM: [number, number, number] = [6, 0, 3]

export function ground(world: World, x0 = -6, z0 = -6, x1 = 14, z1 = 12): Entity {
  return world.spawn([
    Floor,
    {
      points: [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ],
    },
  ])
}

/**
 * An 8 × 6 m building at the origin, two rooms split at x = 4: a front door into the front room
 * (x ∈ [1, 2] on z = 0), an open door between the rooms, and optionally a side door straight into
 * the back room.
 */
export function building(world: World, side = false) {
  const wall = (a: [number, number], b: [number, number]) => world.spawn([Wall, { a, b }])
  const front = wall([0, 0], [8, 0])
  wall([8, 6], [0, 6])
  wall([0, 6], [0, 0])
  const right = wall([8, 0], [8, 6])
  const inner = wall([4, 0], [4, 6])
  const door = world.spawn([Opening, { wall: front, kind: 'door', offset: 1, width: 1 }])
  world.spawn([Opening, { wall: inner, kind: 'door', offset: 2.5, width: 1, state: 'open' }])
  const sideDoor = side
    ? world.spawn([Opening, { wall: right, kind: 'door', offset: 2.5, width: 1 }])
    : null
  return { door, sideDoor, right }
}
