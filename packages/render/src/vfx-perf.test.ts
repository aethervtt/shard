import { PostUpdate } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow, timingMode } from '@aethervtt/shard-core/test-env'
import { cube } from '@aethervtt/shard-mesh'
import { App, Time } from '@aethervtt/shard-runtime'
import {
  GlobalTransform,
  Transform,
  TransformPlugin,
  TransformSystems,
} from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { Materials, Meshes } from './assets'
import { Decals, projectDecal, updateDecals } from './decals'
import { Mesh3d } from './instances'
import { Ribbons, updateRibbons } from './ribbons'
import { Decal, DecalReceiver, Trail } from './vfx'

it('samples 128 ribbons × 64 points and cached decals without steady-state collections', async () => {
  const app = new App().addPlugin(TransformPlugin),
    w = app.world
  w.initResource(Ribbons)
  w.initResource(Decals)
  w.initResource(Meshes)
  w.initResource(Materials)
  app.addSystems(
    PostUpdate,
    updateRibbons.after(TransformSystems),
    updateDecals.after(TransformSystems),
  )
  await app.init()
  for (let i = 0; i < 128; i++)
    w.spawn([Trail, { capacity: 64, lifetime: 100, minDistance: 0.00001 }])
  const mesh = w.resource(Meshes).add(cube())
  w.spawn(Transform, [Mesh3d, { mesh }], DecalReceiver)
  for (let i = 0; i < 32; i++) w.spawn([Decal, { size: [2, 2, 2] }])
  app.update(0)
  const rc = updateRibbons.setup!(w),
    dc = updateDecals.setup!(w)
  const matrices = w
    .query({ with: [Trail, GlobalTransform] })
    .tables[0]!.column(GlobalTransform, 'matrix') as Float32Array
  const run = () => {
    for (let i = 0; i < 128; i++) matrices[i * 12 + 3] = matrices[i * 12 + 3]! + 0.001
    updateRibbons.run(rc, w, undefined as never)
    updateDecals.run(dc, w, undefined as never)
  }
  w.resource(Time).delta = 0.0001
  for (let i = 0; i < 64; i++) run()
  expect(w.resource(Ribbons).records[127]!.pointsCount).toBe(64)
  expect(w.resource(Decals).records[31]!.count).toBeGreaterThan(0)
  if (timingMode === 'bench') {
    for (let i = 0; i < 1000; i++) run()
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const times = new Float64Array(500),
      gc = gcWindow()
    for (let i = 0; i < times.length; i++) {
      const start = performance.now()
      run()
      times[i] = performance.now() - start
    }
    const collections = await gc.end()
    times.sort()
    console.log(
      JSON.stringify({
        scenario: 'render/ribbons-update',
        ribbons: 128,
        points: 8192,
        cachedDecals: 32,
        medianMs: times[250],
        p95Ms: times[475],
        collections,
      }),
    )
    expect(times[250]).toBeLessThan(budget('render/ribbons-update'))
    if (allocationChecks) expect(collections).toBe(0)
    const decals = w.resource(Decals),
      project = new Float64Array(100)
    for (let i = 0; i < project.length; i++) {
      const start = performance.now()
      for (let j = 0; j < decals.records.length; j++)
        projectDecal(decals.records[j]!, decals.receivers)
      project[i] = performance.now() - start
    }
    project.sort()
    console.log(
      JSON.stringify({
        scenario: 'render/decals-project',
        projectors: 32,
        receiverTriangles: 12,
        medianMs: project[50],
        p95Ms: project[95],
      }),
    )
    expect(project[50]).toBeLessThan(budget('render/decals-project'))
  }
  await app.dispose()
})
