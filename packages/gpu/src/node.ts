/**
 * WebGPU in Node through Dawn (the `webgpu` package). For the CLI, headless runs, and GPU tests.
 * Kept out of the main entry so browser bundles never see the native module.
 */
import { create, globals } from 'webgpu'
import { type CreateGpuContextOptions, createGpuContext, type GpuContext } from './context'

let installed = false

/** Defines `GPUBufferUsage`, `GPUTextureUsage`, etc. on globalThis, as browsers do. */
export function installWebGpuGlobals(): void {
  if (installed) return
  Object.assign(globalThis, globals)
  installed = true
}

export function nodeGpu(): GPU {
  installWebGpuGlobals()
  return create([]) as GPU
}

export function createNodeGpuContext(
  options: Omit<CreateGpuContextOptions, 'gpu'> = {},
): Promise<GpuContext> {
  return createGpuContext({ ...options, gpu: nodeGpu() })
}
