import { ShardError } from '@aethervtt/shard-core'
import type { Channel, ConnectionStats, NetConnection, PeerId } from '@aethervtt/shard-net'

/** What both a browser `WebSocket` and a `ws` socket offer. */
export interface SocketLike {
  readonly readyState: number
  binaryType: string
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', fn: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', fn: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', fn: (event: unknown) => void): void
}

const OPEN = 1
const CHANNELS: readonly Channel[] = ['reliable', 'unreliable']

/**
 * One WebSocket as a net connection. Each frame starts with a channel byte; both channels are
 * reliable underneath (`caps.unreliable` is false).
 */
export class SocketConnection implements NetConnection {
  readonly peer: PeerId
  private readonly socket: SocketLike
  private readonly maxMessage: number
  private readonly messageFns: ((channel: Channel, bytes: Uint8Array) => void)[] = []
  private readonly closeFns: ((reason: ShardError | undefined) => void)[] = []
  private readonly counters: ConnectionStats = { rtt: 0, sentBytes: 0, receivedBytes: 0, lost: 0 }
  private closed = false
  private closing = false

  constructor(socket: SocketLike, peer: PeerId, maxMessage: number) {
    this.socket = socket
    this.peer = peer
    this.maxMessage = maxMessage
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('message', (event) => {
      const data = event.data
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : undefined
      if (!bytes || bytes.length < 1) return
      this.counters.receivedBytes += bytes.length
      const channel = CHANNELS[bytes[0]!] ?? 'reliable'
      const body = bytes.subarray(1)
      for (const fn of this.messageFns) fn(channel, body)
    })
    socket.addEventListener('close', (event) => {
      this.shut(
        this.closing
          ? undefined
          : new ShardError(
              'net/transport-closed',
              event.reason || `WebSocket closed (${event.code})`,
            ),
      )
    })
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (this.closed || this.socket.readyState !== OPEN) return
    if (bytes.length > this.maxMessage) {
      throw new ShardError(
        'net/message-too-large',
        `A ${bytes.length}-byte message is over ${this.maxMessage} bytes`,
        {
          hint: 'Reliable messages are split automatically; keep unreliable ones under maxMessage.',
        },
      )
    }
    const frame = new Uint8Array(bytes.length + 1)
    frame[0] = channel === 'reliable' ? 0 : 1
    frame.set(bytes, 1)
    this.counters.sentBytes += frame.length
    this.socket.send(frame)
  }

  onMessage(fn: (channel: Channel, bytes: Uint8Array) => void): () => void {
    this.messageFns.push(fn)
    return () => remove(this.messageFns, fn)
  }

  onClose(fn: (reason: ShardError | undefined) => void): () => void {
    this.closeFns.push(fn)
    return () => remove(this.closeFns, fn)
  }

  close(reason?: string): void {
    if (this.closed) return
    this.closing = true
    this.socket.close(1000, reason?.slice(0, 120))
    this.shut(undefined)
  }

  private shut(reason: ShardError | undefined): void {
    if (this.closed) return
    this.closed = true
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

/** Opens a socket and resolves once it's open. */
export function openSocket(socket: SocketLike, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === OPEN) return resolve()
    let settled = false
    const open = socket as unknown as { addEventListener(type: 'open', fn: () => void): void }
    open.addEventListener('open', () => {
      settled = true
      resolve()
    })
    socket.addEventListener('error', () => {
      if (settled) return
      settled = true
      reject(
        new ShardError('net/connect-failed', `Couldn't open a WebSocket to ${address}`, {
          hint: 'Check the server is listening and the URL (ws:// or wss://) is right.',
        }),
      )
    })
  })
}
