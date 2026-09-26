/** One FNV-1a step. */
function fnv(h: number, unit: number): number {
  return Math.imul(h ^ unit, 0x01000193)
}

/** 32-bit FNV-1a of a label: a string's UTF-16 units, or a u32's four little-endian bytes. */
function hashLabel(label: string | number): number {
  let h = 0x811c9dc5
  if (typeof label === 'string') {
    for (let i = 0; i < label.length; i++) h = fnv(h, label.charCodeAt(i))
  } else {
    h = fnv(h, label & 0xff)
    h = fnv(h, (label >>> 8) & 0xff)
    h = fnv(h, (label >>> 16) & 0xff)
    h = fnv(h, label >>> 24)
  }
  return h
}

/**
 * A child seed from a seed and a label: how `Rng.fork`, noise sources, and generators derive seeds.
 * Numeric labels hash as four bytes, so the noise kernel and WGSL compute the same value.
 */
export function hashSeed(seed: number, label: string | number): number {
  const h = hashLabel(label)
  // `fnv(h, 0x23)` continues the label's hash with '#', which is what `Rng.fork` has always used.
  return (Math.imul((seed ^ h) >>> 0, 0x9e3779b1) ^ fnv(h, 0x23)) >>> 0
}

/** lowbias32 (Chris Wellons): a well-mixed 32-bit finalizer. */
export function mix32(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  return (h ^ (h >>> 16)) >>> 0
}

/** Primes the noise kernel multiplies lattice coordinates by before mixing. */
export const LATTICE_PRIMES = [501125321, 1136930381, 1720413743, 1066037191] as const

/**
 * The noise kernel's lattice hash of an integer cell under a seed, as an unsigned 32-bit number:
 * the same value a noise source hashes for that cell. Generators use it for per-cell decisions.
 */
export function hash32(seed: number, x: number, y = 0, z = 0, w = 0): number {
  return mix32(
    seed ^
      Math.imul(x, LATTICE_PRIMES[0]) ^
      Math.imul(y, LATTICE_PRIMES[1]) ^
      Math.imul(z, LATTICE_PRIMES[2]) ^
      Math.imul(w, LATTICE_PRIMES[3]),
  )
}
