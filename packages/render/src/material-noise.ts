import { defineResource, type World } from '@aethervtt/shard-core'
import type { ShaderLibrary } from '@aethervtt/shard-shader'
import type { MaterialType } from './materials'

/**
 * Noise slots in materials (`noise: { detail: 'rock.noise.json' }`), supplied by
 * `materialNoisePlugin` from `@aethervtt/shard-render/noise`. Core render only asks for it when a
 * material type has noise slots, so apps without such materials carry no noise code.
 */
export interface MaterialNoiseSupport {
  /**
   * The WGSL a type's noise slots add to its module, and a key that changes with its graphs.
   * Undefined while a graph is still loading (this starts the load).
   */
  wrappers(
    world: World,
    library: ShaderLibrary,
    type: MaterialType,
  ): { source: string; key: string } | undefined
}

export const MaterialNoise = defineResource<MaterialNoiseSupport>('render/MaterialNoise', {
  description: 'Noise slots in materials, when materialNoisePlugin is installed.',
})
