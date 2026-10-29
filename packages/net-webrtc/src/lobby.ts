import { ShardError } from '@aethervtt/shard-core'
import type { FromLobby, ToLobby } from './protocol'

/** What a browser `WebSocket` (and Node 22's global one) offers. */
export interface LobbyWebSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open', fn: () => void): void
  addEventListener(type: 'message', fn: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', fn: () => void): void
  addEventListener(type: 'error', fn: () => void): void
}

export type LobbyWebSocketClass = new (url: string) => LobbyWebSocket

type Handler = (message: FromLobby) => void

/** A JSON connection to the lobby, with waiting for one reply by type. */
export class LobbySocket {
  private readonly socket: LobbyWebSocket
  private readonly handlers = new Map<string, Handler[]>()
  private readonly closeFns: (() => void)[] = []
  closed = false

  private constructor(socket: LobbyWebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      let message: FromLobby
      try {
        message = JSON.parse(String(event.data)) as FromLobby
      } catch {
        return
      }
      for (const fn of [...(this.handlers.get(message.t) ?? [])]) fn(message)
      for (const fn of [...(this.handlers.get('*') ?? [])]) fn(message)
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const fn of this.closeFns.splice(0)) fn()
    })
  }

  static open(url: string, Socket: LobbyWebSocketClass): Promise<LobbySocket> {
    return new Promise((resolve, reject) => {
      const socket = new Socket(url)
      let settled = false
      socket.addEventListener('open', () => {
        settled = true
        resolve(new LobbySocket(socket))
      })
      const fail = () => {
        if (settled) return
        settled = true
        reject(
          new ShardError('net/connect-failed', `Couldn't reach the lobby at ${url}`, {
            hint: 'Check the lobby server is running and the URL (ws:// or wss://).',
          }),
        )
      }
      socket.addEventListener('error', fail)
      socket.addEventListener('close', fail)
    })
  }

  send(message: ToLobby): void {
    if (!this.closed) this.socket.send(JSON.stringify(message))
  }

  on<T extends FromLobby['t']>(type: T, fn: (message: Extract<FromLobby, { t: T }>) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(fn as Handler)
    this.handlers.set(type, list)
  }

  onClose(fn: () => void): void {
    if (this.closed) fn()
    else this.closeFns.push(fn)
  }

  /** The next message of `type`; an `error` message or a close rejects. */
  next<T extends FromLobby['t']>(type: T): Promise<Extract<FromLobby, { t: T }>> {
    return new Promise((resolve, reject) => {
      const done = () => {
        this.off(type, onMessage)
        this.off('error', onError)
      }
      const onMessage: Handler = (m) => {
        done()
        resolve(m as Extract<FromLobby, { t: T }>)
      }
      const onError: Handler = (m) => {
        done()
        const e = m as Extract<FromLobby, { t: 'error' }>
        reject(new ShardError(e.code, e.message))
      }
      this.on(type, onMessage as never)
      this.on('error', onError as never)
      this.onClose(() => {
        done()
        reject(new ShardError('net/lobby-closed', 'The lobby connection closed'))
      })
    })
  }

  private off(type: string, fn: Handler): void {
    const list = this.handlers.get(type)
    const i = list?.indexOf(fn) ?? -1
    if (i !== -1) list!.splice(i, 1)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.close()
    for (const fn of this.closeFns.splice(0)) fn()
  }
}
