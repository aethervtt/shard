import { defineResource, ShardError, type World } from '@shard/core'
import type { PlatformFileSystem } from '@shard/platform'

/** Where `shard bake nav` and `nav.bake` keep baked tiles, relative to the project root. */
export const NAV_CACHE_PATH = '.shard/cache/nav/tiles.bin'

const MAGIC = 0x56414e53 // "SNAV"
const FORMAT = 1
const EMPTY = 0xffffffff

/**
 * Baked navmesh tiles by the key of the geometry and settings that made them: a tile whose key
 * is here loads without running Recast. Null marks a tile that bakes to nothing walkable.
 */
export class NavCacheStore {
  readonly tiles = new Map<string, Uint8Array | null>()
  /** Where `save` writes, once `loadNavCache` connected a file system. */
  fs: PlatformFileSystem | undefined
  path = NAV_CACHE_PATH
  /** Tiles read from disk by the last load. */
  loaded = 0

  /** The cache as one file: magic, format, count, then per tile an 8-byte key and its data. */
  encode(keys: Iterable<string> = this.tiles.keys()): Uint8Array {
    const entries: [string, Uint8Array | null][] = []
    let size = 12
    for (const key of keys) {
      const bytes = this.tiles.get(key)
      if (bytes === undefined) continue
      entries.push([key, bytes])
      size += 12 + (bytes?.length ?? 0)
    }
    const out = new Uint8Array(size)
    const view = new DataView(out.buffer)
    view.setUint32(0, MAGIC, true)
    view.setUint32(4, FORMAT, true)
    view.setUint32(8, entries.length, true)
    let o = 12
    for (const [key, bytes] of entries) {
      view.setUint32(o, Number.parseInt(key.slice(0, 8), 16), true)
      view.setUint32(o + 4, Number.parseInt(key.slice(8, 16), 16), true)
      view.setUint32(o + 8, bytes ? bytes.length : EMPTY, true)
      o += 12
      if (bytes) {
        out.set(bytes, o)
        o += bytes.length
      }
    }
    return out
  }

  /** Reads a file written by `encode` into the cache. Returns how many tiles it held. */
  decode(data: Uint8Array): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (data.length < 12 || view.getUint32(0, true) !== MAGIC) {
      throw new ShardError('nav/bad-cache', 'The navmesh cache file is not a Shard nav cache', {
        hint: `Delete ${this.path}; the next bake rewrites it.`,
      })
    }
    if (view.getUint32(4, true) !== FORMAT) return 0
    const count = view.getUint32(8, true)
    let o = 12
    for (let i = 0; i < count; i++) {
      const key =
        view.getUint32(o, true).toString(16).padStart(8, '0') +
        view
          .getUint32(o + 4, true)
          .toString(16)
          .padStart(8, '0')
      const len = view.getUint32(o + 8, true)
      o += 12
      if (len === EMPTY) this.tiles.set(key, null)
      else {
        this.tiles.set(key, data.slice(o, o + len))
        o += len
      }
    }
    return count
  }
}

export const NavCache = defineResource<NavCacheStore>('nav/Cache', {
  description: 'Baked navmesh tiles by geometry key, loaded from and saved to .shard/cache/nav.',
  init: () => new NavCacheStore(),
})

/**
 * Connects the cache to a project's file system and reads the tiles baked there, so navmeshes
 * whose geometry hasn't changed load without running Recast. Call before loading scenes.
 */
export async function loadNavCache(world: World, fs: PlatformFileSystem, path = NAV_CACHE_PATH) {
  const cache = world.initResource(NavCache)
  cache.fs = fs
  cache.path = path
  if (!(await fs.exists(path))) return 0
  cache.loaded = cache.decode(await fs.readBytes(path))
  return cache.loaded
}

/**
 * Writes the tiles in `keys` (default: every tile in the cache) to the cache file. Returns the
 * bytes written, or 0 when no writable file system is connected.
 */
export async function saveNavCache(world: World, keys?: Iterable<string>): Promise<number> {
  const cache = world.initResource(NavCache)
  if (!cache.fs?.writable) return 0
  const bytes = cache.encode(keys)
  await cache.fs.writeBytes(cache.path, bytes)
  return bytes.length
}
