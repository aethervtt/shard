/**
 * `shard vehicle gen` (0118): a vehicle prefab from a car model's nodes. Wheels are found by name
 * (wheel, tire, tyre), else as the lowest round meshes; their bounds give radius and width; axles
 * group them front (−Z) to back; a box above the axles stands in for the body; the class gives
 * mass, center of mass, engine, gears and suspension.
 */
import { type JsonObject, ShardError } from '@aethervtt/shard-core'
import { VEHICLE_CLASS_VALUES, type VehicleClass } from './classes'
import { checkGears } from './sim'
import { tirePreset } from './tire'

/** A model node and the bounds of its meshes and its descendants', in the model's frame. */
export interface ModelNode {
  /** Node name (unique enough to find it again under the instance). */
  name: string
  /** The node's path from the model root, `Body/wheel_fl`. */
  path: string
  /** Index of the parent in the list, or −1. */
  parent: number
  /** Bounds of its own meshes (undefined: none). */
  min?: [number, number, number]
  max?: [number, number, number]
}

export interface GenerateVehicleOptions {
  class?: VehicleClass
  /** The model asset, for the prefab's SceneInstance (`assets/car.glb`). */
  model: string
  /** Which way the model faces (default −Z, Shard's forward). */
  facing?: '-z' | '+z'
}

export interface FoundWheel {
  name: string
  center: [number, number, number]
  radius: number
  width: number
  axle: number
  side: 'left' | 'right' | 'center'
}

const WHEEL = /(wheel|tire|tyre)/i
const NOT_WHEEL = /(steer|spare|well|arch|house|cover|guard|fender)/i

interface Box {
  min: [number, number, number]
  max: [number, number, number]
}

function union(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a) return b && { min: [...b.min], max: [...b.max] }
  if (!b) return a
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}

/** Each node's bounds with its descendants'. */
function subtreeBounds(nodes: ModelNode[]): (Box | undefined)[] {
  const out: (Box | undefined)[] = nodes.map((n) =>
    n.min && n.max ? { min: [...n.min], max: [...n.max] } : undefined,
  )
  // Children come after parents in a depth-first list; fold from the end.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const p = nodes[i]!.parent
    if (p >= 0) out[p] = union(out[p], out[i])
  }
  return out
}

/** Finds the wheels: named nodes (outermost), else round, low meshes. */
export function findWheels(nodes: ModelNode[], facing: '-z' | '+z' = '-z'): FoundWheel[] {
  const bounds = subtreeBounds(nodes)
  const all = bounds.reduce<Box | undefined>((a, b) => union(a, b), undefined)
  if (!all) return []
  const lowest = all.min[1]
  const round = (b: Box) => {
    const sy = b.max[1] - b.min[1]
    const sz = b.max[2] - b.min[2]
    const sx = b.max[0] - b.min[0]
    return Math.abs(sy - sz) < 0.2 * Math.max(sy, sz) && sx < 0.85 * sy && sy > 0.25 && sy < 2
  }
  const named: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (!WHEEL.test(n.name) || NOT_WHEEL.test(n.name) || !bounds[i]) continue
    // Outermost only: a wheel group, not its tire and rim separately.
    let p = n.parent
    let inside = false
    while (p >= 0) {
      if (named.includes(p)) inside = true
      p = nodes[p]!.parent
    }
    if (!inside) named.push(i)
  }
  let picks = named.filter((i) => round(bounds[i]!))
  if (picks.length < 2) {
    picks = []
    for (let i = 0; i < nodes.length; i++) {
      const b = bounds[i]
      if (!nodes[i]!.min || !b || !round(b)) continue
      if (b.min[1] - lowest > 0.08) continue
      picks.push(i)
    }
  }
  // One per place: merge picks whose centers coincide (a tire and its rim).
  const wheels: FoundWheel[] = []
  for (const i of picks) {
    const b = bounds[i]!
    const center: [number, number, number] = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ]
    const radius = Math.max(b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2
    const width = b.max[0] - b.min[0]
    const same = wheels.find(
      (w) => Math.hypot(w.center[0] - center[0], w.center[2] - center[2]) < radius * 0.5,
    )
    if (same) {
      if (radius > same.radius) Object.assign(same, { radius, width, name: nodes[i]!.name })
      continue
    }
    wheels.push({ name: nodes[i]!.name, center, radius, width, axle: 0, side: 'center' })
  }
  // Axles front to back: forward is −Z (or +Z when the model faces it).
  const front = (w: FoundWheel) => (facing === '-z' ? w.center[2] : -w.center[2])
  wheels.sort((a, b) => front(a) - front(b) || a.center[0] - b.center[0])
  let axle = 0
  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i]!
    if (i > 0 && front(w) - front(wheels[i - 1]!) > w.radius) axle++
    w.axle = axle
    const x = facing === '-z' ? w.center[0] : -w.center[0]
    w.side = x < -0.05 ? 'left' : x > 0.05 ? 'right' : 'center'
  }
  return wheels
}

const round3 = (v: number) => Math.round(v * 1000) / 1000
const r3 = (v: readonly number[]) => v.map(round3)

/**
 * A vehicle prefab (`*.prefab.json`) for a model: chassis with Mass, Vehicle, engine, gearbox and
 * sim assists; the model as a SceneInstance; a body box; wheels at the model's wheels (their
 * visuals by node name); a driver seat. Throws `vehicle/no-wheels` with fewer than two.
 */
export function generateVehicle(nodes: ModelNode[], options: GenerateVehicleOptions): JsonObject {
  const cls = options.class ?? 'sedan'
  const c = VEHICLE_CLASS_VALUES[cls]
  const facing = options.facing ?? '-z'
  const wheels = findWheels(nodes, facing)
  if (wheels.length < 2) {
    throw new ShardError(
      'vehicle/no-wheels',
      `Found ${wheels.length} wheel${wheels.length === 1 ? '' : 's'} in ${options.model}`,
      {
        hint: 'Name wheel nodes wheel_fl, wheel_fr… (or tire_*), or keep them as separate round meshes at the bottom of the model.',
      },
    )
  }
  const axles = 1 + Math.max(...wheels.map((w) => w.axle))
  const axleY = wheels.reduce((s, w) => s + w.center[1], 0) / wheels.length
  const zs = wheels.map((w) => w.center[2])
  const midZ = (Math.min(...zs) + Math.max(...zs)) / 2
  // Body: everything that isn't a wheel, from the axles up.
  const wheelNames = new Set(wheels.map((w) => w.name))
  let body: Box | undefined
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (!n.min || !n.max || wheelNames.has(n.name)) continue
    // Skip meshes under a wheel node too.
    let p = n.parent
    let underWheel = false
    while (p >= 0) {
      if (wheelNames.has(nodes[p]!.name)) underWheel = true
      p = nodes[p]!.parent
    }
    if (!underWheel) body = union(body, { min: n.min, max: n.max })
  }
  const yaw: [number, number, number, number] = facing === '-z' ? [0, 0, 0, 1] : [0, 1, 0, 0]
  const children: JsonObject[] = [
    {
      name: 'model',
      components: {
        'core/Transform': { rotation: yaw },
        'scene/SceneInstance': { scene: { path: `${options.model}#Scene` } },
      },
    },
  ]
  if (body) {
    const bottom = Math.max(body.min[1], axleY + 0.02)
    const top = Math.max(bottom + 0.2, body.max[1])
    const half = [
      ((body.max[0] - body.min[0]) / 2) * 0.97,
      (top - bottom) / 2,
      ((body.max[2] - body.min[2]) / 2) * 0.97,
    ]
    const center = [
      (body.min[0] + body.max[0]) / 2,
      (bottom + top) / 2,
      (body.min[2] + body.max[2]) / 2,
    ]
    children.push({
      name: 'body',
      components: {
        'core/Transform': { translation: r3(flip(center, facing)) },
        'physics/Collider': { shape: 'cuboid', halfExtents: r3(half), ignoreCharacters: true },
      },
    })
  }
  const axleValues = []
  for (let a = 0; a < axles; a++) {
    const v = structuredClone(a === 0 ? c.axles[0] : c.axles[1])
    // Extra rear axles share the rear's drive.
    if (a > 0 && axles > 2 && v.drive > 0) v.drive = c.axles[1].drive / (axles - 1)
    axleValues.push(v)
  }
  for (const w of wheels) {
    children.push({
      name: `wheel.${w.axle}.${w.side}`,
      components: {
        'core/Transform': { translation: r3(flip(w.center, facing)) },
        'vehicle/VehicleWheel': {
          axle: w.axle,
          side: w.side,
          radius: round3(w.radius),
          width: round3(Math.max(0.05, w.width)),
          mass: c.wheelMass,
          tire: { path: tirePreset(c.tire).path! },
          frequency: c.frequency,
          damping: c.damping,
          travel: c.travel,
          visualName: w.name,
        },
      },
    })
  }
  const track = Math.max(...wheels.map((w) => Math.abs(w.center[0]))) * 2 || c.track
  const seatZ = facing === '-z' ? midZ - 0.1 : -(midZ - 0.1)
  children.push({
    name: 'seat.driver',
    components: {
      'core/Transform': { translation: r3([-track / 4, axleY + c.bodyY - 0.05, seatZ]) },
      'vehicle/VehicleSeat': { role: 'driver', exit: r3([-track / 2 - 0.7, -c.bodyY + 0.1, 0]) },
    },
  })
  const bad = checkGears(c.gearbox.gears, c.gearbox.upshift, c.gearbox.downshift)
  if (bad) throw new ShardError('vehicle/bad-gears', bad)
  const name = options.model.slice(options.model.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  return {
    $schema: '../.shard/schemas/prefab.schema.json',
    version: 1,
    root: {
      name,
      components: {
        'physics/RigidBody': { kind: 'dynamic' },
        'physics/Velocity': {},
        'physics/Mass': {
          mass: c.mass,
          center: 'authored',
          centerOfMass: r3([0, axleY + c.comHeight, facing === '-z' ? midZ : -midZ]),
          inertiaScale: [1, 1, 1],
        },
        'vehicle/Vehicle': {
          axles: axleValues,
          centerDiff: c.centerDiff,
          aeroDrag: c.aeroDrag,
          steer: {
            maxAngle: c.maxSteer,
            ackermann: 1,
            speed: 180,
            returnSpeed: 360,
            atSpeed: [
              [0, 1],
              [30, 0.35],
            ],
          },
        },
        'vehicle/VehicleEngine': { ...c.engine },
        'vehicle/VehicleTransmission': { ...c.gearbox },
        'vehicle/VehicleAssists': { preset: 'sim' },
        'vehicle/VehicleInput': {},
      },
      children,
    },
  } as unknown as JsonObject
}

function flip(v: readonly number[], facing: '-z' | '+z'): number[] {
  return facing === '-z' ? [...v] : [-v[0]!, v[1]!, -v[2]!]
}

/** The bits of glTF JSON gen reads. */
export interface GltfJson {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: {
    name?: string
    children?: number[]
    mesh?: number
    translation?: number[]
    rotation?: number[]
    scale?: number[]
    matrix?: number[]
  }[]
  meshes?: { primitives: { attributes: Record<string, number> }[] }[]
  accessors?: { min?: number[]; max?: number[] }[]
}

type M = number[]

function compose(a: M, b: M): M {
  // Column-major 4×4 a·b.
  const o = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!
      o[c * 4 + r] = s
    }
  return o
}

function trs(n: NonNullable<GltfJson['nodes']>[number]): M {
  if (n.matrix) return [...n.matrix]
  const [tx, ty, tz] = n.translation ?? [0, 0, 0]
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = n.scale ?? [1, 1, 1]
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ]
}

/**
 * A glTF's nodes with model-space bounds, from the accessors' POSITION min and max (glTF requires
 * them), depth first from the default scene. No geometry is decoded.
 */
export function modelNodesFromGltf(json: GltfJson): ModelNode[] {
  const nodes = json.nodes ?? []
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i)
  const out: ModelNode[] = []
  const visit = (index: number, parent: number, parentMatrix: M, parentPath: string) => {
    const n = nodes[index]
    if (!n) return
    const name = n.name ?? `node${index}`
    const path = parentPath ? `${parentPath}/${name}` : name
    const matrix = compose(parentMatrix, trs(n))
    const node: ModelNode = { name, path, parent }
    if (n.mesh !== undefined) {
      let box: Box | undefined
      for (const prim of json.meshes?.[n.mesh]?.primitives ?? []) {
        const acc = json.accessors?.[prim.attributes.POSITION!]
        if (!acc?.min || !acc.max) continue
        for (let corner = 0; corner < 8; corner++) {
          const lx = corner & 1 ? acc.max[0]! : acc.min[0]!
          const ly = corner & 2 ? acc.max[1]! : acc.min[1]!
          const lz = corner & 4 ? acc.max[2]! : acc.min[2]!
          const p: [number, number, number] = [
            matrix[0]! * lx + matrix[4]! * ly + matrix[8]! * lz + matrix[12]!,
            matrix[1]! * lx + matrix[5]! * ly + matrix[9]! * lz + matrix[13]!,
            matrix[2]! * lx + matrix[6]! * ly + matrix[10]! * lz + matrix[14]!,
          ]
          box = union(box, { min: p, max: p })
        }
      }
      if (box) {
        node.min = box.min
        node.max = box.max
      }
    }
    const self = out.length
    out.push(node)
    for (const child of n.children ?? []) visit(child, self, matrix, path)
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  for (const r of roots) visit(r, -1, identity, '')
  return out
}
