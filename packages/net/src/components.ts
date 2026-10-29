import { defineComponent, defineEvent, defineResource, t } from '@aethervtt/shard-core'
import type { PeerId } from './transport'

export const NetId = defineComponent(
  'net/NetId',
  {
    id: t.u32({
      readonly: true,
      description: 'Session-wide id the server assigned. Never reused.',
    }),
  },
  {
    description: 'The id an entity has on every machine in a session (0087).',
    serialize: false,
  },
)

export const Replicated = defineComponent(
  'net/Replicated',
  {
    prefab: t.string({
      description: 'Prefab clients spawn this entity from (path or guid); empty for a bare entity.',
    }),
    owner: t.u32({ description: 'Peer that owns it; 0 for the server.' }),
  },
  {
    description:
      'Marks a server entity for replication (0087). Add it on the server; clients never author it.',
    serialize: false,
  },
)

export const Relevance = defineComponent(
  'net/Relevance',
  {
    always: t.bool({ description: 'Every client receives it, whatever the interest policy says.' }),
    priority: t.f32({ default: 1, min: 0, description: 'Weight when bandwidth is short.' }),
  },
  { description: 'Pins or raises an entity in interest management (0087).', serialize: false },
)

export const Focus = defineComponent(
  'net/Focus',
  { peer: t.u32({ description: 'Peer whose interest centres here (a spectator camera).' }) },
  {
    description: 'An extra point of interest for a peer, besides the entities it owns (0087).',
    serialize: false,
  },
)

export type NetRoleName = 'server' | 'client'

export interface NetRoleData {
  role: NetRoleName
  /** This app's peer id: 0 on the server, assigned by the server on a client. */
  peer: PeerId
  /** Client: handshake done. Server: listening (or running locally with no transport). */
  connected: boolean
  /** The last network tick sent (server) or received (client). */
  tick: number
}

export const NetRole = defineResource<NetRoleData>('net/NetRole', {
  description: 'Which side of a session this app is, and whether it is connected (0086).',
})

export interface NetClockData {
  /** The server tick now, estimated (fractional). Equals FixedTime.tick on the server. */
  serverTick: number
  /** serverTick minus this app's FixedTime.tick, smoothed. */
  offsetTicks: number
  /** Round trip in ms. */
  rtt: number
  /** Spread of recent round trips in ms. */
  jitter: number
}

export const NetClock = defineResource<NetClockData>('net/NetClock', {
  description: 'Clock estimate against the server: tick offset, RTT and jitter (0086).',
})

export interface PeerInfo {
  readonly id: PeerId
  /** `joining`: accept or the player load is still running (0090). */
  state: 'handshake' | 'joining' | 'connected'
  rtt: number
  /** The token the client sent with hello. */
  token: string
  /** What `accept` returned as `user`: the peer's account (0090). */
  user: unknown
  joinedTick: number
}

export const Peers = defineResource<Map<PeerId, PeerInfo>>('net/Peers', {
  description: 'Server: connected peers by id (0086).',
})

export const PeerJoined = defineEvent<{ peer: PeerId; user: unknown }>('net/PeerJoined')
export const PeerLeft = defineEvent<{ peer: PeerId; reason: string; user: unknown }>('net/PeerLeft')
/** Server: a player's `store` failed (0090). The server keeps running. */
export const PlayerSaveFailed = defineEvent<{
  peer: PeerId
  user: unknown
  code: string
  message: string
}>('net/PlayerSaveFailed')
export const Connected = defineEvent<{ peer: PeerId }>('net/Connected')
export const Disconnected = defineEvent<{ code: string; message: string }>('net/Disconnected')
