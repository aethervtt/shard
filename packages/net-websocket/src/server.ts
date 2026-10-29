import type { NetConnection, NetListener, NetTransport } from '@aethervtt/shard-net'
import { WebSocketServer } from 'ws'
import { webSocketTransport } from './index'
import { SocketConnection, type SocketLike } from './socket'

export interface WebSocketServerOptions {
  /** 0 picks a free port: read it from the listener's `port`. */
  port?: number
  host?: string
  maxMessage?: number
}

export interface WebSocketListener extends NetListener {
  readonly port: number
}

/**
 * A Node WebSocket server for Shard (0086), through `ws`. It also connects out like
 * `webSocketTransport`, so one transport serves both roles in tests.
 */
export function webSocketServer(options: WebSocketServerOptions = {}): NetTransport & {
  listen(): Promise<WebSocketListener>
} {
  const maxMessage = options.maxMessage ?? 1 << 20
  const client = webSocketTransport({ maxMessage })
  return {
    name: 'websocket',
    caps: client.caps,
    connect: client.connect,
    async listen() {
      const server = new WebSocketServer({
        port: options.port ?? 0,
        host: options.host ?? '127.0.0.1',
        maxPayload: maxMessage + 1,
      })
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      const fns: ((connection: NetConnection) => void)[] = []
      let nextPeer = 1
      server.on('connection', (socket) => {
        const connection = new SocketConnection(
          socket as unknown as SocketLike,
          nextPeer++,
          maxMessage,
        )
        for (const fn of fns) fn(connection)
      })
      const address = server.address()
      return {
        port: typeof address === 'object' && address ? address.port : 0,
        onConnection(fn) {
          fns.push(fn)
          return () => {
            const i = fns.indexOf(fn)
            if (i !== -1) fns.splice(i, 1)
          }
        },
        close: () =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) socket.terminate()
            server.close(() => resolve())
          }),
      }
    },
  }
}
