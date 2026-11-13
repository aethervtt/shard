import { defineResource, ShardError, type World } from '@aethervtt/shard-core'
import type { CharacterRig } from './rig'
import type { CharacterPartSource } from './spawn'

/**
 * A registered way to dress a character: rig, build, parts and morphs. Its index is what
 * `Character.look` and `HordeMember.look` carry, so a client composes a replicated root, or a far
 * horde proxy, without the server sending parts.
 */
export interface CharacterLook {
  /** A rig by name, or the rig itself. */
  rig: string | CharacterRig
  build?: string | number
  parts: readonly CharacterPartSource[]
  morphs?: Readonly<Record<string, number>>
  /** The rig's clip names a proxy plays per horde activity: idle, walk, attack (the default). */
  clips?: readonly string[]
}

export const CharacterLooks = defineResource<{ looks: CharacterLook[] }>('characters/Looks', {
  description:
    'Registered character looks by index (Character.look, HordeMember.look): rig, build, parts, morphs, activity clips.',
  init: () => ({ looks: [] }),
})

/** Registers the game's looks, replacing any before; index i is look i. Cold path. */
export function characterLooks(world: World, looks: readonly CharacterLook[]): void {
  if (looks.length >= 0xffff) {
    throw new ShardError('characters/too-many-looks', `${looks.length} looks; at most 65,534`)
  }
  world.initResource(CharacterLooks).looks = [...looks]
}

/** The registered look at `index`, or undefined. */
export function lookOf(world: World, index: number): CharacterLook | undefined {
  return world.tryResource(CharacterLooks)?.looks[index]
}
