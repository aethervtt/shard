import { assetServer } from '@aethervtt/shard-assets'
import type { ShardError, World } from '@aethervtt/shard-core'
import { TextureAtlas } from './atlas'
import { TilemapData, unknownTiles } from './tilemap'

type Ref = { guid?: string; path?: string }

/** Every sprite/Tilemap value in a scene or prefab file, wherever it's nested. */
function tilemapsIn(json: unknown, out: { data: Ref; atlas: Ref }[]): void {
  if (Array.isArray(json)) {
    for (const item of json) tilemapsIn(item, out)
    return
  }
  if (!json || typeof json !== 'object') return
  for (const [key, value] of Object.entries(json)) {
    if (key === 'sprite/Tilemap' && value && typeof value === 'object') {
      const v = value as { data?: Ref | null; atlas?: Ref | null }
      if (v.data && v.atlas) out.push({ data: v.data, atlas: v.atlas })
    } else tilemapsIn(value, out)
  }
}

/**
 * Checks each Tilemap's data against its atlas (0059): a palette name the atlas has no region
 * for is `sprite/unknown-tile`, naming the layer, the cell and the name, with a JSON pointer to
 * the cell's row in the data file. Scenes and prefabs say which atlas draws which data, so the
 * check runs over their files. Loads what it checks.
 */
export async function validateTilemaps(
  world: World,
  files: readonly unknown[],
): Promise<{ source: string; errors: ShardError[] }[]> {
  const server = assetServer(world)
  const found: { data: Ref; atlas: Ref }[] = []
  for (const file of files) tilemapsIn(file, found)
  const seen = new Set<string>()
  const out = new Map<string, ShardError[]>()
  for (const pair of found) {
    const data = server.entry(pair.data)
    const atlas = server.entry(pair.atlas)
    // Missing or mistyped refs are the scene check's to report.
    if (!data || !atlas || data.type !== 'TilemapData' || atlas.type !== 'TextureAtlas') continue
    const key = `${data.guid}|${atlas.guid}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      await Promise.all([server.load(data.guid), server.load(atlas.guid)])
    } catch {
      continue // an import failure, reported with the imports
    }
    const d = server.item(data.guid)
    const a = server.item(atlas.guid)
    if (!(d instanceof TilemapData) || !(a instanceof TextureAtlas)) continue
    const errors = unknownTiles(d, a)
    if (errors.length === 0) continue
    const source = data.source ?? data.path
    const list = out.get(source) ?? []
    for (const e of errors) if (!list.some((x) => x.message === e.message)) list.push(e)
    out.set(source, list)
  }
  return [...out].map(([source, errors]) => ({ source, errors }))
}
