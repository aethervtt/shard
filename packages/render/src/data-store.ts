import { ShardError } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { DATA_TEXTURE_WIDTH } from '@aethervtt/shard-shader'
import type { DataTexture } from './baseline/data-texture'

// Engine data a vertex or fragment shader reads by index (instances, lights, sprite records), one
// binding on either tier (0064):
//
// - full: today's storage buffer, written as always (this is a thin wrapper over GpuBuffer);
// - baseline, `texture`: an rgba32uint data texture (baseline/data-texture.ts, loaded only on a
//   baseline device) holding the same bytes, read by the baseline rewrite's generated loaders;
// - baseline, `uniform`: a uniform buffer, for `@data(uniform)` declarations.
//
// The shader side is a `@data` declaration at the same binding (see shader/data-marks.ts).

/** Texels per row of a data texture (the baseline rewrite's loaders read the same). */
export const DATA_WIDTH = DATA_TEXTURE_WIDTH

export interface DataStoreOptions {
  label: string
  /** Initial size in bytes. Default 256. */
  size?: number
  /**
   * Buffer usages beyond STORAGE (full tier) or UNIFORM (a baseline uniform block): a GPU pass that
   * writes it, a readback. Data textures ignore it.
   */
  usage?: GPUBufferUsageFlags
  /** How baseline shaders read it: a data texture (default), or a uniform block. */
  kind?: 'texture' | 'uniform'
}

let dataTextures: typeof import('./baseline/data-texture') | undefined

/**
 * Loads the baseline tier's data textures, once. The render plugin does it as it opens a baseline
 * device, before anything makes a DataStore; so does code that makes one on its own device.
 */
export async function loadDataTextures(): Promise<void> {
  dataTextures ??= await import('./baseline/data-texture')
}

/**
 * The layout entry a DataStore of `kind` binds with on this device's tier, for layouts made
 * before (or without) the store: storage on the full tier, a data texture or a uniform block on
 * baseline.
 */
export function dataEntry(
  gpu: GpuContext,
  binding: number,
  visibility: GPUShaderStageFlags,
  kind: 'texture' | 'uniform' = 'texture',
  type: GPUBufferBindingType = 'read-only-storage',
): GPUBindGroupLayoutEntry {
  if (gpu.tier !== 'baseline') return { binding, visibility, buffer: { type } }
  if (kind === 'uniform') return { binding, visibility, buffer: { type: 'uniform' } }
  return { binding, visibility, texture: { sampleType: 'uint', viewDimension: '2d' } }
}

/**
 * Forgets the data textures `owner` made on `gpu` (an app's render plugin, as it disposes): the
 * ledger destroys their textures, so they must not flush again.
 */
export function releaseDataStores(gpu: GpuContext, owner: string): void {
  dataTextures?.releaseDataTextures(gpu, owner)
}

/** Uploads what every baseline data texture of `gpu` was written this frame. Before the submit. */
export function flushDataStores(gpu: GpuContext): void {
  dataTextures?.flushDataTextures(gpu)
}

/**
 * A binding of indexed engine data that a vertex or fragment shader reads. Same calls as
 * GpuBuffer: `ensureCapacity`, `write`, `version` (bumps when bind groups must be rebuilt); plus
 * the layout entry and resource of whichever form the tier binds.
 */
export class DataStore {
  readonly label: string
  readonly kind: 'texture' | 'uniform'
  /** Who its GPU objects count against (`gpu.owner` when it was made). */
  readonly owner: string
  /** The texture form: the baseline tier's `@data` binding. */
  readonly textured: boolean
  private readonly gpu: GpuContext
  private readonly buffer: GpuBuffer | undefined
  private readonly texture: DataTexture | undefined

  constructor(gpu: GpuContext, options: DataStoreOptions) {
    this.gpu = gpu
    this.label = options.label
    this.owner = gpu.owner
    this.kind = options.kind ?? 'texture'
    const size = align16(Math.max(16, options.size ?? 256))
    this.textured = gpu.tier === 'baseline' && this.kind === 'texture'
    if (this.textured) {
      if (!dataTextures) {
        throw new ShardError(
          'render/data-textures-not-loaded',
          `DataStore "${options.label}" needs the baseline tier's data textures, which aren't loaded`,
          { hint: 'Await loadDataTextures() before making DataStores on a baseline device.' },
        )
      }
      this.texture = new dataTextures.DataTexture(gpu, options.label, size)
      return
    }
    this.buffer = new GpuBuffer(gpu, {
      label: options.label,
      usage:
        (gpu.tier === 'baseline' ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) |
        (options.usage ?? 0),
      size,
    })
  }

  /** Bumps whenever the GPU object changes: bind groups made on the old one rebuild. */
  get version(): number {
    return this.buffer ? this.buffer.version : this.texture!.currentVersion
  }

  get byteLength(): number {
    return this.buffer ? this.buffer.byteLength : this.texture!.size
  }

  /**
   * The buffer, on the tiers that bind one (full, and baseline uniform blocks): for full-tier
   * passes that read or write it as storage (GPU culling).
   */
  get gpuBuffer(): GPUBuffer {
    if (!this.buffer) throw new Error(`${this.label} is a data texture on this tier`)
    return this.buffer.buffer
  }

  /** Grows to at least `bytes`. Returns true if the GPU object was replaced. */
  ensureCapacity(bytes: number): boolean {
    return this.buffer ? this.buffer.ensureCapacity(bytes) : this.texture!.ensureCapacity(bytes)
  }

  /** Writes a TypedArray (or a slice of it, in elements) at a byte offset, growing if needed. */
  write(
    data: ArrayBufferView & ArrayLike<number>,
    byteOffset = 0,
    start = 0,
    count?: number,
  ): void {
    if (this.buffer) this.buffer.write(data, byteOffset, start, count)
    else this.texture!.write(data, byteOffset, start, count)
  }

  /** The bind group layout entry for this binding on this tier. */
  layoutEntry(
    binding: number,
    visibility: GPUShaderStageFlags,
    type: GPUBufferBindingType = 'read-only-storage',
  ): GPUBindGroupLayoutEntry {
    return dataEntry(this.gpu, binding, visibility, this.kind, type)
  }

  /** What the bind group binds. Rebuild bind groups when `version` changes. */
  resource(): GPUBindingResource {
    return this.buffer ? { buffer: this.buffer.buffer } : this.texture!.resource()
  }

  /** Uploads the rows written since the last flush (data textures; the rest write through). */
  flush(): void {
    this.texture?.flush()
  }

  destroy(): void {
    this.buffer?.destroy()
    this.texture?.destroy()
  }
}

function align16(n: number): number {
  return (n + 15) & ~15
}
