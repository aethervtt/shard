import {
  type Condition,
  condition,
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  type Fields,
  First,
  type InferFields,
  type JsonObject,
  Last,
  PreUpdate,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  type AppMethod,
  definePlugin,
  FixedTime,
  type Plugin,
  Time,
} from '@aethervtt/shard-runtime'
import { NetClient, PendingCommand } from './client'
import * as components from './components'
import { NetClock, NetRole, type NetRoleName, Replicated } from './components'
import { isConditioned, type NetConditions } from './conditions'
import { alwaysInterest, type InterestPolicy } from './interest'
import { type NetCommandDef, type NetEventDef, type ReplicationEntry, replicate } from './registry'
import {
  type AcceptResult,
  NetServer,
  type PlayerHooks,
  type ServerCommand,
  type ServerConfig,
} from './server'
import { directSession, type NetSessionProvider, type NetTransport, type PeerId } from './transport'
import { buildManifest, type Manifest } from './wire'

/** `U`: what `accept` returns as `user`; `L`: what `players.load` returns; `S`: what `capture` returns. */
export interface NetOptions<U = unknown, L = unknown, S = unknown> {
  role: NetRoleName
  /** With `address`: the transport to listen or connect on. A server without one runs locally. */
  transport?: NetTransport
  address?: string
  /** Instead of transport + address: a lobby or relay, and the room code to host or join. */
  session?: NetSessionProvider
  code?: string
  /** Server: what a lobby lists for the room (a name, a mode). */
  meta?: JsonObject
  /** Network ticks per second. Must divide the app's fixedHz. Default: 30, or fixedHz if lower. */
  tickRate?: number
  maxPeers?: number
  /** Sent with hello; the server's `accept` sees it. */
  token?: string
  /** Server: refuse a peer by returning an error. */
  /**
   * Server: admit a peer (`{ user }`, or nothing) or refuse it (a ShardError, or a throw). May be
   * async: the peer receives nothing until it settles (0090).
   */
  accept?(peer: PeerId, token: string, world: World): AcceptResult<U> | Promise<AcceptResult<U>>
  /** Server: load a player on join and save it on leave (0090). */
  players?: PlayerHooks<U, L, S>
  /** Server: seconds `accept` and `players.load` may take together. Default 15. */
  joinTimeout?: number
  replicate?: readonly ReplicationEntry[]
  commands?: readonly NetCommandDef[]
  events?: readonly NetEventDef[]
  /** Server: which entities each peer receives. Default: every replicated entity. */
  interest?: InterestPolicy
  /** Server: bytes of entity data per peer per network tick. Default: unlimited. */
  budget?: { bytesPerTick?: number }
  /** Server: commands a peer may send per second. Default 30. */
  commandsPerSecond?: number
  /** Client: spawns a replicated entity from its prefab (0087). Default: a bare entity. */
  spawnPrefab?: (world: World, prefab: string) => Entity
  /** The clock in ms (pings, rate limits). Default: frame time. */
  now?: () => number
}

export interface NetSessionData {
  readonly role: NetRoleName
  readonly manifest: Manifest
  readonly server: NetServer | undefined
  readonly client: NetClient | undefined
  readonly transport: NetTransport | undefined
  /** Server: the room code (or address) players join with, once listening. */
  code: string | undefined
  /** Settles when the server listens or the client's connection opens (not the handshake). */
  ready: Promise<void>
}

export const NetSession = defineResource<NetSessionData>('net/NetSession', {
  description: 'The running network session: role, manifest, and the server or client (0086).',
})

const receive = defineSystem({
  name: 'net/receive',
  description:
    'Drains connections: handshakes, acks, commands (server); state and events (client).',
  run(_, world) {
    const session = world.resource(NetSession)
    session.server?.receive()
    session.client?.receive()
  },
})

const interpolate = defineSystem({
  name: 'net/interpolate',
  description: 'Writes interpolated values for remote entities.',
  run(_, world) {
    world.resource(NetSession).client?.interpolate()
  },
})

const send = defineSystem({
  name: 'net/send',
  description:
    'Sends state, answers and events (server) or acks and pings (client) on network ticks.',
  run(_, world) {
    const session = world.resource(NetSession)
    session.server?.send()
    session.client?.send()
  },
})

/** The net plugin's systems, to order game systems around them. */
export const NetSystems = { receive, interpolate, send } as const

/** Multiplayer (0086, 0087, 0089): one plugin per app, as server or client. */
export function netPlugin<U = unknown, L = unknown, S = unknown>(
  options: NetOptions<U, L, S>,
): Plugin {
  let session: NetSessionData | undefined
  return definePlugin({
    name: 'net',
    provides: [components],
    build(app) {
      const fixedHz = app.fixedHz
      const tickRate = options.tickRate ?? Math.min(30, fixedHz)
      const ticksPerNet = fixedHz / tickRate
      if (!Number.isInteger(ticksPerNet) || ticksPerNet < 1) {
        throw new ShardError(
          'net/tick-rate',
          `tickRate ${tickRate} doesn't divide fixedHz ${fixedHz}`,
          {
            hint: 'Use a network rate that divides the fixed rate: 60 Hz takes 60, 30, 20, 15 or 10.',
          },
        )
      }
      const manifest = buildManifest(
        [replicate(Replicated, { channel: 'reliable' }), ...(options.replicate ?? [])],
        options.commands ?? [],
        options.events ?? [],
      )
      const world = app.world
      const now = options.now ?? (() => world.resource(Time).elapsed * 1000)
      const transport = options.transport
      const maxMessage = transport?.caps.maxMessage ?? options.session?.caps?.maxMessage ?? 1 << 20
      world.insertResource(NetRole, {
        role: options.role,
        peer: 0,
        connected: options.role === 'server' && !transport && !options.session,
        tick: 0,
      })
      let server: NetServer | undefined
      let client: NetClient | undefined
      if (options.role === 'server') {
        server = new NetServer(world, {
          manifest,
          interest: options.interest ?? alwaysInterest(),
          ticksPerNet,
          maxPeers: options.maxPeers ?? 64,
          bytesPerTick: options.budget?.bytesPerTick ?? Number.POSITIVE_INFINITY,
          maxMessage,
          commandsPerSecond: options.commandsPerSecond ?? 30,
          ...(options.accept
            ? { accept: options.accept.bind(options) as NonNullable<ServerConfig['accept']> }
            : {}),
          ...(options.players ? { players: options.players as PlayerHooks } : {}),
          joinTimeout: (options.joinTimeout ?? 15) * 1000,
          now,
        })
        world.insertResource(NetClock, { serverTick: 0, offsetTicks: 0, rtt: 0, jitter: 0 })
      } else {
        client = new NetClient(world, {
          manifest,
          ticksPerNet,
          maxMessage,
          token: options.token ?? '',
          spawnPrefab: options.spawnPrefab,
          now,
        })
      }
      session = {
        role: options.role,
        manifest,
        server,
        client,
        transport,
        code: undefined,
        ready: Promise.resolve(),
      }
      world.insertResource(NetSession, session)
      app.addSystems(First, receive)
      app.addSystems(PreUpdate, interpolate.runIf(onClient))
      app.addSystems(Last, send)
      app.addMethod(...netMethods)
    },
    ready(app) {
      const s = session!
      const provider =
        options.session ?? (options.transport ? directSession(options.transport) : undefined)
      if (!provider) return
      const role = app.world.resource(NetRole)
      if (s.server) {
        const server = s.server
        s.ready = provider
          .host({
            address: options.code ?? options.address ?? '',
            maxPeers: options.maxPeers ?? 64,
            ...(options.meta ? { meta: options.meta } : {}),
          })
          .then(({ code, listener }) => {
            server.attach(listener)
            s.code = code
            role.connected = true
          })
        return s.ready
      }
      const client = s.client!
      s.ready = provider
        .join(options.code ?? options.address ?? '', { token: options.token ?? '' })
        .then((connection) => client.attach(connection))
      // A client app starts without waiting: NetRole.connected flips after the handshake.
      s.ready.catch((err: unknown) => {
        client.lastError =
          err instanceof ShardError
            ? err
            : new ShardError('net/connect-failed', `Couldn't connect: ${String(err)}`)
      })
      return undefined
    },
    async dispose() {
      session?.client?.dispose()
      await session?.server?.dispose()
    },
  })
}

// ---------------------------------------------------------------------------
// Conditions and authority

function roleOf(world: World): NetRoleName | undefined {
  return world.tryResource(NetRole)?.role
}

/** Runs on the server, and in a game without networking. */
export const onServer: Condition = condition('net/onServer', (world) => roleOf(world) !== 'client')
/** Runs only on a client. */
export const onClient: Condition = condition('net/onClient', (world) => roleOf(world) === 'client')
/** Client: after the handshake. Server: listening (always, without a transport). */
export const connected: Condition = condition(
  'net/connected',
  (world) => world.tryResource(NetRole)?.connected ?? false,
)

/**
 * Server: saves a connected player now through `players.capture` and `players.store` (autosaves),
 * without despawning anything. Resolves when the store does (0090).
 */
export async function savePlayer(world: World, peer: PeerId): Promise<void> {
  const server = netSession(world).server
  if (!server) throw notAuthority('save players')
  await server.save(peer)
}

/** Whether this app decides the entity's state: the server always; a client for what it owns. */
export function hasAuthority(world: World, entity: Entity): boolean {
  const role = world.tryResource(NetRole)
  if (!role || role.role === 'server') return true
  return world.tryGet(entity, Replicated)?.owner === role.peer && role.peer !== 0
}

export function netSession(world: World): NetSessionData {
  const session = world.tryResource(NetSession)
  if (!session) {
    throw new ShardError('net/no-session', 'Networking is not set up in this app', {
      hint: 'Add netPlugin({ role }) to the app.',
    })
  }
  return session
}

// ---------------------------------------------------------------------------
// Commands and events (0089)

/**
 * Sends a command to the server. On the server itself (single-player, tests) it is handled
 * locally by the same systems. The answer arrives in the returned object's `status`.
 */
export function sendCommand<F extends Fields>(
  world: World,
  def: NetCommandDef<F>,
  data: Partial<InferFields<F>>,
): PendingCommand {
  const session = netSession(world)
  if (session.client) return session.client.sendCommand(def as NetCommandDef, data)
  const pending = new PendingCommand(def as NetCommandDef, 0)
  const server = session.server!
  if (server.commandIndexOf(def as NetCommandDef) === undefined) {
    throw new ShardError('net/unknown-command', `${def.name} isn't in netPlugin({ commands })`, {
      hint: 'List every net command in the plugin options on both sides.',
    })
  }
  server.local(def as NetCommandDef, data as Record<string, unknown>, (cmd) => {
    pending.status = cmd.status
    pending.error = cmd.error
  })
  return pending
}

/** Server: commands of this type waiting for an answer. Call `accept()` or `reject()` on each. */
export function commands<F extends Fields>(
  world: World,
  def: NetCommandDef<F>,
): ServerCommand<InferFields<F>>[] {
  // No networking at all: nobody can have sent one, and onServer systems still run offline.
  const session = world.tryResource(NetSession)
  if (!session) return []
  const server = session.server
  if (!server) throw notAuthority(`read ${def.name} commands`)
  return server.pending(def as NetCommandDef) as unknown as ServerCommand<InferFields<F>>[]
}

export interface SendEventOptions {
  /** `all` (default), one peer, or a filter evaluated once per peer. */
  to?: PeerId | 'all' | ((peer: PeerId) => boolean)
}

/**
 * Server: sends an event to clients (and to this world, so local code reads the same stream).
 * Clients read it with `ctx.reader(def.event)`.
 */
export function sendEvent<F extends Fields>(
  world: World,
  def: NetEventDef<F>,
  data: Partial<InferFields<F>>,
  options: SendEventOptions = {},
): void {
  const session = world.tryResource(NetSession)
  if (!session) {
    // No networking: deliver to this world only, so offline code reads the same stream.
    const tick = world.tryResource(FixedTime)?.tick ?? 0
    world.send(def.event, { data: data as never, tick })
    return
  }
  const server = session.server
  if (!server) throw notAuthority(`send ${def.name}`)
  server.sendEvent(def as NetEventDef, data as Record<string, unknown>, options.to ?? 'all')
}

function notAuthority(what: string): ShardError {
  return new ShardError('net/not-authority', `Only the server can ${what}`, {
    hint: 'Run this in a system gated with onServer.',
  })
}

// ---------------------------------------------------------------------------
// Protocol methods

const NoParams = defineSchema('net/NoParams', {})
const EntityParams = defineSchema('net/EntityParams', { entity: t.entity() })
const PeerParams = defineSchema('net/PeerParams', { peer: t.u32(), reason: t.string() })
const ConditionParams = defineSchema('net/ConditionParams', {
  latency: t.f32({ default: -1 }),
  jitter: t.f32({ default: -1 }),
  loss: t.f32({ default: -1 }),
  duplicate: t.f32({ default: -1 }),
})

const netMethods: AppMethod[] = [
  {
    name: 'net.describe',
    description: 'Role, peer, tick, clock, transport and the replicated types.',
    params: NoParams,
    handler: ({ world }) => {
      const session = netSession(world)
      return {
        ...world.resource(NetRole),
        code: session.code ?? null,
        clock: { ...world.resource(NetClock) },
        transport: session.transport
          ? { name: session.transport.name, ...session.transport.caps }
          : null,
        components: session.manifest.components.map((c) => ({
          name: c.def.name,
          mode: c.mode,
          channel: c.channel,
          redacted: c.visibleTo !== undefined,
        })),
        commands: session.manifest.commands.map((c) => c.name),
        events: session.manifest.events.map((e) => e.name),
        lastError: session.client?.lastError?.toJSON() ?? null,
      }
    },
  },
  {
    name: 'net.peers',
    description: 'Server: connected peers with RTT and traffic counters.',
    params: NoParams,
    handler: ({ world }) => {
      const server = netSession(world).server
      if (!server) return []
      return [...server.peers.values()].map((p) => ({
        id: p.info.id,
        state: p.info.state,
        rtt: p.info.rtt,
        user: p.info.user ?? null,
        joinedTick: p.info.joinedTick,
        known: p.known.size,
        relevant: p.relevant.size,
        stats: p.stats,
      }))
    },
  },
  {
    name: 'net.stats',
    description: 'Server: bytes per peer and per component, deferred entities, resends.',
    params: NoParams,
    handler: ({ world }) => {
      const server = netSession(world).server
      if (!server) return {}
      return Object.fromEntries([...server.peers.values()].map((p) => [p.id, p.stats]))
    },
  },
  {
    name: 'net.inspect',
    description: "Server: an entity's net id, owner, and per peer relevance and redaction.",
    params: EntityParams,
    handler: ({ world }, params) => {
      const server = netSession(world).server
      if (!server) throw notAuthority('inspect relevance')
      return server.inspect(params.entity as Entity)
    },
  },
  {
    name: 'net.relevance',
    description: 'Server: the entities one peer receives now.',
    params: PeerParams,
    handler: ({ world }, params) => {
      const peer = netSession(world).server?.peers.get(params.peer as number)
      return peer ? [...peer.relevant.entities] : []
    },
  },
  {
    name: 'net.commands',
    description: 'Server: recent commands with status and error code.',
    params: NoParams,
    handler: ({ world }) =>
      (netSession(world).server?.recentCommands ?? []).map((c) => ({
        name: c.def.name,
        peer: c.peer,
        tick: c.arrivedTick,
        status: c.status,
        code: c.error?.code ?? null,
      })),
  },
  {
    name: 'net.events',
    description: 'Server: recent events and their recipients.',
    params: NoParams,
    handler: ({ world }) => netSession(world).server?.recentEvents ?? [],
  },
  {
    name: 'net.conditions',
    description: 'Reads, and with params sets, simulated latency/jitter/loss (negative keeps).',
    params: ConditionParams,
    handler: ({ world }, params) => {
      const transport = netSession(world).transport
      if (!transport || !isConditioned(transport)) {
        throw new ShardError('net/no-conditions', 'This transport has no simulated conditions', {
          hint: 'Wrap the transport with simulateConditions().',
        })
      }
      const next: Partial<NetConditions> = {}
      for (const key of ['latency', 'jitter', 'loss', 'duplicate'] as const) {
        const v = params[key] as number
        if (v >= 0) next[key] = v
      }
      transport.setConditions(next)
      return transport.conditions
    },
  },
  {
    name: 'net.disconnect',
    description: 'Server: disconnects a peer.',
    params: PeerParams,
    handler: ({ world }, params) => {
      const server = netSession(world).server
      if (!server) throw notAuthority('disconnect peers')
      return server.disconnect(params.peer as number, (params.reason as string) || undefined)
    },
  },
]
