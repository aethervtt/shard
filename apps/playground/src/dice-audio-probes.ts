import { assetServer } from '@aethervtt/shard-assets'
import {
  AudioEvent,
  audioClip,
  audioEventsPlugin,
  audioPlugin,
  audioState,
  playSound,
  setAudioUserBus,
} from '@aethervtt/shard-audio'
import { createWebAudioBackend } from '@aethervtt/shard-platform-web'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { DiceAudioSession } from '../../../packages/dice/src/audio'
import { wavBytes } from '../../../packages/dice/src/sound'

/** Actual Web Audio PCM output of the same bridge the dice table uses. No renderer required. */
async function render(gain: number, muted: boolean, unrelated: boolean) {
  const context = new OfflineAudioContext(1, 24000, 48000)
  const host = createWebAudioBackend({ context, fixedListener: true })
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend: host }),
    audioEventsPlugin(),
  )
  await app.init()
  const world = app.world
  const session = new DiceAudioSession(world, gain)
  try {
    const clip = audioClip(wavBytes(new Float32Array(24000).fill(0.25), 48000), {
      id: 'catalog:dice-tone',
    })
    const server = assetServer(world)
    server.virtual('dice-signal-clip', 'catalog/dice-clip', 'AudioClip', () => clip, { lazy: true })
    server.virtual(
      'dice-signal-event',
      'catalog/dice-event',
      AudioEvent.name,
      () =>
        AudioEvent.deserialize({
          bus: 'dice',
          parameters: [{ name: 'strength' }],
          layers: [{ id: 'hit', choices: [{ clip: { guid: 'dice-signal-clip' } }] }],
        }),
      { lazy: true },
    )
    const ref = { type: AudioEvent.name, guid: 'dice-signal-event', path: undefined }
    await session.prepare([ref])
    setAudioUserBus(world, 'dice', { muted })
    session.play(ref, 42, 1, 1, 20, true, false, 1)
    if (unrelated) playSound(world, clip, { bus: 'sfx' })
    app.update(0.01)
    // Decoding the unrelated legacy voice may complete asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 0))
    app.update(0.01)
    const rendered = await context.startRendering()
    const sample = rendered.getChannelData(0)[12000]!
    session.dispose()
    audioState(world).backend.runtime!.collect()
    const pins = audioState(world).backend.runtime!.memory().pinned
    return { sample, pins }
  } finally {
    session.dispose()
    await app.dispose()
    host.dispose?.()
  }
}

export async function diceAudioProbe() {
  return {
    full: await render(1, false, false),
    quarter: await render(0.25, false, false),
    muted: await render(1, true, false),
    isolated: await render(1, true, true),
  }
}
