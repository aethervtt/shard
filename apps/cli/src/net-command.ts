import { ShardError } from '@aethervtt/shard-core'
import { NetRole, netPlugin, netSession } from '@aethervtt/shard-net'
import { netHarness } from '@aethervtt/shard-net/testing'
import { lobbyServer } from '@aethervtt/shard-net-webrtc/server'
import { type WebSocketListener, webSocketServer } from '@aethervtt/shard-net-websocket/server'
import { type HeadlessCode, loadHeadlessCode, worldHash } from '@aethervtt/shard-node'
import { type ProjectNetOptions, projectNet } from '@aethervtt/shard-project'
import { intervalRunner } from '@aethervtt/shard-runtime'
import type { CommandContext } from './commands'
import { EXIT } from './output'

export interface NetSpec {
  clients: number
  latency: number
  jitter: number
  loss: number
  duplicate: number
}

/** `clients=2,latency=0.08,jitter=0.02,loss=0.05`: seconds and probabilities. */
export function parseNetSpec(spec: string): NetSpec {
  const out: NetSpec = { clients: 2, latency: 0, jitter: 0, loss: 0, duplicate: 0 }
  for (const part of spec.split(',').filter(Boolean)) {
    const [key, value] = part.split('=') as [string, string | undefined]
    const n = Number(value)
    if (!(key in out) || value === undefined || !Number.isFinite(n) || n < 0) {
      throw new ShardError('cli/usage', `Bad --net entry "${part}"`, {
        hint: 'Use --net clients=2,latency=0.08,jitter=0.02,loss=0.05 (seconds, probabilities).',
      })
    }
    out[key as keyof NetSpec] = n
  }
  if (!Number.isInteger(out.clients) || out.clients < 1) {
    throw new ShardError('cli/usage', '--net clients must be a whole number of at least 1')
  }
  return out
}

function requireNet(code: HeadlessCode): ProjectNetOptions {
  const net = projectNet(code.project)
  if (!net) {
    throw new ShardError(
      'project/not-multiplayer',
      `${code.manifest.name} has no project.net(...)`,
      {
        hint: 'Call project.net({ replicate, commands, … }) in the entry to make it multiplayer.',
      },
    )
  }
  return net
}

function seedOf(ctx: CommandContext): number | undefined {
  const seed = ctx.flags.seed
  if (seed === undefined) return undefined
  const n = Number(seed)
  if (!Number.isFinite(n))
    throw new ShardError('cli/usage', `--seed ${String(seed)} isn't a number`)
  return n
}

/**
 * `shard run --net …` (0092): a server and N headless clients in one process, over conditioned
 * loopback on one fake clock. Prints every world's hash and whether the clients converged.
 */
export async function runNet(ctx: CommandContext, frames: number): Promise<number> {
  const spec = parseNetSpec(String(ctx.flags.net))
  const seed = seedOf(ctx)
  const code = await loadHeadlessCode({
    root: ctx.project,
    ...(seed === undefined ? {} : { seed }),
  })
  try {
    const net = requireNet(code)
    const start = performance.now()
    const harness = await netHarness({
      clients: spec.clients,
      net,
      createApp: () => code.build(),
      afterInit: (app) => code.prepare(app),
      conditions: {
        latency: spec.latency,
        jitter: spec.jitter,
        loss: spec.loss,
        duplicate: spec.duplicate,
        seed: code.manifest.seed,
      },
    })
    try {
      await harness.connect()
      await harness.run(frames)
      // Let what's in flight arrive before comparing.
      await harness.run(60)
      const defs = netSession(harness.server.world).manifest.components.map((c) => c.def)
      const differences = harness.differences(...defs)
      const result = {
        frames,
        seed: code.manifest.seed,
        net: spec,
        server: {
          hash: worldHash(harness.server.world),
          entities: harness.server.world.entityCount,
        },
        clients: harness.clients.map((c) => ({
          peer: c.world.resource(NetRole).peer,
          hash: worldHash(c.world),
          entities: c.world.entityCount,
        })),
        converged: differences.length === 0,
        differences: differences.slice(0, 20),
        ms: Math.round(performance.now() - start),
      }
      ctx.out.result(
        result,
        [
          `Ran ${frames} frames with ${spec.clients} client(s) in ${result.ms} ms.`,
          `server   ${result.server.hash.slice(0, 16)}…  ${result.server.entities} entities`,
          ...result.clients.map(
            (c) =>
              `peer ${String(c.peer).padEnd(4)} ${c.hash.slice(0, 16)}…  ${c.entities} entities`,
          ),
          result.converged
            ? 'Clients converged on the server.'
            : `Not converged 60 frames after the run (still in motion, or a bug):\n  ${result.differences.join('\n  ')}`,
        ].join('\n'),
      )
      // Not converging is data, not a failure: a game still in motion differs by the lag.
      return EXIT.ok
    } finally {
      await harness.dispose()
    }
  } finally {
    await code.close()
  }
}

function portFlag(ctx: CommandContext, fallback: number): number {
  const port = ctx.flags.port === undefined ? fallback : Number(ctx.flags.port)
  if (!Number.isInteger(port) || port < 0) {
    throw new ShardError('cli/usage', `--port ${String(ctx.flags.port)} isn't a port`)
  }
  return port
}

function untilStopped(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
}

/**
 * `shard lobby` (0091): room codes and WebRTC signaling for peer-to-peer games, until stopped.
 * It needs no project: one lobby serves any number of games.
 */
export async function lobby(ctx: CommandContext): Promise<number> {
  const host = (ctx.flags.host as string | undefined) ?? '127.0.0.1'
  const server = await lobbyServer({ port: portFlag(ctx, 7500), host })
  const url = `ws://${host}:${server.port}`
  ctx.out.result(
    { url, port: server.port },
    `Lobby at ${url}. Host with \`shard dev --lobby ${url}\` and ?host; join with ?join=<code>. Ctrl-C stops.`,
  )
  await untilStopped()
  await server.close()
  return EXIT.ok
}

/** `shard server` (0092): the project as a dedicated WebSocket server, until stopped. */
export async function server(ctx: CommandContext): Promise<number> {
  const host = (ctx.flags.host as string | undefined) ?? '127.0.0.1'
  const requested = portFlag(ctx, 7000)
  const seed = seedOf(ctx)
  const code = await loadHeadlessCode({
    root: ctx.project,
    ...(seed === undefined ? {} : { seed }),
  })
  try {
    const net = requireNet(code)
    const app = code.build([
      netPlugin({ ...net, role: 'server', transport: webSocketServer({ port: requested, host }) }),
    ])
    await app.init()
    await code.prepare(app)
    const session = netSession(app.world)
    await session.ready
    const port = (session.server!.listener as WebSocketListener).port
    app.setRunner(intervalRunner())
    const running = app.run()
    const url = `ws://${host}:${port}`
    ctx.out.result(
      { url, port, project: code.manifest.name },
      `Serving ${code.manifest.name} at ${url}. Join with \`shard dev --connect ${url}\`. Ctrl-C stops.`,
    )
    await untilStopped()
    ctx.out.say('Stopping: saving players…')
    await app.dispose()
    await running
    return EXIT.ok
  } finally {
    await code.close()
  }
}
