import {
  type ComponentDef,
  defineEvent,
  defineSchema,
  type Entity,
  type EventDef,
  type Fields,
  type InferFields,
  type Quantize,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { Replicated } from './components'
import type { PeerId } from './transport'

export type ReplicationMode = 'set' | 'interpolate'

export interface ReplicateOptions<F extends Fields = Fields> {
  /** `set` (default) writes values as they arrive; `interpolate` renders remote entities smoothly. */
  mode?: ReplicationMode
  /** `unreliable` (default) resends until acked; `reliable` arrives in order. */
  channel?: 'reliable' | 'unreliable'
  /** Float quantization per field. */
  quantize?: { readonly [K in keyof F]?: Quantize }
  /** Redaction: false keeps the component off that peer's wire. */
  visibleTo?: (world: World, peer: PeerId, entity: Entity) => boolean
}

export interface ReplicationEntry {
  readonly def: ComponentDef
  readonly mode: ReplicationMode
  readonly channel: 'reliable' | 'unreliable'
  readonly quantize: Readonly<Record<string, Quantize>>
  readonly visibleTo: ((world: World, peer: PeerId, entity: Entity) => boolean) | undefined
}

/** A component to replicate, and how (0087). Pass the result to `netPlugin({ replicate })`. */
export function replicate<F extends Fields>(
  def: ComponentDef<F>,
  options: ReplicateOptions<F> = {},
): ReplicationEntry {
  if (!def.serializable && def.name !== 'net/Replicated') {
    // Derived components rebuild themselves on every machine; replicating them fights that.
    throw new ShardError('net/not-replicable', `${def.name} is derived and can't replicate`, {
      hint: 'Replicate the components it is computed from.',
    })
  }
  return {
    def: def as ComponentDef,
    mode: options.mode ?? 'set',
    channel: options.channel ?? 'unreliable',
    quantize: (options.quantize ?? {}) as Record<string, Quantize>,
    visibleTo: options.visibleTo,
  }
}

/** Redaction helper: only the entity's owner receives the component. */
export function ownerOnly(world: World, peer: PeerId, entity: Entity): boolean {
  return ownerOf(world, entity) === peer
}

/** The peer that owns a replicated entity (0 for the server), or undefined if it isn't one. */
export function ownerOf(world: World, entity: Entity): PeerId | undefined {
  return world.tryGet(entity, Replicated)?.owner
}

// ---------------------------------------------------------------------------
// Commands and events (0089)

export interface NetCommandDef<F extends Fields = Fields> {
  readonly kind: 'net-command'
  readonly name: string
  readonly schema: ComponentDef<F>
}

export interface NetEventDef<F extends Fields = Fields> {
  readonly kind: 'net-event'
  readonly name: string
  readonly schema: ComponentDef<F>
  /** Received events are sent here: read them with `ctx.reader(def.event)`. */
  readonly event: EventDef<NetEventData<F>>
}

export interface NetEventData<F extends Fields = Fields> {
  readonly data: InferFields<F>
  /** The server tick the event was sent on. */
  readonly tick: number
}

/** A request a client sends and the server validates and answers (0089). */
export function defineNetCommand<const F extends Fields>(
  name: string,
  fields: F,
  options: { description?: string } = {},
): NetCommandDef<F> {
  return { kind: 'net-command', name, schema: defineSchema(name, fields, options) }
}

/** A message the server sends to all clients, one, or a filter (0089). */
export function defineNetEvent<const F extends Fields>(
  name: string,
  fields: F,
  options: { description?: string } = {},
): NetEventDef<F> {
  return {
    kind: 'net-event',
    name,
    schema: defineSchema(name, fields, options),
    event: defineEvent<NetEventData<F>>(name),
  }
}
