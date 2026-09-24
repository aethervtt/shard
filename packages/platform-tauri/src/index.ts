import type { AudioBackend, FileChangeEvent, Platform, PlatformFileSystem } from '@shard/platform'
import { createWebAudioBackend } from '@shard/platform-web'
import {
  exists,
  readFile,
  readTextFile,
  type WatchEvent,
  watch,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'

export interface TauriPlatformOptions {
  /** Absolute path of the project root. Project paths resolve against it. */
  projectRoot: string
}

export function createTauriPlatform(options: TauriPlatformOptions): Platform {
  const root = options.projectRoot.replace(/\/+$/, '')
  const resolve = (path: string) => (path.startsWith('/') ? path : `${root}/${path}`)
  const relative = (path: string) =>
    path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

  const toChange = (event: WatchEvent): FileChangeEvent[] => {
    const type = event.type
    const kind =
      typeof type === 'object' && 'create' in type
        ? 'create'
        : typeof type === 'object' && 'remove' in type
          ? 'remove'
          : 'modify'
    return event.paths.map((path) => ({ kind, path: relative(path) }))
  }

  const fs: PlatformFileSystem = {
    writable: true,
    readText: (path) => readTextFile(resolve(path)),
    readBytes: (path) => readFile(resolve(path)),
    writeText: (path, data) => writeTextFile(resolve(path), data),
    writeBytes: (path, data) => writeFile(resolve(path), data),
    exists: (path) => exists(resolve(path)),
    watch: async (path, onChange) =>
      watch(resolve(path), (event) => toChange(event).forEach(onChange), {
        recursive: true,
        delayMs: 50,
      }),
  }

  let audio: AudioBackend | undefined
  return {
    name: 'tauri',
    // The webview has Web Audio; made on first use.
    get audio() {
      audio ??= createWebAudioBackend()
      return audio
    },
    fs,
    storage: {
      get: async (key) => localStorage.getItem(key) ?? undefined,
      set: async (key, value) => localStorage.setItem(key, value),
      delete: async (key) => localStorage.removeItem(key),
    },
    clock: { now: () => performance.now() },
    log: {
      log: (level, message, data) => console[level](`[shard] ${message}`, data ?? ''),
    },
  }
}
