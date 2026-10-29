import { Rng, type ShardError } from '@aethervtt/shard-core'
import type {
  Channel,
  ConnectionStats,
  NetConnection,
  NetListener,
  NetTransport,
  PeerId,
} from './transport'

export interface NetConditions {
  /** One-way delay in seconds, each direction. RTT is twice this. */
  latency: number
  /** Up to this many extra seconds per message, uniformly. */
  jitter: number
  /** Probability an unreliable message is dropped, each direction. */
  loss: number
  /** Probability an unreliable message arrives twice. */
  duplicate: number
  /** Unreliable messages may overtake each other under jitter. Reliable ones never do. */
  reorder: boolean
}

export interface ConditionsOptions extends Partial<NetConditions> {
  seed?: number
  /** The clock in ms. Tests pass the fake clock every app shares. */
  now?: () => number
}

/** A transport whose conditions can change at runtime (`net.conditions`). */
export interface ConditionedTransport extends NetTransport {
  readonly conditions: NetConditions
  setConditions(conditions: Partial<NetConditions>): void
}

export function isConditioned(transport: NetTransport): transport is ConditionedTransport {
  return typeof (transport as Partial<ConditionedTransport>).setConditions === 'function'
}

interface Pending {
  at: number
  channel: Channel
  bytes: Uint8Array
}

const defaultNow = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now()

class ConditionedConnection implements NetConnection {
  private readonly inner: NetConnection
  private readonly shared: Shared
  private readonly outbound: Pending[] = []
  private readonly inbound: Pending[] = []
  private readonly messageFns: ((channel: Channel, bytes: Uint8Array) => void)[] = []
  private lastReliableOut = 0
  private lastReliableIn = 0
  private lost = 0

  constructor(inner: NetConnection, shared: Shared) {
    this.inner = inner
    this.shared = shared
    inner.onMessage((channel, bytes) => {
      this.schedule(this.inbound, channel, bytes.slice(), 'in')
    })
  }

  get peer(): PeerId {
    return this.inner.peer
  }

  send(channel: Channel, bytes: Uint8Array): void {
    this.schedule(this.outbound, channel, bytes.slice(), 'out')
    // Due now (no latency): send without waiting for the next pump.
    const now = this.shared.now()
    while (this.outbound.length > 0 && this.outbound[0]!.at <= now) {
      const m = this.outbound.shift()!
      this.inner.send(m.channel, m.bytes)
    }
  }

  private schedule(queue: Pending[], channel: Channel, bytes: Uint8Array, dir: 'in' | 'out'): void {
    const c = this.shared.conditions
    const rng = this.shared.rng
    const now = this.shared.now()
    if (channel === 'unreliable' && c.loss > 0 && rng.float() < c.loss) {
      this.lost++
      return
    }
    let at = now + (c.latency + rng.float() * c.jitter) * 1000
    if (channel === 'reliable' || !c.reorder) {
      // Ordered delivery: never before the previous ordered message in this direction.
      const last = dir === 'in' ? this.lastReliableIn : this.lastReliableOut
      if (at < last) at = last
      if (dir === 'in') this.lastReliableIn = at
      else this.lastReliableOut = at
    }
    insert(queue, { at, channel, bytes })
    if (channel === 'unreliable' && c.duplicate > 0 && rng.float() < c.duplicate) {
      insert(queue, { at: at + rng.float() * c.jitter * 1000, channel, bytes })
    }
  }

  pump(): void {
    this.inner.pump?.()
    const now = this.shared.now()
    let n = 0
    while (n < this.outbound.length && this.outbound[n]!.at <= now) n++
    for (const m of this.outbound.splice(0, n)) this.inner.send(m.channel, m.bytes)
    n = 0
    while (n < this.inbound.length && this.inbound[n]!.at <= now) n++
    for (const m of this.inbound.splice(0, n)) {
      for (const fn of this.messageFns) fn(m.channel, m.bytes)
    }
  }

  onMessage(fn: (channel: Channel, bytes: Uint8Array) => void): () => void {
    this.messageFns.push(fn)
    return () => {
      const i = this.messageFns.indexOf(fn)
      if (i !== -1) this.messageFns.splice(i, 1)
    }
  }

  onClose(fn: (reason: ShardError | undefined) => void): () => void {
    return this.inner.onClose(fn)
  }

  close(reason?: string): void {
    this.inner.close(reason)
  }

  stats(): ConnectionStats {
    const s = this.inner.stats()
    return { ...s, lost: s.lost + this.lost }
  }
}

/** Keeps the queue sorted by delivery time; equal times keep insertion order. */
function insert(queue: Pending[], m: Pending): void {
  let i = queue.length
  while (i > 0 && queue[i - 1]!.at > m.at) i--
  queue.splice(i, 0, m)
}

interface Shared {
  conditions: NetConditions
  rng: Rng
  now: () => number
}

/**
 * Wraps any transport with seeded latency, jitter, loss and duplication (0086). Connections it
 * makes or accepts deliver both directions through the delay, so one wrapped side is enough.
 */
export function simulateConditions(
  transport: NetTransport,
  options: ConditionsOptions = {},
): ConditionedTransport {
  const shared: Shared = {
    conditions: {
      latency: options.latency ?? 0,
      jitter: options.jitter ?? 0,
      loss: options.loss ?? 0,
      duplicate: options.duplicate ?? 0,
      reorder: options.reorder ?? true,
    },
    rng: new Rng(options.seed ?? 1),
    now: options.now ?? defaultNow,
  }
  const wrapped: ConditionedTransport = {
    name: `${transport.name}+conditions`,
    caps: transport.caps,
    get conditions() {
      return shared.conditions
    },
    setConditions(conditions) {
      shared.conditions = { ...shared.conditions, ...conditions }
    },
    async connect(address, connectOptions) {
      return new ConditionedConnection(await transport.connect(address, connectOptions), shared)
    },
  }
  if (transport.listen) {
    const listen = transport.listen.bind(transport)
    wrapped.listen = async (listenOptions): Promise<NetListener> => {
      const inner = await listen(listenOptions)
      return {
        onConnection: (fn) =>
          inner.onConnection((connection) => fn(new ConditionedConnection(connection, shared))),
        close: () => inner.close(),
      }
    }
  }
  return wrapped
}
