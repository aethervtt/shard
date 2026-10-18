import { defineResource, type World } from '@aethervtt/shard-core'

/** Optional plugins register inspectors without pulling their engines into base audio. */
export const AudioInspectors = defineResource<Map<string, (world: World) => unknown>>(
  'audio/Inspectors',
  { init: () => new Map() },
)

export function inspectAudioExtensions(world: World): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, inspect] of world.tryResource(AudioInspectors) ?? [])
    result[name] = inspect(world)
  return result
}
