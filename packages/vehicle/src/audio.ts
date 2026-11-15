/**
 * Vehicle audio (0118), `@aethervtt/shard-vehicle/audio`: binds a vehicle's state and events to
 * authored audio events (0077). The engine is a sustained event at the chassis driven by `rpm`,
 * `load`, `throttle`, `gear` and `vehicleSpeed`; each wheel has a sustained tire event driven by
 * `slip`, `rollSpeed`, `sinkage` and a labeled `surface`; one-shots play on shifts, starts, stops,
 * stalls, backfires, bottoming out, landings and hits (with `impact`). `speed` and `distance` are
 * the audio runtime's own listener inputs, so the vehicle's have other names. An event gets the parameters it
 * declares and no others. Needs audioPlugin and audioEventsPlugin.
 */
import {
  type AudioEventInstance,
  type AudioEventRef,
  audioEvents,
  playAudioEvent,
  stopAudioEvent,
} from '@aethervtt/shard-audio'
import {
  type AssetRef,
  defineComponent,
  defineSystem,
  type Entity,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { Surfaces } from '@aethervtt/shard-physics'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import {
  VehicleEngineEvent,
  VehicleHitEvent,
  VehicleLandedEvent,
  VehicleShiftEvent,
  VehicleWheelEvent,
} from './components'
import { VehicleSimsResource } from './sims'

const event = (description: string) => t.handle('audio/AudioEvent', { description })

export const VehicleAudio = defineComponent(
  'vehicle/VehicleAudio',
  {
    engine: event(
      'Sustained, at the chassis. Parameters it may declare: rpm (rpm), load (−1 engine braking … 1 full power: crossfade on-load and off-load loops on it), throttle (0–1), gear (−1…), vehicleSpeed (m/s).',
    ),
    tires: event(
      'Sustained, one per wheel. Parameters: slip (0 rolling … 1 sliding: the skid loop), rollSpeed (m/s: the rolling loop), sinkage (m), surface (a label: the ground’s surface name, e.g. asphalt, gravel, snow).',
    ),
    shift: event('One-shot on a gear change. Parameters: gear (the new one).'),
    start: event('One-shot when the engine starts.'),
    stop: event('One-shot when the engine is switched off.'),
    stall: event('One-shot when the engine stalls.'),
    backfire: event('One-shot on a backfire (lifting off at high rpm).'),
    bottomOut: event('One-shot at a wheel hitting its bump stop. Parameters: impact (m/s).'),
    land: event('One-shot when the vehicle lands. Parameters: impact (m/s down), airTime (s).'),
    hit: event('One-shot when the vehicle hits a character. Parameters: impact (m/s closing).'),
  },
  { description: 'Audio events for a vehicle’s engine, tires and moments (0118).' },
)

type Ref = AssetRef | null

interface Playing {
  id: number
  instance: AudioEventInstance | undefined
}

interface VehicleVoices {
  engine: Playing | undefined
  tires: (Playing | undefined)[]
}

/** One-shots waiting for their instance to admit, with the values to give it. */
interface Pending {
  id: number
  values: Record<string, number>
}

const noValues: Record<string, number> = {}

function find(world: World, id: number): AudioEventInstance | undefined {
  const list = audioEvents(world).instances
  for (let i = 0; i < list.length; i++) if (list[i]?.id === id) return list[i]!
  return undefined
}

function alive(world: World, p: Playing | undefined): boolean {
  if (!p) return false
  p.instance ??= find(world, p.id)
  return p.instance !== undefined && p.instance.state !== 'ended' && p.instance.state !== 'failed'
}

/** Sets a parameter the instance declares; labels must be one of its labels. */
function set(inst: AudioEventInstance | undefined, name: string, value: number | string): void {
  const bank = inst?.parameters
  if (!bank) return
  const index = bank.indices.get(name)
  if (index === undefined) return
  const def = bank.definitions[index]!
  if (def.readonly) return
  if (def.kind === 'label') {
    if (typeof value !== 'string' || !def.labels.includes(value)) return
  } else if (typeof value !== 'number' || !Number.isFinite(value)) return
  bank.set(name, value)
}

function play(world: World, ref: Ref, entity: Entity): number | undefined {
  if (!ref || (ref.guid === undefined && ref.path === undefined)) return undefined
  try {
    return playAudioEvent(world, ref as AudioEventRef, { entity })
  } catch {
    // Capacity, a missing asset: the vehicle drives on silently.
    return undefined
  }
}

/** Vehicle audio: engine and tire loops, one-shots on events. Update, after the fixed steps. */
export const vehicleAudioSystem = defineSystem({
  name: 'vehicle/audio',
  description: 'Drives vehicles’ engine and tire audio events and plays their one-shots.',
  setup: (world) => ({
    voices: new Map<Entity, VehicleVoices>(),
    pending: [] as Pending[],
    shifts: world.reader(VehicleShiftEvent),
    engines: world.reader(VehicleEngineEvent),
    wheels: world.reader(VehicleWheelEvent),
    landings: world.reader(VehicleLandedEvent),
    hits: world.reader(VehicleHitEvent),
  }),
  run: (s, world) => {
    if (!world.tryResource(VehicleSimsResource)) return
    const sims = world.resource(VehicleSimsResource).sims
    const names = world.tryResource(Surfaces)?.names
    const oneShot = (
      vehicle: Entity,
      key: keyof typeof VehicleAudio.fields,
      at: Entity,
      values: Record<string, number>,
    ) => {
      if (!world.isAlive(vehicle) || !world.has(vehicle, VehicleAudio)) return
      const ref = world.get(vehicle, VehicleAudio)[key] as Ref
      const id = play(world, ref, world.isAlive(at) ? at : vehicle)
      if (id !== undefined && values !== noValues) s.pending.push({ id, values })
    }
    for (const e of s.shifts.read()) oneShot(e.vehicle, 'shift', e.vehicle, { gear: e.to })
    for (const e of s.engines.read()) {
      const key =
        e.kind === 'started'
          ? 'start'
          : e.kind === 'stopped'
            ? 'stop'
            : e.kind === 'stalled'
              ? 'stall'
              : 'backfire'
      oneShot(e.vehicle, key, e.vehicle, noValues)
    }
    for (const e of s.wheels.read())
      if (e.kind === 'bottom-out') oneShot(e.vehicle, 'bottomOut', e.wheel, { impact: e.speed })
    for (const e of s.landings.read())
      oneShot(e.vehicle, 'land', e.vehicle, { impact: e.speed, airTime: e.airTime })
    for (const e of s.hits.read()) oneShot(e.vehicle, 'hit', e.vehicle, { impact: e.speed })
    // One-shots get their values once admitted (an event's bank exists from then).
    for (let i = s.pending.length - 1; i >= 0; i--) {
      const p = s.pending[i]!
      const inst = find(world, p.id)
      if (!inst || inst.state === 'ended' || inst.state === 'failed') {
        s.pending.splice(i, 1)
        continue
      }
      if (!inst.parameters) continue
      for (const name in p.values) set(inst, name, p.values[name]!)
      s.pending.splice(i, 1)
    }

    // Vehicles gone or without audio now: stop what they were playing.
    for (const [vehicle, v] of s.voices) {
      if (world.isAlive(vehicle) && world.has(vehicle, VehicleAudio) && sims.has(vehicle)) continue
      if (v.engine && alive(world, v.engine)) stopAudioEvent(world, v.engine.id, { release: 0.1 })
      for (const p of v.tires)
        if (p && alive(world, p)) stopAudioEvent(world, p.id, { release: 0.1 })
      s.voices.delete(vehicle)
    }

    for (const sim of sims.values()) {
      const vehicle = sim.entity
      if (!sim.ok || !world.isAlive(vehicle) || !world.has(vehicle, VehicleAudio)) continue
      const refs = world.get(vehicle, VehicleAudio)
      let v = s.voices.get(vehicle)
      if (!v) {
        v = { engine: undefined, tires: [] }
        s.voices.set(vehicle, v)
      }
      // Engine: plays while it runs.
      if (sim.engine && refs.engine) {
        if (sim.running && !alive(world, v.engine)) {
          const id = play(world, refs.engine, vehicle)
          v.engine = id === undefined ? undefined : { id, instance: undefined }
        } else if (!sim.running && v.engine && alive(world, v.engine)) {
          stopAudioEvent(world, v.engine.id, { release: 0.3 })
          v.engine = undefined
        }
        if (v.engine && alive(world, v.engine)) {
          const inst = v.engine.instance
          set(inst, 'rpm', sim.omegaE * (60 / (2 * Math.PI)))
          set(inst, 'load', sim.load)
          set(inst, 'throttle', sim.throttle)
          set(inst, 'gear', sim.shiftLeft > 0 ? 0 : sim.gear)
          set(inst, 'vehicleSpeed', Math.abs(sim.speed))
        }
      }
      // Tires: one loop per wheel.
      if (refs.tires) {
        for (let i = 0; i < sim.wheels.length; i++) {
          const wh = sim.wheels[i]!
          let p = v.tires[i]
          if (!alive(world, p)) {
            const id = play(world, refs.tires, wh.entity)
            p = id === undefined ? undefined : { id, instance: undefined }
            v.tires[i] = p
          }
          if (!p || !alive(world, p)) continue
          const inst = p.instance
          set(inst, 'slip', wh.grounded ? wh.skid : 0)
          set(inst, 'rollSpeed', wh.grounded ? Math.abs(wh.omega * wh.radius) : 0)
          set(inst, 'sinkage', wh.grounded ? wh.sinkage : 0)
          if (names && wh.grounded) set(inst, 'surface', names[wh.surface] ?? 'asphalt')
        }
      }
    }
  },
})

/** Vehicle audio (0118): VehicleAudio and its system. Needs vehiclePlugin and audio events. */
export function vehicleAudioPlugin(): Plugin {
  return definePlugin({
    name: 'vehicle/audio',
    provides: [{ VehicleAudio }],
    dependencies: ['vehicle', 'audio/events'],
    build(app) {
      app.addSystems(Update, vehicleAudioSystem)
    },
  })
}
