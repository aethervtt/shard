import { type JsonObject, ShardError } from '@aethervtt/shard-core'

/** `reliable` arrives once and in order; `unreliable` may be lost, duplicated or reordered. */
export type Channel = 'reliable' | 'unreliable'

/** Assigned by a listener; unique among its connections. 0 is the server itself. */
export type PeerId = number

export interface TransportCaps {
  /** False when every message is reliable (WebSocket): unreliable sends go reliable. */
  readonly unreliable: boolean
  /** The largest message `send` accepts, in bytes. The net core splits bigger reliable messages. */
  readonly maxMessage: number
}

export interface ConnectionStats {
  /** Round trip in ms, if the transport measures one (the net core measures its own). */
  rtt: number
  sentBytes: number
  receivedBytes: number
  /** Unreliable messages known lost (sent but dropped), when the transport can tell. */
  lost: number
}

export interface ConnectOptions {
  /** Passed to the transport (a relay or lobby may check it). The handshake sends its own. */
  token?: string
}

export interface ListenOptions {
  address?: string
  maxPeers?: number
  /** What a lobby lists for the room (a name, a mode). Transports ignore it. */
  meta?: JsonObject
}

/**
 * Moves bytes between peers (0086): loopback, WebSocket, and later WebRTC or Steam. A transport
 * never touches a world. Messages it receives wait in the connection until the net core drains them.
 */
export interface NetTransport {
  readonly name: string
  readonly caps: TransportCaps
  connect(address: string, options?: ConnectOptions): Promise<NetConnection>
  listen?(options: ListenOptions): Promise<NetListener>
}

export interface NetListener {
  onConnection(fn: (connection: NetConnection) => void): () => void
  close(): Promise<void>
}

export interface NetConnection {
  readonly peer: PeerId
  /** The transport copies `bytes` before returning: the caller reuses its buffer. */
  send(channel: Channel, bytes: Uint8Array): void
  onMessage(fn: (channel: Channel, bytes: Uint8Array) => void): () => void
  onClose(fn: (reason: ShardError | undefined) => void): () => void
  close(reason?: string): void
  stats(): ConnectionStats
  /**
   * Delivers messages that are due. The net core calls it once per frame before draining; a
   * transport that delivers on its own (a socket) leaves it out.
   */
  pump?(): void
}

/** Room codes, lobbies, relays and signaling: how peers find each other (0086). */
export interface NetSessionProvider {
  readonly name: string
  /** Limits of the connections it makes, when they differ from a plain transport's. */
  readonly caps?: TransportCaps
  host(options: ListenOptions): Promise<{ code: string; listener: NetListener }>
  join(code: string, options?: ConnectOptions): Promise<NetConnection>
  list?(filter?: JsonObject): Promise<readonly SessionInfo[]>
}

export interface SessionInfo {
  code: string
  name?: string
  peers?: number
  maxPeers?: number
  meta?: JsonObject
}

/** A session whose code is the transport address: no lobby, peers share a URL. */
export function directSession(transport: NetTransport, address = ''): NetSessionProvider {
  return {
    name: `direct:${transport.name}`,
    caps: transport.caps,
    async host(options) {
      if (!transport.listen) throw notListening(transport)
      const listener = await transport.listen({ ...options, address: options.address ?? address })
      return { code: options.address ?? address, listener }
    },
    join: (code, options) => transport.connect(code, options),
  }
}

export function notListening(transport: NetTransport): ShardError {
  return new ShardError('net/cannot-listen', `The ${transport.name} transport can't listen`, {
    hint: 'Servers need a transport with listen(), such as webSocketServer() or loopback().',
  })
}
