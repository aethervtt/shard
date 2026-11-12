import { ShardError } from '@aethervtt/shard-core'
import type { PlatformFileSystem } from './index'

/** One file of an export (0110): where its bytes are, relative to the export's folder. */
export interface BuildFile {
  url: string
  size: number
  /** Content hash (sha256, hex). */
  hash: string
}

/** An export's files by project path: `scenes/main.scene.json`, `.shard/catalog.json`. */
export type BuildFiles = Readonly<Record<string, BuildFile>>

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}

/**
 * A read-only file system over an export (0110): project paths map to the hashed files `base`
 * reads, so the asset server, scenes, terrain and nav read an export without knowing it's one.
 */
export function buildFs(base: PlatformFileSystem, files: BuildFiles): PlatformFileSystem {
  const fileOf = (path: string): BuildFile => {
    const file = files[normalize(path)]
    if (!file) {
      throw new ShardError('platform/fs-not-found', `"${path}" isn't in this export`, {
        path,
        hint: 'Add it to export.include in shard.json if the game loads it by a computed path.',
      })
    }
    return file
  }
  const readOnly = (path: string): never => {
    throw new ShardError('platform/fs-read-only', `Cannot write "${path}" in an export`, { path })
  }
  return {
    writable: false,
    resolveUrl: (path) => {
      const file = files[normalize(path)]
      return file && base.resolveUrl?.(file.url)
    },
    readText: async (path) => base.readText(fileOf(path).url),
    readBytes: async (path) => base.readBytes(fileOf(path).url),
    readRange: async (path, offset, length) => {
      const file = fileOf(path)
      if (base.readRange) return base.readRange(file.url, offset, length)
      return (await base.readBytes(file.url)).subarray(offset, offset + length)
    },
    writeText: async (path) => readOnly(path),
    writeBytes: async (path) => readOnly(path),
    exists: async (path) => normalize(path) in files,
  }
}
