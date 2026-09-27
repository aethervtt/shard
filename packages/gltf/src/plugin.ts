import { definePlugin } from '@aethervtt/shard-runtime'
import { GltfImporter } from './importer'

/**
 * Imports `.gltf` and `.glb` files. Loading their artifacts needs only render and animation; this
 * plugin is for hosts that import sources at runtime (a dev server, an editor).
 */
export const gltfPlugin = definePlugin({
  name: 'gltf',
  provides: [GltfImporter],
  build() {},
})
