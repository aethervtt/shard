import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { assetServer } from '@aethervtt/shard-assets'
import { type AssetRef, type Entity, t } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import type { TrackWorkerLike } from '@aethervtt/shard-physics/worker'
import {
  Culler,
  defineMaterial,
  forwardPlugin,
  MaterialAsset,
  Materials,
  MeshMaterial,
  OffscreenTarget,
  PointLight,
  RenderStats,
  renderPlugin,
  ScreenEffects,
  Shaders,
  Visibility,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App, FrameDemand, LogResource } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DiceDie } from './components'
import { dieGeometry, requireDie } from './definition'
import { DiceEffectRecipe, diceEffectRecipe } from './effects'
import { defineDiceEntrance } from './entrances'
import { markAngle, naturalValue } from './landing'
import { dicePlugin } from './plugin'
import type { DiceRoll, DiceRollDie } from './roll'
import { DICE_SKINS, DiceSkin, diceSkin } from './skin'
import { DiceTable, ENTRANCE_DEMAND } from './table'
import { spawnDiceWindow } from './windows'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

// A glow of its own (its own shader, so a cold first frame would skip drawing it).
const Glow = defineMaterial('test/EntranceGlow', {
  extends: 'none',
  blend: 'additive',
  fields: { glow: t.f32({ default: 3000 }) },
  shader: 'test::entrance_glow',
})
const GLOW_SHADER = `
import shard::pbr::types::VertexOutput;
import ${Glow.modulePath}::${Glow.varName};
override fn shade(in: VertexOutput) -> vec4f {
  let d = length(in.uv * 2.0 - 1.0);
  return vec4f(vec3f(1.0, 0.6, 0.2) * ${Glow.varName}.glow * (1.0 - smoothstep(0.0, 1.0, d)), 1.0);
}`

const spawns: { name: string; params: Record<string, unknown> }[] = []

/** Down from above over half a second, a glow over its spot, a fire on the table while it plays. */
defineDiceEntrance('test-meteor', {
  vertices: 16,
  durationMs: 900,
  landAtMs: 500,
  spawn(ctx) {
    spawns.push({ name: 'test-meteor', params: ctx.params })
    const material = ctx.world
      .resource(Materials)
      .add(new MaterialAsset({}, Glow)) as AssetRef<'Material'>
    const window = { x: 0, y: 0, width: 3, height: 3, turn: 0, lift: 1.05 }
    return [spawnDiceWindow(ctx, material, { ...window, at: ctx.rest.position })]
  },
  update(ctx, s) {
    const k = Math.min(1, s / ctx.landAt)
    ctx.show(true)
    const [x, y, z] = ctx.rest.position
    ctx.pose([x, y + (1 - k) * 3, z], ctx.rest.rotation)
    ctx.effect({ kind: 'fire', radius: 120, ttlMs: 200, params: { heat: 2 } })
    return true
  },
})
defineDiceEntrance('test-broken', {
  vertices: 4,
  durationMs: 600,
  landAtMs: 300,
  assets: [{ type: 'Mesh', guid: undefined, path: 'missing/nothing.glb' }],
  spawn: () => [],
})
defineDiceEntrance('test-slow', {
  vertices: 4,
  durationMs: 600,
  landAtMs: 300,
  assets: [{ type: 'Mesh', guid: undefined, path: 'slow/forever.glb' }],
  spawn: () => [],
})

interface Rig {
  app: App
  table: import('./table').DiceTableState
  clock: { now: number }
  frame(ms?: number): void
}

async function rig(
  options: { worker?: () => TrackWorkerLike; entranceWaitMs?: number } = {},
): Promise<Rig> {
  const target = new OffscreenTarget(gpu, { label: 'window', width: 320, height: 180 })
  const clock = { now: 0 }
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target, owner: 'dice' }),
    forwardPlugin({ msaa: 1 }),
    // Test frames come faster than real time; real compiles get room (the fallback test sets it).
    dicePlugin({
      now: () => clock.now,
      restMs: 60_000,
      worker: options.worker,
      entranceWaitMs: options.entranceWaitMs ?? 60_000,
    }),
  )
  await app.init()
  const w = app.world
  w.resource(Shaders).register('test::entrance_glow', GLOW_SHADER, 'test')
  const recipes = w.resource(DiceEffectRecipe.store)
  const recipe = (id: string, entrance: string) =>
    recipes.set(
      `test:${id}`,
      diceEffectRecipe({
        id,
        conditions: [{ kind: 'die', die: 'd20', value: 20, state: 'kept' }],
        effects: [
          { kind: 'entrance', entrance, params: { heat: 2 } },
          { kind: 'light-pulse', color: [1, 0.6, 0.3, 1], intensity: 4, durationMs: 600 },
        ],
      }),
    )
  recipe('meteor20', 'test-meteor')
  recipe('broken20', 'test-broken')
  recipe('slow20', 'test-slow')
  const skins = w.resource(DiceSkin.store)
  for (const id of ['meteor', 'broken', 'slow'])
    skins.set(`test:${id}`, diceSkin({ id, effects: [{ guid: `test:${id}20` }] }))
  await settle(app, 4)
  const frame = (ms = 1000 / 60) => {
    clock.now += ms
    app.update(ms / 1000)
  }
  return { app, table: w.resource(DiceTable), clock, frame }
}

const skin = (id: string) => ({ type: 'dice/DiceSkin', guid: `test:${id}`, path: undefined })
const d20 = (value: number, id = 'meteor'): DiceRollDie => ({ kind: 'd20', value, skin: skin(id) })
const d6: DiceRollDie = { kind: 'd6', value: 4, skin: DICE_SKINS.ivory }
const roll = (id: string, dice: DiceRollDie[], over: Partial<DiceRoll> = {}): DiceRoll => ({
  id,
  dice,
  soundGain: 0,
  ...over,
})

async function until(r: Rig, done: () => boolean, max = 1500): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (done()) return
    r.frame()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const { entrances } = describeOf(r)
  throw new Error(
    `still ${r.table.phase} after ${max} frames; entrances: ${JSON.stringify(entrances)}`,
  )
}

interface Described {
  phase: string
  track: { hash: string; bodies: number } | null
  entrances: {
    name: string
    die: number
    state: string
    ready: boolean
    rest: { position: number[]; rotation: number[] }
    fallback: string | null
  }[]
  entranceSkips: { die: number; name: string; reason: string }[]
  screenEffects: { kind: string; params: Record<string, unknown> }[]
}
const describeOf = (r: Rig) => r.table.describe() as unknown as Described

function dieEntity(r: Rig, index: number): Entity {
  for (const e of r.app.world.query({ with: [DiceDie] }).entities())
    if (r.app.world.get(e, DiceDie).index === index) return e
  throw new Error(`no die ${index}`)
}

const lights = (r: Rig) => [...r.app.world.query({ with: [PointLight] }).entities()].length

describe('dice entrances (0065)', () => {
  it('brings a d20 at 20 in through its scene after the d6 tumbles, lands it upright and apart, then plays its recipe', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig()
    const w = r.app.world
    spawns.length = 0
    const outcome = r.table.play(roll('meteor-a', [d20(20), d6]))
    await until(r, () => r.table.phase === 'tumble')
    const d = describeOf(r)
    // Only the d6 is in the physics; the d20 waits hidden at its rest spot.
    expect(d.track!.bodies).toBe(1)
    expect(d.entrances).toMatchObject([{ name: 'test-meteor', die: 0, state: 'waiting' }])
    const e20 = dieEntity(r, 0)
    expect(w.get(e20, Visibility).mode).toBe('hidden')
    // The warm-up spawned the scene once already, with the recipe's params.
    expect(spawns).toEqual([{ name: 'test-meteor', params: { heat: 2 } }])
    const before = lights(r)
    // The d6 has landed; the meteor starts once its warm-up is done (it may outlast the tumble).
    await until(r, () => describeOf(r).entrances[0]!.state === 'playing')
    expect(r.table.phase).toBe('entrance')
    expect(spawns).toHaveLength(2)
    // While it plays: its fire is published for the table; the recipe's light waits for the landing.
    await until(r, () => describeOf(r).screenEffects.length > 0)
    expect(describeOf(r).screenEffects[0]).toMatchObject({ kind: 'fire', params: { heat: 2 } })
    expect(lights(r)).toBe(before)
    const started = r.clock.now
    await until(r, () => describeOf(r).entrances[0]!.state === 'landed')
    expect(r.clock.now - started).toBeGreaterThanOrEqual(480)
    expect(r.clock.now - started).toBeLessThanOrEqual(560)
    expect(lights(r)).toBe(before + 1)
    // Landed at its rest pose: 20 on top, reading up, visible, clear of the d6.
    const g = dieGeometry(requireDie('d20'))
    const tr = w.get(e20, Transform)
    expect(naturalValue(g, tr.rotation)).toBe(20)
    expect(markAngle(g, tr.rotation, 20)).toBeLessThan(1e-4)
    for (const [k, v] of describeOf(r).entrances[0]!.rest.position.entries())
      expect(tr.translation[k]).toBeCloseTo(v, 5)
    expect(w.get(e20, Visibility).mode).toBe('visible')
    const six = w.get(dieEntity(r, 1), Transform).translation
    const apart = Math.hypot(six[0]! - tr.translation[0]!, six[2]! - tr.translation[2]!)
    expect(apart).toBeGreaterThan(g.footprint * w.get(e20, Transform).scale[0]!)
    await until(r, () => r.table.phase === 'rest' && describeOf(r).entrances[0]!.state === 'done')
    expect(w.resource(FrameDemand).isHeld(ENTRANCE_DEMAND)).toBe(false)
    r.table.dismiss()
    await outcome
    expect(w.resource(ScreenEffects).effects).toEqual([])
    await r.app.dispose()
  })

  it('records the same track and rest spot inline and in the worker', {
    timeout: timeout(90_000),
  }, async () => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const nodeWorker = (): TrackWorkerLike => {
      const worker = new Worker(new URL('./test-worker.ts', import.meta.url), {
        execArgv: ['--import', tsx],
      })
      const listeners: Record<string, ((event: never) => void)[]> = {
        message: [],
        error: [],
        messageerror: [],
      }
      worker.on('message', (data) => {
        for (const l of listeners.message!) l({ data } as never)
      })
      return {
        postMessage: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
        addEventListener: (type: string, listener: (event: never) => void) =>
          void listeners[type]!.push(listener),
        terminate: () => void worker.terminate(),
      }
    }
    const seen: { hash: string; rest: number[] }[] = []
    for (const worker of [undefined, nodeWorker]) {
      const r = await rig({ worker })
      const outcome = r.table.play(roll('same', [d20(20), d6, { ...d6, value: 2 }]))
      await until(r, () => r.table.phase === 'tumble')
      const d = describeOf(r)
      seen.push({ hash: d.track!.hash, rest: d.entrances[0]!.rest.position })
      r.table.dismiss()
      await outcome
      await r.app.dispose()
    }
    expect(seen[1]).toEqual(seen[0])
  })

  it('plays no entrance in reduced motion, with effects off or in lower tiers, and at most 2 a roll', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig()
    const cases: [Partial<DiceRoll>, string][] = [
      [{ motion: 'reduced' }, 'reduced motion'],
      [{ effects: false }, 'effects off'],
      [{ quality: 'balanced' }, 'the balanced tier'],
      [{ quality: 'large-pool' }, 'the large-pool tier'],
    ]
    for (const [over, reason] of cases) {
      const outcome = r.table.play(roll(`barred-${reason}`, [d20(20), d6], over), { replace: true })
      await until(r, () => r.table.phase === 'rest' || r.table.phase === 'tumble')
      const d = describeOf(r)
      expect(d.entrances).toEqual([])
      expect(d.entranceSkips).toEqual([{ die: 0, name: 'test-meteor', reason }])
      r.table.dismiss()
      await outcome
    }
    // Three d20s at 20: two enter, the third tumbles.
    const outcome = r.table.play(roll('three', [d20(20), d20(20), d20(20)]))
    await until(r, () => r.table.phase === 'tumble')
    const d = describeOf(r)
    expect(d.entrances.map((e) => e.die)).toEqual([0, 1])
    expect(d.entranceSkips).toEqual([{ die: 2, name: 'test-meteor', reason: 'over 2' }])
    expect(d.track!.bodies).toBe(1)
    // They land one after another, apart.
    await until(r, () => r.table.phase === 'rest')
    const [a, b] = describeOf(r).entrances.map((e) => e.rest.position)
    expect(Math.hypot(a![0]! - b![0]!, a![2]! - b![2]!)).toBeGreaterThan(0.1)
    r.table.dismiss()
    await outcome
    await r.app.dispose()
  })

  it("keeps an entrance die's result clock its own", { timeout: timeout(90_000) }, async () => {
    const r = await rig()
    const w = r.app.world
    const outcome = r.table.play(roll('clocks', [d20(20), d20(7)]))
    const material = (i: number) =>
      w.resource(Materials).get(w.get(dieEntity(r, i), MeshMaterial).material!)!
    await until(r, () => r.table.phase === 'entrance')
    const tumbled = material(1).value.resultTime as number
    expect(tumbled).toBeGreaterThan(0)
    expect(material(0)).not.toBe(material(1))
    expect(material(0).value.result).toBe(0)
    await until(r, () => describeOf(r).entrances[0]!.state === 'landed')
    expect(material(0).value.resultTime as number).toBeGreaterThan(tumbled + 0.3)
    expect(material(1).value.resultTime).toBe(tumbled)
    r.table.dismiss()
    await outcome
    await r.app.dispose()
  })

  it('skips to the landing at once, and leaves nothing behind when dismissed mid-entrance', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig()
    const w = r.app.world
    let outcome = r.table.play(roll('skip', [d20(20)]))
    await until(r, () => describeOf(r).entrances[0]?.state === 'playing')
    expect(r.table.skip()).toBe(true)
    r.frame()
    const e = dieEntity(r, 0)
    expect(describeOf(r).entrances[0]!.state).not.toBe('playing')
    expect(naturalValue(dieGeometry(requireDie('d20')), w.get(e, Transform).rotation)).toBe(20)
    expect(r.table.skip()).toBe(false)
    r.table.dismiss()
    await outcome
    // Dismissed while the scene plays.
    outcome = r.table.play(roll('dismiss', [d20(20)]))
    await until(r, () => describeOf(r).screenEffects.length > 0)
    r.table.dismiss()
    await outcome
    expect(w.resource(ScreenEffects).effects).toEqual([])
    expect(
      [...w.query({ with: [MeshMaterial] }).entities()].filter((x) => {
        const m = w.resource(Materials).get(w.get(x, MeshMaterial).material!)
        return m?.type === Glow
      }),
    ).toEqual([])
    expect(w.resource(FrameDemand).isHeld(ENTRANCE_DEMAND)).toBe(false)
    await r.app.dispose()
  })

  it('drops the die into its spot when the assets fail or come late, and says so once', {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig({ entranceWaitMs: 1500 })
    const w = r.app.world
    const server = assetServer(w)
    const load = server.load.bind(server)
    server.load = ((ref: AssetRef) =>
      ref.path === 'slow/forever.glb' ? new Promise(() => {}) : load(ref)) as typeof server.load
    for (const [id, fallback] of [
      ['broken', 'assets failed'],
      ['slow', 'assets late'],
    ] as const) {
      const outcome = r.table.play(roll(`fallback-${id}`, [d20(20, id), d6]), { replace: true })
      await until(r, () => r.table.phase === 'rest')
      const d = describeOf(r)
      expect(d.entrances[0]).toMatchObject({
        fallback,
        state: expect.stringMatching(/landed|done/),
      })
      const e = dieEntity(r, 0)
      expect(w.get(e, Visibility).mode).toBe('visible')
      const at = w.get(e, Transform).translation
      for (const [k, v] of d.entrances[0]!.rest.position.entries()) expect(at[k]).toBeCloseTo(v, 5)
      r.table.dismiss()
      await outcome
    }
    const warnings = w
      .resource(LogResource)
      .tail(200, 'warn')
      .filter((x) => x.code === 'dice/entrance-unavailable')
    expect(warnings.map((x) => x.message.match(/"(\w+-\w+)"/)?.[1])).toEqual([
      'test-broken',
      'test-slow',
    ])
    await r.app.dispose()
  })

  it("compiles nothing in an entrance's first frames (its scene was drawn beforehand, offscreen)", {
    timeout: timeout(90_000),
  }, async () => {
    const r = await rig()
    // Culled on the CPU, so each frame's draw count is that frame's: GPU culling reads counts back
    // a frame or two late. Compiles and uploads don't depend on which culls.
    r.app.world.resource(Culler).enabled = false
    const view = `camera:${r.table.camera}`
    const outcome = r.table.play(roll('warm', [d20(20), d6]))
    // Frames yield while the track records and the d6 tumbles, so the warm-up's compiles finish.
    await until(
      r,
      () => r.table.phase !== 'simulating' && describeOf(r).entrances[0]?.ready === true,
    )
    expect(describeOf(r).entrances[0]!.state).toBe('waiting')
    // From here frames never yield: a pipeline first asked for now couldn't compile before its draw.
    for (let i = 0; describeOf(r).entrances[0]!.state === 'waiting'; i++) {
      if (i > 1000) throw new Error('the entrance never started')
      r.frame()
    }
    const w = r.app.world
    // From the frame it starts: every mesh on the table (the tray, the dice, the glow) in the list,
    // and no draw skipped for an upload, a shader still linking or a pipeline compiling.
    for (let i = 0; i < 4; i++) {
      if (i > 0) r.frame()
      const stats = w.resource(RenderStats).get(view)!
      expect(stats.drawCalls, `frame ${i}`).toBe(
        [...w.query({ with: [MeshMaterial] }).entities()].length,
      )
      expect(stats.pending, `frame ${i}`).toBe(0)
      expect(gpu.pipelines.skipped, `frame ${i}`).toBe(0)
      expect(gpu.pipelines.pending, `frame ${i}`).toBe(0)
    }
    r.table.dismiss()
    await outcome
    await r.app.dispose()
  })

  it('holds definitions to the budgets', () => {
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (err) {
        return (err as { code: string }).code
      }
      return 'ok'
    }
    const scene = { spawn: () => [] as Entity[] }
    expect(
      code(() =>
        defineDiceEntrance('big', { vertices: 70_000, durationMs: 1000, landAtMs: 500, ...scene }),
      ),
    ).toBe('dice/entrance-budget')
    expect(
      code(() =>
        defineDiceEntrance('long', { vertices: 4, durationMs: 9000, landAtMs: 500, ...scene }),
      ),
    ).toBe('dice/entrance-budget')
    expect(
      code(() =>
        defineDiceEntrance('late', { vertices: 4, durationMs: 1000, landAtMs: 1500, ...scene }),
      ),
    ).toBe('dice/invalid-entrance')
    expect(
      code(() =>
        defineDiceEntrance('off', {
          vertices: 4,
          durationMs: 1000,
          landAtMs: 500,
          spot: [2, 0],
          ...scene,
        }),
      ),
    ).toBe('dice/invalid-entrance')
  })
})
