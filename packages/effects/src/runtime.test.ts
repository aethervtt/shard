import { AnimationClips, animationPlugin, parsePropertyClip } from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import { defineComponent, t } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { registerPrefab, ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { EffectSequence, parseEffect } from './document'
import { effectsPlugin } from './plugin'
import {
  cancelEffect,
  describeEffects,
  Effects,
  pauseEffect,
  playEffect,
  prepareEffect,
} from './runtime'

const Extra = defineComponent('effects-test/Extra', { value: t.f32() })
const move = {
  id: 'move',
  kind: 'property',
  target: 'actor',
  duration: 1,
  component: 'core/Transform',
  field: 'translation',
  from: [0, 0, 0],
  to: [10, 2, 0],
}
const document = {
  duration: 2,
  targets: [{ id: 'actor' }],
  tracks: [move, { id: 'impact', kind: 'marker', start: 1, marker: 'impact' }],
}
async function setup() {
  const app = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin, effectsPlugin)
  await app.init()
  const world = app.world
  const actor = world.spawn([Transform, { translation: [3, 4, 5] }])
  return { app, world, actor }
}

describe('effect sequence authoring', () => {
  it('uses schema defaults, limits and semantic validation for direct/imported documents', () => {
    expect(parseEffect(document).tracks[0]!.easing).toBe('linear')
    const invalid = [
      { ...document, duration: -1 },
      { ...document, tracks: [move, move] },
      { ...document, tracks: [{ ...move, duration: 3 }] },
      { ...document, tracks: [{ ...move, target: 'missing' }] },
      { ...document, tracks: [{ ...move, from: [0] }] },
      { ...document, tracks: [{ ...move, parameter: 'missing' }] },
      { ...document, tracks: [move, { ...move, id: 'other', start: 0.5 }] },
      { ...document, tracks: [{ id: 'bad', kind: 'audio', target: 'actor', duration: 1 }] },
      { ...document, tracks: [{ ...move, duration: Number.NaN }] },
    ]
    for (const value of invalid) {
      expect(() => parseEffect(value)).toThrow()
      expect(EffectSequence.importer.check!(value as never, () => undefined)).not.toHaveLength(0)
    }
    expect(EffectSequence.jsonSchema()).toHaveProperty('properties.tracks')
  })
})

describe('effect runtime', () => {
  it('samples time zero, crosses boundaries once, holds and restores borrowed state', async () => {
    const { app, world, actor } = await setup()
    const plan = await prepareEffect(world, document)
    const instance = playEffect(world, plan, { bindings: { actor }, seed: 123 })
    expect(world.get(actor, Transform).translation).toEqual([0, 0, 0])
    app.update(0.5)
    expect(world.get(actor, Transform).translation).toEqual([5, 1, 0])
    app.update(0.75)
    expect(world.get(actor, Transform).translation).toEqual([10, 2, 0])
    app.update(0.75)
    expect(instance.state).toBe('completed')
    expect(world.get(actor, Transform).translation).toEqual([3, 4, 5])
    expect(describeEffects(world).trace.entries.filter((e) => e.kind === 'marker')).toEqual([
      expect.objectContaining({ time: 1, track: 'impact', reason: 'impact' }),
    ])
    plan.release()
    plan.release()
    expect(describeEffects(world).preparations).toEqual([])
    await app.dispose()
  })

  it('retains released preparation, rejects reuse, and cancels idempotently', async () => {
    const { app, world, actor } = await setup()
    const plan = await prepareEffect(world, document)
    const instance = playEffect(world, plan, { bindings: { actor } })
    plan.release()
    expect(describeEffects(world).preparations).toHaveLength(1)
    expect(() => playEffect(world, plan, { bindings: { actor } })).toThrow()
    expect(cancelEffect(world, instance.id)).toBe(true)
    expect(cancelEffect(world, instance.id)).toBe(false)
    expect(world.get(actor, Transform).translation).toEqual([3, 4, 5])
    expect(describeEffects(world).preparations).toEqual([])
    await app.dispose()
  })

  it('handles sequential tracks, parameter scaling, pause, archetype moves and table growth', async () => {
    const { app, world, actor } = await setup()
    const plan = await prepareEffect(world, {
      ...document,
      parameters: [{ id: 'power', min: 0, max: 3 }],
      tracks: [
        { ...move, parameter: 'power' },
        { ...move, id: 'return', start: 1, from: [20, 4, 0], to: [0, 0, 0] },
      ],
    })
    const instance = playEffect(world, plan, { bindings: { actor }, parameters: { power: 2 } })
    app.update(0.5)
    pauseEffect(world, instance.id)
    app.update(0.8)
    expect(instance.time).toBe(0.5)
    expect(world.get(actor, Transform).translation).toEqual([10, 2, 0])
    world.add(actor, Extra)
    for (let i = 0; i < 500; i++) world.spawn(Transform, Extra)
    pauseEffect(world, instance.id, false)
    app.update(0.75)
    expect(world.get(actor, Transform).translation).toEqual([15, 3, 0])
    cancelEffect(world, instance.id)
    expect(world.get(actor, Transform).translation).toEqual([3, 4, 5])
    await app.dispose()
  })

  it('rejects conflicting instances and aliased overlapping tracks without damaging the first', async () => {
    const { app, world, actor } = await setup()
    const plan = await prepareEffect(world, document)
    const first = playEffect(world, plan, { bindings: { actor } })
    expect(() => playEffect(world, plan, { bindings: { actor } })).toThrow(
      expect.objectContaining({ code: 'effects/conflict' }),
    )
    expect(describeEffects(world).instances).toHaveLength(1)
    app.update(0.5)
    expect(world.get(actor, Transform).translation).toEqual([5, 1, 0])
    cancelEffect(world, first.id)
    const alias = await prepareEffect(world, {
      ...document,
      targets: [{ id: 'actor' }, { id: 'same' }],
      tracks: [move, { ...move, id: 'alias', target: 'same' }],
    })
    expect(() => playEffect(world, alias, { bindings: { actor, same: actor } })).toThrow(
      expect.objectContaining({ code: 'effects/conflict' }),
    )
    expect(world.get(actor, Transform).translation).toEqual([3, 4, 5])
    expect(world.resource(Effects).claims.size).toBe(0)
    await app.dispose()
  })

  it('reports dead targets, invalid fields, owner deletion and disposed preparations', async () => {
    const { app, world, actor } = await setup()
    const bad = await prepareEffect(world, {
      ...document,
      tracks: [{ ...move, field: 'rotation' }],
    })
    expect(() => playEffect(world, bad, { bindings: { actor } })).toThrow(
      expect.objectContaining({ code: 'effects/invalid-field' }),
    )
    const plan = await prepareEffect(world, document)
    const instance = playEffect(world, plan, { bindings: { actor } })
    world.despawn(actor)
    app.update(0.1)
    expect(instance).toMatchObject({ state: 'failed', error: 'effects/dead-target' })
    const owner = world.spawn(),
      target = world.spawn(Transform)
    const next = playEffect(world, plan, { bindings: { actor: target }, ownerEntity: owner })
    world.despawn(owner)
    app.update(0.1)
    expect(next.state).toBe('cancelled')
    await app.dispose()
    expect(plan.released).toBe(true)
  })

  it('plays GUID-only documents, freezes snapshots, and rolls back failed preparation', async () => {
    const { app, world, actor } = await setup()
    const server = assetServer(world)
    server.virtual('database-sequence-42', 'catalog/42', EffectSequence.name, () =>
      parseEffect(document),
    )
    const plan = await prepareEffect(world, { guid: 'database-sequence-42' })
    expect(Object.isFrozen(plan.document.tracks[0])).toBe(true)
    const i = playEffect(world, plan, { bindings: { actor } })
    plan.release()
    expect(server.state('database-sequence-42')).toBe('loaded')
    cancelEffect(world, i.id)
    expect(server.state('database-sequence-42')).toBe('unloaded')
    await expect(
      prepareEffect(world, {
        ...document,
        targets: [{ id: 'actor', prefab: { guid: 'missing' } }],
      }),
    ).rejects.toMatchObject({ code: 'effects/asset-missing' })
    expect(describeEffects(world)).toMatchObject({ pending: 0, preparations: [], instances: [] })
    await app.dispose()
  })

  it('owns prefab trees and drives the real animation sampler; cleanup preserves unrelated entities', async () => {
    const { app, world, actor } = await setup()
    const server = assetServer(world)
    registerPrefab(world, 'memory.prefab.json', {
      version: 1,
      root: {
        name: 'spell',
        components: { 'core/Transform': {} },
        children: [{ name: 'tip', components: { 'core/Transform': {} } }],
      },
    })
    const clip = parsePropertyClip(
      {
        duration: 1,
        tracks: [
          {
            path: '',
            component: 'core/Transform',
            field: 'scale',
            keys: [
              [0, [1, 1, 1]],
              [1, [3, 3, 3]],
            ],
          },
        ],
      },
      'cast',
    )
    server.virtual('clip-id', 'catalog/clip', 'AnimationClip', () => clip)
    const plan = await prepareEffect(world, {
      duration: 2,
      targets: [{ id: 'spell', prefab: { path: 'memory.prefab.json' } }],
      tracks: [
        {
          id: 'cast',
          kind: 'animation',
          target: 'spell',
          duration: 1,
          animation: { guid: 'clip-id' },
        },
      ],
    })
    const instance = playEffect(world, plan)
    const root = instance.targets.get('spell')!
    app.update(0.5)
    expect(world.resource(AnimationClips).byGuid('clip-id')).toBeDefined()
    expect(world.get(root, Transform).scale).toEqual([2, 2, 2])
    cancelEffect(world, instance.id)
    expect(world.isAlive(root)).toBe(false)
    expect(world.isAlive(actor)).toBe(true)
    await app.dispose()
  })

  it('makes marker decisions independent of frame partition and bounds trace memory', async () => {
    const { app, world } = await setup()
    const plan = await prepareEffect(world, {
      duration: 1,
      tracks: [0, 0.1, 0.5, 1].map((start, i) => ({
        id: `m${i}`,
        kind: 'marker',
        marker: `mark${i}`,
        start,
      })),
    })
    playEffect(world, plan, { seed: 22 })
    app.update(1)
    const first = describeEffects(world)
      .trace.entries.filter((e) => e.kind === 'marker')
      .map((e) => [e.time, e.reason])
    const cursor = describeEffects(world).trace.nextCursor
    playEffect(world, plan, { seed: 22 })
    for (let i = 0; i < 10; i++) app.update(0.1)
    expect(
      describeEffects(world, cursor)
        .trace.entries.filter((e) => e.kind === 'marker')
        .map((e) => [e.time, e.reason]),
    ).toEqual(first)
    for (let i = 0; i < 400; i++) {
      const run = playEffect(world, plan)
      cancelEffect(world, run.id)
    }
    expect(describeEffects(world).trace.entries.length).toBeLessThanOrEqual(2048)
    await app.dispose()
  })

  it('invalidates an in-flight preparation on disposal and unwinds its catalog lease', async () => {
    const { app, world } = await setup()
    let resolve!: (value: unknown) => void
    const loading = new Promise((done) => {
      resolve = done
    })
    const server = assetServer(world)
    server.virtual('pending-sequence', 'catalog/pending', EffectSequence.name, () => loading)
    const pending = prepareEffect(world, { guid: 'pending-sequence' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'effects/disposed' })
    await app.dispose()
    resolve(parseEffect(document))
    await rejected
    expect(world.resource(Effects).pending).toBe(0)
    expect(world.resource(Effects).plans.size).toBe(0)
    expect(server.state('pending-sequence')).toBe('unloaded')
  })

  it('supports decimal-adjacent tracks and method-schema validation', async () => {
    const { app, world, actor } = await setup()
    const call = async (name: string, value: unknown) => {
      const method = app.methods.find((m) => m.name === name)!
      return method.handler({ app, world }, method.params.deserialize(value))
    }
    const { preparation } = (await call('effects.prepare', {
      source: {
        ...document,
        tracks: [
          { ...move, start: 0.2, duration: 0.1 },
          { ...move, id: 'next', start: 0.3, duration: 0.1 },
        ],
      },
    })) as { preparation: number }
    const { instance } = (await call('effects.play', { preparation, bindings: { actor } })) as {
      instance: number
    }
    await call('effects.pause', { instance })
    expect(describeEffects(world).instances[0]!.state).toBe('paused')
    await expect(call('effects.play', { preparation, bindings: [] })).rejects.toMatchObject({
      code: 'effects/invalid-sequence',
    })
    await call('effects.cancel', { instance })
    await call('effects.release', { preparation })
    expect(await call('effects.inspect', {})).toMatchObject({ instances: [], preparations: [] })
    await app.dispose()
  })
})
