import { defineSystem, type Entity, Startup, type World } from '@aethervtt/shard-core'
import { NetRole, OwnerSimulated, Replicated, replicate, sendCommand } from '@aethervtt/shard-net'
import { netHarness } from '@aethervtt/shard-net/testing'
import { physics3dPlugin } from '@aethervtt/shard-physics'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import { VehicleInput, VehicleState } from './components'
import { groundTiles } from './ground'
import { setDriver, VehicleDrive, vehicleNetPlugin, vehicleReplicate } from './net'
import { vehiclePlugin } from './plugin'
import { spawnVehicle } from './spawn'

/** Ground in every app (static, not replicated). */
const groundPlugin = () =>
  definePlugin({
    name: 'test/ground',
    build(app) {
      app.addSystems(
        Startup,
        defineSystem({ name: 'test/ground', run: (_, world) => void groundTiles(world, {}) }),
      )
    },
  })

/** Clients spawn a replicated vehicle from its prefab string; it simulates while they own it. */
function spawnPrefab(world: World, prefab: string): Entity {
  if (!prefab.startsWith('vehicle:')) return world.spawn()
  const { chassis } = spawnVehicle(world, { at: [0, 5, 0] })
  world.add(chassis, OwnerSimulated)
  return chassis
}

const pos = (world: World, e: Entity) => world.get(e, Transform).translation

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

describe('driver-owned vehicles', () => {
  it('a client drives, another sees it, and a forged state is rejected and corrected', async () => {
    const net = await netHarness({
      clients: 2,
      plugins: () => [
        TransformPlugin,
        physics3dPlugin({ deterministic: true }),
        vehiclePlugin(),
        vehicleNetPlugin(),
        groundPlugin(),
      ],
      net: {
        replicate: [replicate(Transform, { mode: 'interpolate' }), ...vehicleReplicate()],
        commands: [VehicleDrive],
      },
      clientNet: () => ({ spawnPrefab }),
      conditions: { latency: 0.08, seed: 3 },
    })
    dispose = () => net.dispose()
    await net.connect()
    const [a, b] = net.clients as [(typeof net.clients)[0], (typeof net.clients)[0]]
    const peerA = a.world.resource(NetRole).peer
    // The server's vehicle, driven by client A.
    const { chassis } = spawnVehicle(net.server.world)
    net.server.world.add(chassis, Replicated, { prefab: 'vehicle:sedan', owner: 0 })
    net.server.world.add(chassis, OwnerSimulated)
    await net.run(60)
    setDriver(net.server.world, chassis, peerA)
    await net.run(30)
    const carA = net.clientEntity(0, chassis)!
    const carB = net.clientEntity(1, chassis)!
    expect(carA).toBeDefined()
    expect(carB).toBeDefined()
    // A drives a lap: a circle at a steady throttle.
    a.world.set(carA, VehicleInput, { throttle: 0.5, steer: 0.4 })
    let worst = 0
    let path = 0
    let prev = [...pos(net.server.world, chassis)]
    for (let i = 0; i < 60 * 12; i++) {
      await net.run(1)
      const now = pos(net.server.world, chassis)
      path += Math.hypot(now[0] - prev[0]!, now[2] - prev[2]!)
      prev = [...now]
      if (i < 60) continue
      // B renders behind the server by its interpolation delay: compare against the speed it
      // covers in that time (0087's interpolation error), plus a margin.
      const s = pos(net.server.world, chassis)
      const pb = pos(b.world, carB)
      const gap = Math.hypot(s[0] - pb[0], s[2] - pb[2])
      const speed = Math.abs(net.server.world.get(chassis, VehicleState).speed)
      worst = Math.max(worst, gap - speed * 0.25)
    }
    // It went round (A's states reached the server) and B followed within the delay's distance.
    expect(path).toBeGreaterThan(40)
    expect(worst).toBeLessThan(1)
    // A forged state at three times top speed, 50 m ahead.
    const here = pos(net.server.world, chassis)
    const pending = sendCommand(a.world, VehicleDrive, {
      vehicle: carA,
      translation: [here[0], here[1], here[2] - 50],
      rotation: [0, 0, 0, 1],
      linear: [0, 0, -3 * 60],
      angular: [0, 0, 0],
    })
    await net.run(30)
    expect(pending.status).toBe('rejected')
    expect(pending.error?.code ?? pending.error).toMatch(/vehicle\/rejected/)
    const after = pos(net.server.world, chassis)
    expect(Math.hypot(after[0] - here[0], after[2] - here[2])).toBeLessThan(10)
    // The server took the vehicle for a moment; A follows its pose, then gets it back.
    expect(net.server.world.get(chassis, Replicated).owner).toBe(0)
    await net.run(30)
    const pa = pos(a.world, carA)
    const ps = pos(net.server.world, chassis)
    expect(Math.hypot(pa[0] - ps[0], pa[2] - ps[2])).toBeLessThan(3)
    await net.run(60)
    expect(net.server.world.get(chassis, Replicated).owner).toBe(peerA)
  }, 60_000)
})
