import { watch as fsWatch } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ShardError } from '@aethervtt/shard-core'
import type { FileChangeEvent, KeyValueStorage, Platform, Workers } from '@aethervtt/shard-platform'
import { createNodePerformance } from './performance'
import { createNodeWorkers } from './workers'

export { findPerfBudgets, loadPerfBudgets, type NodePerfBudgets } from './budgets'
export { createNodePerformance } from './performance'
export { createNodeWorkers } from './workers'

/**
 * Storage as files under `dir`: `saves/slot1.json` is `<dir>/saves/slot1.json`. Writes go to a
 * temporary file first and are renamed into place, so a crash never leaves half a save.
 */
export function createFileStorage(dir: string): KeyValueStorage {
  const file = (key: string) => {
    const path = resolve(dir, key)
    // `relative`, not a prefix check: it knows the host's separator and drive letters.
    const inside = relative(resolve(dir), path)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new ShardError(
        'platform/bad-storage-key',
        `Storage key "${key}" leaves the data folder`,
        {
          hint: 'Keys are relative paths like "saves/slot1.json".',
        },
      )
    }
    return path
  }
  let temp = 0
  return {
    read: async (key) => {
      try {
        const data = await readFile(file(key))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    },
    write: async (key, data) => {
      const path = file(key)
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.${temp++}.tmp`
      await writeFile(tmp, data)
      await rename(tmp, path)
    },
    list: async (prefix) => {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
      return entries
        .filter((e) => e.isFile() && !e.name.endsWith('.tmp'))
        .map((e) => relative(dir, resolve(e.parentPath, e.name)).split('\\').join('/'))
        .filter((key) => key.startsWith(prefix))
        .sort()
    },
    delete: async (key) => rm(file(key), { force: true }),
  }
}

export interface NodePlatformOptions {
  /** Project root; relative paths resolve against it. */
  root: string
  /** Where log lines go. Default: stderr (stdout is reserved for command output). */
  logTo?: (line: string) => void
  /**
   * Where `storage` (saves, settings) writes. Default `.shard/user` in the project, so headless
   * runs and tests never touch a player's own saves; relative paths resolve against `root`.
   */
  dataDir?: string
  /** Worker threads for `workers` (made on first use). 0 runs jobs inline. Default: cores − 1, 1 to 8. */
  workers?: number
}

/** The platform for Node hosts: the CLI, headless runs, MCP, and gameplay tests. */
export function createNodePlatform(options: NodePlatformOptions): Platform {
  const root = resolve(options.root)
  const abs = (path: string) => (isAbsolute(path) ? path : resolve(root, path))
  const rel = (path: string) => relative(root, path).split('\\').join('/')
  const dataDir = resolve(root, options.dataDir ?? '.shard/user')
  const write = options.logTo ?? ((line: string) => process.stderr.write(`${line}\n`))
  let workers: Workers | undefined

  return {
    name: 'node',
    get workers() {
      workers ??= createNodeWorkers(options.workers)
      return workers
    },
    fs: {
      writable: true,
      readText: async (path) => {
        try {
          return await readFile(abs(path), 'utf8')
        } catch (cause) {
          throw new ShardError('platform/fs-not-found', `Can't read "${path}"`, { path, cause })
        }
      },
      readBytes: async (path) => {
        // A view, not a copy: big artifacts (meshes, textures) are tens of megabytes.
        const data = await readFile(abs(path))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      },
      writeText: async (path, data) => {
        await mkdir(dirname(abs(path)), { recursive: true })
        await writeFile(abs(path), data, 'utf8')
      },
      writeBytes: async (path, data) => {
        await mkdir(dirname(abs(path)), { recursive: true })
        await writeFile(abs(path), data)
      },
      exists: async (path) =>
        access(abs(path)).then(
          () => true,
          () => false,
        ),
      list: async (dir) => {
        try {
          const entries = await readdir(abs(dir), { withFileTypes: true })
          return entries
            .filter((e) => e.isFile() || e.isDirectory())
            .map((e) => ({
              name: e.name,
              kind: e.isDirectory() ? ('dir' as const) : ('file' as const),
            }))
        } catch {
          return []
        }
      },
      stat: async (path) => {
        try {
          const s = await stat(abs(path))
          return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : undefined
        } catch {
          return undefined
        }
      },
      move: async (from, to) => {
        await mkdir(dirname(abs(to)), { recursive: true })
        await rename(abs(from), abs(to))
      },
      remove: async (path) => rm(abs(path), { force: true }),
      watch: async (path, onChange) => {
        const dir = abs(path)
        const watcher = fsWatch(dir, { recursive: true }, (type, file) => {
          if (!file) return
          const full = resolve(dir, file.toString())
          const kind: FileChangeEvent['kind'] = type === 'rename' ? 'create' : 'modify'
          void access(full).then(
            () => onChange({ kind, path: rel(full) }),
            () => onChange({ kind: 'remove', path: rel(full) }),
          )
        })
        return () => watcher.close()
      },
    },
    storage: createFileStorage(dataDir),
    clock: { now: () => performance.now() },
    performance: createNodePerformance(),
    log: {
      log: (level, message, data) =>
        write(`[${level}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`),
    },
  }
}
