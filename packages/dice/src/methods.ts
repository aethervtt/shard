import { defineSchema, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import type { DiceRoll } from './roll'
import { DiceTable } from './table'

// The dice's agent surface (0054): describe the table, play a roll, dismiss it. With a fixed seed
// (and `motion: 'reduced'` for an instant landing) a screenshot shows a skin or a layout.

export const diceMethods: AppMethod[] = [
  {
    name: 'dice.describe',
    description:
      "The dice table: phase, quality tier and its reason, each die (kind, value, label, natural value, correction, placed), the track (hash, steps, settled, maxStepsHit, simulation ms, contacts), placed-fallback dice, matched recipes, draw calls, live attachments, the dice's lens fields, resources and GPU objects.",
    params: defineSchema('dice/DescribeParams', {}),
    handler: ({ world }) => world.resource(DiceTable).describe(),
  },
  {
    name: 'dice.play',
    description:
      "Plays a roll the host decided: { roll: { id, dice: [{ kind: 'd20', value: 17, skin: { guid: 'dice:skin/ivory' } }], seed, tray, motion, quality, effects }, replace, wait }. With wait, resolves with the outcome once it's over (a 60 s rest unless dismissed); otherwise at once.",
    params: defineSchema('dice/PlayParams', {
      roll: t.json({ description: 'A DiceRoll.' }),
      replace: t.bool({ description: 'Dismiss a roll that is playing.' }),
      wait: t.bool({ description: 'Resolve with the outcome instead of at once.' }),
    }),
    handler: async ({ world }, p) => {
      const table = world.resource(DiceTable)
      const outcome = table.play(p.roll as unknown as DiceRoll, { replace: p.replace as boolean })
      if (p.wait) return { outcome: await outcome, lastError: table.describe().lastError }
      outcome.catch(() => {})
      return { started: true, phase: table.phase }
    },
  },
  {
    name: 'dice.dismiss',
    description: 'Dismisses the roll on the table, if any.',
    params: defineSchema('dice/DismissParams', {}),
    handler: ({ world }) => ({ dismissed: world.resource(DiceTable).dismiss() }),
  },
]
