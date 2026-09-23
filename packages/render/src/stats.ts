import { defineResource } from '@shard/core'

export interface ViewStats {
  visible: number
  culled: number
  hidden: number
  /** Meshes skipped because their mesh or material isn't loaded yet (or failed). */
  pending: number
  drawCalls: number
  /** Pipeline changes in the opaque pass (sorting keeps these near the number of material types). */
  pipelineSwitches?: number
}

export const RenderStats = defineResource<Map<string, ViewStats>>('render/Stats', {
  description: 'Per-view counts from the last frame: visible, culled, hidden, pending, draw calls.',
  init: () => new Map(),
})

export interface GpuMemoryData {
  /** Textures uploaded by the forward renderer. */
  textures: number
  /** Bytes of GPU memory those textures use (all mip levels). */
  textureBytes: number
}

export const GpuMemory = defineResource<GpuMemoryData>('render/GpuMemory', {
  description: 'GPU memory used by uploaded textures.',
  init: () => ({ textures: 0, textureBytes: 0 }),
})
