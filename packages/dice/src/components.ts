import { defineComponent, t } from '@aethervtt/shard-core'

// Components the dice table puts on the world (0054), so agents and tools see dice as entities.

/** A die on the table. Spawned and despawned by the dice table; read-only to everyone else. */
export const DiceDie = defineComponent(
  'dice/Die',
  {
    index: t.u8({ description: 'Its body in the roll (percentile dice are two bodies).' }),
    kind: t.string({ description: 'The roll die kind: d4 … d20, d100, percentile.' }),
    definition: t.string({ description: 'The die definition it shows.' }),
    value: t.u16({ description: "The definition's value on top once landed." }),
    label: t.string({ description: 'The printed mark on top.' }),
    dropped: t.bool({ description: 'A dropped die: excluded from effects and attachments.' }),
  },
  { description: 'A die the dice table is presenting.' },
)

/** Scene hook: an entity with this plays its roll when it appears (for shard screenshot, tests). */
export const DiceRollRequest = defineComponent(
  'dice/RollRequest',
  {
    roll: t.json({
      description:
        'A DiceRoll: { id, dice: [{ kind, value, skin: { guid } }], seed, tray, motion, … }.',
    }),
    replace: t.bool({ description: 'Dismiss a roll that is playing instead of waiting for it.' }),
  },
  { description: 'Plays a dice roll when spawned; removed once the table takes it.' },
)
