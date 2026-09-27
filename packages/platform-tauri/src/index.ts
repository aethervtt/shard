import type {
  AudioBackend,
  FileChangeEvent,
  KeyValueStorage,
  Platform,
  PlatformFileSystem,
  Workers,
} from '@aethervtt/shard-platform'
import { createWebAudioBackend, createWebWorkers } from '@aethervtt/shard-platform-web'
import {
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  type WatchEvent,
  watch,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'

export interface TauriPlatformOptions {
  /** Absolute path of the project root. Project paths resolve against it. */
  projectRoot: string
  /**
   * Absolute folder for `storage` (saves, settings): the app data folder for the project, e.g.
   * `<appDataDir>/<project>`. Default `<projectRoot>/.shard/user`.
   */
  dataDir?: string
}

/** Storage as files under `dir`, through the fs plugin. Writes land in a temp file, then rename. */
function createTauriStorage(dir: string): KeyValueStorage {
  const path = (key: string) => `${dir}/${key}`
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const walk = async (folder: string, prefix: string, out: string[]) => {
    const entries = await readDir(folder).catch(() => [])
    for (const e of entries) {
      const key = prefix === '' ? e.name : `${prefix}/${e.name}`
      if (e.isDirectory) await walk(`${folder}/${e.name}`, key, out)
      else if (e.isFile && !e.name.endsWith('.tmp')) out.push(key)
    }
  }
  return {
    read: async (key) => ((await exists(path(key))) ? readFile(path(key)) : undefined),
    write: async (key, data) => {
      const target = path(key)
      await mkdir(parent(target), { recursive: true })
      await writeFile(`${target}.tmp`, data)
      await rename(`${target}.tmp`, target)
    },
    list: async (prefix) => {
      const out: string[] = []
      await walk(dir, '', out)
      return out.filter((k) => k.startsWith(prefix)).sort()
    },
    delete: async (key) => {
      if (await exists(path(key))) await remove(path(key))
    },
  }
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
  let workers: Workers | undefined
  return {
    name: 'tauri',
    // Web workers in the webview; made on first use.
    get workers() {
      workers ??= createWebWorkers()
      return workers
    },
    // The webview has Web Audio; made on first use.
    get audio() {
      audio ??= createWebAudioBackend()
      return audio
    },
    fs,
    storage: createTauriStorage((options.dataDir ?? `${root}/.shard/user`).replace(/\/+$/, '')),
    clock: { now: () => performance.now() },
    log: {
      log: (level, message, data) => console[level](`[shard] ${message}`, data ?? ''),
    },
  }
}
