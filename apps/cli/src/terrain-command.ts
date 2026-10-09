import type { AssetServer } from '@aethervtt/shard-assets'
import { ShardError, type World } from '@aethervtt/shard-core'
import {
  type BakeHost,
  bakeProjectTerrains,
  fsPackStore,
  type ProjectBake,
  readManifest,
  TerrainSourceAsset,
  terrainCacheDir,
  terrainStats,
} from '@aethervtt/shard-terrain'
import type { CommandContext } from './commands'
import { openProjectAssets } from './commands'
import { EXIT } from './output'

function bakeLine(b: ProjectBake): string {
  const r = b.report
  return `  terrain ${b.path}: ${r.rebaked} of ${r.blocks} blocks rebaked, ${r.pages} pages (${r.ancestors} ancestors), ${(r.bytes / 1e6).toFixed(1)} MB written in ${Math.round(r.ms)} ms${r.outOfRange.length > 0 ? `; ${r.outOfRange.length} blocks clipped by heightRange` : ''}`
}

/** `shard import`'s second step: bakes terrains whose packs no longer match their source (0071). */
export async function bakeStaleTerrains(
  server: AssetServer,
  world: World,
  platform: BakeHost,
): Promise<{ baked: ProjectBake[]; lines: string[]; failed: boolean }> {
  const lines: string[] = []
  let failed = false
  let baked: ProjectBake[] = []
  try {
    baked = await bakeProjectTerrains(server, world, platform.fs, {
      ...(platform.workers ? { workers: platform.workers } : {}),
      warn: (problem, path) =>
        lines.push(`  warning ${path}: [${problem.code}] ${problem.message}`),
    })
  } catch (err) {
    failed = true
    const e = err instanceof ShardError ? err : new ShardError('terrain/bake-failed', String(err))
    lines.push(
      `  FAILED terrain bake: [${e.code}] ${e.message}${e.hint ? `\n      hint: ${e.hint}` : ''}`,
    )
  }
  return { baked, lines: [...baked.map(bakeLine), ...lines], failed }
}

const USAGE = 'Usage: shard terrain bake [file] [--force] | shard terrain stats [file]'

/**
 * `shard terrain bake [file] [--force]`: bakes terrain sources (all of them, or those whose path
 * ends with `file`) into `.shard/cache/terrain/`, incrementally unless forced.
 * `shard terrain stats [file]`: size on disk, blocks, pages and time per block (0071).
 */
export async function terrain(ctx: CommandContext): Promise<number> {
  const [mode, file] = ctx.args
  if (mode !== 'bake' && mode !== 'stats') throw new ShardError('cli/usage', USAGE)
  const { server, world, platform } = await openProjectAssets(ctx.project)
  await server.scan()
  const entries = server
    .all('terrain/TerrainSource')
    .filter((e) => !file || e.path.endsWith(file.replace(/^\.\//, '')))
  if (file && entries.length === 0) {
    throw new ShardError('terrain/no-source', `No terrain source matches "${file}"`, {
      hint: 'Terrain sources are *.terrain.json files under the asset roots; `shard import` lists failures.',
    })
  }
  try {
    if (mode === 'bake') {
      const warnings: string[] = []
      const baked = await bakeProjectTerrains(server, world, platform.fs, {
        force: ctx.flags.force === true,
        always: true,
        ...(file ? { only: file.replace(/^\.\//, '') } : {}),
        ...(platform.workers ? { workers: platform.workers } : {}),
        warn: (problem, path) =>
          warnings.push(`  warning ${path}: [${problem.code}] ${problem.message}`),
      })
      ctx.out.result(
        { baked },
        baked.length === 0
          ? 'No terrain sources to bake.'
          : [...baked.map(bakeLine), ...warnings].join('\n'),
      )
      return EXIT.ok
    }
    const stats = []
    for (const entry of entries) {
      await server.load(entry.guid)
      const asset = server.item(entry.guid)
      if (!(asset instanceof TerrainSourceAsset)) continue
      const store = fsPackStore(platform.fs, terrainCacheDir(entry.guid))
      const manifest = await readManifest(store)
      stats.push({ path: entry.path, ...(await terrainStats(asset, store, manifest)) })
    }
    ctx.out.result(
      { terrains: stats },
      stats
        .map((s) =>
          s.baked
            ? `${s.path}: ${s.size[0]} × ${s.size[1]} m at ${s.spacing} m, ${s.roots} roots, depth ${s.depth}; ${s.blocks} blocks (${s.current ? 'current' : 'stale: run shard terrain bake'}), ${s.pages} pages, ${(s.bytesOnDisk / 1e6).toFixed(1)} MB on disk (${s.bytesPerSample.toFixed(2)} B/sample before deflate, ${s.diskBytesPerSample.toFixed(2)} after); ${s.msPerBlock.toFixed(0)} ms per block (slowest ${s.slowestBlockMs.toFixed(0)} ms)`
            : `${s.path}: not baked yet (shard terrain bake)`,
        )
        .join('\n') || 'No terrain sources.',
    )
    return EXIT.ok
  } finally {
    platform.workers?.dispose()
  }
}
