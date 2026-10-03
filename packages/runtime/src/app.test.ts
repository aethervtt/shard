import {
  condition,
  defineComponent,
  defineEvent,
  defineResource,
  defineSystem,
  defineSystemSet,
  First,
  FixedUpdate,
  PostUpdate,
  ProfilerResource,
  Startup,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import { App } from './app'
import { FrameDemand, LOADING_DEMAND } from './demand'
import { LogResource } from './log'
import { definePlugin } from './plugin'
import { headlessRunner } from './runners'
import { defineState, inState, OnEnter, OnExit, setState } from './state'
import { FixedTime, Time } from './time'

const Position = defineComponent('test/Position', { value: t.vec3 })
const Velocity = defineComponent('test/Velocity', { value: t.vec3 })

/** A system that appends its name to a shared log. */
const logger = (log: string[], name: string) =>
  defineSystem({ name, run: () => void log.push(name) })

async function ready(app: App): Promise<App> {
  await app.init()
  return app
}

describe('system ordering', () => {
  it('runs systems in declared order, registration order otherwise', async () => {
    const log: string[] = []
    const a = logger(log, 'test/a')
    const b = logger(log, 'test/b')
    const c = logger(log, 'test/c')
    const d = logger(log, 'test/d')
    const app = await ready(new App().addSystems(Update, a.after(c), b, c.before(b), d))
    app.update(1 / 60)
    expect(log).toEqual(['test/c', 'test/a', 'test/b', 'test/d'])
  })

  it('orders and gates whole sets', async () => {
    const log: string[] = []
    const Input = defineSystemSet('test/Input')
    const Physics = defineSystemSet('test/Physics')
    let paused = false
    const app = await ready(
      new App()
        .addSystems(
          Update,
          logger(log, 'test/step').inSet(Physics),
          logger(log, 'test/read-keys').inSet(Input),
          logger(log, 'test/collide').inSet(Physics),
        )
        .configureSets(Update, Physics.after(Input).runIf(condition('notPaused', () => !paused))),
    )
    app.update(1 / 60)
    expect(log).toEqual(['test/read-keys', 'test/step', 'test/collide'])
    paused = true
    log.length = 0
    app.update(1 / 60)
    expect(log).toEqual(['test/read-keys'])
  })

  it('throws app/system-cycle naming every system in the cycle', async () => {
    const log: string[] = []
    const a = logger(log, 'test/a')
    const b = logger(log, 'test/b')
    const c = logger(log, 'test/c')
    const downstream = logger(log, 'test/downstream')
    const app = await ready(
      new App().addSystems(Update, a.after(c), b.after(a), c.after(b), downstream.after(a)),
    )
    let error: unknown
    try {
      app.update(1 / 60)
    } catch (err) {
      error = err
    }
    expect(error).toMatchObject({ code: 'app/system-cycle' })
    const message = (error as Error).message
    for (const name of ['test/a', 'test/b', 'test/c']) expect(message).toContain(name)
    expect(message).not.toContain('test/downstream')
  })

  it('rejects duplicate system names', () => {
    const app = new App().addSystems(Update, logger([], 'test/dup'))
    expect(() => app.addSystems(PostUpdate, logger([], 'test/dup'))).toThrow(
      expect.objectContaining({ code: 'app/duplicate-system' }),
    )
  })

  it('wraps system errors with the system name', async () => {
    const boom = defineSystem({
      name: 'test/boom',
      run: () => {
        throw new Error('kaput')
      },
    })
    const app = await ready(new App().addSystems(Update, boom))
    expect(() => app.update(1 / 60)).toThrow(
      expect.objectContaining({
        code: 'app/system-failed',
        message: expect.stringContaining('test/boom'),
      }),
    )
  })
})

describe('commands and change detection through systems', () => {
  it('applies commands after each system, so later systems see them', async () => {
    const seen: number[] = []
    const spawner = defineSystem({
      name: 'test/spawner',
      run: (_, __, ctx) => void ctx.commands.spawn(Position),
    })
    const counter = defineSystem({
      name: 'test/counter',
      setup: (world) => ({ q: world.query({ with: [Position] }) }),
      run: ({ q }) => void seen.push(q.count()),
    })
    const app = await ready(new App().addSystems(Update, spawner, counter.after(spawner)))
    app.update(1 / 60)
    app.update(1 / 60)
    expect(seen).toEqual([1, 2])
  })

  it('reports rows changed since the system last ran', async () => {
    const changedCounts: number[] = []
    const mover = defineSystem({
      name: 'test/mover',
      setup: (world) => ({ q: world.query({ with: [Position, Velocity] }) }),
      run: ({ q }, world) => {
        // Only move on even frames.
        if (world.resource(Time).frame % 2 === 1) return
        for (const table of q.tables) table.markChanged(Position)
      },
    })
    const watcher = defineSystem({
      name: 'test/watcher',
      setup: (world) => ({ q: world.query({ changed: [Position] }) }),
      run: ({ q }, _, ctx) => void changedCounts.push(q.count(ctx.lastRunTick)),
    })
    const app = await ready(
      new App()
        .addSystems(
          Startup,
          defineSystem({
            name: 'test/setup',
            run: (_, world) => {
              world.spawn(Position, Velocity)
              world.spawn(Position, Velocity)
              world.spawn(Position)
            },
          }),
        )
        .addSystems(Update, mover, watcher.after(mover)),
    )
    for (let i = 0; i < 4; i++) app.update(1 / 60)
    // Frame 0: everything is new. Frame 1: nothing moved. Frame 2: the two movers.
    expect(changedCounts).toEqual([3, 0, 2, 0])
  })

  it('gives each system its own event reader', async () => {
    const Ping = defineEvent<number>('test/Ping')
    const got: number[][] = []
    const sender = defineSystem({
      name: 'test/sender',
      run: (_, world) => world.send(Ping, world.resource(Time).frame),
    })
    const receiver = defineSystem({
      name: 'test/receiver',
      run: (_, __, ctx) => void got.push([...ctx.reader(Ping).read()]),
    })
    const app = await ready(new App().addSystems(Update, sender, receiver.after(sender)))
    for (let i = 0; i < 3; i++) app.update(1 / 60)
    expect(got).toEqual([[0], [1], [2]])
  })
})

describe('fixed timestep', () => {
  it('runs floor(accumulated / step) times, at most 5, with correct alpha', async () => {
    let runs = 0
    const tick = defineSystem({ name: 'test/fixed', run: () => void runs++ })
    const app = await ready(new App({ fixedHz: 50 }).addSystems(FixedUpdate, tick))
    const fixed = app.world.resource(FixedTime)
    const step = 1 / 50

    app.update(step * 2.5)
    expect(runs).toBe(2)
    expect(fixed.alpha).toBeCloseTo(0.5)

    app.update(step * 0.6) // 0.5 + 0.6 = 1.1 steps
    expect(runs).toBe(3)
    expect(fixed.alpha).toBeCloseTo(0.1)

    app.update(step * 0.5)
    expect(runs).toBe(3)
    expect(fixed.steps).toBe(0)

    runs = 0
    app.update(1) // 50+ steps due; clamped
    expect(runs).toBe(5)
    expect(fixed.alpha).toBeLessThan(1)
    expect(fixed.elapsed).toBeCloseTo(step * 8)
  })

  it('does not lose steps to floating-point error at exactly one step per frame', async () => {
    let runs = 0
    const tick = defineSystem({ name: 'test/fixed-exact', run: () => void runs++ })
    const app = await ready(new App().addSystems(FixedUpdate, tick))
    for (let i = 0; i < 600; i++) app.update(1 / 60)
    expect(runs).toBe(600)
  })
})

describe('determinism', () => {
  const Rng = defineResource<{ state: number }>('test/Rng')
  const next = (world: World) => {
    const rng = world.resource(Rng)
    rng.state = (rng.state * 1664525 + 1013904223) % 4294967296
    return rng.state / 4294967296
  }

  function buildGame(): App {
    const spawn = defineSystem({
      name: 'test/spawn',
      run: (_, world, ctx) => {
        if (next(world) < 0.5) {
          ctx.commands.spawn(
            [Position, { value: [next(world), next(world), 0] }],
            [Velocity, { value: [next(world) - 0.5, next(world) - 0.5, 0] }],
          )
        }
      },
    })
    const move = defineSystem({
      name: 'test/move',
      setup: (world) => ({ q: world.query({ with: [Position, Velocity] }) }),
      run: ({ q }, world) => {
        const dt = world.resource(FixedTime).step
        for (const table of q.tables) {
          const pos = table.column(Position, 'value')
          const vel = table.column(Velocity, 'value')
          for (let i = 0; i < table.count * 3; i++) pos[i]! += vel[i]! * dt
        }
      },
    })
    const cull = defineSystem({
      name: 'test/cull',
      setup: (world) => ({ q: world.query({ with: [Position] }) }),
      run: ({ q }, world, ctx) => {
        q.each((entity, row, table) => {
          const x = table.column(Position, 'value')[row * 3]!
          if (Math.abs(x) > 2 || next(world) < 0.01) ctx.commands.despawn(entity)
        })
      },
    })
    return new App()
      .insertResource(Rng, { state: 1234 })
      .addSystems(FixedUpdate, spawn, move.after(spawn), cull.after(move))
  }

  function snapshot(world: World): string {
    const rows: string[] = []
    for (const table of world.allTables()) {
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]!
        const values = table.components.map((c) => [
          c.name,
          c.serialize(table.readComponent(c, row)),
        ])
        rows.push(JSON.stringify([entity, values]))
      }
    }
    return rows.sort().join('\n')
  }

  it('produces identical world state on every headless run', async () => {
    const runs: string[] = []
    for (let i = 0; i < 3; i++) {
      const app = buildGame().setRunner(headlessRunner({ frames: 600 }))
      await app.run()
      runs.push(snapshot(app.world))
    }
    expect(runs[0]!.length).toBeGreaterThan(0)
    expect(runs[1]).toBe(runs[0])
    expect(runs[2]).toBe(runs[0])
  })
})

describe('plugins', () => {
  it('builds in dependency order regardless of add order', async () => {
    const order: string[] = []
    const make = (name: string, dependencies: string[] = []) =>
      definePlugin({ name, dependencies, build: () => void order.push(name) })
    await new App()
      .addPlugin(make('physics', ['transform', 'core/time']), make('transform'), make('audio'))
      .init()
    expect(order).toEqual(['transform', 'physics', 'audio'])
  })

  it('lets a plugin add other plugins', async () => {
    const order: string[] = []
    const inner = definePlugin({ name: 'inner', build: () => void order.push('inner') })
    const outer = definePlugin({
      name: 'outer',
      build: (app) => {
        order.push('outer')
        app.addPlugin(inner)
      },
    })
    await new App().addPlugin(outer).init()
    expect(order).toEqual(['outer', 'inner'])
  })

  it('throws app/missing-plugin and app/duplicate-plugin', async () => {
    const needy = definePlugin({ name: 'needy', dependencies: ['ghost'], build() {} })
    await expect(new App().addPlugin(needy).init()).rejects.toMatchObject({
      code: 'app/missing-plugin',
    })
    expect(() => new App().addPlugin(needy, needy)).toThrow(
      expect.objectContaining({ code: 'app/duplicate-plugin' }),
    )
  })

  it('awaits ready() hooks before Startup runs', async () => {
    const log: string[] = []
    const slow = definePlugin({
      name: 'slow',
      build: (app) =>
        void app.addSystems(
          Startup,
          defineSystem({ name: 'test/startup', run: () => void log.push('startup') }),
        ),
      ready: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        log.push('ready')
      },
    })
    const app = new App().addPlugin(slow).setRunner(headlessRunner({ frames: 1 }))
    await app.run()
    expect(log).toEqual(['ready', 'startup'])
  })

  it('refuses to update before init', () => {
    expect(() => new App().update(1 / 60)).toThrow(
      expect.objectContaining({ code: 'app/not-initialized' }),
    )
  })
})

describe('states', () => {
  it('fires OnExit then OnEnter at the start of the next frame', async () => {
    const Game = defineState('game/State', ['menu', 'playing', 'paused'])
    const log: string[] = []
    const app = await ready(
      new App()
        .initState(Game)
        .addSystems(OnEnter(Game, 'menu'), logger(log, 'test/enter-menu'))
        .addSystems(OnExit(Game, 'menu'), logger(log, 'test/exit-menu'))
        .addSystems(OnEnter(Game, 'playing'), logger(log, 'test/enter-playing'))
        .addSystems(First, logger(log, 'test/first'))
        .addSystems(Update, logger(log, 'test/play').runIf(inState(Game, 'playing'))),
    )
    app.update(1 / 60)
    expect(log).toEqual(['test/enter-menu', 'test/first'])

    log.length = 0
    setState(app.world, Game, 'playing')
    expect(log).toEqual([])
    app.update(1 / 60)
    expect(log).toEqual(['test/exit-menu', 'test/enter-playing', 'test/first', 'test/play'])
  })

  it('rejects unknown state values', () => {
    const Game = defineState('game/Mode', ['a', 'b'])
    // @ts-expect-error: not a value of the state
    expect(() => inState(Game, 'c')).toThrow(expect.objectContaining({ code: 'app/invalid-state' }))
  })
})

describe('introspection', () => {
  it('describes plugins, schedules, and ordered systems', async () => {
    const Game = defineState('game/Screen', ['title', 'play'])
    const Sim = defineSystemSet('test/Sim')
    const input = defineSystem({ name: 'test/input', description: 'Reads devices', run() {} })
    const physics = defineSystem({ name: 'test/physics', run() {} })
    const app = new App()
      .initState(Game)
      .addPlugin(definePlugin({ name: 'physics3d', dependencies: ['core/time'], build() {} }))
      .addSystems(Update, physics.inSet(Sim).after(input), input)
      .configureSets(Update, Sim.runIf(inState(Game, 'play')))
      .addSystems(FixedUpdate, defineSystem({ name: 'test/step', run() {} }))
    await app.init()

    expect(app.describe()).toEqual({
      plugins: [
        { name: 'core/time', dependencies: [] },
        { name: 'physics3d', dependencies: ['core/time'] },
      ],
      schedules: [
        {
          name: 'FixedUpdate',
          systems: [{ name: 'test/step', after: [], before: [], sets: [], conditions: [] }],
        },
        {
          name: 'Update',
          systems: [
            {
              name: 'test/input',
              description: 'Reads devices',
              after: [],
              before: [],
              sets: [],
              conditions: [],
            },
            {
              name: 'test/physics',
              after: ['test/input'],
              before: [],
              sets: ['test/Sim'],
              conditions: ['inState(game/Screen=play)'],
            },
          ],
        },
      ],
    })
  })

  it('records per-system timings', async () => {
    let now = 0
    const slow = defineSystem({
      name: 'test/slow',
      run: () => {
        now += 2
      },
    })
    const app = await ready(new App({ now: () => now }).addSystems(Update, slow))
    for (let i = 0; i < 3; i++) app.update(1 / 60)
    const timing = app.world.resource(ProfilerResource).timing('test/slow')
    expect(timing).toEqual({ last: 2, avg: 2, max: 2, samples: 3 })
  })
})

describe('frame control and log', () => {
  it('steps exactly n frames through pump and resolves waiters in order', async () => {
    let frames = 0
    const app = await ready(
      new App().addSystems(Update, defineSystem({ name: 'test/count', run: () => void frames++ })),
    )
    const { AppControlResource } = await import('./control')
    const control = app.world.resource(AppControlResource)
    const order: string[] = []
    const a = control.step(3).then(() => order.push('a'))
    const b = control.step(2).then(() => order.push('b'))
    expect(control.paused).toBe(true)
    expect(control.pendingSteps).toBe(5)
    app.pump()
    await Promise.all([a, b])
    expect(frames).toBe(5)
    expect(order).toEqual(['a', 'b'])
    expect(app.world.resource(Time).delta).toBeCloseTo(1 / 60)
  })

  it('logs ShardErrors with their code, path, and hint', async () => {
    const app = await ready(new App())
    const { LogResource } = await import('./log')
    const { ShardError } = await import('@aethervtt/shard-core')
    const log = app.world.resource(LogResource)
    log.info('hello')
    log.error(new ShardError('test/bad', 'Broken', { path: 'a/b', hint: 'Fix it' }))
    expect(log.errors()).toEqual([
      expect.objectContaining({ level: 'error', code: 'test/bad', path: 'a/b', hint: 'Fix it' }),
    ])
    expect(log.tail(10).map((e) => e.message)).toEqual(['hello', 'Broken'])
  })
})

describe('dispose (0052)', () => {
  it('disposes plugins in reverse build order, once, then refuses every call', async () => {
    const log: string[] = []
    const plugin = (name: string, dependencies: string[] = []) =>
      definePlugin({
        name,
        dependencies,
        build() {},
        dispose: async () => {
          await Promise.resolve()
          log.push(name)
        },
      })
    const app = new App().addPlugin(
      plugin('test/c', ['test/b']),
      plugin('test/a'),
      plugin('test/b', ['test/a']),
    )
    await app.init()
    app.update(1 / 60)
    await Promise.all([app.dispose(), app.dispose()])
    await app.dispose()
    expect(log).toEqual(['test/c', 'test/b', 'test/a'])
    expect(app.disposed).toBe(true)
    for (const call of [
      () => app.update(1 / 60),
      () => app.requestFrame(),
      () => app.addPlugin(plugin('test/d')),
      () => app.insertResource(defineResource<number>('test/AfterDispose'), 1),
      () => app.pump(),
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: 'runtime/disposed' }))
    }
    await expect(app.init()).rejects.toMatchObject({ code: 'runtime/disposed' })
  })

  it('keeps disposing past a plugin that throws, logs it, and rethrows the first error', async () => {
    const log: string[] = []
    const app = new App().addPlugin(
      definePlugin({ name: 'test/fine', build() {}, dispose: () => void log.push('fine') }),
      definePlugin({
        name: 'test/broken',
        build() {},
        dispose: () => {
          throw new Error('nope')
        },
      }),
    )
    await app.init()
    const logged = app.world.resource(LogResource)
    await expect(app.dispose()).rejects.toThrow('nope')
    expect(log).toEqual(['fine'])
    expect(logged.errors(5).map((e) => e.message)).toContain('nope')
  })

  it('awaits every beforeDispose, in build order, before any dispose', async () => {
    const log: string[] = []
    const plugin = (name: string, dependencies: string[] = []) =>
      definePlugin({
        name,
        dependencies,
        build() {},
        async beforeDispose() {
          await new Promise((resolve) => setTimeout(resolve, 5))
          log.push(`wait ${name}`)
        },
        dispose: () => void log.push(`dispose ${name}`),
      })
    const app = new App().addPlugin(
      plugin('test/b', ['test/a']),
      plugin('test/a'),
      definePlugin({
        name: 'test/broken-wait',
        build() {},
        beforeDispose: () => Promise.reject(new Error('stuck')),
        dispose: () => void log.push('dispose test/broken-wait'),
      }),
    )
    await app.init()
    await expect(app.dispose()).rejects.toThrow('stuck')
    // A failed wait is logged; every plugin is still disposed.
    expect(log).toEqual([
      'wait test/a',
      'wait test/b',
      'dispose test/broken-wait',
      'dispose test/b',
      'dispose test/a',
    ])
    expect(
      app.world
        .resource(LogResource)
        .errors(5)
        .map((e) => e.message),
    ).toContain('stuck')
  })

  it('runs frames, builds, readies, and disposals inside the scopes plugins add', async () => {
    const depth: number[] = []
    let inside = 0
    const app = new App().addPlugin(
      definePlugin({
        name: 'test/scoped',
        build(app) {
          app.addScope({ enter: () => void inside++, exit: () => void inside-- })
          app.addSystems(
            Update,
            defineSystem({ name: 'test/depth', run: () => void depth.push(inside) }),
          )
        },
        ready: () => void depth.push(inside),
        dispose: () => void depth.push(inside),
      }),
    )
    await app.init()
    app.update(1 / 60)
    expect(inside).toBe(0)
    await app.dispose()
    expect(depth).toEqual([1, 1, 1])
    expect(inside).toBe(0)
  })
})

describe('presentation (0062)', () => {
  /** An app on a clock the test moves, with a presenter the test resolves. */
  async function presented() {
    let now = 0
    const app = new App({ now: () => now })
    const waiting: ((at: undefined) => void)[] = []
    app.setPresenter(() => new Promise<undefined>((resolve) => waiting.push(resolve)))
    await app.init()
    return {
      app,
      at: (ms: number) => {
        now = ms
      },
      /** Presents every frame still waiting, then lets their callbacks run. */
      present: async () => {
        for (const resolve of waiting.splice(0)) resolve(undefined)
        await Promise.resolve()
      },
    }
  }

  it('records when init started and ended', async () => {
    let now = 5
    const app = new App({ now: () => now }).addPlugin(
      definePlugin({
        name: 'test/slow',
        build() {},
        ready: () => {
          now = 12
        },
      }),
    )
    await app.init()
    expect(app.startup).toMatchObject({ initStart: 5, initEnd: 12 })
    expect(app.startup.usable).toBeNaN()
  })

  it('resolves a trace when the frame that carries it is presented', async () => {
    const { app, at, present } = await presented()
    const seen: [string, number][] = []
    app.onTrace((label, ms) => void seen.push([label, ms]))
    at(10)
    const latency = app.trace('token-move')
    at(14)
    app.update(1 / 60)
    at(30)
    await present()
    expect(await latency).toBe(20)
    expect(seen).toEqual([['token-move', 20]])
  })

  it('leaves a trace stamped during a frame for the next one', async () => {
    const { app, at, present } = await presented()
    let traced: Promise<number> | undefined
    app.onFrame(() => {
      traced ??= app.trace('late')
    })
    at(0)
    app.update(1 / 60)
    at(8)
    await present()
    let done = false
    void traced!.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    app.update(1 / 60)
    at(20)
    await present()
    expect(await traced!).toBe(20)
  })

  it('marks the first frame presented after markUsable', async () => {
    const { app, at, present } = await presented()
    app.update(1 / 60)
    await present()
    expect(app.startup.usable).toBeNaN()
    at(100)
    app.markUsable()
    app.markUsable()
    at(116)
    app.update(1 / 60)
    at(125)
    await present()
    expect(app.startup).toMatchObject({ usableMarked: 100, usable: 125 })
    expect(await app.whenUsable()).toBe(125)
  })

  it('hands traces and the usable mark on while a frame is still loading', async () => {
    const { app, at, present } = await presented()
    const demand = app.world.resource(FrameDemand)
    at(0)
    app.markUsable()
    const latency = app.trace('spawn')
    demand.hold(LOADING_DEMAND) // this frame skipped a draw
    app.update(1 / 60)
    await present()
    expect(app.startup.usable).toBeNaN()
    demand.release(LOADING_DEMAND)
    at(40)
    app.update(1 / 60)
    at(48)
    await present()
    expect(await latency).toBe(48)
    expect(app.startup.usable).toBe(48)
  })

  it('waits for a presented frame without telling trace listeners', async () => {
    const { app, at, present } = await presented()
    const seen: string[] = []
    app.onTrace((label) => void seen.push(label))
    at(0)
    const waited = app.whenPresented()
    app.update(1 / 60)
    at(9)
    await present()
    expect(await waited).toBe(9)
    expect(seen).toEqual([])
  })

  it("takes the presenter's time for when the frame was on screen", async () => {
    let now = 0
    const app = new App({ now: () => now })
    app.setPresenter(async () => 12) // the animation frame began at 12, its callback ran later
    await app.init()
    const latency = app.trace('write')
    app.update(1 / 60)
    now = 20
    expect(await latency).toBe(12)
  })

  it('counts a frame as presented when it ends without a presenter', async () => {
    let now = 0
    const app = new App({ now: () => now })
    await app.init()
    const latency = app.trace('write')
    now = 3
    app.update(1 / 60)
    expect(await latency).toBe(3)
  })
})
