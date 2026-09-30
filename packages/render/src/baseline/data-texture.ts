import { DATA_TEXTURE_PREFIX, type GpuContext } from '@aethervtt/shard-gpu'
import { DATA_TEXTURE_WIDTH as DATA_WIDTH } from '@aethervtt/shard-shader'

// Baseline tier (0064), loaded only on a baseline device: the data texture behind a DataStore of
// kind `texture`. It holds exactly what the storage buffer would, 16 bytes a texel (rgba32uint),
// DATA_WIDTH texels a row, with the byte length in the last texel (for `arrayLength`), and the
// baseline rewrite's loaders read it at the same byte offsets. Writes land in a CPU copy and upload
// before the frame's submit as at most three row spans, with reused descriptors.

const textures = new WeakMap<GpuContext, DataTexture[]>()
/** Byte and word views of written arrays' buffers, made once per buffer. */
const bytesOf = new WeakMap<ArrayBufferLike, Uint8Array>()
const wordsOf = new WeakMap<ArrayBufferLike, Uint32Array>()

function bytes(buffer: ArrayBufferLike): Uint8Array {
  let view = bytesOf.get(buffer)
  if (!view) {
    view = new Uint8Array(buffer)
    bytesOf.set(buffer, view)
  }
  return view
}

function words(buffer: ArrayBufferLike): Uint32Array {
  let view = wordsOf.get(buffer)
  if (!view) {
    view = new Uint32Array(buffer, 0, buffer.byteLength >> 2)
    wordsOf.set(buffer, view)
  }
  return view
}

/** Uploads what every data texture of `gpu` was written this frame. */
export function flushDataTextures(gpu: GpuContext): void {
  const list = textures.get(gpu)
  if (!list) return
  for (let i = 0; i < list.length; i++) list[i]!.flush()
}

/** Forgets `owner`'s data textures on `gpu`: the ledger destroys them, so they mustn't flush. */
export function releaseDataTextures(gpu: GpuContext, owner: string): void {
  const list = textures.get(gpu)
  if (!list) return
  let n = 0
  for (let i = 0; i < list.length; i++) if (list[i]!.owner !== owner) list[n++] = list[i]!
  list.length = n
}

export class DataTexture {
  readonly owner: string
  version = 0
  private readonly gpu: GpuContext
  private readonly label: string
  private texture: GPUTexture | undefined
  private view: GPUTextureView | undefined
  private mirror: Uint8Array
  private mirrorWords: Uint32Array
  size: number
  private rows = 0
  private generation = -1
  private dirtyStart = Number.POSITIVE_INFINITY
  private dirtyEnd = 0
  // Reused upload descriptors: flushing allocates nothing.
  private readonly destination: GPUTexelCopyTextureInfo & { origin: { x: number; y: number } }
  private readonly layout = { offset: 0, bytesPerRow: DATA_WIDTH * 16 }
  private readonly extent = { width: 0, height: 0 }

  constructor(gpu: GpuContext, label: string, size: number) {
    this.gpu = gpu
    this.label = label
    this.owner = gpu.owner
    this.size = size
    this.mirror = new Uint8Array(size)
    this.mirrorWords = new Uint32Array(this.mirror.buffer)
    this.destination = { texture: undefined as unknown as GPUTexture, origin: { x: 0, y: 0 } }
    let list = textures.get(gpu)
    if (!list) {
      list = []
      textures.set(gpu, list)
    }
    list.push(this)
  }

  get currentVersion(): number {
    this.checkGeneration()
    return this.version
  }

  ensureCapacity(bytes: number): boolean {
    this.checkGeneration()
    if (bytes <= this.size) return false
    let size = this.size
    while (size < bytes) size *= 2
    const mirror = new Uint8Array(size)
    // The old mirror may run past its size, to whole rows.
    mirror.set(this.mirror.subarray(0, this.size))
    this.setMirror(mirror)
    this.size = size
    this.recreate()
    return true
  }

  write(
    data: ArrayBufferView & ArrayLike<number>,
    byteOffset: number,
    start: number,
    count: number | undefined,
  ): void {
    const bytesPerElement = (data as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
    const elements = count ?? data.length - start
    const length = elements * bytesPerElement
    this.ensureCapacity(byteOffset + length)
    if (elements === 0) return
    this.checkGeneration()
    const from = data.byteOffset + start * bytesPerElement
    if (((from | byteOffset | length) & 3) === 0) {
      // Whole words, copied through views made once per buffer: nothing allocated per write.
      const src = words(data.buffer)
      const dst = this.mirrorWords
      const s = from >> 2
      const d = byteOffset >> 2
      for (let i = 0, n = length >> 2; i < n; i++) dst[d + i] = src[s + i]!
    } else {
      const src = bytes(data.buffer)
      const dst = this.mirror
      for (let i = 0; i < length; i++) dst[byteOffset + i] = src[from + i]!
    }
    if (byteOffset < this.dirtyStart) this.dirtyStart = byteOffset
    if (byteOffset + length > this.dirtyEnd) this.dirtyEnd = byteOffset + length
  }

  resource(): GPUBindingResource {
    this.checkGeneration()
    return this.view!
  }

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
    this.texture?.destroy()
    const list = textures.get(this.gpu)
    const i = list ? list.indexOf(this) : -1
    if (i !== -1) list!.splice(i, 1)
  }

  private setMirror(mirror: Uint8Array): void {
    this.mirror = mirror
    this.mirrorWords = new Uint32Array(mirror.buffer)
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
      this.setMirror(mirror)
    }
    this.mirrorWords[(this.rows * DATA_WIDTH - 1) * 4] = this.size
    // Made when first flushed or after growth, wherever that runs: it counts against the owner.
    this.texture = this.gpu.withOwner(this.owner, () =>
      this.gpu.device.createTexture({
        label: `${DATA_TEXTURE_PREFIX}${this.label}`,
        size: [DATA_WIDTH, this.rows],
        format: 'rgba32uint',
        // COPY_SRC: tools and tests read a data texture back.
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      }),
    )
    this.view = this.texture.createView()
    this.generation = this.gpu.generation
    this.version++
    this.dirtyStart = 0
    this.dirtyEnd = this.rows * DATA_WIDTH * 16
  }

  /** After device loss (or on first use) the texture is made again from the CPU copy. */
  private checkGeneration(): void {
    if (this.generation !== this.gpu.generation) this.recreate()
  }
}
