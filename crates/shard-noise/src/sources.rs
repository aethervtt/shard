//! Noise sources over four lanes. Every source takes the integer part of the lattice position
//! (`i*`, from the origin split) and a small fractional position (`p*`) in the source's own lattice
//! space: skewed for 2D and 4D simplex, rotated for 3D simplex. The sum is never formed in f32,
//! so precision depends only on the size of `p`. The WGSL in `@shard/noise` mirrors each function
//! operation for operation.

use crate::hash::*;
use crate::lanes::{F4, I4};

#[inline(always)]
fn c(v: f32) -> F4 {
    F4::splat(v)
}

#[inline(always)]
fn ci(v: i32) -> I4 {
    I4::splat(v)
}

#[inline(always)]
fn not(m: I4) -> I4 {
    m ^ ci(-1)
}

/// The cell a lattice position is in (as an absolute i32 cell) and the position within it.
#[inline(always)]
fn split(i: I4, p: F4) -> (I4, F4) {
    let f = p.floor();
    (i + f.to_i4(), p - f)
}

/// 6t⁵ − 15t⁴ + 10t³
#[inline(always)]
fn fade(t: F4) -> F4 {
    t * t * t * (t * (t * c(6.0) - c(15.0)) + c(10.0))
}

/// Eight 2D gradients (index 0–7): four diagonals and four axes, all of length √2.
#[inline(always)]
fn grad2(h: I4, x: F4, y: F4) -> F4 {
    let s0 = h << 31;
    let s1 = (h & ci(2)) << 30;
    let diag = x.flip(s0) + y.flip(s1);
    let axis = F4::select((h & ci(2)).eq(ci(0)), x, y).flip(s0) * c(core::f32::consts::SQRT_2);
    F4::select(h.lt(ci(4)), diag, axis)
}

/// The twelve cube-edge gradients (index 0–15): bits 2–3 pick the axis left out (the y-less
/// edges twice), bits 0–1 the signs of the other two.
#[inline(always)]
fn grad3(g: I4, x: F4, y: F4, z: F4) -> F4 {
    let drop = g >> 2;
    let a = F4::select(drop.eq(ci(0)), y, x);
    let b = F4::select(drop.eq(ci(2)), y, z);
    a.flip(g << 31) + b.flip((g & ci(2)) << 30)
}

/// The 32 edges of the tesseract (index 0–31): one axis dropped, signs on the other three.
#[inline(always)]
fn grad4(h: I4, x: F4, y: F4, z: F4, w: F4) -> F4 {
    let axis = h >> 3;
    let a = F4::select(axis.eq(ci(0)), y, x);
    let b = F4::select(axis.lt(ci(2)), z, y);
    let d = F4::select(axis.lt(ci(3)), w, z);
    a.flip(h << 31) + b.flip((h & ci(2)) << 30) + d.flip((h & ci(4)) << 29)
}

/// Keeps output inside the documented range; the scales below put the peak just under 1.
#[inline(always)]
fn unit(v: F4) -> F4 {
    v.clamp(c(-1.0), c(1.0))
}

// --- value -------------------------------------------------------------------------------------

pub fn value2(seed: I4, ix: I4, iy: I4, px: F4, py: F4) -> F4 {
    let (cx, tx) = split(ix, px);
    let (cy, ty) = split(iy, py);
    let x0 = cx * ci(PX);
    let x1 = x0 + ci(PX);
    let y0 = cy * ci(PY);
    let y1 = y0 + ci(PY);
    let u = fade(tx);
    let v = fade(ty);
    let a = F4::lerp(to_value(hash2(seed, x0, y0)), to_value(hash2(seed, x1, y0)), u);
    let b = F4::lerp(to_value(hash2(seed, x0, y1)), to_value(hash2(seed, x1, y1)), u);
    F4::lerp(a, b, v)
}

pub fn value3(seed: I4, ix: I4, iy: I4, iz: I4, px: F4, py: F4, pz: F4) -> F4 {
    let (cx, tx) = split(ix, px);
    let (cy, ty) = split(iy, py);
    let (cz, tz) = split(iz, pz);
    let x0 = cx * ci(PX);
    let x1 = x0 + ci(PX);
    let y0 = cy * ci(PY);
    let y1 = y0 + ci(PY);
    let z0 = cz * ci(PZ);
    let z1 = z0 + ci(PZ);
    let u = fade(tx);
    let v = fade(ty);
    let w = fade(tz);
    let a = F4::lerp(to_value(hash3(seed, x0, y0, z0)), to_value(hash3(seed, x1, y0, z0)), u);
    let b = F4::lerp(to_value(hash3(seed, x0, y1, z0)), to_value(hash3(seed, x1, y1, z0)), u);
    let d = F4::lerp(to_value(hash3(seed, x0, y0, z1)), to_value(hash3(seed, x1, y0, z1)), u);
    let e = F4::lerp(to_value(hash3(seed, x0, y1, z1)), to_value(hash3(seed, x1, y1, z1)), u);
    F4::lerp(F4::lerp(a, b, v), F4::lerp(d, e, v), w)
}

// --- Perlin ------------------------------------------------------------------------------------

pub const PERLIN2_SCALE: f32 = 1.0;
pub const PERLIN3_SCALE: f32 = 1.0;

pub fn perlin2(seed: I4, ix: I4, iy: I4, px: F4, py: F4) -> F4 {
    let (cx, tx) = split(ix, px);
    let (cy, ty) = split(iy, py);
    let x0 = cx * ci(PX);
    let x1 = x0 + ci(PX);
    let y0 = cy * ci(PY);
    let y1 = y0 + ci(PY);
    let tx1 = tx - c(1.0);
    let ty1 = ty - c(1.0);
    let u = fade(tx);
    let v = fade(ty);
    let a = F4::lerp(grad2(grad_hash2(seed, x0, y0), tx, ty), grad2(grad_hash2(seed, x1, y0), tx1, ty), u);
    let b = F4::lerp(grad2(grad_hash2(seed, x0, y1), tx, ty1), grad2(grad_hash2(seed, x1, y1), tx1, ty1), u);
    unit(F4::lerp(a, b, v) * c(PERLIN2_SCALE))
}

pub fn perlin3(seed: I4, ix: I4, iy: I4, iz: I4, px: F4, py: F4, pz: F4) -> F4 {
    let (cx, tx) = split(ix, px);
    let (cy, ty) = split(iy, py);
    let (cz, tz) = split(iz, pz);
    let x0 = cx * ci(PX);
    let x1 = x0 + ci(PX);
    let y0 = cy * ci(PY);
    let y1 = y0 + ci(PY);
    let z0 = cz * ci(PZ);
    let z1 = z0 + ci(PZ);
    let tx1 = tx - c(1.0);
    let ty1 = ty - c(1.0);
    let tz1 = tz - c(1.0);
    let u = fade(tx);
    let v = fade(ty);
    let w = fade(tz);
    let a = F4::lerp(
        grad3(grad_hash3(seed, x0, y0, z0), tx, ty, tz),
        grad3(grad_hash3(seed, x1, y0, z0), tx1, ty, tz),
        u,
    );
    let b = F4::lerp(
        grad3(grad_hash3(seed, x0, y1, z0), tx, ty1, tz),
        grad3(grad_hash3(seed, x1, y1, z0), tx1, ty1, tz),
        u,
    );
    let d = F4::lerp(
        grad3(grad_hash3(seed, x0, y0, z1), tx, ty, tz1),
        grad3(grad_hash3(seed, x1, y0, z1), tx1, ty, tz1),
        u,
    );
    let e = F4::lerp(
        grad3(grad_hash3(seed, x0, y1, z1), tx, ty1, tz1),
        grad3(grad_hash3(seed, x1, y1, z1), tx1, ty1, tz1),
        u,
    );
    unit(F4::lerp(F4::lerp(a, b, v), F4::lerp(d, e, v), w) * c(PERLIN3_SCALE))
}

// --- simplex -----------------------------------------------------------------------------------

/// (3 − √3) / 6
const G2: f32 = 0.211_324_865_405_187_1;
/// (5 − √5) / 20
const G4: f32 = 0.138_196_601_125_010_5;
const SEED_FLIP_3D: i32 = 0x52d5_47b3;

pub const SIMPLEX2_SCALE: f32 = 70.0;
pub const SIMPLEX3_SCALE: f32 = 32.0;
pub const SIMPLEX4_SCALE: f32 = 27.0;

#[inline(always)]
fn falloff(r2: f32, d2: F4) -> F4 {
    let a = (c(r2) - d2).max(c(0.0));
    let a2 = a * a;
    a2 * a2
}

/// Simplex noise on the skewed 2D lattice (`p` already skewed).
pub fn simplex2(seed: I4, ix: I4, iy: I4, px: F4, py: F4) -> F4 {
    let (cx, xi) = split(ix, px);
    let (cy, yi) = split(iy, py);
    let t = (xi + yi) * c(G2);
    let x0 = xi - t;
    let y0 = yi - t;
    let xb = cx * ci(PX);
    let yb = cy * ci(PY);
    let lower = y0.lt(x0);
    let i1 = F4::select(lower, c(1.0), c(0.0));
    let j1 = c(1.0) - i1;
    let x1 = x0 - i1 + c(G2);
    let y1 = y0 - j1 + c(G2);
    let x2 = x0 - c(1.0) + c(2.0 * G2);
    let y2 = y0 - c(1.0) + c(2.0 * G2);
    let h0 = grad_hash2(seed, xb, yb);
    let h1 = grad_hash2(
        seed,
        xb + I4::select(lower, ci(PX), ci(0)),
        yb + I4::select(lower, ci(0), ci(PY)),
    );
    let h2 = grad_hash2(seed, xb + ci(PX), yb + ci(PY));
    let n0 = falloff(0.5, x0 * x0 + y0 * y0) * grad2(h0, x0, y0);
    let n1 = falloff(0.5, x1 * x1 + y1 * y1) * grad2(h1, x1, y1);
    let n2 = falloff(0.5, x2 * x2 + y2 * y2) * grad2(h2, x2, y2);
    unit((n0 + n1 + n2) * c(SIMPLEX2_SCALE))
}

/// OpenSimplex2 on the rotated 3D body-centered-cubic lattice (`p` already rotated): two cubic
/// lattices offset by half a cell, two contributing points on each.
pub fn simplex3(seed: I4, ix: I4, iy: I4, iz: I4, px: F4, py: F4, pz: F4) -> F4 {
    let rx = px.nearest();
    let ry = py.nearest();
    let rz = pz.nearest();
    let mut xb = (ix + rx.to_i4()) * ci(PX);
    let mut yb = (iy + ry.to_i4()) * ci(PY);
    let mut zb = (iz + rz.to_i4()) * ci(PZ);
    let mut xr = px - rx;
    let mut yr = py - ry;
    let mut zr = pz - rz;
    // Where the offset is negative (the reference's sign is then +1, otherwise -1).
    let mut nx = xr.lt(c(0.0));
    let mut ny = yr.lt(c(0.0));
    let mut nz = zr.lt(c(0.0));
    let mut ax = xr.abs();
    let mut ay = yr.abs();
    let mut az = zr.abs();
    let mut a = (c(0.6) - xr * xr) - (yr * yr + zr * zr);
    let mut s = seed;
    let mut value = c(0.0);
    let sign = ci(i32::MIN);
    let mut l = 0;
    loop {
        let a0 = a.max(c(0.0));
        let a2 = a0 * a0;
        value = value + a2 * a2 * grad3(grad_hash3(s, xb, yb, zb), xr, yr, zr);

        // The second point is along the axis with the largest offset, one cell toward the sample.
        let mx = ax.ge(ay) & ax.ge(az);
        let my = not(mx) & ay.ge(az);
        let mz = not(mx | my);
        let am = ax.max(ay).max(az);
        let b0 = (a + am + am - c(1.0)).max(c(0.0));
        let b2 = b0 * b0;
        let hx = xb - (mx & I4::select(nx, ci(PX), ci(PX.wrapping_neg())));
        let hy = yb - (my & I4::select(ny, ci(PY), ci(PY.wrapping_neg())));
        let hz = zb - (mz & I4::select(nz, ci(PZ), ci(PZ.wrapping_neg())));
        let ox = xr + F4::from_bits(mx & F4::select(nx, c(1.0), c(-1.0)).bits());
        let oy = yr + F4::from_bits(my & F4::select(ny, c(1.0), c(-1.0)).bits());
        let oz = zr + F4::from_bits(mz & F4::select(nz, c(1.0), c(-1.0)).bits());
        value = value + b2 * b2 * grad3(grad_hash3(s, hx, hy, hz), ox, oy, oz);

        if l == 1 {
            break;
        }
        l += 1;
        // Move to the other lattice, half a cell over.
        ax = c(0.5) - ax;
        ay = c(0.5) - ay;
        az = c(0.5) - az;
        xr = ax.flip(not(nx) & sign);
        yr = ay.flip(not(ny) & sign);
        zr = az.flip(not(nz) & sign);
        a = a + ((c(0.75) - ax) - (ay + az));
        xb = xb + (not(nx) & ci(PX));
        yb = yb + (not(ny) & ci(PY));
        zb = zb + (not(nz) & ci(PZ));
        nx = not(nx);
        ny = not(ny);
        nz = not(nz);
        s = s ^ ci(SEED_FLIP_3D);
    }
    unit(value * c(SIMPLEX3_SCALE))
}

/// Simplex noise on the skewed 4D lattice (`p` already skewed).
#[allow(clippy::too_many_arguments)]
pub fn simplex4(
    seed: I4,
    ix: I4,
    iy: I4,
    iz: I4,
    iw: I4,
    px: F4,
    py: F4,
    pz: F4,
    pw: F4,
) -> F4 {
    let (cx, xi) = split(ix, px);
    let (cy, yi) = split(iy, py);
    let (cz, zi) = split(iz, pz);
    let (cw, wi) = split(iw, pw);
    let t = (xi + yi + zi + wi) * c(G4);
    let x0 = xi - t;
    let y0 = yi - t;
    let z0 = zi - t;
    let w0 = wi - t;
    // Rank the offsets (a true mask is -1, so `r - m` counts a win); the simplex walks from the
    // largest axis down.
    let mut rx = ci(0);
    let mut ry = ci(0);
    let mut rz = ci(0);
    let mut rw = ci(0);
    let m = y0.lt(x0);
    rx = rx - m;
    ry = ry - not(m);
    let m = z0.lt(x0);
    rx = rx - m;
    rz = rz - not(m);
    let m = w0.lt(x0);
    rx = rx - m;
    rw = rw - not(m);
    let m = z0.lt(y0);
    ry = ry - m;
    rz = rz - not(m);
    let m = w0.lt(y0);
    ry = ry - m;
    rw = rw - not(m);
    let m = w0.lt(z0);
    rz = rz - m;
    rw = rw - not(m);

    let xb = cx * ci(PX);
    let yb = cy * ci(PY);
    let zb = cz * ci(PZ);
    let wb = cw * ci(PW);
    let mut value = c(0.0);
    let mut k = 0;
    while k < 5 {
        // Corner k: the axes whose rank is at least 4 − k are stepped.
        let at = ci(4 - k);
        let sx = if k == 0 { ci(0) } else if k == 4 { ci(-1) } else { not(rx.lt(at)) };
        let sy = if k == 0 { ci(0) } else if k == 4 { ci(-1) } else { not(ry.lt(at)) };
        let sz = if k == 0 { ci(0) } else if k == 4 { ci(-1) } else { not(rz.lt(at)) };
        let sw = if k == 0 { ci(0) } else if k == 4 { ci(-1) } else { not(rw.lt(at)) };
        let off = c(k as f32 * G4);
        let x = x0 - F4::select(sx, c(1.0), c(0.0)) + off;
        let y = y0 - F4::select(sy, c(1.0), c(0.0)) + off;
        let z = z0 - F4::select(sz, c(1.0), c(0.0)) + off;
        let w = w0 - F4::select(sw, c(1.0), c(0.0)) + off;
        let h = grad_hash4(
            seed,
            xb + (sx & ci(PX)),
            yb + (sy & ci(PY)),
            zb + (sz & ci(PZ)),
            wb + (sw & ci(PW)),
        );
        value = value + falloff(0.6, x * x + y * y + z * z + w * w) * grad4(h, x, y, z, w);
        k += 1;
    }
    unit(value * c(SIMPLEX4_SCALE))
}

// --- cellular ----------------------------------------------------------------------------------

/// What a cellular source returns.
pub const CELL_F1: i32 = 0;
pub const CELL_F2: i32 = 1;
pub const CELL_F2_MINUS_F1: i32 = 2;
pub const CELL_VALUE: i32 = 3;

pub const METRIC_EUCLIDEAN: i32 = 0;
pub const METRIC_MANHATTAN: i32 = 1;
pub const METRIC_CHEBYSHEV: i32 = 2;

#[inline(always)]
fn jitter_of(h: I4, shift: u32) -> F4 {
    ((h >> shift) & ci(1023)).to_f4() * c(1.0 / 1023.0) - c(0.5)
}

#[inline(always)]
fn cell_result(ret: i32, metric: i32, b1: F4, b2: F4, bh: I4) -> F4 {
    let (d1, d2) = if metric == METRIC_EUCLIDEAN { (b1.sqrt(), b2.sqrt()) } else { (b1, b2) };
    match ret {
        CELL_F1 => d1,
        CELL_F2 => d2,
        CELL_F2_MINUS_F1 => d2 - d1,
        _ => to_value(mix(bh)),
    }
}

#[inline(always)]
fn track(d: F4, h: I4, b1: &mut F4, b2: &mut F4, bh: &mut I4) {
    let m = d.lt(*b1);
    *b2 = F4::select(m, *b1, b2.min(d));
    *bh = I4::select(m, h, *bh);
    *b1 = F4::select(m, d, *b1);
}

/// Worley noise: distance to the nearest (F1) and second-nearest (F2) jittered feature point, one
/// per cell, searched over the 3×3 cells around the sample.
#[allow(clippy::too_many_arguments)]
pub fn cellular2(
    seed: I4,
    ix: I4,
    iy: I4,
    px: F4,
    py: F4,
    jitter: f32,
    metric: i32,
    ret: i32,
) -> F4 {
    let (cx, tx) = split(ix, px);
    let (cy, ty) = split(iy, py);
    let xb = cx * ci(PX);
    let yb = cy * ci(PY);
    let j = c(jitter);
    let mut b1 = c(1e10);
    let mut b2 = c(1e10);
    let mut bh = ci(0);
    let mut dy: i32 = -1;
    while dy <= 1 {
        let mut dx: i32 = -1;
        while dx <= 1 {
            let h = hash2(seed, xb + ci(dx.wrapping_mul(PX)), yb + ci(dy.wrapping_mul(PY)));
            let fx = c(dx as f32 + 0.5) + j * jitter_of(h, 0) - tx;
            let fy = c(dy as f32 + 0.5) + j * jitter_of(h, 10) - ty;
            let d = match metric {
                METRIC_MANHATTAN => fx.abs() + fy.abs(),
                METRIC_CHEBYSHEV => fx.abs().max(fy.abs()),
                _ => fx * fx + fy * fy,
            };
            track(d, h, &mut b1, &mut b2, &mut bh);
            dx += 1;
        }
        dy += 1;
    }
    cell_result(ret, metric, b1, b2, bh)
}

/// Worley noise in 3D, over the 27 cells around the sample.
#[allow(clippy::too_many_arguments)]
pub fn cellular3(
    seed: I4,
    ix: I4,
    iy: I4,
    iz: I4,
    px: F4,
    py: F4,
    pz: F4,
    jitter: f32,
    metric: i32,
    ret: i32,
) -> F4 {
    let (cx, tx) = split(ix, px);
    let (cy, ty) = split(iy, py);
    let (cz, tz) = split(iz, pz);
    let xb = cx * ci(PX);
    let yb = cy * ci(PY);
    let zb = cz * ci(PZ);
    let j = c(jitter);
    let mut b1 = c(1e10);
    let mut b2 = c(1e10);
    let mut bh = ci(0);
    let mut dz: i32 = -1;
    while dz <= 1 {
        let mut dy: i32 = -1;
        while dy <= 1 {
            let mut dx: i32 = -1;
            while dx <= 1 {
                let h = hash3(
                    seed,
                    xb + ci(dx.wrapping_mul(PX)),
                    yb + ci(dy.wrapping_mul(PY)),
                    zb + ci(dz.wrapping_mul(PZ)),
                );
                let fx = c(dx as f32 + 0.5) + j * jitter_of(h, 0) - tx;
                let fy = c(dy as f32 + 0.5) + j * jitter_of(h, 10) - ty;
                let fz = c(dz as f32 + 0.5) + j * jitter_of(h, 20) - tz;
                let d = match metric {
                    METRIC_MANHATTAN => fx.abs() + fy.abs() + fz.abs(),
                    METRIC_CHEBYSHEV => fx.abs().max(fy.abs()).max(fz.abs()),
                    _ => fx * fx + fy * fy + fz * fz,
                };
                track(d, h, &mut b1, &mut b2, &mut bh);
                dx += 1;
            }
            dy += 1;
        }
        dz += 1;
    }
    cell_result(ret, metric, b1, b2, bh)
}
