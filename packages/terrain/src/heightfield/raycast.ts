import type { Entity, World } from '@aethervtt/shard-core'
import { dequantize, PAGE } from './kernel'
import { finestPage, heightfieldRuntime, pageSample } from './queries'
import type { HeightfieldRuntime } from './runtime'

/** Where a ray met the ground (spec 0104). */
export interface TerrainHit {
  /** The hit in the world (origin frame). */
  point: [number, number, number]
  /** The triangle's unit normal in the world. */
  normal: [number, number, number]
  /** Metres along the ray (its direction normalized). */
  distance: number
  /** The hit in the terrain's frame: metres from its corner. */
  x: number
  z: number
}

const o = new Float64Array(3)
const d = new Float64Array(3)
const tri = new Float64Array(4)

/**
 * Walks the grid cells of `size` (corner at `x0`, `z0`) a ray's XZ crosses between t0 and t1,
 * nearest first, until `visit(i, j, ta, tb)` returns true.
 */
function walkCells(
  x0: number,
  z0: number,
  size: number,
  t0: number,
  t1: number,
  visit: (i: number, j: number, ta: number, tb: number) => boolean,
): boolean {
  const px = o[0]! + d[0]! * t0 - x0
  const pz = o[2]! + d[2]! * t0 - z0
  let i = Math.floor(px / size)
  let j = Math.floor(pz / size)
  const si = d[0]! > 0 ? 1 : d[0]! < 0 ? -1 : 0
  const sj = d[2]! > 0 ? 1 : d[2]! < 0 ? -1 : 0
  const di = si !== 0 ? size / Math.abs(d[0]!) : Infinity
  const dj = sj !== 0 ? size / Math.abs(d[2]!) : Infinity
  let ni =
    si > 0 ? t0 + ((i + 1) * size - px) / d[0]! : si < 0 ? t0 + (i * size - px) / d[0]! : Infinity
  let nj =
    sj > 0 ? t0 + ((j + 1) * size - pz) / d[2]! : sj < 0 ? t0 + (j * size - pz) / d[2]! : Infinity
  let t = t0
  while (t <= t1) {
    const next = Math.min(ni, nj, t1)
    if (visit(i, j, t, next)) return true
    if (next >= t1) return false
    if (ni <= nj) {
      i += si
      t = ni
      ni += di
    } else {
      j += sj
      t = nj
      nj += dj
    }
  }
  return false
}

/** Möller–Trumbore against triangle (a, b, c): writes t and the unnormalized normal into `tri`. */
function hitTriangle(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const e1x = bx - ax
  const e1y = by - ay
  const e1z = bz - az
  const e2x = cx - ax
  const e2y = cy - ay
  const e2z = cz - az
  const px = d[1]! * e2z - d[2]! * e2y
  const py = d[2]! * e2x - d[0]! * e2z
  const pz = d[0]! * e2y - d[1]! * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (Math.abs(det) < 1e-12) return Infinity
  const inv = 1 / det
  const tx = o[0]! - ax
  const ty = o[1]! - ay
  const tz = o[2]! - az
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity
  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv
  // Facing up, always (cross of the edges, flipped if needed).
  let nx = e1y * e2z - e1z * e2y
  let ny = e1z * e2x - e1x * e2z
  let nz = e1x * e2y - e1y * e2x
  if (ny < 0) {
    nx = -nx
    ny = -ny
    nz = -nz
  }
  tri[0] = t
  tri[1] = nx
  tri[2] = ny
  tri[3] = nz
  return t
}

/** The ray's nearest hit on one page's cells over [ta, tb], into `best` (t, then the normal). */
function hitPage(
  rt: HeightfieldRuntime,
  x: number,
  z: number,
  ta: number,
  tb: number,
  best: Float64Array,
): void {
  const page = finestPage(rt, x, z)
  if (!page) return
  // Above the page's whole range: nothing here.
  const ya = o[1]! + d[1]! * ta
  const yb = o[1]! + d[1]! * tb
  if (Math.min(ya, yb) > dequantize(page.max, rt.lo, rt.hi) + 1e-3) return
  const size = rt.nodeSize(page.depth)
  const s = size / PAGE
  const px0 = page.x * size
  const pz0 = page.z * size
  walkCells(px0, pz0, s, ta, tb, (i, j) => {
    if (i < 0 || j < 0 || i >= PAGE || j >= PAGE) return false
    const x0 = px0 + i * s
    const z0 = pz0 + j * s
    const h00 = pageSample(rt, page, i, j)
    const h10 = pageSample(rt, page, i + 1, j)
    const h01 = pageSample(rt, page, i, j + 1)
    const h11 = pageSample(rt, page, i + 1, j + 1)
    // The cell's two triangles, split along (i + 1, j)–(i, j + 1) as the mesh and Rapier are.
    let found = false
    for (let k = 0; k < 2; k++) {
      const t =
        k === 0
          ? hitTriangle(x0, h00, z0, x0 + s, h10, z0, x0, h01, z0 + s)
          : hitTriangle(x0 + s, h11, z0 + s, x0, h01, z0 + s, x0 + s, h10, z0)
      if (t >= 0 && t < best[0]!) {
        best[0] = t
        best[1] = tri[1]!
        best[2] = tri[2]!
        best[3] = tri[3]!
        found = true
      }
    }
    return found
  })
}

const best = new Float64Array(4)

/**
 * A ray against the ground (spec 0104): `origin` and `direction` in the world (a `screenToRay`
 * ray), up to `maxDistance` metres. It walks the finest pages on the CPU under the ray (leaf cells
 * near anchors, so exactly the drawn and solid ground; coarser farther out, within `errorPixels`
 * of the drawn surface), skipping pages the ray passes above. Null when it misses the terrain.
 */
export function terrainRaycast(
  world: World,
  terrain: Entity,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  maxDistance = 10_000,
  out?: TerrainHit,
): TerrainHit | null {
  const rt = heightfieldRuntime(world, terrain)
  const l = rt.layout!
  rt.frame.pointToPlanet(origin[0]!, origin[1]!, origin[2]!, o)
  rt.frame.vectorToPlanet(direction[0]!, direction[1]!, direction[2]!, d)
  const len = Math.sqrt(d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!)
  if (!(len > 0)) return null
  d[0] = d[0]! / len
  d[1] = d[1]! / len
  d[2] = d[2]! / len
  // Clip to the terrain's box.
  let t0 = 0
  let t1 = maxDistance
  const lo = [0, rt.lo - 1, 0]
  const hi = [l.sizeX, rt.hi + 1, l.sizeZ]
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]!) < 1e-12) {
      if (o[a]! < lo[a]! || o[a]! > hi[a]!) return null
      continue
    }
    let ta = (lo[a]! - o[a]!) / d[a]!
    let tb = (hi[a]! - o[a]!) / d[a]!
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
  }
  if (t0 > t1) return null
  best[0] = Infinity
  const size = l.leafSize
  walkCells(0, 0, size, t0, t1, (i, j, ta, tb) => {
    if (i < 0 || j < 0 || i >= l.leavesX || j >= l.leavesZ) return false
    hitPage(rt, (i + 0.5) * size, (j + 0.5) * size, ta, tb, best)
    // A hit in this cell is the nearest: cells come nearest first.
    return best[0]! <= tb + 1e-6
  })
  const t = best[0]!
  if (t === Infinity || t > maxDistance) return null
  const hx = o[0]! + d[0]! * t
  const hy = o[1]! + d[1]! * t
  const hz = o[2]! + d[2]! * t
  const hit = out ?? { point: [0, 0, 0], normal: [0, 1, 0], distance: 0, x: 0, z: 0 }
  rt.frame.pointToOrigin(hx, hy, hz, o)
  hit.point[0] = o[0]!
  hit.point[1] = o[1]!
  hit.point[2] = o[2]!
  rt.frame.vectorToOrigin(best[1]!, best[2]!, best[3]!, o)
  const nl = Math.sqrt(o[0]! * o[0]! + o[1]! * o[1]! + o[2]! * o[2]!) || 1
  hit.normal[0] = o[0]! / nl
  hit.normal[1] = o[1]! / nl
  hit.normal[2] = o[2]! / nl
  hit.distance = t
  hit.x = hx
  hit.z = hz
  return hit
}
