import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assetServer } from '@shard/assets'
import { ChildOf, Commands, defineComponent, type Entity, t, World } from '@shard/core'
import { createNodePlatform } from '@shard/platform-node'
import { Materials, Mesh3d, Meshes, MeshMaterial } from '@shard/render'
import { App, Log, LogResource } from '@shard/runtime'
import { Transform } from '@shard/transform'
import { afterAll, describe, expect, it } from 'vitest'
import { InstancePart, PrefabInstance } from './components'
import type { SceneFile } from './format'
import {
  currentOverrides,
  instanceEntities,
  loadPrefab,
  ScenePlugin,
  spawnPrefab,
  updateInstances,
} from './instances'
import { applyToPrefab, registerPrefab, validatePrefab } from './prefab-file'
import {
  findEntityByPath,
  loadScene,
  saveScene,
  stringifyScene,
  validateScene,
  whenSceneReady,
} from './scene'
import { prefabJsonSchema } from './schema'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

const Health = defineComponent('test/Health', {
  max: t.f32({ default: 10 }),
  current: t.f32({ default: 10 }),
})
const Thruster = defineComponent('test/Thruster', {
  power: t.f32({ default: 1 }),
  label: t.string(),
})
const Aim = defineComponent('test/Aim', { target: t.entity })

function world(): World {
  const w = new World()
  w.initResource(Meshes)
  w.initResource(Materials)
  return w
}

const SHIP = 'prefabs/ship.prefab.json'

const ship = {
  version: 1,
  assets: { hull: { type: 'Material', value: { baseColor: '#8a93a6' } } },
  root: {
    name: 'ship',
    components: {
      'core/Transform': { translation: [1, 1, 1] },
      'test/Health': { max: 100, current: 50 },
      'test/Aim': { target: 'Exhaust' },
    },
    children: [
      {
        name: 'Hull',
        components: {
          'render/Mesh3d': { mesh: { path: 'procedural:box?x=2' } },
          'render/MeshMaterial': { material: { path: '#hull' } },
        },
        children: [
          { name: 'Cockpit', components: { 'core/Transform': { translation: [0, 1, 0] } } },
          { name: 'Antenna', components: { 'core/Transform': { translation: [0, 2, 0] } } },
        ],
      },
      {
        name: 'Exhaust',
        components: {
          'test/Thruster': { power: 1, label: 'main' },
          'test/Aim': { target: 'Hull' },
        },
      },
    ],
  },
}

const scene: SceneFile = {
  version: 1,
  entities: [
    {
      name: 'player-ship',
      components: {
        'core/Transform': { translation: [0, 5, 0] },
        'test/Health': { max: 200 },
        'scene/PrefabInstance': {
          prefab: { path: SHIP },
          overrides: {
            Exhaust: { 'test/Thruster': { power: 2 } },
            'Hull/Cockpit': { 'test/Health': { max: 5 } },
            'Hull/Antenna': null,
            'Exhaust/test/Aim': null,
          },
        },
      },
      children: [{ name: 'Beacon', components: { 'core/Transform': {} } }],
    },
    {
      name: 'wingman',
      components: { 'scene/PrefabInstance': { prefab: { path: SHIP } } },
    },
  ],
}

function load(w: World, file: SceneFile = scene) {
  const handle = loadScene(w, structuredClone(file))
  updateInstances(w)
  return handle
}

const at = (w: World, path: string) => findEntityByPath(w, path)!

describe('instances', () => {
  it('load as authored: root merged, children by path, overrides applied, authored children kept', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    load(w)
    const root = at(w, 'player-ship')
    expect([...w.get(root, Transform).translation]).toEqual([0, 5, 0]) // the entity's own
    expect(w.get(root, Health)).toEqual({ max: 200, current: 50 }) // own max, prefab current
    const hull = at(w, 'player-ship/Hull')
    expect(w.get(hull, ChildOf).parent).toBe(root)
    expect(w.get(hull, InstancePart)).toEqual({ instance: root, path: 'Hull' })
    expect(w.resource(Materials).get(w.get(hull, MeshMaterial).material)).toBeDefined()
    expect(w.get(at(w, 'player-ship/Hull/Cockpit'), Health).max).toBe(5) // added component
    expect(findEntityByPath(w, 'player-ship/Hull/Antenna')).toBeUndefined() // removed entity
    const exhaust = at(w, 'player-ship/Exhaust')
    expect(w.get(exhaust, Thruster)).toEqual({ power: 2, label: 'main' })
    expect(w.has(exhaust, Aim)).toBe(false) // removed component
    expect(w.get(root, Aim).target).toBe(exhaust) // root refs resolve to generated entities
    expect(w.get(at(w, 'wingman/Exhaust'), Aim).target).toBe(at(w, 'wingman/Hull'))
    expect(w.get(at(w, 'player-ship/Beacon'), ChildOf).parent).toBe(root)
    // Two instances, two sets of entities.
    expect(at(w, 'wingman/Hull')).not.toBe(hull)
    expect([...w.get(at(w, 'wingman'), Transform).translation]).toEqual([1, 1, 1])
  })

  it('saving an untouched scene reproduces the file byte for byte', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    load(w)
    expect(stringifyScene(saveScene(w, 'main'))).toBe(stringifyScene(scene))
  })

  it('saving writes changes to generated entities as overrides, and only those', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    load(w)
    w.set(at(w, 'player-ship/Exhaust'), Thruster, { label: 'hot' })
    w.set(at(w, 'wingman/Hull/Antenna'), Transform, { translation: [0, 3, 0] })
    w.remove(at(w, 'wingman/Hull'), Mesh3d)
    w.despawn(at(w, 'wingman/Hull/Cockpit'))
    w.add(at(w, 'wingman/Exhaust'), Health, { max: 1 })
    const saved = saveScene(w, 'main')
    const overrides = (e: number) =>
      saved.entities[e]!.components!['scene/PrefabInstance']!.overrides
    expect(overrides(0)).toEqual({
      Exhaust: { 'test/Thruster': { power: 2, label: 'hot' } },
      'Hull/Cockpit': { 'test/Health': { max: 5 } },
      'Hull/Antenna': null,
      'Exhaust/test/Aim': null,
    })
    expect(overrides(1)).toEqual({
      'Hull/render/Mesh3d': null,
      'Hull/Cockpit': null,
      'Hull/Antenna': { 'core/Transform': { translation: [0, 3, 0] } },
      Exhaust: { 'test/Health': { max: 1, current: 10 } },
    })
    // The root's prefab components aren't written into the scene.
    expect(Object.keys(saved.entities[1]!.components!)).toEqual(['scene/PrefabInstance'])
  })

  it('a field set back to the prefab value drops out of the overrides', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    load(w)
    w.set(at(w, 'player-ship/Exhaust'), Thruster, { power: 1 })
    const o = currentOverrides(w, at(w, 'player-ship'))!
    expect(o.Exhaust).toBeUndefined()
  })

  it("an overridden entity shares the prefab's #assets (no phantom difference)", () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    const e = spawnPrefab(w, SHIP, { overrides: { Hull: { 'test/Health': { max: 3 } } } })
    const hull = instanceEntities(w, e).get('Hull')!
    const other = instanceEntities(w, spawnPrefab(w, SHIP)).get('Hull')!
    expect(w.get(hull, MeshMaterial).material?.guid).toBe(w.get(other, MeshMaterial).material?.guid)
    expect(currentOverrides(w, e)).toEqual({ Hull: { 'test/Health': { max: 3 } } })
  })

  it('changing overrides on the component respawns with them', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    load(w)
    const root = at(w, 'wingman')
    w.set(root, PrefabInstance, { overrides: { Exhaust: { 'test/Thruster': { power: 9 } } } })
    updateInstances(w)
    expect(w.get(at(w, 'wingman/Exhaust'), Thruster).power).toBe(9)
    expect(currentOverrides(w, root)).toEqual({ Exhaust: { 'test/Thruster': { power: 9 } } })
  })

  it('despawning the instance despawns what it generated', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    load(w)
    const before = w.entityCount
    w.despawn(at(w, 'wingman'))
    updateInstances(w)
    expect(w.entityCount).toBe(before - 5)
  })
})

describe('validation', () => {
  it('reports bad override paths and values with pointers into overrides', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    const bad: SceneFile = {
      version: 1,
      entities: [
        {
          name: 'a',
          components: {
            'scene/PrefabInstance': {
              prefab: { path: SHIP },
              overrides: {
                'Hull/Cockpit': { 'test/Health': { max: 'lots' } },
                'Hull/Nope': null,
                Wing: { 'core/Transform': {} },
                Exhaust: { 'test/Missing': {} },
              },
            },
          },
          children: [{ name: 'Hull' }],
        },
      ],
    }
    const errors = validateScene(w, bad).map((e) => [e.code, e.path])
    const base = '/entities/0/components/scene~1PrefabInstance/overrides'
    expect(errors).toEqual(
      expect.arrayContaining([
        ['schema/type-mismatch', `${base}/Hull~1Cockpit/test~1Health/max`],
        ['prefab/unknown-path', `${base}/Hull~1Nope`],
        ['prefab/unknown-path', `${base}/Wing`],
        ['scene/unknown-component', `${base}/Exhaust/test~1Missing`],
        ['prefab/duplicate-name', '/entities/0/children/0/name'],
      ]),
    )
    expect(errors.length).toBe(5)
  })

  it('validates prefab files with pointers, and the JSON Schema accepts them', () => {
    const w = world()
    expect(validatePrefab(w, ship)).toEqual([])
    const errors = validatePrefab(w, {
      version: 1,
      root: {
        name: 'x',
        components: { 'test/Health': { max: 'x' }, 'test/Aim': { target: 'Nowhere' } },
        children: [{ name: 'a' }, { name: 'a' }],
      },
      overrides: {},
    }).map((e) => [e.code, e.path])
    expect(errors).toEqual(
      expect.arrayContaining([
        ['schema/type-mismatch', '/root/components/test~1Health/max'],
        ['scene/unknown-entity-path', '/root/components/test~1Aim/target'],
        ['scene/duplicate-name', '/root/children/1/name'],
        ['prefab/unknown-field', '/overrides'],
      ]),
    )
    const schema = prefabJsonSchema()
    expect(schema.oneOf).toBeDefined()
  })
})

describe('variants', () => {
  const heavy = {
    version: 1,
    extends: { path: SHIP },
    rootComponents: { 'test/Health': { max: 500 } },
    overrides: { 'Hull/Antenna': null, Exhaust: { 'test/Thruster': { power: 4 } } },
    // '#hull' is the base's asset: variants can use them.
    children: [
      {
        name: 'Turret',
        components: {
          'core/Transform': {},
          'render/MeshMaterial': { material: { path: '#hull' } },
        },
      },
    ],
  }

  it('a variant spawns as its base with its overrides', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    registerPrefab(w, 'prefabs/heavy.prefab.json', heavy)
    const root = spawnPrefab(w, 'prefabs/heavy.prefab.json')
    const parts = instanceEntities(w, root)
    expect(w.get(root, Health)).toEqual({ max: 500, current: 50 })
    expect(parts.has('Hull/Antenna')).toBe(false)
    expect(parts.has('Turret')).toBe(true)
    expect(
      w.resource(Materials).get(w.get(parts.get('Turret')!, MeshMaterial).material),
    ).toBeDefined()
    expect(w.get(parts.get('Exhaust')!, Thruster).power).toBe(4)
  })

  it('editing the base updates instances of the variant', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    registerPrefab(w, 'prefabs/heavy.prefab.json', heavy)
    const root = spawnPrefab(w, 'prefabs/heavy.prefab.json')
    const next = structuredClone(ship)
    next.root.children.push({
      name: 'Wing',
      components: { 'test/Thruster': { power: 1, label: '' } },
    } as never)
    registerPrefab(w, SHIP, next)
    const parts = instanceEntities(w, root)
    expect(parts.has('Wing')).toBe(true)
    expect(parts.has('Turret')).toBe(true)
    expect(w.get(parts.get('Exhaust')!, Thruster).power).toBe(4)
  })

  it('a prefab that extends itself fails with prefab/cycle', () => {
    const w = world()
    registerPrefab(w, 'prefabs/a.prefab.json', ship)
    expect(() =>
      registerPrefab(w, 'prefabs/a.prefab.json', {
        version: 1,
        extends: { path: 'prefabs/a.prefab.json' },
      }),
    ).toThrow(expect.objectContaining({ code: 'prefab/cycle' }))
  })
})

describe('hot reload', () => {
  it('updates every instance and keeps each one’s overrides; a renamed child warns', () => {
    const w = world()
    w.insertResource(LogResource, new Log())
    registerPrefab(w, SHIP, ship)
    load(w)
    const next = structuredClone(ship)
    next.root.components['test/Health'].current = 75
    next.root.children[1]!.name = 'Engine'
    next.root.components['test/Aim'].target = 'Engine'
    next.root.children[0]!.components['render/Mesh3d'] = { mesh: { path: 'procedural:box?x=3' } }
    registerPrefab(w, SHIP, next)
    const root = at(w, 'player-ship')
    expect(w.get(root, Health)).toEqual({ max: 200, current: 75 })
    expect(w.get(at(w, 'wingman'), Health)).toEqual({ max: 100, current: 75 })
    expect(w.get(at(w, 'player-ship/Hull/Cockpit'), Health).max).toBe(5) // override kept
    expect(findEntityByPath(w, 'player-ship/Hull/Antenna')).toBeUndefined()
    expect(findEntityByPath(w, 'player-ship/Engine')).toBeDefined()
    expect(findEntityByPath(w, 'player-ship/Exhaust')).toBeUndefined()
    expect(w.get(root, Aim).target).toBe(at(w, 'player-ship/Engine')) // rewired to the new child
    const warnings = w.resource(LogResource).tail(50, 'warn')
    expect(
      warnings.some((e) => e.code === 'prefab/stale-override' && e.message.includes('Exhaust')),
    ).toBe(true)
    // Stale overrides stay in the file.
    const saved = saveScene(w, 'main').entities[0]!.components!['scene/PrefabInstance']!.overrides
    expect(saved).toMatchObject({
      Exhaust: { 'test/Thruster': { power: 2 } },
      'Exhaust/test/Aim': null,
    })
  })

  it('a runtime change to the root survives a reload; untouched root fields follow the prefab', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    const root = spawnPrefab(w, SHIP, { transform: { translation: [4, 0, 0] } })
    w.set(root, Health, { current: 1 })
    const next = structuredClone(ship)
    next.root.components['test/Health'] = { max: 300, current: 80 }
    next.root.components['core/Transform'] = { translation: [9, 9, 9], scale: [2, 2, 2] } as never
    registerPrefab(w, SHIP, next)
    expect(w.get(root, Health)).toEqual({ max: 300, current: 1 })
    expect([...w.get(root, Transform).translation]).toEqual([4, 0, 0])
    expect([...w.get(root, Transform).scale]).toEqual([2, 2, 2])
  })
})

describe('spawning', () => {
  it('spawnPrefab needs the prefab loaded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-prefab-load-'))
    try {
      mkdirSync(join(root, 'prefabs'))
      writeFileSync(join(root, SHIP), JSON.stringify(ship))
      const w = world()
      const assets = assetServer(w).configure({
        platform: createNodePlatform({ root, logTo: () => {} }),
      })
      await assets.scan()
      expect(() => spawnPrefab(w, SHIP)).toThrow(
        expect.objectContaining({ code: 'prefab/not-loaded' }),
      )
      await loadPrefab(w, SHIP)
      const e = spawnPrefab(w, SHIP, {
        overrides: { Exhaust: { 'test/Thruster': { power: 7 } } },
      })
      expect(w.get(instanceEntities(w, e).get('Exhaust')!, Thruster).power).toBe(7)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('spawns from Commands when they apply, with the root id right away', () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    const cmd = new Commands(w)
    const parent = w.spawn(Transform)
    const e = spawnPrefab(cmd, SHIP, { parent })
    expect(w.isAlive(e)).toBe(false)
    cmd.apply()
    expect(w.get(e, ChildOf).parent).toBe(parent)
    expect(instanceEntities(w, e).size).toBe(4)
    // Found by PrefabInstance queries like any other instance.
    expect(w.query({ with: [PrefabInstance] }).entities()).toContain(e)
  })

  it('spawns 1,000 instances of a 10-entity prefab in under 20 ms', () => {
    const w = world()
    const children = Array.from({ length: 9 }, (_, i) => ({
      name: `part${i}`,
      components: {
        'core/Transform': { translation: [i, 0, 0] },
        'test/Thruster': { power: i },
      },
    }))
    registerPrefab(w, 'prefabs/drone.prefab.json', {
      version: 1,
      root: { name: 'drone', components: { 'core/Transform': {}, 'test/Health': {} }, children },
    })
    spawnPrefab(w, 'prefabs/drone.prefab.json') // warm up: compiles the template
    let ms = Number.POSITIVE_INFINITY
    for (let run = 0; run < 3; run++) {
      const roots: Entity[] = []
      const start = performance.now()
      for (let i = 0; i < 1000; i++)
        roots.push(
          spawnPrefab(w, 'prefabs/drone.prefab.json', { transform: { translation: [i, 0, 0] } }),
        )
      ms = Math.min(ms, performance.now() - start)
      for (const r of roots) w.despawn(r)
      updateInstances(w)
    }
    expect(ms).toBeLessThan(budget(20))
  })
})

describe('apply to prefab', () => {
  it('writes an instance’s overrides into the prefab; others pick it up; it has none left', async () => {
    const w = world()
    registerPrefab(w, SHIP, ship)
    load(w)
    const root = at(w, 'player-ship')
    w.set(at(w, 'player-ship/Hull/Cockpit'), Transform, { translation: [0, 1.5, 0] })
    const result = await applyToPrefab(w, root)
    expect(result.applied).toMatchObject({ Exhaust: { 'test/Thruster': { power: 2 } } })
    expect(currentOverrides(w, root)).toEqual({})
    expect(w.get(root, PrefabInstance).overrides).toEqual({})
    expect(w.get(at(w, 'wingman/Exhaust'), Thruster).power).toBe(2)
    expect(w.has(at(w, 'wingman/Exhaust'), Aim)).toBe(false)
    expect(findEntityByPath(w, 'wingman/Hull/Antenna')).toBeUndefined()
    expect([...w.get(at(w, 'wingman/Hull/Cockpit'), Transform).translation]).toEqual([0, 1.5, 0])
  })
})

// --- files -------------------------------------------------------------------------------------------

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function project(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'shard-prefab-'))
  roots.push(root)
  for (const [path, json] of Object.entries(files)) write(root, path, json)
  return root
}

function write(root: string, path: string, json: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), `${JSON.stringify(json, null, 2)}\n`)
}

async function start(root: string) {
  const app = new App().addPlugin(ScenePlugin)
  app.world.initResource(Meshes)
  app.world.initResource(Materials)
  await app.init()
  const assets = assetServer(app.world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  const report = await assets.scan()
  return { app, assets, report }
}

describe('prefab files', () => {
  it('import as assets; variants follow their base file; edits update running instances', async () => {
    const root = project({
      [SHIP]: ship,
      'prefabs/heavy.prefab.json': {
        version: 1,
        extends: { path: SHIP },
        rootComponents: { 'test/Health': { max: 500 } },
      },
    })
    const { app, assets, report } = await start(root)
    expect(report.failed).toEqual([])
    expect(assets.info('prefabs/heavy.prefab.json').info).toMatchObject({
      extends: [SHIP],
      root: 'ship',
    })
    expect(assets.info(SHIP).info).toMatchObject({
      tree: ['Hull', 'Hull/Cockpit', 'Hull/Antenna', 'Exhaust'],
    })
    const w = app.world
    loadScene(w, {
      version: 1,
      entities: [
        {
          name: 'a',
          components: {
            'scene/PrefabInstance': {
              prefab: { path: SHIP },
              overrides: { Exhaust: { 'test/Thruster': { label: 'x' } } },
            },
          },
        },
        {
          name: 'b',
          components: { 'scene/PrefabInstance': { prefab: { path: 'prefabs/heavy.prefab.json' } } },
        },
      ],
    })
    await whenSceneReady(w, 'main')
    expect(w.get(at(w, 'b'), Health).max).toBe(500)
    // Edit the base: both instances update within two frames; overrides stay.
    const next = structuredClone(ship)
    next.root.children[1]!.components['test/Thruster']!.power = 6
    write(root, SHIP, next)
    await assets.scan()
    app.update(1 / 60)
    app.update(1 / 60)
    expect(w.get(at(w, 'a/Exhaust'), Thruster)).toEqual({ power: 6, label: 'x' })
    expect(w.get(at(w, 'b/Exhaust'), Thruster).power).toBe(6)
    expect(w.get(at(w, 'b'), Health).max).toBe(500)
  })

  it('a prefab that contains or extends itself fails to import with prefab/cycle', async () => {
    const holder = (path: string) => ({
      version: 1,
      root: {
        name: 'r',
        children: [{ name: 'x', components: { 'scene/PrefabInstance': { prefab: { path } } } }],
      },
    })
    const root = project({
      'prefabs/a.prefab.json': holder('prefabs/b.prefab.json'),
      'prefabs/b.prefab.json': holder('prefabs/a.prefab.json'),
      'prefabs/c.prefab.json': { version: 1, extends: { path: 'prefabs/c.prefab.json' } },
    })
    const { report } = await start(root)
    expect(report.failed.map((f) => [f.path, f.error.code]).sort()).toEqual([
      ['prefabs/a.prefab.json', 'prefab/cycle'],
      ['prefabs/b.prefab.json', 'prefab/cycle'],
      ['prefabs/c.prefab.json', 'prefab/cycle'],
    ])
  })

  it('apply writes the file and re-imports it', async () => {
    const root = project({ [SHIP]: ship })
    const { app } = await start(root)
    const w = app.world
    loadScene(w, structuredClone(scene))
    await whenSceneReady(w, 'main')
    const fs = createNodePlatform({ root, logTo: () => {} }).fs
    await applyToPrefab(w, at(w, 'player-ship'), fs)
    const written = JSON.parse(readFileSync(join(root, SHIP), 'utf8'))
    expect(written.root.children[1].components).toEqual({
      'test/Thruster': { power: 2, label: 'main' },
    })
    expect(written.root.children[0].children.map((c: { name: string }) => c.name)).toEqual([
      'Cockpit',
    ])
    expect(written.root.children[0].children[0].components['test/Health']).toEqual({ max: 5 })
    expect(currentOverrides(w, at(w, 'player-ship'))).toEqual({})
    expect(w.get(at(w, 'wingman/Exhaust'), Thruster).power).toBe(2)
  })
})
