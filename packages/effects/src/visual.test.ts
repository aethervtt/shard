import { Beam, Trail } from '@aethervtt/shard-render'
import { App, definePlugin } from '@aethervtt/shard-runtime'
import { registerPrefab, ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { parseEffect } from './document'
import { effectsPlugin } from './plugin'
import { cancelEffect, pauseEffect, playEffect, prepareEffect } from './runtime'

it('owns visual activation and endpoint bindings, pauses, rejects overlap and cleans up', async () => {
  const app = new App().addPlugin(
    TransformPlugin,
    ScenePlugin,
    definePlugin({ name: 'render/ribbons', provides: [Beam, Trail], build() {} }),
    effectsPlugin,
  )
  await app.init()
  const w = app.world,
    receiver = w.spawn(Transform)
  registerPrefab(w, 'beam.prefab.json', {
    version: 1,
    root: { name: 'beam', components: { 'render/Beam': { end: [0, 0, 0] }, 'render/Trail': {} } },
  })
  const doc = {
    duration: 3,
    targets: [{ id: 'beam', prefab: { path: 'beam.prefab.json' } }, { id: 'end' }],
    tracks: [
      {
        id: 'beam',
        kind: 'visual',
        target: 'beam',
        component: 'render/Beam',
        endpoint: 'end',
        start: 0.5,
        duration: 1,
      },
      {
        id: 'trail',
        kind: 'visual',
        target: 'beam',
        component: 'render/Trail',
        start: 0.5,
        duration: 1,
      },
    ],
  }
  expect(() =>
    parseEffect({ ...doc, tracks: [doc.tracks[0], { ...doc.tracks[0], id: 'overlap' }] }),
  ).toThrow()
  expect(() =>
    parseEffect({ ...doc, tracks: [{ ...doc.tracks[0], endpoint: 'unknown' }] }),
  ).toThrow()
  const plan = await prepareEffect(w, doc),
    run = playEffect(w, plan, { bindings: { end: receiver } })
  const entity = run.targets.get('beam')!
  expect(w.get(entity, Beam).playing).toBe(false)
  expect(w.get(entity, Beam).target).toBe(receiver)
  app.update(0.5)
  expect(w.get(entity, Beam).playing).toBe(true)
  pauseEffect(w, run.id)
  expect(w.get(entity, Beam).paused).toBe(true)
  app.update(0.5)
  expect(run.time).toBe(0.5)
  pauseEffect(w, run.id, false)
  app.update(1)
  expect(w.get(entity, Beam).playing).toBe(false)
  expect(w.get(entity, Trail).playing).toBe(false)
  pauseEffect(w, run.id)
  expect(w.get(entity, Trail).paused).toBe(true)
  cancelEffect(w, run.id)
  app.update(0)
  expect(w.isAlive(entity)).toBe(false)
  expect(w.isAlive(receiver)).toBe(true)
  const skipped = playEffect(w, plan, { bindings: { end: receiver } })
  app.update(2)
  expect(w.get(skipped.targets.get('beam')!, Beam).playing).toBe(false)
  w.despawn(receiver)
  app.update(0)
  expect(skipped.state).toBe('failed')
  expect(w.isAlive(skipped.targets.get('beam')!)).toBe(false)
  plan.release()
  await app.dispose()
})
