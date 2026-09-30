/** Live GPU objects counted against one owner (`gpu.stats(owner)`). */
export interface GpuStats {
  buffers: number
  textures: number
  /** Their memory: buffer sizes, and texture sizes over every mip level and sample. */
  bytes: number
}

/**
 * What a GPU object is for, from its usage flags (0062): `targets` (textures rendered into),
 * `textures` (sampled only), `geometry` (vertex and index buffers), `storage`, `uniforms`,
 * `staging` (mappable: uploads and readbacks), and `other`.
 */
export type GpuMemoryCategory =
  | 'targets'
  | 'textures'
  | 'geometry'
  | 'storage'
  | 'uniforms'
  | 'staging'
  | 'other'

/**
 * What bytes written to the GPU were for (0055), from the label of the buffer or texture written:
 * `instances` (instance records), `meshes` (vertex and index data), `materials` (material
 * uniforms), `textures`, `lights`, `shadows` (shadow views), `view` (camera and per-frame
 * uniforms, culling parameters: derived from the view, not the scene), and `other`.
 */
export const UPLOAD_CATEGORIES = [
  'instances',
  'meshes',
  'materials',
  'textures',
  'lights',
  'shadows',
  'view',
  'other',
] as const
export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number]

/** Bytes written and objects created by an owner since the device was made (`gpu.uploads(owner)`). */
export interface GpuUploads {
  /** Cumulative bytes written, indexed like `UPLOAD_CATEGORIES`. */
  readonly bytes: Float64Array
  /** Buffers and textures created. */
  created: number
}

/** Index of each category in `UPLOAD_CATEGORIES` (and in `GpuUploads.bytes`). */
export const Upload = {
  instances: 0,
  meshes: 1,
  materials: 2,
  textures: 3,
  lights: 4,
  shadows: 5,
  view: 6,
  other: 7,
} as const satisfies Record<UploadCategory, number>

/** The upload category of a buffer or texture, from its label. Textures are always `textures`. */
export function uploadCategory(label: string | undefined, texture: boolean): number {
  if (texture) return Upload.textures
  const l = label ?? ''
  // A view's culled list is derived from the view, rewritten every frame it's culled on the CPU.
  if (l === 'instances/visible') return Upload.view
  if (l.startsWith('instances')) return Upload.instances
  if (l.startsWith('mesh/') || l.startsWith('mesh ')) return Upload.meshes
  if (l.startsWith('material')) return Upload.materials
  if (l === 'lights' || l.startsWith('lights/')) return Upload.lights
  if (l.startsWith('shadows/')) return Upload.shadows
  // Per-view buffers are named after their view (`camera:12/view`, `window/tonemap`).
  if (
    l.startsWith('camera:') ||
    l.startsWith('window/') ||
    l === 'globals' ||
    l.startsWith('cull/') ||
    l.endsWith('/view') ||
    l.includes('light-clusters')
  )
    return Upload.view
  return Upload.other
}

/** Live bytes counted against an owner, or everyone, by category (`gpu.memory(owner)`). */
export interface GpuMemory {
  bytes: number
  byCategory: Partial<Record<GpuMemoryCategory, number>>
}

// Usage bits, spelled out: Node has no GPUBufferUsage global until the webgpu globals are installed.
const MAP_READ = 0x1
const MAP_WRITE = 0x2
const INDEX = 0x10
const VERTEX = 0x20
const UNIFORM = 0x40
const STORAGE = 0x80
const INDIRECT = 0x100
const RENDER_ATTACHMENT = 0x10

/** The category of a buffer from its usage. */
export function bufferCategory(usage: number): GpuMemoryCategory {
  if (usage & (MAP_READ | MAP_WRITE)) return 'staging'
  if (usage & (VERTEX | INDEX)) return 'geometry'
  if (usage & (STORAGE | INDIRECT)) return 'storage'
  if (usage & UNIFORM) return 'uniforms'
  return 'other'
}

/** The category of a texture from its usage. */
export function textureCategory(usage: number): GpuMemoryCategory {
  return usage & RENDER_ATTACHMENT ? 'targets' : 'textures'
}

/** The owner of objects made while no app runs, and of per-device objects apps share. */
export const SHARED_OWNER = 'gpu'

interface Entry {
  readonly owner: Owned
  readonly texture: boolean
  readonly category: GpuMemoryCategory
  /** Index into `UPLOAD_CATEGORIES`. */
  readonly upload: number
  readonly bytes: number
  readonly ref: WeakRef<GPUBuffer | GPUTexture>
  live: boolean
}

interface Owned extends GpuStats {
  readonly name: string
  readonly entries: Set<Entry>
  readonly uploads: GpuUploads
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

  track(
    object: GPUBuffer | GPUTexture,
    owner: string,
    texture: boolean,
    bytes: number,
    category: GpuMemoryCategory = texture ? 'textures' : 'other',
    label?: string,
  ): void {
    const owned = this.owned(owner)
    const entry: Entry = {
      owner: owned,
      texture,
      category,
      upload: uploadCategory(label, texture),
      bytes,
      ref: new WeakRef(object),
      live: true,
    }
    owned.entries.add(entry)
    if (texture) owned.textures++
    else owned.buffers++
    owned.bytes += bytes
    owned.uploads.created++
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

  /** Counts bytes written into a tracked object against its owner and upload category. */
  upload(object: object, bytes: number): void {
    const tracked = entryOf.get(object)
    if (!tracked || tracked.ledger !== this) return
    const entry = tracked.entry
    entry.owner.uploads.bytes[entry.upload]! += bytes
  }

  /** Cumulative bytes written and objects created by `owner`. */
  uploads(owner: string): GpuUploads {
    return this.owned(owner).uploads
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

  /** Live bytes of `owner` (or everyone) by category. Walks every live object: not per frame. */
  memory(owner?: string): GpuMemory {
    const result: GpuMemory = { bytes: 0, byCategory: {} }
    const by = result.byCategory
    for (const owned of this.owners.values()) {
      if (owner !== undefined && owned.name !== owner) continue
      for (const entry of owned.entries) {
        result.bytes += entry.bytes
        by[entry.category] = (by[entry.category] ?? 0) + entry.bytes
      }
    }
    return result
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
      owned = {
        name,
        entries: new Set(),
        buffers: 0,
        textures: 0,
        bytes: 0,
        uploads: { bytes: new Float64Array(UPLOAD_CATEGORIES.length), created: 0 },
      }
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
