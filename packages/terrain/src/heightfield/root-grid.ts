import { EDGE_BOTTOM, EDGE_RIGHT, EDGE_TOP } from '../cube'
import type { QuadSurface, QuadTree, SelectionParams, SelectionView } from '../quadtree'

/**
 * A heightfield's roots as a quadtree surface (spec 0071): a grid of `rootsX` × `rootsZ` square
 * roots of `rootSize` metres, in the terrain's frame (x along +X, height along +Y, a node's y index
 * along +Z). A node is a box from its square and height range; there's no horizon. Neighbors
 * cross into the next root and stop at the terrain's edge.
 */
export class RootGrid implements QuadSurface {
  roots = 1
  rootsX = 1
  rootsZ = 1
  rootSize = 1
  /**
   * Called for every new node: may set its height range (`tree.setHeights`-style, flags included)
   * and its ready flag and slot, from what's known of its page.
   */
  onInit: ((tree: QuadTree, n: number, depth: number, x: number, z: number) => void) | undefined

  /** Sets the grid. The tree must be reset after. */
  configure(rootsX: number, rootsZ: number, rootSize: number): void {
    this.rootsX = rootsX
    this.rootsZ = rootsZ
    this.roots = rootsX * rootsZ
    this.rootSize = rootSize
  }

  grow(): void {}

  /** A node's global coordinates at its depth: [x, z]. */
  globalOf(tree: QuadTree, n: number, out: { [i: number]: number }): void {
    const root = tree.root[n]!
    const d = tree.depth[n]!
    out[0] = (root % this.rootsX) * 2 ** d + tree.x[n]!
    out[1] = Math.floor(root / this.rootsX) * 2 ** d + tree.y[n]!
  }

  private readonly g = new Float64Array(2)

  initNode(tree: QuadTree, n: number): void {
    if (!this.onInit) return
    this.globalOf(tree, n, this.g)
    this.onInit(tree, n, tree.depth[n]!, this.g[0]!, this.g[1]!)
  }

  /** The node's square: [x0, z0, size]. */
  private square(tree: QuadTree, n: number, out: Float64Array): Float64Array {
    this.globalOf(tree, n, out)
    const size = this.rootSize / 2 ** tree.depth[n]!
    out[0] = out[0]! * size
    out[1] = out[1]! * size
    out[2] = size
    return out
  }

  updateSphere(tree: QuadTree, n: number): void {
    this.square(tree, n, sq)
    const size = sq[2]!
    const lo = tree.minH[n]!
    const hi = tree.maxH[n]!
    const o = n * 4
    tree.sphere[o] = sq[0]! + size / 2
    tree.sphere[o + 1] = (lo + hi) / 2
    tree.sphere[o + 2] = sq[1]! + size / 2
    const hy = (hi - lo) / 2
    tree.sphere[o + 3] = Math.sqrt(size * size * 0.5 + hy * hy) + 1e-3
  }

  bounds(tree: QuadTree, n: number, center: ArrayLike<number>, out: { [i: number]: number }) {
    this.square(tree, n, sq)
    const size = sq[2]!
    out[0] = sq[0]! - center[0]!
    out[1] = tree.minH[n]! - center[1]!
    out[2] = sq[1]! - center[2]!
    out[3] = sq[0]! + size - center[0]!
    out[4] = tree.maxH[n]! - center[1]!
    out[5] = sq[1]! + size - center[2]!
  }

  /** Outside the frustum: the box's corner furthest along a plane's normal is behind it. */
  culled(tree: QuadTree, n: number, view: SelectionView, _params: SelectionParams): boolean {
    const s = tree.sphere
    const o = n * 4
    const f = view.frustum
    this.square(tree, n, sq)
    const size = sq[2]!
    const lo = tree.minH[n]!
    const hi = tree.maxH[n]!
    for (let p = 0; p < view.planes; p++) {
      const q = p * 4
      const nx = f[q]!
      const ny = f[q + 1]!
      const nz = f[q + 2]!
      const dist = nx * s[o]! + ny * s[o + 1]! + nz * s[o + 2]! + f[q + 3]!
      if (dist < -s[o + 3]!) return true
      if (dist > s[o + 3]!) continue
      const x = nx >= 0 ? sq[0]! + size : sq[0]!
      const y = ny >= 0 ? hi : lo
      const z = nz >= 0 ? sq[1]! + size : sq[1]!
      if (nx * x + ny * y + nz * z + f[q + 3]! < 0) return true
    }
    return false
  }

  neighbor(
    root: number,
    depth: number,
    x: number,
    y: number,
    edge: number,
    out: { [i: number]: number },
  ): boolean {
    const n = 2 ** depth
    let gx = (root % this.rootsX) * n + x
    let gz = Math.floor(root / this.rootsX) * n + y
    if (edge === EDGE_BOTTOM) gz--
    else if (edge === EDGE_RIGHT) gx++
    else if (edge === EDGE_TOP) gz++
    else gx--
    if (gx < 0 || gz < 0 || gx >= this.rootsX * n || gz >= this.rootsZ * n) return false
    const rx = Math.floor(gx / n)
    const rz = Math.floor(gz / n)
    out[0] = rz * this.rootsX + rx
    out[1] = gx - rx * n
    out[2] = gz - rz * n
    return true
  }
}

const sq = new Float64Array(3)
