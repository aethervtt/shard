import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { audioEventsPlugin } from './events'
import { audioPlugin } from './plugin'
import { AudioPreviewHost, AudioPreviewPlan } from './preview'

describe('audio preview protocol contract', () => {
  it('roundtrips normalized asset handles through the registered method and injected host', async () => {
    const app = new App().addPlugin(TransformPlugin, audioPlugin(), audioEventsPlugin())
    await app.init()
    const method = app.methods.find((method) => method.name === 'audio.preview')!
    const payload = {
      plan: {
        duration: 1,
        mixer: { guid: 'mix' },
        events: [{ id: 'hit', asset: { path: 'hit.audio-event.json' } }],
      },
      out: 'hit.wav',
    }
    const params = method.params.deserialize(payload)
    app.world.insertResource(AudioPreviewHost, async (plan, out) => {
      expect(AudioPreviewPlan.serialize(plan)).toMatchObject(payload.plan)
      expect(plan.mixer).toMatchObject({ guid: 'mix', type: 'audio/AudioMixer' })
      expect(out).toBe('hit.wav')
      return { out, measured: { peak: 0.25 } }
    })
    expect(await method.handler({ app, world: app.world }, params)).toEqual({
      out: 'hit.wav',
      measured: { peak: 0.25 },
    })
    app.world.removeResource(AudioPreviewHost)
    expect(() => method.handler({ app, world: app.world }, params)).toThrowError(/host/)
    await app.dispose()
  })
})
