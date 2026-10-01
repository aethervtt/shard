import type { Webgl2CommandBuffer } from './commands'
import type { Webgl2Device } from './device'
import type { Webgl2Buffer, Webgl2Texture } from './resources'

// The queue. Writes run at once (WebGPU orders them before any later submit, and replaying at
// submit keeps that order); submits replay their command buffers.

function axis(
  value: GPUOrigin3D | GPUExtent3D | undefined,
  i: 0 | 1 | 2,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (Array.isArray(value)) return (value[i] as number | undefined) ?? fallback
  const d = value as GPUOrigin3DDict & GPUExtent3DDict
  const v = i === 0 ? (d.x ?? d.width) : i === 1 ? (d.y ?? d.height) : (d.z ?? d.depthOrArrayLayers)
  return v ?? fallback
}

export class Webgl2Queue {
  label = ''
  private readonly device: Webgl2Device

  constructor(device: Webgl2Device) {
    this.device = device
  }

  submit(buffers: Iterable<Webgl2CommandBuffer>): void {
    this.device.submit(buffers)
  }

  onSubmittedWorkDone(): Promise<undefined> {
    return this.device.afterGpu().then(() => undefined)
  }

  writeBuffer(
    buffer: Webgl2Buffer,
    offset: number,
    data: BufferSource,
    dataOffset?: number,
    size?: number,
  ): void {
    if (this.device.isLost) return
    buffer.write(offset, data, dataOffset, size)
  }

  writeTexture(
    destination: GPUTexelCopyTextureInfo,
    data: BufferSource,
    layout: GPUTexelCopyBufferLayout,
    size: GPUExtent3D,
  ): void {
    if (this.device.isLost) return
    const texture = destination.texture as unknown as Webgl2Texture
    const o = destination.origin
    this.device.copier.writeTexture(
      texture,
      destination.mipLevel ?? 0,
      axis(o, 0, 0),
      axis(o, 1, 0),
      axis(o, 2, 0),
      data,
      layout.offset ?? 0,
      layout.bytesPerRow,
      layout.rowsPerImage,
      axis(size, 0, 1),
      axis(size, 1, 1),
      axis(size, 2, 1),
    )
  }

  copyExternalImageToTexture(
    source: GPUCopyExternalImageSourceInfo,
    destination: GPUCopyExternalImageDestInfo,
    size: GPUExtent3D,
  ): void {
    if (this.device.isLost) return
    this.device.copier.copyExternal(source, destination, axis(size, 0, 1), axis(size, 1, 1))
  }
}
