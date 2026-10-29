import { ShardError } from '@aethervtt/shard-core'
import { App, intervalRunner, type Plugin, type Runner } from '@aethervtt/shard-runtime'
import { loopback } from './loopback'
import { type NetOptions, netPlugin, netSession } from './plugin'
import type { NetConnection, NetListener, NetSessionProvider, NetTransport } from './transport'

export interface HostOptions<U = unknown, L = unknown, S = unknown> {
  /** The server App's plugins (the game's rules), made fresh for it. */
  plugins?: () => Plugin[]
  /** Server net options: replicate, commands, events, accept, players, interest, meta… */
  net: Omit<NetOptions<U, L, S>, 'role' | 'transport' | 'address' | 'session' | 'code'>
  /** How remote players reach the host: a lobby such as `webRtcLobby` (0091). */
  session: NetSessionProvider
  fixedHz?: number
  seed?: number
  /** Default `intervalRunner()`: the host keeps simulating without a display to pace it. */
  runner?: Runner
  /** Makes the server App (default `new App`): a project's headless build, say (0092). */
  createApp?: () => App
  /** Runs after the server App's init, before it runs (an asset scan). */
  afterInit?: (app: App) => Promise<void>
}

export interface Host {
  /** The server App, running. */
  readonly app: App
  /** The room code remote players join with. */
  readonly code: string
  /** The host player's own connection: spread into the client's `netPlugin`. */
  readonly local: { readonly transport: NetTransport; readonly address: string }
  /** Saves players (0090), closes the room and every connection, and stops the server. */
  stop(): Promise<void>
}

/** Listens on several listeners as one. */
function mergeListeners(listeners: readonly NetListener[]): NetListener {
  return {
    onConnection(fn: (connection: NetConnection) => void) {
      const offs = listeners.map((l) => l.onConnection(fn))
      return () => {
        for (const off of offs) off()
      }
    },
    async close() {
      await Promise.all(listeners.map((l) => l.close()))
    },
  }
}

/**
 * Hosts a game from this process (0091): runs the server App next to the player's client App,
 * takes remote players through `session`, and gives the host player a loopback connection. The
 * host player is an ordinary client of its own server.
 */
export async function startHost<U = unknown, L = unknown, S = unknown>(
  options: HostOptions<U, L, S>,
): Promise<Host> {
  const local = loopback({ maxMessage: options.session.caps?.maxMessage ?? 1 << 20 })
  const address = 'host'
  const remote = options.session
  const session: NetSessionProvider = {
    name: `host+${remote.name}`,
    ...(remote.caps ? { caps: remote.caps } : {}),
    async host(listen) {
      const [hosted, mine] = await Promise.all([remote.host(listen), local.listen!({ address })])
      return { code: hosted.code, listener: mergeListeners([hosted.listener, mine]) }
    },
    join: (code, join) => remote.join(code, join),
  }

  const app =
    options.createApp?.() ?? new App({ fixedHz: options.fixedHz ?? 60, seed: options.seed ?? 0 })
  for (const p of options.plugins?.() ?? []) app.addPlugin(p)
  app.addPlugin(netPlugin<U, L, S>({ ...options.net, role: 'server', session }))
  app.setRunner(options.runner ?? intervalRunner())
  await app.init()
  await options.afterInit?.(app)
  const net = netSession(app.world)
  await net.ready
  if (net.code === undefined) {
    throw new ShardError('net/cannot-listen', `The ${remote.name} session gave no room code`)
  }
  const running = app.run()
  return {
    app,
    code: net.code,
    local: { transport: local, address },
    async stop() {
      await app.dispose()
      await running
    },
  }
}
