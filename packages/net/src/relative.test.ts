import {
  defineSystem,
  type Entity,
  FixedUpdate,
  PreUpdate,
  Startup,
  type World,
} from '@aethervtt/shard-core'
import { definePlugin, FixedTime } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Anchor,
  NetClock,
  NetSystems,
  RelativeTo,
  RelativeTransform,
  Replicated,
  replicate,
} from '.'
import { type NetHarness, netHarness } from './testing'

type V3 = [number, number, number]
type Q = [number, number, number, number]

/** Two platforms each machine floats itself from the server tick: a raft and a ferry. */
function deck(key: string, tick: number): { t: V3; r: Q } {
  const s = tick / 60
  if (key === 'raft') {
    return {
      t: [3 * Math.cos(0.5 * s), 0.4 * Math.sin(2.1 * s), 3 * Math.sin(0.5 * s)],
      r: mul(axis([0, 1, 0], 0.6 * s), axis([1, 0, 0], 0.1 * Math.sin(1.3 * s))),
    }
  }
  // Alongside the raft, rolling and turning its own way.
  return {
    t: [3 * Math.cos(0.5 * s) + 2.5, 0.25 * Math.sin(1.6 * s), 3 * Math.sin(0.5 * s)],
    r: mul(axis([0, 1, 0], 0.45 * s), axis([0, 0, 1], 0.08 * Math.sin(1.1 * s))),
  }
}

function axis(a: V3, angle: number): Q {
  const h = Math.sin(angle / 2)
  return [a[0] * h, a[1] * h, a[2] * h, Math.cos(angle / 2)]
}

function mul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function rotate(q: Q, v: V3): V3 {
  const p = mul(mul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]])
  return [p[0], p[1], p[2]]
}

/** World position of a point at `local` on a platform. */
function onDeck(d: { t: V3; r: Q }, local: V3): V3 {
  const p = rotate(d.r, local)
  return [p[0] + d.t[0], p[1] + d.t[1], p[2] + d.t[2]]
}

/** A world position in a platform's space. */
function inDeck(d: { t: V3; r: Q }, world: V3): V3 {
  return rotate(
    [-d.r[0], -d.r[1], -d.r[2], d.r[3]],
    [world[0] - d.t[0], world[1] - d.t[1], world[2] - d.t[2]],
  )
}

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2)

function pose(world: World, e: Entity, d: { t: V3; r: Q }): void {
  world.set(e, Transform, { translation: d.t, rotation: d.r })
}

function decksOf(world: World): Map<string, Entity> {
  const out = new Map<string, Entity>()
  for (const table of world.query({ with: [Anchor] }).tables) {
    const keys = table.column(Anchor, 'key')
    for (let row = 0; row < table.count; row++) out.set(keys[row]!, table.entities[row]!)
  }
  return out
}

/** Every machine spawns both platforms itself: they aren't replicated. */
const spawnDecks = defineSystem({
  name: 'reltest/spawn-decks',
  run(_, world) {
    for (const key of ['raft', 'ferry']) world.spawn([Anchor, { key }], Transform)
  },
})

/** Server: platforms at the tick; the body stands where the script says. */
interface Script {
  /** The body's platform and where on it, or its world position once off. */
  on: string | undefined
  local: V3
  world: V3
}
const script: Script = { on: 'raft', local: [1.2, 0.5, -0.6], world: [0, 0, 0] }
let body: Entity = -1

const serverRules = definePlugin({
  name: 'reltest/server',
  build(app) {
    app.addSystems(Startup, spawnDecks)
    app.addSystems(
      FixedUpdate,
      defineSystem({
        name: 'reltest/float',
        run(_, world) {
          const tick = world.resource(FixedTime).tick
          const decks = decksOf(world)
          for (const [key, e] of decks) pose(world, e, deck(key, tick))
          if (body < 0) return
          const at = script.on
          // Physics would carry it: standing still on the platform, or still on the ground.
          const p = at ? onDeck(deck(at, tick), script.local) : script.world
          world.set(body, Transform, { translation: p })
          if (at) world.add(body, RelativeTo, { parent: decks.get(at)! })
          else world.remove(body, RelativeTo)
        },
      }),
    )
  },
})

const clientRules = definePlugin({
  name: 'reltest/client',
  build(app) {
    app.addSystems(Startup, spawnDecks)
    app.addSystems(
      PreUpdate,
      defineSystem({
        name: 'reltest/float-here',
        run(_, world) {
          // Where the server is now, as this client reckons it: no network delay.
          const tick = world.resource(NetClock).serverTick
          for (const [key, e] of decksOf(world)) pose(world, e, deck(key, tick))
        },
      }).before(NetSystems.compose),
    )
  },
})

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
  body = -1
})

describe('transforms relative to a parent (0126)', () => {
  it('draws a body on the platform each client floats, and lands it when it steps off', async () => {
    script.on = 'raft'
    script.local = [1.2, 0.5, -0.6]
    net = await netHarness({
      clients: 2,
      net: {
        replicate: [
          replicate(Transform, { mode: 'interpolate', quantize: { translation: { step: 0.001 } } }),
        ],
      },
      server: () => [serverRules],
      client: () => [clientRules],
      conditions: { latency: 0.04, jitter: 0.005, seed: 3 },
    })
    await net.connect()
    const server = net.server.world
    body = server.spawn(Replicated, Transform)
    net.step(120)

    const bodies = net.clients.map((_, i) => net!.clientEntity(i, body)!)
    const clientDeck = (i: number, key: string) => {
      const world = net!.clients[i]!.world
      const tr = world.get(decksOf(world).get(key)!, Transform)
      return { t: [...tr.translation] as V3, r: [...tr.rotation] as Q }
    }
    const at = (i: number) => [...net!.clients[i]!.world.get(bodies[i]!, Transform).translation]

    // Aboard: in the platform's space, where the server has it; not trailing the platform.
    const sample = (key: string, local: V3, frames: number) => {
      let worst = 0
      let trail = 0
      for (let f = 0; f < frames; f++) {
        net!.step(1)
        expect(server.get(body, RelativeTransform).anchor).toBe(key)
        for (let i = 0; i < bodies.length; i++) {
          const d = clientDeck(i, key)
          worst = Math.max(worst, dist(inDeck(d, at(i) as V3), local))
          // The replicated world Transform alone, a few ticks late: what this replaces.
          const late = net!.clients[i]!.world.resource(NetClock).serverTick - 8
          trail = Math.max(trail, dist(onDeck(deck(key, late), local), onDeck(d, local)))
        }
      }
      return { worst, trail }
    }
    const raft = sample('raft', script.local, 120)
    expect(raft.worst).toBeLessThan(0.003)
    // The platform moves centimetres in the time a world-space pose arrives late.
    expect(raft.trail).toBeGreaterThan(0.1)

    // Across to the other platform, back, and off onto the ground: no frame jumps. Each frame
    // moves about as far as the body moves before and after, never the 10+ cm a pop would be.
    const walk = (frames: number) => {
      const steps: number[] = []
      const last = net!.clients.map((_, i) => at(i))
      for (let f = 0; f < frames; f++) {
        net!.step(1)
        for (let i = 0; i < bodies.length; i++) {
          const p = at(i)
          steps.push(dist(p, last[i]!))
          last[i] = p
        }
      }
      return steps
    }
    const tick = () => server.resource(FixedTime).tick
    const step = (to: string | undefined) => {
      const before = walk(20)
      const from = deck(script.on!, tick())
      const here = onDeck(from, script.local)
      if (to) script.local = inDeck(deck(to, tick()), here)
      else script.world = here
      script.on = to
      const after = walk(90)
      const pace = Math.max(...before, ...after.slice(-20))
      expect(Math.max(...after)).toBeLessThan(pace * 1.25 + 0.01)
      return before
    }
    step('ferry')
    expect(sample('ferry', script.local, 30).worst).toBeLessThan(0.003)
    step('raft')
    expect(sample('raft', script.local, 30).worst).toBeLessThan(0.003)
    // Off a platform moving a few centimetres a frame.
    expect(Math.min(...step(undefined))).toBeGreaterThan(0.01)
    expect(server.has(body, RelativeTransform)).toBe(false)
    for (let i = 0; i < bodies.length; i++) {
      const world = net.clients[i]!.world
      expect(world.has(bodies[i]!, RelativeTransform)).toBe(false)
      // Landed where the server has it.
      expect(dist(at(i), script.world)).toBeLessThan(0.003)
    }
  })

  it('leaves entities without a parent in world space', async () => {
    net = await netHarness({
      clients: 1,
      net: { replicate: [replicate(Transform)] },
      server: () => [serverRules],
      client: () => [clientRules],
    })
    await net.connect()
    const server = net.server.world
    const crate = server.spawn(Replicated, [Transform, { translation: [2, 1, 3] }])
    net.step(20)
    const client = net.clients[0]!.world
    const local = net.clientEntity(0, crate)!
    expect(server.has(crate, RelativeTransform)).toBe(false)
    expect(client.has(local, RelativeTransform)).toBe(false)
    expect([...client.get(local, Transform).translation]).toEqual([2, 1, 3])
  })
})
