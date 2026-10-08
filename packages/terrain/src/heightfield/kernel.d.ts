// Types for kernel.js (plain JavaScript so worker threads can import it without a loader).

export { deflate, inflate } from './deflate.js'

export declare const PAGE: number
export declare const SIDE: number
export declare const LEAF_SIDE: number
export declare const BLOCK: number
export declare const LATTICE: number
export declare const BLOCK_LEVELS: number
export declare const BAKE_VERSION: number

export declare const BLEND_ADD: 0
export declare const BLEND_MAX: 1
export declare const BLEND_MIN: 2
export declare const BLEND_REPLACE: 3
export declare const MODE_FLATTEN: 0
export declare const MODE_RAISE: 1
export declare const MODE_CARVE: 2
export declare const LAYER_NOISE: 0
export declare const LAYER_IMAGE: 1
export declare const LAYER_SPLINE: 2

/** The noise kernel a bake samples with: this thread's instance and its functions. */
export interface NoiseAccess {
  readonly state: unknown
  computeOrigins(terms: unknown, origin: ArrayLike<number>, out: Int32Array): Int32Array
  evalProgram(
    state: unknown,
    program: unknown,
    seed: number,
    origins: Int32Array,
    pts: ArrayLike<number>,
    stride: number,
    count: number,
    out: Float32Array,
  ): void
}

/** A compiled noise program as the kernel reads it (`NoiseGraph.programFor`). */
export interface StackProgram {
  readonly terms: unknown
  readonly zeroOrigins: Int32Array
  readonly [key: string]: unknown
}

/** A heightmap: values 0–1, row by row, top row first. */
export interface StackMap {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
}

/** A rotated rectangle: center, half width and depth, and its rotation's cosine and sine. */
export interface StackRect {
  readonly cx: number
  readonly cz: number
  readonly hw: number
  readonly hd: number
  readonly cos: number
  readonly sin: number
}

/** A spline ready for distance queries (buildSpline). */
export interface StackSpline {
  readonly pts: Float64Array
  readonly count: number
  readonly width: number
  readonly falloff: number
  readonly reach: number
  readonly cell: number
  readonly x0: number
  readonly z0: number
  readonly cols: number
  readonly rows: number
  readonly start: Int32Array
  readonly segs: Int32Array
  readonly minX: number
  readonly minZ: number
  readonly maxX: number
  readonly maxZ: number
}

export type StackHeightLayer =
  | {
      readonly kind: 0
      readonly program: StackProgram
      readonly scale: number
      readonly offset: number
      readonly blend: number
      readonly rect: StackRect | null
      readonly falloff: number
    }
  | {
      readonly kind: 1
      readonly map: StackMap
      readonly rect: StackRect
      readonly lo: number
      readonly hi: number
      readonly blend: number
      readonly falloff: number
    }
  | {
      readonly kind: 2
      readonly spline: StackSpline
      readonly mode: number
      readonly offset: number
      readonly falloff: number
    }

export interface StackPaint {
  /** Material layer index. */
  readonly layer: number
  readonly height: readonly [number, number] | null
  readonly slope: readonly [number, number] | null
  readonly noise: { readonly program: StackProgram; readonly above: number } | null
  readonly mask: { readonly map: StackMap; readonly rect: StackRect } | null
  readonly spline: StackSpline | null
  /** Edge softness: metres for height, masks and splines, degrees for slope. */
  readonly blend: number
}

/** A terrain source compiled for the kernel (heightfield/stack.ts): structured-cloneable. */
export interface Stack {
  readonly spacing: number
  readonly seed: number
  readonly lo: number
  readonly hi: number
  readonly layerCount: number
  readonly height: readonly StackHeightLayer[]
  readonly paint: readonly StackPaint[]
}

/** What bakeBlock needs of the terrain's grid (heightfield/source.ts TerrainLayout). */
export interface KernelLayout {
  readonly depth: number
  readonly spacing: number
  readonly leavesX: number
  readonly leavesZ: number
  /** Leaf samples per paint sample. */
  readonly paintStep: number
  /** Paint cells per page side. */
  readonly cells: number
  /** Leaves per block side (BLOCK; smaller in tests), and log2 of it. */
  readonly block: number
  readonly blockLevels: number
}

/** A decoded page: u16 heights (LEAF_SIDE² for leaves, SIDE² for parents), normals, control. */
export interface DecodedPage {
  readonly heights: Uint16Array
  /** Parents: x then z planes, SIDE² bytes each. Leaves: null (their heights make them). */
  readonly normals: Uint8Array | null
  /** (cells + 1)² texels of four bytes: heaviest layer, second, its share, hole bit. */
  readonly control: Uint8Array
}

/** A baked page: its level above the leaves, node coordinates at that level, and deflated bytes. */
export interface BakedPage {
  level: number
  x: number
  z: number
  data: Uint8Array
  /** Quantized height range over the node (its whole subtree). */
  min: number
  max: number
  /** Exact geometric error (m): the largest gap between its subtree's samples and its surface. */
  error: number
}

export interface BlockResult {
  pages: BakedPage[]
  /** Errors of the levels above the block's own, over its samples (level BLOCK_LEVELS + 1 first). */
  above: number[]
  /** Quantized height range of the block. */
  range: [number, number]
  /** Samples clipped by heightRange. */
  clipped: number
  lowest: number
  highest: number
  ms: number
}

export declare function windowWeight(x: number, lo: number, hi: number, blend: number): number
export declare function sampleMap(map: StackMap, u: number, v: number): number
export declare function buildSpline(
  pts: ArrayLike<number>,
  width: number,
  falloff: number,
  reach: number,
): StackSpline
export declare function nearestOnSpline(
  sp: StackSpline,
  x: number,
  z: number,
  out: Float64Array,
): number
export declare function evalHeights(
  noise: NoiseAccess,
  stack: Stack,
  gi0: number,
  gj0: number,
  step: number,
  nx: number,
  nz: number,
  upTo: number,
  out: Float64Array,
): void
export declare function evalHeightPoints(
  noise: NoiseAccess,
  stack: Stack,
  xz: ArrayLike<number>,
  count: number,
  upTo: number,
  out: Float64Array,
): void
export declare function evalControl(
  noise: NoiseAccess,
  stack: Stack,
  gi0: number,
  gj0: number,
  k: number,
  nx: number,
  nz: number,
  hq: Float64Array,
  hx: number,
  h0: number,
  out: Uint8Array,
): Uint8Array
export declare function quantize(h: number, lo: number, hi: number): number
export declare function dequantize(q: number, lo: number, hi: number): number
export declare function normalByte(v: number): number
export declare function byteNormal(b: number): number
export declare function leafNormals(
  heights: Uint16Array,
  lo: number,
  hi: number,
  spacing: number,
  out: Uint8Array,
): Uint8Array
export declare function pageBytes(leaf: boolean, cells: number): number
export declare function encodePage(page: DecodedPage, leaf: boolean, cells: number): Uint8Array
export declare function decodePage(raw: Uint8Array, leaf: boolean, cells: number): DecodedPage
export declare function readPage(packed: Uint8Array, leaf: boolean, cells: number): DecodedPage
export declare function pageTexels(
  page: DecodedPage,
  leaf: boolean,
  lo: number,
  hi: number,
  spacing: number,
  texels: Uint8Array,
): Uint8Array
export declare function bakeBlock(
  noise: NoiseAccess,
  stack: Stack,
  layout: KernelLayout,
  bx: number,
  bz: number,
): BlockResult
export declare function bakeLeaf(
  noise: NoiseAccess,
  stack: Stack,
  layout: KernelLayout,
  x: number,
  z: number,
): { page: DecodedPage; min: number; max: number }
export declare function parentPage(
  children: readonly (DecodedPage | null)[],
  cells: number,
  normalAt: (i: number, j: number, out: Float64Array) => void,
): DecodedPage
export declare function pageNormal(
  page: DecodedPage,
  i: number,
  j: number,
  out: Float64Array,
): Float64Array
