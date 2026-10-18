import { assetServer } from '@aethervtt/shard-assets'
import {
  AudioBuses,
  AudioEvent,
  AudioMixer,
  AudioState,
  audioClip,
  audioEvents,
  audioEventsPlugin,
  audioMixerPlugin,
  audioPlugin,
  configureAudioMixer,
  HeadlessAudioBackend,
  playSound,
  setAudioUserBus,
  stopAudioEvent,
} from '@aethervtt/shard-audio'
import type { AssetRef } from '@aethervtt/shard-core'
import { budget, timingMode } from '@aethervtt/shard-core/test-env'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { DiceAudioSession, ensureDiceAudioBus } from './audio'
import { DiceEffectRecipe, diceEffectRecipe } from './effects'
import { DiceSkin, diceSkin } from './skin'
import { wavBytes } from './sound'

const ref: AssetRef = { type: AudioEvent.name, guid: 'db-event', path: undefined }

async function setup(options: { gain?: number; audio?: boolean; events?: boolean } = {}) {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(TransformPlugin)
  if (options.audio !== false) app.addPlugin(audioPlugin({ backend }))
  if (options.audio !== false && options.events !== false)
    app.addPlugin(audioEventsPlugin(), audioMixerPlugin())
  await app.init()
  const world = app.world
  const clip = audioClip(wavBytes(new Float32Array(3200).fill(0.25)), { id: 'db-clip' })
  const event = AudioEvent.deserialize({
    bus: 'dice',
    parameters: [
      { name: 'strength' },
      { name: 'pitch', min: 0.1, max: 4, initial: 1 },
      { name: 'value', kind: 'discrete', max: 100 },
      { name: 'high', kind: 'discrete' },
      { name: 'low', kind: 'discrete' },
      { name: 'count', kind: 'discrete', max: 200 },
      { name: 'contact', kind: 'discrete' },
      { name: 'unrelated', initial: 0.7 },
    ],
    layers: [
      {
        id: 'body',
        selector: 'random',
        choices: [{ clip: { guid: 'db-clip' } }, { clip: { guid: 'db-clip' } }],
        curves: [
          {
            parameter: 'strength',
            property: 'gainDb',
            points: [
              [0, -20],
              [1, 0],
            ],
          },
        ],
      },
      {
        id: 'accent',
        condition: { parameter: 'high', min: 1, max: 1 },
        choices: [{ clip: { guid: 'db-clip' } }],
      },
    ],
  })
  let loads = 0
  const server = assetServer(world)
  // Catalog names are opaque host keys, never filesystem reads. Playback only receives GUIDs.
  if (options.audio !== false) {
    server.virtual(
      'db-clip',
      'catalog/clip',
      'AudioClip',
      () => {
        loads++
        return clip
      },
      { lazy: true },
    )
    if (options.events !== false)
      server.virtual(
        'db-event',
        'catalog/event',
        AudioEvent.name,
        () => {
          loads++
          return event
        },
        { lazy: true },
      )
  }
  const session = new DiceAudioSession(world, options.gain ?? 0.5)
  return { app, world, backend, clip, event, session, loads: () => loads }
}

it('round-trips typed bindings and preserves old document defaults', () => {
  const old = diceSkin({ id: 'old' })
  expect(old.sounds.impactEvent).toBeNull()
  expect(old.sounds.resultEvent).toBeNull()
  expect(old.sounds.entranceEvent).toBeNull()
  const skin = diceSkin({ id: 'bound', sounds: { impactEvent: { guid: 'db-event' } } })
  expect(DiceSkin.deserialize(DiceSkin.serialize(skin)).sounds.impactEvent).toEqual(ref)
  const recipe = diceEffectRecipe({
    id: 'crit',
    effects: [{ kind: 'sound-accent', event: { guid: 'db-event' } }],
  })
  expect(
    DiceEffectRecipe.deserialize(DiceEffectRecipe.serialize(recipe)).effects[0]!.event,
  ).toEqual(ref)
})

it('prepares host GUID assets once, drives declared inputs and layers, preserves seeds and frees pins', async () => {
  const r = await setup()
  try {
    await r.session.prepare([ref, ref])
    expect(r.loads()).toBe(2)
    expect(audioEvents(r.world).leases.size).toBe(1)
    r.session.play(ref, 42, 0.5, 1.2, 20, true, false, 3, 1)
    r.app.update(0.01)
    const instance = audioEvents(r.world).instances.find(
      (i) => i && i.state !== 'ended' && i.state !== 'failed',
    )!
    expect(instance).toBeDefined()
    expect(instance.parameters!.targets).toEqual(new Float64Array([0.5, 1.2, 20, 1, 0, 3, 1, 0.7]))
    expect(r.backend.active).toHaveLength(2)
    expect(r.backend.active.every((voice) => voice.bus === 'dice' && voice.spatial === null)).toBe(
      true,
    )
    expect(r.backend.active[0]!.params.gain).toBeCloseTo(0.5 * 10 ** (-10 / 20), 5)
    expect(r.backend.active[1]!.params.gain).toBeCloseTo(0.5, 5)
    const selected = instance.layers[0]!.selected
    stopAudioEvent(r.world, instance.id, { release: 0 })
    r.session.play(ref, 42, 0.5, 1.2, 20, false, false, 3)
    r.app.update(0.01)
    const replay = audioEvents(r.world).instances.find(
      (i) => i && i.state !== 'ended' && i.state !== 'failed',
    )!
    expect(replay.layers[0]!.selected).toBe(selected)
    expect(r.backend.active).toHaveLength(1)
    r.session.dispose()
    r.session.dispose()
    expect(r.backend.active).toHaveLength(0)
    expect(audioEvents(r.world).leases.size).toBe(0)
    r.backend.collect()
    expect(r.backend.memory().pinned).toBe(0)
  } finally {
    r.session.dispose()
    await r.app.dispose()
  }
})

it('isolates dice user controls from other sfx and preserves host bus settings', async () => {
  const r = await setup()
  try {
    r.world.resource(AudioBuses).dice = { volume: 0.7, parent: 'master' }
    await r.session.prepare([ref])
    expect(r.world.resource(AudioBuses).dice!.volume).toBe(0.7)
    r.session.play(ref, 1, 1, 1, 6, false, false, 1)
    const other = playSound(r.world, r.clip)
    setAudioUserBus(r.world, 'dice', { muted: true })
    r.app.update(0.01)
    const voices = r.world.resource(AudioState).voices
    expect(voices.find((voice) => voice.bus === 'dice')!.gain).toBe(0)
    expect(voices.find((voice) => voice.id === other)!.gain).toBeGreaterThan(0)
    setAudioUserBus(r.world, 'dice', { muted: false, volume: 0.25 })
    r.app.update(0.01)
    expect(voices.find((voice) => voice.bus === 'dice')!.gain).toBeCloseTo(0.5 * 0.7 * 0.25, 5)
  } finally {
    r.session.dispose()
    await r.app.dispose()
  }
})

it.each([{ gain: 0 }, { audio: false }])(
  'does not fetch or play audio when disabled: %j',
  async (options) => {
    const r = await setup(options)
    try {
      await r.session.prepare([ref])
      expect(r.session.play(ref, 1, 1, 1, 20, true, false, 1)).toBe(true)
      expect(r.loads()).toBe(0)
      expect(r.backend.active).toHaveLength(0)
    } finally {
      r.session.dispose()
      await r.app.dispose()
    }
  },
)

it('reports a missing events plugin before playback', async () => {
  const r = await setup({ events: false })
  try {
    await expect(r.session.prepare([ref])).rejects.toMatchObject({
      code: 'dice/audio-events-missing',
    })
    expect(r.loads()).toBe(0)
  } finally {
    r.session.dispose()
    await r.app.dispose()
  }
})

it.each(['spatial', 'sustain', 'bus', 'readonly', 'label', 'discrete-strength'])(
  'rejects incompatible %s events without leaked leases',
  async (kind) => {
    const r = await setup()
    try {
      if (kind === 'spatial') r.event.layers[0]!.spatial = true
      if (kind === 'sustain') r.event.mode = 'sustain'
      if (kind === 'bus') r.event.bus = 'sfx'
      if (kind === 'readonly') r.event.parameters[0]!.readonly = true
      if (kind === 'label')
        Object.assign(r.event.parameters[0]!, { kind: 'label', labels: ['soft'] })
      if (kind === 'discrete-strength') r.event.parameters[0]!.kind = 'discrete'
      await expect(r.session.prepare([ref])).rejects.toMatchObject({
        code: expect.stringMatching(/^dice\/audio-/),
      })
      expect(audioEvents(r.world).leases.size).toBe(0)
      r.backend.collect()
      expect(r.backend.memory().pinned).toBe(0)
    } finally {
      r.session.dispose()
      await r.app.dispose()
    }
  },
)

it('releases a preparation that resolves after cancellation and never plays it', async () => {
  const r = await setup()
  let ready!: () => void
  const waiting = new Promise<void>((resolve) => {
    ready = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  assetServer(r.world).virtual(
    'delayed',
    'catalog/delayed',
    AudioEvent.name,
    async () => {
      entered()
      await waiting
      return r.event
    },
    { lazy: true },
  )
  const delayed = { ...ref, guid: 'delayed' }
  try {
    const preparing = r.session.prepare([delayed])
    await started
    r.session.dispose()
    ready()
    await preparing
    r.session.play(delayed, 1, 1, 1, 20, false, false, 1)
    r.app.update(0.01)
    expect(r.backend.active).toHaveLength(0)
    expect(audioEvents(r.world).leases.size).toBe(0)
    r.backend.collect()
    expect(r.backend.memory().pinned).toBe(0)
  } finally {
    ready()
    r.session.dispose()
    await r.app.dispose()
  }
})

it('requires an authored mixer dice route and accepts child buses', async () => {
  const r = await setup()
  try {
    await configureAudioMixer(
      r.world,
      AudioMixer.deserialize({ buses: [{ id: 'master', parent: '' }, { id: 'sfx' }] }),
    )
    expect(() => ensureDiceAudioBus(r.world)).toThrow(/dice bus/)
    await configureAudioMixer(
      r.world,
      AudioMixer.deserialize({
        buses: [
          { id: 'master', parent: '' },
          { id: 'sfx' },
          { id: 'dice', parent: 'master' },
          { id: 'hits', parent: 'dice' },
        ],
      }),
    )
    r.event.layers[0]!.bus = 'hits'
    await r.session.prepare([ref])
    r.session.play(ref, 1, 1, 1, 6, false, false, 1)
    r.app.update(0.01)
    expect(r.backend.active[0]!.bus).toBe('hits')
  } finally {
    r.session.dispose()
    await r.app.dispose()
  }
})

it('keeps event ownership bounded across repeated contact bursts and measures onset cost', async () => {
  const r = await setup()
  try {
    await r.session.prepare([ref])
    const samples = new Float64Array(timingMode === 'bench' ? 1000 : 3)
    for (let i = 0; i < samples.length; i++) {
      const start = performance.now()
      for (let j = 0; j < 4; j++) r.session.play(ref, i * 4 + j, 0.5, 1, 6, false, false, 4)
      samples[i] = performance.now() - start
      for (let j = 0; j < 20; j++) r.app.update(0.02)
    }
    expect(r.backend.active).toHaveLength(0)
    expect(audioEvents(r.world).leases.size).toBe(1)
    if (timingMode === 'bench') {
      samples.sort()
      console.log(
        `dice/audio-onsets: ${samples[samples.length >> 1]} ms median for four prepared hits`,
      )
      expect(samples[samples.length >> 1]!).toBeLessThan(budget('dice/audio-onsets'))
    }
  } finally {
    r.session.dispose()
    await r.app.dispose()
  }
})
