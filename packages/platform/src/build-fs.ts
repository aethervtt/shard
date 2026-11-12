import { ShardError } from '@aethervtt/shard-core'
import type { PlatformFileSystem } from './index'

/**
 * One file of an export (0110): a loose file at `url`, or (stage 3) a range of pack `pack`, stored
 * raw or deflated, both relative to the export's folder.
 */
export interface BuildFile {
  /** Loose files: where the bytes are. */
  url?: string
  /** Bytes of the file itself (inflated). */
  size: number
  /** Content hash (sha256, hex) of the file itself. */
  hash: string
  /** Packed files: index into the build's `packs`, and the stored bytes' place in it. */
  pack?: number
  offset?: number
  length?: number
  encoding?: 'raw' | 'deflate'
}

/** An export's files by project path: `scenes/main.scene.json`, `.shard/catalog.json`. */
export type BuildFiles = Readonly<Record<string, BuildFile>>

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}

// Streams exist in browsers, webviews and Node; this package's lib has no DOM or Node types.
interface Streams {
  TextDecoder: new () => { decode(bytes: Uint8Array): string }
  DecompressionStream: new (format: 'deflate-raw') => unknown
  Blob: new (parts: Uint8Array[]) => { stream(): { pipeThrough(t: unknown): unknown } }
  Response: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const { Blob, DecompressionStream, Response } = globalThis as unknown as Streams
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * A read-only file system over an export (0110): project paths map to the hashed files or pack
 * ranges `base` reads, so the asset server, scenes, terrain and nav read an export without knowing
 * it's one. Packed files have no URL (`resolveUrl` is synchronous; a pack read isn't): callers
 * that would take one read the bytes instead.
 */
export function buildFs(
  base: PlatformFileSystem,
  files: BuildFiles,
  packs: readonly string[] = [],
): PlatformFileSystem {
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
  /** `length` bytes from `offset` of `url`, by range where the host can. */
  const range = async (url: string, offset: number, length: number) =>
    base.readRange
      ? base.readRange(url, offset, length)
      : (await base.readBytes(url)).subarray(offset, offset + length)
  const read = async (path: string): Promise<Uint8Array> => {
    const file = fileOf(path)
    if (file.pack === undefined) return base.readBytes(file.url!)
    const stored = await range(packs[file.pack]!, file.offset!, file.length!)
    return file.encoding === 'deflate' ? inflate(stored) : stored
  }
  const readOnly = (path: string): never => {
    throw new ShardError('platform/fs-read-only', `Cannot write "${path}" in an export`, { path })
  }
  const decoder = new (globalThis as unknown as Streams).TextDecoder()
  return {
    writable: false,
    resolveUrl: (path) => {
      const file = files[normalize(path)]
      return file?.url === undefined ? undefined : base.resolveUrl?.(file.url)
    },
    readText: async (path) => {
      const file = fileOf(path)
      return file.pack === undefined ? base.readText(file.url!) : decoder.decode(await read(path))
    },
    readBytes: read,
    readRange: async (path, offset, length) => {
      const file = fileOf(path)
      const count = Math.max(0, Math.min(length, file.size - offset))
      if (file.pack === undefined) return range(file.url!, offset, count)
      // A raw entry is a range of the pack; a deflated one has to be inflated whole.
      if (file.encoding !== 'deflate') {
        return range(packs[file.pack]!, file.offset! + offset, count)
      }
      return (await read(path)).subarray(offset, offset + count)
    },
    writeText: async (path) => readOnly(path),
    writeBytes: async (path) => readOnly(path),
    exists: async (path) => normalize(path) in files,
  }
}
