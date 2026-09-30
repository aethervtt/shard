import { Last, quat } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane } from '@aethervtt/shard-mesh'
import { App, animationFrameRunner, FrameDemand, LogResource } from '@aethervtt/shard-runtime'
import { fakeAnimationFrames } from '@aethervtt/shard-runtime/testing'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { forwardCorePlugin } from './forward'
import type { CapturedImage } from './graph'
import { Mesh3d, MeshMaterial } from './instances'
import {
  clearLensFields,
  expireLensFields,
  forwardLensFields,
  LENS_DEMAND,
  Lens,
  type LensField,
  LensFields,
  MAX_LENS_FIELDS,
  publishLensField,
} from './lens'
import { LensViews, MAX_LENS_PIXELS } from './lens-plugin'
import { AmbientLight } from './lights'
import { captureView, describeRender, renderOwner, renderPlugin, Shaders } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { settle } from './testing'

const field = (source: number, over: Partial<LensField> = {}): LensField => ({
  screen: [32, 24],
  radius: 12,
  strength: -0.75,
  ttlMs: 1000,
  source: source as LensField['source'],
  ...over,
})

describe('LensFields (headless)', () => {
  async function fieldsApp() {
    const app = new App()
    app.world.initResource(LensFields)
    app.addSystems(Last, expireLensFields)
    await app.init()
    return app
  }

  it('refreshes a source in place, holds at most 4, and clears by source', async () => {
    const app = await fieldsApp()
    const w = app.world
    for (let s = 1; s <= MAX_LENS_FIELDS; s++) expect(publishLensField(w, field(s))).toBe(true)
    expect(publishLensField(w, field(99))).toBe(false)
    expect(publishLensField(w, field(2, { radius: 40 }))).toBe(true)
    const fields = w.resource(LensFields).fields
    expect(fields.map((f) => f.source)).toEqual([1, 2, 3, 4])
    expect(fields[1]!.radius).toBe(40)
    clearLensFields(w, 2 as LensField['source'])
    expect(w.resource(LensFields).fields.map((f) => f.source)).toEqual([1, 3, 4])
    clearLensFields(w)
    expect(w.resource(LensFields).fields).toEqual([])
    await app.dispose()
  })

  it('expires a field ttlMs after its last refresh, holding frames until then', async () => {
    const app = await fieldsApp()
    const w = app.world
    publishLensField(w, field(1, { ttlMs: 90 }))
    const demand = w.resource(FrameDemand)
    for (let i = 0; i < 5; i++) app.update(1 / 60)
    expect(w.resource(LensFields).fields).toHaveLength(1)
    expect(demand.isHeld(LENS_DEMAND)).toBe(true)
    // A refresh starts it over.
    publishLensField(w, field(1, { ttlMs: 90 }))
    for (let i = 0; i < 5; i++) app.update(1 / 60)
    expect(w.resource(LensFields).fields).toHaveLength(1)
    app.update(1 / 60) // 100 ms since the refresh
    expect(w.resource(LensFields).fields).toHaveLength(0)
    expect(demand.isHeld(LENS_DEMAND)).toBe(false)
    await app.dispose()
  })

  it('bounds what a host patches in, and forwards copies between apps', async () => {
    const a = await fieldsApp()
    const b = await fieldsApp()
    a.world.patchResource(LensFields, {
      fields: [1, 2, 3, 4, 5, 6].map((s) => field(s)),
    })
    a.update(1 / 60)
    expect(a.world.resource(LensFields).fields).toHaveLength(MAX_LENS_FIELDS)
    forwardLensFields(a.world, b.world)
    const forwarded = b.world.resource(LensFields).fields
    expect(forwarded.map((f) => f.source)).toEqual([1, 2, 3, 4])
    expect(forwarded[0]).not.toBe(a.world.resource(LensFields).fields[0])
    // Each app counts down its own copy.
    b.update(1 / 60)
    expect(a.world.resource(LensFields).fields[0]!.ttlMs).toBeCloseTo(1000 - 1000 / 60, 6)
    // Into a target that sits 40 CSS pixels down and 10 across in the publisher's.
    forwardLensFields(a.world, b.world, [10, 40])
    expect(b.world.resource(LensFields).fields[0]!.screen).toEqual([22, -16])
    expect(a.world.resource(LensFields).fields[0]!.screen).toEqual([32, 24])
    clearLensFields(a.world)
    forwardLensFields(a.world, b.world)
    expect(b.world.resource(LensFields).fields).toEqual([])
    await a.dispose()
    await b.dispose()
  })
})

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

/**
 * A table (a checkerboard of colored tiles, so any displacement shows) seen by a Lens camera, and a
 * die far off to the side seen by its own camera, as the dice surface would.
 */
async function tableApp(shared: GpuContext, size: [number, number] = [64, 48]) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: shared, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const w = app.world
  const targets = w.resource(RenderTargets)
  const tableTarget = targets.add(
    new OffscreenTarget(shared, { label: 'table', width: size[0], height: size[1] }),
    'table',
  )
  const diceTarget = targets.add(
    new OffscreenTarget(shared, { label: 'dice', width: 32, height: 32 }),
    'dice',
  )
  w.resource(AmbientLight).brightness = 4000
  const meshes = w.resource(Meshes)
  const materials = w.resource(Materials)
  const tile = meshes.add(plane({ size: 1 }))
  for (let x = -5; x < 5; x++) {
    for (let y = -4; y < 4; y++) {
      const baseColor: [number, number, number, number] = [
        (x + 5) / 10,
        (y + 4) / 8,
        (x + y) & 1 ? 0.9 : 0.1,
        1,
      ]
      w.spawn(
        [Mesh3d, { mesh: tile }],
        [MeshMaterial, { material: materials.add(new MaterialAsset({ baseColor })) }],
        [Transform, { translation: [x + 0.5, y + 0.5, 0], rotation: q(90, 0, 0) }],
      )
    }
  }
  const die = w.spawn(
    [Mesh3d, { mesh: meshes.add(cube({ size: 1 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.9, 0.2, 0.1, 1] })) },
    ],
    [Transform, { translation: [100, 0, 0], rotation: q(30, 40, 0) }],
  )
  const table = w.spawn(
    [Camera3d, { target: tableTarget, fovY: 60 }],
    [Transform, { translation: [0, 0, 5] }],
    Lens,
  )
  const dice = w.spawn(
    [Camera3d, { target: diceTarget, fovY: 40, order: 1, clearColor: [0, 0, 0, 0] }],
    [Transform, { translation: [100, 0, 3] }],
  )
  return { app, die, table: `camera:${table}`, dice: `camera:${dice}` }
}

async function shoot(app: App, views: string[]): Promise<CapturedImage[]> {
  const shots = views.map((v) => captureView(app.world, v))
  app.update(1 / 60)
  return Promise.all(shots)
}

/** Pixels whose center lies at `radius` or more from `center`, and whether they're identical. */
function compare(a: CapturedImage, b: CapturedImage, center: [number, number], radius: number) {
  let outsideDiffer = 0
  let insideDiffer = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4
      const same =
        a.data[o] === b.data[o] &&
        a.data[o + 1] === b.data[o + 1] &&
        a.data[o + 2] === b.data[o + 2] &&
        a.data[o + 3] === b.data[o + 3]
      const d = Math.sqrt((x + 0.5 - center[0]) ** 2 + (y + 0.5 - center[1]) ** 2)
      if (same) continue
      if (d >= radius) outsideDiffer++
      else insideDiffer++
    }
  }
  return { outsideDiffer, insideDiffer }
}

const graphOrder = (app: App, view: string) =>
  (describeRender(app.world).perView as Record<string, { order: string[] }>)[view]!.order

describe('lensPlugin (0063)', () => {
  it(
    'bends only inside the field, leaves the source die alone, and leaves the graph at expiry',
    async () => {
      const { app, die, table, dice } = await tableApp(gpu)
      await settle(app)
      const owner = renderOwner(app.world)
      const baseline = gpu.stats(owner).textures
      const [before, diceBefore] = await shoot(app, [table, dice])
      const [again] = await shoot(app, [table])
      expect(compare(before!, again!, [32, 24], 0).outsideDiffer).toBe(0) // frames are repeatable
      expect(graphOrder(app, table)).not.toContain('post/lens')

      publishLensField(app.world, field(die, { ttlMs: 400 }))
      await settle(app, 10) // the lens pipeline compiles
      const [bent, diceBent] = await shoot(app, [table, dice])
      const diff = compare(before!, bent!, [32, 24], 12)
      expect(diff.outsideDiffer).toBe(0)
      expect(diff.insideDiffer).toBeGreaterThan(50)
      expect(compare(diceBefore!, diceBent!, [0, 0], 0).outsideDiffer).toBe(0)
      expect(graphOrder(app, table)).toContain('post/lens')
      expect(graphOrder(app, dice)).not.toContain('post/lens')
      expect(gpu.stats(owner).textures).toBe(baseline + 1)
      const lens = (describeRender(app.world).lens as { views: Record<string, unknown> }).views
      expect(lens[table]).toMatchObject({
        ran: true,
        region: [20, 12, 24, 24],
        target: [24, 24],
        clipped: false,
        fields: [{ source: die, screen: [32, 24], radius: 12, strength: -0.75 }],
      })
      expect(lens[dice]).toBeUndefined()

      // 400 ms after the last refresh it's gone, and so are the pass and its target.
      for (let i = 0; i < 24; i++) app.update(1 / 60)
      expect(app.world.resource(LensFields).fields).toHaveLength(0)
      expect(graphOrder(app, table)).not.toContain('post/lens')
      expect(gpu.stats(owner).textures).toBe(baseline)
      const [after] = await shoot(app, [table])
      expect(compare(before!, after!, [32, 24], 0).outsideDiffer).toBe(0)
      expect(gpu.errors).toEqual([])
      await app.dispose()
    },
    timeout(60_000),
  )

  it(
    'keeps its target within 2,097,152 pixels, and releases it when the field is cleared',
    async () => {
      const { app, die, table } = await tableApp(gpu, [2048, 1100])
      await settle(app)
      const owner = renderOwner(app.world)
      const baseline = gpu.stats(owner).textures
      publishLensField(app.world, field(die, { screen: [1024, 550], radius: 3000 }))
      await settle(app, 10)
      const state = [...app.world.resource(LensViews).values()][0]!
      const texture = state.texture!
      expect(texture.width * texture.height).toBeLessThanOrEqual(MAX_LENS_PIXELS)
      expect(state.clipped).toBe(true)
      expect(state.ran).toBe(true)
      expect(gpu.stats(owner).textures).toBe(baseline + 1)
      // Fields moving around inside the bound never grow it past it.
      publishLensField(app.world, field(die, { screen: [100, 100], radius: 400 }))
      app.update(1 / 60)
      expect(state.texture!.width * state.texture!.height).toBeLessThanOrEqual(MAX_LENS_PIXELS)
      clearLensFields(app.world, die)
      app.update(1 / 60)
      expect(state.texture).toBeUndefined()
      expect(gpu.stats(owner).textures).toBe(baseline)
      expect(graphOrder(app, table)).not.toContain('post/lens')
      expect(gpu.errors).toEqual([])
      await app.dispose()
    },
    timeout(120_000),
  )

  it('logs render/feature-missing for a Lens camera without lensPlugin', async () => {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardCorePlugin({ msaa: 1 }),
    )
    await app.init()
    const target = app.world
      .resource(RenderTargets)
      .add(new OffscreenTarget(gpu, { label: 'bare', width: 8, height: 8 }), 'bare')
    app.world.spawn([Camera3d, { target }], Transform, Lens)
    app.update(1 / 60)
    const log = app.world.resource(LogResource).tail(10)
    expect(log.find((e) => e.code === 'render/feature-missing')?.message).toContain('lensPlugin')
    await app.dispose()
  })

  it(
    "two apps on one device: the dice app's forwarded fields bend the table, which then idles",
    async () => {
      const shared = await createNodeGpuContext()
      const frames = fakeAnimationFrames()
      try {
        const table = await tableApp(shared)
        const dice = new App().addPlugin(
          TransformPlugin,
          renderPlugin({ gpu: shared, windowView: false }),
          forwardPlugin({ msaa: 1 }),
        )
        await dice.init()
        const die = dice.world.spawn(Transform)
        await settle(table.app)
        const [before] = await shoot(table.app, [table.table])

        table.app.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false }))
        const running = table.app.run()
        await Promise.resolve()
        frames.runUntilIdle()
        expect(frames.pending).toBe(0)

        // The dice app publishes while its effect runs; the host forwards each frame.
        publishLensField(dice.world, field(die, { ttlMs: 150 }))
        for (let i = 0; i < 30; i++) {
          dice.update(1 / 60)
          forwardLensFields(dice.world, table.app.world)
          frames.tick()
          await table.app.world.resource(Shaders).whenIdle()
          await shared.pipelines.whenIdle()
          publishLensField(dice.world, field(die, { ttlMs: 150 }))
        }
        const bent = captureView(table.app.world, table.table)
        frames.tick()
        const diff = compare(before!, await bent, [32, 24], 12)
        expect(diff.outsideDiffer).toBe(0)
        expect(diff.insideDiffer).toBeGreaterThan(50)

        // The host stops forwarding: the table keeps its frames until the fields expire, then idles.
        const ran = frames.runUntilIdle()
        expect(ran).toBeGreaterThanOrEqual(5)
        expect(ran).toBeLessThanOrEqual(9)
        expect(frames.pending).toBe(0)
        expect(table.app.world.resource(LensFields).fields).toHaveLength(0)
        expect(table.app.world.resource(FrameDemand).isHeld(LENS_DEMAND)).toBe(false)
        expect(graphOrder(table.app, table.table)).not.toContain('post/lens')
        expect(shared.errors).toEqual([])
        await table.app.dispose()
        await running
        await dice.dispose()
      } finally {
        frames.restore()
        shared.destroy()
      }
    },
    timeout(60_000),
  )
})
