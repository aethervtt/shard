import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NetRole, netPlugin, netSession } from '@aethervtt/shard-net'
import { webRtcLobby } from '@aethervtt/shard-net-webrtc'
import { webSocketTransport } from '@aethervtt/shard-net-websocket'
import { loadHeadlessCode } from '@aethervtt/shard-node'
import { projectNet } from '@aethervtt/shard-project'
import { Gpu } from '@aethervtt/shard-render'
import { describe, expect, it, onTestFinished } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const bin = resolve(here, '../bin/shard.mjs')
const coinRush = resolve(here, '../../../examples/coin-rush')
const mazeChase = resolve(here, '../../../examples/maze-chase')

function shard(args: string[], cwd = coinRush) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: 180_000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) }
}

describe('multiplayer commands (0092)', () => {
  it('run --net runs a server and clients headless, converges, and repeats its hashes', () => {
    const args = ['run', '--net', 'clients=2,latency=0.05,jitter=0.01,loss=0.05', '--seed', '3']
    const a = shard([...args, '--json'])
    expect(a.code, a.stderr).toBe(0)
    const first = a.json()
    expect(first.converged).toBe(true)
    expect(first.clients).toHaveLength(2)
    expect(first.server.hash).toMatch(/^[0-9a-f]{64}$/)
    const second = shard([...args, '--json']).json()
    expect(second.server.hash).toBe(first.server.hash)
    expect(second.clients.map((c: { hash: string }) => c.hash)).toEqual(
      first.clients.map((c: { hash: string }) => c.hash),
    )
    expect(shard(['run', '--net', 'clients=zero']).code).toBe(3)
  })

  it('server serves the game over WebSocket and stops on SIGINT', async () => {
    const child = spawn(process.execPath, [bin, 'server', '--port', '0', '--json'], {
      cwd: coinRush,
    })
    onTestFinished(() => {
      if (child.exitCode !== null) return
      child.kill('SIGINT')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref()
    })
    const info = await new Promise<{ url: string }>((resolveInfo, reject) => {
      let out = ''
      child.stdout.on('data', (d) => {
        out += d
        try {
          resolveInfo(JSON.parse(out))
        } catch {}
      })
      child.on('exit', (code) => reject(new Error(`server exited ${code}`)))
    })
    expect(info.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)

    // A headless client of the same project joins and receives its player and the coins.
    const code = await loadHeadlessCode({ root: coinRush, code: 'source' })
    const net = projectNet(code.project)!
    const app = code.build([
      netPlugin({ ...net, role: 'client', transport: webSocketTransport(), address: info.url }),
    ])
    await app.init()
    await netSession(app.world).ready
    const received = () => netSession(app.world).client!.byNetId.size
    for (let i = 0; i < 400 && received() < 11; i++) {
      app.update(1 / 60)
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(app.world.resource(NetRole).connected).toBe(true)
    expect(received()).toBe(11) // one player and ten coins
    await app.dispose()
    await code.close()

    const exited = new Promise<number | null>((r) => child.on('exit', r))
    child.kill('SIGINT')
    expect(await exited).toBe(0)
  })

  it('lobby runs room codes and signaling, lists rooms, and stops on SIGINT', async () => {
    const child = spawn(process.execPath, [bin, 'lobby', '--port', '0', '--json'], {
      cwd: coinRush,
    })
    onTestFinished(() => {
      if (child.exitCode !== null) return
      child.kill('SIGINT')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref()
    })
    const info = await new Promise<{ url: string }>((resolveInfo, reject) => {
      let out = ''
      child.stdout.on('data', (d) => {
        out += d
        try {
          resolveInfo(JSON.parse(out))
        } catch {}
      })
      child.on('exit', (code) => reject(new Error(`lobby exited ${code}`)))
    })
    // Hosting and listing need only the lobby socket; joining (WebRTC) is 0091's tests.
    const session = webRtcLobby({ url: info.url })
    const { code, listener } = await session.host({ meta: { project: 'coin-rush' }, maxPeers: 4 })
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    expect(await session.list!({ project: 'coin-rush' })).toEqual([
      { code, meta: { project: 'coin-rush' }, peers: 0, maxPeers: 4 },
    ])
    await listener.close()
    const exited = new Promise<number | null>((r) => child.on('exit', r))
    child.kill('SIGINT')
    expect(await exited).toBe(0)
  })

  it('refuses a project without project.net', () => {
    const r = shard(['server', '--port', '0', '--json'], mazeChase)
    expect(r.code).toBe(2)
    expect(r.json().error.code).toBe('project/not-multiplayer')
  })

  it('builds a sprite and input project without display plugins or a GPU', async () => {
    // coin-rush's manifest is ["sprite", "input"]; its code checks for input before using it.
    const code = await loadHeadlessCode({ root: coinRush, code: 'source' })
    const app = code.build()
    await app.init()
    expect(app.world.hasResource(Gpu)).toBe(false)
    expect(app.methods.some((m) => m.name.startsWith('render.'))).toBe(false)
    await app.dispose()
    await code.close()
  })
})
