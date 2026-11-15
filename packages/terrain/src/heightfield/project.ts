import type { AssetServer } from '@aethervtt/shard-assets'
import { ShardError, type World } from '@aethervtt/shard-core'
import { NoiseGraphs } from '@aethervtt/shard-noise'
import type { PlatformFileSystem, Workers } from '@aethervtt/shard-platform'
import { type BakeReport, bakeSourceHash, bakeTerrain, readManifest } from './bake'
import { Heightmaps } from './heightmap'
import type { Stack, StackMap } from './kernel'
import { fsPackStore, type PackStore } from './pack'
import { TerrainSourceAsset } from './source-asset'
import { compileStack } from './stack'

/** Where a terrain source's packs live, under the project: `.shard/cache/terrain/<guid>`. */
export function terrainCacheDir(guid: string): string {
  // Sources made in code have `mem:` guids: kept to file-name characters.
  return `.shard/cache/terrain/${guid.replace(/[^a-zA-Z0-9._-]/g, '-')}`
}

/**
 * The bake kernel's stack for a loaded source, from the noise graphs and heightmaps loaded in the
 * world's stores. Throws `terrain/not-ready` while one isn't loaded.
 */
export function stackFor(world: World, asset: TerrainSourceAsset): Stack {
  const need = <T>(path: string, item: T | undefined): T => {
    if (item === undefined) {
      throw new ShardError('terrain/not-ready', `The terrain is waiting for ${path}`, {
        path,
        hint: 'Its assets load asynchronously; step a frame (or await the loads) first.',
      })
    }
    return item
  }
  const guid = (path: string) => ({ guid: asset.deps[path]?.guid })
  return compileStack(asset.source, {
    noise: (path) => need(path, world.tryResource(NoiseGraphs)?.get(guid(path))),
    heightmap: (path) =>
      need(path, world.tryResource(Heightmaps)?.get(guid(path)) as StackMap | undefined),
  })
}

/**
 * Whether a terrain's packs match its source (a bake would rebake nothing it can't see). With
 * generator layers (spec 0119), `stack` says which versions and params they're at.
 */
export async function bakeIsCurrent(
  store: PackStore,
  asset: TerrainSourceAsset,
  stack?: Stack,
): Promise<boolean> {
  const manifest = await readManifest(store)
  const hash = stack ? await bakeSourceHash(asset.hash, stack) : asset.hash
  return manifest?.sourceHash === hash
}

/** What baking needs of a host: its file service and, where it has one, its worker pool. */
export interface BakeHost {
  readonly fs: PlatformFileSystem
  readonly workers?: Workers | undefined
}

export interface ProjectBake {
  path: string
  guid: string
  report: BakeReport
}

/**
 * Bakes a project's terrain sources into `.shard/cache/terrain/` (`shard import`, `shard terrain
 * bake`): each one's assets loaded through the server, then an incremental bake (all of it with
 * `force`). `only` limits it to sources whose path ends with it. Sources already current are
 * skipped unless forced.
 */
export async function bakeProjectTerrains(
  server: AssetServer,
  world: World,
  fs: PlatformFileSystem,
  options: {
    force?: boolean
    only?: string
    workers?: Workers
    warn?: (problem: ShardError, path: string) => void
    /** Bake even when the packs already match the source. */
    always?: boolean
    /** Hears each near source (spec 0119), which has nothing to bake ahead. */
    near?: (path: string) => void
  } = {},
): Promise<ProjectBake[]> {
  const out: ProjectBake[] = []
  for (const entry of server.all('terrain/TerrainSource')) {
    if (options.only && !entry.path.endsWith(options.only)) continue
    await server.load(entry.guid)
    const asset = server.item(entry.guid)
    if (!(asset instanceof TerrainSourceAsset)) continue
    if (asset.source.bake === 'near') {
      options.near?.(entry.path)
      continue
    }
    const store = fsPackStore(fs, terrainCacheDir(entry.guid))
    const stack = stackFor(world, asset)
    if (!options.force && !options.always && (await bakeIsCurrent(store, asset, stack))) continue
    const hash = await bakeSourceHash(asset.hash, stack)
    const report = await bakeTerrain({ ...asset, hash }, stack, store, {
      force: options.force === true,
      ...(options.workers ? { workers: options.workers } : {}),
      warn: (problem) => options.warn?.(problem, entry.path),
    })
    out.push({ path: entry.path, guid: entry.guid, report })
  }
  return out
}
