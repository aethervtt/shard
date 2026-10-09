import { ShardError } from '@aethervtt/shard-core'
import type { PlatformFileSystem } from '@aethervtt/shard-platform'

// Page packs (spec 0071): one file per (depth, 16 × 16 nodes), each page deflated on its own,
// with an offset index at the front, so reading a page is one ranged read.

/** Nodes per pack side. */
export const PACK = 16
export const PACK_PAGES = PACK * PACK
const MAGIC = 0x31505453 // 'STP1'
const HEADER = 16
const ENTRY = 20
/** Bytes before the first page: header and index. */
export const PACK_INDEX_BYTES = HEADER + ENTRY * PACK_PAGES

/** A page's index entry. Absent pages (past the terrain's edge) have length 0. */
export interface PackEntry {
  offset: number
  length: number
  /** Quantized height range over the node's subtree. */
  min: number
  max: number
  /** Geometric error (m). */
  error: number
}

export interface PackIndex {
  depth: number
  gx: number
  gz: number
  entries: PackEntry[]
}

/** Where a node's page lives: its pack file and slot in it. */
export function packOf(depth: number, x: number, z: number): { path: string; slot: number } {
  const gx = Math.floor(x / PACK)
  const gz = Math.floor(z / PACK)
  return { path: `d${depth}/${gx}_${gz}.pack`, slot: (z - gz * PACK) * PACK + (x - gx * PACK) }
}

function corrupt(path: string, why: string): ShardError {
  return new ShardError('terrain/corrupt-pack', `${path}: ${why}`, {
    path,
    hint: 'The pack is damaged or from another bake: `shard terrain bake --force` rewrites it.',
  })
}

export function readIndex(path: string, bytes: Uint8Array): PackIndex {
  if (bytes.length < PACK_INDEX_BYTES) throw corrupt(path, 'too short for an index')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint32(0, true) !== MAGIC) throw corrupt(path, 'not a terrain pack')
  const entries: PackEntry[] = []
  for (let i = 0; i < PACK_PAGES; i++) {
    const o = HEADER + i * ENTRY
    entries.push({
      offset: v.getUint32(o, true),
      length: v.getUint32(o + 4, true),
      min: v.getUint16(o + 8, true),
      max: v.getUint16(o + 10, true),
      error: v.getFloat32(o + 12, true),
    })
  }
  return { depth: v.getUint8(6), gx: v.getUint16(8, true), gz: v.getUint16(10, true), entries }
}

/** A pack file from its pages (null where absent), in slot order. */
export function writePack(
  depth: number,
  gx: number,
  gz: number,
  pages: readonly ({ data: Uint8Array; min: number; max: number; error: number } | null)[],
): Uint8Array {
  let size = PACK_INDEX_BYTES
  for (const p of pages) if (p) size += p.data.length
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, MAGIC, true)
  v.setUint16(4, 1, true)
  v.setUint8(6, depth)
  v.setUint16(8, gx, true)
  v.setUint16(10, gz, true)
  v.setUint16(12, PACK_PAGES, true)
  let offset = PACK_INDEX_BYTES
  for (let i = 0; i < PACK_PAGES; i++) {
    const p = pages[i]
    if (!p) continue
    const o = HEADER + i * ENTRY
    v.setUint32(o, offset, true)
    v.setUint32(o + 4, p.data.length, true)
    v.setUint16(o + 8, p.min, true)
    v.setUint16(o + 10, p.max, true)
    v.setFloat32(o + 12, p.error, true)
    out.set(p.data, offset)
    offset += p.data.length
  }
  return out
}

/**
 * Where a terrain's packs and manifest live: the project's `.shard/cache/terrain/<id>/` through
 * the platform's file service, or memory (tests, read-only hosts baking on first use).
 */
export interface PackStore {
  readonly writable: boolean
  /** A whole file, or undefined if it doesn't exist. */
  read(path: string): Promise<Uint8Array | undefined>
  /** `length` bytes at `offset` (one ranged read where the host has them). */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array): Promise<void>
  /** Bytes of every file, for stats. */
  size(): Promise<number>
}

/** Packs in memory. */
export function memoryPackStore(): PackStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    writable: true,
    read: async (path) => files.get(path),
    readRange: async (path, offset, length) => {
      const f = files.get(path)
      if (!f) {
        throw new ShardError('terrain/missing-pack', `No pack ${path}`, {
          path,
          hint: 'The terrain isn’t baked (or was baked for another grid): `shard terrain bake`.',
        })
      }
      return f.subarray(offset, offset + length)
    },
    write: async (path, bytes) => void files.set(path, bytes),
    size: async () => {
      let n = 0
      for (const f of files.values()) n += f.length
      return n
    },
  }
}

/**
 * Packs under `dir` on a platform file service: ranged reads through `readRange` (a whole read
 * and a slice on hosts without one), writes to a temporary file moved into place, so a running
 * game reading the old pack never sees half a new one.
 */
export function fsPackStore(fs: PlatformFileSystem, dir: string): PackStore {
  const full = (p: string) => `${dir}/${p}`
  return {
    writable: fs.writable,
    read: async (path) => ((await fs.exists(full(path))) ? fs.readBytes(full(path)) : undefined),
    readRange: async (path, offset, length) => {
      if (fs.readRange) return fs.readRange(full(path), offset, length)
      const all = await fs.readBytes(full(path))
      return all.subarray(offset, offset + length)
    },
    write: async (path, bytes) => {
      if (fs.move) {
        const temp = `${full(path)}.tmp`
        await fs.writeBytes(temp, bytes)
        await fs.move(temp, full(path))
      } else await fs.writeBytes(full(path), bytes)
    },
    size: async () => {
      if (!fs.list || !fs.stat) return 0
      let n = 0
      const walk = async (d: string) => {
        for (const e of await fs.list!(d)) {
          const p = `${d}/${e.name}`
          if (e.kind === 'dir') await walk(p)
          else n += (await fs.stat!(p))?.size ?? 0
        }
      }
      await walk(dir)
      return n
    },
  }
}
