//! Integer hashing: no permutation tables, so every seed costs nothing to set up. `wgsl.ts` in
//! `@shard/noise` mirrors these functions exactly.

use crate::lanes::{F4, I4};

/// Lattice primes, multiplied into cell coordinates before they're mixed.
pub const PX: i32 = 501125321;
pub const PY: i32 = 1136930381;
pub const PZ: i32 = 1720413743;
pub const PW: i32 = 1066037191;

/// lowbias32 (Chris Wellons): a 32-bit finalizer with only constant shifts, so it vectorizes.
#[inline(always)]
pub fn mix(h: I4) -> I4 {
    let h = h ^ (h >> 16);
    let h = h * I4::splat(0x7feb352d);
    let h = h ^ (h >> 15);
    let h = h * I4::splat(0x846ca68bu32 as i32);
    h ^ (h >> 16)
}

/// The hash of a lattice point whose coordinates are already multiplied by the primes.
#[inline(always)]
pub fn hash2(seed: I4, x: I4, y: I4) -> I4 {
    mix(seed ^ x ^ y)
}

#[inline(always)]
pub fn hash3(seed: I4, x: I4, y: I4, z: I4) -> I4 {
    mix(seed ^ x ^ y ^ z)
}

#[inline(always)]
pub fn hash4(seed: I4, x: I4, y: I4, z: I4, w: I4) -> I4 {
    mix(seed ^ x ^ y ^ z ^ w)
}

/// A cheap hash for picking a gradient (FastNoiseLite's): the primed coordinates xor-ed, times an
/// odd constant. Only the top bits of a product mix every input bit, so the gradient index is the
/// top 3 (2D), 4 (3D), or 5 (4D) bits.
#[inline(always)]
pub fn grad_hash2(seed: I4, x: I4, y: I4) -> I4 {
    ((seed ^ x ^ y) * I4::splat(0x27d4eb2d)) >> 29
}

#[inline(always)]
pub fn grad_hash3(seed: I4, x: I4, y: I4, z: I4) -> I4 {
    ((seed ^ x ^ y ^ z) * I4::splat(0x27d4eb2d)) >> 28
}

#[inline(always)]
pub fn grad_hash4(seed: I4, x: I4, y: I4, z: I4, w: I4) -> I4 {
    ((seed ^ x ^ y ^ z ^ w) * I4::splat(0x27d4eb2d)) >> 27
}

/// A hash's top 24 bits as a value in [-1, 1].
#[inline(always)]
pub fn to_value(h: I4) -> F4 {
    (h >> 8).to_f4() * F4::splat(2.0 / 16777215.0) - F4::splat(1.0)
}

/// Scalar lowbias32.
pub const fn mix_u32(h: u32) -> u32 {
    let h = h ^ (h >> 16);
    let h = h.wrapping_mul(0x7feb352d);
    let h = h ^ (h >> 15);
    let h = h.wrapping_mul(0x846ca68b);
    h ^ (h >> 16)
}

const fn fnv(h: u32, byte: u32) -> u32 {
    (h ^ byte).wrapping_mul(0x01000193)
}

/// `hashSeed(seed, label)` from `@shard/core` for a numeric label: FNV-1a of the label's four
/// little-endian bytes, mixed into the seed the way `Rng.fork` does.
pub const fn hash_seed(seed: u32, label: u32) -> u32 {
    let mut h = 0x811c9dc5;
    h = fnv(h, label & 0xff);
    h = fnv(h, (label >> 8) & 0xff);
    h = fnv(h, (label >> 16) & 0xff);
    h = fnv(h, label >> 24);
    (seed ^ h).wrapping_mul(0x9e3779b1) ^ fnv(h, 0x23)
}
