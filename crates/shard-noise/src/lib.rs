//! Shard's noise kernel (spec 0041). `@aethervtt/shard-noise` compiles a noise graph into a program; this
//! crate interprets it over batches of points, one instruction over a whole block at a time.
//! Built to `wasm32-unknown-unknown` with and without `simd128`; the two builds give bitwise-equal
//! results. It uses std only for `floor` and `sqrt`, which compile to single wasm instructions.

pub mod hash;
pub mod lanes;
pub mod program;
pub mod sources;

/// Bumped when the program layout or any source changes its output.
pub const ABI_VERSION: u32 = 1;

#[cfg(target_arch = "wasm32")]
mod exports {
    use core::arch::wasm32::{memory_grow, memory_size};

    unsafe extern "C" {
        static __heap_base: u8;
    }

    fn heap_start() -> usize {
        let base = unsafe { &__heap_base as *const u8 as usize };
        (base + 15) & !15
    }

    /// Makes sure `bytes` of scratch memory exist after the heap base and returns where they
    /// start. The caller lays out programs, points, and registers there; growing detaches its
    /// views of the memory.
    #[unsafe(no_mangle)]
    pub extern "C" fn reserve(bytes: usize) -> usize {
        let start = heap_start();
        let need = start + bytes;
        let have = memory_size(0) * 65536;
        if need > have {
            let pages = (need - have).div_ceil(65536);
            if memory_grow(0, pages) == usize::MAX {
                return 0;
            }
        }
        start
    }

    /// See `program::eval`. Pointers are byte offsets into this module's memory.
    #[unsafe(no_mangle)]
    #[allow(clippy::too_many_arguments)]
    pub unsafe extern "C" fn eval(
        code: usize,
        ninstr: usize,
        consts: usize,
        origins: usize,
        seed: u32,
        pts: usize,
        stride: usize,
        count: usize,
        out: usize,
        regs: usize,
        result: usize,
    ) {
        unsafe {
            crate::program::eval(
                code as *const i32,
                ninstr,
                consts as *const f32,
                origins as *const i32,
                seed,
                pts as *const f32,
                stride,
                count,
                out as *mut f32,
                regs as *mut f32,
                result,
            )
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn hash_seed(seed: u32, label: u32) -> u32 {
        crate::hash::hash_seed(seed, label)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn abi_version() -> u32 {
        crate::ABI_VERSION
    }

    /// Points per block: a register's length.
    #[unsafe(no_mangle)]
    pub extern "C" fn block_size() -> usize {
        crate::program::BLOCK
    }
}
