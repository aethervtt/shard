import { type JsonObject, ShardError } from '@aethervtt/shard-core'
import type {
  NetConnection,
  NetListener,
  NetSessionProvider,
  SessionInfo,
  TransportCaps,
} from '@aethervtt/shard-net'
import { failed, Negotiation, WebRtcConnection } from './connection'
import { LobbySocket, type LobbyWebSocketClass } from './lobby'

export interface WebRtcLobbyOptions {
  /** The lobby server, `ws://` or `wss://`. */
  url: string
  /** STUN and TURN servers. Without them peers connect only on the same network. */
  iceServers?: RTCIceServer[]
  /** Default: the global one (browsers). Node passes one, e.g. from `node-datachannel/polyfill`. */
  RTCPeerConnection?: typeof RTCPeerConnection
  /** Default: the global one (browsers, Node 22+). */
  WebSocket?: LobbyWebSocketClass
  /** Largest data-channel message. Default 64 KiB. */
  maxMessage?: number
  /** How long a join may take to open its channels, in ms. Default 15 s. */
  connectTimeout?: number
}

/**
 * Peer-to-peer sessions over WebRTC, introduced by a lobby (0091). Hosting gets a room code;
 * joining with it opens a direct connection to the host. Pass it as `netPlugin({ session })`.
 */
export function webRtcLobby(options: WebRtcLobbyOptions): NetSessionProvider & {
  readonly caps: TransportCaps
} {
  const maxMessage = options.maxMessage ?? 64 * 1024
  const timeout = options.connectTimeout ?? 15_000
  const config: RTCConfiguration = { iceServers: options.iceServers ?? [] }
  const Socket = options.WebSocket ?? (globalThis as { WebSocket?: LobbyWebSocketClass }).WebSocket
  const Peer =
    options.RTCPeerConnection ??
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection

  const open = () => {
    if (!Socket) {
      throw new ShardError('net/no-websocket', 'This runtime has no global WebSocket', {
        hint: 'Pass one: webRtcLobby({ WebSocket }).',
      })
    }
    return LobbySocket.open(options.url, Socket)
  }
  const peer = () => {
    if (!Peer) {
      throw new ShardError('net/no-webrtc', 'This runtime has no RTCPeerConnection', {
        hint: 'In Node, pass one: webRtcLobby({ RTCPeerConnection }) from node-datachannel/polyfill.',
      })
    }
    return new Peer(config)
  }

  return {
    name: 'webrtc-lobby',
    caps: { unreliable: true, maxMessage },

    async host(listen) {
      const lobby = await open()
      lobby.send({
        t: 'host',
        ...(listen.meta ? { meta: listen.meta } : {}),
        ...(listen.maxPeers ? { maxPeers: listen.maxPeers } : {}),
      })
      const { code } = await lobby.next('hosted')
      const fns: ((connection: NetConnection) => void)[] = []
      const joining = new Map<number, Negotiation>()
      let nextPeer = 1
      lobby.on('joined', ({ id }) => {
        const pc = peer()
        const connection = new WebRtcConnection(pc, nextPeer++, maxMessage)
        const negotiation = new Negotiation(pc, (data) => lobby.send({ t: 'signal', to: id, data }))
        joining.set(id, negotiation)
        connection.opened.then(
          () => {
            joining.delete(id)
            for (const fn of fns) fn(connection)
          },
          () => joining.delete(id),
        )
        setTimeout(() => {
          if (joining.get(id) === negotiation) connection.close()
        }, timeout)
      })
      lobby.on('signal', ({ from, data }) => joining.get(from)?.receive(data))
      lobby.on('left', ({ id }) => joining.delete(id))
      const listener: NetListener = {
        onConnection(fn) {
          fns.push(fn)
          return () => {
            const i = fns.indexOf(fn)
            if (i !== -1) fns.splice(i, 1)
          }
        },
        async close() {
          lobby.close()
        },
      }
      return { code, listener }
    },

    async join(code) {
      const lobby = await open()
      lobby.send({ t: 'join', code })
      try {
        await lobby.next('joining')
      } catch (err) {
        lobby.close()
        throw err
      }
      const pc = peer()
      const connection = new WebRtcConnection(pc, 0, maxMessage)
      const negotiation = new Negotiation(pc, (data) => lobby.send({ t: 'signal', data }))
      lobby.on('signal', ({ data }) => negotiation.receive(data))
      // The lobby counts players by their sockets: keep it until the game connection ends.
      connection.onEnd(() => lobby.close())
      lobby.onClose(() => {
        if (!opened) connection.close()
      })
      let opened = false
      negotiation.offer()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          connection.opened,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  negotiation.error ?? failed(`No connection to the host within ${timeout} ms`),
                ),
              timeout,
            )
          }),
        ])
        opened = true
      } catch (err) {
        connection.close()
        throw negotiation.error ?? err
      } finally {
        clearTimeout(timer)
      }
      return connection
    },

    async list(filter?: JsonObject): Promise<readonly SessionInfo[]> {
      const lobby = await open()
      try {
        lobby.send({ t: 'list' })
        const { rooms } = await lobby.next('rooms')
        return rooms
          .filter((r) => !filter || Object.entries(filter).every(([k, v]) => r.meta[k] === v))
          .map((r) => ({
            code: r.code,
            meta: r.meta,
            peers: r.peers,
            ...(r.maxPeers === null ? {} : { maxPeers: r.maxPeers }),
          }))
      } finally {
        lobby.close()
      }
    },
  }
}

export { Negotiation, WebRtcConnection } from './connection'
export type { LobbyWebSocket, LobbyWebSocketClass } from './lobby'
export type { FromLobby, RoomInfo, SignalData, ToLobby } from './protocol'
