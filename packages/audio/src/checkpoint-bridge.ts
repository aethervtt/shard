import { defineResource, type Entity, type ShardError, type World } from '@aethervtt/shard-core'

/** Optional audio hooks keep save-only projects independent of authored audio engines. */
export const AudioCheckpointHooks = defineResource<{
  loading: boolean
  capture(world: World, entityRef: (entity: Entity) => string | null): void
  reset(world: World, clearCheckpoint?: boolean): void
  restore(world: World, resolve: (ref: string) => Entity | undefined): Promise<ShardError[]>
}>('audio/CheckpointHooks')

export function captureAudioCheckpoint(
  world: World,
  entityRef: (entity: Entity) => string | null = () => null,
): void {
  world.tryResource(AudioCheckpointHooks)?.capture(world, entityRef)
}

export function resetAudioForLoad(world: World, clearCheckpoint = false): void {
  world.tryResource(AudioCheckpointHooks)?.reset(world, clearCheckpoint)
}

export async function restoreAudioCheckpoint(
  world: World,
  resolve: (ref: string) => Entity | undefined = () => undefined,
): Promise<ShardError[]> {
  return world.tryResource(AudioCheckpointHooks)?.restore(world, resolve) ?? []
}

/** Suppress autonomous audio wakes while save reconstructs a world. */
export function setAudioLoading(world: World, loading: boolean): void {
  const hooks = world.tryResource(AudioCheckpointHooks)
  if (hooks) hooks.loading = loading
}
