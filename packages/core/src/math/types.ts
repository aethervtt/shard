/** Anything readable by index: tuples, TypedArrays, column views. */
export type Readable = ArrayLike<number>

/** Anything writable by index. Math functions write results into one of these. */
export interface Writable {
  readonly length: number
  [index: number]: number
}

export const EPSILON = 1e-6
