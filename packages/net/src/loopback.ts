import { ShardError } from '@aethervtt/shard-core'
import type {
  Channel,
  ConnectionStats,
  NetConnection,
  NetListener,
  NetTransport,
  PeerId,
} from './transport'

export interface LoopbackOptions {
  /** Defaults to 1 MiB. Tests lower it to exercise fragmenting. */
  maxMessage?: number
}

type MessageFn = (channel: Channel, bytes: Uint8Array) => void
type CloseFn = (reason: ShardError | undefined) => void

class LoopbackEnd implements NetConnection {
  readonly peer: PeerId
  other: LoopbackEnd | undefined
  private readonly messageFns: MessageFn[] = []
  private readonly closeFns: CloseFn[] = []
  private readonly counters: ConnectionStats = { rtt: 0, sentBytes: 0, receivedBytes: 0, lost: 0 }
  private open = true
  private readonly maxMessage: number

  constructor(peer: PeerId, maxMessage: number) {
    this.peer = peer
    this.maxMessage = maxMessage
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (!this.open) return
    if (bytes.length > this.maxMessage) throw tooLarge(bytes.length, this.maxMessage)
    this.counters.sentBytes += bytes.length
    this.other?.receive(channel, bytes.slice())
  }

  receive(channel: Channel, bytes: Uint8Array): void {
    if (!this.open) return
    this.counters.receivedBytes += bytes.length
    for (const fn of this.messageFns) fn(channel, bytes)
  }

  onMessage(fn: MessageFn): () => void {
    this.messageFns.push(fn)
    return () => remove(this.messageFns, fn)
  }

  onClose(fn: CloseFn): () => void {
    this.closeFns.push(fn)
    return () => remove(this.closeFns, fn)
  }

  close(reason?: string): void {
    if (!this.open) return
    this.shut(undefined)
    this.other?.shut(
      new ShardError('net/transport-closed', reason ?? 'The other side closed the connection'),
    )
  }

  shut(reason: ShardError | undefined): void {
    if (!this.open) return
    this.open = false
    for (const fn of [...this.closeFns]) fn(reason)
  }

  stats(): ConnectionStats {
    return { ...this.counters }
  }
}

function remove<T>(list: T[], item: T): void {
  const i = list.indexOf(item)
  if (i !== -1) list.splice(i, 1)
}

export function tooLarge(size: number, max: number): ShardError {
  return new ShardError('net/message-too-large', `A ${size}-byte message is over ${max} bytes`, {
    hint: 'Reliable messages are split automatically; keep unreliable ones under maxMessage.',
  })
}

/**
 * An in-process transport (0086): a server App and client Apps in one process connect by address.
 * Delivery is immediate; wrap it in `simulateConditions` for latency and loss.
 */
export function loopback(options: LoopbackOptions = {}): NetTransport {
  const maxMessage = options.maxMessage ?? 1 << 20
  const listeners = new Map<string, (end: LoopbackEnd) => void>()
  let nextPeer = 1
  return {
    name: 'loopback',
    caps: { unreliable: true, maxMessage },
    async connect(address) {
      const accept = listeners.get(address)
      if (!accept) {
        throw new ShardError('net/connect-failed', `Nothing listens at "${address}"`, {
          hint: 'Start the server (role: "server") before connecting clients.',
        })
      }
      const client = new LoopbackEnd(0, maxMessage)
      const server = new LoopbackEnd(nextPeer++, maxMessage)
      client.other = server
      server.other = client
      accept(server)
      return client
    },
    async listen(options): Promise<NetListener> {
      const address = options.address ?? ''
      if (listeners.has(address)) {
        throw new ShardError('net/address-in-use', `Something already listens at "${address}"`)
      }
      const fns: ((connection: NetConnection) => void)[] = []
      listeners.set(address, (end) => {
        for (const fn of fns) fn(end)
      })
      return {
        onConnection(fn) {
          fns.push(fn)
          return () => remove(fns, fn)
        },
        async close() {
          listeners.delete(address)
        },
      }
    },
  }
}
