import { defineComponent, t } from '@aethervtt/shard-core'
import { NetRole, netPlugin, netSession, Replicated, replicate } from '@aethervtt/shard-net'
import { App } from '@aethervtt/shard-runtime'
import { afterEach, expect, it } from 'vitest'
import { webSocketTransport } from '.'
import { type WebSocketListener, webSocketServer } from './server'

const Note = defineComponent('wstest/Note', { text: t.string(), n: t.u32() })

const apps: App[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose()
})

async function pair(maxMessage?: number) {
  const server = new App()
  server.addPlugin(
    netPlugin({
      role: 'server',
      transport: webSocketServer({ maxMessage }),
      replicate: [replicate(Note)],
    }),
  )
  await server.init()
  await netSession(server.world).ready
  apps.push(server)
  const port = (netSession(server.world).server!.listener as WebSocketListener).port
  const client = new App()
  client.addPlugin(
    netPlugin({
      role: 'client',
      transport: webSocketTransport({ maxMessage }),
      address: `ws://127.0.0.1:${port}`,
      replicate: [replicate(Note)],
    }),
  )
  await client.init()
  await netSession(client.world).ready
  apps.push(client)
  return { server, client }
}

/** Steps both apps in real time until `done` holds. */
async function until(apps: App[], done: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out')
    for (const app of apps) app.update(1 / 60)
    await new Promise((r) => setTimeout(r, 2))
  }
}

it('connects, replicates and splits large messages over a real socket', async () => {
  const { server, client } = await pair(512)
  await until([server, client], () => client.world.resource(NetRole).connected)
  const e = server.world.spawn([Replicated, {}], [Note, { text: 'y'.repeat(4000), n: 7 }])
  const ids = netSession(client.world).client!.byNetId
  await until([server, client], () => ids.size === 1)
  const local = [...ids.values()][0]!
  expect(client.world.get(local, Note)).toEqual({ text: 'y'.repeat(4000), n: 7 })
  server.world.set(e, Note, { n: 8 })
  await until([server, client], () => client.world.get(local, Note).n === 8)
})

it('reports a refused connection', async () => {
  const transport = webSocketTransport()
  await expect(transport.connect('ws://127.0.0.1:1')).rejects.toMatchObject({
    code: 'net/connect-failed',
  })
})
