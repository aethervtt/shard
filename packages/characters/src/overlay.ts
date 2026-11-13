import type { World } from '@aethervtt/shard-core'
import { defineOverlay } from '@aethervtt/shard-render'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Character, CharacterTier } from './components'

/** Near green, mid yellow, far red; off isn't drawn. */
const COLORS = [
  [0.2, 0.9, 0.3, 1],
  [1, 0.85, 0.2, 1],
  [1, 0.3, 0.25, 1],
]
const a = new Float32Array(3)
const b = new Float32Array(3)

/** A coloured mark over every drawn character by tier: the `character-tiers` overlay. */
export const tiersOverlay = defineOverlay({
  name: 'character-tiers',
  description:
    'A mark over each character by representation tier (0115): green near, yellow mid, red far. Off characters get none.',
  draw(world: World, g, passes) {
    const q = world.query({ with: [Character, CharacterTier, GlobalTransform] })
    for (const table of q.tables) {
      const tiers = table.column(CharacterTier, 'tier')
      const m = table.column(GlobalTransform, 'matrix')
      for (let i = 0; i < table.count; i++) {
        const tier = tiers[i]!
        if (tier > 2 || !passes(table.entities[i]!)) continue
        const o = i * 12
        a[0] = m[o + 3]!
        a[1] = m[o + 7]! + 2
        a[2] = m[o + 11]!
        b[0] = a[0]
        b[1] = a[1] + 0.4
        b[2] = a[2]
        g.line(a, b, COLORS[tier]!)
        b[1] = a[1]
        b[0] = a[0] - 0.2
        a[0] = a[0] + 0.2
        g.line(b, a, COLORS[tier]!)
      }
    }
  },
})
