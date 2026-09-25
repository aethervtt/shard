import type { Mesh } from '@shard/mesh'

/**
 * World-space triangles for a bake: 9 floats per triangle (three xyz corners) and an area code
 * each. Grows by doubling; `clear` keeps the memory.
 */
export class TriangleSoup {
  positions = new Float32Array(9 * 256)
  areas = new Uint8Array(256)
  count = 0
  readonly min = new Float64Array([Infinity, Infinity, Infinity])
  readonly max = new Float64Array([-Infinity, -Infinity, -Infinity])

  clear(): void {
    this.count = 0
    this.min.fill(Infinity)
    this.max.fill(-Infinity)
  }

  private grow(): void {
    const p = new Float32Array(this.positions.length * 2)
    p.set(this.positions)
    this.positions = p
    const a = new Uint8Array(this.areas.length * 2)
    a.set(this.areas)
    this.areas = a
  }

  /** Adds a triangle given in world space. */
  push(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    area: number,
  ): void {
    if (this.count === this.areas.length) this.grow()
    const o = this.count * 9
    const p = this.positions
    p[o] = ax
    p[o + 1] = ay
    p[o + 2] = az
    p[o + 3] = bx
    p[o + 4] = by
    p[o + 5] = bz
    p[o + 6] = cx
    p[o + 7] = cy
    p[o + 8] = cz
    this.areas[this.count++] = area
    for (let k = 0; k < 9; k += 3) {
      const x = p[o + k]!
      const y = p[o + k + 1]!
      const z = p[o + k + 2]!
      if (x < this.min[0]!) this.min[0] = x
      if (y < this.min[1]!) this.min[1] = y
      if (z < this.min[2]!) this.min[2] = z
      if (x > this.max[0]!) this.max[0] = x
      if (y > this.max[1]!) this.max[1] = y
      if (z > this.max[2]!) this.max[2] = z
    }
  }
}

/**
 * Local-space triangles into a soup through a world matrix (affine 3×4, row by row). Winding is
 * kept, or flipped under a mirroring matrix, so upward faces stay upward.
 */
export function pushTransformed(
  soup: TriangleSoup,
  local: ArrayLike<number>,
  indices: ArrayLike<number> | undefined,
  triangles: number,
  m: ArrayLike<number>,
  area: number,
): void {
  const det =
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) +
    m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!)
  const flip = det < 0
  const tx = (i: number) =>
    m[0]! * local[i]! + m[1]! * local[i + 1]! + m[2]! * local[i + 2]! + m[3]!
  const ty = (i: number) =>
    m[4]! * local[i]! + m[5]! * local[i + 1]! + m[6]! * local[i + 2]! + m[7]!
  const tz = (i: number) =>
    m[8]! * local[i]! + m[9]! * local[i + 1]! + m[10]! * local[i + 2]! + m[11]!
  for (let t = 0; t < triangles; t++) {
    const a = 3 * (indices ? indices[3 * t]! : 3 * t)
    let b = 3 * (indices ? indices[3 * t + 1]! : 3 * t + 1)
    let c = 3 * (indices ? indices[3 * t + 2]! : 3 * t + 2)
    if (flip) {
      const s = b
      b = c
      c = s
    }
    soup.push(tx(a), ty(a), tz(a), tx(b), ty(b), tz(b), tx(c), ty(c), tz(c), area)
  }
}

/** A convex shape's local triangles, wound so every face points away from the origin. */
function outward(tris: number[]): number[] {
  for (let o = 0; o < tris.length; o += 9) {
    const e0x = tris[o + 3]! - tris[o]!
    const e0y = tris[o + 4]! - tris[o + 1]!
    const e0z = tris[o + 5]! - tris[o + 2]!
    const e1x = tris[o + 6]! - tris[o]!
    const e1y = tris[o + 7]! - tris[o + 1]!
    const e1z = tris[o + 8]! - tris[o + 2]!
    const nx = e0y * e1z - e0z * e1y
    const ny = e0z * e1x - e0x * e1z
    const nz = e0x * e1y - e0y * e1x
    const cx = tris[o]! + tris[o + 3]! + tris[o + 6]!
    const cy = tris[o + 1]! + tris[o + 4]! + tris[o + 7]!
    const cz = tris[o + 2]! + tris[o + 5]! + tris[o + 8]!
    if (nx * cx + ny * cy + nz * cz < 0) {
      for (let k = 0; k < 3; k++) {
        const s = tris[o + 3 + k]!
        tris[o + 3 + k] = tris[o + 6 + k]!
        tris[o + 6 + k] = s
      }
    }
  }
  return tris
}

export function boxTriangles(hx: number, hy: number, hz: number): number[] {
  const tris: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    tris.push(...a, ...b, ...c, ...a, ...c, ...d)
  }
  const p = (x: number, y: number, z: number) => [x * hx, y * hy, z * hz]
  quad(p(-1, 1, -1), p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1)) // top
  quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1)) // bottom
  quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)) // +z
  quad(p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1), p(1, -1, -1)) // -z
  quad(p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), p(1, -1, 1)) // +x
  quad(p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1)) // -x
  return outward(tris)
}

/**
 * A solid of revolution around Y from a profile of [radius, y] pairs, bottom to top, with
 * `segments` sides. Rings of radius 0 close the ends.
 */
export function latheTriangles(profile: number[][], segments = 12): number[] {
  const tris: number[] = []
  const at = (ring: number, k: number) => {
    const [r, y] = profile[ring]!
    const a = (2 * Math.PI * k) / segments
    return [r! * Math.cos(a), y!, r! * Math.sin(a)]
  }
  for (let i = 0; i + 1 < profile.length; i++) {
    for (let k = 0; k < segments; k++) {
      const a = at(i, k)
      const b = at(i, k + 1)
      const c = at(i + 1, k + 1)
      const d = at(i + 1, k)
      if (profile[i]![0]! > 0) tris.push(...a, ...b, ...c)
      if (profile[i + 1]![0]! > 0) tris.push(...a, ...c, ...d)
    }
  }
  // Flat end caps where the profile doesn't close itself.
  for (const ring of [0, profile.length - 1]) {
    const [r, y] = profile[ring]!
    if (r! <= 0) continue
    for (let k = 0; k < segments; k++) tris.push(0, y!, 0, ...at(ring, k), ...at(ring, k + 1))
  }
  // Every face of a convex solid of revolution points away from its axis center.
  const mid = (profile[0]![1]! + profile[profile.length - 1]![1]!) / 2
  for (let o = 1; o < tris.length; o += 3) tris[o] = tris[o]! - mid
  outward(tris)
  for (let o = 1; o < tris.length; o += 3) tris[o] = tris[o]! + mid
  return tris
}

export function sphereProfile(
  radius: number,
  center = 0,
  from = -1,
  to = 1,
  rings = 6,
): number[][] {
  const out: number[][] = []
  for (let i = 0; i <= rings; i++) {
    const a = (Math.PI / 2) * (from + ((to - from) * i) / rings)
    out.push([radius * Math.cos(a), center + radius * Math.sin(a)])
  }
  return out
}

export function capsuleProfile(radius: number, halfHeight: number): number[][] {
  return [
    ...sphereProfile(radius, -halfHeight, -1, 0, 3),
    ...sphereProfile(radius, halfHeight, 0, 1, 3),
  ]
}

/** Heightfield triangles in local space, as the physics collider lays them out. */
export function heightfieldTriangles(
  rows: number,
  cols: number,
  heights: ArrayLike<number>,
  hx: number,
  hy: number,
  hz: number,
): number[] {
  const tris: number[] = []
  if (rows < 2 || cols < 2 || heights.length < rows * cols) return tris
  const p = (r: number, c: number) => [
    -hx + (2 * hx * c) / (cols - 1),
    heights[r * cols + c]! * hy,
    -hz + (2 * hz * r) / (rows - 1),
  ]
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      // Up-facing: a → a+z → a+x (Recast's walkable test uses the right-handed normal).
      tris.push(...p(r, c), ...p(r + 1, c), ...p(r + 1, c + 1))
      tris.push(...p(r, c), ...p(r + 1, c + 1), ...p(r, c + 1))
    }
  }
  return tris
}

/** A render mesh's triangles through a world matrix. */
export function pushMesh(soup: TriangleSoup, mesh: Mesh, m: ArrayLike<number>, area: number): void {
  const indices = mesh.indices
  const triangles = indices ? Math.floor(indices.length / 3) : Math.floor(mesh.vertexCount / 3)
  pushTransformed(soup, mesh.positions, indices, triangles, m, area)
}
