/**
 * A shipped game in a Tauri app (0111), through `tauri-plugin-shard`: the export's data read by
 * range over its `shard://` protocol, saves as files in the app data folder, and the game server
 * sidecar. Studio's mode (`createTauriPlatform`) edits a project instead; a game never loads it.
 */
import type { BuildFiles, KeyValueStorage, LocalServer, Platform } from '@aethervtt/shard-platform'
import { createWebPlatform } from '@aethervtt/shard-platform-web'
import { invoke } from '@tauri-apps/api/core'

/** Where the game's data is served: `shard://localhost/`, or `http://shard.localhost/` on Windows. */
export function shardBase(): Promise<string> {
  return invoke<string>('plugin:shard|base')
}

/** Saves and settings through the plugin: files under the app data folder, written whole. */
export function pluginStorage(): KeyValueStorage {
  return {
    async read(key) {
      try {
        return new Uint8Array(await invoke<ArrayBuffer>('plugin:shard|storage_read', { key }))
      } catch (err) {
        if (String(err).includes('not-found')) return undefined
        throw err
      }
    },
    write: (key, data) =>
      invoke('plugin:shard|storage_write', data, { headers: { 'shard-key': key } }),
    list: (prefix) => invoke<string[]>('plugin:shard|storage_list', { prefix }),
    delete: (key) => invoke('plugin:shard|storage_delete', { key }),
  }
}

/** The game server sidecar the plugin starts (`plugins.shard.server` in `tauri.conf.json`). */
export function pluginLocalServer(): LocalServer {
  return {
    start: () => invoke<{ url: string; http?: string }>('plugin:shard|server_start'),
    stop: () => invoke('plugin:shard|server_stop'),
  }
}

export interface TauriGamePlatformOptions {
  /** The export's files and packs (`build.json`), read from the plugin's `shard://` base. */
  files: BuildFiles
  packs?: readonly string[]
  /** The plugin's base, from `shardBase()`. */
  base: string
  /** Web workers (0 runs jobs inline). Default: cores − 1, 1 to 8. */
  workers?: number
}

/** The web platform over the app's own files, with the plugin's storage and game server. */
export function createTauriGamePlatform(options: TauriGamePlatformOptions): Platform {
  return createWebPlatform({
    baseUrl: options.base,
    files: options.files,
    packs: options.packs,
    workers: options.workers,
    storage: pluginStorage(),
    localServer: pluginLocalServer(),
  })
}
