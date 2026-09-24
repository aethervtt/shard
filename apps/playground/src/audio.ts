import { assetServer } from '@shard/assets'
import {
  AudioBuses,
  AudioSource,
  audioPlugin,
  describeAudio,
  duck,
  playSound,
  setBus,
} from '@shard/audio'
import {
  defineResource,
  defineSystem,
  type Entity,
  Last,
  quat,
  Update,
  type World,
} from '@shard/core'
import { sphere, torus } from '@shard/mesh'
import type { Platform } from '@shard/platform'
import { createWebAudioBackend, type WebAudioBackend } from '@shard/platform-web'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
} from '@shard/render'
import { App, definePlugin, Time } from '@shard/runtime'
import {
  findEntityByPath,
  loadScene,
  type SceneFile,
  ScenePlugin,
  whenSceneReady,
} from '@shard/scene'
import { Transform, TransformPlugin } from '@shard/transform'
import laserUrl from '../../../examples/star-explorer/assets/sfx/laser.ogg?url'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

// --- sounds --------------------------------------------------------------------------------------
//
// Synthesized into real WAV files in an in-memory project folder, next to star-explorer's
// laser.ogg, and imported by the audio importer like any project's assets.

const RATE = 44100

function wav(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true)
  }
  return out
}

/** Every frequency is a whole number of cycles over the clip, so the loop is seamless. */
function hum(): Float32Array {
  const n = RATE * 2
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const w = 2 * Math.PI * 110 * t
    // Steady (no tremolo), so a short meter window reads its true level.
    out[i] =
      0.3 * (Math.sin(w) + 0.5 * Math.sin(2 * w) + 0.3 * Math.sin(3 * w) + 0.15 * Math.sin(5 * w))
  }
  return out
}

function pad(): Float32Array {
  const n = RATE * 4
  const out = new Float32Array(n)
  const notes = [220, 277.25, 329.5, 440]
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const swell = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.25 * t)
    let v = 0
    for (const f of notes) v += Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(4 * Math.PI * f * t)
    out[i] = 0.12 * swell * v
  }
  return out
}

function ping(): Float32Array {
  const out = new Float32Array(RATE)
  for (let i = 0; i < RATE * 0.25; i++) {
    const t = i / RATE
    out[i] = 0.7 * Math.min(1, i / 60) * Math.exp(-t * 18) * Math.sin(2 * Math.PI * 1320 * t)
  }
  return out
}

/** Six "syllables" of a vowel-ish buzz: a radio line to duck the music under. */
function line(): Float32Array {
  const n = Math.round(RATE * 1.8)
  const out = new Float32Array(n)
  const pitches = [190, 230, 210, 250, 200, 170]
  for (let s = 0; s < pitches.length; s++) {
    const start = Math.round(RATE * (0.05 + s * 0.28))
    const len = Math.round(RATE * 0.2)
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / RATE
      const env = Math.sin((Math.PI * i) / len)
      const w = 2 * Math.PI * pitches[s]! * t
      out[start + i] =
        0.35 *
        env *
        (Math.sin(w) + 0.6 * Math.sin(3 * w) + 0.4 * Math.sin(5 * w) + 0.2 * Math.sin(7 * w))
    }
  }
  return out
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / samples.length)
}

const HUM = 'assets/sfx/hum.wav'
const PING = 'assets/sfx/ping.wav'
const LINE = 'assets/voice/line.wav'
// Under music/: imported as a streamed clip (media element), the way music ships.
const PAD = 'assets/music/pad.wav'
const LASER = 'assets/sfx/laser.ogg'

// --- the scene (the same file in the browser and in the headless mirror) -----------------------

const ORBIT_RADIUS = 6
const scene: SceneFile = {
  version: 1,
  resources: {
    // A bus of its own, so the demo can meter just the orbiter.
    'audio/Buses': { orbiter: { volume: 1, parent: 'sfx' } },
  },
  entities: [
    {
      name: 'camera',
      components: {
        'core/Transform': { translation: [0, 5, 0], rotationEuler: [-14, 0, 0] },
        'audio/AudioListener': {},
      },
    },
    {
      name: 'orbiter',
      components: {
        'core/Transform': { translation: [0, 0.8, -ORBIT_RADIUS] },
        'audio/AudioSource': { clip: { path: HUM }, bus: 'orbiter', loop: true, volume: 1 },
      },
    },
    {
      name: 'beacon',
      components: {
        'core/Transform': { translation: [5, 0.6, -8] },
        'audio/AudioSource': {
          clip: { path: PING },
          loop: true,
          rolloff: 'linear',
          minDistance: 2,
          maxDistance: 25,
          volume: 0.6,
        },
      },
    },
    {
      name: 'music',
      components: {
        'core/Transform': {},
        'audio/AudioSource': {
          clip: { path: PAD },
          bus: 'music',
          loop: true,
          spatial: false,
          volume: 0.5,
        },
      },
    },
  ],
}

// --- motion (both apps) --------------------------------------------------------------------------

interface ClockValue {
  t: number
  paused: boolean
  orbiter: Entity | undefined
  beacon: Entity | undefined
}

const DemoClock = defineResource<ClockValue>('audio-demo/Clock', {
  init: () => ({ t: 0, paused: false, orbiter: undefined, beacon: undefined }),
})

/** The orbiter circles the listener every 8 s; the beacon drifts from 7 m out past 25 m and back. */
const move = defineSystem({
  name: 'audio-demo/move',
  run: (_, world) => {
    const clock = world.resource(DemoClock)
    if (clock.orbiter === undefined) return
    if (!clock.paused) clock.t += world.resource(Time).delta
    const a = (clock.t / 8) * 2 * Math.PI
    const o = world.get(clock.orbiter, Transform).translation
    o[0] = ORBIT_RADIUS * Math.sin(a)
    o[1] = 0.8
    o[2] = -ORBIT_RADIUS * Math.cos(a)
    world.set(clock.orbiter, Transform, { translation: o })
    const b = world.get(clock.beacon!, Transform).translation
    b[2] = -(22 - 15 * Math.cos((clock.t / 16) * 2 * Math.PI))
    world.set(clock.beacon!, Transform, { translation: b })
  },
})

async function loadAudioScene(world: World, platform: Platform): Promise<void> {
  await assetServer(world)
    .configure({ platform, roots: ['assets'] })
    .scan()
  loadScene(world, scene, { id: 'audio' })
  await whenSceneReady(world, 'audio')
  const clock = world.resource(DemoClock)
  clock.orbiter = findEntityByPath(world, 'orbiter')
  clock.beacon = findEntityByPath(world, 'beacon')
}

// --- the demo ------------------------------------------------------------------------------------

let backend: WebAudioBackend | undefined
/** The Web Audio backend (one AudioContext for the page). */
export function webAudio(): WebAudioBackend {
  backend ??= createWebAudioBackend()
  return backend
}

interface Meter {
  left: AnalyserNode
  right: AnalyserNode
  buffer: Float32Array<ArrayBuffer>
  /** RMS of the orbiter's clip, to turn output level back into gain. */
  clipRms: number
}

function meterBus(web: WebAudioBackend, bus: string, clipRms: number): Meter {
  const ctx = web.context
  const split = ctx.createChannelSplitter(2)
  const left = ctx.createAnalyser()
  const right = ctx.createAnalyser()
  left.fftSize = right.fftSize = 8192
  web.busNode(bus).connect(split)
  split.connect(left, 0)
  split.connect(right, 1)
  return { left, right, buffer: new Float32Array(8192), clipRms }
}

function level(node: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  node.getFloatTimeDomainData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!
  return Math.sqrt(sum / buffer.length)
}

const fmt = (x: number, digits = 3) => (x >= 0 ? ' ' : '') + x.toFixed(digits)

/**
 * Audio: a hum orbiting the listener (it pans around your head), a beacon drifting past a linear
 * maxDistance (it goes virtual and comes back in step), streamed music ducked under a radio line,
 * bursts of 100 laser shots held to 8 voices, and bus mutes. The same scene runs in a headless app
 * next to it; the HUD shows audio.describe from both and the level measured off the Web Audio graph.
 */
export const audioDemoPlugin = definePlugin({
  name: 'audio-demo',
  dependencies: ['scene', 'audio'],
  build(app) {
    app.world.initResource(DemoClock)
    app.addSystems(Update, move)
  },
  async ready(app: App) {
    const world = app.world
    const web = webAudio()
    world.resource(AmbientLight).brightness = 500
    world.spawn(
      [DirectionalLight, { illuminance: 20_000 }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.4, 0) as never }],
    )

    // The project folder: four synthesized WAVs and star-explorer's Ogg Vorbis laser.
    const platform = memoryPlatform()
    const humSamples = hum()
    await platform.fs.writeBytes(HUM, wav(humSamples))
    await platform.fs.writeBytes(PING, wav(ping()))
    await platform.fs.writeBytes(LINE, wav(line()))
    await platform.fs.writeBytes(PAD, wav(pad()))
    await platform.fs.writeBytes(LASER, new Uint8Array(await (await fetch(laserUrl)).arrayBuffer()))

    // The headless mirror: the same scene and motion, with the backend that records voices.
    const mirror = new App().addPlugin(TransformPlugin, ScenePlugin, audioPlugin())
    mirror.world.initResource(DemoClock)
    mirror.addSystems(Update, move)
    await mirror.init()
    await Promise.all([loadAudioScene(world, platform), loadAudioScene(mirror.world, platform)])
    app.addSystems(
      Last,
      defineSystem({
        name: 'audio-demo/step-mirror',
        run: (_, w) => mirror.update(w.resource(Time).delta),
      }),
    )
    const both = [world, mirror.world]

    // What you see: the camera on the listener, a glowing orbiter, its ring, the beacon.
    const clock = world.resource(DemoClock)
    const camera = findEntityByPath(world, 'camera')!
    world.add(camera, Camera3d, { fovY: 75, clearColor: [0.02, 0.025, 0.035, 1] })
    world.add(camera, Exposure, { ev100: 12.5 })
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const glow = (color: [number, number, number], lum: number) =>
      materials.add(
        new MaterialAsset({
          baseColor: [...color, 1],
          emissive: [...color, 1],
          emissiveLuminance: lum,
        }),
      )
    // Material first: the render slot is made when Mesh3d arrives.
    world.add(clock.orbiter!, MeshMaterial, { material: glow([1, 0.55, 0.2], 40_000) })
    world.add(clock.orbiter!, Mesh3d, { mesh: meshes.add(sphere({ radius: 0.45 })) })
    const beaconOn = glow([0.3, 0.8, 1], 30_000)
    const beaconOff = glow([0.15, 0.17, 0.2], 0)
    world.add(clock.beacon!, MeshMaterial, { material: beaconOn })
    world.add(clock.beacon!, Mesh3d, { mesh: meshes.add(sphere({ radius: 0.35 })) })
    world.spawn(
      [
        Mesh3d,
        { mesh: meshes.add(torus({ radius: ORBIT_RADIUS, tube: 0.03, tubularSegments: 128 })) },
      ],
      [MeshMaterial, { material: glow([0.5, 0.3, 0.15], 2_000) }],
      [Transform, { translation: [0, 0.8, 0] }],
    )

    const meter = meterBus(web, 'orbiter', rms(humSamples))
    let note = ''
    const shots = Array.from({ length: 100 }, (_, i) => ({
      position: [Math.sin(i * 2.4) * 12, 1 + (i % 5), -4 - (i % 17)] as [number, number, number],
      priority: (i * 37) % 256,
    }))
    const actions: Record<string, () => void> = {
      start: () => {
        void web.resume()
        note = 'resumed the AudioContext'
      },
      mute: () => {
        const muted = !(world.resource(AudioBuses).sfx?.muted ?? false)
        for (const w of both) setBus(w, 'sfx', { muted })
        note = muted ? 'muted sfx: orbiter, beacon, lasers go to 0; music plays on' : 'unmuted sfx'
      },
      line: () => {
        for (const w of both) playSound(w, LINE, { bus: 'voice' })
        note = 'radio line on the voice bus: music ducks by 0.7, back over 0.6 s after it ends'
      },
      burst: () => {
        for (const w of both) for (const s of shots) playSound(w, LASER, { ...s, volume: 0.5 })
        note = '100 laser.ogg one-shots in one frame: 8 keep a voice (highest priority), 92 dropped'
      },
      hrtf: () => {
        for (const w of both) {
          const e = w.resource(DemoClock).orbiter!
          const s = w.get(e, AudioSource)
          w.set(e, AudioSource, { ...s, panning: s.panning === 'hrtf' ? 'equal-power' : 'hrtf' })
        }
        note = `orbiter panning: ${world.get(clock.orbiter!, AudioSource).panning}`
      },
      pause: () => {
        for (const w of both) {
          const c = w.resource(DemoClock)
          c.paused = !c.paused
        }
        note = clock.paused ? 'orbit paused' : 'orbit running'
      },
    }
    for (const w of both) duck(w, 'music', { by: 0.7, attack: 0.15, release: 0.6 })
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-audio]')) {
      button.addEventListener('click', () => actions[button.dataset.audio!]?.())
    }
    window.addEventListener('keydown', (event) => {
      const key = ['start', 'mute', 'line', 'burst', 'hrtf', 'pause'][
        ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(event.code)
      ]
      if (key) actions[key]!()
    })

    let beaconShown = true
    hudExtras.push((w) => {
      const d = describeAudio(w)
      const h = describeAudio(mirror.world)
      const find = (desc: typeof d, path: string) => desc.voices.find((v) => v.path === path)
      const o = find(d, 'orbiter')
      const ho = find(h, 'orbiter')
      const b = find(d, 'beacon')
      const beaconLive = b?.state === 'active'
      if (beaconLive !== beaconShown) {
        beaconShown = beaconLive
        w.set(clock.beacon!, MeshMaterial, { material: beaconLive ? beaconOn : beaconOff })
      }
      const L = level(meter.left, meter.buffer)
      const R = level(meter.right, meter.buffer)
      const measuredGain = Math.sqrt(L * L + R * R) / meter.clipRms
      const measuredPan = (Math.atan2(R, L) * 4) / Math.PI - 1
      const running = d.context === 'running'
      const hrtf = w.get(clock.orbiter!, AudioSource).panning === 'hrtf'
      const bus = (name: string) => d.buses.find((x) => x.name === name)!
      const lasers = d.voices.filter((v) => v.clip === LASER)
      return [
        '',
        `audio  ${d.backend} · context ${d.context}${running ? '' : '  ← click the page or press 1'}`,
        `voices ${d.counts.active} active, ${d.counts.virtual} virtual, ${d.counts.pending} pending · limit ${d.counts.maxVoices} (${d.counts.maxVoicesPerClip}/clip) · dropped ${d.counts.dropped}`,
        '',
        '                    gain     pan',
        `orbiter  web       ${o ? `${fmt(o.gain)}  ${fmt(o.pan)}` : '-'}   audio.describe`,
        `         headless  ${ho ? `${fmt(ho.gain)}  ${fmt(ho.pan)}` : '-'}   same scene, recorded`,
        `         measured  ${running ? `${fmt(measuredGain)}  ${hrtf ? '  hrtf' : fmt(measuredPan)}` : '(context suspended)'}   off the Web Audio graph`,
        `beacon   ${b ? `${b.distance?.toFixed(1).padStart(5)} m  ${b.state.padEnd(7)} gain ${b.gain.toFixed(3)}` : '-'}  (linear: silent past 25 m)`,
        `music    stream · bus gain ${bus('music').gain.toFixed(2)} (duck ${bus('music').ducked.toFixed(2)})`,
        `sfx      ${bus('sfx').muted ? 'muted' : 'on'} · lasers ${lasers.length} voices`,
        note ? `> ${note}` : '',
        '1 start audio · 2 mute sfx · 3 radio line · 4 100 lasers · 5 hrtf · 6 pause orbit',
      ]
    })

    Object.assign(globalThis, {
      audio: {
        web: () => describeAudio(world),
        headless: () => describeAudio(mirror.world),
        backend: web,
        actions,
      },
    })
  },
})
