import { Last } from '@aethervtt/shard-core'
import type { KeyValueStorage, PlatformFileSystem } from '@aethervtt/shard-platform'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { saveMethods } from './methods'
import { NoSave, SaveConfig } from './save'
import { loadSettings, SettingsState, settingsSystem } from './settings'

export interface SavePluginOptions {
  /** Where saves and settings go (`platform.storage`). Default: memory (lost on exit). */
  storage?: KeyValueStorage
  /** The project's files: scene files reload from it, and `settings/*.json` hold defaults. */
  fs?: PlatformFileSystem
  /** Written into saves as `engine`. */
  engine?: string
}

/**
 * Saved games in slots, settings persisted per user, and the save and settings protocol methods.
 * Settings load before Startup.
 */
export function savePlugin(options: SavePluginOptions = {}): Plugin {
  return definePlugin({
    name: 'save',
    dependencies: ['core/time', 'scene'],
    build(app) {
      const fs = options.fs
      const config = app.world.initResource(SaveConfig)
      if (options.storage) config.storage = options.storage
      if (options.engine) config.engine = options.engine
      if (fs) config.readScene = async (id) => JSON.parse(await fs.readText(id))
      app.world.initResource(SettingsState)
      app.world.registry.register(NoSave)
      app.addSystems(Last, settingsSystem)
      app.addMethod(...saveMethods)
    },
    async ready(app) {
      await loadSettings(app.world, { fs: options.fs })
    },
  })
}
