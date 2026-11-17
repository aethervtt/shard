import {
  defineComponent,
  defineSystem,
  type Entity,
  type Query,
  type Table,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'

/**
 * Names an entity every machine has, so replicated Transforms can be sent relative to it (0126).
 * Each side may spawn its own copy (a raft the sea floats, a generated building); the key is what
 * matches them up, since entity ids differ across machines.
 */
export const Anchor = defineComponent(
  'net/Anchor',
  {
    key: t.string({
      description:
        'The same on every machine, and unique on each: what replicated poses name it by.',
    }),
  },
  {
    description:
      'Names this entity on every machine so replicated Transforms can be sent in its space (0126).',
  },
)

/** Server: replicate this entity's Transform in `parent`'s space (0126). */
export const RelativeTo = defineComponent(
  'net/RelativeTo',
  {
    parent: t.entity({
      description: 'An entity with net/Anchor and a Transform: a platform it stands on, say.',
    }),
  },
  {
    description:
      "Server: clients draw this entity on the parent as they pose it, from its pose in the parent's space (0126).",
  },
)

/** Where an entity is in its anchor's space: net writes it on the server and replicates it. */
export const RelativeTransform = defineComponent(
  'net/RelativeTransform',
  {
    anchor: t.string({ description: "The anchor's key (net/Anchor)." }),
    translation: t.vec3({ unit: 'm', description: "Position in the anchor's space." }),
    rotation: t.quat({ description: "Rotation in the anchor's space." }),
  },
  {
    description:
      "The entity's pose in its anchor's space, from net/RelativeTo; clients compose it with the anchor (0126).",
    serialize: false,
  },
)

/** Seconds a correction takes to fall to 1/e when an entity changes the space it is drawn in. */
export const SETTLE_SECONDS = 0.1

// ---------------------------------------------------------------------------
// Server

interface RelateQueries {
  readonly on: Query
  readonly off: Query
}

const adds: Entity[] = []
const drops: Entity[] = []
const pose = new Float64Array(7)

/**
 * Server, before sending: each entity with RelativeTo gets RelativeTransform, its pose in the
 * parent's space; one whose parent is gone or has no Anchor loses it.
 */
export const relate = defineSystem({
  name: 'net/relate',
  description:
    "Server: writes RelativeTransform, each RelativeTo entity's pose in its parent's space.",
  setup: (world): RelateQueries => ({
    on: world.query({ with: [RelativeTo, Transform] }),
    off: world.query({ with: [RelativeTransform], without: [RelativeTo] }),
  }),
  run(q: RelateQueries, world) {
    adds.length = 0
    drops.length = 0
    const on = q.on.tables
    for (let ti = 0; ti < on.length; ti++) {
      const table = on[ti]!
      const parents = table.column(RelativeTo, 'parent')
      const present = table.has(RelativeTransform)
      for (let row = 0; row < table.count; row++) {
        const parent = parents[row]!
        const key = parent >= 0 ? anchorKey(world, parent) : undefined
        if (key === undefined) {
          if (present) drops.push(table.entities[row]!)
        } else if (present) writeLocal(world, table, row, parent, key)
        else adds.push(table.entities[row]!)
      }
    }
    const off = q.off.tables
    for (let ti = 0; ti < off.length; ti++) {
      const table = off[ti]!
      for (let row = 0; row < table.count; row++) drops.push(table.entities[row]!)
    }
    for (let i = 0; i < drops.length; i++) world.remove(drops[i]!, RelativeTransform)
    for (let i = 0; i < adds.length; i++) {
      const e = adds[i]!
      world.add(e, RelativeTransform)
      const parent = world.entityTable(e).column(RelativeTo, 'parent')[world.entityRow(e)]!
      writeLocal(world, world.entityTable(e), world.entityRow(e), parent, anchorKey(world, parent)!)
    }
  },
})

/** The parent's anchor key, if it is alive, has one, and has a Transform. */
function anchorKey(world: World, parent: Entity): string | undefined {
  if (!world.isAlive(parent)) return undefined
  const table = world.entityTable(parent)
  if (!table.has(Anchor) || !table.has(Transform)) return undefined
  return table.column(Anchor, 'key')[world.entityRow(parent)] || undefined
}

/** Writes the row's pose in the parent's space into its RelativeTransform, marking it if changed. */
function writeLocal(world: World, table: Table, row: number, parent: Entity, key: string): void {
  const pt = world.entityTable(parent)
  const prow = world.entityRow(parent)
  readPose(pt, prow, scratchA)
  readPose(table, row, pose)
  toLocal(scratchA, pose, pose)
  const anchors = table.column(RelativeTransform, 'anchor')
  const tr = table.column(RelativeTransform, 'translation')
  const rot = table.column(RelativeTransform, 'rotation')
  let changed = anchors[row] !== key
  anchors[row] = key
  for (let i = 0; i < 3; i++) {
    const v = Math.fround(pose[i]!)
    if (tr[row * 3 + i] !== v) changed = true
    tr[row * 3 + i] = v
  }
  for (let i = 0; i < 4; i++) {
    const v = Math.fround(pose[3 + i]!)
    if (rot[row * 4 + i] !== v) changed = true
    rot[row * 4 + i] = v
  }
  if (changed) table.markChanged(RelativeTransform, row)
}

// ---------------------------------------------------------------------------
// Client

/** One entity drawn on an anchor, or easing back from one. */
class Riding {
  /** The anchor it is drawn on, or -1 while drawn in world space. */
  anchor: Entity = -1
  /** Its last pose in the anchor's space: translation, then rotation. */
  readonly local = new Float64Array(7)
  /** What is added to the pose it should have: a translation, then a rotation (applied first). */
  readonly offset = Float64Array.of(0, 0, 0, 0, 0, 0, 1)
  /** What it was drawn at last. */
  readonly drawn = new Float64Array(7)
  /** The frame it was last on an anchor. */
  seen = -1
}

const scratchA = new Float64Array(7)
const scratchB = new Float64Array(7)
const scratchC = new Float64Array(7)
const local = new Float64Array(7)

/**
 * Client: draws entities with RelativeTransform on their anchor as this client poses it (0126).
 * A change of anchor, or of world space for an anchor, is absorbed by an offset that eases out.
 */
export class RelativeComposer {
  private readonly world: World
  private readonly skip: (entity: Entity) => boolean
  private readonly riding = new Map<Entity, Riding>()
  private readonly anchors = new Map<string, Entity>()
  private readonly relatives: Query
  private readonly anchorQuery: Query
  private scanned = -1
  private frame = 0
  private decay = 1

  /** `skip`: entities this client simulates itself, which keep their own Transform. */
  constructor(world: World, skip: (entity: Entity) => boolean) {
    this.world = world
    this.skip = skip
    this.relatives = world.query({ with: [RelativeTransform, Transform] })
    this.anchorQuery = world.query({ with: [Anchor, Transform] })
  }

  /** PreUpdate, after interpolation: composes, starts and eases corrections. */
  compose(): void {
    const world = this.world
    const time = world.resource(Time)
    this.frame = time.frame
    this.decay = Math.exp(-time.delta / SETTLE_SECONDS)
    const tables = this.relatives.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const keys = table.column(RelativeTransform, 'anchor')
      for (let row = 0; row < table.count; row++) {
        const e = table.entities[row]!
        if (this.skip(e)) continue
        const anchor = this.resolve(keys[row])
        if (anchor === undefined) continue
        let riding = this.riding.get(e)
        if (!riding) {
          riding = new Riding()
          this.riding.set(e, riding)
        }
        readLocal(table, row, local)
        const at = world.entityTable(anchor)
        readPose(at, world.entityRow(anchor), scratchA)
        toWorld(scratchA, local, scratchB)
        if (riding.anchor === -1) {
          // Was drawn in world space: start from there.
          readPose(table, row, scratchA)
          difference(scratchA, scratchB, riding.offset)
        } else if (riding.anchor !== anchor) {
          this.previous(riding, scratchA)
          difference(scratchA, scratchB, riding.offset)
        } else ease(riding.offset, this.decay)
        riding.local.set(local)
        riding.anchor = anchor
        riding.seen = this.frame
        apply(riding.offset, scratchB, riding.drawn)
        writePose(table, row, riding.drawn)
      }
    }
    this.riding.forEach(this.release)
  }

  /** PostUpdate, before propagation: composes again with where the anchors are now. */
  recompose(): void {
    this.riding.forEach(this.again)
  }

  /** Entities no longer on an anchor this frame: their correction eases out in world space. */
  private readonly release = (riding: Riding, e: Entity): void => {
    if (riding.seen === this.frame) return
    const world = this.world
    if (!world.isAlive(e) || !world.has(e, Transform)) {
      this.riding.delete(e)
      return
    }
    const table = world.entityTable(e)
    const row = world.entityRow(e)
    readPose(table, row, scratchB)
    if (riding.anchor !== -1) {
      this.previous(riding, scratchA)
      difference(scratchA, scratchB, riding.offset)
      riding.anchor = -1
    } else ease(riding.offset, this.decay)
    if (settled(riding.offset)) {
      this.riding.delete(e)
      return
    }
    apply(riding.offset, scratchB, riding.drawn)
    writePose(table, row, riding.drawn)
  }

  private readonly again = (riding: Riding, e: Entity): void => {
    if (riding.seen !== this.frame || riding.anchor === -1) return
    const world = this.world
    if (!world.isAlive(riding.anchor) || !world.isAlive(e)) return
    readPose(world.entityTable(riding.anchor), world.entityRow(riding.anchor), scratchA)
    toWorld(scratchA, riding.local, scratchB)
    apply(riding.offset, scratchB, riding.drawn)
    writePose(world.entityTable(e), world.entityRow(e), riding.drawn)
  }

  /** Where the entity would be drawn this frame on its old anchor, or where it was drawn last. */
  private previous(riding: Riding, out: Float64Array): void {
    const world = this.world
    const anchor = riding.anchor
    if (world.isAlive(anchor) && world.has(anchor, Transform)) {
      readPose(world.entityTable(anchor), world.entityRow(anchor), scratchC)
      toWorld(scratchC, riding.local, out)
      apply(riding.offset, out, out)
    } else out.set(riding.drawn)
  }

  /** The entity with this anchor key here, rescanning at most once a frame. */
  private resolve(key: string | undefined): Entity | undefined {
    if (!key) return undefined
    let e = this.anchors.get(key)
    if (e !== undefined && this.valid(e, key)) return e
    if (this.scanned === this.frame) return undefined
    this.scanned = this.frame
    this.anchors.clear()
    const tables = this.anchorQuery.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const keys = table.column(Anchor, 'key')
      for (let row = 0; row < table.count; row++) {
        const k = keys[row]
        if (k) this.anchors.set(k, table.entities[row]!)
      }
    }
    e = this.anchors.get(key)
    return e !== undefined && this.valid(e, key) ? e : undefined
  }

  private valid(e: Entity, key: string): boolean {
    const world = this.world
    if (!world.isAlive(e)) return false
    const table = world.entityTable(e)
    return (
      table.has(Anchor) &&
      table.has(Transform) &&
      table.column(Anchor, 'key')[world.entityRow(e)] === key
    )
  }
}

// ---------------------------------------------------------------------------
// Poses: translation (3) then rotation (x, y, z, w), in Float64Arrays.

function readPose(table: Table, row: number, out: Float64Array): void {
  const tr = table.column(Transform, 'translation')
  const rot = table.column(Transform, 'rotation')
  for (let i = 0; i < 3; i++) out[i] = tr[row * 3 + i]!
  for (let i = 0; i < 4; i++) out[3 + i] = rot[row * 4 + i]!
}

function readLocal(table: Table, row: number, out: Float64Array): void {
  const tr = table.column(RelativeTransform, 'translation')
  const rot = table.column(RelativeTransform, 'rotation')
  for (let i = 0; i < 3; i++) out[i] = tr[row * 3 + i]!
  for (let i = 0; i < 4; i++) out[3 + i] = rot[row * 4 + i]!
}

function writePose(table: Table, row: number, pose: Float64Array): void {
  const tr = table.column(Transform, 'translation')
  const rot = table.column(Transform, 'rotation')
  for (let i = 0; i < 3; i++) tr[row * 3 + i] = pose[i]!
  for (let i = 0; i < 4; i++) rot[row * 4 + i] = pose[3 + i]!
  table.markChanged(Transform, row)
}

/** out = parent × local. `out` may not alias `parent`. */
function toWorld(parent: Float64Array, local: Float64Array, out: Float64Array): void {
  const qx = parent[3]!
  const qy = parent[4]!
  const qz = parent[5]!
  const qw = parent[6]!
  const lx = local[0]!
  const ly = local[1]!
  const lz = local[2]!
  // v + 2w(q × v) + 2 q × (q × v)
  const cx = qy * lz - qz * ly
  const cy = qz * lx - qx * lz
  const cz = qx * ly - qy * lx
  out[0] = parent[0]! + lx + 2 * (qw * cx + qy * cz - qz * cy)
  out[1] = parent[1]! + ly + 2 * (qw * cy + qz * cx - qx * cz)
  out[2] = parent[2]! + lz + 2 * (qw * cz + qx * cy - qy * cx)
  mulQuat(qx, qy, qz, qw, local[3]!, local[4]!, local[5]!, local[6]!, out)
}

/** out = parent⁻¹ × child. `out` may alias `child`. */
function toLocal(parent: Float64Array, child: Float64Array, out: Float64Array): void {
  const qx = -parent[3]!
  const qy = -parent[4]!
  const qz = -parent[5]!
  const qw = parent[6]!
  const dx = child[0]! - parent[0]!
  const dy = child[1]! - parent[1]!
  const dz = child[2]! - parent[2]!
  const rx = child[3]!
  const ry = child[4]!
  const rz = child[5]!
  const rw = child[6]!
  const cx = qy * dz - qz * dy
  const cy = qz * dx - qx * dz
  const cz = qx * dy - qy * dx
  out[0] = dx + 2 * (qw * cx + qy * cz - qz * cy)
  out[1] = dy + 2 * (qw * cy + qz * cx - qx * cz)
  out[2] = dz + 2 * (qw * cz + qx * cy - qy * cx)
  mulQuat(qx, qy, qz, qw, rx, ry, rz, rw, out)
}

/** out[3..7] = a × b, normalized. */
function mulQuat(
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
  out: Float64Array,
): void {
  const x = aw * bx + ax * bw + ay * bz - az * by
  const y = aw * by - ax * bz + ay * bw + az * bx
  const z = aw * bz + ax * by - ay * bx + az * bw
  const w = aw * bw - ax * bx - ay * by - az * bz
  const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1
  out[3] = x / len
  out[4] = y / len
  out[5] = z / len
  out[6] = w / len
}

/** The offset that takes `to` to `from`: translation from − to, rotation from × to⁻¹. */
function difference(from: Float64Array, to: Float64Array, out: Float64Array): void {
  out[0] = from[0]! - to[0]!
  out[1] = from[1]! - to[1]!
  out[2] = from[2]! - to[2]!
  mulQuat(from[3]!, from[4]!, from[5]!, from[6]!, -to[3]!, -to[4]!, -to[5]!, to[6]!, out)
}

/** out = pose with the offset applied. */
function apply(offset: Float64Array, pose: Float64Array, out: Float64Array): void {
  out[0] = pose[0]! + offset[0]!
  out[1] = pose[1]! + offset[1]!
  out[2] = pose[2]! + offset[2]!
  mulQuat(
    offset[3]!,
    offset[4]!,
    offset[5]!,
    offset[6]!,
    pose[3]!,
    pose[4]!,
    pose[5]!,
    pose[6]!,
    out,
  )
}

/** Shrinks an offset toward none by `k` (translation scaled, rotation nlerped from identity). */
function ease(offset: Float64Array, k: number): void {
  offset[0] = offset[0]! * k
  offset[1] = offset[1]! * k
  offset[2] = offset[2]! * k
  const sign = offset[6]! < 0 ? -1 : 1
  mulQuat(
    offset[3]! * sign * k,
    offset[4]! * sign * k,
    offset[5]! * sign * k,
    offset[6]! * sign * k + (1 - k),
    0,
    0,
    0,
    1,
    offset,
  )
}

/** Whether an offset is too small to see (0.01 mm, and about 0.001°): it then stops. */
function settled(offset: Float64Array): boolean {
  const d = offset[0]! * offset[0]! + offset[1]! * offset[1]! + offset[2]! * offset[2]!
  return d < 1e-10 && Math.abs(offset[6]!) > 1 - 1e-10
}
