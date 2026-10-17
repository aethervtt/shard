import { defineResource, type Entity, type ShardError, type World } from '@aethervtt/shard-core'

/** Optional audio hooks keep save-only projects independent of authored audio engines. */
export const AudioCheckpointHooks = defineResource<{
  capture(world: World, entityRef: (entity: Entity) => string | null): void
  reset(world: World): void
  restore(world: World, resolve: (ref: string) => Entity | undefined): Promise<ShardError[]>
}>('audio/CheckpointHooks')

export function captureAudioCheckpoint(
  world: World,
  entityRef: (entity: Entity) => string | null = () => null,
): void {
  world.tryResource(AudioCheckpointHooks)?.capture(world, entityRef)
}

export function resetAudioForLoad(world: World): void {
  world.tryResource(AudioCheckpointHooks)?.reset(world)
}

export async function restoreAudioCheckpoint(
  world: World,
  resolve: (ref: string) => Entity | undefined = () => undefined,
): Promise<ShardError[]> {
  return world.tryResource(AudioCheckpointHooks)?.restore(world, resolve) ?? []
}
