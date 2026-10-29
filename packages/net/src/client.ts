import {
  ByteReader,
  ByteWriter,
  createRowCodec,
  type Entity,
  type EntityMapping,
  onRemove,
  type RowCodec,
  ShardError,
  type TypedArray,
  type World,
} from '@aethervtt/shard-core'
import { FixedTime } from '@aethervtt/shard-runtime'
import { Connected, Disconnected, NetClock, NetId, NetRole } from './components'
import type { NetCommandDef } from './registry'
import type { Channel, NetConnection } from './transport'
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

export interface ClientConfig {
  readonly manifest: Manifest
  readonly ticksPerNet: number
  readonly maxMessage: number
  readonly token: string
  readonly spawnPrefab: ((world: World, prefab: string) => Entity) | undefined
  readonly now: () => number
}

/** A command this client sent, until the server answers (0089). */
export class PendingCommand {
  readonly def: NetCommandDef
  readonly seq: number
  status: 'pending' | 'accepted' | 'rejected' = 'pending'
  error: ShardError | undefined

  constructor(def: NetCommandDef, seq: number) {
    this.def = def
    this.seq = seq
  }
}

/** Recent samples of one interpolated component of one entity (0087). */
class InterpBuffer {
  static readonly SIZE = 8
  readonly ticks = new Float64Array(InterpBuffer.SIZE)
  readonly values: Float64Array
  count = 0
  head = 0

  constructor(width: number) {
    this.values = new Float64Array(InterpBuffer.SIZE * width)
  }
}

interface FloatField {
  readonly column: number
  readonly stride: number
  readonly quat: boolean
  /** Offset into a sample's values. */
  readonly offset: number
}

const SAMPLE_WINDOW = 16
const PING_MS = 500

export class NetClient {
  readonly world: World
  readonly config: ClientConfig
  readonly byNetId = new Map<number, Entity>()
  connection: NetConnection | undefined
  /** Why the server refused or dropped this client, if it did. */
  lastError: ShardError | undefined
  readonly pending = new Map<number, PendingCommand>()
  private readonly fragmenter = new Fragmenter()
  private readonly inbox: { channel: Channel; bytes: Uint8Array }[] = []
  private readonly applied = new Map<number, Float64Array>()
  private readonly interp = new Map<number, (InterpBuffer | undefined)[]>()
  private readonly codecs: RowCodec[]
  private readonly commandCodecs: RowCodec[]
  private readonly eventCodecs: RowCodec[]
  private readonly floatFields: FloatField[][]
  private readonly widths: number[]
  private readonly commandIndex = new Map<string, number>()
  private readonly reader = new ByteReader()
  private readonly out = new ByteWriter(1024)
  private latestSeq = 0
  private seqBits = 0
  private ackDirty = false
  private lastPing = Number.NEGATIVE_INFINITY
  private lastNetTick = -1
  private nextCommand = 1
  private readonly rtts: number[] = []
  private readonly offsets: number[] = []
  private readonly sortScratch: number[] = []
  private closedReason: string | undefined
  private unsubscribe: (() => void) | undefined

  constructor(world: World, config: ClientConfig) {
    this.world = world
    this.config = config
    const mapping: EntityMapping = {
      toWire: (e) => this.toWire(e),
      fromWire: (id) => (id === 0 ? null : this.byNetId.get(id)),
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
    this.floatFields = []
    this.widths = []
    for (const entry of m.components) {
      const fields: FloatField[] = []
      let offset = 0
      if (entry.mode === 'interpolate') {
        entry.def.layout.forEach((c, column) => {
          if (c.storage !== 'f32' && c.storage !== 'f64') return
          fields.push({ column, stride: c.stride, quat: c.field.kind === 'quat', offset })
          offset += c.stride
        })
      }
      this.floatFields.push(fields)
      this.widths.push(offset)
    }
    world.insertResource(NetClock, { serverTick: 0, offsetTicks: 0, rtt: 0, jitter: 0 })
    this.unsubscribe = world.observe(onRemove(NetId), (event) => {
      const table = world.entityTable(event.entity)
      const id = table.column(NetId, 'id')[world.entityRow(event.entity)]!
      if (this.byNetId.get(id) === event.entity) this.forget(id)
    })
  }

  attach(connection: NetConnection): void {
    this.connection = connection
    connection.onMessage((channel, bytes) => this.inbox.push({ channel, bytes }))
    connection.onClose((reason) => {
      this.closedReason = reason?.message ?? 'disconnected'
      if (reason && !this.lastError) this.lastError = reason
    })
    header(this.out, Msg.hello, this.world.resource(FixedTime).tick)
    this.out.u16(PROTOCOL_VERSION)
    this.out.u32(this.config.manifest.hash)
    this.out.string(this.config.token)
    this.out.string(JSON.stringify(describeManifest(this.config.manifest)))
    this.fragmenter.send(connection, 'reliable', this.out.finish(), this.config.maxMessage)
  }

  dispose(): void {
    this.unsubscribe?.()
    const connection = this.connection
    if (!connection) return
    header(this.out, Msg.disconnect, this.world.resource(FixedTime).tick)
    this.out.string('left')
    connection.send('reliable', this.out.finish())
    connection.close('left')
  }

  private toWire(entity: Entity): number {
    const world = this.world
    if (!world.isAlive(entity) || !world.has(entity, NetId)) return 0
    return world.entityTable(entity).column(NetId, 'id')[world.entityRow(entity)]!
  }

  private forget(id: number): void {
    this.byNetId.delete(id)
    this.applied.delete(id)
    this.interp.delete(id)
  }

  // --- receiving -----------------------------------------------------------

  receive(): void {
    const connection = this.connection
    const world = this.world
    const fixed = world.resource(FixedTime)
    const clock = world.resource(NetClock)
    if (connection) {
      connection.pump?.()
      const inbox = this.inbox
      for (let i = 0; i < inbox.length; i++) {
        try {
          this.handle(inbox[i]!.bytes)
        } catch (err) {
          this.lastError = err instanceof ShardError ? err : badMessage(String(err))
          connection.close(this.lastError.message)
          this.closedReason = this.lastError.message
          break
        }
      }
      inbox.length = 0
    }
    if (this.closedReason !== undefined) {
      const role = world.resource(NetRole)
      const error = this.lastError
      world.send(Disconnected, {
        code: error?.code ?? 'net/transport-closed',
        message: error?.message ?? this.closedReason,
      })
      role.connected = false
      this.connection = undefined
      this.closedReason = undefined
    }
    clock.serverTick = fixed.tick + fixed.alpha + clock.offsetTicks
  }

  private handle(bytes: Uint8Array): void {
    const r = this.reader
    r.reset(bytes)
    const kind = r.u8()
    const tick = r.u32()
    switch (kind) {
      case Msg.fragment: {
        const whole = this.fragmenter.receive(r)
        if (whole) this.handle(whole)
        return
      }
      case Msg.welcome:
        this.welcome(r, tick)
        return
      case Msg.refused: {
        const code = r.string()
        const message = r.string()
        const hint = r.string()
        this.lastError = new ShardError(code, message, hint ? { hint } : {})
        this.closedReason = message
        return
      }
      case Msg.disconnect:
        this.lastError = new ShardError('net/disconnected', r.string())
        this.closedReason = this.lastError.message
        return
      case Msg.pong:
        this.pong(r, tick)
        return
      case Msg.reliable:
        this.reliable(r, tick)
        return
      case Msg.state:
        this.state(r, tick)
        return
      default:
        throw badMessage(`unknown kind ${kind}`)
    }
  }

  private welcome(r: ByteReader, serverTick: number): void {
    const world = this.world
    const peer = r.varuint()
    r.u16() // the server's ticks per network tick; both sides already agreed through the manifest
    const role = world.resource(NetRole)
    role.peer = peer
    role.connected = true
    const clock = world.resource(NetClock)
    clock.offsetTicks = serverTick - world.resource(FixedTime).tick
    world.send(Connected, { peer })
  }

  private pong(r: ByteReader, serverTick: number): void {
    const sentAt = r.f64()
    const fixed = this.world.resource(FixedTime)
    const clock = this.world.resource(NetClock)
    const rtt = Math.max(0, this.config.now() - sentAt)
    pushSample(this.rtts, rtt)
    const stepMs = fixed.step * 1000
    // The server read our ping half a round trip ago: it is that much further along now.
    pushSample(this.offsets, serverTick + rtt / 2 / stepMs - (fixed.tick + fixed.alpha))
    clock.rtt = median(this.rtts, this.sortScratch)
    clock.offsetTicks = median(this.offsets, this.sortScratch)
    let spread = 0
    for (const v of this.rtts) spread += Math.abs(v - clock.rtt)
    clock.jitter = spread / this.rtts.length
  }

  private stale(netId: number, comp: number, tick: number): boolean {
    let ticks = this.applied.get(netId)
    if (!ticks) {
      ticks = new Float64Array(this.codecs.length).fill(-1)
      this.applied.set(netId, ticks)
    }
    if (tick < ticks[comp]!) return true
    ticks[comp] = tick
    return false
  }

  /** Decodes one component update into its entity. False if it named an unknown entity. */
  private apply(r: ByteReader, netId: number, comp: number, tick: number): boolean {
    const codec = this.codecs[comp]
    if (!codec) throw badMessage(`component #${comp}`)
    const entity = this.byNetId.get(netId)
    if (entity === undefined || !this.world.isAlive(entity)) {
      codec.decode(r)
      return false
    }
    if (this.stale(netId, comp, tick)) {
      codec.decode(r)
      return true
    }
    const world = this.world
    if (!world.has(entity, codec.def)) world.add(entity, codec.def)
    const ok = codec.decodeRow(r, world.entityTable(entity), world.entityRow(entity))
    if (this.widths[comp]! > 0) this.sample(netId, comp, entity, tick)
    return ok
  }

  private reliable(r: ByteReader, tick: number): void {
    const world = this.world
    for (;;) {
      const section = r.u8()
      if (section === Section.end) return
      const count = r.varuint()
      for (let i = 0; i < count; i++) {
        switch (section) {
          case Section.spawn: {
            const netId = r.varuint()
            const prefab = r.string()
            const old = this.byNetId.get(netId)
            if (old !== undefined && world.isAlive(old)) world.despawn(old)
            const spawn = this.config.spawnPrefab
            const entity = prefab && spawn ? spawn(world, prefab) : world.spawn()
            world.add(entity, NetId, { id: netId })
            this.byNetId.set(netId, entity)
            break
          }
          case Section.set:
            this.apply(r, r.varuint(), r.varuint(), tick)
            break
          case Section.remove: {
            const entity = this.byNetId.get(r.varuint())
            const def = this.codecs[r.varuint()]?.def
            if (entity !== undefined && def && world.isAlive(entity)) world.remove(entity, def)
            break
          }
          case Section.despawn: {
            const netId = r.varuint()
            const entity = this.byNetId.get(netId)
            this.forget(netId)
            if (entity !== undefined && world.isAlive(entity)) world.despawn(entity)
            break
          }
          case Section.answer: {
            const seq = r.varuint()
            const code = r.string()
            const message = r.string()
            const hint = r.string()
            const pending = this.pending.get(seq)
            if (!pending) break
            this.pending.delete(seq)
            if (code) {
              pending.status = 'rejected'
              pending.error = new ShardError(code, message, hint ? { hint } : {})
            } else pending.status = 'accepted'
            break
          }
          case Section.event: {
            const index = r.varuint()
            const def = this.config.manifest.events[index]
            const codec = this.eventCodecs[index]
            if (!def || !codec) throw badMessage(`event #${index}`)
            const data = codec.decode(r)
            if (data) world.send(def.event, { data: data as never, tick })
            break
          }
          default:
            throw badMessage(`section ${section}`)
        }
      }
    }
  }

  private state(r: ByteReader, tick: number): void {
    const seq = r.u32()
    const count = r.u32()
    let complete = true
    for (let i = 0; i < count; i++) {
      if (!this.apply(r, r.varuint(), r.varuint(), tick)) complete = false
    }
    // An update for an entity we don't have yet isn't acked: the server sends it again.
    if (complete) this.received(seq)
  }

  private received(seq: number): void {
    if (seq > this.latestSeq) {
      const shift = seq - this.latestSeq
      this.seqBits =
        shift > 32
          ? 0
          : shift === 32
            ? 1 << 31
            : ((this.seqBits << shift) | (1 << (shift - 1))) >>> 0
      if (this.latestSeq === 0) this.seqBits = 0
      this.latestSeq = seq
    } else if (seq < this.latestSeq) {
      const diff = this.latestSeq - seq
      if (diff <= 32) this.seqBits = (this.seqBits | (1 << (diff - 1))) >>> 0
    }
    this.ackDirty = true
  }

  // --- interpolation -------------------------------------------------------

  private sample(netId: number, comp: number, entity: Entity, tick: number): void {
    let buffers = this.interp.get(netId)
    if (!buffers) {
      buffers = new Array(this.codecs.length)
      this.interp.set(netId, buffers)
    }
    let buffer = buffers[comp]
    if (!buffer) {
      buffer = new InterpBuffer(this.widths[comp]!)
      buffers[comp] = buffer
    }
    const width = this.widths[comp]!
    // Keep ticks ascending: drop a sample older than the newest (it arrived late).
    const newest = buffer.count > 0 ? buffer.ticks[(buffer.head + SIZE - 1) % SIZE]! : -1
    if (tick <= newest) return
    const slot = buffer.head
    buffer.ticks[slot] = tick
    const world = this.world
    const storage = world.entityTable(entity).storage(this.codecs[comp]!.def)!
    const row = world.entityRow(entity)
    for (const f of this.floatFields[comp]!) {
      const column = storage.columns[f.column] as TypedArray
      for (let i = 0; i < f.stride; i++) {
        buffer.values[slot * width + f.offset + i] = column[row * f.stride + i]!
      }
    }
    buffer.head = (slot + 1) % SIZE
    if (buffer.count < SIZE) buffer.count++
  }

  /** Writes interpolated values for every remote entity (PreUpdate). */
  interpolate(): void {
    if (this.interp.size === 0) return
    const world = this.world
    const fixed = world.resource(FixedTime)
    const clock = world.resource(NetClock)
    const step = fixed.step
    const delay = Math.max(2 * this.config.ticksPerNet, (2 * clock.jitter) / 1000 / step)
    this.renderTick = clock.serverTick - clock.rtt / 2 / 1000 / step - delay
    this.interp.forEach(this.interpolateEntity)
  }

  private renderTick = 0
  private readonly interpolateEntity = (buffers: (InterpBuffer | undefined)[], netId: number) => {
    const world = this.world
    const entity = this.byNetId.get(netId)
    if (entity === undefined || !world.isAlive(entity)) return
    for (let c = 0; c < buffers.length; c++) {
      const buffer = buffers[c]
      if (!buffer || buffer.count === 0) continue
      if (!world.has(entity, this.codecs[c]!.def)) continue
      this.write(buffer, c, entity, this.renderTick)
    }
  }

  private write(buffer: InterpBuffer, comp: number, entity: Entity, renderTick: number): void {
    const width = this.widths[comp]!
    const oldest = (buffer.head + SIZE - buffer.count) % SIZE
    const newestSlot = (buffer.head + SIZE - 1) % SIZE
    let a = oldest
    let b = oldest
    let t = 0
    if (renderTick <= buffer.ticks[oldest]!) {
      a = b = oldest
    } else if (renderTick >= buffer.ticks[newestSlot]!) {
      // Past the newest sample: hold it. Updates are deltas, so no newer sample usually means the
      // value stopped changing; extrapolating would overshoot and stay there.
      a = b = newestSlot
    } else {
      for (let k = 0; k < buffer.count - 1; k++) {
        const i = (oldest + k) % SIZE
        const j = (i + 1) % SIZE
        if (renderTick >= buffer.ticks[i]! && renderTick <= buffer.ticks[j]!) {
          a = i
          b = j
          const span = buffer.ticks[j]! - buffer.ticks[i]!
          t = span > 0 ? (renderTick - buffer.ticks[i]!) / span : 0
          break
        }
      }
    }
    const world = this.world
    const table = world.entityTable(entity)
    const storage = table.storage(this.codecs[comp]!.def)!
    const row = world.entityRow(entity)
    const va = buffer.values
    for (const f of this.floatFields[comp]!) {
      const column = storage.columns[f.column] as TypedArray
      const base = row * f.stride
      const oa = a * width + f.offset
      const ob = b * width + f.offset
      if (f.quat) {
        // nlerp along the shorter arc.
        const dot =
          va[oa]! * va[ob]! +
          va[oa + 1]! * va[ob + 1]! +
          va[oa + 2]! * va[ob + 2]! +
          va[oa + 3]! * va[ob + 3]!
        const sign = dot < 0 ? -1 : 1
        const u = Math.min(t, 1)
        let len = 0
        for (let i = 0; i < 4; i++) {
          const v = va[oa + i]! * (1 - u) + va[ob + i]! * sign * u
          column[base + i] = v
          len += v * v
        }
        len = Math.sqrt(len) || 1
        for (let i = 0; i < 4; i++) column[base + i] = column[base + i]! / len
        continue
      }
      for (let i = 0; i < f.stride; i++) {
        column[base + i] = va[oa + i]! + (va[ob + i]! - va[oa + i]!) * t
      }
    }
    table.markChanged(this.codecs[comp]!.def, row)
  }

  // --- sending -------------------------------------------------------------

  /** Runs in Last: acks and pings on network ticks. */
  send(): void {
    const connection = this.connection
    const world = this.world
    if (!connection || !world.resource(NetRole).connected) return
    const fixed = world.resource(FixedTime)
    const netTick = Math.floor(fixed.tick / this.config.ticksPerNet)
    if (netTick === this.lastNetTick) return
    this.lastNetTick = netTick
    world.resource(NetRole).tick = Math.floor(world.resource(NetClock).serverTick)
    if (this.ackDirty) {
      header(this.out, Msg.ack, fixed.tick)
      this.out.varuint(this.latestSeq)
      this.out.u32(this.seqBits)
      this.out.f64(world.resource(NetClock).rtt)
      connection.send('unreliable', this.out.finish())
      this.ackDirty = false
    }
    const now = this.config.now()
    if (now - this.lastPing >= PING_MS) {
      this.lastPing = now
      header(this.out, Msg.ping, fixed.tick)
      this.out.f64(now)
      connection.send('unreliable', this.out.finish())
    }
  }

  sendCommand(def: NetCommandDef, data: Record<string, unknown>): PendingCommand {
    const index = this.commandIndex.get(def.name)
    if (index === undefined) {
      throw new ShardError('net/unknown-command', `${def.name} isn't in netPlugin({ commands })`, {
        hint: 'List every net command in the plugin options on both sides.',
      })
    }
    const pending = new PendingCommand(def, this.nextCommand++)
    const connection = this.connection
    if (!connection || !this.world.resource(NetRole).connected) {
      pending.status = 'rejected'
      pending.error = new ShardError('net/not-connected', `Can't send ${def.name}: not connected`)
      return pending
    }
    this.pending.set(pending.seq, pending)
    header(this.out, Msg.command, this.world.resource(FixedTime).tick)
    this.out.varuint(pending.seq)
    this.out.varuint(index)
    this.commandCodecs[index]!.encode(data, this.out)
    this.fragmenter.send(connection, 'reliable', this.out.finish(), this.config.maxMessage)
    return pending
  }
}

const SIZE = InterpBuffer.SIZE

function pushSample(list: number[], v: number): void {
  list.push(v)
  if (list.length > SAMPLE_WINDOW) list.shift()
}

function median(list: readonly number[], scratch: number[]): number {
  scratch.length = 0
  for (const v of list) scratch.push(v)
  scratch.sort((a, b) => a - b)
  const n = scratch.length
  if (n === 0) return 0
  return n % 2 === 1 ? scratch[(n - 1) / 2]! : (scratch[n / 2 - 1]! + scratch[n / 2]!) / 2
}
