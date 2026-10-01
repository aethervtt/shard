// The WebGPU flag namespaces (`GPUBufferUsage.STORAGE`, `GPUShaderStage.FRAGMENT`, …) as the
// WebGPU spec defines them. A browser without WebGPU doesn't define them, and the engine reads them
// when it makes objects, not when it loads: installing them before the first device is enough.

export const BufferUsage = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const

export const TextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
} as const

export const ShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 } as const

export const MapMode = { READ: 0x0001, WRITE: 0x0002 } as const

export const ColorWrite = { RED: 0x1, GREEN: 0x2, BLUE: 0x4, ALPHA: 0x8, ALL: 0xf } as const

/**
 * Defines `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`, `GPUMapMode` and `GPUColorWrite`
 * on globalThis where the browser doesn't. Where it does (WebGPU and WebGL2 in one page), they
 * stay: the values are the spec's either way.
 */
export function installGpuConstants(): void {
  const g = globalThis as Record<string, unknown>
  g.GPUBufferUsage ??= BufferUsage
  g.GPUTextureUsage ??= TextureUsage
  g.GPUShaderStage ??= ShaderStage
  g.GPUMapMode ??= MapMode
  g.GPUColorWrite ??= ColorWrite
}
