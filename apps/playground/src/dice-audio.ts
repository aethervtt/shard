import { AudioClips, AudioEvent } from '@aethervtt/shard-audio'
import type { World } from '@aethervtt/shard-core'
import { DiceSoundBank } from '@aethervtt/shard-dice'

/** Example catalog documents; Aether supplies equivalent GUID assets from its own storage. */
export function installDiceAudioDemo(world: World) {
  const bank = new DiceSoundBank()
  const clips = world.resource(AudioClips)
  const events = world.resource(AudioEvent.store)
  const impactEvent = events.add(
    AudioEvent.deserialize({
      bus: 'dice',
      parameters: [{ name: 'strength' }, { name: 'pitch', min: 0.1, max: 4, initial: 1 }],
      layers: [0, 1, 2].map((layer) => ({
        id: ['soft', 'medium', 'hard'][layer],
        selector: 'no-repeat',
        choices: Array.from({ length: 6 }, (_, variation) => {
          const clip = bank.impact('glass', 'tray', layer, variation)
          return { clip: clips.add(clip, clip.id) }
        }),
        condition: {
          parameter: 'strength',
          min: [0, 0.33, 0.66][layer],
          max: [0.329999, 0.659999, 1][layer],
        },
        pitchRandom: [-0.8, 0.8],
        curves: [
          {
            parameter: 'strength',
            property: 'gainDb',
            points: [
              [0, -45],
              [0.5, -22],
              [1, -12],
            ],
          },
          {
            parameter: 'pitch',
            property: 'pitchSemitones',
            points: [
              [0.5, -12],
              [1, 0],
              [2, 12],
            ],
          },
        ],
      })),
    }),
    'demo:audio/glass-hit',
  )
  const chime = bank.accent('arcane-spark'),
    bass = bank.accent('void-whump')
  const resultEvent = events.add(
    AudioEvent.deserialize({
      bus: 'dice',
      parameters: [{ name: 'high', kind: 'discrete' }],
      layers: [
        { id: 'chime', gainDb: -12, choices: [{ clip: clips.add(chime, chime.id) }] },
        {
          id: 'high-roll-bass',
          gainDb: -14,
          condition: { parameter: 'high', min: 1, max: 1 },
          choices: [{ clip: clips.add(bass, bass.id) }],
        },
      ],
    }),
    'demo:audio/enchanted-result',
  )
  return { impactEvent, resultEvent }
}
