import { randomInt } from 'node:crypto'
import type { JsonObject } from '@aethervtt/shard-core'
import { type WebSocket, WebSocketServer } from 'ws'
import type { FromLobby, RoomInfo, ToLobby } from './protocol'

export interface LobbyServerOptions {
  /** 0 picks a free port: read it from `port`. */
  port?: number
  host?: string
  /** Rooms at most. Default 10,000. */
  maxRooms?: number
}

export interface LobbyServer {
  readonly port: number
  rooms(): RoomInfo[]
  close(): Promise<void>
}

interface Client {
  readonly id: number
  readonly socket: WebSocket
  room: Room | undefined
}

interface Room {
  readonly code: string
  readonly host: Client
  readonly meta: JsonObject
  readonly maxPeers: number | null
  readonly joiners: Map<number, Client>
}

// No look-alikes: 0/O, 1/I/L.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * The lobby (0091): room codes, a room list, and signaling between a room's host and its joiners.
 * Game traffic never passes through it.
 */
export async function lobbyServer(options: LobbyServerOptions = {}): Promise<LobbyServer> {
  const server = new WebSocketServer({
    port: options.port ?? 0,
    host: options.host ?? '127.0.0.1',
    maxPayload: 64 * 1024,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const rooms = new Map<string, Room>()
  const maxRooms = options.maxRooms ?? 10_000
  let nextId = 1

  const send = (client: Client, message: FromLobby) => {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(message))
  }
  const error = (client: Client, code: string, message: string) =>
    send(client, { t: 'error', code, message })
  const info = (room: Room): RoomInfo => ({
    code: room.code,
    meta: room.meta,
    peers: room.joiners.size,
    maxPeers: room.maxPeers,
  })
  const newCode = () => {
    for (;;) {
      let code = ''
      for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)]
      if (!rooms.has(code)) return code
    }
  }

  server.on('connection', (socket) => {
    const client: Client = { id: nextId++, socket, room: undefined }
    socket.on('message', (raw) => {
      let message: ToLobby
      try {
        message = JSON.parse(String(raw)) as ToLobby
      } catch {
        error(client, 'net/bad-lobby-message', 'Lobby messages are JSON')
        return
      }
      switch (message.t) {
        case 'host': {
          if (client.room) return error(client, 'net/bad-lobby-message', 'Already in a room')
          if (rooms.size >= maxRooms) return error(client, 'net/room-full', 'The lobby is full')
          const room: Room = {
            code: newCode(),
            host: client,
            meta: message.meta ?? {},
            maxPeers: message.maxPeers ?? null,
            joiners: new Map(),
          }
          rooms.set(room.code, room)
          client.room = room
          return send(client, { t: 'hosted', code: room.code })
        }
        case 'join': {
          if (client.room) return error(client, 'net/bad-lobby-message', 'Already in a room')
          const room = rooms.get(String(message.code).toUpperCase())
          if (!room) return error(client, 'net/room-not-found', `No room ${message.code}`)
          if (room.maxPeers !== null && room.joiners.size >= room.maxPeers) {
            return error(client, 'net/room-full', `Room ${room.code} is full`)
          }
          room.joiners.set(client.id, client)
          client.room = room
          send(room.host, { t: 'joined', id: client.id })
          return send(client, { t: 'joining', id: client.id })
        }
        case 'signal': {
          const room = client.room
          if (!room) return error(client, 'net/bad-lobby-message', 'Join or host a room first')
          if (room.host === client) {
            const to = room.joiners.get(Number(message.to))
            if (to) send(to, { t: 'signal', from: client.id, data: message.data })
          } else send(room.host, { t: 'signal', from: client.id, data: message.data })
          return
        }
        case 'list':
          return send(client, { t: 'rooms', rooms: [...rooms.values()].map(info) })
        default:
          return error(client, 'net/bad-lobby-message', 'Unknown lobby message')
      }
    })
    socket.on('close', () => {
      const room = client.room
      if (!room) return
      if (room.host === client) {
        rooms.delete(room.code)
        for (const joiner of room.joiners.values()) {
          send(joiner, { t: 'closed' })
          joiner.room = undefined
        }
      } else {
        room.joiners.delete(client.id)
        send(room.host, { t: 'left', id: client.id })
      }
    })
  })

  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    rooms: () => [...rooms.values()].map(info),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate()
        server.close(() => resolve())
      }),
  }
}
