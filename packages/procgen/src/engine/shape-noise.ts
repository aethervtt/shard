import { hash32 } from '@aethervtt/shard-core'

/**
 * Small value noise for engine generators' shapes: integer hashing and + × only, so a rock is the
 * same bytes on every host. Not the noise graph kernel (0041): shapes need a few octaves at a few
 * thousand points, and a generator shouldn't need a graph asset to make a rock.
 */

const INV = 1 / 4294967296

function lattice(seed: number, x: number, y: number, z: number): number {
  return hash32(seed, x, y, z) * INV * 2 - 1
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** Smooth value noise in [−1, 1]. */
export function valueNoise(seed: number, x: number, y: number, z: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const u = fade(x - xi)
  const v = fade(y - yi)
  const w = fade(z - zi)
  const a = lattice(seed, xi, yi, zi)
  const b = lattice(seed, xi + 1, yi, zi)
  const c = lattice(seed, xi, yi + 1, zi)
  const d = lattice(seed, xi + 1, yi + 1, zi)
  const e = lattice(seed, xi, yi, zi + 1)
  const f = lattice(seed, xi + 1, yi, zi + 1)
  const g = lattice(seed, xi, yi + 1, zi + 1)
  const h = lattice(seed, xi + 1, yi + 1, zi + 1)
  const ab = a + (b - a) * u
  const cd = c + (d - c) * u
  const ef = e + (f - e) * u
  const gh = g + (h - g) * u
  const lo = ab + (cd - ab) * v
  const hi = ef + (gh - ef) * v
  return lo + (hi - lo) * w
}

/** Fractal sum of `octaves` value-noise layers (halving amplitude, doubling frequency), ~[−1, 1]. */
export function fbm(seed: number, x: number, y: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(seed + o * 1013, x * f, y * f, z * f) * amp
    norm += amp
    amp *= 0.5
    f *= 2.03
  }
  return sum / norm
}
