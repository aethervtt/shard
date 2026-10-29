import {
  ByteReader,
  ByteWriter,
  ChildOf,
  createRowCodec,
  type Entity,
  type EntityMapping,
  onRemove,
  type Query,
  type RowCodec,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { FixedTime, LogResource } from '@aethervtt/shard-runtime'
import {
  Focus,
  NetId,
  NetRole,
  type PeerInfo,
  PeerJoined,
  PeerLeft,
  Peers,
  PlayerSaveFailed,
  Relevance,
  Replicated,
} from './components'
import { type InterestPeer, type InterestPolicy, RelevanceSet } from './interest'
import type { NetCommandDef, NetEventDef } from './registry'
import type { Channel, NetConnection, NetListener, PeerId } from './transport'
import { NumberList } from './vec'
import {
  badMessage,
  describeManifest,
  Fragmenter,
  header,
  type Manifest,
  Msg,
  PROTOCOL_VERSION,
  Section,
} from './wire'

/** What `accept` returns: `{ user }` (or nothing) admits, a ShardError refuses (0090). */
export type AcceptResult<U = unknown> = { readonly user?: U } | ShardError | undefined

export interface JoinContext<U = unknown> {
  readonly peer: PeerId
  readonly user: U
  readonly token: string
}

export interface LeaveContext<U = unknown> {
  readonly peer: PeerId
  readonly user: U
  /** Entities whose `Replicated.owner` is the peer. */
  readonly owned: readonly Entity[]
}

/**
 * Loading and saving a player around a session (0090). The async hooks never get the world;
 * the ones that get the world are synchronous, so nothing reads it after an `await`.
 */
export interface PlayerHooks<U = unknown, L = unknown, S = unknown> {
  /** Async: fetch what the player needs (a character row). Runs after accept, before welcome. */
  load?(ctx: JoinContext<U>): L | Promise<L>
  /** Sync, in `net/receive`: spawn the player's entities, owned by `ctx.peer`. */
  spawn?(world: World, ctx: JoinContext<U> & { readonly data: L }): void
  /** Sync: read what to save from the owned entities, before they're despawned. */
  capture?(world: World, ctx: LeaveContext<U>): S
  /** Async: write it. A rejection fires `PlayerSaveFailed`. */
  store?(ctx: { readonly peer: PeerId; readonly user: U; readonly data: S }): void | Promise<void>
  /** Despawn the owned entities when the player leaves. Default true. */
  despawn?: boolean
}

export interface ServerConfig {
  readonly manifest: Manifest
  readonly interest: InterestPolicy
  readonly ticksPerNet: number
  readonly maxPeers: number
  readonly bytesPerTick: number
  readonly maxMessage: number
  readonly commandsPerSecond: number
  readonly accept?: (
    peer: PeerId,
    token: string,
    world: World,
  ) => AcceptResult | Promise<AcceptResult>
  readonly players?: PlayerHooks
  /** Milliseconds for accept + load before `net/join-timeout`. */
  readonly joinTimeout: number
  readonly now: () => number
}

/** What one peer has of one entity, as far as the server knows. */
interface Known {
  readonly netId: number
  readonly entity: Entity
  /** Per manifest component: on the client. */
  readonly present: Uint8Array
  /** Per component: the change tick last sent, and the newest one the client confirmed. */
  readonly sent: Uint32Array
  readonly acked: Uint32Array
  /** Per component: the fixed tick it was last sent on, for resends. */
  readonly sentAt: Float64Array
  /** The fixed tick anything of it was last sent: older entities go first under a budget. */
  lastSent: number
}

interface PacketRecord {
  seq: number
  acked: boolean
  readonly netIds: NumberList
  readonly comps: NumberList
  readonly ticks: NumberList
}

const PACKET_RING = 64

/** A command the server received, until a system answers it (0089). */
export class ServerCommand<T = Record<string, unknown>> {
  readonly def: NetCommandDef
  readonly peer: PeerId
  readonly seq: number
  readonly data: T
  readonly arrivedTick: number
  status: 'pending' | 'accepted' | 'rejected' = 'pending'
  error: ShardError | undefined
  private readonly answer: (cmd: ServerCommand<T>) => void

  constructor(
    def: NetCommandDef,
    peer: PeerId,
    seq: number,
    data: T,
    arrivedTick: number,
    answer: (cmd: ServerCommand<T>) => void,
  ) {
    this.def = def
    this.peer = peer
    this.seq = seq
    this.data = data
    this.arrivedTick = arrivedTick
    this.answer = answer
  }

  accept(): void {
    if (this.status !== 'pending') return
    this.status = 'accepted'
    this.answer(this)
  }

  reject(code: string, message = code, hint?: string): void {
    if (this.status !== 'pending') return
    this.status = 'rejected'
    this.error = new ShardError(code, message, hint === undefined ? {} : { hint })
    this.answer(this)
  }
}

interface QueuedEvent {
  readonly index: number
  readonly data: Record<string, unknown>
  readonly to: PeerId | 'all' | ((peer: PeerId) => boolean)
}

interface Answer {
  seq: number
  error: ShardError | undefined
}

export interface PeerStats {
  bytesSent: number
  bytesByComponent: Record<string, number>
  deferred: number
  resends: number
  commands: number
  rejected: number
}

class PeerState implements InterestPeer {
  readonly id: PeerId
  readonly info: PeerInfo
  readonly connection: NetConnection
  readonly fragmenter = new Fragmenter()
  readonly inbox: { channel: Channel; bytes: Uint8Array }[] = []
  readonly known = new Map<number, Known>()
  relevant = new RelevanceSet()
  /** Last tick's relevant set, for hysteresis (`knows`). */
  previous = new RelevanceSet()
  readonly focus: Entity[] = []
  readonly packets: PacketRecord[] = []
  readonly answers: Answer[] = []
  nextSeq = 1
  closed: string | undefined
  /** When the join started (config.now), for the timeout. */
  joinStarted = 0
  /** Command rate limit: tokens refill at commandsPerSecond. */
  tokens: number
  lastRefill = 0
  readonly stats: PeerStats = {
    bytesSent: 0,
    bytesByComponent: {},
    deferred: 0,
    resends: 0,
    commands: 0,
    rejected: 0,
  }

  constructor(connection: NetConnection, id: PeerId, tick: number, tokens: number) {
    this.id = id
    this.connection = connection
    this.tokens = tokens
    this.info = {
      id,
      state: 'handshake',
      rtt: 0,
      token: '',
      user: undefined,
      joinedTick: tick,
    }
    for (let i = 0; i < PACKET_RING; i++) {
      this.packets.push({
        seq: 0,
        acked: true,
        netIds: new NumberList(),
        comps: new NumberList(),
        ticks: new NumberList(),
      })
    }
  }

  /** Whether the peer had the entity after the last network tick. */
  knows(entity: Entity): boolean {
    return this.previous.has(entity)
  }
}

export class NetServer {
  readonly world: World
  readonly config: ServerConfig
  readonly peers = new Map<PeerId, PeerState>()
  /** The same peers as an array, so per-frame loops don't allocate iterators. */
  private readonly peerList: PeerState[] = []
  readonly byNetId = new Map<number, Entity>()
  readonly commands: ServerCommand[] = []
  /** Recent commands for `net.commands`. */
  readonly recentCommands: ServerCommand[] = []
  readonly recentEvents: { name: string; tick: number; to: string }[] = []
  private nextNetId = 1
  private nextPeer = 1
  /** Joins whose async accept/load finished, applied in the next receive. */
  private readonly settled: JoinOutcome[] = []
  private readonly saveFailures: { peer: PeerId; user: unknown; error: ShardError }[] = []
  private readonly stores = new Set<Promise<unknown>>()
  private readonly incoming: PeerState[] = []
  private readonly events: QueuedEvent[] = []
  private readonly codecs: RowCodec[]
  private readonly commandCodecs: RowCodec[]
  private readonly eventCodecs: RowCodec[]
  private readonly commandIndex = new Map<string, number>()
  private readonly eventIndex = new Map<string, number>()
  private readonly reader = new ByteReader()
  private readonly out = new ByteWriter(4096)
  private readonly state = new ByteWriter(4096)
  private readonly spawns = new ByteWriter(1024)
  private readonly sets = new ByteWriter(4096)
  private readonly removes = new ByteWriter(256)
  private readonly despawns = new ByteWriter(256)
  private readonly tail = new ByteWriter(1024)
  private current: PeerState | undefined
  private pendingRef = false
  private despawnCount = 0
  private lastNetTick = -1
  private readonly unassigned: Query
  private readonly replicatedQuery: Query
  private readonly focusQuery: Query
  private readonly relevanceQuery: Query
  private readonly newEntities: Entity[] = []
  private readonly candidates = new NumberList()
  private readonly scores = new NumberList()
  private order = new Uint32Array(64)
  private readonly despawnKnown: (known: Known) => void
  listener: NetListener | undefined
  private unsubscribe: (() => void) | undefined

  constructor(world: World, config: ServerConfig) {
    this.world = world
    this.config = config
    const mapping: EntityMapping = {
      toWire: (e) => this.toWire(e),
      fromWire: (id) => this.fromWire(id),
    }
    const m = config.manifest
    this.codecs = m.components.map((c) =>
      createRowCodec(c.def, { quantize: c.quantize, entities: mapping }),
    )
    this.commandCodecs = m.commands.map((c) => createRowCodec(c.schema, { entities: mapping }))
    this.eventCodecs = m.events.map((e) => createRowCodec(e.schema, { entities: mapping }))
    m.commands.forEach((c, i) => {
      this.commandIndex.set(c.name, i)
    })
    m.events.forEach((e, i) => {
      this.eventIndex.set(e.name, i)
    })
    this.unassigned = world.query({ with: [Replicated], without: [NetId] })
    this.replicatedQuery = world.query({ with: [Replicated] })
    this.focusQuery = world.query({ with: [Focus] })
    this.relevanceQuery = world.query({ with: [Relevance, Replicated] })
    this.despawnKnown = (known) => {
      const peer = this.current!
      if (this.world.isAlive(known.entity) && peer.relevant.has(known.entity)) return
      this.despawns.varuint(known.netId)
      this.despawnCount++
      peer.known.delete(known.netId)
    }
    this.unsubscribe = world.observe(onRemoveNetId, (event) => {
      const id = readNetId(world, event.entity)
      if (id !== undefined) this.byNetId.delete(id)
    })
    world.insertResource(Peers, new Map())
  }

  attach(listener: NetListener): void {
    this.listener = listener
    // Subscribe at once: a client may send its hello before the server's next frame.
    listener.onConnection((connection) => {
      const tick = this.world.resource(FixedTime).tick
      // The server numbers peers itself: ids from different listeners (a lobby and the host's
      // loopback) would collide.
      const peer = new PeerState(connection, this.nextPeer++, tick, this.config.commandsPerSecond)
      connection.onMessage((channel, bytes) => peer.inbox.push({ channel, bytes }))
      connection.onClose((reason) => {
        peer.closed = reason?.message ?? 'disconnected'
      })
      this.incoming.push(peer)
    })
  }

  /** Saves every connected player (0090), closes their connections, and waits for the stores. */
  async dispose(): Promise<void> {
    for (const peer of [...this.peerList]) {
      if (peer.info.state === 'connected') {
        this.sendDisconnect(peer, 'server stopped')
        this.drop(peer, 'server stopped')
      } else peer.connection.close('server stopped')
    }
    await this.flush()
    this.unsubscribe?.()
    await this.listener?.close()
  }

  /** Resolves when every player store in flight has settled. */
  async flush(): Promise<void> {
    while (this.stores.size > 0) await Promise.allSettled([...this.stores])
  }

  // --- entity ids ----------------------------------------------------------

  private toWire(entity: Entity): number {
    const world = this.world
    if (!world.isAlive(entity) || !world.has(entity, NetId)) return 0
    const id = world.entityTable(entity).column(NetId, 'id')[world.entityRow(entity)]!
    const peer = this.current
    if (!peer || peer.known.has(id)) return id
    if (peer.relevant.has(entity)) {
      // Spawned for this peer later (this message or a later tick): resend once it is.
      this.pendingRef = true
      return id
    }
    return 0
  }

  private fromWire(id: number): Entity | null | undefined {
    if (id === 0) return null
    const peer = this.current
    if (peer && !peer.known.has(id)) return undefined
    return this.byNetId.get(id)
  }

  netIdOf(entity: Entity): number | undefined {
    return readNetId(this.world, entity)
  }

  // --- receiving -----------------------------------------------------------

  receive(): void {
    const world = this.world
    const tick = world.resource(FixedTime).tick
    for (let i = 0; i < this.incoming.length; i++) {
      const peer = this.incoming[i]!
      this.peers.set(peer.id, peer)
      this.peerList.push(peer)
    }
    this.incoming.length = 0
    this.settleJoins()
    for (const f of this.saveFailures.splice(0)) {
      world.send(PlayerSaveFailed, {
        peer: f.peer,
        user: f.user,
        code: f.error.code,
        message: f.error.message,
      })
    }
    // Oldest peer first; `drop` removes the peer from the list, so the index steps back.
    const peers = this.peerList
    for (let p = 0; p < peers.length; p++) {
      const peer = peers[p]!
      peer.connection.pump?.()
      this.current = peer
      const inbox = peer.inbox
      for (let i = 0; i < inbox.length; i++) {
        try {
          this.handle(peer, inbox[i]!.bytes, tick)
        } catch (err) {
          const error = err instanceof ShardError ? err : badMessage(String(err))
          this.refuse(peer, error)
        }
        if (peer.closed) break
      }
      inbox.length = 0
      this.current = undefined
      if (peer.closed) {
        this.drop(peer, peer.closed)
        p--
      }
    }
  }

  private handle(peer: PeerState, bytes: Uint8Array, tick: number): void {
    const r = this.reader
    r.reset(bytes)
    const kind = r.u8()
    const sentTick = r.u32()
    if (kind === Msg.fragment) {
      const whole = peer.fragmenter.receive(r)
      if (whole) this.handle(peer, whole, tick)
      return
    }
    if (kind === Msg.hello) {
      this.hello(peer, r, tick)
      return
    }
    if (peer.info.state !== 'connected') throw badMessage('message before handshake')
    switch (kind) {
      case Msg.ping: {
        const clientTime = r.f64()
        header(this.out, Msg.pong, tick)
        this.out.f64(clientTime)
        this.out.u32(sentTick)
        peer.connection.send('unreliable', this.out.finish())
        return
      }
      case Msg.ack:
        this.ack(peer, r)
        return
      case Msg.command:
        this.command(peer, r, tick)
        return
      case Msg.disconnect:
        peer.closed = r.remaining > 0 ? r.string() : 'left'
        return
      default:
        throw badMessage(`unknown kind ${kind}`)
    }
  }

  private hello(peer: PeerState, r: ByteReader, tick: number): void {
    const protocol = r.u16()
    const hash = r.u32()
    const token = r.string()
    const types = JSON.parse(r.string()) as string[]
    const m = this.config.manifest
    if (protocol !== PROTOCOL_VERSION) {
      this.refuse(
        peer,
        new ShardError(
          'net/schema-mismatch',
          `Protocol ${protocol}, server runs ${PROTOCOL_VERSION}`,
        ),
      )
      return
    }
    if (hash !== m.hash) {
      const mine = describeManifest(m)
      const differs =
        mine.find((line) => !types.includes(line)) ?? types.find((line) => !mine.includes(line))
      this.refuse(
        peer,
        new ShardError(
          'net/schema-mismatch',
          `Client and server disagree on ${differs ?? 'their replicated types'}`,
          { hint: 'Run the same build of the game on both sides.' },
        ),
      )
      return
    }
    let taken = 0
    for (const p of this.peerList) if (p.info.state !== 'handshake') taken++
    if (taken >= this.config.maxPeers) {
      this.refuse(peer, new ShardError('net/full', 'The server is full'))
      return
    }
    peer.info.state = 'joining'
    peer.info.token = token
    peer.joinStarted = this.config.now()
    this.join(peer, token, tick)
  }

  // --- joining and leaving (0090) -------------------------------------------

  private join(peer: PeerState, token: string, tick: number): void {
    let result: AcceptResult | Promise<AcceptResult>
    try {
      result = this.config.accept?.(peer.id, token, this.world)
    } catch (err) {
      this.finishJoin(peer, { peer, error: failure(err, 'net/accept-failed') }, tick)
      return
    }
    // A synchronous answer with nothing to load admits in this frame.
    if (!isPromise(result) && !this.config.players?.load) {
      this.finishJoin(peer, outcome(peer, result), tick)
      return
    }
    void this.joinAsync(peer, token, result)
  }

  private async joinAsync(
    peer: PeerState,
    token: string,
    result: AcceptResult | Promise<AcceptResult>,
  ): Promise<void> {
    let accepted: AcceptResult
    try {
      accepted = await result
    } catch (err) {
      this.settled.push({ peer, error: failure(err, 'net/accept-failed') })
      return
    }
    const first = outcome(peer, accepted)
    const load = this.config.players?.load
    if (first.error || !load || peer.closed) {
      this.settled.push(first)
      return
    }
    try {
      const data = await load({ peer: peer.id, user: first.user, token })
      this.settled.push({ peer, user: first.user, data })
    } catch (err) {
      this.settled.push({ peer, error: failure(err, 'net/load-failed') })
    }
  }

  /** Applies finished joins, and times out the slow ones. */
  private settleJoins(): void {
    const tick = this.world.resource(FixedTime).tick
    for (const result of this.settled.splice(0)) this.finishJoin(result.peer, result, tick)
    const now = this.config.now()
    for (const peer of this.peerList) {
      if (
        peer.info.state === 'joining' &&
        !peer.closed &&
        now - peer.joinStarted > this.config.joinTimeout
      ) {
        this.refuse(
          peer,
          new ShardError(
            'net/join-timeout',
            `Joining took over ${this.config.joinTimeout / 1000} s`,
            {
              hint: 'accept and players.load must settle within joinTimeout.',
            },
          ),
        )
      }
    }
  }

  private finishJoin(peer: PeerState, result: JoinOutcome, tick: number): void {
    // Left, refused or timed out meanwhile: the late result is dropped.
    if (peer.closed || peer.info.state !== 'joining' || !this.peers.has(peer.id)) return
    if (result.error) {
      this.refuse(peer, result.error)
      return
    }
    const user = result.user
    peer.info.user = user
    try {
      this.config.players?.spawn?.(this.world, {
        peer: peer.id,
        user,
        token: peer.info.token,
        data: result.data,
      })
    } catch (err) {
      this.refuse(peer, failure(err, 'net/spawn-failed'))
      return
    }
    peer.info.state = 'connected'
    peer.info.joinedTick = tick
    this.world.resource(Peers).set(peer.id, peer.info)
    header(this.out, Msg.welcome, tick)
    this.out.varuint(peer.id)
    this.out.u16(this.config.ticksPerNet)
    peer.connection.send('reliable', this.out.finish())
    this.world.send(PeerJoined, { peer: peer.id, user })
  }

  private ownedBy(peer: PeerId): Entity[] {
    const owned: Entity[] = []
    for (const table of this.replicatedQuery.tables) {
      const owner = table.column(Replicated, 'owner')
      for (let row = 0; row < table.count; row++) {
        if (owner[row] === peer) owned.push(table.entities[row]!)
      }
    }
    return owned
  }

  /** Captures a connected player's data and starts its store. Undefined without hooks. */
  save(peer: PeerId): Promise<void> | undefined {
    const state = this.peers.get(peer)
    if (state?.info.state !== 'connected') {
      throw new ShardError('net/not-connected', `Peer ${peer} isn't connected`)
    }
    return this.captureAndStore(state, this.ownedBy(peer))
  }

  private captureAndStore(peer: PeerState, owned: readonly Entity[]): Promise<void> | undefined {
    const players = this.config.players
    if (!players?.capture && !players?.store) return undefined
    const user = peer.info.user
    let data: unknown
    try {
      data = players.capture?.(this.world, { peer: peer.id, user, owned })
    } catch (err) {
      this.saveFailed(peer.id, user, failure(err, 'net/save-failed'))
      return undefined
    }
    if (!players.store) return undefined
    let stored: Promise<void>
    try {
      stored = Promise.resolve(players.store({ peer: peer.id, user, data }))
    } catch (err) {
      stored = Promise.reject(err)
    }
    const tracked = stored.then(
      () => undefined,
      (err: unknown) => this.saveFailed(peer.id, user, failure(err, 'net/save-failed')),
    )
    this.stores.add(tracked)
    void tracked.finally(() => this.stores.delete(tracked))
    return stored
  }

  private saveFailed(peer: PeerId, user: unknown, error: ShardError): void {
    this.saveFailures.push({ peer, user, error })
    this.world.tryResource(LogResource)?.error(error)
  }

  /** A connected peer left: save it, despawn what it owned, tell the game. */
  private leave(peer: PeerState, reason: string): void {
    const owned = this.ownedBy(peer.id)
    this.captureAndStore(peer, owned)
    if (this.config.players && (this.config.players.despawn ?? true)) {
      for (const e of owned) if (this.world.isAlive(e)) this.world.despawn(e)
    }
    this.world.send(PeerLeft, { peer: peer.id, reason, user: peer.info.user })
  }

  private refuse(peer: PeerState, error: ShardError): void {
    header(this.out, Msg.refused, this.world.resource(FixedTime).tick)
    this.out.string(error.code)
    this.out.string(error.message)
    this.out.string(error.hint ?? '')
    peer.connection.send('reliable', this.out.finish())
    peer.connection.close(error.message)
    peer.closed = error.code
  }

  private drop(peer: PeerState, reason: string): void {
    this.peers.delete(peer.id)
    const index = this.peerList.indexOf(peer)
    if (index !== -1) this.peerList.splice(index, 1)
    const wasConnected = this.world.resource(Peers).delete(peer.id)
    for (const cmd of this.commands) if (cmd.peer === peer.id) cmd.reject('net/peer-left')
    if (wasConnected) this.leave(peer, reason)
    peer.info.state = 'handshake'
  }

  private sendDisconnect(peer: PeerState, reason: string): void {
    header(this.out, Msg.disconnect, this.world.resource(FixedTime).tick)
    this.out.string(reason)
    peer.connection.send('reliable', this.out.finish())
    peer.connection.close(reason)
  }

  /** Disconnects a peer (`net.disconnect`). */
  disconnect(peer: PeerId, reason = 'disconnected by the server'): boolean {
    const state = this.peers.get(peer)
    if (!state) return false
    this.sendDisconnect(state, reason)
    this.drop(state, reason)
    return true
  }

  private ack(peer: PeerState, r: ByteReader): void {
    const latest = r.varuint()
    const bits = r.u32()
    const rtt = r.f64()
    if (rtt > 0) peer.info.rtt = rtt
    for (let i = 0; i <= 32; i++) {
      if (i > 0 && (bits & (1 << (i - 1))) === 0) continue
      const seq = latest - i
      if (seq <= 0) break
      const record = peer.packets[seq % PACKET_RING]!
      if (record.seq !== seq || record.acked) continue
      record.acked = true
      for (let k = 0; k < record.netIds.length; k++) {
        const known = peer.known.get(record.netIds.at(k))
        if (!known) continue
        const c = record.comps.at(k)
        const t = record.ticks.at(k)
        if (t > known.acked[c]!) known.acked[c] = t
      }
    }
  }

  private command(peer: PeerState, r: ByteReader, tick: number): void {
    const seq = r.varuint()
    const index = r.varuint()
    const def = this.config.manifest.commands[index]
    peer.stats.commands++
    const answer = (cmd: ServerCommand) => this.answer(cmd)
    if (!def) {
      const cmd = new ServerCommand(unknownDef, peer.id, seq, {}, tick, answer)
      cmd.reject('net/unknown-command', `Command #${index} isn't in the server's manifest`)
      return
    }
    // Rate limit with a token bucket.
    const now = this.config.now()
    const rate = this.config.commandsPerSecond
    peer.tokens = Math.min(rate, peer.tokens + ((now - peer.lastRefill) / 1000) * rate)
    peer.lastRefill = now
    const data = this.commandCodecs[index]!.decode(r)
    const cmd = new ServerCommand(def, peer.id, seq, data ?? {}, tick, answer)
    this.remember(cmd)
    if (peer.tokens < 1) {
      cmd.reject('net/command-rate', `Over ${rate} commands per second`)
      return
    }
    peer.tokens--
    if (data === undefined) {
      cmd.reject('net/unknown-net-id', 'The command names an entity you do not have')
      return
    }
    const errors = def.schema.validate(def.schema.serialize(data))
    if (errors.length > 0) {
      const e = errors[0]!
      cmd.reject(e.code, e.message, e.hint)
      return
    }
    this.commands.push(cmd)
  }

  private remember(cmd: ServerCommand): void {
    this.recentCommands.push(cmd)
    if (this.recentCommands.length > 64) this.recentCommands.shift()
  }

  /** Delivers a command from the server's own world (single-player, or a host's local player). */
  local(def: NetCommandDef, data: Record<string, unknown>, onAnswer: (cmd: ServerCommand) => void) {
    const tick = this.world.resource(FixedTime).tick
    const cmd = new ServerCommand(def, 0, 0, data, tick, onAnswer)
    const errors = def.schema.validate(def.schema.serialize(data))
    this.remember(cmd)
    if (errors.length > 0) cmd.reject(errors[0]!.code, errors[0]!.message, errors[0]!.hint)
    else this.commands.push(cmd)
    return cmd
  }

  private answer(cmd: ServerCommand): void {
    if (cmd.peer === 0) return
    const peer = this.peers.get(cmd.peer)
    if (cmd.status === 'rejected') {
      if (peer) peer.stats.rejected++
    }
    peer?.answers.push({ seq: cmd.seq, error: cmd.error })
  }

  /** Commands of one type still waiting for an answer. */
  pending(def: NetCommandDef): ServerCommand[] {
    const out: ServerCommand[] = []
    for (const cmd of this.commands) if (cmd.def === def && cmd.status === 'pending') out.push(cmd)
    return out
  }

  // --- events --------------------------------------------------------------

  sendEvent(def: NetEventDef, data: Record<string, unknown>, to: QueuedEvent['to']): void {
    const index = this.eventIndex.get(def.name)
    if (index === undefined) {
      throw new ShardError('net/unknown-event', `${def.name} isn't in netPlugin({ events })`, {
        hint: 'List every net event in the plugin options on both sides.',
      })
    }
    this.events.push({ index, data, to })
    const tick = this.world.resource(FixedTime).tick
    this.recentEvents.push({
      name: def.name,
      tick,
      to: typeof to === 'function' ? 'filter' : String(to),
    })
    if (this.recentEvents.length > 64) this.recentEvents.shift()
    this.world.send(def.event, { data: data as never, tick })
  }

  commandIndexOf(def: NetCommandDef): number | undefined {
    return this.commandIndex.get(def.name)
  }

  // --- sending -------------------------------------------------------------

  /** Runs in Last: answers unhandled commands, and on network ticks sends state to every peer. */
  send(): void {
    const world = this.world
    const fixed = world.resource(FixedTime)
    for (const cmd of this.commands) {
      if (cmd.status === 'pending' && fixed.tick > cmd.arrivedTick) {
        cmd.reject('net/unhandled-command', `No system handled ${cmd.def.name}`)
      }
    }
    if (this.commands.length > 0) {
      let n = 0
      for (const cmd of this.commands) if (cmd.status === 'pending') this.commands[n++] = cmd
      this.commands.length = n
    }
    const netTick = Math.floor(fixed.tick / this.config.ticksPerNet)
    if (netTick === this.lastNetTick) return
    this.lastNetTick = netTick
    world.resource(NetRole).tick = fixed.tick

    this.assignIds()
    this.collectFocus()
    this.config.interest.prepare?.(world)
    for (let p = 0; p < this.peerList.length; p++) {
      const peer = this.peerList[p]!
      if (peer.info.state !== 'connected' || peer.closed) continue
      this.current = peer
      this.sendTo(peer, fixed.tick)
      this.current = undefined
    }
    this.events.length = 0
  }

  private assignIds(): void {
    const list = this.newEntities
    list.length = 0
    for (const table of this.unassigned.tables) {
      for (let row = 0; row < table.count; row++) list.push(table.entities[row]!)
    }
    for (const e of list) {
      const id = this.nextNetId++
      this.world.add(e, NetId, { id })
      this.byNetId.set(id, e)
    }
  }

  private collectFocus(): void {
    for (let p = 0; p < this.peerList.length; p++) this.peerList[p]!.focus.length = 0
    for (const table of this.replicatedQuery.tables) {
      const owner = table.column(Replicated, 'owner')
      for (let row = 0; row < table.count; row++) {
        if (owner[row] !== 0) this.peers.get(owner[row]!)?.focus.push(table.entities[row]!)
      }
    }
    for (const table of this.focusQuery.tables) {
      const peerId = table.column(Focus, 'peer')
      for (let row = 0; row < table.count; row++) {
        this.peers.get(peerId[row]!)?.focus.push(table.entities[row]!)
      }
    }
  }

  private readonly keepRelevant = (e: Entity): boolean => {
    const world = this.world
    if (!world.isAlive(e) || !world.has(e, NetId)) return false
    if (!world.has(e, ChildOf)) return true
    const parent = world.entityTable(e).column(ChildOf, 'parent')[world.entityRow(e)]!
    return (
      parent < 0 ||
      !world.isAlive(parent) ||
      !world.has(parent, Replicated) ||
      this.current!.relevant.has(parent)
    )
  }

  private relevance(peer: PeerState): void {
    const world = this.world
    // Swap: the old set becomes `previous`, and the new one is filled from scratch.
    const set = peer.previous
    peer.previous = peer.relevant
    peer.relevant = set
    set.clear()
    this.config.interest.update(world, peer, set)
    for (const table of this.relevanceQuery.tables) {
      const always = table.column(Relevance, 'always')
      for (let row = 0; row < table.count; row++) {
        if (always[row] === 1) set.add(table.entities[row]!)
      }
    }
    // A child is relevant only with its parent, so it never arrives without one.
    for (let pass = 0; pass < 8; pass++) {
      const before = set.size
      set.retain(this.keepRelevant)
      if (set.size === before) break
    }
  }

  private sendTo(peer: PeerState, tick: number): void {
    const world = this.world
    const config = this.config
    const comps = config.manifest.components
    this.relevance(peer)

    this.spawns.reset()
    this.sets.reset()
    this.removes.reset()
    this.despawns.reset()
    let spawnCount = 0
    let setCount = 0
    let removeCount = 0

    // Despawn what left the peer's interest or the world.
    this.despawnCount = 0
    peer.known.forEach(this.despawnKnown)
    const despawnCount = this.despawnCount

    // Candidates: entities to spawn, and known ones with something to send.
    const resendAfter = Math.max(
      config.ticksPerNet * 2,
      Math.ceil((peer.info.rtt / 1000) * (1 / world.resource(FixedTime).step)) + config.ticksPerNet,
    )
    const candidates = this.candidates
    const scores = this.scores
    candidates.clear()
    scores.clear()
    const relevant = peer.relevant
    for (let i = 0; i < relevant.size; i++) {
      const e = relevant.at(i)
      const table = world.entityTable(e)
      const row = world.entityRow(e)
      const netId = table.column(NetId, 'id')[row]!
      const known = peer.known.get(netId)
      const priority = table.has(Relevance) ? table.column(Relevance, 'priority')[row]! : 1
      if (!known) {
        candidates.push(i)
        scores.push(priority * 1e6)
        continue
      }
      let due = false
      for (let c = 0; c < comps.length; c++) {
        const entry = comps[c]!
        const has = table.has(entry.def)
        const visible = has && (!entry.visibleTo || entry.visibleTo(world, peer.id, e))
        if (!visible) {
          if (known.present[c]) {
            this.removes.varuint(netId)
            this.removes.varuint(c)
            removeCount++
            known.present[c] = 0
            known.sent[c] = 0
            known.acked[c] = 0
          }
          continue
        }
        const changed = table.changedTicks(entry.def)[row]!
        if (changed <= known.acked[c]! && known.present[c]) continue
        if (
          changed > known.sent[c]! ||
          !known.present[c] ||
          tick - known.sentAt[c]! >= resendAfter
        ) {
          due = true
        }
      }
      if (due) {
        candidates.push(i)
        scores.push(priority * (tick - known.lastSent + 1))
      }
    }

    const count = candidates.length
    if (this.order.length < count) this.order = new Uint32Array(count * 2)
    const order = this.order
    for (let i = 0; i < count; i++) order[i] = i
    if (Number.isFinite(config.bytesPerTick)) {
      const s = scores.data
      order.subarray(0, count).sort((a, b) => s[b]! - s[a]!)
    }

    // State message: header, sequence, then entries (count patched at the end).
    const state = this.state
    header(state, Msg.state, tick)
    const seq = peer.nextSeq
    state.u32(seq)
    const countAt = state.length
    state.u32(0)
    let stateEntries = 0
    const record = peer.packets[seq % PACKET_RING]!
    record.netIds.clear()
    record.comps.clear()
    record.ticks.clear()
    const stateLimit = config.maxMessage - 64

    let bytes = 0
    let deferred = 0
    for (let k = 0; k < count; k++) {
      if (bytes >= config.bytesPerTick || state.length >= stateLimit) {
        deferred = count - k
        break
      }
      const e = relevant.at(candidates.at(order[k]!))
      const table = world.entityTable(e)
      const row = world.entityRow(e)
      const netId = table.column(NetId, 'id')[row]!
      let known = peer.known.get(netId)
      const startBytes = this.spawns.length + this.sets.length + state.length
      if (!known) {
        known = makeKnown(netId, e, comps.length)
        peer.known.set(netId, known)
        this.spawns.varuint(netId)
        const prefab = table.column(Replicated, 'prefab')[row]
        this.spawns.string(prefab ?? '')
        spawnCount++
      }
      for (let c = 0; c < comps.length; c++) {
        const entry = comps[c]!
        if (!table.has(entry.def)) continue
        if (entry.visibleTo && !entry.visibleTo(world, peer.id, e)) continue
        const changed = table.changedTicks(entry.def)[row]!
        const present = known.present[c] === 1
        if (present && changed <= known.acked[c]!) continue
        const resend = present && changed <= known.sent[c]!
        if (resend && tick - known.sentAt[c]! < resendAfter) continue
        let toReliable = !present || entry.channel === 'reliable'
        let w = toReliable ? this.sets : state
        let before = w.length
        w.varuint(netId)
        w.varuint(c)
        this.pendingRef = false
        this.codecs[c]!.encodeRow(table, row, w)
        if (!toReliable && w.length > config.maxMessage) {
          // Too big for one unreliable message: send it reliably, which fragments.
          state.length = before
          toReliable = true
          w = this.sets
          before = w.length
          w.varuint(netId)
          w.varuint(c)
          this.pendingRef = false
          this.codecs[c]!.encodeRow(table, row, w)
        }
        const size = w.length - before
        peer.stats.bytesByComponent[entry.def.name] =
          (peer.stats.bytesByComponent[entry.def.name] ?? 0) + size
        if (resend) peer.stats.resends++
        known.present[c] = 1
        known.sentAt[c] = tick
        if (toReliable) {
          setCount++
          known.sent[c] = changed
          known.acked[c] = this.pendingRef ? 0 : changed
        } else {
          stateEntries++
          known.sent[c] = changed
          if (this.pendingRef) known.acked[c] = 0
          record.netIds.push(netId)
          record.comps.push(c)
          record.ticks.push(this.pendingRef ? 0 : changed)
        }
      }
      known.lastSent = tick
      bytes += this.spawns.length + this.sets.length + state.length - startBytes
    }
    peer.stats.deferred = deferred

    // Answers and events go after spawns, so they never name an entity the client lacks.
    const tail = this.tail
    tail.reset()
    let tailSections = 0
    if (peer.answers.length > 0) {
      tail.u8(Section.answer)
      tail.varuint(peer.answers.length)
      for (const a of peer.answers) {
        tail.varuint(a.seq)
        tail.string(a.error?.code ?? '')
        tail.string(a.error?.message ?? '')
        tail.string(a.error?.hint ?? '')
      }
      peer.answers.length = 0
      tailSections++
    }
    let eventCount = 0
    for (const ev of this.events) if (isRecipient(ev.to, peer.id)) eventCount++
    if (eventCount > 0) {
      tail.u8(Section.event)
      tail.varuint(eventCount)
      for (const ev of this.events) {
        if (!isRecipient(ev.to, peer.id)) continue
        tail.varuint(ev.index)
        this.eventCodecs[ev.index]!.encode(ev.data, tail)
      }
      tailSections++
    }

    if (spawnCount + setCount + removeCount + despawnCount + tailSections > 0) {
      const out = this.out
      header(out, Msg.reliable, tick)
      if (spawnCount > 0) section(out, Section.spawn, spawnCount, this.spawns)
      if (setCount > 0) section(out, Section.set, setCount, this.sets)
      if (removeCount > 0) section(out, Section.remove, removeCount, this.removes)
      if (despawnCount > 0) section(out, Section.despawn, despawnCount, this.despawns)
      out.bytes(tail.finish())
      out.u8(Section.end)
      peer.stats.bytesSent += out.length
      peer.fragmenter.send(peer.connection, 'reliable', out.finish(), config.maxMessage)
    }
    if (stateEntries > 0) {
      state.patchU32(countAt, stateEntries)
      record.seq = seq
      record.acked = false
      peer.nextSeq++
      peer.stats.bytesSent += state.length
      peer.connection.send('unreliable', state.finish())
    }
  }

  /** Describes one entity for `net.inspect`. */
  inspect(entity: Entity): Record<string, unknown> {
    const world = this.world
    const replicated = world.tryGet(entity, Replicated)
    const netId = readNetId(world, entity)
    const peers: Record<string, unknown> = {}
    for (const peer of this.peers.values()) {
      const known = netId === undefined ? undefined : peer.known.get(netId)
      const redacted: string[] = []
      for (const entry of this.config.manifest.components) {
        if (
          world.has(entity, entry.def) &&
          entry.visibleTo &&
          !entry.visibleTo(world, peer.id, entity)
        ) {
          redacted.push(entry.def.name)
        }
      }
      peers[String(peer.id)] = {
        relevant: peer.relevant.has(entity),
        known: known !== undefined,
        redacted,
        lastSentTick: known?.lastSent ?? null,
      }
    }
    return {
      netId: netId ?? null,
      owner: replicated?.owner ?? null,
      prefab: replicated?.prefab ?? null,
      peers,
    }
  }
}

const unknownDef = { kind: 'net-command', name: 'net/Unknown' } as unknown as NetCommandDef

interface JoinOutcome {
  readonly peer: PeerState
  readonly error?: ShardError
  readonly user?: unknown
  readonly data?: unknown
}

function outcome(peer: PeerState, result: AcceptResult): JoinOutcome {
  if (result instanceof ShardError) return { peer, error: result }
  return { peer, user: result?.user }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function'
}

/** A thrown ShardError as is; anything else under `code`. */
function failure(err: unknown, code: string): ShardError {
  if (err instanceof ShardError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new ShardError(code, message, { cause: err })
}

const onRemoveNetId = onRemove(NetId)

function readNetId(world: World, entity: Entity): number | undefined {
  if (!world.isAlive(entity) || !world.has(entity, NetId)) return undefined
  return world.entityTable(entity).column(NetId, 'id')[world.entityRow(entity)]
}

function makeKnown(netId: number, entity: Entity, count: number): Known {
  return {
    netId,
    entity,
    present: new Uint8Array(count),
    sent: new Uint32Array(count),
    acked: new Uint32Array(count),
    sentAt: new Float64Array(count),
    lastSent: 0,
  }
}

function section(out: ByteWriter, kind: number, count: number, body: ByteWriter): void {
  out.u8(kind)
  out.varuint(count)
  out.bytes(body.finish())
}

function isRecipient(to: QueuedEvent['to'], peer: PeerId): boolean {
  if (to === 'all') return true
  if (typeof to === 'number') return to === peer
  return to(peer)
}
