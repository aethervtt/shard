import { defineResource } from '@aethervtt/shard-core'

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

export interface RenderCountersData {
  /** Times a TAA history started over (new view, resize, device loss). Never on origin shifts. */
  taaResets: number
  /** Floating-origin shifts the renderer followed (spec 0040): history moved, not reset. */
  originShifts: number
}

export const RenderCounters = defineResource<RenderCountersData>('render/Counters', {
  description:
    'Running totals since start: TAA history resets and floating-origin shifts followed.',
  init: () => ({ taaResets: 0, originShifts: 0 }),
})
