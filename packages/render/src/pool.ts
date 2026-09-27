import type { GpuContext } from '@aethervtt/shard-gpu'

interface Entry {
  texture: GPUTexture
  key: string
  lastUsed: number
}

/** Frames a pooled texture may go unused before it's destroyed (e.g. after a resize). */
const EXPIRY_FRAMES = 60

/**
 * Transient textures, reused across frames. Textures with the same format, size, usage, and sample
 * count come from the same free list. Aliasing different resources within a frame is a later
 * optimization; the API won't change for it.
 */
export class TexturePool {
  private readonly entries: Entry[] = []
  private readonly gpu: GpuContext
  private frame = 0
  private generation = -1

  constructor(gpu: GpuContext) {
    this.gpu = gpu
  }

  /** Total textures currently held (in use or free). */
  get size(): number {
    return this.entries.length
  }

  beginFrame(): void {
    this.frame++
    if (this.generation !== this.gpu.generation) {
      // A new device: every old texture is dead.
      this.entries.length = 0
      this.generation = this.gpu.generation
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!
      if (this.frame - entry.lastUsed > EXPIRY_FRAMES) {
        entry.texture.destroy()
        this.entries.splice(i, 1)
      }
    }
  }

  acquire(descriptor: GPUTextureDescriptor & { size: [number, number] }): GPUTexture {
    const key = `${descriptor.format}|${descriptor.size[0]}x${descriptor.size[1]}|${descriptor.usage}|${descriptor.sampleCount ?? 1}|${descriptor.mipLevelCount ?? 1}`
    for (const entry of this.entries) {
      if (entry.key === key && entry.lastUsed !== this.frame) {
        entry.lastUsed = this.frame
        return entry.texture
      }
    }
    const texture = this.gpu.device.createTexture(descriptor)
    this.entries.push({ texture, key, lastUsed: this.frame })
    return texture
  }
}
