//! The program interpreter. A program is a list of fixed-width instructions over registers of
//! `BLOCK` floats each. Points are processed a block at a time, one instruction over the whole
//! block, so dispatch costs one match per instruction rather than per point. `compile.ts` in
//! `@shard/noise` writes programs; the opcodes and layouts here must match it.

use crate::hash::hash_seed;
use crate::lanes::{F4, I4};
use crate::sources::*;

/// Points per block. Each register holds one block.
pub const BLOCK: usize = 256;
/// i32 words per instruction: `[op, dst, a, b, c, d, e, f, k, n, seed, salt]`.
pub const WIDTH: usize = 12;
/// i32 words per origin record: the integer lattice cell (xyzw), then the fraction (xyzw, f32 bits).
pub const ORIGIN_WORDS: usize = 8;
/// Registers 0–3 hold the block's local positions (x, y, z, w).
pub const POSITION_REGS: usize = 4;
/// Largest octave count a fractal may have.
pub const MAX_OCTAVES: usize = 16;

pub mod op {
    pub const CONST: i32 = 0;
    pub const SOURCE: i32 = 1;
    pub const ADD: i32 = 2;
    pub const MUL: i32 = 3;
    pub const MIN: i32 = 4;
    pub const MAX: i32 = 5;
    pub const LERP: i32 = 6;
    pub const SELECT: i32 = 7;
    pub const REMAP: i32 = 8;
    pub const CLAMP: i32 = 9;
    pub const CURVE: i32 = 10;
    pub const TERRACE: i32 = 11;
    pub const ABS: i32 = 12;
    pub const POWER: i32 = 13;
    pub const WARP: i32 = 14;
    pub const SCALE_DISP: i32 = 15;
}

pub mod kind {
    pub const VALUE: i32 = 0;
    pub const PERLIN: i32 = 1;
    pub const SIMPLEX: i32 = 2;
    pub const CELLULAR: i32 = 3;
}

pub mod fractal {
    pub const NONE: i32 = 0;
    pub const FBM: i32 = 1;
    pub const RIDGED: i32 = 2;
    pub const BILLOW: i32 = 3;
}

/// (√3 − 1) / 2
pub const F2: f32 = 0.366_025_403_784_438_6;
/// (√5 − 1) / 4
pub const F4_SKEW: f32 = 0.309_016_994_374_947_4;

#[inline(always)]
fn c(v: f32) -> F4 {
    F4::splat(v)
}

struct Regs(*mut f32);

impl Regs {
    #[inline(always)]
    fn at(&self, r: i32) -> *mut f32 {
        unsafe { self.0.add(r as usize * BLOCK) }
    }
}

/// Evaluates `code` (`ninstr` instructions) at `count` points and writes register `result` of each
/// block into `out`.
///
/// # Safety
/// Every pointer must be valid for what the program reads and writes: `pts` holds `count` points
/// of `stride` floats (x, y, then z and w when the stride has them), `out` holds `count` floats,
/// and `regs` is 16-byte aligned with room for every register the program uses.
#[allow(clippy::too_many_arguments)]
pub unsafe fn eval(
    code: *const i32,
    ninstr: usize,
    consts: *const f32,
    origins: *const i32,
    seed: u32,
    pts: *const f32,
    stride: usize,
    count: usize,
    out: *mut f32,
    regs: *mut f32,
    result: usize,
) {
    let r = Regs(regs);
    let mut start = 0;
    while start < count {
        let n = if count - start < BLOCK { count - start } else { BLOCK };
        let n4 = (n + 3) & !3;
        unsafe {
            load_positions(&r, pts.add(start * stride), stride, n, n4);
            let mut i = 0;
            while i < ninstr {
                exec(code.add(i * WIDTH), consts, origins, seed, &r, n4);
                i += 1;
            }
            let src = r.at(result as i32);
            let mut j = 0;
            while j < n {
                *out.add(start + j) = *src.add(j);
                j += 1;
            }
        }
        start += n;
    }
}

unsafe fn load_positions(r: &Regs, pts: *const f32, stride: usize, n: usize, n4: usize) {
    unsafe {
        let (x, y, z, w) = (r.at(0), r.at(1), r.at(2), r.at(3));
        let mut j = 0;
        while j < n {
            let p = pts.add(j * stride);
            *x.add(j) = *p;
            *y.add(j) = *p.add(1);
            *z.add(j) = if stride > 2 { *p.add(2) } else { 0.0 };
            *w.add(j) = if stride > 3 { *p.add(3) } else { 0.0 };
            j += 1;
        }
        while j < n4 {
            *x.add(j) = 0.0;
            *y.add(j) = 0.0;
            *z.add(j) = 0.0;
            *w.add(j) = 0.0;
            j += 1;
        }
    }
}

unsafe fn exec(ins: *const i32, consts: *const f32, origins: *const i32, seed: u32, r: &Regs, n4: usize) {
    unsafe {
        let w = |i: usize| *ins.add(i);
        let k = consts.add(w(8) as usize);
        let kf = |i: usize| *k.add(i);
        let dst = r.at(w(1));
        match w(0) {
            op::SOURCE => source(ins, consts, origins, seed, r, n4),
            op::CONST => {
                let v = c(kf(0));
                each(n4, |g| v.store(dst.add(g)));
            }
            op::ADD => binary(dst, r.at(w(2)), r.at(w(3)), n4, |a, b| a + b),
            op::MUL => binary(dst, r.at(w(2)), r.at(w(3)), n4, |a, b| a * b),
            op::MIN => binary(dst, r.at(w(2)), r.at(w(3)), n4, |a, b| a.min(b)),
            op::MAX => binary(dst, r.at(w(2)), r.at(w(3)), n4, |a, b| a.max(b)),
            op::LERP => {
                let (a, b, t) = (r.at(w(2)), r.at(w(3)), r.at(w(4)));
                each(n4, |g| {
                    F4::lerp(F4::load(a.add(g)), F4::load(b.add(g)), F4::load(t.add(g)))
                        .store(dst.add(g))
                });
            }
            op::SELECT => {
                let (a, b, ctl) = (r.at(w(2)), r.at(w(3)), r.at(w(4)));
                let (th, falloff, lo, inv) = (c(kf(0)), kf(1), c(kf(2)), c(kf(3)));
                each(n4, |g| {
                    let x = F4::load(ctl.add(g));
                    let t = if falloff > 0.0 {
                        let t = ((x - lo) * inv).clamp(c(0.0), c(1.0));
                        t * t * (c(3.0) - c(2.0) * t)
                    } else {
                        F4::select(x.ge(th), c(1.0), c(0.0))
                    };
                    F4::lerp(F4::load(a.add(g)), F4::load(b.add(g)), t).store(dst.add(g))
                });
            }
            op::REMAP => {
                let a = r.at(w(2));
                let (from0, to0, scale, lo, hi) = (c(kf(0)), c(kf(1)), c(kf(2)), c(kf(3)), c(kf(4)));
                let clamp = w(9) != 0;
                each(n4, |g| {
                    let v = to0 + (F4::load(a.add(g)) - from0) * scale;
                    (if clamp { v.clamp(lo, hi) } else { v }).store(dst.add(g))
                });
            }
            op::CLAMP => {
                let a = r.at(w(2));
                let (lo, hi) = (c(kf(0)), c(kf(1)));
                each(n4, |g| F4::load(a.add(g)).clamp(lo, hi).store(dst.add(g)));
            }
            op::CURVE => {
                let a = r.at(w(2));
                let points = w(9) as usize;
                each(n4, |g| {
                    let x = F4::load(a.add(g));
                    let mut v = c(kf(1));
                    let mut i = 0;
                    while i + 1 < points {
                        let (x0, y0, inv, dy) = (c(kf(i * 4)), c(kf(i * 4 + 1)), c(kf(i * 4 + 2)), c(kf(i * 4 + 3)));
                        let t = ((x - x0) * inv).clamp(c(0.0), c(1.0));
                        v = F4::select(x.ge(x0), y0 + t * dy, v);
                        i += 1;
                    }
                    v.store(dst.add(g))
                });
            }
            op::TERRACE => {
                let a = r.at(w(2));
                let (min, scale, sharp, back) = (c(kf(0)), c(kf(1)), c(kf(2)), c(kf(3)));
                each(n4, |g| {
                    let u = (F4::load(a.add(g)) - min) * scale;
                    let step = u.floor();
                    let f = ((u - step - c(0.5)) * sharp + c(0.5)).clamp(c(0.0), c(1.0));
                    ((step + f) * back + min).store(dst.add(g))
                });
            }
            op::ABS => {
                let a = r.at(w(2));
                each(n4, |g| F4::load(a.add(g)).abs().store(dst.add(g)));
            }
            op::POWER => {
                let a = r.at(w(2));
                let e = c(kf(0));
                each(n4, |g| pow_signed(F4::load(a.add(g)), e).store(dst.add(g)));
            }
            op::WARP => {
                let src = w(2);
                let amount = c(kf(0));
                let mut axis = 0;
                while axis < 4 {
                    let ch = w(3 + axis);
                    let out = r.at(w(1) + axis as i32);
                    if ch < 0 {
                        // No channel for this axis (a 3D warp's w): keep the incoming displacement.
                        if src >= 0 {
                            let s = r.at(src + axis as i32);
                            each(n4, |g| F4::load(s.add(g)).store(out.add(g)));
                        } else {
                            each(n4, |g| c(0.0).store(out.add(g)));
                        }
                    } else {
                        let chr = r.at(ch);
                        if src >= 0 {
                            let s = r.at(src + axis as i32);
                            each(n4, |g| {
                                (F4::load(s.add(g)) + amount * F4::load(chr.add(g))).store(out.add(g))
                            });
                        } else {
                            each(n4, |g| (amount * F4::load(chr.add(g))).store(out.add(g)));
                        }
                    }
                    axis += 1;
                }
            }
            op::SCALE_DISP => {
                let src = w(2);
                let mut axis = 0;
                while axis < 4 {
                    let s = r.at(src + axis as i32);
                    let out = r.at(w(1) + axis as i32);
                    let f = c(kf(axis));
                    each(n4, |g| (F4::load(s.add(g)) * f).store(out.add(g)));
                    axis += 1;
                }
            }
            _ => {}
        }
    }
}

#[inline(always)]
fn each(n4: usize, mut f: impl FnMut(usize)) {
    let mut g = 0;
    while g < n4 {
        f(g);
        g += 4;
    }
}

#[inline(always)]
unsafe fn binary(dst: *mut f32, a: *const f32, b: *const f32, n4: usize, f: impl Fn(F4, F4) -> F4) {
    each(n4, |g| unsafe { f(F4::load(a.add(g)), F4::load(b.add(g))).store(dst.add(g)) });
}

// --- sources -----------------------------------------------------------------------------------

struct Source {
    dst: *mut f32,
    pos: [*const f32; 4],
    disp: Option<[*const f32; 4]>,
    origins: *const i32,
    consts: *const f32,
    octaves: usize,
    fractal: i32,
    jitter: f32,
    norm: f32,
    metric: i32,
    ret: i32,
    seeds: [i32; MAX_OCTAVES],
}

unsafe fn source(ins: *const i32, consts: *const f32, origins: *const i32, seed: u32, r: &Regs, n4: usize) {
    unsafe {
        let w = |i: usize| *ins.add(i);
        let k = consts.add(w(8) as usize);
        let octaves = (w(9) as usize).clamp(1, MAX_OCTAVES);
        let fractal = w(6);
        let salt = w(11) as u32;
        let mut s = if salt != 0 { hash_seed(seed, salt) } else { seed };
        s = hash_seed(s, w(10) as u32);
        let mut seeds = [0i32; MAX_OCTAVES];
        let mut o = 0;
        while o < octaves {
            seeds[o] = if fractal == fractal::NONE { s } else { hash_seed(s, o as u32) } as i32;
            o += 1;
        }
        let disp = w(2);
        let src = Source {
            dst: r.at(w(1)),
            pos: [r.at(0), r.at(1), r.at(2), r.at(3)],
            disp: if disp >= 0 {
                Some([r.at(disp), r.at(disp + 1), r.at(disp + 2), r.at(disp + 3)])
            } else {
                None
            },
            origins: origins.add(w(3) as usize * ORIGIN_WORDS),
            consts: k.add(2),
            octaves,
            fractal,
            jitter: *k,
            norm: *k.add(1),
            metric: w(7) & 15,
            ret: w(7) >> 4,
            seeds,
        };
        match (w(4), w(5)) {
            (kind::VALUE, 2) => run::<{ kind::VALUE }, 2>(&src, n4),
            (kind::VALUE, _) => run::<{ kind::VALUE }, 3>(&src, n4),
            (kind::PERLIN, 2) => run::<{ kind::PERLIN }, 2>(&src, n4),
            (kind::PERLIN, _) => run::<{ kind::PERLIN }, 3>(&src, n4),
            (kind::SIMPLEX, 2) => run::<{ kind::SIMPLEX }, 2>(&src, n4),
            (kind::SIMPLEX, 4) => run::<{ kind::SIMPLEX }, 4>(&src, n4),
            (kind::SIMPLEX, _) => run::<{ kind::SIMPLEX }, 3>(&src, n4),
            (kind::CELLULAR, 2) => run::<{ kind::CELLULAR }, 2>(&src, n4),
            (_, _) => run::<{ kind::CELLULAR }, 3>(&src, n4),
        }
    }
}

/// One source instruction: octave by octave (so each octave's constants stay in registers across
/// the block), accumulating into the destination register, then normalized.
#[inline(always)]
unsafe fn run<const K: i32, const D: i32>(s: &Source, n4: usize) {
    unsafe {
        let mut o = 0;
        while o < s.octaves {
            let k = s.consts.add(o * 6);
            let (ax, ay, az, aw) = (c(*k), c(*k.add(1)), c(*k.add(2)), c(*k.add(3)));
            let f = c(*k.add(4));
            let amp = c(*k.add(5));
            let rec = s.origins.add(o * ORIGIN_WORDS);
            let ix = I4::splat(*rec);
            let iy = I4::splat(*rec.add(1));
            let iz = I4::splat(*rec.add(2));
            let iw = I4::splat(*rec.add(3));
            let fx = c(f32::from_bits(*rec.add(4) as u32));
            let fy = c(f32::from_bits(*rec.add(5) as u32));
            let fz = c(f32::from_bits(*rec.add(6) as u32));
            let fw = c(f32::from_bits(*rec.add(7) as u32));
            let seed = I4::splat(s.seeds[o]);
            let first = o == 0;
            let octave = |g: usize| {
                // The local lattice offset: frequency × domain scale × local, plus any warp.
                // (z and w only when the source reads them.)
                let mut qx = ax * F4::load(s.pos[0].add(g));
                let mut qy = ay * F4::load(s.pos[1].add(g));
                let mut qz = if D >= 3 { az * F4::load(s.pos[2].add(g)) } else { c(0.0) };
                let mut qw = if D >= 4 { aw * F4::load(s.pos[3].add(g)) } else { c(0.0) };
                if let Some(d) = s.disp {
                    qx = qx + f * F4::load(d[0].add(g));
                    qy = qy + f * F4::load(d[1].add(g));
                    if D >= 3 {
                        qz = qz + f * F4::load(d[2].add(g));
                    }
                    if D >= 4 {
                        qw = qw + f * F4::load(d[3].add(g));
                    }
                }
                let v = if K == kind::SIMPLEX && D == 2 {
                    let t = (qx + qy) * c(F2);
                    simplex2(seed, ix, iy, fx + (qx + t), fy + (qy + t))
                } else if K == kind::SIMPLEX && D == 4 {
                    let t = (qx + qy + qz + qw) * c(F4_SKEW);
                    simplex4(seed, ix, iy, iz, iw, fx + (qx + t), fy + (qy + t), fz + (qz + t), fw + (qw + t))
                } else if K == kind::SIMPLEX {
                    let t = (qx + qy + qz) * c(2.0 / 3.0);
                    simplex3(seed, ix, iy, iz, fx + (t - qx), fy + (t - qy), fz + (t - qz))
                } else if K == kind::VALUE && D == 2 {
                    value2(seed, ix, iy, fx + qx, fy + qy)
                } else if K == kind::VALUE {
                    value3(seed, ix, iy, iz, fx + qx, fy + qy, fz + qz)
                } else if K == kind::PERLIN && D == 2 {
                    perlin2(seed, ix, iy, fx + qx, fy + qy)
                } else if K == kind::PERLIN {
                    perlin3(seed, ix, iy, iz, fx + qx, fy + qy, fz + qz)
                } else if D == 2 {
                    cellular2(seed, ix, iy, fx + qx, fy + qy, s.jitter, s.metric, s.ret)
                } else {
                    cellular3(seed, ix, iy, iz, fx + qx, fy + qy, fz + qz, s.jitter, s.metric, s.ret)
                };
                let term = match s.fractal {
                    fractal::RIDGED => {
                        let r = c(1.0) - v.abs();
                        amp * (r * r)
                    }
                    fractal::BILLOW => amp * (c(2.0) * v.abs() - c(1.0)),
                    _ => amp * v,
                };
                let sum = if first { c(0.0) } else { F4::load(s.dst.add(g)) };
                (sum + term).store(s.dst.add(g));
            };
            // Two groups per step: independent chains the CPU overlaps.
            let mut g = 0;
            while g + 8 <= n4 {
                octave(g);
                octave(g + 4);
                g += 8;
            }
            if g < n4 {
                octave(g);
            }
            o += 1;
        }
        let norm = c(s.norm);
        let ridged = s.fractal == fractal::RIDGED;
        let mut g = 0;
        while g < n4 {
            let sum = F4::load(s.dst.add(g));
            let out = if ridged { sum * norm * c(2.0) - c(1.0) } else { sum * norm };
            out.store(s.dst.add(g));
            g += 4;
        }
    }
}

// --- power -------------------------------------------------------------------------------------

/// log2 of a positive normal float: exponent plus an atanh series on the mantissa in [√½, √2).
#[inline(always)]
fn log2(x: F4) -> F4 {
    let bits = x.bits();
    let e = ((bits >> 23) & I4::splat(0xff)) - I4::splat(127);
    let m = F4::from_bits((bits & I4::splat(0x007f_ffff)) | I4::splat(0x3f80_0000));
    let big = m.gt(c(core::f32::consts::SQRT_2));
    let m = F4::select(big, m * c(0.5), m);
    let e = (e - big).to_f4();
    let s = (m - c(1.0)) / (m + c(1.0));
    let s2 = s * s;
    let p = c(1.0 / 9.0);
    let p = c(1.0 / 7.0) + s2 * p;
    let p = c(1.0 / 5.0) + s2 * p;
    let p = c(1.0 / 3.0) + s2 * p;
    let p = c(1.0) + s2 * p;
    e + s * p * c(2.0 / core::f32::consts::LN_2)
}

/// 2^y for y in [−126, 126]: 2^round(y) from the exponent bits, times a polynomial for the rest.
#[inline(always)]
fn exp2(y: F4) -> F4 {
    let y = y.clamp(c(-126.0), c(126.0));
    let n = (y + c(0.5)).floor();
    let t = (y - n) * c(core::f32::consts::LN_2);
    let p = c(1.0 / 720.0);
    let p = c(1.0 / 120.0) + t * p;
    let p = c(1.0 / 24.0) + t * p;
    let p = c(1.0 / 6.0) + t * p;
    let p = c(0.5) + t * p;
    let p = c(1.0) + t * p;
    let p = c(1.0) + t * p;
    let scale = F4::from_bits((n.to_i4() + I4::splat(127)) << 23);
    p * scale
}

/// `sign(x) × |x|^e`, and 0 for |x| below 1e-30.
#[inline(always)]
pub fn pow_signed(x: F4, e: F4) -> F4 {
    let a = x.abs();
    let v = exp2(e * log2(a.max(c(1e-30))));
    let v = F4::select(a.lt(c(1e-30)), c(0.0), v);
    v.flip(x.bits() & I4::splat(i32::MIN))
}
