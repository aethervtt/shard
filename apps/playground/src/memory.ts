import {
  createMemoryStorage,
  type DirEntry,
  type FileStat,
  type Platform,
  type PlatformFileSystem,
} from '@aethervtt/shard-platform'

/**
 * A project folder in memory, for demos that import real asset files: the playground has no file
 * system, so the asset server gets this one. Writes bump mtimes, so rescans see edits.
 */
export function memoryPlatform(): Platform {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  let clock = 0
  const encoder = new TextEncoder()
  const missing = (path: string) => new Error(`ENOENT: ${path}`)
  const fs: PlatformFileSystem = {
    writable: true,
    async readBytes(path) {
      const f = files.get(path)
      if (!f) throw missing(path)
      return f.bytes
    },
    async readText(path) {
      return new TextDecoder().decode(await fs.readBytes(path))
    },
    async writeBytes(path, bytes) {
      files.set(path, { bytes, mtime: ++clock })
    },
    async writeText(path, text) {
      files.set(path, { bytes: encoder.encode(text), mtime: ++clock })
    },
    async exists(path) {
      return files.has(path) || [...files.keys()].some((p) => p.startsWith(`${path}/`))
    },
    async list(dir) {
      const prefix = dir === '' ? '' : `${dir}/`
      const out = new Map<string, DirEntry>()
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        const name = slash === -1 ? rest : rest.slice(0, slash)
        out.set(name, { name, kind: slash === -1 ? 'file' : 'dir' })
      }
      return [...out.values()]
    },
    async stat(path): Promise<FileStat | undefined> {
      const f = files.get(path)
      return f && { size: f.bytes.length, mtime: f.mtime }
    },
    async move(from, to) {
      const f = files.get(from)
      if (!f) throw missing(from)
      files.delete(from)
      files.set(to, f)
    },
    async remove(path) {
      files.delete(path)
    },
  }
  return {
    name: 'memory',
    fs,
    storage: createMemoryStorage(),
    clock: { now: () => performance.now() },
    log: { log() {} },
  }
}
