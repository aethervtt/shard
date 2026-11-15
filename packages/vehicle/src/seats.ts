import { ChildOf, type Entity, ShardError, type World } from '@aethervtt/shard-core'
import {
  CharacterController,
  CharacterSuspended,
  Physics,
  type PhysicsWorld,
  type QueryShape,
} from '@aethervtt/shard-physics'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { Vehicle, VehicleSeat, VehicleSeatEvent } from './components'

/** The vehicle a seat (or any descendant) belongs to. */
export function vehicleOf(world: World, entity: Entity): Entity | undefined {
  let node: Entity | null | undefined = entity
  while (node !== null && node !== undefined && world.isAlive(node)) {
    if (world.has(node, Vehicle)) return node
    node = world.tryGet(node, ChildOf)?.parent
  }
  return undefined
}

/** The seat a character sits in, if any. */
export function seatOf(world: World, character: Entity): Entity | undefined {
  const parent = world.tryGet(character, ChildOf)?.parent
  if (parent === null || parent === undefined || !world.has(parent, VehicleSeat)) return undefined
  return world.get(parent, VehicleSeat).occupant === character ? parent : undefined
}

/**
 * Seats a character (0118): its controller stops moving it (CharacterSuspended), it's parented to
 * the seat at the seat's origin, and the seat records it. Throws `vehicle/seat-taken`.
 */
export function enterVehicle(world: World, character: Entity, seat: Entity): void {
  const s = world.get(seat, VehicleSeat)
  if (s.occupant !== null && s.occupant !== character && world.isAlive(s.occupant)) {
    throw new ShardError('vehicle/seat-taken', `Seat ${seat} is taken by ${s.occupant}`, {
      hint: 'Pick another VehicleSeat, or exitVehicle the occupant first.',
    })
  }
  if (world.has(character, CharacterController) && !world.has(character, CharacterSuspended))
    world.add(character, CharacterSuspended)
  world.add(character, ChildOf, { parent: seat })
  world.set(character, Transform, { translation: [0, 0, 0], rotation: [0, 0, 0, 1] })
  world.set(seat, VehicleSeat, { occupant: character })
  const vehicle = vehicleOf(world, seat)
  if (vehicle !== undefined)
    world.send(VehicleSeatEvent, { vehicle, seat, character, kind: 'entered' })
}

const capsule: QueryShape = { shape: 'capsule', radius: 0.35, halfHeight: 0.55 }
const spot = new Float64Array(3)

/**
 * Takes a character out of its seat (0118) to the first clear spot: the seat's `exit`, its mirror
 * across the vehicle, then the roof. Returns where it went, or undefined when every spot is
 * blocked (it stays seated).
 */
export function exitVehicle(world: World, character: Entity): [number, number, number] | undefined {
  const seat = seatOf(world, character)
  if (seat === undefined) return undefined
  const vehicle = vehicleOf(world, seat)
  const exit = world.get(seat, VehicleSeat).exit
  const g = world.get(seat, GlobalTransform).matrix
  const p = world.tryResource(Physics)
  const controller = world.tryGet(character, CharacterController)
  if (controller) {
    capsule.radius = controller.radius
    capsule.halfHeight = Math.max(0, controller.height / 2 - controller.radius)
  }
  const half = controller ? controller.height / 2 : 0.9
  const candidates: [number, number, number][] = [
    [exit[0], exit[1], exit[2]],
    [-exit[0], exit[1], exit[2]],
  ]
  let found: [number, number, number] | undefined
  for (const local of candidates) {
    spot[0] = g[0]! * local[0] + g[1]! * local[1] + g[2]! * local[2] + g[3]!
    spot[1] = g[4]! * local[0] + g[5]! * local[1] + g[6]! * local[2] + g[7]! + half
    spot[2] = g[8]! * local[0] + g[9]! * local[1] + g[10]! * local[2] + g[11]!
    if (!p || clear(p, character)) {
      found = [spot[0]!, spot[1]!, spot[2]!]
      break
    }
  }
  if (!found && vehicle !== undefined) {
    // The roof: above the chassis' highest point we know (its origin plus 2.5 m).
    const v = world.get(vehicle, GlobalTransform).matrix
    spot[0] = v[3]!
    spot[1] = v[7]! + 2.5
    spot[2] = v[11]!
    if (!p || clear(p, character)) found = [spot[0]!, spot[1]!, spot[2]!]
  }
  if (!found) return undefined
  world.remove(character, ChildOf)
  world.set(character, Transform, { translation: found, rotation: [0, 0, 0, 1] })
  if (world.has(character, CharacterSuspended)) world.remove(character, CharacterSuspended)
  world.set(seat, VehicleSeat, { occupant: null })
  if (vehicle !== undefined)
    world.send(VehicleSeatEvent, { vehicle, seat, character, kind: 'exited' })
  return found
}

const identity = [0, 0, 0, 1]

/** Whether the capsule at `spot` overlaps nothing but the character itself. */
function clear(p: PhysicsWorld, character: Entity): boolean {
  let blocked = false
  p.overlapShape(capsule, spot, identity, { exclude: character }, (e: Entity) => {
    if ((p.colliderOwner.get(e) ?? e) === character) return true
    blocked = true
    return false
  })
  return !blocked
}
