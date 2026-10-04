// Interior lighting from the plan (0069): a sky visibility field per level, and polar rows that
// block lights at walls. Pure and headless: the plugin (interior-plugin.ts) feeds it structure's
// compiled shapes and uploads what it writes.
//
// The field is a screened diffusion over covered texels: each is the mean of the neighbours it
// isn't walled off from, times a factor set by the spill reach L (∇²u = u / L²), with uncovered
// texels fixed at 1. A wide opening lets in more than a narrow one, light bends around corners
// at a falling rate, and a sealed room settles at 0.

import {
  COVER_SCALE,
  COVER_ZERO,
  LINK_X,
  LINK_Z,
  ROW_CLEAR,
  ROW_SCALE,
  ROW_ZERO,
  VISIBILITY_MAX,
} from '@aethervtt/shard-render'
import type { FloorShape } from './geometry'

export { LINK_X, LINK_Z }

/** The field's grid: origin (x, z) of texel (0, 0)'s corner, texel size, size in texels. */
export interface FieldGrid {
  ox: number
  oz: number
  texel: number
  width: number
  height: number
}

/** A rectangle of texels, [x0, x1) × [z0, z1). */
export interface TexelRect {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** A world rectangle, [minX, maxX] × [minZ, maxZ]. */
export interface Bounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** A barrier for the field and the rows: a segment, its top (y), and its wall's thickness. */
export interface Barrier {
  ax: number
  az: number
  bx: number
  bz: number
  /** World y of its top, for wall-blocked lights (a window's sill, a low wall's top). */
  top: number
  thickness: number
  /** Blocks the field's spill (a gap for the field may still block low for the rows). */
  field: boolean
}

/** A cover: a slab outline (holes included) whose surface stands over the layer. */
export interface Cover {
  shape: FloorShape
  /** Rings of closed hatches: they cover though their hole is in the shape. */
  closed: readonly number[]
}

/** One level's field: cover, links and visibility per texel. */
export class FieldLayer {
  /** Cover top y over the layer's base, per texel; Infinity where uncovered. */
  cover: Float32Array
  /** LINK_X | LINK_Z: flux to the +x and +z neighbour is blocked. */
  links: Uint8Array
  /** The solve's visibility, before the blur: a region re-solve starts from it. */
  value: Float32Array
  /** What uploads: blurred visibility, links and cover, packed (see `packTexel`). */
  packed: Uint32Array
  /** The y cover heights count from: the level's elevation (the ground level's is 0). */
  base = 0

  constructor(width: number, height: number) {
    const n = width * height
    this.cover = new Float32Array(n).fill(Number.POSITIVE_INFINITY)
    this.links = new Uint8Array(n)
    this.value = new Float32Array(n).fill(1)
    this.packed = new Uint32Array(n)
  }
}

/** Scratch shared by solves: reused, grown when a solve needs more. */
export class SolveScratch {
  blurred = new Float32Array(0)
  /** Per texel: neighbours reached, and 1 / (their count + κ). */
  mask = new Uint8Array(0)
  inv = new Float32Array(0)
  /** Per tile: how far its texels moved in the last sweep, and in this one. */
  moved = new Float32Array(0)
  movedNext = new Float32Array(0)
  crossings = new Float64Array(64)
  /** Aggregation (the coarse pass): aggregate per texel, and per aggregate its sums. */
  agg = new Int32Array(0)
  aggValue = new Float64Array(0)
  aggDiag = new Float64Array(0)
  aggRhs = new Float64Array(0)
  /** Coarse couplings as CSR. */
  rowStart = new Int32Array(0)
  colIndex = new Int32Array(0)
  weight = new Float64Array(0)
  stack = new Int32Array(0)

  ensure(n: number): void {
    if (this.blurred.length < n) this.blurred = new Float32Array(n)
    if (this.mask.length < n) {
      this.mask = new Uint8Array(n)
      this.inv = new Float32Array(n)
    }
    if (this.agg.length < n) {
      this.agg = new Int32Array(n)
      this.stack = new Int32Array(n)
    }
  }
}

/** Texels of `rect` clipped to the grid. */
export function clipRect(grid: FieldGrid, r: TexelRect): TexelRect {
  return {
    x0: Math.max(0, r.x0),
    z0: Math.max(0, r.z0),
    x1: Math.min(grid.width, r.x1),
    z1: Math.min(grid.height, r.z1),
  }
}

/** The texels whose centres lie within `b` grown by `grow` metres, clipped to the grid. */
export function texelsOf(grid: FieldGrid, b: Bounds, grow: number): TexelRect {
  const t = grid.texel
  return clipRect(grid, {
    x0: Math.floor((b.minX - grow - grid.ox) / t - 0.5),
    z0: Math.floor((b.minZ - grow - grid.oz) / t - 0.5),
    x1: Math.ceil((b.maxX + grow - grid.ox) / t - 0.5) + 1,
    z1: Math.ceil((b.maxZ + grow - grid.oz) / t - 0.5) + 1,
  })
}

// ---------------------------------------------------------------------------------------------
// Rasterizing

/**
 * Covers the texels of `rect` whose centres are inside `cover` (even-odd over its rings, so
 * holes stay open; closed hatches cover again): each keeps the lowest cover top over `base`.
 */
export function rasterCover(
  grid: FieldGrid,
  layer: FieldLayer,
  cover: Cover,
  rect: TexelRect,
  base: number,
  scratch: SolveScratch,
): void {
  const f = cover.shape
  const t = grid.texel
  const z0 = Math.max(rect.z0, Math.floor((f.minZ - grid.oz) / t - 0.5))
  const z1 = Math.min(rect.z1, Math.ceil((f.maxZ - grid.oz) / t - 0.5) + 1)
  const rings = f.rings.length - 1
  for (let z = z0; z < z1; z++) {
    const zc = grid.oz + (z + 0.5) * t
    let n = 0
    for (let r = 0; r < rings; r++) {
      // Closed hatches cover: their ring stays out of the crossings.
      if (r > 0 && cover.closed.includes(r)) continue
      n = crossings(f.points, f.rings[r]!, f.rings[r + 1]!, zc, scratch, n)
    }
    fillSpans(grid, layer, f, rect, z, zc, base, scratch.crossings, n)
    // A closed hatch's own outline, at its host's height.
    for (const r of cover.closed) {
      const m = crossings(f.points, f.rings[r]!, f.rings[r + 1]!, zc, scratch, 0)
      fillSpans(grid, layer, f, rect, z, zc, base, scratch.crossings, m)
    }
  }
}

/** Appends the x where ring [start, end)'s edges cross z = zc (half-open in z), sorted at the end. */
function crossings(
  p: Float64Array,
  start: number,
  end: number,
  zc: number,
  scratch: SolveScratch,
  n: number,
): number {
  for (let i = start, j = end - 1; i < end; j = i++) {
    const zi = p[i * 2 + 1]!
    const zj = p[j * 2 + 1]!
    if (zi > zc === zj > zc) continue
    const xi = p[i * 2]!
    const xj = p[j * 2]!
    if (n >= scratch.crossings.length) {
      const grown = new Float64Array(scratch.crossings.length * 2)
      grown.set(scratch.crossings)
      scratch.crossings = grown
    }
    scratch.crossings[n++] = xi + ((zc - zi) * (xj - xi)) / (zj - zi)
  }
  return n
}

function fillSpans(
  grid: FieldGrid,
  layer: FieldLayer,
  f: FloorShape,
  rect: TexelRect,
  z: number,
  zc: number,
  base: number,
  xs: Float64Array,
  n: number,
): void {
  const list = xs.subarray(0, n).sort()
  const t = grid.texel
  const w = grid.width
  for (let k = 0; k + 1 < n; k += 2) {
    // Texel centres in [xs[k], xs[k + 1]).
    const a = Math.max(rect.x0, Math.ceil((list[k]! - grid.ox) / t - 0.5))
    const b = Math.min(rect.x1, Math.ceil((list[k + 1]! - grid.ox) / t - 0.5))
    for (let x = a; x < b; x++) {
      const xc = grid.ox + (x + 0.5) * t
      const y = f.elevation + f.slope * (xc * f.rx + zc * f.rz - f.d0) - base
      const i = z * w + x
      if (y < layer.cover[i]!) layer.cover[i] = y
    }
  }
}

/**
 * Marks the links of `rect`'s texels (each texel owns its links to +x and +z) that a barrier
 * crosses: the segment meets the line between the two centres, ends included, so walls meeting
 * at a corner leave no crack.
 */
export function rasterBarrier(
  grid: FieldGrid,
  layer: FieldLayer,
  s: Barrier,
  rect: TexelRect,
): void {
  const t = grid.texel
  const w = grid.width
  const eps = 1e-6
  const dx = s.bx - s.ax
  const dz = s.bz - s.az
  // Links along x lie on rows of centres: where the segment crosses each row's line.
  if (Math.abs(dz) > 1e-12) {
    const lo = Math.min(s.az, s.bz) - eps
    const hi = Math.max(s.az, s.bz) + eps
    const z0 = Math.max(rect.z0, Math.ceil((lo - grid.oz) / t - 0.5))
    const z1 = Math.min(rect.z1 - 1, Math.floor((hi - grid.oz) / t - 0.5))
    for (let z = z0; z <= z1; z++) {
      const zc = grid.oz + (z + 0.5) * t
      const u = Math.min(1, Math.max(0, (zc - s.az) / dz))
      const x = s.ax + u * dx
      // The link from centre i to i + 1 holds x when centre i ≤ x ≤ centre i + 1.
      const f = (x - grid.ox) / t - 0.5
      let i = Math.floor(f)
      markX(layer, rect, w, i, z)
      // Exactly on a centre: both links touching it.
      if (Math.abs(f - Math.round(f)) < 1e-9) {
        i = Math.round(f)
        markX(layer, rect, w, i - 1, z)
        markX(layer, rect, w, i, z)
      }
    }
  }
  if (Math.abs(dx) > 1e-12) {
    const lo = Math.min(s.ax, s.bx) - eps
    const hi = Math.max(s.ax, s.bx) + eps
    const x0 = Math.max(rect.x0, Math.ceil((lo - grid.ox) / t - 0.5))
    const x1 = Math.min(rect.x1 - 1, Math.floor((hi - grid.ox) / t - 0.5))
    for (let x = x0; x <= x1; x++) {
      const xc = grid.ox + (x + 0.5) * t
      const u = Math.min(1, Math.max(0, (xc - s.ax) / dx))
      const z = s.az + u * dz
      const f = (z - grid.oz) / t - 0.5
      let j = Math.floor(f)
      markZ(layer, rect, w, x, j)
      if (Math.abs(f - Math.round(f)) < 1e-9) {
        j = Math.round(f)
        markZ(layer, rect, w, x, j - 1)
        markZ(layer, rect, w, x, j)
      }
    }
  }
}

function markX(layer: FieldLayer, rect: TexelRect, w: number, x: number, z: number): void {
  if (x >= rect.x0 && x < rect.x1 && z >= rect.z0 && z < rect.z1) layer.links[z * w + x]! |= LINK_X
}

function markZ(layer: FieldLayer, rect: TexelRect, w: number, x: number, z: number): void {
  if (x >= rect.x0 && x < rect.x1 && z >= rect.z0 && z < rect.z1) layer.links[z * w + x]! |= LINK_Z
}

/** Clears `rect`'s cover and links, before they're rasterized again. */
export function clearRect(grid: FieldGrid, layer: FieldLayer, rect: TexelRect): void {
  const w = grid.width
  for (let z = rect.z0; z < rect.z1; z++) {
    layer.cover.fill(Number.POSITIVE_INFINITY, z * w + rect.x0, z * w + rect.x1)
    layer.links.fill(0, z * w + rect.x0, z * w + rect.x1)
  }
}

// ---------------------------------------------------------------------------------------------
// Solving

/** κ = h² / L²: the screening term of a texel h wide for spill reach L. */
export function screening(texel: number, reach: number): number {
  return (texel * texel) / Math.max(reach * reach, 1e-12)
}

/** SOR's relaxation for the screened Laplacian: optimal for its slowest mode. */
export function relaxation(kappa: number): number {
  const rho = 4 / (4 + kappa)
  return 2 / (1 + Math.sqrt(1 - rho * rho))
}

/** Tiles the sweeps skip once settled, in texels. */
const TILE = 16

/** Options of a solve. */
export interface SolveOptions {
  /** Spill reach (m). */
  reach: number
  /** Stop once no texel moves more than this in a sweep. */
  tolerance?: number
  /** At most this many sweeps at the texel size. */
  maxSweeps?: number
  /** Start from an aggregated coarse solve (whole-field solves); a region starts from its old values. */
  coarse?: boolean
  /** Coarse cells, in texels: about 1 m. */
  coarseCells?: number
}

/** What a solve did. */
export interface SolveReport {
  texels: number
  sweeps: number
  coarseSweeps: number
}

/**
 * Solves `rect` of a layer: uncovered texels are 1, covered ones the screened diffusion, with
 * texels outside the rect held at their values. Then blurs and packs `rect` grown by a texel
 * (`packRect` reads it back). Whole-field solves start from a coarse pass over ~1 m aggregates;
 * a region starts from the values it had, which an edit changes only near it.
 */
export function solveRect(
  grid: FieldGrid,
  layer: FieldLayer,
  rect: TexelRect,
  options: SolveOptions,
  scratch: SolveScratch,
): SolveReport {
  const w = grid.width
  const h = grid.height
  const kappa = screening(grid.texel, options.reach)
  const omega = relaxation(kappa)
  const tolerance = options.tolerance ?? 1e-4
  const maxSweeps = options.maxSweeps ?? 2000
  const v = layer.value
  const cover = layer.cover
  const links = layer.links
  scratch.ensure(w * h)
  const mask = scratch.mask
  const inv = scratch.inv
  const linkX = LINK_X
  const linkZ = LINK_Z
  // Per texel: which neighbours it reaches (1 +x, 2 −x, 4 +z, 8 −z; 0 uncovered) and 1 / (n + κ).
  let texels = 0
  for (let z = rect.z0; z < rect.z1; z++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = z * w + x
      if (cover[i] === Number.POSITIVE_INFINITY) {
        v[i] = 1
        mask[i] = 0
        continue
      }
      texels++
      let m = 16
      let n = 0
      if (x + 1 < w && (links[i]! & linkX) === 0) {
        m |= 1
        n++
      }
      if (x > 0 && (links[i - 1]! & linkX) === 0) {
        m |= 2
        n++
      }
      if (z + 1 < h && (links[i]! & linkZ) === 0) {
        m |= 4
        n++
      }
      if (z > 0 && (links[i - w]! & linkZ) === 0) {
        m |= 8
        n++
      }
      mask[i] = m
      inv[i] = 1 / (n + kappa)
    }
  }
  let coarseSweeps = 0
  if (options.coarse && texels > 0)
    coarseSweeps = coarsePass(grid, layer, rect, kappa, options.coarseCells ?? 4, scratch)
  let sweeps = 0
  if (texels > 0) {
    // Tiles of TILE² texels: a tile is swept while it, or a neighbour, moved last sweep.
    const tx = Math.ceil((rect.x1 - rect.x0) / TILE)
    const tz = Math.ceil((rect.z1 - rect.z0) / TILE)
    const tiles = tx * tz
    if (scratch.moved.length < tiles) {
      scratch.moved = new Float32Array(tiles)
      scratch.movedNext = new Float32Array(tiles)
    }
    let moved = scratch.moved
    let next = scratch.movedNext
    moved.fill(1, 0, tiles)
    for (; sweeps < maxSweeps; sweeps++) {
      let most = 0
      for (let b = 0; b < tz; b++) {
        for (let a = 0; a < tx; a++) {
          const t = b * tx + a
          if (
            moved[t]! < tolerance &&
            (a === 0 || moved[t - 1]! < tolerance) &&
            (a + 1 === tx || moved[t + 1]! < tolerance) &&
            (b === 0 || moved[t - tx]! < tolerance) &&
            (b + 1 === tz || moved[t + tx]! < tolerance)
          ) {
            next[t] = 0
            continue
          }
          let tileMost = 0
          const x0 = rect.x0 + a * TILE
          const x1 = Math.min(rect.x1, x0 + TILE)
          const z0 = rect.z0 + b * TILE
          const z1 = Math.min(rect.z1, z0 + TILE)
          for (let z = z0; z < z1; z++) {
            for (let i = z * w + x0, end = z * w + x1; i < end; i++) {
              const m = mask[i]!
              if (m === 0) continue
              let sum = 0
              if (m & 1) sum += v[i + 1]!
              if (m & 2) sum += v[i - 1]!
              if (m & 4) sum += v[i + w]!
              if (m & 8) sum += v[i - w]!
              const old = v[i]!
              let value = old + omega * (sum * inv[i]! - old)
              if (value < 0) value = 0
              else if (value > 1) value = 1
              v[i] = value
              const d = value > old ? value - old : old - value
              if (d > tileMost) tileMost = d
            }
          }
          next[t] = tileMost
          if (tileMost > most) most = tileMost
        }
      }
      const swap = moved
      moved = next
      next = swap
      if (most < tolerance) {
        sweeps++
        break
      }
    }
    scratch.moved = moved
    scratch.movedNext = next
  }
  return { texels, sweeps, coarseSweeps }
}

/**
 * The coarse pass: covered texels grouped by `cells`×`cells` block and by what's connected inside
 * it (a wall through a block makes two aggregates), solved with couplings scaled to the coarse
 * spacing, and spread back as the fine solve's start.
 */
function coarsePass(
  grid: FieldGrid,
  layer: FieldLayer,
  rect: TexelRect,
  kappa: number,
  cells: number,
  scratch: SolveScratch,
): number {
  const w = grid.width
  const n = w * grid.height
  scratch.ensure(n)
  const agg = scratch.agg
  const cover = layer.cover
  const links = layer.links
  const v = layer.value
  const stack = scratch.stack
  for (let z = rect.z0; z < rect.z1; z++) agg.fill(-1, z * w + rect.x0, z * w + rect.x1)
  // Aggregates: flood each block's covered texels through open links.
  let count = 0
  for (let z = rect.z0; z < rect.z1; z++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const seed = z * w + x
      if (agg[seed] !== -1 || cover[seed] === Number.POSITIVE_INFINITY) continue
      const bx = Math.floor((x - rect.x0) / cells)
      const bz = Math.floor((z - rect.z0) / cells)
      const id = count++
      let top = 0
      stack[top++] = seed
      agg[seed] = id
      while (top > 0) {
        const i = stack[--top]!
        const ix = i % w
        const iz = (i - ix) / w
        for (let k = 0; k < 4; k++) {
          let j: number
          let open: boolean
          if (k === 0) {
            j = i + 1
            open = ix + 1 < rect.x1 && (links[i]! & LINK_X) === 0
          } else if (k === 1) {
            j = i - 1
            open = ix > rect.x0 && (links[i - 1]! & LINK_X) === 0
          } else if (k === 2) {
            j = i + w
            open = iz + 1 < rect.z1 && (links[i]! & LINK_Z) === 0
          } else {
            j = i - w
            open = iz > rect.z0 && (links[i - w]! & LINK_Z) === 0
          }
          if (!open || agg[j] !== -1 || cover[j] === Number.POSITIVE_INFINITY) continue
          const jx = j % w
          const jz = (j - jx) / w
          if (
            Math.floor((jx - rect.x0) / cells) !== bx ||
            Math.floor((jz - rect.z0) / cells) !== bz
          )
            continue
          agg[j] = id
          stack[top++] = j
        }
      }
    }
  }
  if (count === 0) return 0
  if (scratch.aggValue.length < count) {
    scratch.aggValue = new Float64Array(count * 2)
    scratch.aggDiag = new Float64Array(count * 2)
    scratch.aggRhs = new Float64Array(count * 2)
    scratch.rowStart = new Int32Array(count * 2 + 1)
  }
  const diag = scratch.aggDiag
  const rhs = scratch.aggRhs
  const value = scratch.aggValue
  diag.fill(0, 0, count)
  rhs.fill(0, 0, count)
  // Couplings: each open link between aggregates counts 1 / cells (the coarse spacing is `cells`
  // texels), each texel κ. Links to fixed texels (uncovered, or outside the rect) feed the rhs.
  const scale = 1 / cells
  const pairs = new Map<number, number>()
  const h = grid.height
  const aggIn = (i: number): number => {
    const x = i % w
    const z = (i - x) / w
    return x >= rect.x0 && x < rect.x1 && z >= rect.z0 && z < rect.z1 ? agg[i]! : -1
  }
  const pair = (i: number, j: number) => {
    const a = aggIn(i)
    const b = aggIn(j)
    if (a === b) return
    if (a >= 0 && b >= 0) {
      diag[a] = diag[a]! + scale
      diag[b] = diag[b]! + scale
      const key = a < b ? a * count + b : b * count + a
      pairs.set(key, (pairs.get(key) ?? 0) + scale)
    } else if (a >= 0) {
      // j is held: uncovered (1), or outside the rect at its value.
      diag[a] = diag[a]! + scale
      rhs[a] = rhs[a]! + scale * v[j]!
    } else {
      diag[b] = diag[b]! + scale
      rhs[b] = rhs[b]! + scale * v[i]!
    }
  }
  for (let z = Math.max(0, rect.z0 - 1); z < Math.min(h, rect.z1 + 1); z++) {
    for (let x = Math.max(0, rect.x0 - 1); x < Math.min(w, rect.x1 + 1); x++) {
      const i = z * w + x
      const a = aggIn(i)
      if (a >= 0) diag[a] = diag[a]! + kappa
      if (x + 1 < w && (links[i]! & LINK_X) === 0) pair(i, i + 1)
      if (z + 1 < h && (links[i]! & LINK_Z) === 0) pair(i, i + w)
    }
  }
  // CSR from the pairs.
  const rowStart = scratch.rowStart
  rowStart.fill(0, 0, count + 1)
  for (const key of pairs.keys()) {
    const a = Math.floor(key / count)
    const b = key - a * count
    rowStart[a + 1]!++
    rowStart[b + 1]!++
  }
  for (let a = 0; a < count; a++) rowStart[a + 1] = rowStart[a + 1]! + rowStart[a]!
  const nnz = rowStart[count]!
  if (scratch.colIndex.length < nnz) {
    scratch.colIndex = new Int32Array(nnz * 2)
    scratch.weight = new Float64Array(nnz * 2)
  }
  const col = scratch.colIndex
  const weight = scratch.weight
  const fill = new Int32Array(count)
  for (const [key, g] of pairs) {
    const a = Math.floor(key / count)
    const b = key - a * count
    let o = rowStart[a]! + fill[a]!++
    col[o] = b
    weight[o] = g
    o = rowStart[b]! + fill[b]!++
    col[o] = a
    weight[o] = g
  }
  // Start from the aggregates' mean value, then SOR on the coarse system.
  value.fill(0, 0, count)
  const coarseKappa = kappa * cells * cells
  const omega = relaxation(coarseKappa)
  let sweeps = 0
  for (; sweeps < 500; sweeps++) {
    let moved = 0
    for (let a = 0; a < count; a++) {
      let sum = rhs[a]!
      for (let o = rowStart[a]!; o < rowStart[a + 1]!; o++) sum += weight[o]! * value[col[o]!]!
      const old = value[a]!
      const next = Math.min(1, Math.max(0, old + omega * (sum / diag[a]! - old)))
      value[a] = next
      const d = Math.abs(next - old)
      if (d > moved) moved = d
    }
    if (moved < 1e-5) break
  }
  for (let z = rect.z0; z < rect.z1; z++)
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = z * w + x
      if (agg[i]! >= 0) v[i] = value[agg[i]!]!
    }
  return sweeps + 1
}

/**
 * Blurs `rect` of the solved values once (each covered texel with the neighbours it isn't walled
 * off from, itself weighted 4) and packs it for upload. Uncovered texels stay 1.
 */
export function packRect(
  grid: FieldGrid,
  layer: FieldLayer,
  rect: TexelRect,
  scratch: SolveScratch,
): void {
  const w = grid.width
  const h = grid.height
  scratch.ensure(w * h)
  const v = layer.value
  const links = layer.links
  const cover = layer.cover
  const packed = layer.packed
  // Imports read once: a bundler inlines them, a module loader may not.
  const visMax = VISIBILITY_MAX
  const coverScale = COVER_SCALE
  const coverZero = COVER_ZERO
  const linkX = LINK_X
  const linkZ = LINK_Z
  for (let z = rect.z0; z < rect.z1; z++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = z * w + x
      const c = cover[i]!
      if (c === Number.POSITIVE_INFINITY) {
        packed[i] = (visMax << 2) | (links[i]! & 3)
        continue
      }
      let out: number
      {
        let sum = 4 * v[i]!
        let n = 4
        if (x + 1 < w && (links[i]! & linkX) === 0) {
          sum += v[i + 1]!
          n++
        }
        if (x > 0 && (links[i - 1]! & linkX) === 0) {
          sum += v[i - 1]!
          n++
        }
        if (z + 1 < h && (links[i]! & linkZ) === 0) {
          sum += v[i + w]!
          n++
        }
        if (z > 0 && (links[i - w]! & linkZ) === 0) {
          sum += v[i - w]!
          n++
        }
        out = sum / n
      }
      // packTexel, inlined: this runs over every texel of a whole-field solve.
      const vis = (Math.min(1, Math.max(0, out)) * visMax + 0.5) | 0
      let code = Math.round(c * coverScale) + coverZero
      code = code < 1 ? 1 : code > 65535 ? 65535 : code
      packed[i] = ((code << 16) | (vis << 2) | (links[i]! & 3)) >>> 0
    }
  }
}

/** A field texel as uploaded: visibility (14 bits) over the link bits, the cover code above. */
export function packTexel(visibility: number, links: number, cover: number): number {
  const vis = Math.round(Math.min(1, Math.max(0, visibility)) * VISIBILITY_MAX)
  const code =
    cover === Number.POSITIVE_INFINITY
      ? 0
      : Math.min(65535, Math.max(1, Math.round(cover * COVER_SCALE) + COVER_ZERO))
  return ((code << 16) | (vis << 2) | (links & 3)) >>> 0
}

/** The uploaded visibility of a packed texel. */
export function unpackVisibility(texel: number): number {
  return ((texel & 0xffff) >>> 2) / VISIBILITY_MAX
}

// ---------------------------------------------------------------------------------------------
// Light rows

const directions = new Map<number, { cos: Float64Array; sin: Float64Array }>()

/**
 * A direction's place around the circle, 0 to 1 from −x counter-clockwise (+x at ½): the pseudo-
 * angle `interior_bin` in the lighting stage reads bins by (one division, not an atan2).
 */
export function binOf(x: number, z: number): number {
  const t = z / (Math.abs(x) + Math.abs(z))
  const p = x < 0 ? 2 - t : t >= 0 ? t : 4 + t
  const u = p * 0.25 + 0.5
  return u - Math.floor(u)
}

/** The unit direction at a place around the circle (`binOf`'s inverse). */
function directionAt(u: number, out: Float64Array, k: number, sin: Float64Array): void {
  let p = (u - 0.5) * 4
  if (p < 0) p += 4
  let x: number
  let z: number
  if (p < 1) {
    z = p
    x = 1 - p
  } else if (p < 3) {
    z = 2 - p
    x = -(1 - Math.abs(z))
  } else {
    z = p - 4
    x = 1 - Math.abs(z)
  }
  const len = Math.sqrt(x * x + z * z)
  out[k] = x / len
  sin[k] = z / len
}

/** Each bin's centre direction. */
function binDirections(bins: number) {
  let d = directions.get(bins)
  if (!d) {
    d = { cos: new Float64Array(bins), sin: new Float64Array(bins) }
    for (let k = 0; k < bins; k++) directionAt((k + 0.5) / bins, d.cos, k, d.sin)
    directions.set(bins, d)
  }
  return d
}

/** Scratch for `buildRow`. */
export class RowScratch {
  distance = new Float64Array(0)
  top = new Float64Array(0)
  ensure(bins: number): void {
    if (this.distance.length < bins) {
      this.distance = new Float64Array(bins)
      this.top = new Float64Array(bins)
    }
  }
}

/** How far behind a barrier's centreline a receiver counts as behind it: a quarter of its thickness, at most 5 cm. */
export function rowBias(thickness: number): number {
  return Math.min(thickness / 4, 0.05)
}

/**
 * A light's polar row: per bin, the distance to the nearest barrier along the bin's direction
 * within `range` (plus its bias), and that barrier's top, packed for upload (`ROW_*`). Only the
 * first `count` barriers are tested: the caller gathers the ones near the light.
 */
export function buildRow(
  out: Uint32Array,
  x: number,
  y: number,
  z: number,
  range: number,
  barriers: readonly Barrier[],
  count: number,
  scratch: RowScratch,
): void {
  const bins = out.length
  scratch.ensure(bins)
  const dist = scratch.distance
  const top = scratch.top
  dist.fill(Number.POSITIVE_INFINITY, 0, bins)
  const { cos, sin } = binDirections(bins)
  for (let n = 0; n < count; n++) {
    const s = barriers[n]!
    const ax = s.ax - x
    const az = s.az - z
    const ex = s.bx - s.ax
    const ez = s.bz - s.az
    const l2 = ex * ex + ez * ez
    if (l2 < 1e-12) continue
    // Nearest point of the segment: past the range, it can't block.
    const u0 = Math.min(1, Math.max(0, -(ax * ex + az * ez) / l2))
    const px = ax + u0 * ex
    const pz = az + u0 * ez
    const near = Math.sqrt(px * px + pz * pz)
    if (near > range || near < 1e-6) continue
    // The bins between its ends, the short way round (a segment not through the light spans
    // less than half the circle).
    const ua = binOf(ax, az)
    const ub = binOf(ax + ex, az + ez)
    let span = ub - ua
    if (span > 0.5) span -= 1
    else if (span < -0.5) span += 1
    const start = span >= 0 ? ua : ub
    const k0 = Math.ceil(start * bins - 0.5)
    const k1 = Math.floor((start + Math.abs(span)) * bins - 0.5)
    const bias = rowBias(s.thickness)
    for (let kk = k0; kk <= k1; kk++) {
      const k = ((kk % bins) + bins) % bins
      const dx = cos[k]!
      const dz = sin[k]!
      const denom = dx * ez - dz * ex
      if (Math.abs(denom) < 1e-12) continue
      const t = (ax * ez - az * ex) / denom
      const u = (ax * dz - az * dx) / denom
      if (t <= 0 || t > range || u < -1e-9 || u > 1 + 1e-9) continue
      const r = t + bias
      if (r < dist[k]!) {
        dist[k] = r
        top[k] = s.top
      }
    }
  }
  for (let k = 0; k < bins; k++) {
    const r = dist[k]!
    if (r === Number.POSITIVE_INFINITY) {
      out[k] = ROW_CLEAR
      continue
    }
    const d = Math.min(0xfffe, Math.round(r * ROW_SCALE))
    const h = Math.min(0xffff, Math.max(0, Math.round((top[k]! - y) * ROW_SCALE) + ROW_ZERO))
    out[k] = ((h << 16) | d) >>> 0
  }
}

/** A row bin's barrier distance (Infinity for none) and top (relative to the light's y). */
export function unpackBin(bin: number): { distance: number; top: number } {
  const d = bin & 0xffff
  return {
    distance: d === 0xffff ? Number.POSITIVE_INFINITY : d / ROW_SCALE,
    top: ((bin >>> 16) - ROW_ZERO) / ROW_SCALE,
  }
}
