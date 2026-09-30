import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'

// Engine data a vertex or fragment shader reads by index (instances, lights, sprite records), one
// binding on either tier (0064):
//
// - full: today's storage buffer, written as always (this is a thin wrapper over GpuBuffer);
// - baseline, `texture`: an rgba32uint data texture the baseline rewrite reads through generated
//   loaders. Texel k holds bytes [16k, 16k + 16) of what the storage buffer would hold, 1,024
//   texels a row, and the last texel holds the byte length (for `arrayLength`). Writes land in a
//   CPU copy and upload before the frame's submit as at most three row spans;
// - baseline, `uniform`: a uniform buffer, for `@data(uniform)` declarations.
//
// The shader side is a `@data` declaration at the same binding (see shader/baseline/data.ts).

/** Texels per row of a data texture (matches the baseline rewrite's loaders). */
export const DATA_WIDTH = 1024

export interface DataStoreOptions {
  label: string
  /** Initial size in bytes. Default 256. */
  size?: number
  /** Buffer usages on the full tier beyond STORAGE (a GPU pass that writes it, say). */
  usage?: GPUBufferUsageFlags
  /** How baseline shaders read it: a data texture (default), or a uniform block. */
  kind?: 'texture' | 'uniform'
}

const stores = new WeakMap<GpuContext, DataStore[]>()

/** Uploads what every baseline data texture of `gpu` was written this frame. Before the submit. */
export function flushDataStores(gpu: GpuContext): void {
  const list = stores.get(gpu)
  if (!list) return
  for (let i = 0; i < list.length; i++) list[i]!.flush()
}

/**
 * A binding of indexed engine data that a vertex or fragment shader reads. Same calls as
 * GpuBuffer: `ensureCapacity`, `write`, `version` (bumps when bind groups must be rebuilt); plus
 * the layout entry and resource of whichever form the tier binds.
 */
export class DataStore {
  readonly label: string
  readonly kind: 'texture' | 'uniform'
  /** The texture form: the baseline tier's `@data` binding. */
  readonly textured: boolean
  private readonly gpu: GpuContext
  private readonly buffer: GpuBuffer | undefined
  private texture: GPUTexture | undefined
  private view: GPUTextureView | undefined
  private mirror = new Uint8Array(0)
  private size: number
  private rows = 0
  private generation = -1
  private textureVersion = 0
  private dirtyStart = Number.POSITIVE_INFINITY
  private dirtyEnd = 0
  // Reused upload descriptors: flushing allocates nothing.
  private readonly destination: GPUTexelCopyTextureInfo & { origin: { x: number; y: number } }
  private readonly layout = { offset: 0, bytesPerRow: DATA_WIDTH * 16 }
  private readonly extent = { width: 0, height: 0 }

  constructor(gpu: GpuContext, options: DataStoreOptions) {
    this.gpu = gpu
    this.label = options.label
    this.kind = options.kind ?? 'texture'
    this.size = align16(Math.max(16, options.size ?? 256))
    this.textured = gpu.tier === 'baseline' && this.kind === 'texture'
    this.destination = { texture: undefined as unknown as GPUTexture, origin: { x: 0, y: 0 } }
    if (!this.textured) {
      this.buffer = new GpuBuffer(gpu, {
        label: options.label,
        usage:
          gpu.tier === 'baseline'
            ? GPUBufferUsage.UNIFORM
            : GPUBufferUsage.STORAGE | (options.usage ?? 0),
        size: this.size,
      })
      return
    }
    this.mirror = new Uint8Array(this.size)
    let list = stores.get(gpu)
    if (!list) {
      list = []
      stores.set(gpu, list)
    }
    list.push(this)
  }

  /** Bumps whenever the GPU object changes: bind groups made on the old one rebuild. */
  get version(): number {
    this.checkGeneration()
    return this.buffer ? this.buffer.version : this.textureVersion
  }

  get byteLength(): number {
    return this.buffer ? this.buffer.byteLength : this.size
  }

  /** The buffer, on the tiers that bind one (full, and baseline uniform blocks). */
  get gpuBuffer(): GPUBuffer {
    if (!this.buffer) throw new Error(`${this.label} is a data texture on this tier`)
    return this.buffer.buffer
  }

  /** Grows to at least `bytes`. Returns true if the GPU object was replaced. */
  ensureCapacity(bytes: number): boolean {
    if (this.buffer) return this.buffer.ensureCapacity(bytes)
    this.checkGeneration()
    if (bytes <= this.size) return false
    let size = this.size
    while (size < bytes) size *= 2
    const mirror = new Uint8Array(size)
    mirror.set(this.mirror)
    this.mirror = mirror
    this.size = size
    this.recreate()
    return true
  }

  /** Writes a TypedArray (or a slice of it, in elements) at a byte offset, growing if needed. */
  write(
    data: ArrayBufferView & ArrayLike<number>,
    byteOffset = 0,
    start = 0,
    count?: number,
  ): void {
    if (this.buffer) {
      this.buffer.write(data, byteOffset, start, count)
      return
    }
    const bytesPerElement = (data as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
    const elements = count ?? data.length - start
    const bytes = elements * bytesPerElement
    this.ensureCapacity(byteOffset + bytes)
    if (elements === 0) return
    this.checkGeneration()
    this.mirror.set(
      new Uint8Array(data.buffer, data.byteOffset + start * bytesPerElement, bytes),
      byteOffset,
    )
    if (byteOffset < this.dirtyStart) this.dirtyStart = byteOffset
    if (byteOffset + bytes > this.dirtyEnd) this.dirtyEnd = byteOffset + bytes
  }

  /** The bind group layout entry for this binding on this tier. */
  layoutEntry(
    binding: number,
    visibility: GPUShaderStageFlags,
    type: GPUBufferBindingType = 'read-only-storage',
  ): GPUBindGroupLayoutEntry {
    if (this.textured) {
      return { binding, visibility, texture: { sampleType: 'uint', viewDimension: '2d' } }
    }
    if (this.gpu.tier === 'baseline') return { binding, visibility, buffer: { type: 'uniform' } }
    return { binding, visibility, buffer: { type } }
  }

  /** What the bind group binds. Rebuild bind groups when `version` changes. */
  resource(): GPUBindingResource {
    if (this.buffer) return { buffer: this.buffer.buffer }
    this.checkGeneration()
    return this.view!
  }

  /** Uploads the rows written since the last flush (data textures; the rest write through). */
  flush(): void {
    if (this.dirtyEnd <= this.dirtyStart) return
    this.checkGeneration()
    const first = Math.floor(this.dirtyStart / 16)
    const last = Math.ceil(this.dirtyEnd / 16) // exclusive
    this.dirtyStart = Number.POSITIVE_INFINITY
    this.dirtyEnd = 0
    const row0 = Math.floor(first / DATA_WIDTH)
    const row1 = Math.floor((last - 1) / DATA_WIDTH)
    if (row0 === row1) {
      this.upload(first % DATA_WIDTH, row0, last - first, 1)
      return
    }
    // A partial first row, whole rows between, a partial last row.
    this.upload(first % DATA_WIDTH, row0, DATA_WIDTH - (first % DATA_WIDTH), 1)
    if (row1 > row0 + 1) this.upload(0, row0 + 1, DATA_WIDTH, row1 - row0 - 1)
    this.upload(0, row1, last - row1 * DATA_WIDTH, 1)
  }

  destroy(): void {
    this.buffer?.destroy()
    this.texture?.destroy()
    const list = stores.get(this.gpu)
    const i = list ? list.indexOf(this) : -1
    if (i !== -1) list!.splice(i, 1)
  }

  private upload(x: number, y: number, width: number, height: number): void {
    this.destination.texture = this.texture!
    this.destination.origin.x = x
    this.destination.origin.y = y
    this.layout.offset = (y * DATA_WIDTH + x) * 16
    this.extent.width = width
    this.extent.height = height
    this.gpu.device.queue.writeTexture(this.destination, this.mirror, this.layout, this.extent)
  }

  /** A texture for the current size (plus the length texel), everything uploaded again. */
  private recreate(): void {
    this.texture?.destroy()
    const texels = this.size / 16 + 1
    this.rows = Math.ceil(texels / DATA_WIDTH)
    // The mirror covers whole rows, so row uploads never read past its end.
    if (this.mirror.byteLength < this.rows * DATA_WIDTH * 16) {
      const mirror = new Uint8Array(this.rows * DATA_WIDTH * 16)
      mirror.set(this.mirror)
      this.mirror = mirror
    }
    new Uint32Array(this.mirror.buffer, (this.rows * DATA_WIDTH - 1) * 16, 4)[0] = this.size
    this.texture = this.gpu.device.createTexture({
      label: this.label,
      size: [DATA_WIDTH, this.rows],
      format: 'rgba32uint',
      // COPY_SRC: tools and tests read a data texture back.
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    })
    this.view = this.texture.createView()
    this.generation = this.gpu.generation
    this.textureVersion++
    this.dirtyStart = 0
    this.dirtyEnd = this.rows * DATA_WIDTH * 16
  }

  /** After device loss (or on first use) the texture is made again from the CPU copy. */
  private checkGeneration(): void {
    if (this.generation !== this.gpu.generation) this.recreate()
  }
}

function align16(n: number): number {
  return (n + 15) & ~15
}
