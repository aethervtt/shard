import {
  audioEvents,
  audioEventsPlugin,
  audioPlugin,
  HeadlessAudioBackend,
} from '@aethervtt/shard-audio'
import { diceSkin } from '@aethervtt/shard-dice'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { DiceAudioSession } from '../../../packages/dice/src/audio'
import { installDiceAudioDemo } from './dice-audio'

it('authors the enchanted demo through serialized handles and selects its strength and high-roll layers', async () => {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(TransformPlugin, audioPlugin({ backend }), audioEventsPlugin())
  await app.init()
  const session = new DiceAudioSession(app.world, 0.7)
  try {
    const skin = diceSkin({ id: 'demo', sounds: installDiceAudioDemo(app.world) })
    const impact = skin.sounds.impactEvent!,
      result = skin.sounds.resultEvent!
    await session.prepare([impact, result])
    for (const [strength, layer] of [
      [0.1, 0],
      [0.5, 1],
      [0.9, 2],
    ] as const) {
      session.play(impact, 42, strength, 1, 20, true, false, 1)
      app.update(0.01)
      const instance = audioEvents(app.world)
        .instances.filter((i) => i?.key === impact.guid)
        .at(-1)!
      expect(instance.layers.map((l) => l.voice !== null)).toEqual(
        [0, 1, 2].map((i) => i === layer),
      )
    }
    session.play(result, 42, 1, 1, 20, true, false, 1)
    app.update(0.01)
    const celebration = audioEvents(app.world).instances.find((i) => i?.key === result.guid)!
    expect(celebration.layers.every((layer) => layer.voice !== null)).toBe(true)
    expect(backend.history.length).toBe(5)
    session.dispose()
    expect(backend.active).toHaveLength(0)
    backend.collect()
    expect(backend.memory().pinned).toBe(0)
  } finally {
    session.dispose()
    await app.dispose()
  }
})
