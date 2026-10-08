import { ShardError } from '@aethervtt/shard-core'

// The chunk mesh every quadtree surface draws (spec 0043, shared with 0071's heightfields): its
// vertex layout, and its index sets per (drawn quadrants, stitched edges), skirts included.

/**
 * How a chunk's vertices are laid out, per resolution `n` (vertices per edge, 2^k + 1). The border
 * ring comes first (so edge locks rewrite one contiguous block), then the interior row by row, then
 * one skirt vertex under each ring vertex. Every chunk of a resolution shares one index buffer.
 */
export interface ChunkLayout {
  resolution: number
  /** Ring vertices: 4 (n − 1), counter-clockwise from (0, 0) seen from outside. */
  ring: number
  /** Surface vertices: n². */
  surface: number
  /** Surface plus skirt: n² + 4 (n − 1). */
  vertexCount: number
  /** Vertex index of grid point (i, j), at `i + j * n`. */
  index: Uint16Array
  /** Grid point of each ring vertex: i, j pairs. */
  ringPoints: Uint16Array
  /** Triangles: the surface, then the skirts (`chunkIndices` with every quadrant, no stitching). */
  indices: Uint16Array
  /** Triangles without skirts (the surface only): colliders, and planets with skirts off. */
  surfaceIndices: Uint16Array
}

const layouts = new Map<number, ChunkLayout>()
const sets = new Map<string, Uint16Array>()

/**
 * A chunk's triangles (cached per combination, so chunks share the array and its GPU index buffer).
 * `mask` picks quadrants (bit q: quadrant q, in child order (x, y), (x+1, y), (x, y+1),
 * (x+1, y+1)): a split waiting for children draws its own quadrants where they're missing and the
 * children elsewhere. `stitch` bit e marks edge e (0 bottom, 1 right, 2 top, 3 left) as meeting a
 * coarser neighbor: that edge's triangles use only its even vertices, the neighbor's, so there's no
 * T-junction (a vertex on the neighbor's edge only up to rounding shows pixel-sized holes).
 *
 * Quads fill the interior; each edge's strip (between the border and the first inner row) is
 * zipped per half, so no triangle crosses a quadrant boundary. Skirts follow the drawn border.
 *
 * `diagonal: 'anti'` (heightfields, 0071) splits every quad along (i+1, j)–(i, j+1), Rapier's
 * heightfield split, border cells included: only a stitched edge's strip is zipped. What's drawn is
 * then exactly the collider's triangles wherever no edge is stitched. Its triangles face +Y with
 * i along +X and j along +Z (clockwise in (i, j)).
 */
export function chunkIndices(
  n: number,
  mask: number,
  stitch: number,
  skirts: boolean,
  diagonal: 'main' | 'anti' = 'main',
): Uint16Array {
  if (diagonal === 'anti') return antiIndices(n, mask, stitch, skirts)
  const key = `${n}:${mask}:${stitch}:${skirts}`
  let out = sets.get(key)
  if (out) return out
  const layout = chunkLayout(n)
  const index = layout.index
  const side = n - 1
  const h = side / 2
  const parts: number[] = []
  const quadrant = (i: number, j: number) => (i >= h ? 1 : 0) + (j >= h ? 2 : 0)
  // Interior quads, split along (i, j)–(i+1, j+1): a parent's odd-odd child vertex is on it.
  for (let j = 1; j < side - 1; j++) {
    for (let i = 1; i < side - 1; i++) {
      if (!(mask & (1 << quadrant(i, j)))) continue
      const a = index[i + j * n]!
      const b = index[i + 1 + j * n]!
      const c = index[i + 1 + (j + 1) * n]!
      const d = index[i + (j + 1) * n]!
      parts.push(a, b, c, a, c, d)
    }
  }
  // Edge e at position s (0 to side, counter-clockwise), on the border (depth 0) or the first
  // inner row (depth 1).
  const at = (e: number, s: number, depth: number) => {
    const i = e === 0 ? s : e === 1 ? side - depth : e === 2 ? side - s : depth
    const j = e === 0 ? depth : e === 1 ? s : e === 2 ? side - depth : side - s
    return index[i + j * n]!
  }
  const skirt: number[] = []
  const outer: number[] = []
  const inner: number[] = []
  for (let e = 0; e < 4; e++) {
    const step = stitch & (1 << e) ? 2 : 1
    for (let half = 0; half < 2; half++) {
      const s0 = half * h
      const s1 = s0 + h
      // The half's quadrant: the one containing the border's midpoint there.
      const m = s0 + h / 2
      const q =
        e === 0
          ? quadrant(m, 0)
          : e === 1
            ? quadrant(side, m)
            : e === 2
              ? quadrant(side - m, side)
              : quadrant(0, side - m)
      if (!(mask & (1 << q))) continue
      outer.length = 0
      inner.length = 0
      for (let s = s0; s <= s1; s += step) outer.push(s)
      for (let s = Math.max(1, s0); s <= Math.min(side - 1, s1); s++) inner.push(s)
      let a = 0
      let b = 0
      while (a < outer.length - 1 || b < inner.length - 1) {
        const advanceOuter =
          b === inner.length - 1 || (a < outer.length - 1 && outer[a + 1]! <= inner[b + 1]!)
        if (advanceOuter) {
          parts.push(at(e, outer[a]!, 0), at(e, outer[a + 1]!, 0), at(e, inner[b]!, 1))
          a++
        } else {
          parts.push(at(e, outer[a]!, 0), at(e, inner[b + 1]!, 1), at(e, inner[b]!, 1))
          b++
        }
      }
      if (!skirts) continue
      // Skirt walls under the drawn border, both faces: a crack is covered seen from either side,
      // including a finer neighbor's side of a partial parent's quadrant (no skirt of its own).
      for (let k = 0; k + 1 < outer.length; k++) {
        const va = at(e, outer[k]!, 0)
        const vb = at(e, outer[k + 1]!, 0)
        const sa = layout.surface + va
        const sb = layout.surface + vb
        skirt.push(va, sa, vb, vb, sa, sb, va, vb, sa, vb, sb, sa)
      }
    }
  }
  for (const v of skirt) parts.push(v)
  out = Uint16Array.from(parts)
  sets.set(key, out)
  return out
}

/** `chunkIndices` with every quad split along its anti-diagonal (heightfields). */
function antiIndices(n: number, mask: number, stitch: number, skirts: boolean): Uint16Array {
  const key = `${n}:${mask}:${stitch}:${skirts}:anti`
  let out = sets.get(key)
  if (out) return out
  const layout = chunkLayout(n)
  const index = layout.index
  const side = n - 1
  const h = side / 2
  const parts: number[] = []
  const quadrant = (i: number, j: number) => (i >= h ? 1 : 0) + (j >= h ? 2 : 0)
  const stitched = (e: number) => (stitch & (1 << e)) !== 0
  // Every cell not in a stitched edge's strip: a quad split along (i+1, j)–(i, j+1).
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      if (
        (j === 0 && stitched(0)) ||
        (i === side - 1 && stitched(1)) ||
        (j === side - 1 && stitched(2)) ||
        (i === 0 && stitched(3))
      )
        continue
      if (!(mask & (1 << quadrant(i, j)))) continue
      const a = index[i + j * n]!
      const b = index[i + 1 + j * n]!
      const c = index[i + 1 + (j + 1) * n]!
      const d = index[i + (j + 1) * n]!
      parts.push(a, b, d, b, c, d)
    }
  }
  const at = (e: number, s: number, depth: number) => {
    const i = e === 0 ? s : e === 1 ? side - depth : e === 2 ? side - s : depth
    const j = e === 0 ? depth : e === 1 ? s : e === 2 ? side - depth : side - s
    return index[i + j * n]!
  }
  const skirt: number[] = []
  const outer: number[] = []
  const inner: number[] = []
  for (let e = 0; e < 4; e++) {
    const step = stitched(e) ? 2 : 1
    // Where a stitched strip's inner row starts and ends: at the corner, unless the edge before
    // (or after) is stitched too, when the two strips share the corner cell along its diagonal.
    const lo = stitched((e + 3) % 4) ? 1 : 0
    const hi = stitched((e + 1) % 4) ? side - 1 : side
    for (let half = 0; half < 2; half++) {
      const s0 = half * h
      const s1 = s0 + h
      const m = s0 + h / 2
      const q =
        e === 0
          ? quadrant(m, 0)
          : e === 1
            ? quadrant(side, m)
            : e === 2
              ? quadrant(side - m, side)
              : quadrant(0, side - m)
      if (!(mask & (1 << q))) continue
      outer.length = 0
      for (let s = s0; s <= s1; s += step) outer.push(s)
      if (stitched(e)) {
        inner.length = 0
        for (let s = Math.max(lo, s0); s <= Math.min(hi, s1); s++) inner.push(s)
        let a = 0
        let b = 0
        while (a < outer.length - 1 || b < inner.length - 1) {
          const advanceOuter =
            b === inner.length - 1 || (a < outer.length - 1 && outer[a + 1]! <= inner[b + 1]!)
          if (advanceOuter) {
            parts.push(at(e, outer[a]!, 0), at(e, outer[a + 1]!, 0), at(e, inner[b]!, 1))
            a++
          } else {
            parts.push(at(e, outer[a]!, 0), at(e, inner[b + 1]!, 1), at(e, inner[b]!, 1))
            b++
          }
        }
      }
      if (!skirts) continue
      for (let k = 0; k + 1 < outer.length; k++) {
        const va = at(e, outer[k]!, 0)
        const vb = at(e, outer[k + 1]!, 0)
        const sa = layout.surface + va
        const sb = layout.surface + vb
        skirt.push(va, sa, vb, vb, sa, sb, va, vb, sa, vb, sb, sa)
      }
    }
  }
  for (const v of skirt) parts.push(v)
  // Grid i, j run along a heightfield's +X and +Z: front faces turn counter-clockwise seen from
  // +Y, which is clockwise in (i, j).
  for (let t = 0; t < parts.length; t += 3) {
    const b = parts[t + 1]!
    parts[t + 1] = parts[t + 2]!
    parts[t + 2] = b
  }
  out = Uint16Array.from(parts)
  sets.set(key, out)
  return out
}

/** Throws `terrain/bad-resolution` unless `n` is 2^k + 1 (5 to 129). */
export function checkResolution(n: number): void {
  const k = Math.log2(n - 1)
  if (!Number.isInteger(k) || k < 2 || k > 7) {
    throw new ShardError('terrain/bad-resolution', `Planet resolution ${n} isn't 2^n + 1`, {
      hint: 'Use 17, 33 (the default), 65, or 129 vertices per chunk edge.',
    })
  }
}

export function chunkLayout(n: number): ChunkLayout {
  let layout = layouts.get(n)
  if (layout) return layout
  checkResolution(n)
  const ring = 4 * (n - 1)
  const surface = n * n
  const index = new Uint16Array(surface)
  const ringPoints = new Uint16Array(ring * 2)
  let r = 0
  const put = (i: number, j: number) => {
    index[i + j * n] = r
    ringPoints[r * 2] = i
    ringPoints[r * 2 + 1] = j
    r++
  }
  for (let i = 0; i < n - 1; i++) put(i, 0)
  for (let j = 0; j < n - 1; j++) put(n - 1, j)
  for (let i = n - 1; i > 0; i--) put(i, n - 1)
  for (let j = n - 1; j > 0; j--) put(0, j)
  let v = ring
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) index[i + j * n] = v++
  layout = {
    resolution: n,
    ring,
    surface,
    vertexCount: surface + ring,
    index,
    ringPoints,
    indices: new Uint16Array(0),
    surfaceIndices: new Uint16Array(0),
  }
  layouts.set(n, layout)
  layout.indices = chunkIndices(n, 15, 0, true)
  layout.surfaceIndices = chunkIndices(n, 15, 0, false)
  return layout
}

/**
 * A vertex's lock code (uv1.x): its edge for ring vertices (0 bottom, 1 right, 2 top, 3 left, where
 * the instance's lock bits apply), the quadrant boundary for vertices on the center lines (4 and 5
 * the vertical line's lower and upper half, 6 and 7 the horizontal line's left and right half, 8
 * the center; locked to this level where a partial draw meets a child), else −1.
 */
export function lockCode(i: number, j: number, n: number, vi: number, ring: number): number {
  if (vi < ring) return Math.floor(vi / (n - 1))
  const h = (n - 1) / 2
  if (i === h && j === h) return 8
  if (i === h) return j < h ? 4 : 5
  if (j === h) return i < h ? 6 : 7
  return -1
}
