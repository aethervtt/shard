import { ShardError } from '@shard/core'

export const DIAGONAL_MODES = ['no-corners', 'never', 'always'] as const
export type DiagonalMode = (typeof DIAGONAL_MODES)[number]

/** Diagonal rule as a number, for hot code: 0 no-corners, 1 never, 2 always. */
export const DIAGONAL_NO_CORNERS = 0
export const DIAGONAL_NEVER = 1
export const DIAGONAL_ALWAYS = 2

/** Neighbor directions: 0–3 orthogonal (+x, −x, +y, −y), 4–7 diagonal. */
const DX = new Int32Array([1, -1, 0, 0, 1, 1, -1, -1])
const DY = new Int32Array([0, 0, 1, -1, 1, -1, 1, -1])

/**
 * Walkable cells and their costs, row by row from y = 0 (the bottom row, lowest world y).
 * 0 is blocked; 1 is normal ground; higher values cost that many times more to cross.
 */
export class NavGridData {
  width: number
  height: number
  costs: Uint8Array
  /**
   * Bumps on every edit, so grids and agents built from it know to refresh. `set` bumps it; code
   * that writes `costs` directly must bump it too.
   */
  version = 0
  private masks: (Uint8Array | undefined)[] = [undefined, undefined, undefined]
  private maskVersions = [-1, -1, -1]

  constructor(width: number, height: number, costs?: Uint8Array) {
    if (!(width >= 1 && height >= 1) || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw new ShardError('nav/invalid-grid', `A grid needs a whole size of at least 1×1`, {
        hint: `Got ${width}×${height}.`,
      })
    }
    this.width = width
    this.height = height
    this.costs = costs ?? new Uint8Array(width * height).fill(1)
    if (this.costs.length !== width * height) {
      throw new ShardError(
        'nav/invalid-grid',
        `A ${width}×${height} grid needs ${width * height} costs, got ${this.costs.length}`,
      )
    }
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0
    return this.costs[y * this.width + x]!
  }

  /** Sets a cell's cost (0 blocks it). Out-of-range cells are `nav/out-of-bounds`. */
  set(x: number, y: number, cost: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new ShardError(
        'nav/out-of-bounds',
        `Cell (${x}, ${y}) is outside the ${this.width}×${this.height} grid`,
      )
    }
    const i = y * this.width + x
    if (this.costs[i] === cost) return
    this.costs[i] = cost
    this.version++
  }

  /**
   * Per cell, a bit per direction (see `DX`, `DY`) that A* may step in under the diagonal rule:
   * in bounds, walkable, and not cutting a blocked corner when that's not allowed. Cached until
   * `version` changes, so searches skip walls without testing them.
   */
  neighbors(diagonal: number): Uint8Array {
    const cached = this.masks[diagonal]
    if (cached && this.maskVersions[diagonal] === this.version) return cached
    const w = this.width
    const h = this.height
    const costs = this.costs
    const out = cached?.length === w * h ? cached : new Uint8Array(w * h)
    const dirs = diagonal === DIAGONAL_NEVER ? 4 : 8
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mask = 0
        for (let d = 0; d < dirs; d++) {
          const nx = x + DX[d]!
          const ny = y + DY[d]!
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || costs[ny * w + nx] === 0) continue
          if (
            d >= 4 &&
            diagonal === DIAGONAL_NO_CORNERS &&
            (costs[y * w + nx] === 0 || costs[ny * w + x] === 0)
          )
            continue
          mask |= 1 << d
        }
        out[y * w + x] = mask
      }
    }
    this.masks[diagonal] = out
    this.maskVersions[diagonal] = this.version
    return out
  }

  copyFrom(other: NavGridData): void {
    this.width = other.width
    this.height = other.height
    this.costs = other.costs
    this.version++
  }
}

// --- A* ------------------------------------------------------------------------

/**
 * Reusable A* state for grids up to a size: a binary heap over TypedArrays and a generation
 * counter per search, so a search neither allocates nor clears arrays once it has grown.
 */
export class GridSearch {
  private capacity = 0
  private g = new Float64Array(0)
  private parent = new Int32Array(0)
  /** `gen`: seen this search (open). `gen + 1`: closed. Anything else: untouched. */
  private stamp = new Uint32Array(0)
  private heap = new Int32Array(0)
  private heapF = new Float64Array(0)
  private heapG = new Float64Array(0)
  private heapPos = new Int32Array(0)
  private stack = new Int32Array(0)
  private gen = 0
  /** The last path's cells (y · width + x), start first. */
  cells = new Int32Array(0)
  /** How many cells `cells` holds. */
  count = 0
  /** Path cost of the last search (world distance × cell cost). */
  cost = 0
  /** Whether the last search reached the goal; false means `cells` ends at the closest cell. */
  reached = false
  /** Cells expanded by the last search. */
  expanded = 0

  private ensure(n: number): void {
    if (n <= this.capacity) return
    this.capacity = n
    this.g = new Float64Array(n)
    this.parent = new Int32Array(n)
    this.stamp = new Uint32Array(n)
    this.heap = new Int32Array(n)
    this.heapF = new Float64Array(n)
    this.heapG = new Float64Array(n)
    this.heapPos = new Int32Array(n)
    this.stack = new Int32Array(n)
    this.cells = new Int32Array(n)
    this.gen = 0
  }

  /**
   * Finds the cheapest path from cell (sx, sy) to (gx, gy). Moving costs the world distance
   * (cell size `csx` × `csy`) times the entered cell's cost. Returns true when the goal was
   * reached; otherwise `cells` leads to the reachable cell closest to the goal. Both cells must
   * be walkable (see `nearestWalkable`).
   */
  search(
    grid: NavGridData,
    sx: number,
    sy: number,
    gx: number,
    gy: number,
    diagonal: number,
    csx = 1,
    csy = 1,
  ): boolean {
    const w = grid.width
    const h = grid.height
    this.ensure(w * h)
    this.gen += 2
    if (this.gen >= 0xfffffff0) {
      this.stamp.fill(0)
      this.gen = 2
    }
    const open = this.gen
    const closed = open + 1
    const costs = grid.costs
    const g = this.g
    const parent = this.parent
    const stamp = this.stamp
    const heap = this.heap
    const heapF = this.heapF
    const heapG = this.heapG
    const heapPos = this.heapPos
    const stack = this.stack
    const cd = Math.sqrt(csx * csx + csy * csy)
    const never = diagonal === DIAGONAL_NEVER
    const masks = grid.neighbors(diagonal)
    const start = sy * w + sx
    const goal = gy * w + gx
    let size = 0
    let top = 0
    let expanded = 0

    // Push the start.
    const dx0 = sx > gx ? sx - gx : gx - sx
    const dy0 = sy > gy ? sy - gy : gy - sy
    const m0 = dx0 < dy0 ? dx0 : dy0
    const h0 = never ? dx0 * csx + dy0 * csy : m0 * cd + (dx0 - m0) * csx + (dy0 - m0) * csy
    g[start] = 0
    parent[start] = -1
    stamp[start] = open
    heap[0] = start
    heapF[0] = h0
    heapG[0] = 0
    heapPos[start] = 0
    size = 1
    let best = start
    let bestH = h0
    let found = false
    let curF = h0

    // With a consistent heuristic f never drops, and a neighbor straight toward the goal keeps
    // the f of the cell it came from. Those go on a stack instead of the heap: popped first
    // (they tie with the heap's minimum at best), deepest first, and without heap sifts, which
    // in a maze's corridors is most pushes.
    while (top > 0 || size > 0) {
      let cur: number
      if (top > 0) cur = stack[--top]!
      else {
        // Pop the lowest f (ties: highest g).
        cur = heap[0]!
        curF = heapF[0]!
        size--
        if (size > 0) {
          const node = heap[size]!
          const nf = heapF[size]!
          const ng = heapG[size]!
          let i = 0
          for (;;) {
            const l = 2 * i + 1
            if (l >= size) break
            let c = l
            const r = l + 1
            if (r < size) {
              const fr = heapF[r]!
              const fl = heapF[l]!
              if (fr < fl || (fr === fl && heapG[r]! > heapG[l]!)) c = r
            }
            const fc = heapF[c]!
            if (fc > nf || (fc === nf && heapG[c]! <= ng)) break
            const moved = heap[c]!
            heap[i] = moved
            heapF[i] = fc
            heapG[i] = heapG[c]!
            heapPos[moved] = i
            i = c
          }
          heap[i] = node
          heapF[i] = nf
          heapG[i] = ng
          heapPos[node] = i
        }
      }
      if (cur === goal) {
        found = true
        break
      }
      stamp[cur] = closed
      expanded++
      const cy = (cur / w) | 0
      const cx = cur - cy * w
      const gc = g[cur]!
      const hc = curF - gc
      if (hc < bestH) {
        bestH = hc
        best = cur
      }
      let mask = masks[cur]!
      while (mask !== 0) {
        const bit = mask & -mask
        mask ^= bit
        const d = 31 - Math.clz32(bit)
        const nx = cx + DX[d]!
        const ny = cy + DY[d]!
        const next = ny * w + nx
        const st = stamp[next]!
        if (st === closed) continue
        const step = d < 2 ? csx : d < 4 ? csy : cd
        const cost = costs[next]!
        const tentative = gc + step * cost
        let i: number
        let f: number
        if (st === open) {
          const old = g[next]!
          if (tentative >= old) continue
          i = heapPos[next]!
          g[next] = tentative
          parent[next] = cur
          // On the stack its f is already the minimum; only rounding can improve it.
          if (i === -1) continue
          f = heapF[i]! - old + tentative
        } else {
          stamp[next] = open
          const hx = nx > gx ? nx - gx : gx - nx
          const hy = ny > gy ? ny - gy : gy - ny
          const hm = hx < hy ? hx : hy
          f =
            tentative + (never ? hx * csx + hy * csy : hm * cd + (hx - hm) * csx + (hy - hm) * csy)
          g[next] = tentative
          parent[next] = cur
          if (f <= curF) {
            stack[top++] = next
            heapPos[next] = -1
            continue
          }
          i = size++
        }
        // Sift up.
        while (i > 0) {
          const p = (i - 1) >> 1
          const fp = heapF[p]!
          if (fp < f || (fp === f && heapG[p]! >= tentative)) break
          const moved = heap[p]!
          heap[i] = moved
          heapF[i] = fp
          heapG[i] = heapG[p]!
          heapPos[moved] = i
          i = p
        }
        heap[i] = next
        heapF[i] = f
        heapG[i] = tentative
        heapPos[next] = i
      }
    }
    const end = found ? goal : best
    this.reached = found
    this.cost = g[end]!
    this.expanded = expanded
    // Walk the parents back, then reverse into start-first order.
    let count = 0
    const cells = this.cells
    for (let c = end; c !== -1; c = parent[c]!) cells[count++] = c
    for (let i = 0, j = count - 1; i < j; i++, j--) {
      const tmp = cells[i]!
      cells[i] = cells[j]!
      cells[j] = tmp
    }
    this.count = count
    return found
  }
}

// --- line of sight, smoothing, raycast ------------------------------------------

/** Scratch for `gridRaycast`: where the ray stopped, in cell units. */
export interface GridHit {
  /** 0..1 along the segment; 1 means it reached the end. */
  t: number
  x: number
  y: number
}

/**
 * A segment for `traceSegment`: ax, ay, bx, by. Doubles passed as arguments to a call V8 doesn't
 * inline are boxed, so hot callers write the segment here instead.
 */
const SEG = new Float64Array(4)
const SMOOTH = new Float64Array(6)

/**
 * Walks the segment (ax, ay) → (bx, by), in cell units, through the cells it touches
 * (Amanatides–Woo). Stops at the first blocked cell, a cell costing more than `maxCost`, or a
 * corner squeezed between two blocked cells (unless `always`). Returns true when the whole
 * segment is clear; writes the stop point and fraction reached into `hit` when given.
 */
export function gridTrace(
  grid: NavGridData,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  diagonal: number,
  maxCost: number,
  hit?: GridHit,
): boolean {
  SEG[0] = ax
  SEG[1] = ay
  SEG[2] = bx
  SEG[3] = by
  return traceSegment(grid, SEG, diagonal, maxCost, hit)
}

/** `gridTrace` with the segment in `seg` (ax, ay, bx, by), for per-frame callers. */
export function traceSegment(
  grid: NavGridData,
  seg: Float64Array,
  diagonal: number,
  maxCost: number,
  hit?: GridHit,
): boolean {
  const w = grid.width
  const h = grid.height
  const costs = grid.costs
  const ax = seg[0]!
  const ay = seg[1]!
  const bx = seg[2]!
  const by = seg[3]!
  let cx = Math.floor(ax)
  let cy = Math.floor(ay)
  const ex = Math.floor(bx)
  const ey = Math.floor(by)
  const dx = bx - ax
  const dy = by - ay
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity
  let tMaxX = stepX > 0 ? (cx + 1 - ax) / dx : stepX < 0 ? (cx - ax) / dx : Infinity
  let tMaxY = stepY > 0 ? (cy + 1 - ay) / dy : stepY < 0 ? (cy - ay) / dy : Infinity
  let t = 0
  let clear = true
  let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2
  for (;;) {
    let cost = 0
    if (cx >= 0 && cy >= 0 && cx < w && cy < h) cost = costs[cy * w + cx]!
    if (cost === 0 || cost > maxCost) {
      clear = false
      break
    }
    if ((cx === ex && cy === ey) || --guard < 0) break
    const diff = tMaxX - tMaxY
    if (Math.abs(diff) < 1e-9) {
      // Through a corner: both side cells must be open unless corners may be cut.
      if (diagonal !== DIAGONAL_ALWAYS) {
        const sx = cx + stepX
        const sy = cy + stepY
        const a = sx >= 0 && sx < w && cy >= 0 && cy < h ? costs[cy * w + sx]! : 0
        const b = cx >= 0 && cx < w && sy >= 0 && sy < h ? costs[sy * w + cx]! : 0
        if (a === 0 || b === 0) {
          t = tMaxX
          clear = false
          break
        }
      }
      t = tMaxX
      cx += stepX
      cy += stepY
      tMaxX += tDeltaX
      tMaxY += tDeltaY
      guard--
    } else if (diff < 0) {
      t = tMaxX
      cx += stepX
      tMaxX += tDeltaX
    } else {
      t = tMaxY
      cy += stepY
      tMaxY += tDeltaY
    }
  }
  if (hit) {
    const c = clear ? 1 : t < 0 ? 0 : t > 1 ? 1 : t
    hit.t = c
    hit.x = ax + dx * c
    hit.y = ay + dy * c
  }
  return clear
}

/**
 * String-pulls a cell path into corners: from the start point, the path runs straight to the
 * farthest cell center it can see, and on from there. Points are in cell units (cell (x, y) spans
 * [x, x + 1] × [y, y + 1]); `ends` holds the start and end points (sx, sy, ex, ey). Writes
 * `stride`-spaced x, y pairs into `out` and returns the corner count (start and end included).
 */
export function smoothGridPath(
  grid: NavGridData,
  cells: Int32Array,
  count: number,
  ends: Float64Array,
  diagonal: number,
  out: Float32Array,
  stride: number,
  maxCorners: number,
): number {
  const w = grid.width
  const costs = grid.costs
  let n = 1
  out[0] = ends[0]!
  out[1] = ends[1]!
  if (count <= 1) {
    if (maxCorners > 1 && (ends[2] !== ends[0] || ends[3] !== ends[1])) {
      out[stride] = ends[2]!
      out[stride + 1] = ends[3]!
      n = 2
    }
    return n
  }
  // Points stay in Float64Arrays: doubles in loop variables that also hold a parameter or a
  // call's result can make V8 box every value.
  const p = SMOOTH
  p[0] = ends[0]! // anchor
  p[1] = ends[1]!
  p[2] = ends[0]! // previous point
  p[3] = ends[1]!
  p[4] = ends[2]!
  p[5] = ends[3]!
  let anchorCost = costs[cells[0]!]!
  let prevCost = anchorCost
  for (let i = 1; i < count; i++) {
    const c = cells[i]!
    const cy = (c / w) | 0
    const last = i === count - 1
    SEG[0] = p[0]!
    SEG[1] = p[1]!
    SEG[2] = last ? p[4]! : c - cy * w + 0.5
    SEG[3] = last ? p[5]! : cy + 0.5
    const cost = costs[c]!
    const limit = cost > anchorCost ? cost : anchorCost
    if (!traceSegment(grid, SEG, diagonal, limit)) {
      if (n >= maxCorners - 1) break
      out[n * stride] = p[2]!
      out[n * stride + 1] = p[3]!
      n++
      p[0] = p[2]!
      p[1] = p[3]!
      anchorCost = prevCost
    }
    p[2] = SEG[2]!
    p[3] = SEG[3]!
    prevCost = cost
  }
  out[n * stride] = p[4]!
  out[n * stride + 1] = p[5]!
  return n + 1
}

/**
 * The walkable cell nearest to (x, y) within `radius` cells, as y · width + x, or -1. Searches
 * rings outward and picks the closest center in the first ring that has one.
 */
export function nearestWalkable(grid: NavGridData, x: number, y: number, radius: number): number {
  const w = grid.width
  const h = grid.height
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  if (cx >= 0 && cy >= 0 && cx < w && cy < h && grid.costs[cy * w + cx]! > 0) return cy * w + cx
  let best = -1
  let bestD = Infinity
  for (let r = 1; r <= radius; r++) {
    for (let j = cy - r; j <= cy + r; j++) {
      if (j < 0 || j >= h) continue
      const edge = j === cy - r || j === cy + r
      for (let i = cx - r; i <= cx + r; i += edge ? 1 : 2 * r) {
        if (i < 0 || i >= w || grid.costs[j * w + i] === 0) continue
        const ddx = i + 0.5 - x
        const ddy = j + 0.5 - y
        const d = ddx * ddx + ddy * ddy
        if (d < bestD) {
          bestD = d
          best = j * w + i
        }
      }
    }
    // Centers in the next ring are at least r + 0.5 away: past that, nothing can beat `best`.
    if (best !== -1 && Math.sqrt(bestD) <= r + 0.5) return best
  }
  return best
}
