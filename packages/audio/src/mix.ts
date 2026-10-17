import { assetServer, defineDataType } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  defineSystem,
  type Infer,
  PostUpdate,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import type { AudioBusDesc, AudioEffectDesc, AudioMixerGraph } from '@aethervtt/shard-platform'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { type AudioClipAsset, AudioClips } from './clip'
import { AudioBuses, AudioUserControls } from './components'
import { acquireAudioGlobals, audioEvents, releaseAudioGlobals } from './events'
import { AudioInspectors } from './inspection'
import { audioMixMethods } from './mix-methods'
import { audioState, updateAudio } from './mixer'
import { type AudioParameterBank, sampleAudioCurve, validateCurve } from './parameters'
import { AudioPreviewPlan } from './preview'
import { audioNumber } from './validation'

export const AudioEffectFields = {
  id: t.string({ required: true }),
  kind: t.enum(['lowpass', 'highpass', 'peaking', 'compressor', 'delay', 'reverb']),
  frequency: t.f64({ default: 20000, min: 10, max: 24000, unit: 'Hz' }),
  q: t.f64({ default: Math.SQRT1_2, min: 0.0001, max: 100 }),
  gainDb: t.f64({ min: -60, max: 24, unit: 'dB' }),
  threshold: t.f64({ default: -24, min: -100, max: 0, unit: 'dB' }),
  ratio: t.f64({ default: 4, min: 1, max: 20 }),
  attack: t.f64({ default: 0.003, min: 0, max: 1, unit: 's' }),
  release: t.f64({ default: 0.25, min: 0, max: 1, unit: 's' }),
  seconds: t.f64({ default: 0.2, min: 0, max: 10, unit: 's' }),
  feedback: t.f64({ default: 0.3, min: -0.99, max: 0.99 }),
  tailSeconds: t.f64({ default: 2, min: 0.01, max: 10, unit: 's' }),
  ir: t.handle('AudioClip'),
}
export const AudioMixer = defineDataType(
  'audio/AudioMixer',
  {
    globals: t.handle('audio/AudioParameters'),
    curves: t.list(
      t.struct({
        bus: t.string({ required: true }),
        field: t.string({ default: 'gainDb' }),
        parameter: t.string({ required: true }),
        points: t.list(t.vec2),
      }),
    ),
    buses: t.list(
      t.struct({
        id: t.string({ required: true }),
        parent: t.string({ default: 'master' }),
        gainDb: t.f64({ min: -120, max: 24 }),
        return: t.bool(),
        effects: t.list(t.struct(AudioEffectFields)),
        sends: t.list(
          t.struct({
            target: t.string({ required: true }),
            gainDb: t.f64({ min: -120, max: 24 }),
            pre: t.bool(),
          }),
        ),
      }),
    ),
  },
  {
    extension: 'audio-mixer',
    lazyDependencies: true,
    validate: (value) => validateAudioMixer(value as AudioMixerDefinition),
  },
)
export type AudioMixerDefinition = Infer<typeof AudioMixer>

export function validateAudioMixer(value: AudioMixerDefinition): void {
  if (!value.buses.length || value.buses.length > 64)
    throw new ShardError('audio/mixer-capacity', 'Mixer requires 1–64 buses', { path: '/buses' })
  if (value.curves.length && !value.globals)
    throw new ShardError('audio/unknown-parameter', 'Mixer curves require a global parameter asset')
  for (const curve of value.curves) validateCurve(curve.points, '/curves')
  const buses = new Map<string, AudioMixerDefinition['buses'][number]>()
  let effects = 0,
    sends = 0
  for (let i = 0; i < value.buses.length; i++) {
    const bus = value.buses[i]!,
      path = `/buses/${i}`
    if (!bus.id || buses.has(bus.id) || bus.id.includes('/'))
      throw new ShardError(
        'audio/invalid-effect',
        'Bus IDs must be unique, nonempty and contain no slash',
        { path },
      )
    buses.set(bus.id, bus)
    effects += bus.effects.length
    sends += bus.sends.length
    const names = new Set<string>()
    for (let e = 0; e < bus.effects.length; e++) {
      const effect = bus.effects[e]!
      if (!effect.id || effect.id.includes('/') || names.has(effect.id))
        throw new ShardError('audio/invalid-effect', 'Effect IDs must be unique within a bus', {
          path: `${path}/effects/${e}`,
        })
      names.add(effect.id)
      if (effect.kind === 'reverb' && !effect.ir)
        throw new ShardError('audio/invalid-effect', 'Reverb needs an impulse response', {
          path: `${path}/effects/${e}/ir`,
        })
    }
    const destinations = new Set<string>()
    for (const send of bus.sends) {
      if (destinations.has(send.target))
        throw new ShardError('audio/invalid-effect', 'Duplicate send target', {
          path: `${path}/sends`,
        })
      destinations.add(send.target)
    }
  }
  if (effects > 128 || sends > 128)
    throw new ShardError('audio/mixer-capacity', 'Mixer exceeds 128 effects or sends')
  const master = buses.get('master')
  if (
    !master ||
    master.parent ||
    master.return ||
    master.sends.length ||
    master.effects.some((e) => e.kind === 'delay' || e.kind === 'reverb')
  ) {
    throw new ShardError(
      'audio/invalid-effect',
      'Master must be an ordinary root without sends or wet effects',
      { path: '/buses' },
    )
  }
  const visited = new Set<string>(),
    visiting = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new ShardError('audio/mixer-cycle', `Routing cycle at ${id}`, { path: `/buses/${id}` })
    if (visited.has(id)) return
    const bus = buses.get(id)
    if (!bus)
      throw new ShardError('audio/unknown-bus', `Unknown bus ${id}`, { path: `/buses/${id}` })
    visiting.add(id)
    if (bus.parent) {
      const parent = buses.get(bus.parent)
      if (!parent || (bus.return ? parent.id !== 'master' && !parent.return : parent.return))
        throw new ShardError('audio/unknown-bus', `Invalid parent ${bus.parent}`, {
          path: `/buses/${id}/parent`,
        })
      visit(bus.parent)
    } else if (id !== 'master')
      throw new ShardError('audio/unknown-bus', 'Only master can be a root', {
        path: `/buses/${id}/parent`,
      })
    for (const send of bus.sends) {
      if (!buses.get(send.target)?.return)
        throw new ShardError('audio/unknown-bus', `Send ${send.target} must target a return`, {
          path: `/buses/${id}/sends`,
        })
      visit(send.target)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of buses.keys()) visit(id)
}

export const AudioSnapshot = defineDataType(
  'audio/AudioSnapshot',
  {
    priority: t.i32(),
    attack: t.f64({ default: 0.1, min: 0 }),
    release: t.f64({ default: 0.2, min: 0 }),
    targets: t.list(
      t.struct({
        bus: t.string({ required: true }),
        field: t.string({ default: 'gainDb' }),
        mode: t.enum(['override', 'offset']),
        value: t.f64(),
      }),
    ),
  },
  {
    extension: 'audio-snapshot',
    validate(value) {
      const snapshot = value as AudioSnapshotDefinition
      const seen = new Set<string>()
      for (const target of snapshot.targets) {
        const key = `${target.bus}/${target.field}`
        if (
          seen.has(key) ||
          (target.mode === 'offset' &&
            target.field !== 'gainDb' &&
            !target.field.endsWith('/gainDb'))
        ) {
          throw new ShardError(
            'audio/invalid-snapshot',
            'Duplicate target or unsupported offset unit',
            { path: `/targets/${key}` },
          )
        }
        seen.add(key)
      }
    },
  },
)
export type AudioSnapshotDefinition = Infer<typeof AudioSnapshot>
export interface MixField {
  min: number
  max: number
  sendTarget: string
  factor: number
  bus: string
  field: string
  base: number
  value: number
  sent: number
  logarithmic: boolean
  linearGain: boolean
}
interface SnapshotHandle {
  id: number
  key: string
  definition: AudioSnapshotDefinition
  indices: Int32Array
  weight: number
  from: number
  elapsed: number
  target: number
  removing: boolean
}
export interface AudioMixStateValue {
  definition: AudioMixerDefinition | null
  graph: AudioMixerGraph | null
  fields: MixField[]
  snapshots: SnapshotHandle[]
  nextId: number
  revision: number
  maxNodes: number
  userSent: Float64Array
  globals: AudioParameterBank | null
  globalKey: string
  curves: { field: number; parameter: number; points: Float64Array }[]
  scratch: Float64Array
}
export const AudioMixState = defineResource<AudioMixStateValue>('audio/MixState')

async function loadData<T>(
  world: World,
  ref: AssetRef | string,
  type: { store: Parameters<World['initResource']>[0] },
): Promise<T> {
  const server = assetServer(world)
  const resolved = typeof ref === 'string' ? (server.resolve(ref) ?? (await server.load(ref))) : ref
  const store = world.initResource(type.store) as { get(ref: unknown): unknown }
  if (!store.get(resolved)) await server.load(ref)
  const value = store.get(typeof ref === 'string' ? server.resolve(ref) : ref)
  if (!value)
    throw new ShardError(
      'audio/prepare-failed',
      `Cannot load audio data ${typeof ref === 'string' ? ref : (ref.path ?? ref.guid)}`,
    )
  return value as T
}

export async function configureAudioMixer(
  world: World,
  ref: AudioMixerDefinition | AssetRef | string,
): Promise<void> {
  const state = world.resource(AudioMixState),
    runtime = audioState(world).backend.runtime!
  const source =
    typeof ref === 'object' && 'buses' in ref
      ? ref
      : await loadData<AudioMixerDefinition>(world, ref, AudioMixer)
  const definition = AudioMixer.deserialize(AudioMixer.serialize(source))
  validateAudioMixer(definition)
  const revision = ++state.revision,
    buses: AudioBusDesc[] = [],
    fields: MixField[] = []
  const addField = (bus: string, field: string, base: number, linearGain = false) =>
    fields.push({
      min:
        field === 'gainDb' || field.startsWith('send/')
          ? -120
          : ((AudioEffectFields[
              field.split('/').at(-1)! as keyof typeof AudioEffectFields
            ]?.jsonSchema().minimum as number | undefined) ?? -Number.MAX_VALUE),
      max:
        field === 'gainDb' || field.startsWith('send/')
          ? 24
          : ((AudioEffectFields[
              field.split('/').at(-1)! as keyof typeof AudioEffectFields
            ]?.jsonSchema().maximum as number | undefined) ?? Number.MAX_VALUE),
      sendTarget: field.startsWith('send/') ? field.slice(5) : '',
      factor: 1,
      bus,
      field,
      base,
      value: base,
      sent: Number.NaN,
      logarithmic: field.endsWith('/frequency'),
      linearGain,
    })
  for (const bus of definition.buses) {
    const effects: AudioEffectDesc[] = []
    addField(bus.id, 'gainDb', bus.gainDb, true)
    for (const effect of bus.effects) {
      let ir: AudioClipAsset | undefined
      if (effect.ir) {
        const store = world.resource(AudioClips)
        if (!store.get(effect.ir)) await assetServer(world).load(effect.ir)
        ir = store.get(effect.ir)
        if (!ir || ir.stream)
          throw new ShardError('audio/invalid-effect', 'Reverb requires a decoded impulse response')
      }
      effects.push({ ...effect, ir: ir ?? undefined })
      const names =
        effect.kind === 'compressor'
          ? ['threshold', 'ratio', 'attack', 'release']
          : effect.kind === 'delay'
            ? ['seconds', 'feedback']
            : effect.kind === 'reverb'
              ? []
              : ['frequency', 'q', 'gainDb']
      for (const name of names)
        addField(bus.id, `${effect.id}/${name}`, effect[name as keyof typeof effect] as number)
    }
    for (const send of bus.sends) addField(bus.id, `send/${send.target}`, send.gainDb, true)
    buses.push({
      id: bus.id,
      parent: bus.parent,
      return: bus.return,
      effects,
      gain:
        10 ** (bus.gainDb / 20) *
        (world.resource(AudioBuses)[bus.id]?.volume ?? 1) *
        (audioState(world).duckLevels.get(bus.id) ?? 1),
      userGain:
        world.resource(AudioUserControls)[bus.id]?.muted ||
        world.resource(AudioBuses)[bus.id]?.muted
          ? 0
          : (world.resource(AudioUserControls)[bus.id]?.volume ?? 1),
      sends: bus.sends.map((send) => ({
        target: send.target,
        gain: 10 ** (send.gainDb / 20),
        pre: send.pre,
      })),
    })
  }
  // Validate snapshot destinations before committing a topology edit.
  const mappings = state.snapshots.map((handle) => snapshotIndices(handle.definition, fields))
  const shared = definition.globals ? await acquireAudioGlobals(world, definition.globals) : null
  let curves: AudioMixStateValue['curves']
  try {
    curves = definition.curves.map((curve) => {
      const index = fields.findIndex(
        (field) => field.bus === curve.bus && field.field === curve.field,
      )
      if (index < 0)
        throw new ShardError('audio/invalid-effect', 'Unknown mixer curve target', {
          path: '/curves',
        })
      for (const point of curve.points)
        audioNumber(point[1]!, '/curves/points', fields[index]!.min, fields[index]!.max)
      return {
        field: index,
        parameter: shared!.bank.index(curve.parameter),
        points: new Float64Array(curve.points.flat()),
      }
    })
    // Virtual/paused layers must retain their routes too: they have no native voice to inspect.
    for (const instance of audioEvents(world).instances) {
      if (!instance || instance.state === 'ended' || instance.state === 'failed') continue
      const event = instance.plan?.definition ?? instance.definition
      if (!event) continue
      for (const layer of event.layers) {
        const route = buses.find((bus) => bus.id === (layer.bus || event.bus))
        if (
          !route ||
          layer.sends.some(
            (send) => !route.sends.some((candidate) => candidate.target === send.target),
          )
        )
          throw new ShardError(
            'audio/unknown-bus',
            'Mixer edit removes an active logical event route',
          )
      }
    }
    await runtime.configureMixer({ buses, maxNodes: state.maxNodes })
  } catch (error) {
    if (shared) releaseAudioGlobals(audioEvents(world), shared.key)
    throw error
  }
  if (revision !== state.revision) {
    if (shared) releaseAudioGlobals(audioEvents(world), shared.key)
    return
  }
  if (state.globalKey) releaseAudioGlobals(audioEvents(world), state.globalKey)
  state.globals = shared?.bank ?? null
  state.globalKey = shared?.key ?? ''
  state.curves = curves
  state.definition = definition
  state.graph = { buses, maxNodes: state.maxNodes }
  state.fields = fields
  state.userSent = new Float64Array(buses.length).fill(Number.NaN)
  for (let i = 0; i < state.snapshots.length; i++) state.snapshots[i]!.indices = mappings[i]!
  const legacy = world.resource(AudioBuses)
  for (const bus of buses)
    legacy[bus.id] = {
      volume: legacy[bus.id]?.volume ?? 1,
      muted: legacy[bus.id]?.muted ?? false,
      parent: bus.parent,
      userDomain: !bus.return,
      duck: legacy[bus.id]?.duck,
    }
  updateAudioMix(world, 0)
}

function snapshotIndices(definition: AudioSnapshotDefinition, fields: MixField[]): Int32Array {
  const indices = new Int32Array(definition.targets.length)
  for (let i = 0; i < definition.targets.length; i++) {
    const target = definition.targets[i]!,
      index = fields.findIndex((field) => field.bus === target.bus && field.field === target.field)
    if (index < 0)
      throw new ShardError(
        'audio/invalid-snapshot',
        `Unknown mixer target ${target.bus}/${target.field}`,
      )
    const field = fields[index]!
    if (target.mode === 'offset' && target.field !== 'gainDb' && !target.field.endsWith('/gainDb'))
      throw new ShardError('audio/invalid-snapshot', 'Offsets require dB units')
    if (
      definition.targets.some(
        (other, j) => j < i && other.bus === target.bus && other.field === target.field,
      )
    )
      throw new ShardError('audio/invalid-snapshot', 'Duplicate snapshot target')
    audioNumber(
      target.value,
      `/targets/${i}/value`,
      target.mode === 'offset' ? -Number.MAX_VALUE : field.min,
      target.mode === 'offset' ? Number.MAX_VALUE : field.max,
    )
    if (field.logarithmic && target.value <= 0)
      throw new ShardError('audio/invalid-snapshot', 'Frequency must be positive')
    indices[i] = index
  }
  return indices
}

export async function acquireAudioSnapshot(
  world: World,
  ref: AudioSnapshotDefinition | AssetRef | string,
  weight = 1,
): Promise<number> {
  audioNumber(weight, 'weight', 0, 1)
  const state = world.resource(AudioMixState)
  const source =
    typeof ref === 'object' && 'targets' in ref
      ? ref
      : await loadData<AudioSnapshotDefinition>(world, ref, AudioSnapshot)
  const definition = AudioSnapshot.deserialize(AudioSnapshot.serialize(source))
  if (state.snapshots.length >= 64)
    throw new ShardError('audio/mixer-capacity', 'Snapshot handle capacity reached')
  const indices = snapshotIndices(definition, state.fields)
  const key = JSON.stringify(AudioSnapshot.serialize(definition)),
    id = state.nextId++
  state.snapshots.push({
    id,
    key,
    definition,
    indices,
    weight: definition.attack ? 0 : weight,
    from: 0,
    elapsed: 0,
    target: weight,
    removing: false,
  })
  state.snapshots.sort(
    (a, b) =>
      a.definition.priority - b.definition.priority || a.key.localeCompare(b.key) || a.id - b.id,
  )
  return id
}
export function setAudioSnapshotWeight(world: World, id: number, weight: number): void {
  audioNumber(weight, 'weight', 0, 1)
  const handle = world.resource(AudioMixState).snapshots.find((handle) => handle.id === id)
  if (!handle || handle.removing)
    throw new ShardError('audio/stale-handle', 'Snapshot handle is released')
  handle.from = handle.weight
  handle.elapsed = 0
  handle.target = weight
}
export function releaseAudioSnapshot(world: World, id: number): boolean {
  const handle = world.resource(AudioMixState).snapshots.find((handle) => handle.id === id)
  if (!handle || handle.removing) return false
  handle.removing = true
  handle.from = handle.weight
  handle.elapsed = 0
  handle.target = 0
  return true
}

export function updateAudioMix(world: World, delta: number): void {
  const state = world.resource(AudioMixState)
  if (!state.graph) return
  const runtime = audioState(world).backend.runtime!,
    handles = state.snapshots
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i]!,
      seconds = handle.target < handle.weight ? handle.definition.release : handle.definition.attack
    handle.elapsed += delta
    handle.weight = seconds
      ? handle.from + (handle.target - handle.from) * Math.min(1, handle.elapsed / seconds)
      : handle.target
  }
  for (let i = 0; i < state.curves.length; i++) {
    const curve = state.curves[i]!
    sampleAudioCurve(curve.points, state.globals!.values[curve.parameter]!, state.scratch, 0)
    state.fields[curve.field]!.base = state.scratch[0]!
  }
  for (let i = 0; i < state.fields.length; i++) {
    const field = state.fields[i]!
    let value = field.logarithmic ? Math.log(field.base) : field.base,
      offset = 0,
      priority = Number.NEGATIVE_INFINITY,
      sum = 0,
      weight = 0
    for (let j = 0; j < handles.length; j++) {
      const handle = handles[j]!
      if (priority !== handle.definition.priority) {
        if (weight > 0) value += (sum / weight - value) * Math.min(1, weight)
        priority = handle.definition.priority
        sum = 0
        weight = 0
      }
      for (let k = 0; k < handle.indices.length; k++)
        if (handle.indices[k] === i) {
          const target = handle.definition.targets[k]!
          if (target.mode === 'offset') offset += target.value * handle.weight
          else {
            sum += (field.logarithmic ? Math.log(target.value) : target.value) * handle.weight
            weight += handle.weight
          }
        }
    }
    if (weight > 0) value += (sum / weight - value) * Math.min(1, weight)
    field.value = Math.max(
      field.min,
      Math.min(field.max, (field.logarithmic ? Math.exp(value) : value) + offset),
    )
    const authored =
      field.field === 'gainDb'
        ? (world.resource(AudioBuses)[field.bus]?.volume ?? 1) *
          (audioState(world).duckLevels.get(field.bus) ?? 1)
        : 1
    const output = field.linearGain
      ? 10 ** (field.value / 20) * field.factor * authored
      : field.value
    if (output !== field.sent) {
      runtime.setMixerValue(
        field.bus,
        field.field === 'gainDb' ? 'gain' : field.field,
        output,
        delta === 0 ? 0 : 0.01,
      )
      field.sent = output
    }
  }
  const legacy = world.resource(AudioBuses),
    users = world.resource(AudioUserControls)
  for (let i = 0; i < state.graph.buses.length; i++) {
    const bus = state.graph.buses[i]!,
      control = users[bus.id]
    const value = control?.muted || legacy[bus.id]?.muted ? 0 : (control?.volume ?? 1)
    if (value !== state.userSent[i]) {
      runtime.setMixerValue(bus.id, 'userGain', value, value === 0 ? 0 : 0.01)
      state.userSent[i] = value
    }
  }
  let count = 0
  for (let i = 0; i < handles.length; i++)
    if (!handles[i]!.removing || handles[i]!.weight > 0) handles[count++] = handles[i]!
  handles.length = count
}
const mixSystem = defineSystem({
  name: 'audio/mix',
  run: (_state, world) => updateAudioMix(world, world.resource(Time).delta),
})

export function describeAudioMix(world: World) {
  const state = world.resource(AudioMixState)
  return {
    graph: state.definition ? AudioMixer.serialize(state.definition) : null,
    fields: state.fields.map((field) => ({
      bus: field.bus,
      field: field.field,
      authored: field.base,
      effective: field.value,
    })),
    snapshots: state.snapshots.map((handle) => ({
      id: handle.id,
      priority: handle.definition.priority,
      weight: handle.weight,
      target: handle.target,
      releasing: handle.removing,
    })),
    userGains: Object.fromEntries(
      (state.graph?.buses ?? []).map((bus, i) => [bus.id, state.userSent[i]]),
    ),
  }
}
export function audioMixerPlugin(options: { mixer?: AssetRef | string; maxNodes?: number } = {}) {
  return definePlugin({
    name: 'audio/mixer',
    dependencies: ['audio/events'],
    provides: [{ AudioMixer, AudioSnapshot, AudioMixState, AudioPreviewPlan }],
    build(app) {
      app.world.initResource(AudioInspectors).set('mix', describeAudioMix)
      app.addMethod(...audioMixMethods)
      if (!audioState(app.world).backend.runtime?.capabilities.mixer)
        throw new ShardError('audio/unsupported-capability', 'Backend has no mixer graph support')
      app.world.initResource(AudioMixer.store)
      app.world.initResource(AudioSnapshot.store)
      app.world.insertResource(AudioMixState, {
        definition: null,
        graph: null,
        fields: [],
        snapshots: [],
        nextId: 1,
        revision: 0,
        maxNodes: options.maxNodes ?? 2048,
        userSent: new Float64Array(0),
        globals: null,
        globalKey: '',
        curves: [],
        scratch: new Float64Array(1),
      })
      app.addSystems(PostUpdate, mixSystem.after(updateAudio))
    },
    dispose(app) {
      releaseAudioGlobals(audioEvents(app.world), app.world.resource(AudioMixState).globalKey)
    },
    async ready(app) {
      if (options.mixer) await configureAudioMixer(app.world, options.mixer)
    },
  })
}
