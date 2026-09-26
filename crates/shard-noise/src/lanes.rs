//! Four-lane f32 and i32 vectors. With `simd128` they're one v128 each; without it, arrays of four.
//! Both backends run the same operations in the same order, so they give bitwise-equal results.
//! Masks are `I4` lanes of all ones (true) or zero (false).

use core::ops::{Add, BitAnd, BitOr, BitXor, Div, Mul, Neg, Shl, Shr, Sub};

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct F4(pub v128);
    #[derive(Clone, Copy)]
    pub struct I4(pub v128);

    impl F4 {
        #[inline(always)]
        pub fn splat(v: f32) -> F4 {
            F4(f32x4_splat(v))
        }
        #[inline(always)]
        pub unsafe fn load(p: *const f32) -> F4 {
            F4(unsafe { v128_load(p as *const v128) })
        }
        #[inline(always)]
        pub unsafe fn store(self, p: *mut f32) {
            unsafe { v128_store(p as *mut v128, self.0) }
        }
        #[inline(always)]
        pub fn add(self, o: F4) -> F4 {
            F4(f32x4_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn sub(self, o: F4) -> F4 {
            F4(f32x4_sub(self.0, o.0))
        }
        #[inline(always)]
        pub fn mul(self, o: F4) -> F4 {
            F4(f32x4_mul(self.0, o.0))
        }
        #[inline(always)]
        pub fn div(self, o: F4) -> F4 {
            F4(f32x4_div(self.0, o.0))
        }
        /// IEEE minimum (a single instruction on every target, unlike `pmin`).
        #[inline(always)]
        pub fn min(self, o: F4) -> F4 {
            F4(f32x4_min(self.0, o.0))
        }
        #[inline(always)]
        pub fn max(self, o: F4) -> F4 {
            F4(f32x4_max(self.0, o.0))
        }
        #[inline(always)]
        pub fn floor(self) -> F4 {
            F4(f32x4_floor(self.0))
        }
        #[inline(always)]
        pub fn nearest(self) -> F4 {
            F4(f32x4_nearest(self.0))
        }
        #[inline(always)]
        pub fn sqrt(self) -> F4 {
            F4(f32x4_sqrt(self.0))
        }
        #[inline(always)]
        pub fn abs(self) -> F4 {
            F4(f32x4_abs(self.0))
        }
        #[inline(always)]
        pub fn neg(self) -> F4 {
            F4(f32x4_neg(self.0))
        }
        #[inline(always)]
        pub fn lt(self, o: F4) -> I4 {
            I4(f32x4_lt(self.0, o.0))
        }
        #[inline(always)]
        pub fn le(self, o: F4) -> I4 {
            I4(f32x4_le(self.0, o.0))
        }
        /// Truncates toward zero, saturating.
        #[inline(always)]
        pub fn to_i4(self) -> I4 {
            I4(i32x4_trunc_sat_f32x4(self.0))
        }
        #[inline(always)]
        pub fn bits(self) -> I4 {
            I4(self.0)
        }
        #[inline(always)]
        pub fn from_bits(i: I4) -> F4 {
            F4(i.0)
        }
        /// `m ? a : b`, per lane.
        #[inline(always)]
        pub fn select(m: I4, a: F4, b: F4) -> F4 {
            F4(v128_bitselect(a.0, b.0, m.0))
        }
    }

    impl I4 {
        #[inline(always)]
        pub fn splat(v: i32) -> I4 {
            I4(i32x4_splat(v))
        }
        #[inline(always)]
        pub fn add(self, o: I4) -> I4 {
            I4(i32x4_add(self.0, o.0))
        }
        #[inline(always)]
        pub fn sub(self, o: I4) -> I4 {
            I4(i32x4_sub(self.0, o.0))
        }
        #[inline(always)]
        pub fn mul(self, o: I4) -> I4 {
            I4(i32x4_mul(self.0, o.0))
        }
        #[inline(always)]
        pub fn xor(self, o: I4) -> I4 {
            I4(v128_xor(self.0, o.0))
        }
        #[inline(always)]
        pub fn and(self, o: I4) -> I4 {
            I4(v128_and(self.0, o.0))
        }
        #[inline(always)]
        pub fn or(self, o: I4) -> I4 {
            I4(v128_or(self.0, o.0))
        }
        /// Logical shift right.
        #[inline(always)]
        pub fn shr(self, n: u32) -> I4 {
            I4(u32x4_shr(self.0, n))
        }
        #[inline(always)]
        pub fn shl(self, n: u32) -> I4 {
            I4(i32x4_shl(self.0, n))
        }
        #[inline(always)]
        pub fn eq(self, o: I4) -> I4 {
            I4(i32x4_eq(self.0, o.0))
        }
        /// Signed `self < o`.
        #[inline(always)]
        pub fn lt(self, o: I4) -> I4 {
            I4(i32x4_lt(self.0, o.0))
        }
        #[inline(always)]
        pub fn to_f4(self) -> F4 {
            F4(f32x4_convert_i32x4(self.0))
        }
        #[inline(always)]
        pub fn select(m: I4, a: I4, b: I4) -> I4 {
            I4(v128_bitselect(a.0, b.0, m.0))
        }
    }

}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod imp {
    // std's floor and sqrt compile to the wasm `f32.floor` and `f32.sqrt` instructions.
    #[inline(always)]
    fn floor(x: f32) -> f32 {
        x.floor()
    }

    #[inline(always)]
    fn sqrt(x: f32) -> f32 {
        x.sqrt()
    }

    #[inline(always)]
    fn nearest(x: f32) -> f32 {
        x.round_ties_even()
    }

    #[derive(Clone, Copy)]
    pub struct F4(pub [f32; 4]);
    #[derive(Clone, Copy)]
    pub struct I4(pub [i32; 4]);

    macro_rules! map_f {
        ($a:expr, |$x:ident| $body:expr) => {{
            let a = $a;
            F4([
                { let $x = a[0]; $body },
                { let $x = a[1]; $body },
                { let $x = a[2]; $body },
                { let $x = a[3]; $body },
            ])
        }};
    }

    macro_rules! zip {
        ($ty:ident, $a:expr, $b:expr, |$x:ident, $y:ident| $body:expr) => {{
            let (a, b) = ($a, $b);
            $ty([
                { let ($x, $y) = (a[0], b[0]); $body },
                { let ($x, $y) = (a[1], b[1]); $body },
                { let ($x, $y) = (a[2], b[2]); $body },
                { let ($x, $y) = (a[3], b[3]); $body },
            ])
        }};
    }

    const fn mask(b: bool) -> i32 {
        if b { -1 } else { 0 }
    }

    impl F4 {
        #[inline(always)]
        pub fn splat(v: f32) -> F4 {
            F4([v; 4])
        }
        #[inline(always)]
        pub unsafe fn load(p: *const f32) -> F4 {
            F4(unsafe { [*p, *p.add(1), *p.add(2), *p.add(3)] })
        }
        #[inline(always)]
        pub unsafe fn store(self, p: *mut f32) {
            unsafe {
                *p = self.0[0];
                *p.add(1) = self.0[1];
                *p.add(2) = self.0[2];
                *p.add(3) = self.0[3];
            }
        }
        #[inline(always)]
        pub fn add(self, o: F4) -> F4 {
            zip!(F4, self.0, o.0, |x, y| x + y)
        }
        #[inline(always)]
        pub fn sub(self, o: F4) -> F4 {
            zip!(F4, self.0, o.0, |x, y| x - y)
        }
        #[inline(always)]
        pub fn mul(self, o: F4) -> F4 {
            zip!(F4, self.0, o.0, |x, y| x * y)
        }
        #[inline(always)]
        pub fn div(self, o: F4) -> F4 {
            zip!(F4, self.0, o.0, |x, y| x / y)
        }
        /// `f32x4.min` exactly: −0 is below +0 (inputs are never NaN).
        #[inline(always)]
        pub fn min(self, o: F4) -> F4 {
            zip!(F4, self.0, o.0, |x, y| if x < y {
                x
            } else if y < x {
                y
            } else {
                f32::from_bits(x.to_bits() | y.to_bits())
            })
        }
        /// `f32x4.max` exactly.
        #[inline(always)]
        pub fn max(self, o: F4) -> F4 {
            zip!(F4, self.0, o.0, |x, y| if y < x {
                x
            } else if x < y {
                y
            } else {
                f32::from_bits(x.to_bits() & y.to_bits())
            })
        }
        #[inline(always)]
        pub fn floor(self) -> F4 {
            map_f!(self.0, |x| floor(x))
        }
        #[inline(always)]
        pub fn nearest(self) -> F4 {
            map_f!(self.0, |x| nearest(x))
        }
        #[inline(always)]
        pub fn sqrt(self) -> F4 {
            map_f!(self.0, |x| sqrt(x))
        }
        #[inline(always)]
        pub fn abs(self) -> F4 {
            map_f!(self.0, |x| f32::from_bits(x.to_bits() & 0x7fff_ffff))
        }
        #[inline(always)]
        pub fn neg(self) -> F4 {
            map_f!(self.0, |x| -x)
        }
        #[inline(always)]
        pub fn lt(self, o: F4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| mask(x < y))
        }
        #[inline(always)]
        pub fn le(self, o: F4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| mask(x <= y))
        }
        #[inline(always)]
        pub fn to_i4(self) -> I4 {
            let a = self.0;
            I4([a[0] as i32, a[1] as i32, a[2] as i32, a[3] as i32])
        }
        #[inline(always)]
        pub fn bits(self) -> I4 {
            let a = self.0;
            I4([a[0].to_bits() as i32, a[1].to_bits() as i32, a[2].to_bits() as i32, a[3].to_bits() as i32])
        }
        #[inline(always)]
        pub fn from_bits(i: I4) -> F4 {
            let a = i.0;
            F4([
                f32::from_bits(a[0] as u32),
                f32::from_bits(a[1] as u32),
                f32::from_bits(a[2] as u32),
                f32::from_bits(a[3] as u32),
            ])
        }
        #[inline(always)]
        pub fn select(m: I4, a: F4, b: F4) -> F4 {
            F4::from_bits(I4::select(m, a.bits(), b.bits()))
        }
    }

    impl I4 {
        #[inline(always)]
        pub fn splat(v: i32) -> I4 {
            I4([v; 4])
        }
        #[inline(always)]
        pub fn add(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| x.wrapping_add(y))
        }
        #[inline(always)]
        pub fn sub(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| x.wrapping_sub(y))
        }
        #[inline(always)]
        pub fn mul(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| x.wrapping_mul(y))
        }
        #[inline(always)]
        pub fn xor(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| x ^ y)
        }
        #[inline(always)]
        pub fn and(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| x & y)
        }
        #[inline(always)]
        pub fn or(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| x | y)
        }
        #[inline(always)]
        pub fn shr(self, n: u32) -> I4 {
            let a = self.0;
            I4([
                ((a[0] as u32) >> n) as i32,
                ((a[1] as u32) >> n) as i32,
                ((a[2] as u32) >> n) as i32,
                ((a[3] as u32) >> n) as i32,
            ])
        }
        #[inline(always)]
        pub fn shl(self, n: u32) -> I4 {
            let a = self.0;
            I4([a[0] << n, a[1] << n, a[2] << n, a[3] << n])
        }
        #[inline(always)]
        pub fn eq(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| mask(x == y))
        }
        #[inline(always)]
        pub fn lt(self, o: I4) -> I4 {
            zip!(I4, self.0, o.0, |x, y| mask(x < y))
        }
        #[inline(always)]
        pub fn to_f4(self) -> F4 {
            let a = self.0;
            F4([a[0] as f32, a[1] as f32, a[2] as f32, a[3] as f32])
        }
        #[inline(always)]
        pub fn select(m: I4, a: I4, b: I4) -> I4 {
            let (m, a, b) = (m.0, a.0, b.0);
            I4([
                (a[0] & m[0]) | (b[0] & !m[0]),
                (a[1] & m[1]) | (b[1] & !m[1]),
                (a[2] & m[2]) | (b[2] & !m[2]),
                (a[3] & m[3]) | (b[3] & !m[3]),
            ])
        }
    }
}

/// Four f32 lanes.
#[derive(Clone, Copy)]
pub struct F4(imp::F4);

/// Four i32 lanes, also used as masks.
#[derive(Clone, Copy)]
pub struct I4(imp::I4);

impl F4 {
    #[inline(always)]
    pub fn splat(v: f32) -> F4 {
        F4(imp::F4::splat(v))
    }
    /// # Safety
    /// `p` must point at four readable, 16-byte aligned floats.
    #[inline(always)]
    pub unsafe fn load(p: *const f32) -> F4 {
        F4(unsafe { imp::F4::load(p) })
    }
    /// # Safety
    /// `p` must point at four writable, 16-byte aligned floats.
    #[inline(always)]
    pub unsafe fn store(self, p: *mut f32) {
        unsafe { self.0.store(p) }
    }
    #[inline(always)]
    pub fn min(self, o: F4) -> F4 {
        F4(self.0.min(o.0))
    }
    #[inline(always)]
    pub fn max(self, o: F4) -> F4 {
        F4(self.0.max(o.0))
    }
    #[inline(always)]
    pub fn floor(self) -> F4 {
        F4(self.0.floor())
    }
    /// Rounds to the nearest integer, ties to even.
    #[inline(always)]
    pub fn nearest(self) -> F4 {
        F4(self.0.nearest())
    }
    #[inline(always)]
    pub fn sqrt(self) -> F4 {
        F4(self.0.sqrt())
    }
    #[inline(always)]
    pub fn abs(self) -> F4 {
        F4(self.0.abs())
    }
    #[inline(always)]
    pub fn lt(self, o: F4) -> I4 {
        I4(self.0.lt(o.0))
    }
    #[inline(always)]
    pub fn le(self, o: F4) -> I4 {
        I4(self.0.le(o.0))
    }
    #[inline(always)]
    pub fn gt(self, o: F4) -> I4 {
        I4(o.0.lt(self.0))
    }
    #[inline(always)]
    pub fn ge(self, o: F4) -> I4 {
        I4(o.0.le(self.0))
    }
    /// Truncates toward zero (exact for the integral values `floor` returns).
    #[inline(always)]
    pub fn to_i4(self) -> I4 {
        I4(self.0.to_i4())
    }
    #[inline(always)]
    pub fn bits(self) -> I4 {
        I4(self.0.bits())
    }
    #[inline(always)]
    pub fn from_bits(i: I4) -> F4 {
        F4(imp::F4::from_bits(i.0))
    }
    /// `m ? a : b`, per lane.
    #[inline(always)]
    pub fn select(m: I4, a: F4, b: F4) -> F4 {
        F4(imp::F4::select(m.0, a.0, b.0))
    }
    #[inline(always)]
    pub fn clamp(self, lo: F4, hi: F4) -> F4 {
        self.max(lo).min(hi)
    }
    /// `a + t * (b - a)`
    #[inline(always)]
    pub fn lerp(a: F4, b: F4, t: F4) -> F4 {
        a + t * (b - a)
    }
    /// Flips the sign where bit 31 of `sign` is set.
    #[inline(always)]
    pub fn flip(self, sign: I4) -> F4 {
        F4::from_bits(self.bits() ^ sign)
    }
}

impl I4 {
    #[inline(always)]
    pub fn splat(v: i32) -> I4 {
        I4(imp::I4::splat(v))
    }
    #[inline(always)]
    pub fn eq(self, o: I4) -> I4 {
        I4(self.0.eq(o.0))
    }
    #[inline(always)]
    pub fn lt(self, o: I4) -> I4 {
        I4(self.0.lt(o.0))
    }
    #[inline(always)]
    pub fn to_f4(self) -> F4 {
        F4(self.0.to_f4())
    }
    #[inline(always)]
    pub fn select(m: I4, a: I4, b: I4) -> I4 {
        I4(imp::I4::select(m.0, a.0, b.0))
    }
}

macro_rules! binop {
    ($ty:ident, $tr:ident, $f:ident, $imp:ident) => {
        impl $tr for $ty {
            type Output = $ty;
            #[inline(always)]
            fn $f(self, o: $ty) -> $ty {
                $ty(self.0.$imp(o.0))
            }
        }
    };
}

binop!(F4, Add, add, add);
binop!(F4, Sub, sub, sub);
binop!(F4, Mul, mul, mul);
binop!(F4, Div, div, div);
binop!(I4, Add, add, add);
binop!(I4, Sub, sub, sub);
binop!(I4, Mul, mul, mul);
binop!(I4, BitXor, bitxor, xor);
binop!(I4, BitAnd, bitand, and);
binop!(I4, BitOr, bitor, or);

impl Neg for F4 {
    type Output = F4;
    #[inline(always)]
    fn neg(self) -> F4 {
        F4(self.0.neg())
    }
}

impl Shr<u32> for I4 {
    type Output = I4;
    #[inline(always)]
    fn shr(self, n: u32) -> I4 {
        I4(self.0.shr(n))
    }
}

impl Shl<u32> for I4 {
    type Output = I4;
    #[inline(always)]
    fn shl(self, n: u32) -> I4 {
        I4(self.0.shl(n))
    }
}
