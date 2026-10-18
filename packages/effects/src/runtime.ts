import {
  AnimationClips,
  type AnimationLayerValue,
  AnimationPlayer,
  animationLayer,
} from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import {
  type AudioLease,
  pauseAudioEvent,
  playAudioEvent,
  prepareAudio,
  stopAudioEvent,
} from '@aethervtt/shard-audio'
import {
  type AssetRef,
  type ComponentDef,
  type ComponentStorage,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  type Owner,
  ShardError,
  type Table,
  type TypedArray,
  type World,
} from '@aethervtt/shard-core'
import { ParticleSystem } from '@aethervtt/shard-particles'
import { descendantPaths } from '@aethervtt/shard-render'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { loadPrefab, spawnPrefab } from '@aethervtt/shard-scene'
import {
  type EffectDocument,
  EffectSequence,
  type EffectTrackValue,
  effectError,
  parseEffect,
} from './document'

export interface PreparedEffect {
  readonly id: number
  readonly document: EffectDocument
  readonly released: boolean
  release(): void
}
interface Plan extends PreparedEffect {
  world: World
  refs: number
  owner: Owner
  audio: AudioLease[]
}
interface FieldSlot {
  entity: Entity
  def: ComponentDef
  field: string
  width: number
  saved: Float64Array
  table: Table | null
  capacity: number
  row: number
  storage: ComponentStorage | null
  column: TypedArray | null
  key: string
}
interface Track {
  definition: EffectTrackValue
  entity: Entity | null
  slot: FieldSlot | null
  from: Float64Array
  to: Float64Array
  state: number
  audio: number
  layer: AnimationLayerValue | null
  seed: number
}
interface Boundary {
  time: number
  index: number
  end: boolean
}
export interface EffectInstance {
  readonly id: number
  readonly seed: number
  readonly targets: ReadonlyMap<string, Entity>
  readonly time: number
  readonly state: 'playing' | 'paused' | 'completed' | 'cancelled' | 'failed'
  readonly error: string | null
}
interface Instance extends EffectInstance {
  time: number
  state: EffectInstance['state']
  error: string | null
  plan: Plan
  owner: Owner
  ownerEntity: Entity | undefined
  tracks: Track[]
  slots: FieldSlot[]
  boundaries: Boundary[]
  claims: string[]
  cursor: number
}

/** Ring storage: recording a boundary does not allocate. Reading diagnostics does. */
class Trace {
  next = 0
  times = new Float64Array(2048)
  ids = new Float64Array(2048)
  kinds = new Array<string>(2048).fill('')
  tracks = new Array<string>(2048).fill('')
  reasons = new Array<string>(2048).fill('')
  write(id: number, time: number, kind: string, track = '', reason = ''): void {
    const s = this.next++ % 2048
    this.times[s] = time
    this.ids[s] = id
    this.kinds[s] = kind
    this.tracks[s] = track
    this.reasons[s] = reason
  }
  read(cursor: number) {
    const oldestCursor = Math.max(0, this.next - 2048)
    const entries = []
    for (let i = Math.max(oldestCursor, cursor); i < this.next; i++) {
      const s = i % 2048
      entries.push({
        cursor: i,
        instance: this.ids[s],
        time: this.times[s],
        kind: this.kinds[s],
        track: this.tracks[s],
        reason: this.reasons[s],
      })
    }
    return { entries, oldestCursor, nextCursor: this.next, truncated: cursor < oldestCursor }
  }
}

export const Effects = defineResource('effects/State', {
  init: () => ({
    plans: new Map<number, Plan>(),
    active: [] as Instance[],
    claims: new Map<string, number>(),
    plugins: new Set<string>(),
    nextId: 1,
    nextPlan: 1,
    pending: 0,
    disposed: false,
    trace: new Trace(),
  }),
})

function stateOf(world: World) {
  const state = world.tryResource(Effects)
  if (!state || state.disposed)
    effectError('Install the effects plugin in a live app', '', 'no-plugin')
  return state
}

function dropPlan(plan: Plan): void {
  if (--plan.refs !== 0) return
  for (const lease of plan.audio) lease.release()
  plan.world.owners.release(plan.owner)
  plan.world.resource(Effects).plans.delete(plan.id)
}

/** All references go through the host's catalog. Never interprets a GUID as a URL/path. */
export async function prepareEffect(world: World, source: unknown): Promise<PreparedEffect> {
  const state = stateOf(world)
  if (state.plans.size + state.pending >= 128)
    effectError('Preparation capacity (128) reached', '', 'capacity')
  state.pending++
  const id = state.nextPlan++
  const owner = world.owners.create(`effect-preparation-${id}`)
  const audio: AudioLease[] = []
  const server = assetServer(world)
  const load = async (ref: AssetRef | string, type: string) => {
    if (state.disposed) effectError('App disposed during preparation', '', 'disposed')
    const entry = server.entry(ref)
    if (!entry || entry.type !== type)
      effectError(`Expected catalog asset ${type}`, '', 'asset-missing')
    server.lease(entry.guid, owner)
    await server.load(entry.guid)
    if (entry.error || entry.state !== 'loaded')
      effectError(`Could not load ${entry.path}`, '', 'asset-failed')
    return { type, guid: entry.guid, path: entry.path }
  }
  try {
    let document: EffectDocument
    if (
      typeof source === 'string' ||
      (source &&
        typeof source === 'object' &&
        !('tracks' in source) &&
        ('guid' in source || 'path' in source))
    ) {
      const ref = await load(source as AssetRef | string, EffectSequence.name)
      document = parseEffect(
        EffectSequence.serialize(world.initResource(EffectSequence.store).require(ref)),
      )
    } else document = parseEffect(source)
    for (const target of document.targets)
      if (target.prefab) {
        if (!state.plugins.has('scene'))
          effectError('Prefab targets require the scene plugin', '/targets', 'missing-plugin')
        target.prefab = (await load(target.prefab, 'Prefab')) as AssetRef<'Prefab'>
        await loadPrefab(world, target.prefab)
      }
    for (const track of document.tracks) {
      const kind = track.kind
      if (kind === 'property' || kind === 'marker') continue
      const plugin = kind === 'audio' ? 'audio/events' : kind
      if (!state.plugins.has(plugin))
        effectError(`Track ${track.id} requires ${plugin}`, '/tracks', 'missing-plugin')
      if (kind === 'audio') {
        track.audio = (await load(track.audio!, 'audio/AudioEvent')) as AssetRef<'audio/AudioEvent'>
        audio.push(await prepareAudio(world, track.audio))
      } else if (kind === 'animation')
        track.animation = (await load(
          track.animation!,
          'AnimationClip',
        )) as AssetRef<'AnimationClip'>
      else
        track.particles = (await load(
          track.particles!,
          'ParticleEffect',
        )) as AssetRef<'ParticleEffect'>
    }
    if (state.disposed) effectError('App disposed during preparation', '', 'disposed')
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
      }
    }
    freeze(document)
    let released = false
    const plan: Plan = {
      id,
      document,
      world,
      owner,
      audio,
      refs: 1,
      get released() {
        return released
      },
      release() {
        if (!released) {
          released = true
          dropPlan(plan)
        }
      },
    }
    state.plans.set(id, plan)
    return plan
  } catch (error) {
    for (const lease of audio) lease.release()
    world.owners.release(owner)
    throw error
  } finally {
    state.pending--
  }
}

function refresh(world: World, slot: FieldSlot): boolean {
  if (!world.isAlive(slot.entity)) return false
  const table = world.entityTableUnchecked(slot.entity)
  if (slot.table !== table || slot.capacity !== table.capacity) {
    const storage = table.storage(slot.def)
    if (!storage) return false
    slot.table = table
    slot.capacity = table.capacity
    slot.storage = storage
    slot.column = storage.byName[slot.field] as TypedArray
  }
  slot.row = world.entityRowUnchecked(slot.entity)
  return true
}

function property(world: World, entity: Entity, d: EffectTrackValue, factor: number): FieldSlot {
  const def = findComponent(d.component),
    field = def?.fields[d.field]
  if (
    !def ||
    !field ||
    def.hostOnly ||
    field.options.readonly ||
    !['f32', 'f64', 'vec2', 'vec3', 'vec4', 'color'].includes(field.kind) ||
    field.stride !== d.from.length ||
    !world.has(entity, def)
  )
    effectError(`Cannot animate ${d.component}.${d.field} on ${entity}`, '', 'invalid-field')
  for (const values of [d.from, d.to])
    for (const value of values) {
      const scaled = value * factor
      if (
        !Number.isFinite(scaled) ||
        (field.storage === 'f32' && !Number.isFinite(Math.fround(scaled))) ||
        scaled < (field.options.min ?? -Infinity) ||
        scaled > (field.options.max ?? Infinity)
      )
        effectError('Scaled property endpoint exceeds schema bounds', '', 'invalid-field')
    }
  const slot: FieldSlot = {
    entity,
    def,
    field: d.field,
    width: field.stride,
    saved: new Float64Array(field.stride),
    table: null,
    capacity: 0,
    row: 0,
    storage: null,
    column: null,
    key: `${entity}:${def.id}:${d.field}`,
  }
  refresh(world, slot)
  for (let i = 0; i < slot.width; i++) slot.saved[i] = slot.column![slot.row * slot.width + i]!
  return slot
}

export interface PlayEffectOptions {
  bindings?: Readonly<Record<string, Entity>>
  parameters?: Readonly<Record<string, number>>
  seed?: number
  ownerEntity?: Entity
  /** Parent frame for owned targets; their authored transforms stay local. */
  parent?: Entity
}

/** Synchronous after preparation: validation and binding finish before any track starts. */
export function playEffect(
  world: World,
  prepared: PreparedEffect,
  options: PlayEffectOptions = {},
): EffectInstance {
  const state = stateOf(world),
    plan = state.plans.get(prepared.id)
  if (plan !== prepared || plan.released)
    effectError('Preparation is released or belongs to another app', '', 'invalid-preparation')
  if (state.active.length >= 256)
    effectError('Active instance capacity (256) reached', '', 'capacity')
  const seed = options.seed ?? 0
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    effectError('Seed must be a u32', '/seed')
  if (options.ownerEntity !== undefined && !world.isAlive(options.ownerEntity))
    effectError('Owner entity is dead', '', 'dead-target')
  if (options.parent !== undefined && !world.isAlive(options.parent))
    effectError('Parent entity is dead', '/parent', 'dead-target')
  const parameters = new Map(plan.document.parameters.map((p) => [p.id, p.value]))
  for (const [key, value] of Object.entries(options.parameters ?? {})) {
    const p = plan.document.parameters.find((p) => p.id === key)
    if (!p || !Number.isFinite(value) || value < p.min || value > p.max)
      effectError(`Invalid parameter ${key}`, '/parameters')
    parameters.set(key, value)
  }
  for (const key of Object.keys(options.bindings ?? {})) {
    const target = plan.document.targets.find((t) => t.id === key)
    if (!target || target.prefab) effectError(`Unexpected borrowed binding ${key}`, '/bindings')
  }
  const id = state.nextId++
  const owner = world.owners.create(`effect-instance-${id}`)
  const instance: Instance = {
    id,
    seed,
    plan,
    owner,
    ownerEntity: options.ownerEntity ?? options.parent,
    targets: new Map(),
    time: 0,
    state: 'playing',
    error: null,
    tracks: [],
    slots: [],
    boundaries: [],
    claims: [],
    cursor: 0,
  }
  plan.refs++
  try {
    for (const target of plan.document.targets) {
      let entity: Entity | undefined
      if (target.prefab) {
        entity = spawnPrefab(world, target.prefab, { parent: options.parent })
        // Adopting the root adopts its complete existing child tree too (0061).
        world.owners.adopt(owner, entity)
      } else entity = options.bindings?.[target.id]
      if (entity === undefined || !world.isAlive(entity))
        effectError(`Missing live binding ${target.id}`, '/bindings', 'dead-target')
      ;(instance.targets as Map<string, Entity>).set(target.id, entity)
    }
    const slots = new Map<string, FieldSlot>()
    for (let i = 0; i < plan.document.tracks.length; i++) {
      const d = plan.document.tracks[i]!
      let entity = d.kind === 'marker' ? null : instance.targets.get(d.target)!
      if (entity !== null && d.targetPath)
        entity = descendantPaths(world, entity).get(d.targetPath) ?? null
      if (d.kind !== 'marker' && entity === null)
        effectError(`Missing target path for ${d.id}`, `/tracks/${i}/targetPath`, 'dead-target')
      const factor = d.parameter ? parameters.get(d.parameter)! : 1
      let slot: FieldSlot | null = null
      if (d.kind === 'property') {
        slot = property(world, entity!, d, factor)
        const existing = slots.get(slot.key)
        if (existing) slot = existing
        else {
          if (state.claims.has(slot.key))
            effectError(
              `Field claimed by instance ${state.claims.get(slot.key)}`,
              `/tracks/${i}`,
              'conflict',
            )
          state.claims.set(slot.key, id)
          instance.claims.push(slot.key)
          slots.set(slot.key, slot)
          instance.slots.push(slot)
        }
      }
      instance.tracks.push({
        definition: d,
        entity,
        slot,
        from: Float64Array.from(d.from, (v) => v * factor),
        to: Float64Array.from(d.to, (v) => v * factor),
        state: 0,
        audio: 0,
        layer: null,
        seed: (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0,
      })
      instance.boundaries.push({ time: d.start, index: i, end: false })
      if (d.kind !== 'marker')
        instance.boundaries.push({ time: d.start + d.duration, index: i, end: true })
    }
    // Resolve every animation channel too: ownership does not make two writers safe.
    const channels = instance.tracks.map((track) => {
      if (track.slot) return [track.slot.key]
      if (track.definition.kind !== 'animation') return []
      const paths = descendantPaths(world, track.entity!)
      return world
        .resource(AnimationClips)
        .require(track.definition.animation)
        .channels.map((channel) => {
          const entity = paths.get(channel.target)
          const def = findComponent(channel.component)
          if (entity === undefined || !def || !world.has(entity, def))
            effectError('Animation channel has no live target/component', '', 'dead-target')
          const key = `${entity}:${def.id}:${channel.field}`
          const claimed = state.claims.get(key)
          if (claimed !== undefined && claimed !== id)
            effectError('Animation field already claimed', '', 'conflict')
          if (claimed === undefined) {
            state.claims.set(key, id)
            instance.claims.push(key)
          }
          return key
        })
    })
    for (let i = 0; i < instance.tracks.length; i++)
      for (let j = 0; j < i; j++) {
        const a = instance.tracks[i]!.definition,
          b = instance.tracks[j]!.definition
        if (
          a.start < b.start + b.duration - 1e-9 &&
          b.start < a.start + a.duration - 1e-9 &&
          channels[i]!.some((key) => channels[j]!.includes(key))
        )
          effectError(
            'Resolved tracks write the same field concurrently',
            `/tracks/${i}`,
            'conflict',
          )
      }
    instance.boundaries.sort((a, b) =>
      Math.abs(a.time - b.time) > 1e-9
        ? a.time - b.time
        : Number(b.end) - Number(a.end) || a.index - b.index,
    )
    state.active.push(instance)
    state.trace.write(id, 0, 'play')
    advance(world, instance, 0)
    world.tryResource(FrameDemand)?.hold('effects')
    return instance
  } catch (error) {
    finish(
      world,
      instance,
      'failed',
      error instanceof ShardError ? error.code : 'effects/activation-failed',
    )
    throw error
  }
}

function sample(world: World, track: Track, time: number): boolean {
  const d = track.definition
  if (track.entity !== null && !world.isAlive(track.entity)) return false
  if (track.slot) {
    const slot = track.slot
    if (!refresh(world, slot)) return false
    let f = Math.min(1, Math.max(0, (time - d.start) / d.duration))
    if (d.easing === 'smoothstep') f = f * f * (3 - 2 * f)
    const offset = slot.row * slot.width
    for (let k = 0; k < slot.width; k++)
      slot.column![offset + k] = track.from[k]! + (track.to[k]! - track.from[k]!) * f
    slot.storage!.changed[slot.row] = world.tick
    slot.storage!.lastChanged = world.tick
  } else if (track.layer) track.layer.time = Math.max(0, Math.min(d.duration, time - d.start))
  return true
}

function startTrack(world: World, instance: Instance, track: Track): void {
  const d = track.definition,
    entity = track.entity!
  track.state = 1
  if (d.kind === 'animation') {
    const clip = world.resource(AnimationClips).require(d.animation)
    track.layer = animationLayer(d.animation, { playing: false, loop: 'once' })
    if (!Number.isFinite(clip.duration)) effectError('Invalid animation clip', '', 'asset-failed')
    if (!world.has(entity, AnimationPlayer)) world.add(entity, AnimationPlayer)
    world.set(entity, AnimationPlayer, { layers: [track.layer] })
    track.layer = (
      world.entityTable(entity).column(AnimationPlayer, 'layers')[
        world.entityRow(entity)
      ] as AnimationLayerValue[]
    )[0]!
  } else if (d.kind === 'particles') {
    if (!world.has(entity, ParticleSystem)) world.add(entity, ParticleSystem)
    world.set(entity, ParticleSystem, { effect: d.particles, seed: track.seed, playing: true })
  } else if (d.kind === 'audio')
    track.audio = playAudioEvent(world, d.audio!, { entity, seed: track.seed })
  world
    .resource(Effects)
    .trace.write(instance.id, d.start, d.kind === 'marker' ? 'marker' : 'start', d.id, d.marker)
  if (d.kind === 'marker') track.state = 2
}

function endTrack(world: World, track: Track, teardown = false): void {
  if (track.audio) {
    stopAudioEvent(world, track.audio, { release: 0 })
    track.audio = 0
  }
  if (track.entity !== null && world.isAlive(track.entity)) {
    if (track.definition.kind === 'particles' && world.has(track.entity, ParticleSystem))
      world.remove(track.entity, ParticleSystem)
    if (teardown && track.layer && world.has(track.entity, AnimationPlayer))
      world.remove(track.entity, AnimationPlayer)
  }
  if (teardown) track.layer = null
  track.state = 2
}

function finish(
  world: World,
  instance: Instance,
  status: EffectInstance['state'],
  reason = '',
): void {
  if (
    instance.state === 'completed' ||
    instance.state === 'cancelled' ||
    instance.state === 'failed'
  )
    return
  const state = world.resource(Effects)
  instance.state = status
  instance.error = reason || null
  for (let i = 0; i < instance.tracks.length; i++) endTrack(world, instance.tracks[i]!, true)
  for (let i = 0; i < instance.slots.length; i++) {
    const slot = instance.slots[i]!
    if (refresh(world, slot)) {
      for (let k = 0; k < slot.width; k++) slot.column![slot.row * slot.width + k] = slot.saved[k]!
      slot.storage!.changed[slot.row] = world.tick
      slot.storage!.lastChanged = world.tick
    }
  }
  for (let i = 0; i < instance.claims.length; i++) state.claims.delete(instance.claims[i]!)
  world.owners.release(instance.owner)
  dropPlan(instance.plan)
  const at = state.active.indexOf(instance)
  if (at !== -1) state.active.splice(at, 1)
  state.trace.write(instance.id, instance.time, status, '', reason)
  refreshDemand(world)
}

function advance(world: World, instance: Instance, time: number): void {
  const trace = world.resource(Effects).trace
  instance.time = Math.min(time, instance.plan.document.duration)
  while (
    instance.cursor < instance.boundaries.length &&
    instance.boundaries[instance.cursor]!.time <= instance.time + 1e-9
  ) {
    const b = instance.boundaries[instance.cursor++]!,
      track = instance.tracks[b.index]!,
      d = track.definition
    if (b.end) {
      if (track.state === 1) {
        if (!sample(world, track, b.time)) effectError('Target disappeared', '', 'dead-target')
        endTrack(world, track)
        trace.write(instance.id, b.time, 'end', d.id)
      }
    } else if (
      (d.kind === 'audio' || d.kind === 'particles') &&
      d.start + d.duration <= instance.time
    ) {
      track.state = 2
      trace.write(instance.id, b.time, 'skip', d.id, 'missed-window')
    } else startTrack(world, instance, track)
  }
  for (let i = 0; i < instance.tracks.length; i++) {
    const track = instance.tracks[i]!
    if (track.state === 1 && !sample(world, track, instance.time))
      effectError('Target disappeared', '', 'dead-target')
  }
  if (instance.time >= instance.plan.document.duration - 1e-9) finish(world, instance, 'completed')
}

export function cancelEffect(world: World, id: number): boolean {
  const state = stateOf(world),
    instance = state.active.find((i) => i.id === id)
  if (!instance) return false
  finish(world, instance, 'cancelled')
  return true
}

function refreshDemand(world: World): void {
  const active = world.resource(Effects).active
  let playing = false
  for (let i = 0; i < active.length; i++)
    if (active[i]!.state === 'playing') {
      playing = true
      break
    }
  world.tryResource(FrameDemand)?.set('effects', playing)
}

export function pauseEffect(world: World, id: number, paused = true): boolean {
  const instance = stateOf(world).active.find((i) => i.id === id)
  if (!instance) return false
  instance.state = paused ? 'paused' : 'playing'
  for (const track of instance.tracks) {
    if (track.audio) pauseAudioEvent(world, track.audio, paused)
    if (track.state === 1 && track.definition.kind === 'particles' && world.isAlive(track.entity!))
      world.set(track.entity!, ParticleSystem, { playing: !paused })
  }
  refreshDemand(world)
  world.resource(Effects).trace.write(id, instance.time, paused ? 'pause' : 'resume')
  return true
}

/** Exported for isolated performance measurement; App users install effectsPlugin. */
export const updateEffects = defineSystem({
  name: 'effects/update',
  run(_, world) {
    const state = world.resource(Effects),
      delta = world.resource(Time).delta
    if (state.disposed) return
    for (let i = state.active.length - 1; i >= 0; i--) {
      const instance = state.active[i]!
      if (instance.ownerEntity !== undefined && !world.isAlive(instance.ownerEntity)) {
        finish(world, instance, 'cancelled', 'owner-removed')
        continue
      }
      let dead = false
      for (let j = 0; j < instance.tracks.length; j++) {
        const entity = instance.tracks[j]!.entity
        if (entity !== null && !world.isAlive(entity)) {
          dead = true
          break
        }
      }
      if (dead) {
        finish(world, instance, 'failed', 'effects/dead-target')
        continue
      }
      if (instance.state === 'paused') continue
      try {
        advance(world, instance, instance.time + delta)
      } catch (error) {
        finish(
          world,
          instance,
          'failed',
          error instanceof ShardError ? error.code : 'effects/update-failed',
        )
      }
    }
  },
})

export function describeEffects(world: World, cursor = 0) {
  const state = stateOf(world)
  return {
    pending: state.pending,
    preparations: [...state.plans.values()].map((p) => ({
      id: p.id,
      released: p.released,
      references: p.refs,
      duration: p.document.duration,
    })),
    instances: state.active.map((i) => ({
      id: i.id,
      state: i.state,
      time: i.time,
      seed: i.seed,
      targets: Object.fromEntries(i.targets),
    })),
    trace: state.trace.read(cursor),
  }
}

export function disposeEffects(world: World): void {
  const state = world.resource(Effects)
  while (state.active.length)
    finish(world, state.active[state.active.length - 1]!, 'cancelled', 'disposed')
  for (const plan of state.plans.values()) plan.release()
  state.disposed = true
}
