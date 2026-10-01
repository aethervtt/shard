import {
  binLightsInto,
  COARSE_RES,
  LIGHT2D_FLOATS,
  type LightView2d,
  SHADOW_RES,
  TILE_STRIDE,
  type ViewGpu,
  writeShadowRow,
} from '../lights2d'

// Baseline tier (0064), loaded only on a baseline device: 2D lighting's compute work on the CPU,
// the same math as the GPU kernels (and their CPU references): lights binned into screen tiles,
// one polar shadow row per shadowed light, and each row's coarse min and max. They land in the
// fragment stage's data textures. A shadow row is made again only when its light moved or changed
// or the occluder segments did, and tiles upload only the span that changed.

const SPAN = SHADOW_RES / COARSE_RES

/** A view's CPU lighting: last frame's tiles and rows, and what each row was made from. */
interface CpuLighting {
  tiles: Uint32Array
  scratch: Uint32Array
  rows: Float32Array
  coarse: Float32Array
  /** Per row: light x, y, radius, layers; NaN when not made. */
  keys: Float64Array
}

const views = new WeakMap<LightView2d, CpuLighting>()

function stateOf(view: LightView2d): CpuLighting {
  let s = views.get(view)
  if (!s) {
    s = {
      tiles: new Uint32Array(0),
      scratch: new Uint32Array(0),
      rows: new Float32Array(0),
      coarse: new Float32Array(0),
      keys: new Float64Array(0),
    }
    views.set(view, s)
  }
  return s
}

/**
 * Bins, shadows and reduces a view's lights into its fragment-stage data textures. Returns the
 * bytes written. `segmentsChanged`: the occluder segments differ from last frame.
 */
export function lightOnCpu(view: LightView2d, g: ViewGpu, segmentsChanged: boolean): number {
  const s = stateOf(view)
  let bytes = 0
  // Tiles: binned into scratch, and only the changed span written.
  const words = view.tilesX * view.tilesY * TILE_STRIDE
  if (s.scratch.length < words) {
    s.scratch = new Uint32Array(words)
    const tiles = new Uint32Array(words)
    tiles.fill(0xffffffff) // unlike anything binned: the first frame writes it all
    s.tiles = tiles
  }
  binLightsInto(view.circles, view.count, view.tilesX, view.tilesY, s.scratch)
  let first = -1
  let last = -1
  for (let i = 0; i < words; i++) {
    // Indices past a tile's count are stale on the GPU too: only count and live indices matter,
    // but comparing all keeps this simple and exact.
    if (s.scratch[i] !== s.tiles[i]) {
      if (first < 0) first = i
      last = i
      s.tiles[i] = s.scratch[i]!
    }
  }
  if (first >= 0) {
    g.tiles.write(s.tiles, first * 4, first, last - first + 1)
    bytes += (last - first + 1) * 4
  }
  // Shadow rows, made again when their light or the segments changed.
  const rows = view.shadowedCount
  if (s.keys.length < rows * 4) {
    const keys = new Float64Array(Math.max(rows, 1) * 4 * 2).fill(Number.NaN)
    keys.set(s.keys)
    s.keys = keys
    const grown = new Float32Array((keys.length / 4) * SHADOW_RES)
    grown.set(s.rows)
    s.rows = grown
    const coarse = new Float32Array((keys.length / 4) * COARSE_RES * 2)
    coarse.set(s.coarse)
    s.coarse = coarse
  }
  let lo = -1
  let hi = -1
  for (let r = 0; r < rows; r++) {
    const o = view.shadowed[r]! * LIGHT2D_FLOATS
    const x = view.lights[o]!
    const y = view.lights[o + 1]!
    const radius = view.lights[o + 3]!
    const layers = view.lightBits[o + 14]!
    const k = r * 4
    if (
      !segmentsChanged &&
      s.keys[k] === x &&
      s.keys[k + 1] === y &&
      s.keys[k + 2] === radius &&
      s.keys[k + 3] === layers
    ) {
      continue
    }
    s.keys[k] = x
    s.keys[k + 1] = y
    s.keys[k + 2] = radius
    s.keys[k + 3] = layers
    const at = r * SHADOW_RES
    writeShadowRow(
      x,
      y,
      radius,
      layers,
      view.segments,
      view.segmentBits,
      view.segmentCount,
      s.rows,
      at,
    )
    // Coarse bins: the min and max of each 32 angles.
    for (let c = 0; c < COARSE_RES; c++) {
      let min = Number.POSITIVE_INFINITY
      let max = 0
      for (let i = 0; i < SPAN; i++) {
        const v = s.rows[at + c * SPAN + i]!
        if (v < min) min = v
        if (v > max) max = v
      }
      s.coarse[(r * COARSE_RES + c) * 2] = min
      s.coarse[(r * COARSE_RES + c) * 2 + 1] = max
    }
    if (lo < 0) lo = r
    hi = r
  }
  // Rows past the count keep old keys: a light shadowed again later is checked afresh.
  for (let r = rows; r < s.keys.length / 4; r++) s.keys[r * 4] = Number.NaN
  if (lo >= 0) {
    const n = hi - lo + 1
    g.shadowMap.write(s.rows, lo * SHADOW_RES * 4, lo * SHADOW_RES, n * SHADOW_RES)
    g.shadowCoarse.write(s.coarse, lo * COARSE_RES * 8, lo * COARSE_RES * 2, n * COARSE_RES * 2)
    bytes += n * (SHADOW_RES + COARSE_RES * 2) * 4
  }
  return bytes
}
