import { EDGE_LEFT, faceToDirection, neighborNode, nodeExtent } from './cube'

/** The node's mesh exists (GPU dispatched, or a CPU mesh assigned): it can render. */
export const NODE_READY = 1
/** Heights are known exactly (CPU mesh, or the GPU readback arrived). */
export const NODE_BOUNDS = 2

const NONE = -1

/** Test points per node for the horizon: corners, edge middles, center. */
const POINTS = 9

/**
 * One cube-sphere quadtree per planet surface (terrain or ocean), stored as flat typed arrays
 * indexed by node, so the per-frame walk allocates nothing. The six roots are nodes 0–5; children
 * are made on first split as a block of four consecutive nodes, and freed as a block when their
 * subtree hasn't been needed for a while.
 */
export class NodeTree {
  capacity = 0
  count = 0
  face = new Uint8Array(0)
  depth = new Uint8Array(0)
  x = new Uint32Array(0)
  y = new Uint32Array(0)
  parent = new Int32Array(0)
  /** First of four children (in order (2x, 2y), (2x+1, 2y), (2x, 2y+1), (2x+1, 2y+1)), or −1. */
  child = new Int32Array(0)
  flags = new Uint8Array(0)
  /** Bounding sphere in the planet frame (f64): center xyz, radius. */
  sphere = new Float64Array(0)
  /** Height range (m above radius): exact once NODE_BOUNDS, else inherited or the planet's. */
  minH = new Float32Array(0)
  maxH = new Float32Array(0)
  /** Horizon test directions (unit, 9 per node). */
  dirs = new Float64Array(0)
  /** Stamps: last walk (frame), rendered and culled (walk stamp), forced split, last needed (frame). */
  visited = new Uint32Array(0)
  rendered = new Uint32Array(0)
  forced = new Uint32Array(0)
  culled = new Uint32Array(0)
  used = new Uint32Array(0)
  /** Pass stamp when the node was last requested, so each pass lists it once. */
  requestedAt = new Uint32Array(0)
  /** Frame the node was last split (children walked): merging then takes a margin. */
  splitAt = new Uint32Array(0)
  /**
   * Frame the node was last needed on screen: rendered, or a visible child a split waits for.
   * Prefetched and out-of-view nodes are only `used`; a full pool evicts them first.
   */
  neededAt = new Uint32Array(0)
  /** Render slot holding its mesh, or −1. */
  slot = new Int32Array(0)
  /** Projected error (px) and distance when last requested: generation priority. */
  priority = new Float32Array(0)
  distance = new Float64Array(0)
  /** Edge locks when rendered: bottom, right, top, left (−1, 0, 1). */
  locks = new Int8Array(0)
  /** Quadrants drawn when rendered (15: all; fewer while a split waits for some children). */
  mask = new Uint8Array(0)
  /** The planet version the node's mesh was made for: older is stale (it renders until replaced). */
  gen = new Uint32Array(0)
  /**
   * 1 / cos(half the widest angle between neighboring test points, diagonals included): lifting
   * the points by it puts the surface between them inside their hull (horizon test, bulge).
   */
  lift = new Float64Array(0)
  /** Starts of freed child blocks. */
  private blocks: number[] = []

  radius = 1
  readonly shape = new Float64Array([1, 1, 1])
  /** Height range for nodes whose heights aren't known yet. */
  lowest = 0
  highest = 0

  constructor(capacity = 1024) {
    this.grow(capacity)
  }

  private grow(capacity: number): void {
    const re = <
      T extends Uint8Array | Int8Array | Uint32Array | Int32Array | Float32Array | Float64Array,
    >(
      old: T,
      width = 1,
    ): T => {
      const next = new (old.constructor as new (n: number) => T)(capacity * width)
      next.set(old as never)
      return next
    }
    this.face = re(this.face)
    this.depth = re(this.depth)
    this.x = re(this.x)
    this.y = re(this.y)
    this.parent = re(this.parent)
    this.child = re(this.child)
    this.flags = re(this.flags)
    this.sphere = re(this.sphere, 4)
    this.minH = re(this.minH)
    this.maxH = re(this.maxH)
    this.dirs = re(this.dirs, POINTS * 3)
    this.visited = re(this.visited)
    this.rendered = re(this.rendered)
    this.forced = re(this.forced)
    this.culled = re(this.culled)
    this.used = re(this.used)
    this.requestedAt = re(this.requestedAt)
    this.splitAt = re(this.splitAt)
    this.neededAt = re(this.neededAt)
    this.slot = re(this.slot)
    this.priority = re(this.priority)
    this.distance = re(this.distance)
    this.locks = re(this.locks, 4)
    this.mask = re(this.mask)
    this.gen = re(this.gen)
    this.lift = re(this.lift)
    this.capacity = capacity
  }

  /** Clears every node and makes the six roots (after a planet's shape or graphs change). */
  reset(radius: number, shape: ArrayLike<number>, lowest: number, highest: number): void {
    this.count = 6
    this.blocks.length = 0
    this.radius = radius
    this.shape[0] = shape[0]!
    this.shape[1] = shape[1]!
    this.shape[2] = shape[2]!
    this.lowest = lowest
    this.highest = highest
    for (let f = 0; f < 6; f++) this.init(f, f, 0, 0, 0, NONE)
  }

  /** Root of a face (nodes 0–5). */
  root(face: number): number {
    return face
  }

  private init(n: number, face: number, depth: number, x: number, y: number, parent: number): void {
    this.face[n] = face
    this.depth[n] = depth
    this.x[n] = x
    this.y[n] = y
    this.parent[n] = parent
    this.child[n] = NONE
    this.flags[n] = 0
    this.slot[n] = NONE
    this.visited[n] = 0
    this.rendered[n] = 0
    this.forced[n] = 0
    this.culled[n] = 0
    this.used[n] = 0
    this.requestedAt[n] = 0
    this.splitAt[n] = 0
    this.neededAt[n] = 0
    this.priority[n] = 0
    this.distance[n] = 0
    this.gen[n] = 0
    this.mask[n] = 15
    this.locks.fill(-1, n * 4, n * 4 + 4)
    const ext = nodeExtent(depth)
    const u0 = -1 + x * ext
    const v0 = -1 + y * ext
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
    // Children start from their parent's known range, else the planet's.
    if (parent !== NONE && this.flags[parent]! & NODE_BOUNDS) {
      this.minH[n] = this.minH[parent]!
      this.maxH[n] = this.maxH[parent]!
    } else {
      this.minH[n] = this.lowest
      this.maxH[n] = this.highest
    }
    this.updateSphere(n)
  }

  /** Children of `n`, made if needed. Returns the first (the others follow it). */
  split(n: number): number {
    let c = this.child[n]!
    if (c !== NONE) return c
    const reused = this.blocks.pop()
    if (reused !== undefined) c = reused
    else {
      if (this.count + 4 > this.capacity) this.grow(this.capacity * 2)
      c = this.count
      this.count += 4
    }
    const face = this.face[n]!
    const depth = this.depth[n]! + 1
    const x = this.x[n]! * 2
    const y = this.y[n]! * 2
    for (let i = 0; i < 4; i++) this.init(c + i, face, depth, x + (i & 1), y + (i >> 1), n)
    this.child[n] = c
    return c
  }

  /** Frees `n`'s subtree. `release` is called for every freed node that holds a render slot. */
  merge(n: number, release: (node: number) => void): void {
    const c = this.child[n]!
    if (c === NONE) return
    for (let i = 0; i < 4; i++) {
      this.merge(c + i, release)
      if (this.slot[c + i]! !== NONE) release(c + i)
      this.slot[c + i] = NONE
      this.flags[c + i] = 0
    }
    this.child[n] = NONE
    this.blocks.push(c)
  }

  /** Live nodes (roots plus allocated blocks). */
  get live(): number {
    return this.count - this.blocks.length * 4
  }

  /** Sets a node's exact height range and recomputes its bounds. */
  setHeights(n: number, minH: number, maxH: number): void {
    this.minH[n] = minH
    this.maxH[n] = maxH
    this.flags[n]! |= NODE_BOUNDS
    this.updateSphere(n)
  }

  /** Bounding sphere of the node's 9 test points at its lowest and highest heights, plus bulge. */
  updateSphere(n: number): void {
    const d = this.dirs
    const s = this.shape
    const lo = this.radius + this.minH[n]!
    const hi = this.radius + this.maxH[n]!
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
    this.sphere[o] = cx
    this.sphere[o + 1] = cy
    this.sphere[o + 2] = cz
    this.sphere[o + 3] = Math.sqrt(r2) + bulge
  }

  /**
   * Axis-aligned bounds of the node relative to `center` (its chunk's reference point), from its
   * test points at its lowest and highest heights plus the bulge between them.
   */
  bounds(n: number, center: ArrayLike<number>, out: { [i: number]: number }): void {
    const d = this.dirs
    const s = this.shape
    const lo = this.radius + this.minH[n]!
    const hi = this.radius + this.maxH[n]!
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

  /** The node at (face, depth, x, y) if the tree has it, else the deepest existing ancestor. */
  find(face: number, depth: number, x: number, y: number): number {
    let n = face
    for (let k = 0; k < depth; k++) {
      const c = this.child[n]!
      if (c === NONE) return n
      const shift = depth - k - 1
      n = c + ((x >>> shift) & 1) + 2 * ((y >>> shift) & 1)
    }
    return n
  }

  /** Frees subtrees nobody has needed since frame `before`. */
  prune(before: number, release: (node: number) => void): void {
    for (let f = 0; f < 6; f++) this.pruneNode(f, before, release)
  }

  /** Returns whether `n` and its whole subtree are idle. */
  private pruneNode(n: number, before: number, release: (node: number) => void): boolean {
    const c = this.child[n]!
    let idle = this.used[n]! < before
    if (c === NONE) return idle
    let childrenIdle = true
    for (let i = 0; i < 4; i++) if (!this.pruneNode(c + i, before, release)) childrenIdle = false
    if (childrenIdle) this.merge(n, release)
    idle = idle && childrenIdle
    return idle
  }
}

// --- selection -------------------------------------------------------------------------------

/** What selection sees of the camera, in the planet frame (f64). */
export interface SelectionView {
  /** Camera position. */
  position: Float64Array
  /** Planes (nx, ny, nz, d), inside where n · p + d ≥ 0; `planes` of them. */
  frustum: Float64Array
  planes: number
  /**
   * A wider frustum (1.5× the field of view), same count: nodes just outside the view are
   * generated ahead of nodes far outside, so turning or moving shows them ready.
   */
  wide: Float64Array
  /** Pixels per radian at the view center: viewport height / (2 tan(fovY / 2)). */
  pixelsPerRadian: number
}

export interface SelectionParams {
  maxDepth: number
  /** Geometric error per depth (m). A depth-d node splits by errors[d + 1]. */
  errors: Float32Array
  errorPixels: number
  /** Occluder radius for the horizon test (the lowest the surface gets), 0 for none. */
  occluder: number
  /** Depth colliders use: forced near anchors, and the deepest rendered there. */
  colliderDepth: number
  /** Anchor positions in the planet frame (xyz) and their radii; `anchors` of them. */
  anchorPos: Float64Array
  anchorRadius: Float64Array
  anchors: number
}

/** A selection's output: rendered nodes, and nodes to generate with their priority. */
export interface Selection {
  rendered: Int32Array
  renderedCount: number
  requested: Int32Array
  requestedCount: number
  /** Splits waiting for children: the parent renders meanwhile. */
  waiting: number
  /** The first child each waiting split is missing (debugging and terrain.describe). */
  missing: Int32Array
  /** Walks this frame (2:1 balance adds some). */
  passes: number
  /** Stamp of the final walk: `tree.rendered[n] === stamp` for nodes rendered this frame. */
  stamp: number
}

export function createSelection(): Selection {
  return {
    rendered: new Int32Array(1024),
    renderedCount: 0,
    requested: new Int32Array(256),
    requestedCount: 0,
    waiting: 0,
    missing: new Int32Array(64),
    passes: 0,
    stamp: 0,
  }
}

const neighbor = new Float64Array(3)
let passStamp = 0
/** Children are generated ahead from this fraction of errorPixels (twice the split distance). */
const PREFETCH = 0.7
/** Frames a balance-forced split holds after last needed. */
const FORCE_HOLD = 30
/** Error fraction below which a split node merges. */
const MERGE_MARGIN = 0.9
/** Priority scale for children just outside the view (in the wide frustum), and far outside. */
const NEAR_VIEW = 0.5
const OUT_OF_VIEW = 1e-3

/**
 * Picks the nodes to render this frame (spec 0043): walks the six trees, culls nodes behind the
 * horizon or outside the frustum, splits a node when its children's geometric error projects past
 * `errorPixels` (or an anchor needs collider depth nearby, where nothing goes deeper), and renders
 * a split node's children only once all of the visible ones are ready, so a split never shows a
 * hole. Then enforces 2:1 balance between neighbors (marking coarse nodes to split and walking
 * again) and sets each rendered node's edge locks. Allocates nothing once its arrays are big enough.
 */
export function selectNodes(
  tree: NodeTree,
  view: SelectionView,
  params: SelectionParams,
  frame: number,
  out: Selection,
): void {
  out.passes = 0
  for (let pass = 0; pass < 8; pass++) {
    passStamp = (passStamp + 1) >>> 0 || 1
    out.renderedCount = 0
    out.requestedCount = 0
    out.waiting = 0
    out.passes++
    for (let f = 0; f < 6; f++) {
      tree.visited[f] = frame
      tree.used[f] = frame
      if (culledNode(tree, f, view, params)) tree.culled[f] = passStamp
      else visit(tree, f, view, params, frame, out)
    }
    if (!balance(tree, frame, out)) break
  }
  out.stamp = passStamp
  setLocks(tree, out)
}

function culledNode(
  tree: NodeTree,
  n: number,
  view: SelectionView,
  params: SelectionParams,
): boolean {
  const s = tree.sphere
  const o = n * 4
  const cx = s[o]!
  const cy = s[o + 1]!
  const cz = s[o + 2]!
  const r = s[o + 3]!
  const f = view.frustum
  const d = tree.dirs
  const sh = tree.shape
  const lo = tree.radius + tree.minH[n]!
  const hi = (tree.radius + tree.maxH[n]!) * tree.lift[n]!
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

/** Whether a node's bounding sphere is inside the wide frustum. */
function nearView(tree: NodeTree, n: number, view: SelectionView): boolean {
  const s = tree.sphere
  const o = n * 4
  const f = view.wide
  for (let p = 0; p < view.planes; p++) {
    const q = p * 4
    if (f[q]! * s[o]! + f[q + 1]! * s[o + 1]! + f[q + 2]! * s[o + 2]! + f[q + 3]! < -s[o + 3]!)
      return false
  }
  return true
}

function nodeDistance(tree: NodeTree, n: number, p: Float64Array): number {
  const s = tree.sphere
  const o = n * 4
  const dx = p[0]! - s[o]!
  const dy = p[1]! - s[o + 1]!
  const dz = p[2]! - s[o + 2]!
  return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - s[o + 3]!)
}

/** Whether any anchor is within its radius of the node's bounds. */
export function nearAnchor(tree: NodeTree, n: number, params: SelectionParams): boolean {
  if (params.anchors === 0) return false
  const s = tree.sphere
  const o = n * 4
  const a = params.anchorPos
  for (let i = 0; i < params.anchors; i++) {
    const dx = a[i * 3]! - s[o]!
    const dy = a[i * 3 + 1]! - s[o + 1]!
    const dz = a[i * 3 + 2]! - s[o + 2]!
    const reach = params.anchorRadius[i]! + s[o + 3]!
    if (dx * dx + dy * dy + dz * dz < reach * reach) return true
  }
  return false
}

function request(
  tree: NodeTree,
  n: number,
  priority: number,
  distance: number,
  frame: number,
  out: Selection,
): void {
  tree.used[n] = frame
  if (tree.requestedAt[n] === passStamp) return
  tree.requestedAt[n] = passStamp
  tree.priority[n] = priority
  tree.distance[n] = distance
  if (out.requestedCount === out.requested.length) {
    const next = new Int32Array(out.requested.length * 2)
    next.set(out.requested)
    out.requested = next
  }
  out.requested[out.requestedCount++] = n
}

function render(tree: NodeTree, n: number, frame: number, out: Selection, mask: number): void {
  tree.rendered[n] = passStamp
  tree.neededAt[n] = frame
  tree.mask[n] = mask
  if (out.renderedCount === out.rendered.length) {
    const next = new Int32Array(out.rendered.length * 2)
    next.set(out.rendered)
    out.rendered = next
  }
  out.rendered[out.renderedCount++] = n
}

/** Visits a node already known to be in view. */
function visit(
  tree: NodeTree,
  n: number,
  view: SelectionView,
  params: SelectionParams,
  frame: number,
  out: Selection,
): void {
  const depth = tree.depth[n]!
  const dist = nodeDistance(tree, n, view.position)
  const error = (view.pixelsPerRadian * params.errors[depth + 1]!) / Math.max(dist, 1e-3)
  let split = false
  if (depth < params.maxDepth) {
    // A split held for 2:1 balance stays a while after its reason goes (no one-frame merges).
    if (tree.forced[n] !== 0 && frame - tree.forced[n]! < FORCE_HOLD) split = true
    else if (nearAnchor(tree, n, params)) split = depth < params.colliderDepth
    else {
      // Merging takes a 10% margin: still inside the band where children are fully morphed.
      const wasSplit = tree.splitAt[n] !== 0 && frame - tree.splitAt[n]! <= 1
      split = error > params.errorPixels * (wasSplit ? MERGE_MARGIN : 1)
    }
  }
  if (split) {
    tree.splitAt[n] = frame
    const c = tree.split(n)
    let missing = 0
    for (let i = 0; i < 4; i++) {
      const k = c + i
      tree.visited[k] = frame
      tree.used[k] = frame
      // A split node's children stay in the pool even out of view: evicting one and seeing it
      // again would show the whole parent instead.
      tree.neededAt[k] = frame
      if (culledNode(tree, k, view, params)) {
        tree.culled[k] = passStamp
        // Out of view now, but generated anyway (sooner when just outside), so moving or turning
        // toward it shows it ready instead of its parent.
        if (!(tree.flags[k]! & NODE_READY)) {
          const d = nodeDistance(tree, k, view.position)
          const e = (view.pixelsPerRadian * params.errors[depth + 1]!) / Math.max(d, 1e-3)
          request(tree, k, e * (nearView(tree, k, view) ? NEAR_VIEW : OUT_OF_VIEW), d, frame, out)
        }
        continue
      }
      if (!(tree.flags[k]! & NODE_READY)) {
        if (missing === 0 && out.waiting < out.missing.length) out.missing[out.waiting] = k
        missing |= 1 << i
        const d = nodeDistance(tree, k, view.position)
        const e = (view.pixelsPerRadian * params.errors[depth + 1]!) / Math.max(d, 1e-3)
        request(tree, k, e, d, frame, out)
      }
    }
    if (missing !== 0) out.waiting++
    if (missing === 0 || tree.flags[n]! & NODE_READY) {
      // Ready children draw; where one is missing, this node draws that quadrant meanwhile.
      for (let i = 0; i < 4; i++) {
        const k = c + i
        if (tree.culled[k] !== passStamp && !(missing & (1 << i)))
          visit(tree, k, view, params, frame, out)
      }
      if (missing !== 0) render(tree, n, frame, out, missing)
      return
    }
    // Neither this node nor a child is ready: only roots (the first frames) get here.
    tree.neededAt[n] = frame
    request(tree, n, 1e9 - depth, dist, frame, out)
    return
  } else if (
    depth < params.maxDepth &&
    error > params.errorPixels * PREFETCH &&
    !nearAnchor(tree, n, params)
  ) {
    // Within the prefetch band past the split distance: generate the children now, so they're
    // ready (and fully morphed to this node's shape) when the split happens.
    const c = tree.split(n)
    for (let i = 0; i < 4; i++) {
      const k = c + i
      tree.used[k] = frame
      if (tree.flags[k]! & NODE_READY) continue
      const d = nodeDistance(tree, k, view.position)
      const e = (view.pixelsPerRadian * params.errors[depth + 1]!) / Math.max(d, 1e-3)
      const scale = !culledNode(tree, k, view, params)
        ? 1
        : nearView(tree, k, view)
          ? NEAR_VIEW
          : OUT_OF_VIEW
      request(tree, k, e * scale, d, frame, out)
    }
  }
  if (tree.flags[n]! & NODE_READY) render(tree, n, frame, out, 15)
  // Nothing renders here until it's ready: only roots (the first frames) get here unready.
  else {
    tree.neededAt[n] = frame
    request(tree, n, 1e9 - depth, dist, frame, out)
  }
}

/**
 * Finds rendered nodes more than one level coarser than a rendered neighbor and marks them to
 * split. Returns whether it marked any (selection walks again).
 */
function balance(tree: NodeTree, frame: number, out: Selection): boolean {
  let marked = false
  for (let r = 0; r < out.renderedCount; r++) {
    const n = out.rendered[r]!
    const depth = tree.depth[n]!
    if (depth < 2) continue
    for (let edge = 0; edge <= EDGE_LEFT; edge++) {
      neighborNode(tree.face[n]!, depth, tree.x[n]!, tree.y[n]!, edge, neighbor)
      const m = tree.find(neighbor[0]!, depth, neighbor[1]!, neighbor[2]!)
      const k = renderedAbove(tree, m)
      if (k === NONE) continue
      // A partial node (split, waiting for a child) can't go finer yet: nothing to force.
      if (tree.depth[k]! < depth - 1 && tree.forced[k] !== frame && tree.mask[k] === 15) {
        tree.forced[k] = frame
        marked = true
      }
    }
  }
  return marked
}

/** The node rendered by the current walk at or above `m`, or −1. */
function renderedAbove(tree: NodeTree, m: number): number {
  for (let k = m; k !== NONE; k = tree.parent[k]!) if (tree.rendered[k] === passStamp) return k
  return NONE
}

/** Edge locks per rendered node: 1 toward a coarser neighbor, 0 toward a finer one, else −1. */
function setLocks(tree: NodeTree, out: Selection): void {
  for (let r = 0; r < out.renderedCount; r++) {
    const n = out.rendered[r]!
    const depth = tree.depth[n]!
    for (let edge = 0; edge <= EDGE_LEFT; edge++) {
      let lock = -1
      if (depth > 0) {
        neighborNode(tree.face[n]!, depth, tree.x[n]!, tree.y[n]!, edge, neighbor)
        const m = tree.find(neighbor[0]!, depth, neighbor[1]!, neighbor[2]!)
        const k = renderedAbove(tree, m)
        if (k !== NONE) lock = tree.depth[k]! < depth ? 1 : -1
        else if (tree.depth[m] === depth && tree.child[m] !== NONE) lock = 0
      }
      tree.locks[n * 4 + edge] = lock
    }
  }
}
