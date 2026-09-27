import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { findEntityByPath, loadScene, ScenePlugin, whenSceneReady } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, describe, expect, it } from 'vitest'
import { duck, isSoundPlaying, playSound, setBus, stopSound } from './api'
import { AudioClips, audioClip } from './clip'
import { AudioFinished, type AudioFinishedData, AudioListener, AudioSource } from './components'
import { HeadlessAudioBackend } from './headless'
import { audioLog, describeAudio } from './methods'
import { AudioConfig, AudioState } from './mixer'
import { audioPlugin } from './plugin'
import { distanceGain, equalPowerGains } from './spatial'
import { sineWav } from './testing-utils'

const DT = 1 / 60
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

async function app(options: { scene?: boolean } = {}) {
  const backend = new HeadlessAudioBackend()
  const a = new App().addPlugin(TransformPlugin, audioPlugin({ backend }))
  if (options.scene) a.addPlugin(ScenePlugin)
  await a.init()
  return { app: a, world: a.world, backend }
}

function frames(a: App, n: number): void {
  for (let i = 0; i < n; i++) a.update(DT)
}

function addClip(world: World, seconds: number, name: string): AssetRef<'AudioClip'> {
  return world.resource(AudioClips).add(audioClip(sineWav(seconds), { id: name }), name)
}

function listener(
  world: World,
  translation: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
): Entity {
  return world.spawn(AudioListener, [Transform, { translation, rotation }])
}

function source(world: World, clip: AssetRef, fields: Record<string, unknown> = {}): Entity {
  const { translation, ...rest } = fields
  return world.spawn(
    [AudioSource, { clip: clip as AssetRef<'AudioClip'>, ...rest }],
    [Transform, { translation: (translation as [number, number, number]) ?? [0, 0, 0] }],
  )
}

const voices = (world: World) => describeAudio(world).voices

describe('spatial audio', () => {
  it('matches the Web Audio distance models and equal-power pan', () => {
    expect(distanceGain('inverse', 10, 1, 100, 1)).toBeCloseTo(0.1, 10)
    expect(distanceGain('inverse', 0.5, 1, 100, 1)).toBe(1)
    expect(distanceGain('linear', 50, 0, 100, 1)).toBeCloseTo(0.5, 10)
    expect(distanceGain('linear', 150, 0, 100, 1)).toBe(0)
    // Linear clamps the factor to 1; inverse and exponential ignore maxDistance.
    expect(distanceGain('linear', 150, 0, 100, 3)).toBe(0)
    expect(distanceGain('exponential', 4, 1, 2, 2)).toBeCloseTo(1 / 16, 10)
    expect(distanceGain('inverse', 5, 0, 100, 1)).toBe(0)
    const out = new Float64Array(2)
    equalPowerGains(1, out)
    expect(out[0]).toBeCloseTo(0, 10)
    expect(out[1]).toBeCloseTo(1, 10)
    equalPowerGains(0, out)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 10)
  })

  it('records inverse-distance gain and a pan of +1 for a source 10 m to the right', async () => {
    const { app: a, world, backend } = await app()
    const clip = addClip(world, 2, 'hum')
    listener(world)
    source(world, clip, { translation: [10, 0, 0], loop: true })
    frames(a, 1)
    const [voice] = voices(world)
    // inverse: min / (min + factor × (d - min)) = 1 / (1 + 9).
    expect(voice).toMatchObject({ state: 'active', distance: 10 })
    expect(Math.abs(voice!.gain - 0.1) / 0.1).toBeLessThan(0.01)
    expect(Math.abs(voice!.pan - 1)).toBeLessThan(0.01)
    // The backend was given a PannerNode's parameters and computes the same.
    const played = backend.active[0]!
    expect(played.spatial).toEqual({
      panning: 'equal-power',
      distanceModel: 'inverse',
      refDistance: 1,
      maxDistance: 100,
      rolloffFactor: 1,
    })
    const measured = backend.measure(played)
    expect(measured.gain).toBeCloseTo(voice!.gain, 4)
    expect(measured.pan).toBeCloseTo(1, 4)
    expect(audioLog(world)).toEqual([
      expect.objectContaining({ event: 'start', clip: 'hum', bus: 'sfx', position: [10, 0, 0] }),
    ])
  })

  it('pans relative to where the listener faces', async () => {
    const { app: a, world } = await app()
    const clip = addClip(world, 2, 'hum')
    // Turned 90° left (+Y): the source on +X is now behind, so dead center.
    const l = listener(world, [0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2])
    const s = source(world, clip, { translation: [10, 0, 0], loop: true })
    frames(a, 1)
    expect(voices(world)[0]!.pan).toBeCloseTo(0, 5)
    // Ahead-left at 45° in the listener's view: pan -0.5.
    world.set(l, Transform, { translation: [0, 0, 0], rotation: [0, 0, 0, 1] })
    world.set(s, Transform, { translation: [-5, 0, -5] })
    frames(a, 1)
    expect(voices(world)[0]!.pan).toBeCloseTo(-0.5, 5)
    expect(voices(world)[0]!.gain).toBeCloseTo(1 / Math.sqrt(50), 3)
  })

  it('virtualizes sources past a linear maxDistance and resumes them in step', async () => {
    const { app: a, world, backend } = await app()
    const clip = addClip(world, 10, 'drone')
    listener(world)
    const s = source(world, clip, {
      translation: [0, 0, -150],
      rolloff: 'linear',
      minDistance: 0,
      maxDistance: 100,
      loop: true,
    })
    frames(a, 60)
    expect(voices(world)[0]).toMatchObject({ state: 'virtual', gain: 0 })
    expect(backend.active).toHaveLength(0)
    world.set(s, Transform, { translation: [0, 0, -50] })
    frames(a, 1)
    const v = voices(world)[0]!
    expect(v).toMatchObject({ state: 'active', gain: 0.5 })
    // It kept time while silent: the backend starts it 60 frames in.
    expect(backend.active[0]!.offset).toBeCloseTo(v.time, 6)
    expect(v.time).toBeCloseTo(60 * DT, 6)
  })

  it('shifts pitch with Doppler only when asked', async () => {
    const { app: a, world } = await app()
    const clip = addClip(world, 5, 'siren')
    listener(world)
    const s = source(world, clip, { translation: [0, 0, -100], loop: true, doppler: 1 })
    const still = source(world, clip, { translation: [0, 0, -100], loop: true })
    frames(a, 1)
    // 34.3 m/s toward the listener: 343 / (343 - 34.3).
    for (const e of [s, still]) world.set(e, Transform, { translation: [0, 0, -100 + 34.3 * DT] })
    frames(a, 1)
    const [moving, fixed] = voices(world)
    expect(moving!.pitch).toBeCloseTo(343 / (343 - 34.3), 3)
    expect(fixed!.pitch).toBe(1)
  })
})

describe('sources and one-shots', () => {
  it('ends a clip at its duration divided by pitch and sends AudioFinished', async () => {
    const { app: a, world, backend } = await app()
    const clip = addClip(world, 0.5, 'blip')
    const reader = world.reader(AudioFinished)
    const s = source(world, clip, { pitch: 2, spatial: false })
    frames(a, 1)
    expect(world.get(s, AudioSource).playing).toBe(true)
    const finished: AudioFinishedData[] = []
    let endFrame = -1
    for (let f = 1; f < 40 && endFrame < 0; f++) {
      frames(a, 1)
      finished.push(...reader.read())
      if (finished.length > 0) endFrame = f
    }
    // 0.5 s at pitch 2 = 0.25 s = 15 frames.
    expect(endFrame).toBe(15)
    expect(finished).toEqual([{ entity: s, voice: expect.any(Number), clip: 'blip' }])
    expect(world.get(s, AudioSource).playing).toBe(false)
    const log = audioLog(world)
    expect(log.map((e) => [e.event, e.frame, e.reason])).toEqual([
      ['start', 0, undefined],
      ['stop', 15, 'ended'],
    ])
    expect(backend.history[0]!.stopped).toBe(true)
    // Setting playing again restarts it from startTime.
    world.set(s, AudioSource, { ...world.get(s, AudioSource), playing: true })
    frames(a, 1)
    expect(voices(world)).toHaveLength(1)
    expect(voices(world)[0]!.time).toBe(0)
  })

  it('loops between loopStart and loopEnd', async () => {
    const { app: a, world } = await app()
    const clip = world
      .resource(AudioClips)
      .add(audioClip(sineWav(1), { id: 'loop', loopStart: 0.25, loopEnd: 0.75 }), 'loop')
    source(world, clip, { loop: true, spatial: false })
    frames(a, 61) // 1 s in: 0.75 → back to 0.25, 0.25 more → 0.5
    const v = voices(world)[0]!
    expect(v.time).toBeCloseTo(0.5, 4)
    expect(v.state).toBe('active')
  })

  it('does not autoplay when autoplay is off, and stops when playing is cleared', async () => {
    const { app: a, world } = await app()
    const clip = addClip(world, 2, 'hum')
    const s = source(world, clip, { autoplay: false, loop: true })
    frames(a, 5)
    expect(voices(world)).toHaveLength(0)
    world.set(s, AudioSource, { ...world.get(s, AudioSource), playing: true })
    frames(a, 5)
    expect(voices(world)).toHaveLength(1)
    world.set(s, AudioSource, { ...world.get(s, AudioSource), playing: false })
    frames(a, 1)
    expect(voices(world)).toHaveLength(0)
    expect(audioLog(world).at(-1)).toMatchObject({ event: 'stop', reason: 'stopped' })
    world.despawn(s)
    frames(a, 1)
  })

  it('stops the voice of a despawned source', async () => {
    const { app: a, world, backend } = await app()
    const s = source(world, addClip(world, 2, 'hum'), { loop: true })
    frames(a, 2)
    world.despawn(s)
    frames(a, 1)
    expect(voices(world)).toHaveLength(0)
    expect(backend.active).toHaveLength(0)
    expect(audioLog(world).at(-1)).toMatchObject({ event: 'stop', reason: 'removed', entity: s })
  })

  it('plays one-shots at a position, and stops them on request', async () => {
    const { app: a, world, backend } = await app()
    const clip = addClip(world, 1, 'zap')
    listener(world)
    const id = playSound(world, clip, { position: [0, 0, -4], volume: 0.5 })
    frames(a, 1)
    expect(voices(world)[0]).toMatchObject({
      voice: id,
      entity: null,
      gain: 0.5 * (1 / 4),
      pan: 0,
      position: [0, 0, -4],
    })
    expect(backend.active[0]!.params.gain).toBe(0.5)
    expect(stopSound(world, id, 0.1)).toBe(true)
    expect(backend.history[0]).toMatchObject({ stopped: true, fade: 0.1 })
    expect(isSoundPlaying(world, id)).toBe(false)
    expect(stopSound(world, id)).toBe(false)
    // A clip object made in code plays flat without a position.
    const direct = audioClip(sineWav(0.1), { id: 'direct' })
    playSound(world, direct, { bus: 'ui' })
    frames(a, 1)
    expect(voices(world)[0]).toMatchObject({ clip: 'direct', bus: 'ui', gain: 1, position: null })
  })
})

describe('buses', () => {
  it('muting sfx zeroes every sfx voice and leaves music alone', async () => {
    const { app: a, world, backend } = await app()
    const zap = addClip(world, 2, 'zap')
    const theme = addClip(world, 2, 'theme')
    listener(world)
    source(world, zap, { spatial: false, loop: true })
    playSound(world, zap, { loop: true })
    source(world, theme, { spatial: false, loop: true, bus: 'music', volume: 0.8 })
    frames(a, 1)
    setBus(world, 'sfx', { muted: true })
    frames(a, 1)
    const byBus = (bus: string) => voices(world).filter((v) => v.bus === bus)
    expect(byBus('sfx').map((v) => v.gain)).toEqual([0, 0])
    expect(byBus('music').map((v) => v.gain)).toEqual([0.8])
    expect(backend.buses.get('sfx')).toBe(0)
    expect(backend.buses.get('music')).toBe(1)
    // Parents multiply: master at half halves music.
    setBus(world, 'master', { volume: 0.5 })
    frames(a, 1)
    expect(byBus('music')[0]!.gain).toBeCloseTo(0.4, 6)
    expect(() => setBus(world, 'nope', { volume: 1 })).toThrow(/No audio bus "nope"/)
  })

  it('ducks music while a voice plays and restores it after release', async () => {
    const { app: a, world } = await app()
    const theme = addClip(world, 10, 'theme')
    const line = addClip(world, 0.5, 'line')
    source(world, theme, { spatial: false, loop: true, bus: 'music' })
    duck(world, 'music', { by: 0.6, attack: 0.1, release: 0.5 })
    frames(a, 10)
    const music = () => voices(world).find((v) => v.clip === 'theme')!.gain
    expect(music()).toBe(1)
    playSound(world, line, { bus: 'voice' })
    frames(a, 3)
    expect(music()).toBeLessThan(1)
    expect(music()).toBeGreaterThan(0.4)
    frames(a, 5) // past the 0.1 s attack
    expect(music()).toBeCloseTo(0.4, 5)
    // The line ends 30 frames after the frame it started in; then 0.5 s (30 frames) of release.
    frames(a, 31 - 8)
    expect(voices(world).some((v) => v.clip === 'line')).toBe(false)
    frames(a, 15)
    expect(music()).toBeCloseTo(0.7, 1)
    frames(a, 16)
    expect(music()).toBe(1)
    expect(describeAudio(world).buses.find((b) => b.name === 'music')).toMatchObject({
      ducked: 1,
      duck: { by: 0.6, attack: 0.1, release: 0.5, when: ['voice'] },
    })
  })

  it('mixes a source on an unknown bus on master and reports audio/unknown-bus once', async () => {
    const { app: a, world } = await app()
    const errors: string[] = []
    const log = world.resource(LogResource)
    const original = log.error.bind(log)
    log.error = (err: unknown) => {
      errors.push((err as { code?: string }).code ?? String(err))
      return original(err)
    }
    source(world, addClip(world, 2, 'hum'), { bus: 'engines', spatial: false, loop: true })
    frames(a, 3)
    expect(errors).toEqual(['audio/unknown-bus'])
    expect(voices(world)[0]).toMatchObject({
      bus: 'engines',
      gain: 1,
      problem: expect.stringContaining('audio/unknown-bus'),
    })
    expect(() => playSound(world, addClip(world, 1, 'x'), { bus: 'engines' })).toThrow(
      /No audio bus "engines"/,
    )
  })
})

describe('voice limits', () => {
  it('holds at most 8 voices of one clip, keeping the highest priorities', async () => {
    const { app: a, world, backend } = await app()
    const clip = addClip(world, 1, 'bullet')
    listener(world)
    for (let i = 0; i < 100; i++) playSound(world, clip, { position: [0, 0, -2], priority: i })
    frames(a, 1)
    const kept = voices(world)
    expect(kept).toHaveLength(8)
    expect(kept.map((v) => v.priority).sort((x, y) => x - y)).toEqual([
      92, 93, 94, 95, 96, 97, 98, 99,
    ])
    expect(backend.active).toHaveLength(8)
    expect(audioLog(world).filter((e) => e.event === 'dropped')).toHaveLength(92)
    expect(describeAudio(world).counts).toMatchObject({ active: 8, dropped: 92 })
    // A louder new shot of equal priority steals the quietest; a low one is dropped.
    playSound(world, clip, { position: [0, 0, -1], priority: 92 })
    playSound(world, clip, { position: [0, 0, -1], priority: 3 })
    frames(a, 1)
    expect(voices(world)).toHaveLength(8)
    expect(backend.active).toHaveLength(8)
    const stolen = audioLog(world).filter((e) => e.reason === 'stolen')
    expect(stolen).toHaveLength(1)
    expect(stolen[0]!.voice).toBe(kept.find((v) => v.priority === 92)!.voice)
    for (let f = 0; f < 10; f++) {
      for (let i = 0; i < 20; i++) playSound(world, clip, { position: [0, 0, -2] })
      frames(a, 1)
      expect(backend.active.length).toBeLessThanOrEqual(8)
    }
  })

  it('caps voices across clips, and virtualizes sources instead of stopping them', async () => {
    const { app: a, world, backend } = await app()
    world.resource(AudioConfig).maxVoices = 4
    const clips = [0, 1, 2, 3, 4, 5].map((i) => addClip(world, 3, `c${i}`))
    const sources = clips.map((c, i) =>
      source(world, c, { loop: true, spatial: false, priority: 100 + i }),
    )
    frames(a, 1)
    expect(backend.active).toHaveLength(4)
    const byEntity = new Map(voices(world).map((v) => [v.entity, v.state]))
    expect(byEntity.get(sources[0]!)).toBe('virtual')
    expect(byEntity.get(sources[5]!)).toBe('active')
    // Freeing a voice brings the next one back, in step.
    world.despawn(sources[5]!)
    frames(a, 30)
    const back = voices(world).find((v) => v.entity === sources[1])!
    expect(back.state).toBe('active')
    expect(backend.active).toHaveLength(4)
    expect(backend.active.find((v) => v.clip === 'c1')!.offset).toBeCloseTo(DT, 6)
  })
})

describe('scene files', () => {
  it('plays an imported clip from a scene, with a bus the scene adds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-audio-scene-'))
    roots.push(root)
    mkdirSync(join(root, 'assets/sfx'), { recursive: true })
    copyFileSync(join(fixtures, 'tone-48k-stereo.ogg'), join(root, 'assets/sfx/engine.ogg'))
    const { app: a, world } = await app({ scene: true })
    await assetServer(world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }), roots: ['assets'] })
      .scan()
    loadScene(
      world,
      {
        version: 1,
        resources: { 'audio/Buses': { engines: { volume: 0.5, parent: 'sfx' } } },
        entities: [
          { name: 'camera', components: { 'core/Transform': {}, 'audio/AudioListener': {} } },
          {
            name: 'ship',
            components: {
              'core/Transform': { translation: [0, 0, -3] },
              'audio/AudioSource': {
                clip: { path: 'assets/sfx/engine.ogg' },
                bus: 'engines',
                loop: true,
                rolloff: 'linear',
                minDistance: 1,
                maxDistance: 5,
              },
            },
          },
        ],
      },
      { id: 'main' },
    )
    await whenSceneReady(world, 'main')
    frames(a, 1)
    const d = describeAudio(world)
    expect(d.listener).toMatchObject({ path: 'camera', position: [0, 0, 0] })
    expect(d.voices).toEqual([
      expect.objectContaining({
        clip: 'assets/sfx/engine.ogg',
        path: 'ship',
        bus: 'engines',
        state: 'active',
        // 0.5 (engines) × linear 1 - (3 - 1) / (5 - 1).
        gain: 0.25,
        duration: 1.25,
      }),
    ])
    expect(d.buses.find((b) => b.name === 'engines')).toMatchObject({ parent: 'sfx', gain: 0.5 })
    expect(findEntityByPath(world, 'ship')).toBe(d.voices[0]!.entity)
    // audio.log over the protocol shape.
    expect(world.resource(AudioState).log[0]).toMatchObject({ event: 'start', path: 'ship' })
  })

  it('waits for a clip that is still loading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-audio-pending-'))
    roots.push(root)
    mkdirSync(join(root, 'assets'), { recursive: true })
    copyFileSync(join(fixtures, 'tone-44k-mono.wav'), join(root, 'assets/ping.wav'))
    const { app: a, world } = await app()
    await assetServer(world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }), roots: ['assets'] })
      .scan()
    playSound(world, 'assets/ping.wav')
    frames(a, 1)
    expect(describeAudio(world).counts.pending).toBe(1)
    await assetServer(world).load('assets/ping.wav')
    frames(a, 1)
    expect(voices(world)[0]).toMatchObject({
      state: 'active',
      clip: 'assets/ping.wav',
      duration: 0.5,
    })
  })
})
