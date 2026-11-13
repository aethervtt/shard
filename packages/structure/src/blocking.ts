import type { Centerline } from './curve'
import { ClipScratch, emitFloor, type FloorShape, MeshBuilder, ringShape } from './geometry'
import type { CutoutModel, SlabModel, WallModel } from './model'

// What blocks movement (0112), from the structure model, as world-space shapes that physics and
// nav read alike. A straight span is one oriented box; a curved one is a convex hull per sampled
// interval of its centreline, the same subdivision compile draws (0066). Frames don't block.

/** One blocking shape, in the form `PhysicsWorld.setStatic` takes. */
export type BlockingShape =
  | { kind: 'cuboid'; center: number[]; halfExtents: number[]; yaw: number }
  | { kind: 'convex'; points: Float32Array }
  | { kind: 'trimesh'; positions: Float32Array; indices: Uint32Array }

/**
 * The box or hulls filling `[s0, s1]` of a centreline, from `y0` to `y1`, `half` either side of
 * it. Pushed onto `out`.
 */
export function stripShapes(
  line: Centerline,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  half: number,
  out: BlockingShape[],
): void {
  if (s1 - s0 <= 1e-9 || y1 - y0 <= 1e-9 || half <= 0) return
  if (line.count === 2) {
    const dx = (line.x[1]! - line.x[0]!) / (line.length || 1)
    const dz = (line.z[1]! - line.z[0]!) / (line.length || 1)
    const mid = (s0 + s1) / 2
    out.push({
      kind: 'cuboid',
      center: [line.x[0]! + dx * mid, (y0 + y1) / 2, line.z[0]! + dz * mid],
      halfExtents: [(s1 - s0) / 2, (y1 - y0) / 2, half],
      // Turns local +x onto (dx, dz): a rotation about +y by θ takes x to (cos θ, 0, −sin θ).
      yaw: Math.atan2(-dz, dx),
    })
    return
  }
  // One hull per interval the span covers, cut at s0 and s1.
  for (let i = 0; i + 1 < line.count; i++) {
    const a = line.s[i]!
    const b = line.s[i + 1]!
    if (b <= s0 || a >= s1) continue
    const p = new Float32Array(24)
    let k = 0
    for (const s of [Math.max(a, s0), Math.min(b, s1)]) {
      const t = b > a ? (s - a) / (b - a) : 0
      const x = line.x[i]! + (line.x[i + 1]! - line.x[i]!) * t
      const z = line.z[i]! + (line.z[i + 1]! - line.z[i]!) * t
      const nx = line.nx[i]! + (line.nx[i + 1]! - line.nx[i]!) * t
      const nz = line.nz[i]! + (line.nz[i + 1]! - line.nz[i]!) * t
      const nl = Math.sqrt(nx * nx + nz * nz) || 1
      for (const side of [-1, 1]) {
        for (const y of [y0, y1]) {
          p[k++] = x + (side * half * nx) / nl
          p[k++] = y
          p[k++] = z + (side * half * nz) / nl
        }
      }
    }
    out.push({ kind: 'convex', points: p })
  }
}

/** A wall's solid pieces (frames left out). */
export function wallBlockers(wall: WallModel, out: BlockingShape[] = []): BlockingShape[] {
  const line = wall.shape.line
  for (let i = 0; i < wall.count; i++) {
    const p = wall.pieces[i]!
    if (!p.frame) stripShapes(line, p.s0, p.s1, p.y0, p.y1, p.half, out)
  }
  return out
}

/**
 * What fills opening `index`'s hole in its wall, the wall's full thickness: a door's closed leaf
 * or a window's glass. Empty when the hole isn't there (the wall is gone, or it has no width).
 */
export function gapBlockers(
  wall: WallModel,
  index: number,
  out: BlockingShape[] = [],
): BlockingShape[] {
  const g = wall.gaps
  const s0 = g[index * 4]!
  if (Number.isNaN(s0) || index < 0) return out
  stripShapes(
    wall.shape.line,
    s0,
    g[index * 4 + 1]!,
    g[index * 4 + 2]!,
    g[index * 4 + 3]!,
    wall.shape.thickness / 2,
    out,
  )
  return out
}

const builder = new MeshBuilder()
const scratch = new ClipScratch()

type Trimesh = Extract<BlockingShape, { kind: 'trimesh' }>

function slabMesh(shape: FloorShape): Trimesh {
  const b = builder
  b.reset()
  emitFloor(shape, -Infinity, -Infinity, Infinity, Infinity, b, scratch)
  return {
    kind: 'trimesh',
    positions: b.positions.slice(0, b.vertexCount * 3),
    indices: b.indices.slice(0, b.indexCount),
  }
}

/** A floor's or roof's slab, its accepted cutouts as holes. */
export function slabBlockers(slab: SlabModel, out: BlockingShape[] = []): BlockingShape[] {
  const mesh = slabMesh(slab.shape)
  if (mesh.indices.length >= 3) out.push(mesh)
  return out
}

/** A hatch's or skylight's cover: its host's slab across the hole. Holes have none. */
export function cutoutBlockers(
  cutout: CutoutModel,
  host: SlabModel,
  out: BlockingShape[] = [],
): BlockingShape[] {
  if (cutout.kind === 'hole' || cutout.ring < 1) return out
  const f = host.shape
  const cover = ringShape(f, cutout.ring, f.thickness > 0 ? f.thickness : 0.04)
  const mesh = slabMesh(cover)
  if (mesh.indices.length >= 3) out.push(mesh)
  return out
}

/**
 * Triangles of blocking shapes for a navmesh (0112), 9 floats each. A box's or hull's top faces
 * up by Recast's rule ((v1 − v0) × (v2 − v0) points up), so it bakes as walkable when flat enough;
 * slab trimeshes keep their winding, which faces out.
 */
export function blockingTriangles(shapes: readonly BlockingShape[]): Float32Array {
  const out: number[] = []
  const corner = new Float64Array(24)
  for (const s of shapes) {
    if (s.kind === 'trimesh') {
      const p = s.positions
      for (let i = 0; i < s.indices.length; i++) {
        const v = s.indices[i]! * 3
        out.push(p[v]!, p[v + 1]!, p[v + 2]!)
      }
      continue
    }
    // Eight corners, indexed (along, up, side) as bits 2, 1, 0... in the same order for both.
    if (s.kind === 'cuboid') {
      const c = Math.cos(s.yaw)
      const n = Math.sin(s.yaw)
      const [hx, hy, hz] = s.halfExtents
      for (let i = 0; i < 8; i++) {
        const x = i & 4 ? hx! : -hx!
        const y = i & 2 ? hy! : -hy!
        const z = i & 1 ? hz! : -hz!
        corner[i * 3] = s.center[0]! + x * c + z * n
        corner[i * 3 + 1] = s.center[1]! + y
        corner[i * 3 + 2] = s.center[2]! - x * n + z * c
      }
    } else {
      // stripShapes writes (along, side, up) as bits 2, 1, 0: swap to (along, up, side).
      for (let i = 0; i < 8; i++) {
        const src = (i & 4) | ((i & 1) << 1) | ((i & 2) >> 1)
        corner[i * 3] = s.points[src * 3]!
        corner[i * 3 + 1] = s.points[src * 3 + 1]!
        corner[i * 3 + 2] = s.points[src * 3 + 2]!
      }
    }
    for (const f of BOX_FACES)
      for (const i of f) out.push(corner[i * 3]!, corner[i * 3 + 1]!, corner[i * 3 + 2]!)
  }
  return new Float32Array(out)
}

/**
 * A box's faces by corner (along, up, side as bits 2, 1, 0; along and side are a right-handed
 * x and z). The top is wound so Recast sees it facing up, the bottom down.
 */
const BOX_FACES = [
  [2, 3, 7, 2, 7, 6],
  [0, 4, 5, 0, 5, 1],
  [0, 1, 3, 0, 3, 2],
  [4, 6, 7, 4, 7, 5],
  [0, 2, 6, 0, 6, 4],
  [1, 5, 7, 1, 7, 3],
]
