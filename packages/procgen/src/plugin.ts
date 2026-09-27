import { assetServer } from '@aethervtt/shard-assets'
import type { KeyValueStorage, PlatformFileSystem } from '@aethervtt/shard-platform'
import { definePlugin } from '@aethervtt/shard-runtime'
import { updateInstances } from '@aethervtt/shard-scene'
import { procgenMethods } from './methods'
import { procgen } from './runtime'

export interface ProcgenPluginOptions {
  /** Project files: outputs are cached in `.shard/cache/generated/` when writable. */
  fs?: PlatformFileSystem
  /** Where outputs are cached on hosts that can't write files (IndexedDB in browsers). */
  storage?: KeyValueStorage
  /** Bytes of outputs kept in memory (and in storage). Default 256 MB (`shard.json` procgen.cacheSize). */
  cacheSize?: number
}

/** Generator outputs for an app: the runtime and its caches, GeneratorInstance, procgen.* methods. */
export function procgenPlugin(options: ProcgenPluginOptions = {}) {
  return definePlugin({
    name: 'procgen',
    build(app) {
      const runtime = procgen(app.world).configure({
        ...(options.fs ? { fs: options.fs } : {}),
        ...(options.storage ? { storage: options.storage } : {}),
        ...(options.cacheSize ? { cacheSize: options.cacheSize } : {}),
      })
      // A generator file's defaults loading (or changing) respawns the instances that use it.
      runtime.server.onEvent((e) => {
        if (e.kind !== 'loaded' && e.kind !== 'modified') return
        if (assetServer(app.world).entry(e.guid)?.type === 'Generator') updateInstances(app.world)
      })
      app.addMethod(...procgenMethods)
    },
  })
}
