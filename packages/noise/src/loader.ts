import { ShardError } from '@aethervtt/shard-core'
import { instantiate, type KernelState } from './kernel'

export interface NoiseKernel {
  /** The compiled module; workers instantiate it from this (modules are cheap to post). */
  readonly module: WebAssembly.Module
  /** This thread's instance. */
  readonly state: KernelState
  /** Whether this is the simd128 build. */
  readonly simd: boolean
}

// The smallest module using a v128 instruction (from wasm-feature-detect).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
])

/** Whether this host runs WebAssembly SIMD (every current browser and Node does). */
export function simdSupported(): boolean {
  return WebAssembly.validate(SIMD_PROBE)
}

/**
 * URL of the kernel's JavaScript side (kernel.js), for other packages' pool jobs: a worker module
 * imports it with `import(url)` and instantiates the posted `NoiseKernel.module`, so it samples
 * exactly as this thread does.
 */
export const NOISE_KERNEL_MODULE = new URL('./kernel.js', import.meta.url).href

const loaded = new Map<boolean, Promise<NoiseKernel>>()
let current: NoiseKernel | undefined

async function readWasm(file: string): Promise<Uint8Array | Response> {
  const url = new URL(`../wasm/${file}`, import.meta.url)
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises')
    const data = await readFile(url)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  const res = await fetch(url)
  if (!res.ok) {
    throw new ShardError(
      'noise/kernel-load-failed',
      `Couldn't fetch the noise kernel (${res.status})`,
      {
        path: url.href,
        hint: 'The .wasm files live in packages/noise/wasm; the dev server must serve them.',
      },
    )
  }
  return res
}

/**
 * Loads the WASM noise kernel once per thread: the SIMD build where the host supports it (or when
 * `simd` says so), the scalar build otherwise. The two give bitwise-equal results.
 */
export function loadNoiseKernel(options: { simd?: boolean } = {}): Promise<NoiseKernel> {
  // A kernel installed from a posted module (a worker) is this thread's kernel.
  if (options.simd === undefined && current && installed) return Promise.resolve(current)
  const simd = options.simd ?? simdSupported()
  let p = loaded.get(simd)
  if (!p) {
    p = (async () => {
      const source = await readWasm(simd ? 'shard_noise_simd.wasm' : 'shard_noise.wasm')
      let module: WebAssembly.Module
      try {
        module =
          source instanceof Uint8Array
            ? await WebAssembly.compile(source as Uint8Array<ArrayBuffer>)
            : await WebAssembly.compileStreaming(source)
      } catch (cause) {
        throw new ShardError('noise/kernel-load-failed', "The noise kernel didn't compile", {
          cause,
          hint: 'Rebuild it with `pnpm build:wasm`.',
        })
      }
      const instance = await WebAssembly.instantiate(module, {})
      const kernel: NoiseKernel = { module, state: instantiate(module, instance), simd }
      if (options.simd === undefined || !current) current = kernel
      return kernel
    })()
    loaded.set(simd, p)
  }
  return p
}

let installed = false

/**
 * Makes a compiled kernel module (`noiseKernel().module`, posted from another thread) this thread's
 * kernel, so a worker samples without fetching the .wasm. Later `loadNoiseKernel()` calls return it.
 */
export function useNoiseKernel(module: WebAssembly.Module, simd = true): NoiseKernel {
  if (current?.module === module) return current
  const kernel: NoiseKernel = { module, state: instantiate(module), simd }
  loaded.set(simd, Promise.resolve(kernel))
  current = kernel
  installed = true
  return kernel
}

/** The kernel sync sampling uses. Throws `noise/kernel-not-loaded` before `loadNoiseKernel`. */
export function noiseKernel(): NoiseKernel {
  if (!current) {
    throw new ShardError('noise/kernel-not-loaded', 'The noise kernel is not loaded yet', {
      hint: 'await loadNoiseKernel() (or load a NoiseGraph asset, which does) before sampling synchronously.',
    })
  }
  return current
}
