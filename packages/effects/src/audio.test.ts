import { assetServer } from '@aethervtt/shard-assets'
import {
  AudioEvent,
  audioClip,
  audioEventsPlugin,
  audioPlugin,
  describeAudioEvents,
  HeadlessAudioBackend,
} from '@aethervtt/shard-audio'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { sineWav } from '../../audio/src/testing-utils'
import { effectsPlugin } from './plugin'
import { cancelEffect, describeEffects, pauseEffect, playEffect, prepareEffect } from './runtime'

it('owns real authored audio lifetimes, pauses locally and skips completely missed windows', async () => {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend }),
    audioEventsPlugin(),
    effectsPlugin,
  )
  await app.init()
  const world = app.world,
    server = assetServer(world)
  server.virtual('sound', 'catalog/sound', 'AudioClip', () =>
    audioClip(sineWav(5), { id: 'sound' }),
  )
  server.virtual('event', 'catalog/event', AudioEvent.name, () =>
    AudioEvent.deserialize({ layers: [{ id: 'body', choices: [{ clip: { guid: 'sound' } }] }] }),
  )
  const actor = world.spawn(Transform)
  const plan = await prepareEffect(world, {
    duration: 2,
    targets: [{ id: 'actor' }],
    tracks: [
      {
        id: 'sound',
        kind: 'audio',
        target: 'actor',
        start: 0.2,
        duration: 1,
        audio: { guid: 'event' },
      },
      { id: 'impact', kind: 'marker', start: 0.3, marker: 'impact' },
    ],
  })
  playEffect(world, plan, { bindings: { actor } })
  app.update(2)
  expect(backend.active).toHaveLength(0)
  expect(describeEffects(world).trace.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'skip', reason: 'missed-window' }),
      expect.objectContaining({ kind: 'marker', reason: 'impact' }),
    ]),
  )
  const run = playEffect(world, plan, { bindings: { actor }, seed: 5 })
  app.update(0.25)
  expect(backend.active).toHaveLength(1)
  pauseEffect(world, run.id)
  const time = describeAudioEvents(world).instances[0]!.decisionTime
  app.update(0.25)
  expect(describeAudioEvents(world).instances[0]!.decisionTime).toBe(time)
  pauseEffect(world, run.id, false)
  plan.release()
  cancelEffect(world, run.id)
  app.update(0)
  expect(backend.active).toHaveLength(0)
  expect(describeAudioEvents(world).instances).toEqual([])
  backend.collect()
  expect(backend.memory().pinned).toBe(0)
  await app.dispose()
})
