/**
 * Asset packs (`.shardpak`, 0110): an export's data in a few files read by range instead of one
 * file per asset. `SHPK`, a u32 version, a u32 index length, the index (JSON: this pack's entries
 * by project path), then each blob at a 16-byte boundary. `build.json` repeats the index, so a
 * reader never fetches the header; it's there for tools that only have the pack.
 */
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

export const PACK_VERSION = 1
/** No pack grows past this; the next file starts a new one. */
export const PACK_LIMIT = 1024 ** 3

/** One file in a pack, as `build.json` lists it. */
export interface PackedFile {
  pack: number
  /** From the start of the pack. */
  offset: number
  /** Stored bytes. */
  length: number
  encoding: 'raw' | 'deflate'
  /** Bytes once inflated. */
  size: number
  /** sha256 of the inflated bytes. */
  hash: string
}

/** Formats that are compressed already: deflate would only cost time. */
const COMPRESSED = new Set([
  '.ktx2',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.ogg',
  '.mp3',
  '.m4a',
  '.opus',
  '.glb',
  '.basis',
  '.zst',
  '.br',
  '.gz',
])

/**
 * How to store a file: raw when it's already compressed, when it's read by range (heightfield
 * pages, 0071: a range of a deflated entry would inflate all of it), or when deflate saves under
 * 10%.
 */
export function packEncoding(
  path: string,
  bytes: Uint8Array,
): { encoding: 'raw' | 'deflate'; stored: Uint8Array } {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (COMPRESSED.has(ext) || path.includes('/cache/terrain/') || bytes.length < 256) {
    return { encoding: 'raw', stored: bytes }
  }
  const deflated = deflateRawSync(bytes, { level: 9 })
  return deflated.length < bytes.length * 0.9
    ? { encoding: 'deflate', stored: deflated }
    : { encoding: 'raw', stored: bytes }
}

const align = (n: number) => (n + 15) & ~15

/**
 * Packs files (project path → bytes, in a stable order) into as few packs as `limit` allows.
 * Returns each pack's bytes and every file's place.
 */
export function packFiles(
  files: ReadonlyMap<string, Uint8Array>,
  limit = PACK_LIMIT,
): { packs: Uint8Array[]; entries: Record<string, PackedFile> } {
  type Pending = { path: string; stored: Uint8Array; entry: Omit<PackedFile, 'pack' | 'offset'> }
  const groups: Pending[][] = [[]]
  let used = 0
  for (const [path, bytes] of files) {
    const { encoding, stored } = packEncoding(path, bytes)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (used > 0 && used + align(stored.length) > limit) {
      groups.push([])
      used = 0
    }
    groups
      .at(-1)!
      .push({ path, stored, entry: { length: stored.length, encoding, size: bytes.length, hash } })
    used += align(stored.length)
  }
  const packs: Uint8Array[] = []
  const entries: Record<string, PackedFile> = {}
  const encoder = new TextEncoder()
  for (const group of groups) {
    if (group.length === 0) continue
    const pack = packs.length
    // The header's size depends on the index, whose offsets depend on the header: lay out the
    // blobs from 0, then shift them past the header once its size is known.
    const local: Record<string, PackedFile> = {}
    let at = 0
    for (const { path, entry } of group) {
      local[path] = { ...entry, pack, offset: at }
      at = align(at + entry.length)
    }
    let start = 0
    let index = new Uint8Array()
    // Settles in a pass or two: shifting offsets only lengthens the JSON by a few digits.
    for (;;) {
      const shifted = Object.fromEntries(
        Object.entries(local).map(([p, e]) => [p, { ...e, offset: e.offset + start }]),
      )
      index = encoder.encode(JSON.stringify(shifted))
      const next = align(12 + index.length)
      if (next === start) break
      start = next
    }
    const out = new Uint8Array(start + at)
    const view = new DataView(out.buffer)
    out.set(encoder.encode('SHPK'), 0)
    view.setUint32(4, PACK_VERSION, true)
    view.setUint32(8, index.length, true)
    out.set(index, 12)
    for (const { path, stored } of group) {
      const entry = { ...local[path]!, offset: local[path]!.offset + start }
      out.set(stored, entry.offset)
      entries[path] = entry
    }
    packs.push(out)
  }
  return { packs, entries }
}
