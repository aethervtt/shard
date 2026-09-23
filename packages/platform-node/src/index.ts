import { watch as fsWatch } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { ShardError } from '@shard/core'
import type { FileChangeEvent, Platform } from '@shard/platform'

export interface NodePlatformOptions {
  /** Project root; relative paths resolve against it. */
  root: string
  /** Where log lines go. Default: stderr (stdout is reserved for command output). */
  logTo?: (line: string) => void
}

/** The platform for Node hosts: the CLI, headless runs, MCP, and gameplay tests. */
export function createNodePlatform(options: NodePlatformOptions): Platform {
  const root = resolve(options.root)
  const abs = (path: string) => (isAbsolute(path) ? path : resolve(root, path))
  const rel = (path: string) => relative(root, path).split('\\').join('/')
  const storage = new Map<string, string>()
  const write = options.logTo ?? ((line: string) => process.stderr.write(`${line}\n`))

  return {
    name: 'node',
    fs: {
      writable: true,
      readText: async (path) => {
        try {
          return await readFile(abs(path), 'utf8')
        } catch (cause) {
          throw new ShardError('platform/fs-not-found', `Can't read "${path}"`, { path, cause })
        }
      },
      readBytes: async (path) => new Uint8Array(await readFile(abs(path))),
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
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => void storage.set(key, value),
      delete: async (key) => void storage.delete(key),
    },
    clock: { now: () => performance.now() },
    log: {
      log: (level, message, data) =>
        write(`[${level}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`),
    },
  }
}
