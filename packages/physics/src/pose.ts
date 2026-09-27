import { ChildOf, type Entity, type World } from '@aethervtt/shard-core'
import {
  GlobalTransform,
  Grid,
  GridCell,
  GridFramesResource,
  originMatrix64,
  Transform,
} from '@aethervtt/shard-transform'

/**
 * A rigid pose plus scale: translation (0..2), rotation quaternion (3..6), scale (7..9). Poses are
 * composed from Transforms, not read from GlobalTransform, so bodies spawned before the first
 * propagation get the right place.
 */
export type Pose = Float64Array

export const createPose = (): Pose => {
  const p = new Float64Array(10)
  p[6] = 1
  p[7] = 1
  p[8] = 1
  p[9] = 1
  return p
}

export function identityPose(out: Pose): Pose {
  out.fill(0)
  out[6] = 1
  out[7] = out[8] = out[9] = 1
  return out
}

/** Rotates (x, y, z) by quaternion q (offset qo) into out[oo..oo+2]. */
export function rotate(
  out: ArrayLike<number> & { [i: number]: number },
  oo: number,
  q: ArrayLike<number>,
  qo: number,
  x: number,
  y: number,
  z: number,
): void {
  const qx = q[qo]!
  const qy = q[qo + 1]!
  const qz = q[qo + 2]!
  const qw = q[qo + 3]!
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[oo] = x + qw * tx + (qy * tz - qz * ty)
  out[oo + 1] = y + qw * ty + (qz * tx - qx * tz)
  out[oo + 2] = z + qw * tz + (qx * ty - qy * tx)
}

/** out = a * b (quaternions at offsets). `out` may alias either input. */
export function mulQuat(
  out: { [i: number]: number },
  oo: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): void {
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const aw = a[ao + 3]!
  const bx = b[bo]!
  const by = b[bo + 1]!
  const bz = b[bo + 2]!
  const bw = b[bo + 3]!
  out[oo] = aw * bx + ax * bw + ay * bz - az * by
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz
}

const chain: Entity[] = []
const tmp = new Float64Array(4)

/** Applies a local TRS (from Transform columns) under `out` in place: out = out ∘ local. */
function composeLocal(
  out: Pose,
  t: ArrayLike<number>,
  to: number,
  r: ArrayLike<number>,
  ro: number,
  s: ArrayLike<number>,
  so: number,
): void {
  // position = parent.pos + parent.rot * (parent.scale ⊙ local.pos)
  rotate(tmp, 0, out, 3, out[7]! * t[to]!, out[8]! * t[to + 1]!, out[9]! * t[to + 2]!)
  out[0] = out[0]! + tmp[0]!
  out[1] = out[1]! + tmp[1]!
  out[2] = out[2]! + tmp[2]!
  mulQuat(out, 3, out, 3, r, ro)
  out[7] = out[7]! * s[so]!
  out[8] = out[8]! * s[so + 1]!
  out[9] = out[9]! * s[so + 2]!
}

/** The entity's parent, read from the ChildOf column (no allocation). */
export function parentOf(world: World, entity: Entity): Entity | undefined {
  const table = world.entityTableUnchecked(entity)
  if (!table.has(ChildOf)) return undefined
  const p = table.column(ChildOf, 'parent')[world.entityRowUnchecked(entity)]!
  return p >= 0 ? (p as Entity) : undefined
}

/** Whether an entity is a Grid (spec 0040). */
export function isGrid(world: World, entity: Entity): boolean {
  return world.entityTableUnchecked(entity).has(Grid)
}

/**
 * A grid's (or, for no grid, the root frame's) map to the origin frame, where Rapier simulates:
 * `origin = m · ((cell − ref) × cs + p)` for a point `p` in cell `cell`.
 */
interface Frame {
  m: Float64Array
  rx: number
  ry: number
  rz: number
  cs: number
  /** Whether m is exactly the identity (the origin's own grid): no rotation or scale to apply. */
  identity: boolean
}

const frame: Frame = { m: new Float64Array(12), rx: 0, ry: 0, rz: 0, cs: 0, identity: true }
const fq = new Float64Array(4)

/**
 * Reads the frame of `grid` (undefined: the root frame) from the frames transform propagation
 * solved, which is the frame Rapier is in. Before the first propagation (or for a grid it hasn't
 * seen yet), solves it fresh with `originMatrix64` (cold).
 */
function frameOf(world: World, grid: Entity | undefined, out: Frame): void {
  const m = out.m
  const frames = world.tryResource(GridFramesResource)
  const slot = frames?.active ? (grid === undefined ? 0 : frames.slotOf.get(grid)) : undefined
  if (slot !== undefined) {
    const a = frames!.a
    const o = slot * 12
    for (let i = 0; i < 12; i++) m[i] = a[o + i]!
    out.rx = frames!.ref[slot * 3]!
    out.ry = frames!.ref[slot * 3 + 1]!
    out.rz = frames!.ref[slot * 3 + 2]!
    out.cs = slot === 0 ? 0 : frames!.cellSize[slot]!
  } else if (grid === undefined) {
    m.fill(0)
    m[0] = m[5] = m[10] = 1
    out.rx = out.ry = out.rz = out.cs = 0
  } else {
    originMatrix64(world, grid, m)
    out.rx = out.ry = out.rz = 0
    const table = world.entityTableUnchecked(grid)
    out.cs = table.column(Grid, 'cellSize')[world.entityRowUnchecked(grid)]!
  }
  out.identity =
    m[0] === 1 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[4] === 0 &&
    m[5] === 1 &&
    m[6] === 0 &&
    m[8] === 0 &&
    m[9] === 0 &&
    m[10] === 1
}

/** The rotation of a frame's matrix (normalized columns) into fq, and its column lengths. */
function frameRotation(m: Float64Array, scale: Float64Array): void {
  const sx = Math.sqrt(m[0]! * m[0]! + m[4]! * m[4]! + m[8]! * m[8]!) || 1
  const sy = Math.sqrt(m[1]! * m[1]! + m[5]! * m[5]! + m[9]! * m[9]!) || 1
  const sz = Math.sqrt(m[2]! * m[2]! + m[6]! * m[6]! + m[10]! * m[10]!) || 1
  scale[0] = sx
  scale[1] = sy
  scale[2] = sz
  quatFromBasis(
    fq,
    m[0]! / sx,
    m[4]! / sx,
    m[8]! / sx,
    m[1]! / sy,
    m[5]! / sy,
    m[9]! / sy,
    m[2]! / sz,
    m[6]! / sz,
    m[10]! / sz,
  )
}

const frameScale = new Float64Array(3)

/** Maps a pose in cell (kx, ky, kz) of `f` into the origin frame, in place. */
function applyFrame(out: Pose, f: Frame, kx: number, ky: number, kz: number): void {
  const m = f.m
  const px = (kx - f.rx) * f.cs + out[0]!
  const py = (ky - f.ry) * f.cs + out[1]!
  const pz = (kz - f.rz) * f.cs + out[2]!
  out[0] = m[0]! * px + m[1]! * py + m[2]! * pz + m[3]!
  out[1] = m[4]! * px + m[5]! * py + m[6]! * pz + m[7]!
  out[2] = m[8]! * px + m[9]! * py + m[10]! * pz + m[11]!
  if (f.identity) return
  frameRotation(m, frameScale)
  mulQuat(out, 3, fq, 0, out, 3)
  out[7] = out[7]! * frameScale[0]!
  out[8] = out[8]! * frameScale[1]!
  out[9] = out[9]! * frameScale[2]!
}

/**
 * Pose of an entity in the origin frame (where Rapier simulates), from its own and its ancestors'
 * Transforms (up to, not including, `stop` when given: then the pose is relative to `stop`).
 * Ignores shear from non-uniform scale under rotation, like physics shapes do. Under a Grid, the
 * cell and the grid's frame are applied in f64, so the pose is exact however far the grid cell is
 * from the grid's origin.
 */
export function poseOf(world: World, entity: Entity, out: Pose, stop?: Entity): Pose {
  chain.length = 0
  let grid: Entity | undefined
  let e: Entity | undefined = entity
  while (e !== undefined && e !== stop) {
    if (stop === undefined && e !== entity && isGrid(world, e)) {
      grid = e
      break
    }
    chain.push(e)
    e = parentOf(world, e)
  }
  identityPose(out)
  for (let i = chain.length - 1; i >= 0; i--) {
    const ent = chain[i]!
    if (!world.has(ent, Transform)) continue
    const table = world.entityTable(ent)
    const row = world.entityRow(ent)
    composeLocal(
      out,
      table.column(Transform, 'translation'),
      row * 3,
      table.column(Transform, 'rotation'),
      row * 4,
      table.column(Transform, 'scale'),
      row * 3,
    )
  }
  if (stop !== undefined) return out
  if (grid === undefined) {
    // A root: the root frame is the origin frame unless the origin is inside a grid.
    const frames = world.tryResource(GridFramesResource)
    if (frames === undefined || frames.rootIdentity) return out
    frameOf(world, undefined, frame)
    applyFrame(out, frame, 0, 0, 0)
    return out
  }
  // The chain's last entity is the grid's direct child, which holds the cell.
  const top = chain[chain.length - 1]!
  const table = world.entityTableUnchecked(top)
  let kx = 0
  let ky = 0
  let kz = 0
  if (table.has(GridCell)) {
    const cell = table.column(GridCell, 'cell')
    const o = world.entityRowUnchecked(top) * 3
    kx = cell[o]!
    ky = cell[o + 1]!
    kz = cell[o + 2]!
  }
  frameOf(world, grid, frame)
  applyFrame(out, frame, kx, ky, kz)
  return out
}

/**
 * The inverse of a parent's world matrix applied to an origin-frame position and rotation, for
 * writing a body's pose back into its local Transform. Uses the parent's GlobalTransform, except
 * when the parent is a Grid (or there is no parent and the origin is in a grid): then the grid's
 * f64 frame, keeping the translation small by moving `child`'s GridCell when it leaves the cell
 * (the same rule as `transform/recenter`, which then has nothing left to do).
 */
export function worldToLocal(
  world: World,
  parent: Entity | undefined,
  child: Entity,
  pos: ArrayLike<number>,
  rot: ArrayLike<number>,
  outPos: { [i: number]: number },
  po: number,
  outRot: { [i: number]: number },
  ro: number,
): void {
  if (parent === undefined || isGrid(world, parent)) {
    gridToLocal(world, parent, child, pos, rot, outPos, po, outRot, ro)
    return
  }
  const table = world.entityTable(parent)
  if (!table.has(GlobalTransform)) {
    outPos[po] = pos[0]!
    outPos[po + 1] = pos[1]!
    outPos[po + 2] = pos[2]!
    outRot[ro] = rot[0]!
    outRot[ro + 1] = rot[1]!
    outRot[ro + 2] = rot[2]!
    outRot[ro + 3] = rot[3]!
    return
  }
  const m = table.column(GlobalTransform, 'matrix')
  const o = world.entityRow(parent) * 12
  // Rows of the 3x4 matrix: [m0 m1 m2 m3; m4 m5 m6 m7; m8 m9 m10 m11]. Columns are scaled axes.
  const dx = pos[0]! - m[o + 3]!
  const dy = pos[1]! - m[o + 7]!
  const dz = pos[2]! - m[o + 11]!
  // Inverse of the 3x3 part (general, handles scale).
  const a = m[o]!
  const b = m[o + 1]!
  const c = m[o + 2]!
  const d = m[o + 4]!
  const e = m[o + 5]!
  const f = m[o + 6]!
  const g = m[o + 8]!
  const h = m[o + 9]!
  const i = m[o + 10]!
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C || 1
  const inv = 1 / det
  outPos[po] = (A * dx + (c * h - b * i) * dy + (b * f - c * e) * dz) * inv
  outPos[po + 1] = (B * dx + (a * i - c * g) * dy + (c * d - a * f) * dz) * inv
  outPos[po + 2] = (C * dx + (b * g - a * h) * dy + (a * e - b * d) * dz) * inv
  // Parent rotation: normalize the columns and take the quaternion of that basis.
  const sx = Math.sqrt(a * a + d * d + g * g) || 1
  const sy = Math.sqrt(b * b + e * e + h * h) || 1
  const sz = Math.sqrt(c * c + f * f + i * i) || 1
  quatFromBasis(tmp, a / sx, d / sx, g / sx, b / sy, e / sy, h / sy, c / sz, f / sz, i / sz)
  // local = conj(parent) * world
  tmp[0] = -tmp[0]!
  tmp[1] = -tmp[1]!
  tmp[2] = -tmp[2]!
  mulQuat(outRot, ro, tmp, 0, rot, 0)
}

/** worldToLocal for a grid parent (or the root frame), in f64. */
function gridToLocal(
  world: World,
  grid: Entity | undefined,
  child: Entity,
  pos: ArrayLike<number>,
  rot: ArrayLike<number>,
  outPos: { [i: number]: number },
  po: number,
  outRot: { [i: number]: number },
  ro: number,
): void {
  frameOf(world, grid, frame)
  const m = frame.m
  const dx = pos[0]! - m[3]!
  const dy = pos[1]! - m[7]!
  const dz = pos[2]! - m[11]!
  let lx = dx
  let ly = dy
  let lz = dz
  if (!frame.identity) {
    const a = m[0]!
    const b = m[1]!
    const c = m[2]!
    const d = m[4]!
    const e = m[5]!
    const f = m[6]!
    const g = m[8]!
    const h = m[9]!
    const i = m[10]!
    const A = e * i - f * h
    const B = -(d * i - f * g)
    const C = d * h - e * g
    const inv = 1 / (a * A + b * B + c * C || 1)
    lx = (A * dx + (c * h - b * i) * dy + (b * f - c * e) * dz) * inv
    ly = (B * dx + (a * i - c * g) * dy + (c * d - a * f) * dz) * inv
    lz = (C * dx + (b * g - a * h) * dy + (a * e - b * d) * dz) * inv
  }
  const table = world.entityTableUnchecked(child)
  if (grid !== undefined && table.has(GridCell)) {
    const cell = table.column(GridCell, 'cell')
    const row = world.entityRowUnchecked(child)
    const o = row * 3
    const cs = frame.cs
    lx -= (cell[o]! - frame.rx) * cs
    ly -= (cell[o + 1]! - frame.ry) * cs
    lz -= (cell[o + 2]! - frame.rz) * cs
    // Left the cell (past half a cell plus the grid's hysteresis): move to the one it's in.
    const gt = world.entityTableUnchecked(grid)
    const limit = cs / 2 + gt.column(Grid, 'hysteresis')[world.entityRowUnchecked(grid)]!
    if (lx > limit || lx < -limit || ly > limit || ly < -limit || lz > limit || lz < -limit) {
      const jx = lx > limit || lx < -limit ? Math.round(lx / cs) : 0
      const jy = ly > limit || ly < -limit ? Math.round(ly / cs) : 0
      const jz = lz > limit || lz < -limit ? Math.round(lz / cs) : 0
      cell[o] = cell[o]! + jx
      cell[o + 1] = cell[o + 1]! + jy
      cell[o + 2] = cell[o + 2]! + jz
      lx -= jx * cs
      ly -= jy * cs
      lz -= jz * cs
      table.markChanged(GridCell, row)
    }
  } else if (grid !== undefined) {
    const cs = frame.cs
    lx += frame.rx * cs
    ly += frame.ry * cs
    lz += frame.rz * cs
  }
  outPos[po] = lx
  outPos[po + 1] = ly
  outPos[po + 2] = lz
  if (frame.identity) {
    outRot[ro] = rot[0]!
    outRot[ro + 1] = rot[1]!
    outRot[ro + 2] = rot[2]!
    outRot[ro + 3] = rot[3]!
    return
  }
  frameRotation(m, frameScale)
  fq[0] = -fq[0]!
  fq[1] = -fq[1]!
  fq[2] = -fq[2]!
  mulQuat(outRot, ro, fq, 0, rot, 0)
}

/** Quaternion of a rotation matrix given by its columns (x axis, y axis, z axis). */
function quatFromBasis(
  out: Float64Array,
  m00: number,
  m10: number,
  m20: number,
  m01: number,
  m11: number,
  m21: number,
  m02: number,
  m12: number,
  m22: number,
): void {
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    out[3] = 0.25 / s
    out[0] = (m21 - m12) * s
    out[1] = (m02 - m20) * s
    out[2] = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    out[3] = (m21 - m12) / s
    out[0] = 0.25 * s
    out[1] = (m01 + m10) / s
    out[2] = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    out[3] = (m02 - m20) / s
    out[0] = (m01 + m10) / s
    out[1] = 0.25 * s
    out[2] = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    out[3] = (m10 - m01) / s
    out[0] = (m02 + m20) / s
    out[1] = (m12 + m21) / s
    out[2] = 0.25 * s
  }
}
