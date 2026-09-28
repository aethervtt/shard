// The render-facing parts of physics (0053): the collider overlay and collider mesh lookup. The
// plugin imports this module; the simulation (`world.ts`) and tracks don't.

import type { AssetRef, World } from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import { defineOverlay, type GizmoStore, Meshes } from '@aethervtt/shard-render'
import { CharacterState } from './components'
import { rotate } from './pose'
import { Physics, type PhysicsWorld } from './world'

const KIND_DYNAMIC = 0
const KIND_FIXED = 1

/** Collider meshes from the renderer's mesh store. */
export function rendererMeshes(world: World, ref: AssetRef): Mesh | undefined {
  return world.tryResource(Meshes)?.get(ref)
}

const COLORS = [
  [1, 0.55, 0.2, 1], // dynamic
  [0.55, 0.55, 0.6, 1], // fixed
  [0.3, 0.8, 1, 1], // kinematic
  [0.3, 0.8, 1, 1],
]
const SLEEPING = [0.5, 0.35, 0.2, 1]
const SENSOR = [0.3, 1, 0.4, 1]
const CONTACT = [1, 0.2, 0.3, 1]
const UP = [1, 0.9, 0.2, 1]
const pa = new Float64Array(3)
const pb = new Float64Array(3)
const q = new Float64Array(4)
const center = new Float64Array(3)

export const collidersOverlay = defineOverlay({
  name: 'colliders',
  description:
    'Physics collider outlines, colored by body kind (sleeping dimmed, sensors green, characters cyan with their up in yellow), and contact normals.',
  draw(world, g, passes) {
    const p = world.tryResource(Physics)
    if (!p) return
    for (const [entity, collider] of p.colliders) {
      if (!passes(entity)) continue
      const owner = p.colliderOwner.get(entity)
      const record = owner === undefined ? undefined : p.bodies.get(owner)
      const color = collider.isSensor()
        ? SENSOR
        : record?.body.isSleeping()
          ? SLEEPING
          : COLORS[record?.kind ?? KIND_FIXED]!
      const t = collider.translation(p.v3 as never)
      center[0] = t.x
      center[1] = t.y
      center[2] = p.dim === 3 ? (t as { z: number }).z : 0
      if (p.dim === 3) {
        const r = collider.rotation(p.q4 as never) as { x: number; y: number; z: number; w: number }
        q[0] = r.x
        q[1] = r.y
        q[2] = r.z
        q[3] = r.w
      } else {
        const angle = collider.rotation() as unknown as number
        q[0] = 0
        q[1] = 0
        q[2] = Math.sin(angle / 2)
        q[3] = Math.cos(angle / 2)
      }
      drawCollider(p, g, collider, p.colliderShape.get(entity)!, color)
    }
    // Characters: their up, from the capsule's center to a little past its top.
    for (const [entity, c] of p.characters) {
      if (!passes(entity) || !world.has(entity, CharacterState)) continue
      const up = world.get(entity, CharacterState).up
      const t = c.collider.translation(p.v3 as never) as { x: number; y: number; z?: number }
      const tall = p.colliderShape.get(entity) === 'capsule' ? c.collider.halfHeight() : 0
      const reach = c.collider.radius() + tall + 0.5
      pa[0] = t.x
      pa[1] = t.y
      pa[2] = p.dim === 3 ? t.z! : 0
      pb[0] = pa[0] + up[0] * reach
      pb[1] = pa[1] + up[1] * reach
      pb[2] = pa[2] + up[2] * reach
      g.line(pa, pb, UP)
    }
    // Contact normals around awake bodies, up to a budget: past a thousand pairs they're an
    // unreadable carpet, and each pair costs several calls into Rapier.
    contactBudget = MAX_CONTACT_PAIRS
    for (let i = 0; i < p.list.length && contactBudget > 0; i++) {
      const record = p.list[i]!
      if (record.kind !== KIND_DYNAMIC || record.body.isSleeping()) continue
      const n = record.body.numColliders()
      for (let c = 0; c < n; c++) drawContacts(p, g, record.body.collider(c))
    }
  },
})

type Gz = GizmoStore
type RCollider = InstanceType<PhysicsWorld['R']['Collider']>

const MAX_CONTACT_PAIRS = 1000
let contactBudget = 0

/** An awake dynamic body's collider, whose pairs the loop visits from its own side too. */
function visitedFromOtherSide(other: RCollider): boolean {
  const body = other.parent()
  return body?.isDynamic() === true && !body.isSleeping()
}

function drawContacts(p: PhysicsWorld, g: Gz, collider: RCollider): void {
  p.raw.contactPairsWith(collider, (other) => {
    if (contactBudget <= 0) return
    // Each pair once: when both sides are visited, only from the lower handle.
    if (other.handle < collider.handle && visitedFromOtherSide(other)) return
    contactBudget--
    p.raw.contactPair(collider, other, (manifold) => {
      const count = manifold.numSolverContacts()
      if (count === 0) return
      const n = manifold.normal()
      for (let i = 0; i < count; i++) {
        const point = manifold.solverContactPoint(i)
        if (!point) continue
        pa[0] = point.x
        pa[1] = point.y
        pa[2] = p.dim === 3 ? (point as { z: number }).z : 0
        pb[0] = pa[0] + n.x * 0.25
        pb[1] = pa[1] + n.y * 0.25
        pb[2] = pa[2] + (p.dim === 3 ? (n as { z: number }).z : 0) * 0.25
        g.line(pa, pb, CONTACT)
      }
    })
  })
}

/** A point in the collider's local frame (centered at `center`, rotated by `q`) into out. */
function local(out: Float64Array, x: number, y: number, z: number): Float64Array {
  rotate(out, 0, q, 0, x, y, z)
  out[0] = out[0]! + center[0]!
  out[1] = out[1]! + center[1]!
  out[2] = out[2]! + center[2]!
  return out
}

/** A circle of radius r in a local plane (axis 0: YZ, 1: XZ, 2: XY), offset along y by dy. */
const SEGMENTS = 24
/** The unit circle's points, once (cos, sin per segment boundary). */
const UNIT = (() => {
  const out = new Float64Array((SEGMENTS + 1) * 2)
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2
    out[i * 2] = Math.cos(t)
    out[i * 2 + 1] = Math.sin(t)
  }
  return out
})()

/** A circle of radius r in a local plane (axis 0: YZ, 1: XZ, 2: XY), offset along y by dy. */
function localCircle(g: Gz, axis: number, r: number, dy: number, color: ArrayLike<number>): void {
  for (let i = 0; i <= SEGMENTS; i++) {
    const u = UNIT[i * 2]! * r
    const v = UNIT[i * 2 + 1]! * r
    if (axis === 0) local(pb, 0, u + dy, v)
    else if (axis === 1) local(pb, u, dy, v)
    else local(pb, u, v + dy, 0)
    if (i > 0) g.line(pa, pb, color)
    pa[0] = pb[0]!
    pa[1] = pb[1]!
    pa[2] = pb[2]!
  }
}

function drawCollider(
  p: PhysicsWorld,
  g: Gz,
  collider: InstanceType<PhysicsWorld['R']['Collider']>,
  shape: string,
  color: ArrayLike<number>,
): void {
  const is2d = p.dim === 2
  switch (shape) {
    case 'ball': {
      const r = collider.radius()
      localCircle(g, 2, r, 0, color)
      if (!is2d) {
        localCircle(g, 0, r, 0, color)
        localCircle(g, 1, r, 0, color)
      }
      return
    }
    case 'cuboid': {
      const he = collider.halfExtents() as { x: number; y: number; z?: number }
      const hz = is2d ? 0 : he.z!
      const size = [he.x * 2, he.y * 2, hz * 2]
      g.box(center, size, q, color)
      return
    }
    case 'capsule':
    case 'cylinder':
    case 'cone': {
      const r = collider.radius()
      const h = collider.halfHeight()
      if (is2d) {
        local(pa, -r, -h, 0)
        local(pb, -r, h, 0)
        g.line(pa, pb, color)
        local(pa, r, -h, 0)
        local(pb, r, h, 0)
        g.line(pa, pb, color)
        localCircle(g, 2, r, h, color)
        localCircle(g, 2, r, -h, color)
        return
      }
      const top = shape === 'cone' ? 0 : r
      localCircle(g, 1, r, -h, color)
      if (top > 0) localCircle(g, 1, top, h, color)
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2
        local(pa, Math.cos(a) * r, -h, Math.sin(a) * r)
        local(pb, Math.cos(a) * top, h, Math.sin(a) * top)
        g.line(pa, pb, color)
      }
      if (shape === 'capsule') {
        localCircle(g, 0, r, h, color)
        localCircle(g, 0, r, -h, color)
        localCircle(g, 2, r, h, color)
        localCircle(g, 2, r, -h, color)
      }
      return
    }
    case 'heightfield':
      drawHeightfield(p, g, collider, color)
      return
    default: {
      // Meshes, hulls, polylines: their edges from Rapier's own vertices.
      const vertices = collider.vertices?.() as Float32Array | undefined
      const indices = collider.indices?.() as Uint32Array | undefined
      if (!vertices || vertices.length === 0) return
      const d = p.dim
      const edge = (i: number, j: number) => {
        local(pa, vertices[i * d]!, vertices[i * d + 1]!, d === 3 ? vertices[i * d + 2]! : 0)
        local(pb, vertices[j * d]!, vertices[j * d + 1]!, d === 3 ? vertices[j * d + 2]! : 0)
        g.line(pa, pb, color)
      }
      if (indices && indices.length > 0) {
        const stride = shape === 'polyline' || is2d ? 2 : 3
        const limit = Math.min(indices.length, 30000)
        for (let i = 0; i + stride - 1 < limit; i += stride) {
          for (let k = 0; k < stride; k++) {
            if (stride === 2 && k === 1) break
            edge(indices[i + k]!, indices[i + ((k + 1) % stride)]!)
          }
        }
      } else {
        const n = vertices.length / d
        for (let i = 0; i + 1 < n; i++) edge(i, i + 1)
        // A 2D convex polygon comes as its outline; close it.
        if (shape === 'convex' && n > 2) edge(n - 1, 0)
      }
    }
  }
}

/** A heightfield from Rapier's heights: the profile in 2D, a grid of lines in 3D. */
function drawHeightfield(
  p: PhysicsWorld,
  g: Gz,
  collider: RCollider,
  color: ArrayLike<number>,
): void {
  const hf = collider as unknown as {
    heightfieldHeights(): Float32Array
    heightfieldScale(): { x: number; y: number; z?: number }
    heightfieldNRows(): number
    heightfieldNCols(): number
  }
  const heights = hf.heightfieldHeights()
  const scale = hf.heightfieldScale()
  if (p.dim === 2) {
    const n = heights.length
    for (let i = 0; i < n; i++) {
      local(pb, (i / (n - 1) - 0.5) * scale.x, heights[i]! * scale.y, 0)
      if (i > 0) g.line(pa, pb, color)
      pa[0] = pb[0]!
      pa[1] = pb[1]!
      pa[2] = pb[2]!
    }
    return
  }
  // Rows run along Z and columns along X; heights are column-major, (nrows + 1) × (ncols + 1).
  const rows = hf.heightfieldNRows() + 1
  const cols = hf.heightfieldNCols() + 1
  const sz = scale.z ?? 1
  const at = (out: Float64Array, r: number, c: number) =>
    local(
      out,
      (c / (cols - 1) - 0.5) * scale.x,
      heights[c * rows + r]! * scale.y,
      (r / (rows - 1) - 0.5) * sz,
    )
  // Dense fields draw every n-th line so the overlay stays readable.
  const step = Math.max(1, Math.ceil(Math.max(rows, cols) / 64))
  for (let r = 0; r < rows; r += step) {
    for (let c = 0; c + step < cols; c += step) {
      at(pa, r, c)
      at(pb, r, c + step)
      g.line(pa, pb, color)
    }
  }
  for (let c = 0; c < cols; c += step) {
    for (let r = 0; r + step < rows; r += step) {
      at(pa, r, c)
      at(pb, r + step, c)
      g.line(pa, pb, color)
    }
  }
}
