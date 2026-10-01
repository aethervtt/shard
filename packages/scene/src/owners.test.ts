import { World } from '@aethervtt/shard-core'
import { Materials, Meshes } from '@aethervtt/shard-render'
import { describe, expect, it } from 'vitest'
import { SceneIndex } from './components'
import { validatePrefab } from './prefab-file'
import { loadScene, validateScene } from './scene'

// Ownership in authored data (0061): scene files and prefabs can't name an owner, and a scene the
// host loads for an owner belongs to it entirely.

function world(): World {
  const w = new World()
  w.initResource(Meshes)
  w.initResource(Materials)
  return w
}

const owned = {
  version: 1,
  entities: [
    {
      name: 'lantern',
      components: { 'core/Transform': {}, 'core/OwnedBy': { owner: 1, inherited: false } },
    },
  ],
}

describe('ownership in scene files and prefabs (0061)', () => {
  it('fails a scene naming core/OwnedBy with core/owner-not-authorable, and creates nothing', () => {
    const w = world()
    w.owners.create('mod:lanterns')
    expect(validateScene(w, owned).map((e) => [e.code, e.path])).toEqual([
      ['core/owner-not-authorable', '/entities/0/components/core~1OwnedBy'],
    ])
    expect(() => loadScene(w, owned)).toThrow(/core\/OwnedBy/)
    expect(w.entityCount).toBe(0)
  })

  it('fails a prefab naming core/OwnedBy the same way', () => {
    const w = world()
    const prefab = {
      version: 1,
      root: { name: 'lantern', components: owned.entities[0]!.components },
    }
    expect(validatePrefab(w, prefab).map((e) => e.code)).toEqual(['core/owner-not-authorable'])
  })

  it('gives a scene loaded for an owner to that owner, and checks its limit first', () => {
    const w = world()
    const scene = {
      version: 1,
      entities: [
        {
          name: 'a',
          components: { 'core/Transform': {} },
          children: [{ name: 'b' }, { name: 'c' }],
        },
        { name: 'd' },
      ],
    }
    const small = w.owners.create('small', { limits: { entities: 3 } })
    expect(() => loadScene(w, scene, { id: 's1', owner: small })).toThrow(/entities limit/)
    expect(w.entityCount).toBe(0)
    const host = w.owners.create('scene:abc')
    const { entities } = loadScene(w, scene, { id: 's2', owner: host })
    for (const e of entities.values()) expect(w.owners.nameOf(e)).toBe('scene:abc')
    expect(w.owners.describe(host).usage.entities).toBe(4)
    w.owners.release(host)
    expect(w.entityCount).toBe(0)
    // The scene left the index with its owner, so the id can load again.
    expect(w.resource(SceneIndex).has('s2')).toBe(false)
    loadScene(w, scene, { id: 's2' })
  })
})
