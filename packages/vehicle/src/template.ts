/**
 * A vehicle captured as plain values (0118), to rebuild it in another world: `vehicle.test` and
 * `shard vehicle test` run maneuvers on a copy in a fresh headless app, so the running world is
 * left alone. Mesh colliders become their hull points.
 */
import { ChildOf, Children, type Entity, type World } from '@aethervtt/shard-core'
import { Collider, Mass, Physics, RigidBody, Velocity } from '@aethervtt/shard-physics'
import { Transform } from '@aethervtt/shard-transform'
import {
  Vehicle,
  VehicleAssists,
  VehicleEngine,
  VehicleInput,
  VehicleSeat,
  VehicleTransmission,
  VehicleWheel,
} from './components'

type Values = Record<string, unknown>

export interface VehicleTemplate {
  mass: Values
  vehicle: Values
  engine?: Values
  transmission?: Values
  assists?: Values
  /** Children in the chassis frame: colliders, wheels and seats. */
  parts: {
    translation: [number, number, number]
    rotation: [number, number, number, number]
    collider?: Values
    wheel?: Values
    seat?: Values
  }[]
}

const copy = <T>(v: T): T => structuredClone(v)

/** Captures a vehicle's settings and parts. Wheel visuals aren't kept. */
export function captureVehicle(world: World, chassis: Entity): VehicleTemplate {
  const template: VehicleTemplate = {
    mass: world.has(chassis, Mass) ? copy(world.get(chassis, Mass)) : { mass: 1500 },
    vehicle: copy(world.get(chassis, Vehicle)),
    parts: [],
  }
  if (world.has(chassis, VehicleEngine)) template.engine = copy(world.get(chassis, VehicleEngine))
  if (world.has(chassis, VehicleTransmission))
    template.transmission = copy(world.get(chassis, VehicleTransmission))
  if (world.has(chassis, VehicleAssists))
    template.assists = copy(world.get(chassis, VehicleAssists))
  const p = world.tryResource(Physics)
  // The chassis' own collider, then descendants (not under another body).
  const visit = (e: Entity, t: [number, number, number], r: [number, number, number, number]) => {
    const part: VehicleTemplate['parts'][number] = { translation: t, rotation: r }
    if (world.has(e, Collider)) {
      const c = copy(world.get(e, Collider)) as Values
      if (c.mesh) {
        // A mesh collider: keep its hull, which Rapier has built already.
        const shape = p?.colliders.get(e)?.shape as { vertices?: Float32Array } | undefined
        const verts = shape?.vertices
        c.mesh = null
        c.points = []
        if (verts)
          for (let i = 0; i + 2 < verts.length; i += 3)
            (c.points as number[][]).push([verts[i]!, verts[i + 1]!, verts[i + 2]!])
        if (c.shape === 'trimesh') c.shape = 'convex'
      }
      part.collider = c
    }
    if (world.has(e, VehicleWheel)) {
      const wv = copy(world.get(e, VehicleWheel)) as Values
      wv.visual = null
      part.wheel = wv
    }
    if (world.has(e, VehicleSeat)) {
      const sv = copy(world.get(e, VehicleSeat)) as Values
      sv.occupant = null
      part.seat = sv
    }
    if (e !== chassis && (part.collider || part.wheel || part.seat)) template.parts.push(part)
    else if (e === chassis && part.collider)
      template.parts.push({ ...part, translation: [0, 0, 0], rotation: [0, 0, 0, 1] })
    for (const k of world.tryGet(e, Children)?.entities ?? []) {
      if (k === null || !world.isAlive(k) || world.has(k, RigidBody)) continue
      const tr = world.get(k, Transform)
      // Compose the child's local pose under the parent's (in the chassis frame).
      const [qx, qy, qz, qw] = r
      const [x, y, z] = tr.translation
      const tx = 2 * (qy * z - qz * y)
      const ty = 2 * (qz * x - qx * z)
      const tz = 2 * (qx * y - qy * x)
      const pt: [number, number, number] = [
        t[0] + x + qw * tx + (qy * tz - qz * ty),
        t[1] + y + qw * ty + (qz * tx - qx * tz),
        t[2] + z + qw * tz + (qx * ty - qy * tx),
      ]
      const [bx, by, bz, bw] = tr.rotation
      const pr: [number, number, number, number] = [
        qw * bx + qx * bw + qy * bz - qz * by,
        qw * by - qx * bz + qy * bw + qz * bx,
        qw * bz + qx * by - qy * bx + qz * bw,
        qw * bw - qx * bx - qy * by - qz * bz,
      ]
      visit(k, pt, pr)
    }
  }
  visit(chassis, [0, 0, 0], [0, 0, 0, 1])
  return template
}

/** Spawns a captured vehicle at `at` facing `yaw` (0: −Z). Returns the chassis. */
export function spawnTemplate(
  world: World,
  template: VehicleTemplate,
  at: [number, number, number],
  yaw = 0,
): Entity {
  const chassis = world.spawn(
    [Transform, { translation: at, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] }],
    [RigidBody, { kind: 'dynamic' }],
    [Velocity, {}],
    [Mass, copy(template.mass)],
    [Vehicle, copy(template.vehicle)],
    [VehicleInput, {}],
  )
  if (template.engine) world.add(chassis, VehicleEngine, copy(template.engine))
  if (template.transmission) world.add(chassis, VehicleTransmission, copy(template.transmission))
  if (template.assists) world.add(chassis, VehicleAssists, copy(template.assists))
  for (const part of template.parts) {
    const e = world.spawn(
      [Transform, { translation: part.translation, rotation: part.rotation }],
      [ChildOf, { parent: chassis }],
    )
    if (part.collider) world.add(e, Collider, copy(part.collider))
    if (part.wheel) world.add(e, VehicleWheel, copy(part.wheel))
    if (part.seat) world.add(e, VehicleSeat, copy(part.seat))
  }
  return chassis
}

/** The lowest wheel bottom below the chassis origin (m): spawn at this height to sit on y = 0. */
export function rideHeight(template: VehicleTemplate): number {
  let h = 0.35
  for (const part of template.parts) {
    if (!part.wheel) continue
    const radius = (part.wheel.radius as number | undefined) ?? 0.33
    h = Math.max(h, radius - part.translation[1]!)
  }
  return h + 0.01
}

/** Component names a template reads from a prefab, and the definitions that parse them. */
const PREFAB_COMPONENTS = {
  mass: Mass,
  vehicle: Vehicle,
  engine: VehicleEngine,
  transmission: VehicleTransmission,
  assists: VehicleAssists,
} as const

/**
 * A template from a vehicle prefab's JSON (`shard vehicle test` reads files this way): the root's
 * vehicle components, and colliders, wheels and seats below it with their poses composed. Values
 * are parsed by their schemas, so defaults fill in. Mesh colliders aren't kept.
 */
export function templateFromPrefab(json: { root: PrefabEntityJson }): VehicleTemplate {
  const root = json.root
  const comps = root.components ?? {}
  const get = (def: { name: string; deserialize(json: unknown): unknown }) =>
    comps[def.name] === undefined ? undefined : (def.deserialize(comps[def.name]) as Values)
  const vehicle = get(PREFAB_COMPONENTS.vehicle)
  if (!vehicle) throw new Error(`The prefab's root has no ${Vehicle.name}`)
  const template: VehicleTemplate = {
    mass: get(PREFAB_COMPONENTS.mass) ?? { mass: 1500 },
    vehicle,
    parts: [],
  }
  const engine = get(PREFAB_COMPONENTS.engine)
  const transmission = get(PREFAB_COMPONENTS.transmission)
  const assists = get(PREFAB_COMPONENTS.assists)
  if (engine) template.engine = engine
  if (transmission) template.transmission = transmission
  if (assists) template.assists = assists
  const visit = (
    e: PrefabEntityJson,
    t: [number, number, number],
    r: [number, number, number, number],
    isRoot: boolean,
  ) => {
    const c = e.components ?? {}
    const tr = (c[Transform.name] ?? {}) as { translation?: number[]; rotation?: number[] }
    const lt = tr.translation ?? [0, 0, 0]
    const lr = tr.rotation ?? [0, 0, 0, 1]
    const [qx, qy, qz, qw] = r
    const [x, y, z] = isRoot ? [0, 0, 0] : (lt as [number, number, number])
    const tx = 2 * (qy * z - qz * y)
    const ty = 2 * (qz * x - qx * z)
    const tz = 2 * (qx * y - qy * x)
    const pt: [number, number, number] = [
      t[0] + x + qw * tx + (qy * tz - qz * ty),
      t[1] + y + qw * ty + (qz * tx - qx * tz),
      t[2] + z + qw * tz + (qx * ty - qy * tx),
    ]
    const [bx, by, bz, bw] = (isRoot ? [0, 0, 0, 1] : lr) as [number, number, number, number]
    const pr: [number, number, number, number] = [
      qw * bx + qx * bw + qy * bz - qz * by,
      qw * by - qx * bz + qy * bw + qz * bx,
      qw * bz + qx * by - qy * bx + qz * bw,
      qw * bw - qx * bx - qy * by - qz * bz,
    ]
    const part: VehicleTemplate['parts'][number] = { translation: pt, rotation: pr }
    if (c[Collider.name] !== undefined) {
      const col = Collider.deserialize(c[Collider.name]) as Values
      if (!col.mesh) part.collider = col
    }
    if (c[VehicleWheel.name] !== undefined) {
      const wv = VehicleWheel.deserialize(c[VehicleWheel.name]) as Values
      wv.visual = null
      part.wheel = wv
    }
    if (c[VehicleSeat.name] !== undefined) {
      const sv = VehicleSeat.deserialize(c[VehicleSeat.name]) as Values
      sv.occupant = null
      part.seat = sv
    }
    if (part.collider || part.wheel || part.seat) template.parts.push(part)
    for (const k of e.children ?? []) visit(k, pt, pr, false)
  }
  visit(root, [0, 0, 0], [0, 0, 0, 1], true)
  return template
}

/** A prefab entity as JSON: components by name, and children. */
export interface PrefabEntityJson {
  name?: string
  components?: Record<string, unknown>
  children?: PrefabEntityJson[]
}
