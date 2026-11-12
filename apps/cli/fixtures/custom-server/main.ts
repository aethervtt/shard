// A project's own game server, shaped like risen's and my-hotel's (0111): the game's authority
// beside an HTTP API of its own on Bun.serve. From an export it opens the game with openExportGame
// and meets the launch contract: SHARD_DIR, PORT, HOST, SHARD_DATA, a ready line with --json,
// SIGTERM stores players and exits 0, and with SHARD_SIDECAR, so does its stdin closing.
import { netPlugin, netSession } from '@aethervtt/shard-net'
import { type WebSocketListener, webSocketServer } from '@aethervtt/shard-net-websocket/server'
import { openExportGame } from '@aethervtt/shard-node/serve'
import { projectNet } from '@aethervtt/shard-project/export'
import { enginePlugins } from '@aethervtt/shard-project/plugins'
import project from '../../../../examples/coin-rush/scripts/main'

const host = process.env.HOST ?? '127.0.0.1'
const net = projectNet(project)!
const game = await openExportGame({
  dir: process.env.SHARD_DIR!,
  project,
  plugins: enginePlugins,
  dataDir: process.env.SHARD_DATA,
  configure(app) {
    app.addPlugin(
      netPlugin({
        ...net,
        role: 'server',
        transport: webSocketServer({ port: Number(process.env.PORT ?? 0), host }),
      }),
    )
  },
})
await netSession(game.app.world).ready
const port = (netSession(game.app.world).server!.listener as WebSocketListener).port
const api = Bun.serve({
  hostname: host,
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === '/health') {
      return Response.json({ ok: true, game: game.build.project.name, custom: true })
    }
    return new Response('Not found', { status: 404 })
  },
})
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ url: `ws://${host}:${port}`, http: `http://${host}:${api.port}` }))
}
const stop = async () => {
  api.stop()
  await game.close()
  process.exit(0)
}
process.once('SIGTERM', stop)
// As a sidecar, stop with the app that started it: its stdin closes when the app dies.
if (process.env.SHARD_SIDECAR) process.stdin.once('end', stop).resume()
