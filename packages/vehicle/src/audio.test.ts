import { assetServer } from '@aethervtt/shard-assets'
import {
  AudioClips,
  AudioEvent,
  audioClip,
  audioEvents,
  audioEventsPlugin,
  audioPlugin,
  HeadlessAudioBackend,
  prepareAudio,
} from '@aethervtt/shard-audio'
import type { AssetRef, World } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import { VehicleAudio, vehicleAudioPlugin } from './audio'
import { VehicleState } from './components'
import { drive, frames, ground, spawnCar, vehicleApp } from './testing'

/** A short silent 16-bit WAV. */
function wav(seconds: number): Uint8Array {
  const frames = Math.round(8000 * seconds)
  const out = new Uint8Array(44 + frames * 2)
  const view = new DataView(out.buffer)
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + frames * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, frames * 2, true)
  return out
}

async function setup(surface?: 'gravel') {
  const backend = new HeadlessAudioBackend()
  const app = await vehicleApp([
    audioPlugin({ backend }),
    audioEventsPlugin(),
    vehicleAudioPlugin(),
  ])
  const world = app.world
  ground(world, { surface })
  const clip = world.resource(AudioClips).add(audioClip(wav(1), { id: 'loop' }))
  const choices = [{ clip: { guid: clip.guid } }]
  const engine = AudioEvent.deserialize({
    mode: 'sustain',
    parameters: [
      { name: 'rpm', min: 0, max: 10000, initial: 0 },
      { name: 'load', min: -1, max: 1, initial: 0 },
      { name: 'throttle', min: 0, max: 1, initial: 0 },
      { name: 'gear', kind: 'discrete', min: -1, max: 8, initial: 0 },
    ],
    layers: [{ id: 'on', loop: true, choices }],
  })
  const tires = AudioEvent.deserialize({
    mode: 'sustain',
    parameters: [
      { name: 'slip', min: 0, max: 1, initial: 0 },
      { name: 'rollSpeed', min: 0, max: 100, initial: 0 },
      { name: 'surface', kind: 'label', labels: ['asphalt', 'gravel', 'snow'], initial: 0 },
    ],
    layers: [
      { id: 'roll', loop: true, choices },
      {
        id: 'skid',
        loop: true,
        choices,
        trigger: 'while',
        condition: { parameter: 'slip', min: 0.3, max: 1, label: '' },
      },
    ],
  })
  const shift = AudioEvent.deserialize({ layers: [{ id: 'clunk', choices }] })
  // Inline definitions as virtual assets, so the component can name them.
  const server = assetServer(world)
  const store = world.initResource(AudioEvent.store)
  const refs: Record<string, AssetRef<'audio/AudioEvent'>> = {}
  for (const [name, def] of Object.entries({ engine, tires, shift })) {
    const guid = `test:${name}`
    const path = `test/${name}.audio-event.json`
    store.set(guid, def as never)
    server.virtual(guid, path, AudioEvent.type.name, () => def)
    refs[name] = { type: 'audio/AudioEvent', guid, path }
  }
  // Prepared up front, as a game would before driving: playing then starts at once.
  await Promise.all(Object.values(refs).map((r) => prepareAudio(world, r)))
  const car = spawnCar(world)
  return { app, world, car, backend, engine, tires, shift, refs }
}

/** Instances of an event that are running (by the layer ids it was defined with). */
function running(world: World, definition: { layers: { id: string }[] }) {
  const key = definition.layers.map((l) => l.id).join(',')
  return audioEvents(world).instances.filter(
    (i) => i && i.state !== 'ended' && i.definition?.layers.map((l) => l.id).join(',') === key,
  )
}

describe('vehicle audio', () => {
  it('feeds the engine its rpm, plays one shift per shift, and opens the skid on locked wheels', async () => {
    const { app, world, car, engine, tires, shift, refs } = await setup()
    world.add(car.chassis, VehicleAudio, {
      engine: refs.engine!,
      tires: refs.tires!,
      shift: refs.shift!,
    })
    frames(app, 30)
    drive(world, car.chassis, { throttle: 1 })
    let shifts = 0
    let seen = new Set<number>()
    for (let i = 0; i < 60 * 8; i++) {
      frames(app, 1)
      const inst = running(world, engine)[0]
      expect(inst).toBeDefined()
      const rpm = world.get(car.chassis, VehicleState).rpm
      const index = inst!.parameters!.indices.get('rpm')!
      expect(inst!.parameters!.targets[index]!).toBeCloseTo(rpm, 1)
      for (const s of running(world, shift)) {
        if (!seen.has(s!.id)) shifts++
        seen.add(s!.id)
      }
    }
    seen = new Set()
    const shiftsSeen = shifts
    expect(shiftsSeen).toBeGreaterThanOrEqual(1)
    // Lock the wheels: the front tires' skid layers open.
    drive(world, car.chassis, { brake: 1 })
    let skid = false
    for (let i = 0; i < 40; i++) {
      frames(app, 1)
      for (const inst of running(world, tires)) if (inst!.layers[1]!.gate) skid = true
    }
    expect(skid).toBe(true)
    app.dispose()
  })

  it('switches the tire surface label on gravel', async () => {
    const { app, world, car, tires, refs } = await setup('gravel')
    world.add(car.chassis, VehicleAudio, { engine: refs.engine!, tires: refs.tires! })
    frames(app, 30)
    drive(world, car.chassis, { throttle: 0.5 })
    frames(app, 30)
    const inst = running(world, tires)[0]!
    const index = inst!.parameters!.indices.get('surface')!
    expect(inst!.parameters!.targets[index]).toBe(1)
    app.dispose()
  })
})
