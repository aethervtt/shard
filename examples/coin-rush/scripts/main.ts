import {
  defineSystem,
  type Entity,
  FixedUpdate,
  type Query,
  type Rng,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { addActions, defineActions, InputQueue } from '@aethervtt/shard-input'
import {
  commands,
  connected,
  defineNetCommand,
  defineNetEvent,
  NetRole,
  onClient,
  onServer,
  Replicated,
  replicate,
  sendCommand,
  sendEvent,
} from '@aethervtt/shard-net'
import { defineProject } from '@aethervtt/shard-project'
import { FixedTime, GlobalRng } from '@aethervtt/shard-runtime'
import { Sprite } from '@aethervtt/shard-sprite'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform } from '@aethervtt/shard-transform'

/** Half the arena's width, in metres. */
export const ARENA = 10
export const COINS = 10
/** Headless bots play this long, then stop, so a headless run settles. */
export const BOT_SECONDS = 8
const PICKUP = 0.8

/** WASD or the arrows. */
export const Controls = defineActions('coin-rush/Controls', {
  up: { kind: 'button', bindings: ['Key:ArrowUp', 'Key:KeyW'] },
  down: { kind: 'button', bindings: ['Key:ArrowDown', 'Key:KeyS'] },
  left: { kind: 'button', bindings: ['Key:ArrowLeft', 'Key:KeyA'] },
  right: { kind: 'button', bindings: ['Key:ArrowRight', 'Key:KeyD'] },
})

const project = defineProject({
  name: 'coin-rush',
  build(app) {
    // Headless builds (servers, `shard run --net` clients) have no input plugin.
    if (app.world.hasResource(InputQueue)) addActions(app.world, Controls)
    app.addSystems(
      FixedUpdate,
      steer.runIf(onServer),
      move.runIf(onServer),
      collect.runIf(onServer),
    )
    app.addSystems(FixedUpdate, topUpCoins.runIf(onServer))
    app.addSystems(Update, play.runIf(onClient, connected), decorate.runIf(onClient))
  },
})

export const Player = project.component(
  'Player',
  {
    speed: t.f32({ default: 6, min: 0, unit: 'm/s', description: 'Running speed.' }),
    hue: t.f32({ min: 0, max: 1, description: 'The player’s colour, from the peer id.' }),
    /** Server-side steering; replicated too, so a client can tell who's moving. */
    direction: t.vec2({ description: 'Where the player is heading, length at most 1.' }),
  },
  { description: 'A player: a square that runs around collecting coins.' },
)

export const Score = project.component(
  'Score',
  { points: t.u32({ description: 'Coins collected.' }) },
  { description: 'A player’s score. Every client sees every score.' },
)

export const Coin = project.tag('Coin', { description: 'A coin to collect.' })

/** A client asks to run in a direction (zero to stop). The server validates and steers. */
export const Move = defineNetCommand('coin-rush/Move', {
  direction: t.vec2({ min: -1, max: 1 }),
})

/** Told to everyone when a coin is collected (for a sound, a toast). */
export const Collected = defineNetEvent('coin-rush/Collected', {
  peer: t.u32(),
  points: t.u32(),
})

project.net({
  replicate: [
    replicate(Transform, { mode: 'interpolate', quantize: { translation: { step: 0.01 } } }),
    replicate(Player, { quantize: { direction: { step: 0.01 } } }),
    replicate(Score),
    replicate(Coin),
  ],
  commands: [Move],
  events: [Collected],
  players: {
    spawn(world, { peer }) {
      const rng = world.resource(GlobalRng).fork(`coin-rush/spawn/${peer}`)
      world.spawn(
        [Replicated, { owner: peer }],
        [Transform, { translation: [rng.range(-ARENA, ARENA), rng.range(-ARENA, ARENA), 0.1] }],
        [Player, { hue: (peer * 0.618) % 1 }],
        [Score, {}],
      )
    },
  },
})

export default project

// ---------------------------------------------------------------------------
// Server

/** The player entity a peer owns, if it has one. */
export function playerOf(world: World, peer: number): Entity | undefined {
  for (const table of world.query({ with: [Player, Replicated] }).tables) {
    const owner = table.column(Replicated, 'owner')
    for (let row = 0; row < table.count; row++) {
      if (owner[row] === peer) return table.entities[row]
    }
  }
  return undefined
}

const steer = defineSystem({
  name: 'coin-rush/steer',
  description: 'Applies Move commands to the sender’s player.',
  run(_, world) {
    for (const cmd of commands(world, Move)) {
      const player = playerOf(world, cmd.peer)
      if (player === undefined) {
        cmd.reject('coin-rush/no-player', 'You have no player yet')
        continue
      }
      const [x, y] = cmd.data.direction
      const length = Math.sqrt(x * x + y * y)
      const scale = length > 1 ? 1 / length : 1
      world.set(player, Player, { direction: [x * scale, y * scale] })
      cmd.accept()
    }
  },
})

const move = defineSystem({
  name: 'coin-rush/move',
  description: 'Runs every player in its direction, inside the arena.',
  setup: (world) => world.query({ with: [Player, Transform] }),
  run(query: Query, world) {
    const dt = world.resource(FixedTime).step
    for (const table of query.tables) {
      const direction = table.column(Player, 'direction')
      const speed = table.column(Player, 'speed')
      const translation = table.column(Transform, 'translation')
      for (let row = 0; row < table.count; row++) {
        const dx = direction[row * 2]!
        const dy = direction[row * 2 + 1]!
        if (dx === 0 && dy === 0) continue
        const x = translation[row * 3]! + dx * speed[row]! * dt
        const y = translation[row * 3 + 1]! + dy * speed[row]! * dt
        translation[row * 3] = Math.max(-ARENA, Math.min(ARENA, x))
        translation[row * 3 + 1] = Math.max(-ARENA, Math.min(ARENA, y))
        table.markChanged(Transform, row)
      }
    }
  },
})

const collect = defineSystem({
  name: 'coin-rush/collect',
  description: 'A player touching a coin scores it, and the coin goes.',
  run(_, world) {
    const coins = world.query({ with: [Coin, Transform] })
    const taken: Entity[] = []
    for (const table of world.query({ with: [Player, Score, Transform, Replicated] }).tables) {
      for (let row = 0; row < table.count; row++) {
        const player = table.entities[row]!
        const [px, py] = world.get(player, Transform).translation
        for (const coinTable of coins.tables) {
          for (let c = 0; c < coinTable.count; c++) {
            const coin = coinTable.entities[c]!
            if (taken.includes(coin)) continue
            const [cx, cy] = world.get(coin, Transform).translation
            if ((cx - px) ** 2 + (cy - py) ** 2 > PICKUP * PICKUP) continue
            taken.push(coin)
            const points = world.get(player, Score).points + 1
            world.set(player, Score, { points })
            sendEvent(world, Collected, { peer: world.get(player, Replicated).owner, points })
          }
        }
      }
    }
    for (const coin of taken) world.despawn(coin)
  },
})

const topUpCoins = defineSystem({
  name: 'coin-rush/coins',
  description: `Keeps ${COINS} coins in the arena.`,
  setup: (world) => ({ rng: world.resource(GlobalRng).fork('coin-rush/coins') as Rng }),
  run(state, world) {
    let count = 0
    for (const table of world.query({ with: [Coin] }).tables) count += table.count
    for (; count < COINS; count++) {
      world.spawn([Replicated, {}], Coin, [
        Transform,
        { translation: [state.rng.range(-ARENA, ARENA), state.rng.range(-ARENA, ARENA), 0] },
      ])
    }
  },
})

// ---------------------------------------------------------------------------
// Client

const play = defineSystem({
  name: 'coin-rush/play',
  description:
    'Sends Move when the keys change; without a keyboard, a bot heads for the nearest coin.',
  setup: () => ({ last: [0, 0] as [number, number], frame: 0 }),
  run(state, world) {
    let next: [number, number]
    const controls = world.tryResource(Controls.resource)
    if (controls) {
      next = [
        (controls.pressed('right') ? 1 : 0) - (controls.pressed('left') ? 1 : 0),
        (controls.pressed('up') ? 1 : 0) - (controls.pressed('down') ? 1 : 0),
      ]
    } else {
      // Headless clients (`shard run --net`) play as bots, a few times a second, for a while.
      if (state.frame++ % 15 !== 0) return
      next = world.resource(FixedTime).elapsed < BOT_SECONDS ? botDirection(world) : [0, 0]
    }
    if (Math.abs(next[0] - state.last[0]) < 0.05 && Math.abs(next[1] - state.last[1]) < 0.05) return
    state.last = next
    sendCommand(world, Move, { direction: next })
  },
})

/** Toward the nearest coin this client can see, or still. */
export function botDirection(world: World): [number, number] {
  const peer = world.resource(NetRole).peer
  const me = playerOf(world, peer)
  if (me === undefined) return [0, 0]
  const [px, py] = world.get(me, Transform).translation
  let best: [number, number] = [0, 0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const table of world.query({ with: [Coin, Transform] }).tables) {
    const translation = table.column(Transform, 'translation')
    for (let row = 0; row < table.count; row++) {
      const dx = translation[row * 3]! - px
      const dy = translation[row * 3 + 1]! - py
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < bestDistance && d > 1e-3) {
        bestDistance = d
        best = [dx / d, dy / d]
      }
    }
  }
  return best
}

const decorate = defineSystem({
  name: 'coin-rush/decorate',
  description:
    'Gives replicated players and coins a sprite when they arrive (display builds only).',
  setup: () => ({ white: undefined as unknown }),
  run(state, world) {
    const textures = world.tryResource(Textures)
    if (!textures) return
    state.white ??= textures.add(
      Texture.create({ width: 4, height: 4, mips: [new Uint8Array(64).fill(255)] }),
    )
    const fresh: [Entity, [number, number, number, number], number][] = []
    for (const table of world.query({ with: [Player], without: [Sprite] }).tables) {
      const hue = table.column(Player, 'hue')
      for (let row = 0; row < table.count; row++) {
        fresh.push([table.entities[row]!, hsl(hue[row]!), 0.9])
      }
    }
    for (const table of world.query({ with: [Coin], without: [Sprite] }).tables) {
      for (let row = 0; row < table.count; row++) {
        fresh.push([table.entities[row]!, [1, 0.8, 0.1, 1], 0.4])
      }
    }
    for (const [entity, color, size] of fresh) {
      world.add(entity, Sprite, { texture: state.white as never, color, size: [size, size] })
    }
  },
})

/** A bright colour from a hue in [0, 1). */
function hsl(h: number): [number, number, number, number] {
  const k = (n: number) => (n + h * 12) % 12
  const f = (n: number) => 0.55 - 0.45 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0), f(8), f(4), 1]
}
