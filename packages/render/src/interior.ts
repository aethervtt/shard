import { defineResource } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'

// Interior lighting (0069). Core owns the hooks: the lighting stage's `SKY_VISIBILITY` and
// `BLOCKED_LIGHTS` defines, two view bindings that exist only while one is on, and the light
// record's row word (lights.ts). `interiorPlugin` (in forwardPlugin) owns the textures, their
// placeholders and the WGSL; structure's interiorLightingPlugin fills them. Render never imports
// structure.

/** `InteriorSupport.mode` bits. */
export const INTERIOR_SKY = 1
export const INTERIOR_BLOCKED = 2

/** The view group's bindings while a mode bit is on: the field and rows (one texture), the table. */
export const INTERIOR_BINDINGS = { data: 16, table: 17 } as const

/**
 * Set by `interiorPlugin`: what forward needs to link and bind the interior variants. With mode 0
 * the view group and every shader are as they are without the plugin.
 */
export interface InteriorSupport {
  /** INTERIOR_SKY | INTERIOR_BLOCKED this frame. */
  readonly mode: number
  /** Whether something fills the field and rows (structure's interiorLightingPlugin). */
  readonly provided: boolean
  /** Bumps when an entry's resource changes (a texture grows): the view bind group is rebuilt. */
  readonly version: number
  /** The view group's extra entries (INTERIOR_BINDINGS): a placeholder until there's data. */
  entries(gpu: GpuContext): readonly GPUBindGroupEntry[]
}

export const InteriorPath = defineResource<InteriorSupport>('render/InteriorPath', {
  description: 'Present when interior lighting (interiorPlugin) is installed.',
})
