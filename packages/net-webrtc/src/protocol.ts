import type { JsonObject } from '@aethervtt/shard-core'

// The lobby protocol (0091): JSON over WebSocket. The lobby introduces peers and relays their
// WebRTC signaling; it never carries game traffic.

export interface RoomInfo {
  code: string
  meta: JsonObject
  /** Players connected through the lobby (each keeps its lobby socket while in the game). */
  peers: number
  maxPeers: number | null
}

/** Offers, answers and network candidates, passed between two peers through the lobby. */
export type SignalData =
  | { sdp: { type: string; sdp: string } }
  | { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } }

export type ToLobby =
  | { t: 'host'; meta?: JsonObject; maxPeers?: number }
  | { t: 'join'; code: string }
  /** From a host: `to` is a joiner's id. From a joiner: always to its room's host. */
  | { t: 'signal'; to?: number; data: SignalData }
  | { t: 'list' }

export type FromLobby =
  | { t: 'hosted'; code: string }
  | { t: 'joined'; id: number }
  | { t: 'joining'; id: number }
  | { t: 'left'; id: number }
  | { t: 'signal'; from: number; data: SignalData }
  | { t: 'rooms'; rooms: RoomInfo[] }
  | { t: 'error'; code: string; message: string }
  | { t: 'closed' }
