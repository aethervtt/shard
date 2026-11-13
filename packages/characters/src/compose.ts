import {
  defineResource,
  defineSystem,
  type Entity,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { LogResource } from '@aethervtt/shard-runtime'
import { Character, NO_LOOK } from './components'
import { lookOf } from './looks'
import { CharacterStates, type SpawnCharacterOptions, spawnCharacter } from './spawn'

export type SpawnLookOptions = Omit<SpawnCharacterOptions, 'parts' | 'build' | 'morphs' | 'look'>

/** Spawns (or, with `root`, composes) a character from a registered look. */
export function spawnLook(world: World, look: number, options: SpawnLookOptions = {}): Entity {
  const l = lookOf(world, look)
  if (!l) {
    throw new ShardError('characters/unknown-look', `No character look #${look}`, {
      hint: 'Register looks with characterLooks(world, [...]) first.',
    })
  }
  return spawnCharacter(world, l.rig, {
    ...options,
    build: l.build,
    parts: l.parts,
    morphs: l.morphs,
    look,
  })
}

/** Character roots added without a state (replicated ones), to compose from their look. */
export const PendingLooks = defineResource<{ entities: Entity[] }>('characters/PendingLooks', {
  description: 'Character roots that arrived without parts, composed from their look next frame.',
  init: () => ({ entities: [] }),
})

/**
 * Composes a replicated character: a root with `Character.look` and no parts gets the look's
 * parts, tier state and player, as spawnCharacter would have made them. Roots the server spawned
 * with explicit parts (no look) can't be composed and are left alone.
 */
export const composeLooks = defineSystem({
  name: 'characters/compose',
  description:
    'Composes replicated character roots from their registered look (Character.look): parts, tier state, player.',
  run: (_, world) => {
    const pending = world.tryResource(PendingLooks)
    if (!pending || pending.entities.length === 0) return
    const states = world.resource(CharacterStates)
    const list = pending.entities
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!
      if (!world.isAlive(e) || states.has(e) || !world.has(e, Character)) continue
      const look = world.get(e, Character).look
      if (look === NO_LOOK) continue
      if (!lookOf(world, look)) {
        world
          .tryResource(LogResource)
          ?.log('warn', `Character ${e} has look #${look}, which isn't registered`, {
            code: 'characters/unknown-look',
            hint: 'Register the same looks on clients as on the server (characterLooks).',
          })
        continue
      }
      spawnLook(world, look, { root: e })
    }
    list.length = 0
  },
})
