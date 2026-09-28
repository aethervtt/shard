/** Live GPU objects counted against one owner (`gpu.stats(owner)`). */
export interface GpuStats {
  buffers: number
  textures: number
  /** Their memory: buffer sizes, and texture sizes over every mip level and sample. */
  bytes: number
}

/** The owner of objects made while no app runs, and of per-device objects apps share. */
export const SHARED_OWNER = 'gpu'

interface Entry {
  readonly owner: Owned
  readonly texture: boolean
  readonly bytes: number
  readonly ref: WeakRef<GPUBuffer | GPUTexture>
  live: boolean
}

interface Owned extends GpuStats {
  readonly name: string
  readonly entries: Set<Entry>
}

/** What a tracked object's own `destroy` needs: its entry and the prototype's destroy. */
const entryOf = new WeakMap<object, { ledger: Ledger; entry: Entry }>()

/** Replaces `destroy` on tracked objects: uncount, then destroy for real. */
function destroyTracked(this: GPUBuffer | GPUTexture): undefined {
  const tracked = entryOf.get(this)
  if (tracked) tracked.ledger.drop(tracked.entry)
  ;(Object.getPrototypeOf(this) as { destroy(): void }).destroy.call(this)
  return undefined
}

/**
 * Counts the buffers and textures a device creates, by owner (0052). Destroying an object uncounts
 * it; so does garbage collection of one nobody destroyed. `release(owner)` destroys what an owner
 * still has, which is how a disposed app gives back everything it made.
 */
export class Ledger {
  private readonly owners = new Map<string, Owned>()
  private readonly finalizer = new FinalizationRegistry<Entry>((entry) => this.drop(entry))

  track(object: GPUBuffer | GPUTexture, owner: string, texture: boolean, bytes: number): void {
    const owned = this.owned(owner)
    const entry: Entry = { owner: owned, texture, bytes, ref: new WeakRef(object), live: true }
    owned.entries.add(entry)
    if (texture) owned.textures++
    else owned.buffers++
    owned.bytes += bytes
    entryOf.set(object, { ledger: this, entry })
    this.finalizer.register(object, entry, entry)
    object.destroy = destroyTracked
  }

  drop(entry: Entry): void {
    if (!entry.live) return
    entry.live = false
    this.finalizer.unregister(entry)
    const owned = entry.owner
    owned.entries.delete(entry)
    if (entry.texture) owned.textures--
    else owned.buffers--
    owned.bytes -= entry.bytes
  }

  /** Destroys every object `owner` still has. Returns how many there were. */
  release(owner: string): number {
    const owned = this.owners.get(owner)
    if (!owned) return 0
    let n = 0
    for (const entry of [...owned.entries]) {
      const object = entry.ref.deref()
      this.drop(entry)
      object?.destroy()
      n++
    }
    return n
  }

  /** Forgets everything without destroying it: the device it lived on is gone. */
  clear(): void {
    for (const owned of this.owners.values()) {
      for (const entry of owned.entries) {
        entry.live = false
        this.finalizer.unregister(entry)
      }
      owned.entries.clear()
      owned.buffers = owned.textures = owned.bytes = 0
    }
  }

  stats(owner?: string): GpuStats {
    if (owner !== undefined) {
      const owned = this.owners.get(owner)
      return {
        buffers: owned?.buffers ?? 0,
        textures: owned?.textures ?? 0,
        bytes: owned?.bytes ?? 0,
      }
    }
    const total: GpuStats = { buffers: 0, textures: 0, bytes: 0 }
    for (const owned of this.owners.values()) {
      total.buffers += owned.buffers
      total.textures += owned.textures
      total.bytes += owned.bytes
    }
    return total
  }

  /** Owners that have live objects, sorted. */
  names(): string[] {
    return [...this.owners.values()]
      .filter((o) => o.buffers + o.textures > 0)
      .map((o) => o.name)
      .sort()
  }

  private owned(name: string): Owned {
    let owned = this.owners.get(name)
    if (!owned) {
      owned = { name, entries: new Set(), buffers: 0, textures: 0, bytes: 0 }
      this.owners.set(name, owned)
    }
    return owned
  }
}

/** [block width, block height, bytes per block] for compressed formats; texels are 1×1 blocks. */
function blockOf(format: GPUTextureFormat): [number, number, number] {
  if (format.startsWith('astc-')) {
    const [w, h] = format.slice(5).split(/[x-]/).map(Number)
    return [w!, h!, 16]
  }
  if (/^(bc1|bc4|etc2-rgb8|eac-r11)/.test(format)) return [4, 4, 8]
  if (/^(bc|etc2|eac)/.test(format)) return [4, 4, 16]
  if (/^(rgba32|rgb32)/.test(format)) return [1, 1, 16]
  if (/^(rgba16|rg32)/.test(format) || format === 'depth32float-stencil8') return [1, 1, 8]
  if (/^(r8|stencil8)/.test(format)) return [1, 1, 1]
  if (/^(rg8|r16|depth16)/.test(format)) return [1, 1, 2]
  return [1, 1, 4]
}

/** Bytes a texture takes: every mip level (and 3D slice), times its sample count. */
export function textureBytes(descriptor: GPUTextureDescriptor): number {
  const size = descriptor.size as number[] | GPUExtent3DDict
  const width = Array.isArray(size) ? size[0]! : size.width
  const height = (Array.isArray(size) ? size[1] : size.height) ?? 1
  const layers = (Array.isArray(size) ? size[2] : size.depthOrArrayLayers) ?? 1
  const is3d = descriptor.dimension === '3d'
  const [bw, bh, bytes] = blockOf(descriptor.format)
  let total = 0
  for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level++) {
    const w = Math.max(1, width >> level)
    const h = Math.max(1, height >> level)
    const d = is3d ? Math.max(1, layers >> level) : layers
    total += Math.ceil(w / bw) * Math.ceil(h / bh) * bytes * d
  }
  return total * (descriptor.sampleCount ?? 1)
}
