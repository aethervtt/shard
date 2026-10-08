import { faceToDirection, neighborNode, nodeExtent } from './cube'
import { type QuadSurface, QuadTree, type SelectionParams, type SelectionView } from './quadtree'

/** Test points per node for the horizon: corners, edge middles, center. */
const POINTS = 9

/**
 * The cube-sphere as a quadtree surface (spec 0043): six roots, one per cube face, projected onto
 * an ellipsoid of `radius` and `shape`. Each node keeps 9 test directions (corners, edge middles,
 * center) for its bounds and the horizon test, and how far to lift them over the surface's bulge.
 */
export class CubeSphere implements QuadSurface {
  readonly roots = 6
  radius = 1
  readonly shape = new Float64Array([1, 1, 1])
  /** Horizon test directions (unit, 9 per node). */
  dirs = new Float64Array(0)
  /**
   * 1 / cos(half the widest angle between neighboring test points, diagonals included): lifting
   * the points by it puts the surface between them inside their hull (horizon test, bulge).
   */
  lift = new Float64Array(0)

  grow(capacity: number): void {
    const dirs = new Float64Array(capacity * POINTS * 3)
    dirs.set(this.dirs)
    this.dirs = dirs
    const lift = new Float64Array(capacity)
    lift.set(this.lift)
    this.lift = lift
  }

  initNode(tree: QuadTree, n: number): void {
    const face = tree.root[n]!
    const ext = nodeExtent(tree.depth[n]!)
    const u0 = -1 + tree.x[n]! * ext
    const v0 = -1 + tree.y[n]! * ext
    let k = n * POINTS * 3
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        faceToDirection(face, u0 + (ext * i) / 2, v0 + (ext * j) / 2, this.dirs, k)
        k += 3
      }
    }
    let widest = 0
    const base = n * POINTS * 3
    for (let a = 0; a < POINTS; a++) {
      for (let b = a + 1; b < POINTS; b++) {
        // Neighbors in the 3 × 3 grid, diagonals included.
        if (Math.abs((a % 3) - (b % 3)) > 1 || Math.abs(Math.floor(a / 3) - Math.floor(b / 3)) > 1)
          continue
        const d = this.dirs
        const cos =
          d[base + a * 3]! * d[base + b * 3]! +
          d[base + a * 3 + 1]! * d[base + b * 3 + 1]! +
          d[base + a * 3 + 2]! * d[base + b * 3 + 2]!
        widest = Math.max(widest, Math.acos(Math.min(1, cos)))
      }
    }
    this.lift[n] = 1 / Math.cos(widest / 2) + 1e-9
  }

  /** Bounding sphere of the node's 9 test points at its lowest and highest heights, plus bulge. */
  updateSphere(tree: QuadTree, n: number): void {
    const d = this.dirs
    const s = this.shape
    const lo = this.radius + tree.minH[n]!
    const hi = this.radius + tree.maxH[n]!
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let p = 0; p < POINTS; p++) {
      const o = (n * POINTS + p) * 3
      for (let k = 0; k < 2; k++) {
        const r = k === 0 ? lo : hi
        const x = d[o]! * s[0]! * r
        const y = d[o + 1]! * s[1]! * r
        const z = d[o + 2]! * s[2]! * r
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (z < minZ) minZ = z
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
      }
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const cz = (minZ + maxZ) / 2
    let r2 = 0
    for (let p = 0; p < POINTS; p++) {
      const o = (n * POINTS + p) * 3
      for (let k = 0; k < 2; k++) {
        const r = k === 0 ? lo : hi
        const x = d[o]! * s[0]! * r - cx
        const y = d[o + 1]! * s[1]! * r - cy
        const z = d[o + 2]! * s[2]! * r - cz
        const q = x * x + y * y + z * z
        if (q > r2) r2 = q
      }
    }
    // The surface bulges past its sample points by the sagitta between them.
    const bulge = hi * (this.lift[n]! - 1) + 1e-3
    const o = n * 4
    tree.sphere[o] = cx
    tree.sphere[o + 1] = cy
    tree.sphere[o + 2] = cz
    tree.sphere[o + 3] = Math.sqrt(r2) + bulge
  }

  /**
   * Axis-aligned bounds of the node relative to `center`, from its test points at its lowest and
   * highest heights plus the bulge between them.
   */
  bounds(tree: QuadTree, n: number, center: ArrayLike<number>, out: { [i: number]: number }) {
    const d = this.dirs
    const s = this.shape
    const lo = this.radius + tree.minH[n]!
    const hi = this.radius + tree.maxH[n]!
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let p = 0; p < POINTS; p++) {
      const o = (n * POINTS + p) * 3
      for (let k = 0; k < 2; k++) {
        const r = k === 0 ? lo : hi
        const x = d[o]! * s[0]! * r - center[0]!
        const y = d[o + 1]! * s[1]! * r - center[1]!
        const z = d[o + 2]! * s[2]! * r - center[2]!
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (z < minZ) minZ = z
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
      }
    }
    const bulge = hi * (this.lift[n]! - 1) + 1e-3
    out[0] = minX - bulge
    out[1] = minY - bulge
    out[2] = minZ - bulge
    out[3] = maxX + bulge
    out[4] = maxY + bulge
    out[5] = maxZ + bulge
  }

  culled(tree: QuadTree, n: number, view: SelectionView, params: SelectionParams): boolean {
    const s = tree.sphere
    const o = n * 4
    const cx = s[o]!
    const cy = s[o + 1]!
    const cz = s[o + 2]!
    const r = s[o + 3]!
    const f = view.frustum
    const d = this.dirs
    const sh = this.shape
    const lo = this.radius + tree.minH[n]!
    const hi = (this.radius + tree.maxH[n]!) * this.lift[n]!
    for (let p = 0; p < view.planes; p++) {
      const q = p * 4
      const nx = f[q]!
      const ny = f[q + 1]!
      const nz = f[q + 2]!
      const dist = nx * cx + ny * cy + nz * cz + f[q + 3]!
      if (dist < -r) return true
      if (dist > r) continue
      // Tighter than the sphere: the hull of the test points at the lowest height and (lifted over
      // the bulge) the highest holds the whole patch; all of it behind one plane is out of view.
      let inside = false
      for (let k = 0; k < POINTS && !inside; k++) {
        const i = (n * POINTS + k) * 3
        const dx = d[i]! * sh[0]!
        const dy = d[i + 1]! * sh[1]!
        const dz = d[i + 2]! * sh[2]!
        const along = nx * dx + ny * dy + nz * dz
        if (along * lo + f[q + 3]! >= 0 || along * hi + f[q + 3]! >= 0) inside = true
      }
      if (!inside) return true
    }
    if (params.occluder <= 0) return false
    // Horizon: every test point (lifted over the bulge between them) is behind the occluder sphere
    // (Cesium's test), in space scaled so the ellipsoid is a sphere of radius 1.
    const inv = 1 / params.occluder
    const px = (view.position[0]! / sh[0]!) * inv
    const py = (view.position[1]! / sh[1]!) * inv
    const pz = (view.position[2]! / sh[2]!) * inv
    const vh2 = px * px + py * py + pz * pz - 1
    if (vh2 <= 0) return false
    const top = hi * inv
    for (let k = 0; k < POINTS; k++) {
      const i = (n * POINTS + k) * 3
      const tx = d[i]! * top - px
      const ty = d[i + 1]! * top - py
      const tz = d[i + 2]! * top - pz
      const dot = -(tx * px + ty * py + tz * pz)
      if (dot <= vh2) return false
      if ((dot * dot) / (tx * tx + ty * ty + tz * tz) <= vh2) return false
    }
    return true
  }

  /** Across a cube edge the neighbor is on another face: there always is one. */
  neighbor(
    root: number,
    depth: number,
    x: number,
    y: number,
    edge: number,
    out: { [i: number]: number },
  ): boolean {
    neighborNode(root, depth, x, y, edge, out)
    return true
  }
}

/**
 * A planet surface's quadtree (terrain or ocean): a `QuadTree` on a `CubeSphere`. The six roots
 * are nodes 0–5, one per face.
 */
export class NodeTree extends QuadTree {
  readonly cube: CubeSphere

  constructor(capacity = 1024) {
    const cube = new CubeSphere()
    super(cube, capacity)
    this.cube = cube
  }

  /** Each node's cube face (its root). */
  get face(): Uint8Array {
    return this.root
  }

  get radius(): number {
    return this.cube.radius
  }

  get shape(): Float64Array {
    return this.cube.shape
  }

  /** Clears every node and makes the six roots (after a planet's shape or graphs change). */
  reset(radius: number, shape: ArrayLike<number>, lowest: number, highest: number): void {
    this.cube.radius = radius
    this.cube.shape[0] = shape[0]!
    this.cube.shape[1] = shape[1]!
    this.cube.shape[2] = shape[2]!
    this.resetRoots(lowest, highest)
  }

  /** Root of a face (nodes 0–5). */
  rootOf(face: number): number {
    return face
  }
}
