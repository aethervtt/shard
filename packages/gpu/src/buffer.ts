import type { GpuContext } from './context'

export interface GpuBufferOptions {
  label: string
  usage: GPUBufferUsageFlags
  /** Initial size in bytes. Default 256. */
  size?: number
}

/**
 * A GPU buffer that grows. `ensureCapacity` doubles the size when needed; `version` increments
 * every time the underlying `GPUBuffer` is replaced, so bind groups built on it know to rebuild.
 * Contents are not preserved across growth or device loss: rewrite them each frame.
 */
export class GpuBuffer {
  readonly label: string
  readonly usage: GPUBufferUsageFlags
  version = 0
  private current: GPUBuffer
  private size: number
  private generation: number
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext, options: GpuBufferOptions) {
    this.gpu = gpu
    this.label = options.label
    // Writing from the CPU is the point of this class.
    this.usage = options.usage | GPUBufferUsage.COPY_DST
    this.size = align4(Math.max(16, options.size ?? 256))
    this.generation = gpu.generation
    this.current = this.create(this.size)
  }

  get buffer(): GPUBuffer {
    this.checkGeneration()
    return this.current
  }

  get byteLength(): number {
    return this.size
  }

  /** Grows to at least `bytes`. Returns true if the buffer was replaced. */
  ensureCapacity(bytes: number): boolean {
    this.checkGeneration()
    if (bytes <= this.size) return false
    let size = this.size
    while (size < bytes) size *= 2
    this.current.destroy()
    this.size = size
    this.current = this.create(size)
    this.version++
    return true
  }

  /** Writes a TypedArray (or a slice of it, in elements) at a byte offset, growing if needed. */
  write(
    data: ArrayBufferView & ArrayLike<number>,
    byteOffset = 0,
    start = 0,
    count?: number,
  ): void {
    const elements = count ?? data.length - start
    const bytesPerElement = (data as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
    const bytes = align4(elements * bytesPerElement)
    this.ensureCapacity(byteOffset + bytes)
    if (elements > 0)
      this.gpu.device.queue.writeBuffer(this.current, byteOffset, data, start, elements)
  }

  destroy(): void {
    this.current.destroy()
  }

  private create(size: number): GPUBuffer {
    return this.gpu.device.createBuffer({ label: this.label, size, usage: this.usage })
  }

  /** After device loss the old buffer is gone; make a new one on the new device. */
  private checkGeneration(): void {
    if (this.generation === this.gpu.generation) return
    this.generation = this.gpu.generation
    this.current = this.create(this.size)
    this.version++
  }
}

function align4(n: number): number {
  return (n + 3) & ~3
}
