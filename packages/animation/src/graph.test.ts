import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assetServer, validateDataAssets } from '@shard/assets'
import { type AssetRef, defineComponent, type Entity, ShardError, t, type World } from '@shard/core'
import { createNodePlatform } from '@shard/platform-node'
import { App } from '@shard/runtime'
import { findEntityByPath, loadScene, ScenePlugin } from '@shard/scene'
import { Transform, TransformPlugin } from '@shard/transform'
import { afterAll, describe, expect, it } from 'vitest'
import {
  Animator,
  AnimatorParams,
  AnimatorStateEntered,
  type AnimatorStateEnteredData,
  describeAnimator,
  setAnimParam,
} from './animator'
import { AnimationClips } from './clip'
import { AnimationPlayer } from './components'
import {
  AnimationGraphs,
  compileCondition,
  createAnimationGraph,
  parseAnimationGraph,
  test as run,
  triangulate,
} from './graph'
import { animationPlugin } from './plugin'

const DT = 1 / 60
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** What a character controller would publish; bound by the test graphs. */
const Body = defineComponent('test-graph/Body', {
  grounded: t.bool({ default: true }),
  velocity: t.vec3(),
})

async function app(): Promise<App> {
  const a = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin)
  await a.init()
  return a
}

function frames(a: App, n: number): void {
  for (let i = 0; i < n; i++) a.update(DT)
}

function rig(world: World): Entity {
  const { entities } = loadScene(
    world,
    {
      version: 1,
      entities: [
        {
          name: 'rig',
          components: { 'core/Transform': {} },
          children: [
            { name: 'Hips', components: { 'core/Transform': { translation: [0, 1, 0] } } },
          ],
        },
      ],
    },
    { id: `rig${Math.random()}` },
  )
  return entities.get('rig')!
}

/** A clip holding the Hips at one translation for `duration` seconds. */
function at(world: World, name: string, translation: number[], duration = 1): AssetRef {
  return world.resource(AnimationClips).add(
    {
      name,
      duration,
      events: [],
      channels: [
        {
          target: 'Hips',
          component: 'core/Transform',
          field: 'translation',
          interpolation: 'linear',
          times: Float32Array.from([0, duration]),
          values: Float32Array.from([...translation, ...translation]),
          width: 3,
        },
      ],
    },
    name,
  )
}

function animate(world: World, entity: Entity, graphJson: unknown): AssetRef {
  const graph = world.resource(AnimationGraphs).add(createAnimationGraph(graphJson))
  world.add(entity, Animator, { graph: graph as never })
  return graph
}

const params = (world: World, e: Entity) =>
  world.get(e, AnimatorParams).values as Record<string, unknown>
const hips = (world: World) =>
  world.get(findEntityByPath(world, 'rig/Hips')!, Transform).translation
const layer0 = (world: World, e: Entity) => describeAnimator(world, e)!.layers[0]!

function collect(a: App) {
  const reader = a.world.reader(AnimatorStateEntered)
  const seen: AnimatorStateEnteredData[] = []
  return {
    step(n: number) {
      for (let i = 0; i < n; i++) {
        a.update(DT)
        seen.push(...(reader.read() as AnimatorStateEnteredData[]))
      }
    },
    states: () => seen.map((e) => `${e.from ?? '-'}→${e.state}`),
  }
}

describe('state machines', () => {
  it('moves locomotion → fall → land → locomotion as grounded flips, with each duration and an event per state', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    w.add(e, Body, {})
    const clips = {
      idle: at(w, 'idle', [0, 1, 0]),
      fall: at(w, 'fall', [0, 2, 0]),
      land: at(w, 'land', [0, 0.5, 0], 0.5),
    }
    animate(w, e, {
      parameters: {
        grounded: { type: 'bool', bind: { component: 'test-graph/Body', field: 'grounded' } },
      },
      layers: [
        {
          name: 'base',
          entry: 'locomotion',
          states: {
            locomotion: { clip: '#idle' },
            fall: { clip: '#fall' },
            land: { clip: '#land', loop: 'once' },
          },
          transitions: [
            { from: 'locomotion', to: 'fall', when: '!grounded', duration: 0.15 },
            { from: 'fall', to: 'land', when: 'grounded', duration: 0.05 },
            { from: 'land', to: 'locomotion', exitTime: 0.8, duration: 0.2 },
          ],
        },
      ],
      clips,
    })
    const events = collect(a)
    events.step(5)
    expect(layer0(w, e).state).toBe('locomotion')
    expect(hips(w)[1]).toBeCloseTo(1, 5)

    w.set(e, Body, { grounded: false })
    events.step(1)
    let l = layer0(w, e)
    expect(l.state).toBe('fall')
    expect(l.transition).toMatchObject({ from: 'locomotion', to: 'fall', duration: 0.15 })
    expect(l.transition!.progress).toBeCloseTo(DT / 0.15, 5)
    expect(hips(w)[1]).toBeCloseTo(1 + DT / 0.15, 4)
    events.step(8) // 9 frames = 0.15 s
    l = layer0(w, e)
    expect(l.transition).toBeNull()
    expect(l.active).toHaveLength(1)
    expect(hips(w)[1]).toBeCloseTo(2, 5)

    w.set(e, Body, { grounded: true })
    events.step(3) // 3 frames = 0.05 s
    l = layer0(w, e)
    expect(l.state).toBe('land')
    expect(l.transition).toBeNull()
    expect(hips(w)[1]).toBeCloseTo(0.5, 5)

    // land is 0.5 s, once: it leaves at 0.8 (0.4 s, 24 frames in), then fades 0.2 s back.
    events.step(20)
    expect(layer0(w, e).state).toBe('land')
    expect(layer0(w, e).normalizedTime).toBeCloseTo(23 / 30, 5)
    events.step(2)
    l = layer0(w, e)
    expect(l.state).toBe('locomotion')
    expect(l.transition!.progress).toBeCloseTo(DT / 0.2, 5)
    events.step(11)
    expect(layer0(w, e).transition).toBeNull()
    expect(hips(w)[1]).toBeCloseTo(1, 5)

    expect(events.states()).toEqual([
      '-→locomotion',
      'locomotion→fall',
      'fall→land',
      'land→locomotion',
    ])
    // Bound values show in describe, not in AnimatorParams (that holds what code sets).
    expect(describeAnimator(w, e)!.parameters).toEqual({ grounded: true })
    expect(describeAnimator(w, e)!.bindings?.grounded).toBe(
      `test-graph/Body.grounded of entity ${e}`,
    )
    expect(params(w, e)).toEqual({})
  })

  it('a trigger fires one transition and resets; an any-state transition wins by order', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const clips = {
      idle: at(w, 'idle', [0, 1, 0]),
      swing: at(w, 'swing', [1, 1, 0], 0.5),
      hit: at(w, 'hit', [2, 1, 0]),
    }
    animate(w, e, {
      parameters: { attack: { type: 'trigger' }, hurt: { type: 'bool' } },
      layers: [
        {
          states: {
            idle: { clip: '#idle' },
            swing: { clip: '#swing', loop: 'once' },
            hit: { clip: '#hit' },
          },
          transitions: [
            { from: '*', to: 'hit', when: 'hurt' },
            { from: 'idle', to: 'swing', when: 'attack' },
            { from: 'swing', to: 'idle', exitTime: 1 },
            { from: 'hit', to: 'idle', when: '!hurt' },
          ],
        },
      ],
      clips,
    })
    const events = collect(a)
    events.step(2)
    setAnimParam(w, e, 'attack', true)
    events.step(1)
    expect(layer0(w, e).state).toBe('swing')
    expect(params(w, e).attack).toBe(false)
    // Back to idle after the swing; the trigger doesn't fire again.
    events.step(40)
    expect(layer0(w, e).state).toBe('idle')
    expect(events.states()).toEqual(['-→idle', 'idle→swing', 'swing→idle'])

    // Both match from idle: the any-state transition comes first.
    setAnimParam(w, e, 'attack', true)
    setAnimParam(w, e, 'hurt', true)
    events.step(1)
    expect(layer0(w, e).state).toBe('hit')
    // The trigger wasn't taken, so it stays set until a transition reads it.
    expect(params(w, e).attack).toBe(true)
    events.step(5) // hurt stays true: the any-state transition doesn't re-enter hit
    expect(events.states().slice(3)).toEqual(['idle→hit'])
    // Patching the component works too.
    w.set(e, AnimatorParams, { values: { attack: true, hurt: false } })
    events.step(2)
    expect(events.states().slice(3)).toEqual(['idle→hit', 'hit→idle', 'idle→swing'])
  })

  it('an empty state lets the layers below show through, and a masked upper layer fades over them', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const clips = { idle: at(w, 'idle', [0, 1, 0]), swing: at(w, 'swing', [0, 3, 0]) }
    animate(w, e, {
      parameters: { attack: { type: 'trigger' } },
      layers: [
        { name: 'base', states: { idle: { clip: '#idle' } } },
        {
          name: 'upper',
          weight: 0.5,
          states: { none: {}, swing: { clip: '#swing' } },
          transitions: [{ from: 'none', to: 'swing', when: 'attack', duration: 0.1 }],
        },
      ],
      clips,
    })
    frames(a, 2)
    expect(hips(w)[1]).toBeCloseTo(1, 5)
    setAnimParam(w, e, 'attack', true)
    frames(a, 3) // halfway through the fade, at half layer weight: a quarter of the way
    expect(hips(w)[1]).toBeCloseTo(1 + 2 * 0.5 * 0.5, 4)
    frames(a, 10)
    expect(hips(w)[1]).toBeCloseTo(2, 5)
  })

  it('restarts on the new graph when it reloads', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const clips = { one: at(w, 'one', [0, 1, 0]), two: at(w, 'two', [0, 2, 0]) }
    const ref = animate(w, e, { layers: [{ states: { a: { clip: '#one' } } }], clips })
    frames(a, 2)
    const graph = w.resource(AnimationGraphs).get(ref)!
    const next = createAnimationGraph({ layers: [{ states: { b: { clip: '#two' } } }], clips })
    const revision = graph.revision + 1
    Object.assign(graph, next, { revision })
    frames(a, 1)
    expect(layer0(w, e).state).toBe('b')
    expect(hips(w)[1]).toBeCloseTo(2, 5)
  })
})

describe('blend spaces', () => {
  it('1D at speed 3.25 plays walk and run at 0.5 each, with synced normalized times', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    w.add(e, Body, { velocity: [3.25, -2, 0] })
    const clips = {
      idle: at(w, 'idle', [0, 1, 0], 2),
      walk: at(w, 'walk', [0, 1, 1], 1.2),
      run: at(w, 'run', [0, 1, 3], 0.7),
    }
    animate(w, e, {
      parameters: {
        speed: {
          type: 'float',
          bind: { component: 'test-graph/Body', field: 'velocity', op: 'horizontal' },
        },
      },
      layers: [
        {
          states: {
            locomotion: {
              blend1d: {
                parameter: 'speed',
                clips: [
                  [0, '#idle'],
                  [1.5, '#walk'],
                  [5, '#run'],
                ],
              },
            },
          },
        },
      ],
      clips,
    })
    frames(a, 37)
    const l = layer0(w, e)
    expect(describeAnimator(w, e)!.parameters.speed).toBeCloseTo(3.25, 5)
    expect(l.active[0]!.motions.map((m) => [m.name, m.weight])).toEqual([
      ['idle', 0],
      ['walk', 0.5],
      ['run', 0.5],
    ])
    expect(hips(w)[2]).toBeCloseTo(2, 5)
    // Both clips sit at the same fraction of their length; the blend's cycle is 0.95 s.
    const layers = w.get(e, AnimationPlayer).layers.filter((x) => x.weight > 0)
    expect(layers).toHaveLength(2)
    const [walk, run] = layers as [(typeof layers)[0], (typeof layers)[0]]
    expect(walk.time / 1.2).toBeCloseTo(run.time / 0.7, 5)
    expect(walk.time / 1.2).toBeCloseTo(((37 * DT) / 0.95) % 1, 4)
  })

  it('2D between samples weights the three nearest barycentrically', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    // Each clip puts the Hips at its sample point, so the blend puts them at the parameter.
    const sample = (name: string, x: number, y: number) => at(w, name, [x, 0, y])
    const clips = {
      idle: sample('idle', 0, 0),
      forward: sample('forward', 0, 1),
      back: sample('back', 0, -1),
      left: sample('left', -1, 0),
      right: sample('right', 1, 0),
    }
    animate(w, e, {
      parameters: { x: { type: 'float' }, y: { type: 'float' } },
      layers: [
        {
          states: {
            move: {
              blend2d: {
                x: 'x',
                y: 'y',
                clips: [
                  [0, 0, '#idle'],
                  [0, 1, '#forward'],
                  [0, -1, '#back'],
                  [-1, 0, '#left'],
                  [1, 0, '#right'],
                ],
              },
            },
          },
        },
      ],
      clips,
    })
    setAnimParam(w, e, 'x', 0.3)
    setAnimParam(w, e, 'y', 0.5)
    frames(a, 2)
    const weights = Object.fromEntries(
      layer0(w, e).active[0]!.motions.map((m) => [m.name, m.weight]),
    )
    expect(weights.idle).toBeCloseTo(0.2, 6)
    expect(weights.forward).toBeCloseTo(0.5, 6)
    expect(weights.right).toBeCloseTo(0.3, 6)
    expect(weights.left).toBe(0)
    expect(weights.back).toBe(0)
    expect(hips(w)[0]).toBeCloseTo(0.3, 5)
    expect(hips(w)[2]).toBeCloseTo(0.5, 5)
    // Outside the hull: the nearest point on its edge.
    setAnimParam(w, e, 'x', 2)
    setAnimParam(w, e, 'y', 2)
    frames(a, 1)
    expect(hips(w)[0]).toBeCloseTo(0.5, 5)
    expect(hips(w)[2]).toBeCloseTo(0.5, 5)
  })

  it('triangulates a diamond with a center into four triangles', () => {
    const tris = triangulate([0, 0, 0, -1, 1], [0, 1, -1, 0, 0])
    expect(tris.length / 3).toBe(4)
    for (let k = 0; k < tris.length; k += 3) expect(tris.slice(k, k + 3)).toContain(0)
    expect(triangulate([0, 1, 2], [0, 1, 2])).toEqual([])
  })
})

describe('conditions', () => {
  const params = [
    { name: 'speed', type: 'float' as const },
    { name: 'grounded', type: 'bool' as const },
    { name: 'attack', type: 'trigger' as const },
  ]
  const evaluate = (src: string, values: number[]) =>
    run(Float64Array.from(compileCondition(src, params).code), Float64Array.from(values))

  it('evaluates !, &&, ||, comparisons, and parentheses', () => {
    expect(evaluate('!grounded', [0, 0, 0])).toBe(true)
    expect(evaluate('grounded && speed > 0.1', [0.2, 1, 0])).toBe(true)
    expect(evaluate('grounded && speed > 0.1', [0.05, 1, 0])).toBe(false)
    expect(evaluate('!grounded || speed >= 5', [5, 1, 0])).toBe(true)
    expect(evaluate('!(speed < -1) && attack', [-2, 0, 1])).toBe(false)
    expect(evaluate('speed == 2 && grounded != false', [2, 1, 0])).toBe(true)
    expect(compileCondition('attack && !attack', params).triggers).toEqual([2])
  })

  it('points at the column of a typo, in the file and through the importer', async () => {
    const graph = {
      parameters: { grounded: { type: 'bool' } },
      layers: [
        {
          states: { idle: {}, fall: {}, orphan: {} },
          transitions: [
            { from: 'idle', to: 'fall', when: '!grnded' },
            { from: 'fall', to: 'idle', when: 'grounded &&& true' },
            { from: 'fall', to: 'nowhere', when: 'grounded' },
          ],
        },
      ],
    }
    const { errors, warnings } = parseAnimationGraph(graph)
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['animgraph/unknown-parameter', '/layers/0/transitions/0/when'],
      ['animgraph/bad-condition', '/layers/0/transitions/1/when'],
      ['animgraph/unknown-state', '/layers/0/transitions/2/to'],
    ])
    expect(errors[0]!.message).toBe('Condition "!grnded", column 2: no parameter "grnded"')
    expect(errors[0]!.hint).toBe('Did you mean "grounded"?')
    expect(errors[1]!.message).toMatch(/column 12: unexpected "&" \(and is "&&"\)/)
    expect(errors[2]!.hint).toBe('States: idle, fall, orphan.')
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ['animgraph/unreachable-state', '/layers/0/states/orphan'],
    ])
    expect(() => createAnimationGraph(graph)).toThrow(ShardError)

    // Through the asset server: the import fails with the pointer; a good graph imports with
    // its warning, and validate finds the clip path that isn't there.
    const root = mkdtempSync(join(tmpdir(), 'shard-animgraph-'))
    roots.push(root)
    const write = (path: string, json: unknown) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify(json))
    }
    write('data/bad.animgraph.json', graph)
    write('data/good.animgraph.json', {
      layers: [
        { states: { idle: { clip: { path: 'assets/missing.glb#Animation/Idle' } }, lost: {} } },
      ],
    })
    const a = await app()
    const server = assetServer(a.world).configure({ platform: createNodePlatform({ root }) })
    const scan = await server.scan()
    expect(scan.failed.map((f) => [f.path, f.error.code, f.error.path])).toEqual([
      ['data/bad.animgraph.json', 'animgraph/unknown-parameter', '/layers/0/transitions/0/when'],
    ])
    expect(scan.failed[0]!.error.message).toMatch(/column 2/)
    const good = server.info('data/good.animgraph.json')!
    expect(good.warnings).toEqual([
      {
        message:
          '[animgraph/unreachable-state] State "lost" in layer "layer0" can\'t be reached from "idle"',
        path: '/layers/0/states/lost',
      },
    ])
    const checked = await validateDataAssets(a.world)
    expect(checked.map((c) => [c.source, c.errors.map((e) => [e.code, e.path])])).toEqual([
      ['data/good.animgraph.json', [['animgraph/unknown-clip', '/layers/0/states/idle']]],
    ])
  })
})
