import { ByteReader, ByteWriter, type ComponentDef, ShardError } from '@aethervtt/shard-core'
import type { NetCommandDef, NetEventDef, ReplicationEntry } from './registry'
import type { Channel, NetConnection } from './transport'

/** Bumped when the message layout changes. */
export const PROTOCOL_VERSION = 1

/** The first byte of every message. Each is followed by a u32 tick. */
export const Msg = {
  hello: 1,
  welcome: 2,
  refused: 3,
  ping: 4,
  pong: 5,
  disconnect: 6,
  fragment: 7,
  /** Server → client, unreliable: component updates, acked by sequence. */
  state: 10,
  /** Server → client, reliable: spawns, reliable components, removals, despawns, answers, events. */
  reliable: 11,
  /** Client → server, unreliable: which state messages arrived. */
  ack: 12,
  /** Client → server, reliable. */
  command: 13,
} as const

/** Sections of a `reliable` message, in the order they're written. */
export const Section = {
  spawn: 1,
  set: 2,
  remove: 3,
  despawn: 4,
  answer: 5,
  event: 6,
  end: 0,
} as const

// Messages are at least this big; fragments carry this much less than maxMessage.
const FRAGMENT_OVERHEAD = 32

/** What both sides number by sorted name, and hash to refuse mismatched builds (0086). */
export interface Manifest {
  readonly components: readonly ReplicationEntry[]
  readonly commands: readonly NetCommandDef[]
  readonly events: readonly NetEventDef[]
  readonly hash: number
}

export function buildManifest(
  components: readonly ReplicationEntry[],
  commands: readonly NetCommandDef[],
  events: readonly NetEventDef[],
): Manifest {
  const byName = <T extends { readonly name: string }>(list: readonly T[], what: string): T[] => {
    const sorted = [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.name === sorted[i - 1]!.name) {
        throw new ShardError('net/duplicate-type', `${what} "${sorted[i]!.name}" is listed twice`)
      }
    }
    return sorted
  }
  const comps = byName(
    components.map((c) => ({ ...c, name: c.def.name })),
    'Replicated component',
  )
  const cmds = byName(commands, 'Command')
  const evts = byName(events, 'Event')
  let text = `p${PROTOCOL_VERSION}`
  for (const c of comps)
    text += `|c:${describeLayout(c.def)}:${c.mode}:${c.channel}:${JSON.stringify(c.quantize)}`
  for (const c of cmds) text += `|q:${describeLayout(c.schema)}`
  for (const e of evts) text += `|e:${describeLayout(e.schema)}`
  return { components: comps, commands: cmds, events: evts, hash: fnv1a(text) }
}

function describeLayout(def: ComponentDef): string {
  let s = `${def.name}@${def.version}`
  for (const c of def.layout) s += `,${c.name}:${c.field.kind}:${c.storage}:${c.stride}`
  return s
}

/** Names the first type two manifests disagree on, for `net/schema-mismatch`. */
export function describeManifest(m: Manifest): string[] {
  return [
    ...m.components.map((c) => `component ${describeLayout(c.def)}`),
    ...m.commands.map((c) => `command ${describeLayout(c.schema)}`),
    ...m.events.map((e) => `event ${describeLayout(e.schema)}`),
  ]
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

export function header(w: ByteWriter, kind: number, tick: number): void {
  w.reset()
  w.u8(kind)
  w.u32(tick >>> 0)
}

// ---------------------------------------------------------------------------
// Fragments

/**
 * Sends a reliable message whole, or split into fragments when it's over the transport's limit.
 * Fragments travel in order on the reliable channel, so reassembly only needs a count.
 */
export class Fragmenter {
  private nextId = 1
  private readonly scratch = new ByteWriter(256)
  private parts: Uint8Array[] = []
  private expected = 0
  private partId = 0

  send(connection: NetConnection, channel: Channel, bytes: Uint8Array, max: number): void {
    if (bytes.length <= max || channel === 'unreliable') {
      connection.send(channel, bytes)
      return
    }
    const chunk = max - FRAGMENT_OVERHEAD
    if (chunk <= 0) throw new ShardError('net/bad-message', `maxMessage ${max} is too small`)
    const count = Math.ceil(bytes.length / chunk)
    const id = this.nextId++
    for (let i = 0; i < count; i++) {
      header(this.scratch, Msg.fragment, 0)
      this.scratch.varuint(id)
      this.scratch.varuint(i)
      this.scratch.varuint(count)
      this.scratch.bytes(bytes.subarray(i * chunk, Math.min(bytes.length, (i + 1) * chunk)))
      connection.send('reliable', this.scratch.finish())
    }
  }

  /** Feeds one fragment's body; returns the whole message once the last part arrives. */
  receive(r: ByteReader): Uint8Array | undefined {
    const id = r.varuint()
    const index = r.varuint()
    const count = r.varuint()
    if (index === 0) {
      this.parts = []
      this.expected = count
      this.partId = id
    } else if (id !== this.partId || index !== this.parts.length) {
      throw new ShardError('net/bad-message', 'A fragment arrived out of order')
    }
    this.parts.push(r.bytes(r.remaining).slice())
    if (this.parts.length < this.expected) return undefined
    let size = 0
    for (const p of this.parts) size += p.length
    const out = new Uint8Array(size)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    this.parts = []
    return out
  }
}

export function badMessage(detail: string): ShardError {
  return new ShardError('net/bad-message', `Malformed network message: ${detail}`, {
    hint: 'Both sides must run the same build; the connection is closed.',
  })
}

export { ByteReader, ByteWriter }
