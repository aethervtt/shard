import { ShardError } from '@aethervtt/shard-core'
import type { NetTransport } from '@aethervtt/shard-net'
import { openSocket, SocketConnection, type SocketLike } from './socket'

export interface WebSocketTransportOptions {
  /** Defaults to 1 MiB. Larger reliable messages are split by the net core. */
  maxMessage?: number
  /** The WebSocket class. Defaults to the global one (browsers, Node 22+). */
  WebSocket?: new (
    url: string,
  ) => SocketLike
}

/**
 * Connects to a Shard server over WebSocket (0086). Every message is reliable underneath, so
 * `caps.unreliable` is false. Servers use `webSocketServer` from `@aethervtt/shard-net-websocket/server`.
 */
export function webSocketTransport(options: WebSocketTransportOptions = {}): NetTransport {
  const maxMessage = options.maxMessage ?? 1 << 20
  const Socket =
    options.WebSocket ??
    ((globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket as
      | (new (
          url: string,
        ) => SocketLike)
      | undefined)
  return {
    name: 'websocket',
    caps: { unreliable: false, maxMessage },
    async connect(address) {
      if (!Socket) {
        throw new ShardError('net/no-websocket', 'This runtime has no global WebSocket', {
          hint: 'Pass one: webSocketTransport({ WebSocket }).',
        })
      }
      const socket = new Socket(address)
      await openSocket(socket, address)
      return new SocketConnection(socket, 0, maxMessage)
    },
  }
}

export { SocketConnection, type SocketLike } from './socket'
