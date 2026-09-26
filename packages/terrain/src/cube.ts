import { directionToFace, faceToDirection } from '@shard/noise'

export { directionToFace, faceToDirection }

/** Deepest quadtree level: node keys hold 24 bits per axis. */
export const MAX_DEPTH = 24
/** Largest planet radius (m): 0.4 m spacing at depth 24 reaches about this far. */
export const MAX_RADIUS = 5e7

/** Edges of a node, counter-clockwise seen from outside: bottom (−v), right (+u), top (+v), left (−u). */
export const EDGE_BOTTOM = 0
export const EDGE_RIGHT = 1
export const EDGE_TOP = 2
export const EDGE_LEFT = 3

/** Face-coordinate side of a node at `depth`: a face spans [-1, 1], so 2 / 2^depth. */
export function nodeExtent(depth: number): number {
  return 2 / 2 ** depth
}

/** Metres between vertices at `depth` (along a face's middle): a face edge is a quarter circle. */
export function nodeSpacing(radius: number, depth: number, resolution: number): number {
  return (radius * Math.PI) / 2 / 2 ** depth / (resolution - 1)
}

/** The first depth whose vertex spacing is at most `minSpacing`, capped at `MAX_DEPTH`. */
export function maxDepthFor(radius: number, resolution: number, minSpacing: number): number {
  let d = 0
  while (d < MAX_DEPTH && nodeSpacing(radius, d, resolution) > minSpacing) d++
  return d
}

/**
 * Packs a node as two u32s: `face << 29 | depth << 24 | x` and `y` (3 + 5 + 24 + 24 bits). Stable
 * across runs and machines, so caches and saves can key by it.
 */
export function packKey(
  face: number,
  depth: number,
  x: number,
  y: number,
  out: Uint32Array,
  offset = 0,
): Uint32Array {
  out[offset] = ((face << 29) | (depth << 24) | x) >>> 0
  out[offset + 1] = y >>> 0
  return out
}

export interface NodeAddress {
  face: number
  depth: number
  x: number
  y: number
}

export function unpackKey(k0: number, k1: number): NodeAddress {
  return { face: k0 >>> 29, depth: (k0 >>> 24) & 31, x: k0 & 0xffffff, y: k1 >>> 0 }
}

/** A node as text, `face/depth/x/y` (cache keys, describe output). */
export function keyString(face: number, depth: number, x: number, y: number): string {
  return `${face}/${depth}/${x}/${y}`
}

export function parseKey(key: string): NodeAddress | undefined {
  const parts = key.split('/').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0)) return undefined
  const [face, depth, x, y] = parts as [number, number, number, number]
  if (face > 5 || depth > MAX_DEPTH || x >= 2 ** depth || y >= 2 ** depth) return undefined
  return { face, depth, x, y }
}

const dir = new Float64Array(3)
const uv = new Float64Array(2)

/**
 * The node at `depth` containing a unit direction: its face and cell, written into `out` as
 * [face, x, y].
 */
export function nodeAt(
  x: number,
  y: number,
  z: number,
  depth: number,
  out: { [i: number]: number },
): { [i: number]: number } {
  const face = directionToFace(x, y, z, uv)
  const n = 2 ** depth
  out[0] = face
  out[1] = Math.min(n - 1, Math.max(0, Math.floor(((uv[0]! + 1) / 2) * n)))
  out[2] = Math.min(n - 1, Math.max(0, Math.floor(((uv[1]! + 1) / 2) * n)))
  return out
}

/**
 * The same-depth neighbor across one edge, written into `out` as [face, x, y]. Across a cube edge
 * it's on another face, found through the direction just past the edge's middle (the grids of two
 * faces meet edge to edge at every depth).
 */
export function neighborNode(
  face: number,
  depth: number,
  x: number,
  y: number,
  edge: number,
  out: { [i: number]: number },
): { [i: number]: number } {
  const n = 2 ** depth
  let nx = x
  let ny = y
  if (edge === EDGE_BOTTOM) ny--
  else if (edge === EDGE_RIGHT) nx++
  else if (edge === EDGE_TOP) ny++
  else nx--
  if (nx >= 0 && ny >= 0 && nx < n && ny < n) {
    out[0] = face
    out[1] = nx
    out[2] = ny
    return out
  }
  const ext = 2 / n
  // A point a quarter node past the edge's middle, on the extended face plane.
  const u = -1 + (nx + 0.5) * ext
  const v = -1 + (ny + 0.5) * ext
  const pu =
    edge === EDGE_RIGHT || edge === EDGE_LEFT ? u + (edge === EDGE_RIGHT ? -0.25 : 0.25) * ext : u
  const pv =
    edge === EDGE_TOP || edge === EDGE_BOTTOM ? v + (edge === EDGE_TOP ? -0.25 : 0.25) * ext : v
  faceToDirection(face, pu, pv, dir)
  return nodeAt(dir[0]!, dir[1]!, dir[2]!, depth, out)
}
