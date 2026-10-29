import { type ComponentDef, type Entity, ShardError } from '@aethervtt/shard-core'
import { App, type Plugin } from '@aethervtt/shard-runtime'
import { NetId, NetRole } from './components'
import {
  type ConditionedTransport,
  type ConditionsOptions,
  type NetConditions,
  simulateConditions,
} from './conditions'
import { loopback } from './loopback'
import { type NetOptions, netPlugin, netSession } from './plugin'

export interface NetHarnessOptions {
  /** Plugins every app gets: a function, so each app has its own instances. */
  plugins?: () => Plugin[]
  /** Extra plugins for the server only, and for each client. */
  server?: () => Plugin[]
  client?: (index: number) => Plugin[]
  /** Net options both sides share (replicate, commands, events, tickRate…). */
  net?: Omit<NetOptions, 'role' | 'transport' | 'address' | 'session' | 'code' | 'now'>
  /** Per-side overrides (interest and budget for the server, a token for clients…). */
  serverNet?: Partial<NetOptions>
  clientNet?: (index: number) => Partial<NetOptions>
  clients?: number
  /** Conditions on every client's link (one wrapper per client, both directions). */
  conditions?: Omit<ConditionsOptions, 'now'>
  fixedHz?: number
  seed?: number
  maxMessage?: number
  /**
   * Makes each app (default `new App`): a project build, say (0092). The harness adds the net
   * plugin and initializes it; `plugins`, `server` and `client` are added too.
   */
  createApp?: (side: 'server' | 'client', index: number) => App
  /** Runs after each app's init, before it connects (an asset scan). */
  afterInit?: (app: App) => Promise<void>
}

export interface NetHarness {
  readonly server: App
  readonly clients: App[]
  /** The shared fake clock, in ms. */
  now(): number
  /** Advances every app by `ticks` fixed steps on the shared clock: server first, then clients. */
  step(ticks: number): void
  /**
   * Steps until every client has finished its handshake (at most `maxTicks`), yielding between
   * ticks so async `accept` and player hooks settle.
   */
  connect(maxTicks?: number): Promise<void>
  /** Like `step`, but yields to pending promises between ticks. */
  run(ticks: number): Promise<void>
  setConditions(client: number, conditions: Partial<NetConditions>): void
  /** Connects one more client mid-game; resolves once its connection is open. */
  addClient(): Promise<App>
  /** Disposes one client (it says goodbye to the server) and removes it from `clients`. */
  removeClient(index: number): Promise<void>
  /** Per client, what differs from the server for these components (empty when converged). */
  differences(...defs: ComponentDef[]): string[]
  converged(...defs: ComponentDef[]): boolean
  /** The client entity with the server entity's net id, if it has one. */
  clientEntity(client: number, serverEntity: Entity): Entity | undefined
  dispose(): Promise<void>
}

/**
 * A server and N clients in one process, over a conditioned loopback, stepped on one fake clock
 * (0086). Deterministic for a given seed.
 */
export async function netHarness(options: NetHarnessOptions = {}): Promise<NetHarness> {
  const fixedHz = options.fixedHz ?? 60
  const seed = options.seed ?? 1
  let clock = 0
  const now = () => clock
  const network = loopback({ maxMessage: options.maxMessage ?? 1 << 20 })
  const address = 'harness'

  const make = (side: 'server' | 'client', index: number, appSeed: number) =>
    options.createApp?.(side, index) ?? new App({ fixedHz, seed: appSeed, now })
  const server = make('server', 0, seed)
  for (const p of options.plugins?.() ?? []) server.addPlugin(p)
  for (const p of options.server?.() ?? []) server.addPlugin(p)
  server.addPlugin(
    netPlugin({
      ...options.net,
      ...options.serverNet,
      role: 'server',
      transport: network,
      address,
      now,
    }),
  )
  await server.init()
  await options.afterInit?.(server)
  await netSession(server.world).ready

  const clients: App[] = []
  const links: ConditionedTransport[] = []

  async function addClient(): Promise<App> {
    const index = clients.length
    const link = simulateConditions(network, {
      ...options.conditions,
      seed: (options.conditions?.seed ?? seed) + index * 7919,
      now,
    })
    const app = make('client', index, seed + index + 1)
    for (const p of options.plugins?.() ?? []) app.addPlugin(p)
    for (const p of options.client?.(index) ?? []) app.addPlugin(p)
    app.addPlugin(
      netPlugin({
        ...options.net,
        ...options.clientNet?.(index),
        role: 'client',
        transport: link,
        address,
        now,
      }),
    )
    await app.init()
    await options.afterInit?.(app)
    await netSession(app.world).ready
    clients.push(app)
    links.push(link)
    return app
  }

  for (let i = 0; i < (options.clients ?? 1); i++) await addClient()

  const step = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      clock += 1000 / fixedHz
      server.update(1 / fixedHz)
      for (const c of clients) c.update(1 / fixedHz)
    }
  }

  function clientEntity(client: number, serverEntity: Entity): Entity | undefined {
    const world = server.world
    if (!world.isAlive(serverEntity) || !world.has(serverEntity, NetId)) return undefined
    const id = world.get(serverEntity, NetId).id
    return netSession(clients[client]!.world).client!.byNetId.get(id)
  }

  function differences(...defs: ComponentDef[]): string[] {
    const out: string[] = []
    const session = netSession(server.world)
    const entries = session.manifest.components
    clients.forEach((app, index) => {
      const client = netSession(app.world).client!
      const peerId = app.world.resource(NetRole).peer
      const peer = session.server!.peers.get(peerId)
      if (!peer) {
        out.push(`client ${index}: not connected`)
        return
      }
      for (const e of peer.relevant.entities) {
        const id = server.world.get(e, NetId).id
        const local = client.byNetId.get(id)
        if (local === undefined) {
          out.push(`client ${index}: missing net id ${id}`)
          continue
        }
        for (const def of defs) {
          const entry = entries.find((c) => c.def === def)
          const visible =
            server.world.has(e, def) &&
            (!entry?.visibleTo || entry.visibleTo(server.world, peerId, e))
          const has = app.world.has(local, def)
          if (visible !== has) {
            out.push(
              `client ${index}: net id ${id} ${def.name} ${visible ? 'missing' : 'should be absent'}`,
            )
            continue
          }
          if (!visible) continue
          const a = def.serialize(server.world.get(e, def))
          const b = def.serialize(app.world.get(local, def))
          for (const c of def.layout) {
            const step = entry?.quantize[c.name]?.step ?? 0
            const diff =
              c.field.kind === 'quat'
                ? compareQuat(a[c.name] as number[], b[c.name] as number[], `/${c.name}`)
                : compare(a[c.name], b[c.name], `/${c.name}`, step)
            if (diff) {
              out.push(`client ${index}: net id ${id} ${def.name}${diff}`)
              break
            }
          }
        }
      }
      for (const [id] of client.byNetId) {
        const e = session.server!.byNetId.get(id)
        if (e === undefined || !peer.relevant.has(e))
          out.push(`client ${index}: extra net id ${id}`)
      }
    })
    return out
  }

  return {
    server,
    clients,
    now,
    step,
    async connect(maxTicks = 600) {
      for (let i = 0; i < maxTicks; i++) {
        if (clients.every((c) => c.world.resource(NetRole).connected)) return
        step(1)
        await yieldToPromises()
      }
      const failed = clients.find((c) => !c.world.resource(NetRole).connected)!
      throw (
        netSession(failed.world).client!.lastError ??
        new ShardError('net/connect-failed', `A client didn't connect within ${maxTicks} ticks`)
      )
    },
    async run(ticks) {
      for (let i = 0; i < ticks; i++) {
        step(1)
        await yieldToPromises()
      }
    },
    setConditions(client, conditions) {
      links[client]!.setConditions(conditions)
    },
    addClient,
    async removeClient(index) {
      const [app] = clients.splice(index, 1)
      links.splice(index, 1)
      await app?.dispose()
    },
    differences,
    converged: (...defs) => differences(...defs).length === 0,
    clientEntity,
    async dispose() {
      for (const c of clients) await c.dispose()
      await server.dispose()
    },
  }
}

/** Lets promise continuations (and zero-delay timers) run. */
function yieldToPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** q and -q are one rotation: equal when |dot| is 1 within 1e-5. */
function compareQuat(a: number[], b: number[], path: string): string {
  const dot = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!)
  return dot >= 1 - 1e-5 ? '' : ` ${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
}

/** A path and both values where JSON differs; numbers within half the step (or 1e-3) match. */
function compare(a: unknown, b: unknown, path: string, step: number): string {
  if (typeof a === 'number' && typeof b === 'number') {
    const tolerance = Math.max(step / 2 + 1e-6, 1e-3)
    return Math.abs(a - b) <= tolerance ? '' : ` ${path}: ${a} vs ${b}`
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      const d = compare(a[i], b[i], `${path}/${i}`, step)
      if (d) return d
    }
    return ''
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) {
      const d = compare(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}/${k}`,
        step,
      )
      if (d) return d
    }
    return ''
  }
  return JSON.stringify(a) === JSON.stringify(b)
    ? ''
    : ` ${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
}
