import { AssetServerResource, assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  type Infer,
  PostUpdate,
  Rng,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import type { AudioPreparation } from '@aethervtt/shard-platform'
import {
  AppControlResource,
  definePlugin,
  GlobalRng,
  LogResource,
  Time,
} from '@aethervtt/shard-runtime'
import { GlobalTransform, OriginShift, TransformSystems } from '@aethervtt/shard-transform'
import { AudioCheckpoint, CheckpointSchema, installAudioCheckpoints } from './checkpoint'
import { AudioCheckpointHooks } from './checkpoint-bridge'
import { type AudioClipAsset, AudioClips } from './clip'
import { AudioBuses } from './components'
import * as definitions from './event-assets'
import {
  AudioCollection,
  AudioEvent,
  type AudioEventDefinition,
  type AudioEventLayer,
} from './event-assets'
import { audioEventMethods } from './event-methods'
import { AudioInspectors } from './inspection'
import { AudioMixState } from './mix'
import { audioState, endVoice, newVoice, updateAudio, type Voice } from './mixer'
import * as parameters from './parameters'
import { AudioParameterBank, AudioParameters, sampleAudioCurve } from './parameters'
import * as preview from './preview'
import { audioNumber } from './validation'

export interface PreparedAudioEvent {
  readonly key: string
  readonly releasePins: () => void
  readonly revision: string
  readonly definition: AudioEventDefinition
  readonly clips: readonly (readonly AudioClipAsset[])[]
  readonly leases: readonly AudioPreparation[]
  readonly globals: AudioParameterBank
  readonly source: AssetRef | null
  readonly globalKey: string
  readonly histories: { previous: Int32Array; cursor: number; sequence: number }[]
  refs: number
}

export interface AudioLease {
  readonly id: number
  readonly events: readonly PreparedAudioEvent[]
  readonly released: boolean
  release(): void
}

interface Binding {
  parameter: number
  global: boolean
  builtin: number
  property: number
  points: Float64Array
}
interface LayerState {
  rng: Rng
  definition: AudioEventLayer
  voice: Voice | null
  selected: number
  cursor: number
  age: number
  triggered: boolean
  gate: boolean
  ending: boolean
  releasedAt: number
  gainDb: number
  pitchSemitones: number
  sends: {
    target: string
    gain: number
    sent: number
    parameter: number
    global: boolean
    builtin: number
    points: Float64Array
  }[]
  bindings: Binding[]
  condition: number
  conditionGlobal: boolean
  conditionLabel: number
}

export interface AudioEventInstance {
  id: number
  ordinal: number
  key: string
  entity: Entity | null
  plan: PreparedAudioEvent | null
  definition: AudioEventDefinition | null
  admission: (() => void) | null
  parameters: AudioParameterBank | null
  layers: LayerState[]
  state: 'preparing' | 'active' | 'virtual' | 'stopping' | 'ended' | 'failed'
  error: string | null
  decisionTime: number
  sampleTime: number
  requestedAt: number
  waitAge: number
  wasBlocked: boolean
  maxAge: number
  blocked: string
  transient: boolean
  clock: 'simulation' | 'realtime'
  pitchLinked: boolean
  x: number
  y: number
  z: number
  speed: number
  distance: number
  rng: Rng
  release: number
  options: PlayAudioEventOptions
}

const TransportSchema = defineSchema('audio/TransportData', {
  paused: t.bool(),
  timeScale: t.f64({ default: 1, min: 0, max: 16 }),
})
export const AudioTransport = defineResource<Infer<typeof TransportSchema>>('audio/Transport', {
  schema: TransportSchema,
  hostWritable: true,
  init: () => ({ paused: false, timeScale: 1 }),
})

export interface AudioEventTraceEntry {
  cursor: number
  frame: number
  time: number
  kind: string
  instance: number
  layer: string
  choice: number
  reason: string
}

/** Fixed slots; JSON records are only made when inspected. */
export class AudioTrace {
  readonly frames: Float64Array
  readonly times: Float64Array
  readonly instances: Float64Array
  readonly choices: Int32Array
  readonly kinds: string[]
  readonly layers: string[]
  readonly reasons: string[]
  next = 0
  readonly capacity: number
  constructor(capacity = 4096) {
    this.capacity = capacity
    this.frames = new Float64Array(capacity)
    this.times = new Float64Array(capacity)
    this.instances = new Float64Array(capacity)
    this.choices = new Int32Array(capacity)
    this.kinds = new Array(capacity).fill('')
    this.layers = new Array(capacity).fill('')
    this.reasons = new Array(capacity).fill('')
  }
  write(
    frame: number,
    time: number,
    kind: string,
    instance: number,
    layer = '',
    choice = -1,
    reason = '',
  ): void {
    const slot = this.next++ % this.capacity
    this.frames[slot] = frame
    this.times[slot] = time
    this.kinds[slot] = kind
    this.instances[slot] = instance
    this.layers[slot] = layer
    this.choices[slot] = choice
    this.reasons[slot] = reason
  }
  read(cursor = 0) {
    const oldestCursor = Math.max(0, this.next - this.capacity)
    const entries: AudioEventTraceEntry[] = []
    for (let i = Math.max(cursor, oldestCursor); i < this.next; i++) {
      const s = i % this.capacity
      entries.push({
        cursor: i,
        frame: this.frames[s]!,
        time: this.times[s]!,
        kind: this.kinds[s]!,
        instance: this.instances[s]!,
        layer: this.layers[s]!,
        choice: this.choices[s]!,
        reason: this.reasons[s]!,
      })
    }
    return { entries, oldestCursor, nextCursor: this.next, truncated: cursor < oldestCursor }
  }
}

export interface AudioEventsStateValue {
  instances: (AudioEventInstance | null)[]
  plans: Map<string, PreparedAudioEvent>
  preparations: Map<string, Promise<PreparedAudioEvent>>
  nextPlan: number
  restoring: boolean
  histories: Map<string, PreparedAudioEvent['histories']>
  globalList: AudioParameterBank[]
  globalBanks: Map<string, AudioParameterBank>
  globalRefs: Map<string, number>
  generation: number
  leases: Map<number, AudioLease>
  cooldowns: Map<string, number>
  nextId: number
  nextLease: number
  ordinal: number
  seed: number
  lastClock: number
  lastWall: number
  trace: AudioTrace
  scratch: Float64Array
  disposed: boolean
  inFrame: boolean
  unshift: (() => void) | null
  pending: number
  maxPending: number
  wake: (() => void) | null
}
export const AudioEventsState = defineResource<AudioEventsStateValue>('audio/EventsState')

export function audioEvents(world: World): AudioEventsStateValue {
  const state = world.tryResource(AudioEventsState)
  if (!state) throw new ShardError('audio/no-plugin', 'Enable audio/events first')
  return state
}

export type AudioEventRef = AssetRef | string | AudioEventDefinition
function isDefinition(ref: AudioEventRef): ref is AudioEventDefinition {
  return typeof ref === 'object' && 'layers' in ref
}
function refKey(ref: AssetRef | string): string {
  return typeof ref === 'string' ? ref : (ref.guid ?? ref.path ?? '')
}
function hash(text: string, seed = 2166136261): number {
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619)
  return seed >>> 0
}

async function eventDefinition(
  world: World,
  ref: AudioEventRef,
): Promise<{ key: string; definition: AudioEventDefinition }> {
  if (isDefinition(ref)) {
    const errors = AudioEvent.validate(AudioEvent.serialize(ref))
    if (errors.length) throw errors[0]
    const definition = AudioEvent.deserialize(AudioEvent.serialize(ref))
    definitions.validateAudioEvent(definition)
    return { key: `inline:${hash(JSON.stringify(AudioEvent.serialize(definition)))}`, definition }
  }
  const server = assetServer(world)
  const resolved =
    typeof ref === 'string'
      ? (server.resolve(ref) ?? { path: ref, type: 'audio/AudioEvent', guid: undefined })
      : ref
  const store = world.initResource(AudioEvent.store)
  if (!store.get(resolved)) await server.load(resolved)
  const value = store.get(resolved)
  if (!value) throw new ShardError('audio/invalid-event', `No event ${refKey(ref)}`)
  // Data stores mutate on reload; active instances pin a schema-derived immutable revision.
  return { key: refKey(resolved), definition: AudioEvent.deserialize(AudioEvent.serialize(value)) }
}

async function resolveClip(world: World, ref: AssetRef): Promise<AudioClipAsset> {
  const store = world.resource(AudioClips)
  if (!store.get(ref)) await assetServer(world).load(ref)
  const clip = store.get(ref)
  if (!clip) throw new ShardError('audio/prepare-failed', `Missing clip ${refKey(ref)}`)
  return { ...clip }
}

async function prepareEvent(
  world: World,
  ref: AudioEventRef,
  resolved?: { key: string; definition: AudioEventDefinition },
): Promise<PreparedAudioEvent> {
  const state = audioEvents(world)
  if (state.disposed || state.pending >= state.maxPending)
    throw new ShardError('audio/capacity', 'Preparation queue is unavailable or full')
  const generation = state.generation
  state.pending++
  try {
    return await prepareEventInner(world, ref, generation, resolved)
  } finally {
    state.pending--
  }
}

function planFresh(world: World, plan: PreparedAudioEvent): boolean {
  if (plan.source) {
    const definition = world.resource(AudioEvent.store).get(plan.source)
    if (!definition || JSON.stringify(AudioEvent.serialize(definition)) !== plan.revision)
      return false
  }
  const store = world.resource(AudioClips)
  for (let i = 0; i < plan.definition.layers.length; i++)
    for (let j = 0; j < plan.definition.layers[i]!.choices.length; j++) {
      const current = store.get(plan.definition.layers[i]!.choices[j]!.clip),
        pinned = plan.clips[i]![j]!
      if (
        !current ||
        current.bytes !== pinned.bytes ||
        current.url !== pinned.url ||
        current.stream !== pinned.stream ||
        current.duration !== pinned.duration ||
        current.loopStart !== pinned.loopStart ||
        current.loopEnd !== pinned.loopEnd
      )
        return false
    }
  return true
}

async function prepareEventInner(
  world: World,
  ref: AudioEventRef,
  generation: number,
  resolved?: { key: string; definition: AudioEventDefinition },
): Promise<PreparedAudioEvent> {
  const state = audioEvents(world)
  const { key, definition } = resolved ?? (await eventDefinition(world, ref))
  const runtime = audioState(world).backend.runtime
  if (!runtime)
    throw new ShardError(
      'audio/unsupported-capability',
      'Events require preparation-aware playback',
    )
  for (let i = 0; i < state.instances.length; i++) {
    const instance = state.instances[i]
    if (instance?.state === 'preparing' && instance.key === key) {
      instance.maxAge = definition.maxAge
      instance.blocked = definition.blocked
      instance.transient = definition.mode === 'oneshot'
    }
  }
  const revision = JSON.stringify(AudioEvent.serialize(definition))
  const existing = state.plans.get(key)
  if (existing && existing.revision === revision && planFresh(world, existing)) {
    existing.refs++
    return existing
  }
  if (state.plans.size >= 256)
    throw new ShardError('audio/capacity', 'At most 256 prepared event definitions per session')
  const pendingKey = `${generation}:${key}:${revision}`
  const pending = state.preparations.get(pendingKey)
  if (pending) {
    const plan = await pending
    if (planFresh(world, plan)) {
      plan.refs++
      return plan
    }
    return prepareEventInner(world, ref, generation)
  }
  const operation = compileEvent(world, ref, key, definition, revision, generation)
  state.preparations.set(pendingKey, operation)
  try {
    return await operation
  } finally {
    if (state.preparations.get(pendingKey) === operation) state.preparations.delete(pendingKey)
  }
}

async function compileEvent(
  world: World,
  ref: AudioEventRef,
  key: string,
  definition: AudioEventDefinition,
  revision: string,
  generation: number,
): Promise<PreparedAudioEvent> {
  const state = audioEvents(world),
    runtime = audioState(world).backend.runtime!
  const server = world.tryResource(AssetServerResource)
  const owner = `audio:plan:${state.nextPlan++}`
  if (!isDefinition(ref)) server?.pin(ref, owner)
  const leases: AudioPreparation[] = []
  const clips: AudioClipAsset[][] = []
  let globals = new AudioParameterBank([])
  let globalKey = ''
  try {
    if (definition.globals) {
      const shared = await acquireAudioGlobals(world, definition.globals)
      globalKey = shared.key
      globals = shared.bank
    }
    const unique = new Map<string, AudioClipAsset>()
    const buses = world.resource(AudioBuses)
    for (const layer of definition.layers) {
      const bus = layer.bus || definition.bus
      if (!buses[bus])
        throw new ShardError('audio/unknown-bus', `Unknown event bus ${bus}`, {
          path: `/layers/${layer.id}/bus`,
        })
      const choices: AudioClipAsset[] = []
      for (const choice of layer.choices) {
        const clipKey = refKey(choice.clip!)
        let clip = unique.get(clipKey)
        if (!clip) {
          server?.pin(choice.clip!, owner)
          clip = await resolveClip(world, choice.clip!)
          unique.set(clipKey, clip)
          leases.push(await runtime.prepare(clip))
        }
        choices.push(clip)
      }
      clips.push(choices)
    }
    if (state.disposed || generation !== state.generation)
      throw new ShardError('audio/prepare-failed', 'Session changed during preparation')
    if (state.plans.size >= 256 && !state.plans.has(key))
      throw new ShardError('audio/capacity', 'Prepared event capacity reached')
    const plan: PreparedAudioEvent = {
      key,
      releasePins: () => server?.unpin(owner),
      revision,
      definition,
      clips,
      leases,
      globals,
      refs: 1,
      globalKey,
      source: isDefinition(ref)
        ? null
        : typeof ref === 'string'
          ? (assetServer(world).resolve(ref) ?? null)
          : ref,
      histories:
        state.histories.get(`${key}:${revision}`) ??
        definition.layers.map((layer) => ({
          previous: new Int32Array(Math.max(1, layer.noRepeat)).fill(-1),
          cursor: 0,
          sequence: 0,
        })),
    }
    if (!state.histories.has(`${key}:${revision}`)) {
      if (state.histories.size >= 256) state.histories.delete(state.histories.keys().next().value!)
      state.histories.set(`${key}:${revision}`, plan.histories)
    }
    if (planFresh(world, plan)) state.plans.set(key, plan)
    return plan
  } catch (error) {
    for (const lease of leases) lease.release()
    server?.unpin(owner)
    releaseAudioGlobals(state, globalKey)
    throw error
  }
}

/** One parameter bank per asset in this session, shared by events, mixing and music. */
export async function acquireAudioGlobals(
  world: World,
  ref: AssetRef,
): Promise<{ key: string; bank: AudioParameterBank }> {
  const state = audioEvents(world),
    store = world.initResource(AudioParameters.store)
  if (!store.get(ref)) await assetServer(world).load(ref)
  const value = store.get(ref)
  if (!value) throw new ShardError('audio/unknown-parameter', 'Global parameter asset is missing')
  const key = refKey(ref),
    current = state.globalBanks.get(key)
  if (current && JSON.stringify(current.definitions) !== JSON.stringify(value.parameters))
    throw new ShardError(
      'audio/unknown-parameter',
      'Global parameter schema changed while in use',
      { hint: 'Release its users before replacing the schema.' },
    )
  const bank =
    current ??
    new AudioParameterBank(AudioParameters.deserialize(AudioParameters.serialize(value)).parameters)
  if (!current) state.globalList.push(bank)
  state.globalBanks.set(key, bank)
  state.globalRefs.set(key, (state.globalRefs.get(key) ?? 0) + 1)
  return { key, bank }
}

export function releaseAudioGlobals(state: AudioEventsStateValue, key: string): void {
  if (!key) return
  const count = (state.globalRefs.get(key) ?? 0) - 1
  if (count <= 0) {
    state.globalRefs.delete(key)
    const bank = state.globalBanks.get(key)
    const index = bank ? state.globalList.indexOf(bank) : -1
    if (index >= 0) state.globalList.splice(index, 1)
    state.globalBanks.delete(key)
  } else state.globalRefs.set(key, count)
}

function releasePlan(state: AudioEventsStateValue, plan: PreparedAudioEvent): void {
  if (--plan.refs !== 0) return
  for (const lease of plan.leases) lease.release()
  plan.releasePins()
  releaseAudioGlobals(state, plan.globalKey)
  if (state.plans.get(plan.key) === plan) state.plans.delete(plan.key)
}

/** Collections are ordinary dependency manifests. Preparation is explicitly leased and awaitable. */
export async function prepareAudio(world: World, ref: AudioEventRef): Promise<AudioLease> {
  const state = audioEvents(world)
  if (state.disposed || state.pending >= state.maxPending)
    throw new ShardError('audio/capacity', 'Preparation queue is full')
  const generation = state.generation
  const events: PreparedAudioEvent[] = []
  const clips: AudioPreparation[] = []
  try {
    const key = isDefinition(ref) ? '' : refKey(ref)
    if (
      key.endsWith('.audio-collection.json') ||
      (!isDefinition(ref) && typeof ref !== 'string' && ref.type === 'audio/AudioCollection')
    ) {
      const server = assetServer(world)
      const resolved =
        typeof ref === 'string'
          ? (server.resolve(ref) ?? { path: ref, type: 'audio/AudioCollection', guid: undefined })
          : (ref as AssetRef)
      const store = world.initResource(AudioCollection.store)
      if (!store.get(resolved)) await server.load(resolved)
      const collection = store.get(resolved)
      if (!collection) throw new ShardError('audio/prepare-failed', `Missing collection ${key}`)
      for (const event of collection.events) events.push(await prepareEvent(world, event!))
      for (const clip of collection.clips)
        clips.push(
          await audioState(world).backend.runtime!.prepare(await resolveClip(world, clip!)),
        )
    } else events.push(await prepareEvent(world, ref))
    if (state.disposed || generation !== state.generation)
      throw new ShardError('audio/prepare-failed', 'Session changed during preparation')
    let released = false
    const id = state.nextLease++
    const lease: AudioLease = {
      id,
      events,
      get released() {
        return released
      },
      release: () => {
        if (released) return
        released = true
        for (const event of events) releasePlan(state, event)
        for (const clip of clips) clip.release()
        state.leases.delete(id)
      },
    }
    state.leases.set(id, lease)
    return lease
  } catch (error) {
    for (const event of events) releasePlan(state, event)
    for (const clip of clips) clip.release()
    throw error
  }
}

export interface PlayAudioEventOptions {
  entity?: Entity
  position?: readonly number[]
  parameters?: Readonly<Record<string, number | string>>
  clock?: 'simulation' | 'realtime'
  pitchLinked?: boolean
  persist?: boolean
}

function instanceOf(state: AudioEventsStateValue, id: number): AudioEventInstance | null {
  for (let i = 0; i < state.instances.length; i++)
    if (state.instances[i]?.id === id) return state.instances[i]!
  return null
}

function resolveParameter(local: AudioParameterBank, global: AudioParameterBank, name: string) {
  const index = local.indices.get(name)
  return index === undefined
    ? { index: global.index(name), global: true }
    : { index, global: false }
}

function admit(
  world: World,
  state: AudioEventsStateValue,
  instance: AudioEventInstance,
  plan: Pick<PreparedAudioEvent, 'key' | 'definition' | 'globals'>,
): void {
  if (instance.entity !== null && !world.isAlive(instance.entity))
    throw new ShardError('audio/stale-handle', 'Emitter was removed before admission')
  const local = new AudioParameterBank(plan.definition.parameters)
  for (const name in instance.options.parameters)
    local.set(name, instance.options.parameters[name]!)
  const layers: LayerState[] = []
  for (const layer of plan.definition.layers) {
    if (!world.resource(AudioBuses)[layer.bus || plan.definition.bus])
      throw new ShardError(
        'audio/unknown-bus',
        `Unknown event bus ${layer.bus || plan.definition.bus}`,
      )
    const bindings: Binding[] = []
    for (const curve of layer.curves) {
      const builtin = curve.parameter === 'distance' ? 1 : curve.parameter === 'speed' ? 2 : 0
      const param = builtin
        ? { index: -1, global: false }
        : resolveParameter(local, plan.globals, curve.parameter)
      bindings.push({
        parameter: param.index,
        global: param.global,
        builtin,
        property: ['gainDb', 'pitchSemitones', 'lowpass', 'highpass'].indexOf(curve.property),
        points: new Float64Array(curve.points.flat()),
      })
    }
    const sends = layer.sends.map((send) => {
      const bus = layer.bus || plan.definition.bus
      if (
        !world
          .tryResource(AudioMixState)
          ?.graph?.buses.find((route) => route.id === bus)
          ?.sends.some((route) => route.target === send.target)
      )
        throw new ShardError(
          'audio/unknown-bus',
          `Declare mixer route ${bus} -> ${send.target} before preparing an event send`,
        )
      const builtin = send.parameter === 'distance' ? 1 : send.parameter === 'speed' ? 2 : 0
      const parameter =
        send.parameter && !builtin
          ? resolveParameter(local, plan.globals, send.parameter)
          : { index: -1, global: false }
      return {
        target: send.target,
        gain: 10 ** (send.gainDb / 20),
        sent: Number.NaN,
        parameter: parameter.index,
        global: parameter.global,
        builtin,
        points: new Float64Array(send.points.flat()),
      }
    })
    const condition = layer.condition.parameter
      ? resolveParameter(local, plan.globals, layer.condition.parameter)
      : { index: -1, global: false }
    const bank = condition.global ? plan.globals : local
    const label =
      layer.condition.label && condition.index >= 0
        ? bank.encode(condition.index, layer.condition.label)
        : -1
    layers.push({
      rng: new Rng(hash(layer.id, hash(plan.key, state.seed ^ state.ordinal))),
      definition: layer,
      voice: null,
      selected: -1,
      cursor: 0,
      age: 0,
      triggered: false,
      gate: false,
      ending: false,
      releasedAt: 0,
      gainDb: 0,
      pitchSemitones: 0,
      bindings,
      sends,
      condition: condition.index,
      conditionGlobal: condition.global,
      conditionLabel: label,
    })
    if (layer.selector === 'switch') {
      const selected = resolveParameter(local, plan.globals, layer.selectParameter)
      if (
        (selected.global ? plan.globals : local).definitions[selected.index]!.kind === 'continuous'
      )
        throw new ShardError(
          'audio/invalid-event',
          'Switch selectors require a discrete or label parameter',
        )
    }
  }
  const group = `${plan.definition.group || plan.key}:${plan.definition.scope === 'emitter' ? instance.entity : 'session'}`
  const now = audioState(world).backend.runtime!.clock.now()
  const last = state.cooldowns.get(group)
  if (!state.restoring && last !== undefined && now < last)
    throw new ShardError('audio/capacity', 'Event cooldown is active')
  let count = 0,
    victim: AudioEventInstance | null = null
  for (let i = 0; i < state.instances.length; i++) {
    const other = state.instances[i]
    if (
      !other ||
      other === instance ||
      !other.definition ||
      other.ordinal < 0 ||
      other.state === 'ended' ||
      other.state === 'failed'
    )
      continue
    const def = other.definition
    if (
      (def.group || other.key) !== (plan.definition.group || plan.key) ||
      (plan.definition.scope === 'emitter' && other.entity !== instance.entity)
    )
      continue
    count++
    if (
      !victim ||
      (plan.definition.policy === 'steal-quietest'
        ? instanceGain(other) < instanceGain(victim)
        : other.id < victim.id)
    )
      victim = other
  }
  if (plan.definition.cooldown > 0) {
    for (const [key, expiry] of state.cooldowns) if (expiry <= now) state.cooldowns.delete(key)
    if (state.cooldowns.size >= 4096 && !state.cooldowns.has(group))
      throw new ShardError('audio/capacity', 'Cooldown capacity reached')
  }
  if (count >= plan.definition.maxInstances) {
    if (plan.definition.policy === 'reject-new' || !victim)
      throw new ShardError('audio/capacity', 'Event concurrency limit reached')
    stopAudioEvent(world, victim.id, { release: 0 })
  }
  instance.key = plan.key
  instance.definition = plan.definition
  instance.parameters = local
  instance.layers = layers
  instance.ordinal = state.ordinal++
  instance.rng = new Rng(hash(plan.key, state.seed ^ instance.ordinal))
  instance.maxAge = plan.definition.maxAge
  instance.blocked = plan.definition.blocked
  instance.transient = plan.definition.mode === 'oneshot'
  if (plan.definition.cooldown > 0) {
    for (const [key, expiry] of state.cooldowns) if (expiry <= now) state.cooldowns.delete(key)
    state.cooldowns.set(group, now + plan.definition.cooldown)
  }
  state.trace.write(audioState(world).frame, now, 'event-start', instance.id)
}

function activate(
  _world: World,
  state: AudioEventsStateValue,
  instance: AudioEventInstance,
  plan: PreparedAudioEvent,
): void {
  if (instance.state !== 'preparing' || state.disposed) {
    releasePlan(state, plan)
    return
  }
  if (instance.entity !== null && !_world.isAlive(instance.entity)) {
    releasePlan(state, plan)
    finishInstance(_world, state, instance, 'removed')
    return
  }
  instance.plan = plan
  instance.state = 'active'
}

/** Metadata resolves in parallel; admission is always in command order, before PCM/pins. */
function drainAdmissions(state: AudioEventsStateValue): void {
  for (;;) {
    let next: AudioEventInstance | null = null
    for (const instance of state.instances)
      if (
        instance?.state === 'preparing' &&
        instance.ordinal < 0 &&
        (!next || instance.id < next.id)
      )
        next = instance
    if (!next?.admission) return
    const admit = next.admission
    next.admission = null
    admit()
  }
}

function instanceGain(instance: AudioEventInstance): number {
  let gain = 0
  for (let i = 0; i < instance.layers.length; i++) gain += instance.layers[i]!.voice?.gain ?? 0
  return gain
}

export function playAudioEvent(
  world: World,
  ref: AudioEventRef,
  options: PlayAudioEventOptions = {},
): number {
  const state = audioEvents(world)
  if (state.disposed) throw new ShardError('audio/no-plugin', 'Audio session is disposed')
  let slot = -1
  for (let i = 0; i < state.instances.length; i++)
    if (!state.instances[i] || ['ended', 'failed'].includes(state.instances[i]!.state)) {
      slot = i
      break
    }
  if (slot === -1) throw new ShardError('audio/capacity', 'Logical audio instance capacity reached')
  if (options.entity !== undefined && !world.isAlive(options.entity))
    throw new ShardError('audio/stale-handle', 'Emitter entity is not alive')
  if (options.position)
    for (let i = 0; i < 3; i++) audioNumber(options.position[i]!, 'position', -Number.MAX_VALUE)
  const key = isDefinition(ref)
    ? `inline:${hash(JSON.stringify(AudioEvent.serialize(ref)))}`
    : refKey(
        world
          .tryResource(AssetServerResource)
          ?.resolve(typeof ref === 'string' ? ref : (ref.path ?? ref.guid ?? '')) ?? ref,
      )
  const id = state.nextId++
  const instance: AudioEventInstance = {
    id,
    ordinal: -1,
    key,
    entity: options.entity ?? null,
    plan: null,
    definition: null,
    admission: null,
    parameters: null,
    layers: [],
    state: 'preparing',
    error: null,
    decisionTime: 0,
    sampleTime: 0,
    requestedAt: audioState(world).backend.runtime!.clock.now(),
    waitAge: 0,
    wasBlocked: false,
    maxAge: isDefinition(ref) ? ref.maxAge : 0.25,
    blocked: isDefinition(ref) ? ref.blocked : 'drop',
    transient: isDefinition(ref) ? ref.mode === 'oneshot' : true,
    clock: options.clock ?? 'simulation',
    pitchLinked: options.pitchLinked ?? false,
    x: options.position?.[0] ?? 0,
    y: options.position?.[1] ?? 0,
    z: options.position?.[2] ?? 0,
    speed: 0,
    distance: 0,
    rng: new Rng(0),
    release: -1,
    options,
  }
  state.instances[slot] = instance
  const fail = (error: unknown) => {
    if (instance.state === 'ended') return
    instance.state = 'failed'
    instance.error = error instanceof ShardError ? error.code : 'audio/prepare-failed'
    world.tryResource(LogResource)?.error(error)
    state.trace.write(audioState(world).frame, 0, 'event-failed', id, '', -1, instance.error)
  }
  const prepared = state.plans.get(key)
  let synchronousError: unknown
  let synchronous = true
  const enqueue = (metadata: Pick<PreparedAudioEvent, 'key' | 'definition' | 'globals'>) => {
    if (instance.state !== 'preparing' || state.disposed) return
    instance.admission = () => {
      try {
        admit(world, state, instance, metadata)
        const cached = state.plans.get(metadata.key)
        if (
          cached &&
          cached.revision === JSON.stringify(AudioEvent.serialize(metadata.definition)) &&
          planFresh(world, cached)
        ) {
          cached.refs++
          activate(world, state, instance, cached)
        } else {
          void prepareEvent(world, ref, metadata)
            .then((plan) => activate(world, state, instance, plan))
            .catch(fail)
        }
      } catch (error) {
        fail(error)
        if (synchronous) synchronousError = error
      }
    }
    drainAdmissions(state)
  }
  if (prepared && planFresh(world, prepared)) enqueue(prepared)
  else {
    if (state.pending >= state.maxPending) {
      instance.state = 'failed'
      throw new ShardError('audio/capacity', 'Preparation queue is full')
    }
    state.pending++
    void (async () => {
      try {
        const metadata = await eventDefinition(world, ref)
        let globals = new AudioParameterBank([])
        if (metadata.definition.globals) {
          const store = world.resource(AudioParameters.store)
          if (!store.get(metadata.definition.globals))
            await assetServer(world).load(metadata.definition.globals)
          const value = store.get(metadata.definition.globals)
          if (!value)
            throw new ShardError('audio/unknown-parameter', 'Global parameter asset is missing')
          globals = new AudioParameterBank(value.parameters)
        }
        state.pending--
        enqueue({ ...metadata, globals })
      } catch (error) {
        state.pending--
        fail(error)
        drainAdmissions(state)
      }
    })()
  }
  synchronous = false
  if (synchronousError) throw synchronousError
  return id
}

export function setAudioParameter(
  world: World,
  instance: number | null,
  name: string,
  value: number | string,
): void {
  const state = audioEvents(world)
  if (instance !== null) {
    const target = instanceOf(state, instance)
    if (!target?.parameters || target.state === 'ended')
      throw new ShardError('audio/stale-handle', 'Event is not active')
    target.parameters.set(name, value)
  } else {
    let found = false
    for (const bank of state.globalBanks.values())
      if (bank.indices.has(name)) {
        bank.set(name, value)
        found = true
      }
    if (!found) throw new ShardError('audio/unknown-parameter', `Unknown global parameter ${name}`)
  }
}

function finishInstance(
  world: World,
  state: AudioEventsStateValue,
  instance: AudioEventInstance,
  reason: string,
): void {
  if (instance.state === 'ended') return
  const audio = audioState(world)
  for (let i = 0; i < instance.layers.length; i++) {
    const voice = instance.layers[i]!.voice
    if (voice && voice.id > 0) endVoice(world, audio, voice, 'stopped')
  }
  if (instance.plan) {
    releasePlan(state, instance.plan)
    instance.plan = null
  }
  instance.state = 'ended'
  instance.admission = null
  drainAdmissions(state)
  state.trace.write(audio.frame, instance.decisionTime, 'event-stop', instance.id, '', -1, reason)
}

export function stopAudioEvent(
  world: World,
  id: number,
  options: { release?: number } = {},
): boolean {
  const state = audioEvents(world),
    instance = instanceOf(state, id)
  if (!instance || instance.state === 'ended' || instance.state === 'failed') return false
  audioNumber(options.release ?? 0.02, 'release')
  if (instance.state === 'preparing' || options.release === 0)
    finishInstance(world, state, instance, 'stopped')
  else {
    instance.state = 'stopping'
    instance.release = options.release ?? 0.02
  }
  return true
}

function select(instance: AudioEventInstance, layer: LayerState, index: number): number {
  const plan = instance.plan!,
    definition = layer.definition,
    history = plan.histories[index]!
  if (definition.selector === 'single') return 0
  if (definition.selector === 'sequence') return history.sequence++ % definition.choices.length
  if (definition.selector === 'switch') {
    const local = instance.parameters!,
      id = local.indices.get(definition.selectParameter)
    const bank = id === undefined ? plan.globals : local,
      parameter = id ?? bank.index(definition.selectParameter)
    const value = bank.values[parameter]!,
      def = bank.definitions[parameter]!
    for (let i = 0; i < definition.choices.length; i++) {
      const choice = definition.choices[i]!
      if (def.kind === 'label' ? def.labels[value] === choice.label : value === choice.value)
        return i
    }
    return definition.defaultChoice
  }
  let total = 0
  const exclude = definition.selector === 'no-repeat'
  for (let i = 0; i < definition.choices.length; i++)
    if (!exclude || !history.previous.includes(i)) total += definition.choices[i]!.weight
  const reduce = total <= 0
  if (reduce)
    for (let i = 0; i < definition.choices.length; i++) total += definition.choices[i]!.weight
  let pick = layer.rng.float() * total,
    selected = Math.max(0, definition.defaultChoice)
  for (let i = 0; i < definition.choices.length; i++) {
    if (exclude && !reduce && history.previous.includes(i)) continue
    pick -= definition.choices[i]!.weight
    if (pick < 0) {
      selected = i
      break
    }
  }
  if (exclude) history.previous[history.cursor++ % history.previous.length] = selected
  return selected
}

function updateInstance(
  world: World,
  state: AudioEventsStateValue,
  instance: AudioEventInstance,
  delta: number,
  unscaled: number,
): void {
  const audio = audioState(world),
    plan = instance.plan!
  const transport = world.resource(AudioTransport)
  const paused =
    instance.clock === 'simulation' &&
    (transport.paused || (world.tryResource(AppControlResource)?.paused ?? false))
  if (paused && instance.state === 'stopping') {
    finishInstance(world, state, instance, 'stopped')
    return
  }
  const sampleDelta = paused ? 0 : unscaled
  const decisionDelta = paused
    ? 0
    : instance.clock === 'simulation'
      ? delta * transport.timeScale
      : unscaled
  instance.decisionTime += decisionDelta
  instance.sampleTime += sampleDelta
  instance.parameters!.update(decisionDelta)
  if (instance.entity !== null) {
    if (!world.isAlive(instance.entity)) {
      finishInstance(world, state, instance, 'removed')
      return
    }
    const table = world.entityTableUnchecked(instance.entity)
    if (table.has(GlobalTransform)) {
      const m = table.column(GlobalTransform, 'matrix'),
        row = world.entityRowUnchecked(instance.entity) * 12
      const x = m[row + 3]!,
        y = m[row + 7]!,
        z = m[row + 11]!
      const dx = x - instance.x,
        dy = y - instance.y,
        dz = z - instance.z
      instance.speed = unscaled > 0 ? Math.sqrt(dx * dx + dy * dy + dz * dz) / unscaled : 0
      instance.x = x
      instance.y = y
      instance.z = z
    }
  }
  const dx = instance.x - audio.listener[3]!,
    dy = instance.y - audio.listener[7]!,
    dz = instance.z - audio.listener[11]!
  instance.distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  let live = paused,
    real = false
  for (let i = 0; i < instance.layers.length; i++) {
    const layer = instance.layers[i]!,
      def = layer.definition
    let condition = true
    if (layer.condition >= 0) {
      const bank = layer.conditionGlobal ? plan.globals : instance.parameters!
      const value = bank.values[layer.condition]!
      condition =
        layer.conditionLabel >= 0
          ? value === layer.conditionLabel
          : value >= def.condition.min && value <= def.condition.max
    }
    const gate =
      !paused && instance.state !== 'stopping' && condition && instance.decisionTime >= def.delay
    const mayTrigger =
      !paused &&
      (def.trigger === 'while'
        ? gate && !layer.gate
        : !layer.triggered && instance.decisionTime >= def.delay)
    if (mayTrigger) {
      layer.triggered = true
      if (condition && gate) {
        if (layer.ending && layer.voice && def.loopPolicy === 'resume') layer.ending = false
        else if (layer.ending && layer.voice) {
          endVoice(world, audio, layer.voice, 'stopped', 0)
          layer.voice = null
        }
        if (layer.selected < 0 || def.loopPolicy === 'restart') {
          layer.selected = select(instance, layer, i)
          layer.gainDb =
            def.gainRandom[0] + layer.rng.float() * (def.gainRandom[1] - def.gainRandom[0])
          layer.pitchSemitones =
            def.pitchRandom[0] + layer.rng.float() * (def.pitchRandom[1] - def.pitchRandom[0])
          if (def.loopPolicy === 'restart') layer.cursor = 0
        }
        if (!layer.voice || layer.voice.id <= 0) {
          const voice = newVoice(audio, null, audio.frame)
          voice.sends = layer.sends
          voice.managed = true
          voice.fresh = true
          voice.virtualizable = plan.definition.mode === 'sustain'
          voice.clip = plan.clips[i]![layer.selected]!
          voice.bus = def.bus || plan.definition.bus
          voice.loop = def.loop
          voice.priority = plan.definition.priority
          voice.spatial = def.spatial
          voice.minDistance = def.minDistance
          voice.maxDistance = def.maxDistance
          voice.rolloff = def.rolloff
          voice.rolloffFactor = def.rolloffFactor
          voice.panning = def.panning
          voice.time = layer.cursor
          audio.voices.push(voice)
          layer.voice = voice
          layer.age = 0
          layer.ending = false
          state.trace.write(
            audio.frame,
            instance.decisionTime,
            'layer-start',
            instance.id,
            def.id,
            layer.selected,
          )
        }
      }
    }
    const voice = layer.voice
    if (voice && voice.id > 0) {
      layer.age += decisionDelta
      voice.suppressed = paused
      if (!voice.fresh) voice.time += sampleDelta * voice.pitch
      layer.cursor = voice.time
      voice.elapsed += decisionDelta
      voice.x = instance.x
      voice.y = instance.y
      voice.z = instance.z
      if (
        (!gate && def.trigger === 'while' && !paused) ||
        instance.state === 'stopping' ||
        (def.duration > 0 && layer.age >= def.duration)
      ) {
        if (!layer.ending) {
          layer.ending = true
          layer.releasedAt = layer.age
        }
      }
      const scratch = state.scratch
      scratch[0] = def.gainDb + layer.gainDb
      scratch[1] = def.pitchSemitones + layer.pitchSemitones
      scratch[2] = 20000
      scratch[3] = 0
      for (let b = 0; b < layer.bindings.length; b++) {
        const binding = layer.bindings[b]!
        const bank = binding.global ? plan.globals : instance.parameters!
        const value =
          binding.builtin === 1
            ? instance.distance
            : binding.builtin === 2
              ? instance.speed
              : bank.values[binding.parameter]!
        sampleAudioCurve(binding.points, value, scratch, binding.property + 4)
        if (binding.property < 2)
          scratch[binding.property] = scratch[binding.property]! + scratch[binding.property + 4]!
        else scratch[binding.property] = scratch[binding.property + 4]!
      }
      let envelope = def.attack > 0 ? Math.min(1, layer.age / def.attack) : 1
      const release = instance.release >= 0 ? instance.release : def.release
      if (layer.ending)
        envelope *= release > 0 ? Math.max(0, 1 - (layer.age - layer.releasedAt) / release) : 0
      for (let sendIndex = 0; sendIndex < layer.sends.length; sendIndex++) {
        const send = layer.sends[sendIndex]!
        if (!send.points.length) continue
        const value =
          send.builtin === 1
            ? instance.distance
            : send.builtin === 2
              ? instance.speed
              : (send.global ? plan.globals : instance.parameters!).values[send.parameter]!
        sampleAudioCurve(send.points, value, scratch, 4)
        send.gain = 10 ** (scratch[4]! / 20)
      }
      voice.lowpass = scratch[2]!
      voice.highpass = scratch[3]!
      voice.volume = 10 ** (scratch[0]! / 20) * envelope
      voice.pitch = 2 ** (scratch[1]! / 12) * (instance.pitchLinked ? transport.timeScale : 1)
      if (layer.ending && envelope === 0) {
        endVoice(world, audio, voice, 'stopped')
        layer.voice = null
      } else {
        live = true
        if (voice.backend !== -1) real = true
      }
    } else if (voice) layer.voice = null
    if (instance.decisionTime < def.delay) live = true
    if (!paused) layer.gate = gate
  }
  if (!live && (plan.definition.mode === 'oneshot' || instance.state === 'stopping'))
    finishInstance(world, state, instance, 'ended')
  else if (instance.state !== 'stopping') instance.state = real ? 'active' : 'virtual'
}

export const updateAudioEvents = defineSystem({
  name: 'audio/events',
  run: (_state, world) => {
    const state = audioEvents(world),
      time = world.resource(Time),
      runtime = audioState(world).backend.runtime!
    state.inFrame = true
    try {
      runtime.advance?.(time.delta)
    } finally {
      state.inFrame = false
    }
    const now = runtime.clock.now(),
      unscaled = Math.max(0, now - state.lastClock)
    state.lastClock = now
    const wall = runtime.clock.wallNow?.() ?? state.lastWall + time.delta
    const waitDelta = Math.max(0, wall - state.lastWall)
    state.lastWall = wall
    for (let b = 0; b < state.globalList.length; b++) state.globalList[b]!.update(unscaled)
    for (let i = 0; i < state.instances.length; i++) {
      const instance = state.instances[i]
      if (!instance || instance.state === 'ended' || instance.state === 'failed') continue
      if (instance.entity !== null && !world.isAlive(instance.entity)) {
        finishInstance(world, state, instance, 'removed')
        continue
      }
      if (instance.state === 'preparing' || audioState(world).backend.state === 'suspended') {
        instance.waitAge += waitDelta
        instance.wasBlocked = true
        if (
          instance.transient &&
          instance.blocked === 'drop' &&
          instance.waitAge > instance.maxAge
        ) {
          finishInstance(world, state, instance, 'expired')
          continue
        }
        continue
      }
      if (instance.wasBlocked) {
        instance.wasBlocked = false
        if (instance.blocked === 'restart') {
          instance.decisionTime = instance.sampleTime = 0
          for (let l = 0; l < instance.layers.length; l++) {
            const layer = instance.layers[l]!
            if (layer.voice && layer.voice.id > 0)
              endVoice(world, audioState(world), layer.voice, 'stopped', 0)
            layer.voice = null
            layer.cursor = layer.age = 0
            layer.triggered = layer.gate = layer.ending = false
          }
        }
        instance.waitAge = 0
      }
      updateInstance(world, state, instance, time.delta, unscaled)
    }
  },
})

export function describeAudioEvents(world: World) {
  const state = audioEvents(world)
  return {
    transport: world.resource(AudioTransport),
    pending: state.pending,
    instances: state.instances
      .filter((instance) => instance && instance.state !== 'ended')
      .map((instance) => ({
        id: instance!.id,
        event: instance!.key,
        state: instance!.state,
        error: instance!.error,
        revision: instance!.plan ? hash(instance!.plan.revision) : null,
        ordinal: instance!.ordinal,
        decisionTime: instance!.decisionTime,
        sampleTime: instance!.sampleTime,
        parameters: instance!.parameters
          ? Object.fromEntries(
              instance!.parameters.definitions.map((p, i) => [
                p.name,
                {
                  value: instance!.parameters!.values[i],
                  target: instance!.parameters!.targets[i],
                },
              ]),
            )
          : {},
      })),
    trace: state.trace.read(),
  }
}

export function audioEventsPlugin(
  options: { maxInstances?: number; decodedBudgetMiB?: number; maxPending?: number } = {},
) {
  return definePlugin({
    name: 'audio/events',
    dependencies: ['audio'],
    provides: [
      definitions,
      parameters,
      preview,
      {
        AudioTransport,
        AudioEventsState,
        TransportSchema,
        AudioCheckpoint,
        CheckpointSchema,
        installAudioCheckpoints,
      },
    ],
    build(app) {
      app.world.initResource(AudioInspectors).set('events', describeAudioEvents)
      app.addMethod(...audioEventMethods, ...preview.audioPreviewMethods)
      const world = app.world,
        audio = audioState(world),
        runtime = audio.backend.runtime
      if (!runtime)
        throw new ShardError(
          'audio/unsupported-capability',
          'audio/events needs backend runtime support',
        )
      const maxInstances = options.maxInstances ?? 256
      audioNumber(maxInstances, 'maxInstances', 1, 65536)
      audioNumber(options.maxPending ?? 2048, 'maxPending', 1, 65536)
      if (!Number.isInteger(maxInstances) || !Number.isInteger(options.maxPending ?? 2048))
        throw new ShardError('audio/invalid-range', 'Audio capacities must be integers')
      if (options.decodedBudgetMiB !== undefined) {
        audioNumber(options.decodedBudgetMiB, 'decodedBudgetMiB', 0.001, 4096)
        runtime.setDecodedBudget(options.decodedBudgetMiB * 1024 * 1024)
      }
      world.initResource(AudioTransport)
      world.initResource(AudioEvent.store)
      world.initResource(AudioCollection.store)
      world.initResource(AudioParameters.store)
      world.insertResource(AudioEventsState, {
        instances: new Array(maxInstances).fill(null),
        plans: new Map(),
        preparations: new Map(),
        nextPlan: 1,
        restoring: false,
        histories: new Map(),
        globalList: [],
        globalBanks: new Map(),
        globalRefs: new Map(),
        generation: 0,
        leases: new Map(),
        cooldowns: new Map(),
        nextId: 1,
        nextLease: 1,
        ordinal: 0,
        seed: world.tryResource(GlobalRng)?.stream('audio/events').nextU32() ?? 0,
        lastClock: runtime.clock.now(),
        lastWall: runtime.clock.wallNow?.() ?? 0,
        trace: new AudioTrace(),
        scratch: new Float64Array(8),
        disposed: false,
        inFrame: false,
        unshift: null,
        pending: 0,
        maxPending: options.maxPending ?? 2048,
        wake: null,
      })
      installAudioCheckpoints(world)
      const state = audioEvents(world),
        mixerSetup = updateAudio.setup!(world)
      const context = { lastRunTick: world.tick }
      const pump = () => {
        if (state.disposed || state.inFrame || world.tryResource(AudioCheckpointHooks)?.loading)
          return
        const time = world.tryResource(Time)
        if (!time) return
        const delta = time.delta
        time.delta = 0
        try {
          context.lastRunTick = world.tick
          updateAudioEvents.run(undefined, world, context as never)
          updateAudio.run(mixerSetup, world, context as never)
        } finally {
          time.delta = delta
        }
      }
      state.wake = runtime.clock.wake(pump, 0.025)
      state.unshift = world.observe(OriginShift, ({ data }) => {
        for (let i = 0; i < state.instances.length; i++) {
          const instance = state.instances[i]
          if (instance) {
            instance.x += data.offset[0]
            instance.y += data.offset[1]
            instance.z += data.offset[2]
          }
        }
      })
      app.addSystems(PostUpdate, updateAudioEvents.after(TransformSystems).before(updateAudio))
    },
    dispose(app) {
      const world = app.world,
        state = audioEvents(world)
      state.disposed = true
      state.generation++
      state.wake?.()
      state.unshift?.()
      for (let i = 0; i < state.instances.length; i++)
        if (state.instances[i]) finishInstance(world, state, state.instances[i]!, 'disposed')
      for (const lease of state.leases.values()) lease.release()
      state.plans.clear()
      state.globalBanks.clear()
      state.globalList.length = 0
      state.globalRefs.clear()
      state.cooldowns.clear()
      state.histories.clear()
    },
  })
}
