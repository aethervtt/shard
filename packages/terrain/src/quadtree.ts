import { EDGE_LEFT } from './cube'

/** The node's mesh exists (GPU dispatched, a CPU mesh assigned, a page resident): it can render. */
export const NODE_READY = 1
/** Heights are known exactly (CPU mesh, the GPU readback arrived, or a baked page's range). */
export const NODE_BOUNDS = 2

const NONE = -1

/**
 * What a quadtree needs from the surface it covers (spec 0071): how many roots there are, each
 * node's geometry (its bounding sphere and box at its height range), whether it's out of view or
 * behind the horizon, and its neighbor across an edge. The cube-sphere (`CubeSphere`, six roots)
 * and the heightfield's root grid (`RootGrid`) are the two surfaces; selection, 2:1 balance and
 * edge locks are the same code for both.
 */
export interface QuadSurface {
  /** Root nodes, 0 to roots − 1. */
  readonly roots: number
  /** The tree grew to `capacity` nodes: per-node data the surface keeps grows with it. */
  grow(capacity: number): void
  /** Sets up a new node's geometry; the tree has filled its root, depth, x and y. */
  initNode(tree: QuadTree, n: number): void
  /** The node's bounding sphere at its height range, into `tree.sphere`. */
  updateSphere(tree: QuadTree, n: number): void
  /** Axis-aligned bounds of the node relative to `center` (its chunk's reference point). */
  bounds(tree: QuadTree, n: number, center: ArrayLike<number>, out: { [i: number]: number }): void
  /** Whether the node is outside the view's frustum or below the horizon. */
  culled(tree: QuadTree, n: number, view: SelectionView, params: SelectionParams): boolean
  /**
   * The same-depth node across `edge` (EDGE_BOTTOM … EDGE_LEFT), written into `out` as
   * [root, x, y]. False where the surface ends (a heightfield's border).
   */
  neighbor(
    root: number,
    depth: number,
    x: number,
    y: number,
    edge: number,
    out: { [i: number]: number },
  ): boolean
}

/**
 * A quadtree over a surface (spec 0043, shared with 0071), stored as flat typed arrays indexed by
 * node, so the per-frame walk allocates nothing. The roots are nodes 0 to `surface.roots − 1`;
 * children are made on first split as a block of four consecutive nodes, and freed as a block when
 * their subtree hasn't been needed for a while.
 */
export class QuadTree {
  readonly surface: QuadSurface
  capacity = 0
  count = 0
  /** The root each node is under (a cube face on a planet, a grid cell on a heightfield). */
  root = new Uint8Array(0)
  depth = new Uint8Array(0)
  x = new Uint32Array(0)
  y = new Uint32Array(0)
  parent = new Int32Array(0)
  /** First of four children (in order (2x, 2y), (2x+1, 2y), (2x, 2y+1), (2x+1, 2y+1)), or −1. */
  child = new Int32Array(0)
  flags = new Uint8Array(0)
  /** Bounding sphere in the surface's frame (f64): center xyz, radius. */
  sphere = new Float64Array(0)
  /** Height range (m): exact once NODE_BOUNDS, else inherited or the surface's. */
  minH = new Float32Array(0)
  maxH = new Float32Array(0)
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
  /** Render slot holding its mesh (or its page), or −1. */
  slot = new Int32Array(0)
  /** Projected error (px) and distance when last requested: generation priority. */
  priority = new Float32Array(0)
  distance = new Float64Array(0)
  /** Edge locks when rendered: bottom, right, top, left (−1, 0, 1). */
  locks = new Int8Array(0)
  /** Quadrants drawn when rendered (15: all; fewer while a split waits for some children). */
  mask = new Uint8Array(0)
  /** The content version the node's mesh was made for: older is stale (it renders until replaced). */
  gen = new Uint32Array(0)
  /** Starts of freed child blocks. */
  private blocks: number[] = []

  /** Height range for nodes whose heights aren't known yet. */
  lowest = 0
  highest = 0

  constructor(surface: QuadSurface, capacity = 1024) {
    this.surface = surface
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
    this.root = re(this.root)
    this.depth = re(this.depth)
    this.x = re(this.x)
    this.y = re(this.y)
    this.parent = re(this.parent)
    this.child = re(this.child)
    this.flags = re(this.flags)
    this.sphere = re(this.sphere, 4)
    this.minH = re(this.minH)
    this.maxH = re(this.maxH)
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
    this.surface.grow(capacity)
    this.capacity = capacity
  }

  /** Clears every node and makes the roots (after the surface's shape or contents change). */
  resetRoots(lowest: number, highest: number): void {
    const roots = this.surface.roots
    if (roots > this.capacity) this.grow(Math.max(roots, this.capacity * 2))
    this.count = roots
    this.blocks.length = 0
    this.lowest = lowest
    this.highest = highest
    for (let r = 0; r < roots; r++) this.init(r, r, 0, 0, 0, NONE)
  }

  private init(n: number, root: number, depth: number, x: number, y: number, parent: number): void {
    this.root[n] = root
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
    this.surface.initNode(this, n)
    // Children start from their parent's known range, else the surface's.
    if (parent !== NONE && this.flags[parent]! & NODE_BOUNDS) {
      this.minH[n] = this.minH[parent]!
      this.maxH[n] = this.maxH[parent]!
    } else {
      this.minH[n] = this.lowest
      this.maxH[n] = this.highest
    }
    this.surface.updateSphere(this, n)
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
    const root = this.root[n]!
    const depth = this.depth[n]! + 1
    const x = this.x[n]! * 2
    const y = this.y[n]! * 2
    for (let i = 0; i < 4; i++) this.init(c + i, root, depth, x + (i & 1), y + (i >> 1), n)
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

  /** Recomputes the node's bounding sphere from its height range. */
  updateSphere(n: number): void {
    this.surface.updateSphere(this, n)
  }

  /** Axis-aligned bounds of the node relative to `center` (its chunk's reference point). */
  bounds(n: number, center: ArrayLike<number>, out: { [i: number]: number }): void {
    this.surface.bounds(this, n, center, out)
  }

  /** The node at (root, depth, x, y) if the tree has it, else the deepest existing ancestor. */
  find(root: number, depth: number, x: number, y: number): number {
    let n = root
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
    for (let r = 0; r < this.surface.roots; r++) this.pruneNode(r, before, release)
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

/** What selection sees of the camera, in the surface's frame (f64). */
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
  /** Anchor positions in the surface's frame (xyz) and their radii; `anchors` of them. */
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
 * Picks the nodes to render this frame (spec 0043): walks the trees from every root, culls nodes
 * behind the horizon or outside the frustum, splits a node when its children's geometric error projects past
 * `errorPixels` (or an anchor needs collider depth nearby, where nothing goes deeper), and renders
 * a split node's children only once all of the visible ones are ready, so a split never shows a
 * hole. Then enforces 2:1 balance between neighbors (marking coarse nodes to split and walking
 * again) and sets each rendered node's edge locks. Allocates nothing once its arrays are big enough.
 */
export function selectNodes(
  tree: QuadTree,
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
    for (let r = 0; r < tree.surface.roots; r++) {
      tree.visited[r] = frame
      tree.used[r] = frame
      if (tree.surface.culled(tree, r, view, params)) tree.culled[r] = passStamp
      else visit(tree, r, view, params, frame, out)
    }
    if (!balance(tree, frame, out)) break
  }
  out.stamp = passStamp
  setLocks(tree, out)
}

/** Whether a node's bounding sphere is inside the wide frustum. */
function nearView(tree: QuadTree, n: number, view: SelectionView): boolean {
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

function nodeDistance(tree: QuadTree, n: number, p: Float64Array): number {
  const s = tree.sphere
  const o = n * 4
  const dx = p[0]! - s[o]!
  const dy = p[1]! - s[o + 1]!
  const dz = p[2]! - s[o + 2]!
  return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - s[o + 3]!)
}

/** Whether any anchor is within its radius of the node's bounds. */
export function nearAnchor(tree: QuadTree, n: number, params: SelectionParams): boolean {
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
  tree: QuadTree,
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

function render(tree: QuadTree, n: number, frame: number, out: Selection, mask: number): void {
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
  tree: QuadTree,
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
      if (tree.surface.culled(tree, k, view, params)) {
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
      const scale = !tree.surface.culled(tree, k, view, params)
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
function balance(tree: QuadTree, frame: number, out: Selection): boolean {
  let marked = false
  for (let r = 0; r < out.renderedCount; r++) {
    const n = out.rendered[r]!
    const depth = tree.depth[n]!
    if (depth < 2) continue
    for (let edge = 0; edge <= EDGE_LEFT; edge++) {
      if (!tree.surface.neighbor(tree.root[n]!, depth, tree.x[n]!, tree.y[n]!, edge, neighbor))
        continue
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
function renderedAbove(tree: QuadTree, m: number): number {
  for (let k = m; k !== NONE; k = tree.parent[k]!) if (tree.rendered[k] === passStamp) return k
  return NONE
}

/** Edge locks per rendered node: 1 toward a coarser neighbor, 0 toward a finer one, else −1. */
function setLocks(tree: QuadTree, out: Selection): void {
  for (let r = 0; r < out.renderedCount; r++) {
    const n = out.rendered[r]!
    const depth = tree.depth[n]!
    for (let edge = 0; edge <= EDGE_LEFT; edge++) {
      let lock = -1
      if (
        depth > 0 &&
        tree.surface.neighbor(tree.root[n]!, depth, tree.x[n]!, tree.y[n]!, edge, neighbor)
      ) {
        const m = tree.find(neighbor[0]!, depth, neighbor[1]!, neighbor[2]!)
        const k = renderedAbove(tree, m)
        if (k !== NONE) lock = tree.depth[k]! < depth ? 1 : -1
        else if (tree.depth[m] === depth && tree.child[m] !== NONE) lock = 0
      }
      tree.locks[n * 4 + edge] = lock
    }
  }
}
