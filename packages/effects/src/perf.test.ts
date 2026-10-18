import { defineComponent, t } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow, timingMode } from '@aethervtt/shard-core/test-env'
import { App, Time } from '@aethervtt/shard-runtime'
import { expect, it } from 'vitest'
import { effectsPlugin } from './plugin'
import { playEffect, prepareEffect, updateEffects } from './runtime'

const Values = defineComponent('effects-perf/Values', {
  a: t.f32(),
  b: t.f32(),
  c: t.vec3(),
  d: t.f32(),
})

it('samples 200 sequences × four fields without steady-state collections', async () => {
  const app = new App().addPlugin(effectsPlugin)
  await app.init()
  const world = app.world
  const plan = await prepareEffect(world, {
    duration: 3600,
    targets: [{ id: 'target' }],
    tracks: ['a', 'b', 'c', 'd'].map((field) => ({
      id: field,
      kind: 'property',
      target: 'target',
      component: Values.name,
      field,
      duration: 3600,
      from: field === 'c' ? [0, 0, 0] : [0],
      to: field === 'c' ? [1, 2, 3] : [1],
    })),
  })
  const targets = []
  for (let i = 0; i < 200; i++) {
    const entity = world.spawn(Values)
    targets.push(entity)
    playEffect(world, plan, { bindings: { target: entity } })
  }
  const run = () => updateEffects.run(undefined, world, undefined as never)
  world.resource(Time).delta = 1 / 60
  run()
  expect(world.get(targets[199]!, Values).c[2]).toBeGreaterThan(0)
  if (timingMode === 'bench') {
    for (let i = 0; i < 3000; i++) run()
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const times = new Float64Array(1000),
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
        scenario: 'effects/update',
        sequences: 200,
        tracks: 800,
        medianMs: times[500],
        p95Ms: times[950],
        collections,
      }),
    )
    expect(times[500]).toBeLessThan(budget('effects/update'))
    if (allocationChecks) expect(collections).toBe(0)
  }
  await app.dispose()
})
