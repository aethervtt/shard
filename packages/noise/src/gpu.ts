import type { ShaderLibrary } from '@shard/shader'
import type { NoiseGraph } from './noise-graph'
import { NOISE_LIBRARY } from './wgsl'

/** Module path of the shared sources and helpers. */
export const NOISE_LIBRARY_PATH = 'shard::noise'

/** Registers `shard::noise` once. */
export function registerNoiseLibrary(library: ShaderLibrary): void {
  if (!library.has(NOISE_LIBRARY_PATH))
    library.register(NOISE_LIBRARY_PATH, NOISE_LIBRARY, '@shard/noise')
}

/**
 * Registers a graph's module (`graph.module`, exporting `noise_<name>` and `noise_<name>_at`).
 * Registering a changed graph relinks every shader that imports it; an unchanged one is a no-op.
 */
export function registerNoiseGraph(
  library: ShaderLibrary,
  graph: NoiseGraph,
  origin?: string,
): void {
  registerNoiseLibrary(library)
  library.register(graph.module, graph.wgsl, origin ?? graph.module)
}
