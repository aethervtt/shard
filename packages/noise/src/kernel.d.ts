// Types for kernel.js (plain JavaScript so worker threads can import it without a loader).

export declare const BLOCK: number
export declare const ORIGIN_WORDS: number

/** How each source octave's lattice position depends on the sample origin. */
export interface OriginTerms {
  /** Per term, xyzw: frequency × domain scale (f32 values). */
  readonly a: Float64Array
  /** Per term, xyzw: frequency × domain offset (f64). */
  readonly b: Float64Array
  /** Per term: 0 (none), 2, 3, or 4 (the simplex skew for that many dimensions). */
  readonly skew: Uint8Array
}

/** What `evalProgram` needs from a compiled program. */
export interface ProgramData {
  readonly code: Int32Array
  readonly consts: Float32Array
  readonly registers: number
  readonly result: number
}

export interface KernelState {
  readonly memory: WebAssembly.Memory
}

export interface SpherePatch {
  /** Cube face: 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z. */
  readonly face: number
  /** Lower corner in face coordinates, [-1, 1]. */
  readonly x0: number
  readonly y0: number
  /** Side length in face coordinates (2 is the whole face). */
  readonly extent: number
  /** Vertices per side, edges included. */
  readonly resolution: number
  readonly radius: number
}

export interface Grid2d {
  /** Lower corner. */
  readonly origin: readonly [number, number]
  readonly size: readonly [number, number]
  /** Samples per side, edges included. */
  readonly resolution: readonly [number, number]
  /** The plane's z. Default 0. */
  readonly z?: number
}

export declare function computeOrigins(
  terms: OriginTerms,
  origin: ArrayLike<number>,
  out: Int32Array,
): Int32Array
export declare function instantiate(
  module: WebAssembly.Module,
  instance?: WebAssembly.Instance,
): KernelState
export declare function evalProgram(
  state: KernelState,
  program: ProgramData,
  seed: number,
  origins: Int32Array,
  pts: ArrayLike<number>,
  stride: number,
  count: number,
  out: Float32Array,
  outOffset?: number,
): void
export declare function faceToDirection<T extends { [i: number]: number }>(
  face: number,
  u: number,
  v: number,
  out: T,
  offset?: number,
): T
export declare function directionToFace(
  x: number,
  y: number,
  z: number,
  out: { [i: number]: number },
): number
export declare function patchOrigin(p: SpherePatch, out: Float64Array): Float64Array
export declare function patchPoints(
  p: SpherePatch,
  origin: ArrayLike<number>,
  row0: number,
  row1: number,
  out: Float32Array,
): Float32Array
export declare function gridOrigin(g: Grid2d, out: Float64Array): Float64Array
export declare function gridPoints(
  g: Grid2d,
  origin: ArrayLike<number>,
  row0: number,
  row1: number,
  out: Float32Array,
): Float32Array
