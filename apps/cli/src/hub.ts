import { ShardError } from '@shard/core'
import type { JsonRpcNotification, JsonRpcResponse, ProtocolServer } from '@shard/protocol'
import { type WebSocket, WebSocketServer } from 'ws'

/** Something that answers protocol requests: a headless app in-process, or an app attached to the hub. */
export interface ProtocolTarget {
  readonly name: string
  request<T = unknown>(method: string, params?: unknown): Promise<T>
}

function unwrap<T>(response: JsonRpcResponse | undefined): T {
  if (!response) throw new ShardError('cli/no-response', 'The app did not answer')
  if (response.error) {
    const data = response.error.data as
      | { code?: string; path?: string; hint?: string; details?: unknown }
      | undefined
    throw new ShardError(data?.code ?? 'protocol/error', response.error.message, {
      path: data?.path,
      hint: data?.hint,
    })
  }
  return response.result as T
}

/** A target backed by an in-process protocol server (headless project). */
export function localTarget(name: string, server: ProtocolServer): ProtocolTarget {
  let id = 1
  return {
    name,
    request: async <T>(method: string, params?: unknown) =>
      unwrap<T>(await server.handle({ jsonrpc: '2.0', id: id++, method, params })),
  }
}

interface Attached {
  socket: WebSocket
  name: string
  pending: Map<number, (response: JsonRpcResponse) => void>
}

/**
 * The protocol hub: apps (Studio, a browser tab, anything with `connectToHub`) dial in over
 * WebSocket; the CLI and MCP server send requests to the most recently attached app.
 */
export class Hub {
  private server: WebSocketServer | undefined
  private readonly apps: Attached[] = []
  private nextId = 1
  private readonly notificationListeners = new Set<(from: string, n: JsonRpcNotification) => void>()
  private readonly attachListeners = new Set<(name: string, attached: boolean) => void>()

  /** Starts listening (localhost only). Resolves with the port. */
  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port })
      server.once('error', reject)
      server.once('listening', () => {
        this.server = server
        resolve((server.address() as { port: number }).port)
      })
      server.on('connection', (socket) => this.accept(socket))
    })
  }

  /** The most recently attached app, if any. */
  current(): ProtocolTarget | undefined {
    const app = this.apps.at(-1)
    return app ? this.targetFor(app) : undefined
  }

  /** Every attached app. */
  all(): ProtocolTarget[] {
    return this.apps.map((a) => this.targetFor(a))
  }

  private targetFor(app: Attached): ProtocolTarget {
    return {
      name: app.name,
      request: <T>(method: string, params?: unknown) =>
        new Promise<T>((resolve, reject) => {
          const id = this.nextId++
          app.pending.set(id, (response) => {
            try {
              resolve(unwrap<T>(response))
            } catch (err) {
              reject(err)
            }
          })
          app.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        }),
    }
  }

  attachedNames(): string[] {
    return this.apps.map((a) => a.name)
  }

  onAttach(listener: (name: string, attached: boolean) => void): () => void {
    this.attachListeners.add(listener)
    return () => this.attachListeners.delete(listener)
  }

  onNotification(listener: (from: string, n: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  close(): void {
    for (const app of this.apps) app.socket.close()
    this.server?.close()
  }

  private accept(socket: WebSocket): void {
    let app: Attached | undefined
    socket.on('message', (raw) => {
      let msg: { id?: number; method?: string; params?: { name?: string } } & JsonRpcResponse
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.method === 'hello') {
        app = { socket, name: msg.params?.name ?? 'app', pending: new Map() }
        this.apps.push(app)
        for (const l of this.attachListeners) l(app.name, true)
        return
      }
      if (!app) return
      if (msg.method) {
        for (const l of this.notificationListeners)
          l(app.name, msg as unknown as JsonRpcNotification)
        return
      }
      const resolve = typeof msg.id === 'number' ? app.pending.get(msg.id) : undefined
      if (resolve) {
        app.pending.delete(msg.id as number)
        resolve(msg)
      }
    })
    socket.on('close', () => {
      if (!app) return
      const i = this.apps.indexOf(app)
      if (i !== -1) this.apps.splice(i, 1)
      for (const [, resolve] of app.pending) {
        resolve({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: `${app.name} disconnected` },
        })
      }
      for (const l of this.attachListeners) l(app.name, false)
    })
  }
}
