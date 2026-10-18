import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef, World } from '@aethervtt/shard-core'

/** Catalog lookup preserves GUID identity and supports unresolved schema/path handles. */
export function resolveAudioRef(world: World, ref: AssetRef | string): AssetRef {
  const entry = assetServer(world).entry(ref)
  if (entry) return { type: entry.type, guid: entry.guid, path: entry.path }
  return typeof ref === 'string' ? { type: '', guid: undefined, path: ref } : ref
}
