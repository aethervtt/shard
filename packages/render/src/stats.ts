import { defineResource } from '@shard/core'

export interface ViewStats {
  visible: number
  culled: number
  hidden: number
  drawCalls: number
}

export const RenderStats = defineResource<Map<string, ViewStats>>('render/Stats', {
  description: 'Per-view counts from the last frame: visible, culled, hidden, draw calls.',
  init: () => new Map(),
})
