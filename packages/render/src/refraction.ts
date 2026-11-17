import { defineResource } from '@aethervtt/shard-core'
import { VIEW_BINDINGS } from './view-bindings'

// Refracting material types (0129). Core owns the flag (`refraction: true` on defineMaterial), the
// pass constants and the pipelines (forward.ts); `refractionPlugin` (in forwardPlugin) owns the
// graph nodes and the WGSL. Without it, refracting draws are skipped and logged once.

/** The view group's bindings in the refraction pass: the opaque copy's color and depth. */
export const REFRACTION_BINDINGS = {
  color: VIEW_BINDINGS.refractionColor,
  depth: VIEW_BINDINGS.refractionDepth,
} as const

export const RefractionPath = defineResource<{ installed: true }>('render/RefractionPath', {
  description: 'Present when refracting material types can draw (refractionPlugin).',
})
