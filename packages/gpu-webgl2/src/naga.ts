import { ShardError } from '@aethervtt/shard-core'

// naga (crates/shard-naga) as WebAssembly: one WGSL entry point in, GLSL ES 3.00 out, with the
// binding reflection the shim binds by. Loaded on the first translation the cache doesn't have
// (0064): a session whose shaders are all baked never downloads it.

export type GlslStage = 'vertex' | 'fragment'

export interface GlslTranslation {
  glsl: string
  /** Combined sampler uniforms: the texture binding, and the sampler's (null for `texelFetch`). */
  textures: { name: string; group: number; binding: number; sampler: [number, number] | null }[]
  /** Uniform blocks by block name. */
  uniforms: { name: string; group: number; binding: number }[]
  varyings: { name: string; location: number }[]
  /** Uses `naga_vs_first_instance`, the uniform standing in for the draw's first instance. */
  firstInstance: boolean
}

export interface TranslateOptions {
  /**
   * `EXT_clip_control` sets depth to [0, 1] as WebGPU has it: only y is flipped. Without it,
   * naga maps z to [-1, 1] too (the same depth values, less precision far away).
   */
  clipControl: boolean
}

export interface Naga {
  /** naga's release: part of every translation's cache key. */
  readonly version: string
  translate(
    wgsl: string,
    entry: string,
    stage: GlslStage,
    options: TranslateOptions,
  ): GlslTranslation
}

interface NagaExports {
  memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(ptr: number, len: number): void
  translate(
    src: number,
    srcLen: number,
    entry: number,
    entryLen: number,
    stage: number,
    flags: number,
  ): number
  version(): number
  result_ptr(): number
  result_len(): number
}

const ADJUST_COORDINATE_SPACE = 1
/** What naga writes at the end of a vertex entry point with ADJUST_COORDINATE_SPACE. */
const Z_REMAP = 'gl_Position.yz = vec2(-gl_Position.y, gl_Position.z * 2.0 - gl_Position.w);'
const Y_FLIP = 'gl_Position.y = -gl_Position.y;'

let loading: Promise<Naga> | undefined

/** Loads naga once. Rejects with `gpu-webgl2/naga-load-failed` if the module can't be fetched. */
export function loadNaga(): Promise<Naga> {
  loading ??= (async () => {
    const module = await compileNaga()
    return nagaFrom(module)
  })()
  loading.catch(() => {
    loading = undefined
  })
  return loading
}

async function compileNaga(): Promise<WebAssembly.Module> {
  const url = new URL('../wasm/shard_naga.wasm', import.meta.url)
  try {
    if (url.protocol === 'file:') {
      const { readFile } = await import('node:fs/promises')
      const data = await readFile(url)
      return await WebAssembly.compile(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as Uint8Array<ArrayBuffer>,
      )
    }
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await WebAssembly.compileStreaming(response)
  } catch (cause) {
    throw new ShardError(
      'gpu-webgl2/naga-load-failed',
      "Couldn't load naga, the shader translator",
      {
        cause,
        path: url.href,
        hint: 'packages/gpu-webgl2/wasm must be served with the app (rebuild with `pnpm build:wasm`).',
      },
    )
  }
}

function nagaFrom(module: WebAssembly.Module): Naga {
  let exports = instantiate(module)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const read = () =>
    decoder.decode(
      new Uint8Array(exports.memory.buffer, exports.result_ptr(), exports.result_len()),
    )
  exports.version()
  const version = read()
  return {
    version,
    translate(wgsl, entry, stage, options) {
      const src = encoder.encode(wgsl)
      const name = encoder.encode(entry)
      let status: number
      let json: string
      try {
        const srcPtr = exports.alloc(src.length)
        const namePtr = exports.alloc(name.length)
        new Uint8Array(exports.memory.buffer, srcPtr, src.length).set(src)
        new Uint8Array(exports.memory.buffer, namePtr, name.length).set(name)
        status = exports.translate(
          srcPtr,
          src.length,
          namePtr,
          name.length,
          stage === 'vertex' ? 0 : 1,
          ADJUST_COORDINATE_SPACE,
        )
        json = read()
        exports.dealloc(srcPtr, src.length)
        exports.dealloc(namePtr, name.length)
      } catch (cause) {
        // A panic aborts the instance: make a fresh one for the next translation.
        exports = instantiate(module)
        throw new ShardError('gpu-webgl2/naga-crashed', `naga crashed translating ${entry}`, {
          cause,
          hint: 'Report the shader: naga should return an error, not crash.',
        })
      }
      const result = JSON.parse(json) as GlslTranslation | { error: string }
      if (status !== 0 || 'error' in result) {
        throw new ShardError(
          'gpu-webgl2/translate',
          `WGSL → GLSL failed for ${entry}: ${(result as { error: string }).error}`,
        )
      }
      if (options.clipControl && stage === 'vertex') {
        result.glsl = result.glsl.replaceAll(Z_REMAP, Y_FLIP)
      }
      return result
    },
  }
}

function instantiate(module: WebAssembly.Module): NagaExports {
  return new WebAssembly.Instance(module, {}).exports as unknown as NagaExports
}
