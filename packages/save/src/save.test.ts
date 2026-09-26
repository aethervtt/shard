import { createHash } from 'node:crypto'
import {
  ChildOf,
  defineComponent,
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  t,
  Update,
  type World,
} from '@shard/core'
import { Collider, physics3dPlugin, RigidBody, Velocity } from '@shard/physics'
import { createMemoryStorage } from '@shard/platform'
import { App, GlobalRng, Time } from '@shard/runtime'
import {
  currentOverrides,
  findEntityByPath,
  instanceEntities,
  loadPrefab,
  loadScene,
  PrefabInstance,
  registerPrefab,
  type SceneFile,
  SceneMember,
  ScenePlugin,
  spawnPrefab,
  whenSceneReady,
} from '@shard/scene'
import {
  GlobalTransform,
  GridCell,
  placeInGrid,
  Transform,
  TransformPlugin,
  worldPosition64,
} from '@shard/transform'
import { describe, expect, it } from 'vitest'
import { SAVE_VERSION, type SaveFile, saveJsonSchema } from './format'
import { savePlugin } from './plugin'
import {
  captureGame,
  describeSave,
  listSaves,
  loadGame,
  NoSave,
  readSave,
  SaveConfig,
  saveGame,
  writeSave,
} from './save'

const Health = defineComponent('save-test/Health', {
  current: t.f32({ default: 100 }),
  max: t.f32({ default: 100 }),
})
const Target = defineComponent('save-test/Target', {
  entity: t.entity(),
  others: t.list(t.entity),
})
const Cache = defineComponent('save-test/Cache', { value: t.f32() }, { save: false })

const InventorySchema = defineSchema('save-test/Inventory', {
  items: t.list(t.string),
  gold: t.u32(),
})
const Inventory = defineResource<{ items: string[]; gold: number }>('save-test/Inventory', {
  schema: InventorySchema,
  persist: true,
  init: () => InventorySchema.defaults(),
})

const MAIN = 'scenes/main.scene.json'
const DRONE = 'prefabs/drone.prefab.json'

const drone = {
  version: 1,
  root: {
    name: 'drone',
    components: { 'core/Transform': {}, 'save-test/Health': { current: 30, max: 30 } },
    children: [
      { name: 'rotor', components: { 'core/Transform': { translation: [0, 1, 0] } } },
      { name: 'light', components: { 'core/Transform': { translation: [0, -1, 0] } } },
    ],
  },
}

function mainScene(extra: SceneFile['entities'] = []): SceneFile {
  return {
    version: 1,
    entities: [
      {
        name: 'ship',
        components: {
          'core/Transform': { translation: [0, 0, 0] },
          'save-test/Health': { current: 100 },
          'save-test/Target': { entity: 'base' },
        },
        children: [
          { name: 'camera', components: { 'core/Transform': { translation: [0, 2, 8] } } },
        ],
      },
      { name: 'base', components: { 'core/Transform': { translation: [20, 0, 0] } } },
      { name: 'rock', components: { 'core/Transform': { translation: [5, 0, 5] } } },
      {
        name: 'guard',
        components: { 'scene/PrefabInstance': { prefab: { path: DRONE } } },
      },
      ...extra,
    ],
  }
}

interface Setup {
  app: App
  world: World
  files: Map<string, unknown>
}

async function game(
  options: { physics?: boolean; files?: Map<string, unknown>; thrust?: boolean } = {},
): Promise<Setup> {
  const app = new App({ seed: 7 }).addPlugin(TransformPlugin, ScenePlugin)
  if (options.physics) app.addPlugin(physics3dPlugin)
  if (options.thrust) app.addSystems(Update, thrustSystem)
  const storage = createMemoryStorage()
  app.addPlugin(savePlugin({ storage }))
  await app.init()
  const world = app.world
  const files = options.files ?? new Map<string, unknown>([[MAIN, mainScene()]])
  world.resource(SaveConfig).readScene = async (id) => structuredClone(files.get(id))
  registerPrefab(world, DRONE, drone)
  return { app, world, files }
}

async function start(s: Setup, scene = MAIN): Promise<void> {
  loadScene(s.world, structuredClone(s.files.get(scene)), { id: scene })
  await whenSceneReady(s.world, scene)
  s.app.update(1 / 60)
}

/**
 * The world as a save sees it, independent of entity ids: scene entities by path, others as their
 * component JSON, entity fields as the path (or "runtime") of what they point at.
 */
function snapshot(world: World): unknown {
  const keyOf = (e: unknown) =>
    typeof e === 'number' && world.isAlive(e)
      ? (world.tryGet(e as Entity, SceneMember)?.path ?? 'runtime')
      : e
  const byPath: Record<string, unknown> = {}
  const runtime: string[] = []
  for (const table of world.allTables()) {
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]! as Entity
      const out: Record<string, unknown> = {}
      for (const def of table.components) {
        if (!def.saved) continue
        const json = def.serialize(table.readComponent(def, row)) as Record<string, unknown>
        // An instance's state is its prefab plus the changes to what it generated.
        if (def === PrefabInstance) json.overrides = currentOverrides(world, e) as never
        for (const { name, field } of def.layout) {
          if (field.kind === 'entity') json[name] = keyOf(json[name])
          if (field.kind === 'list' && field.item?.kind === 'entity')
            json[name] = (json[name] as unknown[]).map(keyOf)
        }
        out[def.name] = json
      }
      const path = world.tryGet(e, SceneMember)?.path
      if (path) byPath[path] = out
      else runtime.push(JSON.stringify(out))
    }
  }
  return { byPath, runtime: runtime.sort() }
}

function at(world: World, path: string): Entity {
  const e = findEntityByPath(world, path)
  if (e === undefined) throw new Error(`no ${path}`)
  return e
}

describe('save and load', () => {
  it('restores the world as saved: a moved scene entity, a runtime prefab, a despawned entity', async () => {
    const s = await game()
    await start(s)
    const w = s.world
    // Play: move the ship, hurt it, despawn the rock, spawn drones and a waypoint.
    w.set(at(w, 'ship'), Transform, { translation: [10, 2, 0] })
    w.set(at(w, 'ship'), Health, { current: 40 })
    w.despawn(at(w, 'rock'))
    await loadPrefab(w, DRONE)
    const free = spawnPrefab(w, DRONE, { transform: { translation: [4, 0, 1] } })
    const docked = spawnPrefab(w, DRONE, { parent: at(w, 'base') })
    w.set(instanceEntities(w, free).get('rotor')!, Transform, { translation: [0, 3, 0] })
    w.despawn(instanceEntities(w, free).get('light')!)
    const waypoint = w.spawn(
      [Transform, { translation: [1, 2, 3] }],
      [Target, { entity: free, others: [docked, at(w, 'ship')] }],
    )
    w.add(at(w, 'ship'), Target, { entity: waypoint })
    w.spawn(Transform, NoSave)
    w.add(at(w, 'base'), Cache, { value: 3 })
    w.initResource(Inventory).items.push('crystal')
    w.resource(Inventory).gold = 12
    const loot = w.resource(GlobalRng).stream('save-test/loot')
    loot.float()
    s.app.update(1 / 60)

    const before = snapshot(w)
    const file = await saveGame(w, 'slot1', { meta: { label: 'Crash site' } })
    const lootNext = [loot.float(), loot.float()]

    const freeEntry = file.spawned.find((x) => x.prefab && x.parent === undefined)!
    const dockedEntry = file.spawned.find((x) => x.prefab && x.parent === 'base')!
    const waypointEntry = file.spawned.find((x) => !x.prefab)!
    expect(file.spawned).toHaveLength(3)
    expect(file.scenes[MAIN]!.removed).toEqual(['rock'])
    expect(file.scenes[MAIN]!.changed.ship).toMatchObject({
      'core/Transform': { translation: [10, 2, 0] },
      'save-test/Health': { current: 40 },
      'save-test/Target': { entity: waypointEntry.id },
    })
    // Only what changed: the untouched max and camera aren't in the save.
    expect(file.scenes[MAIN]!.changed.ship!['save-test/Health']).toEqual({ current: 40 })
    expect(file.scenes[MAIN]!.changed['ship/camera']).toBeUndefined()
    // save: false components aren't written.
    expect(file.scenes[MAIN]!.changed.base).toBeUndefined()
    expect(freeEntry.prefab).toEqual({ guid: expect.any(String), path: DRONE })
    expect(freeEntry.overrides).toEqual({
      rotor: { 'core/Transform': { translation: [0, 3, 0] } },
      light: null,
    })
    expect(dockedEntry.overrides).toBeUndefined()
    // Instances write only root fields that differ from the prefab (not its Health).
    expect(freeEntry.components).toEqual({ 'core/Transform': { translation: [4, 0, 1] } })
    expect(dockedEntry.components).toEqual({})
    expect(waypointEntry.components['save-test/Target']).toEqual({
      entity: freeEntry.id,
      others: [dockedEntry.id, 'ship'],
    })
    expect(file.resources['save-test/Inventory']).toEqual({ items: ['crystal'], gold: 12 })
    expect(Object.keys(file.rng)).toEqual(['core/GlobalRng', 'save-test/loot'])

    // Keep playing, then load.
    w.set(at(w, 'ship'), Transform, { translation: [-50, 0, 0] })
    w.despawn(free)
    w.despawn(waypoint)
    w.resource(Inventory).gold = 0
    s.app.update(1 / 60)
    const report = await loadGame(w, 'slot1')
    expect(report.warnings).toEqual([])
    expect(report.spawned).toBe(3)
    expect(snapshot(w)).toEqual(before)
    // Saving again right away writes the same thing.
    const again = captureGame(w, { meta: { label: 'Crash site' } })
    expect({ ...again, time: file.time }).toEqual(file)
    expect(findEntityByPath(w, 'rock')).toBeUndefined()
    expect(w.resource(Inventory)).toEqual({ items: ['crystal'], gold: 12 })
    // The loot stream continues where it was at save time.
    const stream = w.resource(GlobalRng).stream('save-test/loot')
    expect([stream.float(), stream.float()]).toEqual(lootNext)
    // Entity fields point at the new entities.
    const newFree = w.get(at(w, 'ship'), Target).entity!
    expect(w.get(newFree, Target).entity).not.toBeNull()
    expect(describeSave(await readSave(w, 'slot1'))).toMatchObject({
      meta: { label: 'Crash site' },
      spawned: { total: 3, prefabs: { [DRONE]: 2 }, entities: 1 },
      scenes: { [MAIN]: { removed: ['rock'] } },
    })
  })

  it('keeps saved changes and shows new authored entities when the scene file changed since', async () => {
    const s = await game()
    await start(s)
    const w = s.world
    w.set(at(w, 'ship'), Health, { current: 40 })
    w.set(at(w, 'rock'), Transform, { translation: [9, 9, 9] })
    await saveGame(w, 'slot1')
    // The designer adds a beacon, renames the rock, and moves the base.
    const edited = mainScene([
      { name: 'beacon', components: { 'core/Transform': { translation: [0, 9, 0] } } },
    ])
    edited.entities.find((e) => e.name === 'rock')!.name = 'boulder'
    edited.entities.find((e) => e.name === 'base')!.components!['core/Transform'] = {
      translation: [30, 0, 0],
    }
    s.files.set(MAIN, edited)
    const report = await loadGame(w, 'slot1')
    expect(w.get(at(w, 'ship'), Health).current).toBe(40)
    expect([...w.get(at(w, 'beacon'), Transform).translation]).toEqual([0, 9, 0])
    expect([...w.get(at(w, 'base'), Transform).translation]).toEqual([30, 0, 0])
    expect(findEntityByPath(w, 'boulder')).toBeDefined()
    expect(report.warnings.map((e) => [e.code, e.path])).toEqual([
      ['save/stale-entity', `/scenes/${MAIN.replaceAll('/', '~1')}/changed/rock`],
    ])
  })

  it('migrates component data saved at an older version', async () => {
    // Version 2 renamed hp to current.
    const Hull = defineComponent(
      'save-test/Hull',
      { current: t.f32({ default: 10 }), armor: t.f32() },
      {
        version: 2,
        migrate: (from, json) => {
          const { hp, ...rest } = json as { hp?: number }
          return from === 1 && hp !== undefined ? { ...rest, current: hp } : json
        },
      },
    )
    const s = await game()
    await start(s)
    const w = s.world
    const v1: SaveFile = {
      version: SAVE_VERSION,
      engine: '0.x',
      schemas: { 'save-test/Hull': 1 },
      time: { elapsed: 3, frame: 180 },
      scenes: {
        [MAIN]: { changed: { ship: { 'save-test/Hull': { hp: 7, armor: 2 } } }, removed: [] },
      },
      spawned: [{ id: '@0', components: { 'save-test/Hull': { hp: 4 } } }],
      resources: {},
      rng: {},
    }
    await writeSave(w, 'old', v1)
    const report = await loadGame(w, 'old')
    expect(report.warnings).toEqual([])
    expect(w.get(at(w, 'ship'), Hull)).toEqual({ current: 7, armor: 2 })
    const spawned = w
      .query({ with: [Hull], without: [SceneMember] })
      .tables.flatMap((tb) => [...tb.entities.slice(0, tb.count)])
    expect(spawned.map((e) => w.get(e as Entity, Hull))).toEqual([{ current: 4, armor: 0 }])
  })

  it('refuses saves from a newer format and reports empty slots', async () => {
    const s = await game()
    await start(s)
    await expect(loadGame(s.world, 'nothing')).rejects.toMatchObject({ code: 'save/not-found' })
    await s.world
      .resource(SaveConfig)
      .storage.write(
        'saves/future.json',
        new TextEncoder().encode(JSON.stringify({ version: 99, scenes: {}, spawned: [] })),
      )
    await expect(loadGame(s.world, 'future')).rejects.toMatchObject({
      code: 'save/version-mismatch',
    })
    await expect(saveGame(s.world, '../escape')).rejects.toMatchObject({ code: 'save/bad-slot' })
    await saveGame(s.world, 'b')
    await saveGame(s.world, 'a')
    expect((await listSaves(s.world)).map((x) => x.slot)).toEqual(['a', 'b', 'future'])
  })

  it('resumes physics bodies with their saved velocities', async () => {
    const files = new Map<string, unknown>([
      [
        MAIN,
        {
          version: 1,
          entities: [
            {
              name: 'box',
              components: {
                'core/Transform': { translation: [0, 10, 0] },
                'physics/RigidBody': { kind: 'dynamic', gravityScale: 0 },
                'physics/Collider': { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] },
                'physics/Velocity': {},
              },
            },
          ],
        },
      ],
    ])
    const s = await game({ physics: true, files })
    await start(s)
    const w = s.world
    const box = at(w, 'box')
    expect(w.has(box, RigidBody) && w.has(box, Collider)).toBe(true)
    // Throw it.
    w.set(box, Velocity, { linear: [6, 3, 0] })
    for (let i = 0; i < 20; i++) s.app.update(1 / 60)
    const savedAt = [...w.get(box, Transform).translation]
    expect(savedAt[0]).toBeGreaterThan(1)
    await saveGame(w, 'throw')
    for (let i = 0; i < 30; i++) s.app.update(1 / 60)
    const expected = [...w.get(at(w, 'box'), Transform).translation]
    await loadGame(w, 'throw')
    const loaded = at(w, 'box')
    expect([...w.get(loaded, Transform).translation]).toEqual(savedAt)
    expect(w.get(loaded, Velocity).linear[0]).toBeCloseTo(6, 3)
    for (let i = 0; i < 30; i++) s.app.update(1 / 60)
    const after = w.get(loaded, Transform).translation
    for (let k = 0; k < 3; k++) expect(after[k]).toBeCloseTo(expected[k]!, 3)
  })

  it('reparents scene entities and keeps NoSave entities through a load', async () => {
    const s = await game()
    await start(s)
    const w = s.world
    w.add(at(w, 'rock'), ChildOf, { parent: at(w, 'base') })
    const keep = w.spawn(Transform, NoSave)
    const file = await saveGame(w, 'slot1')
    expect(file.scenes[MAIN]!.changed.rock).toEqual({ 'core/ChildOf': { parent: 'base' } })
    await loadGame(w, 'slot1')
    expect(w.get(at(w, 'rock'), ChildOf).parent).toBe(at(w, 'base'))
    expect(w.isAlive(keep)).toBe(true)
  })

  it('publishes a JSON Schema that saves validate against', async () => {
    const { default: Ajv } = await import('ajv/dist/2020')
    const ajv = new Ajv({ strict: false })
    const validate = ajv.compile(saveJsonSchema())
    const s = await game()
    await start(s)
    await loadPrefab(s.world, DRONE)
    spawnPrefab(s.world, DRONE, { parent: at(s.world, 'base') })
    s.world.set(at(s.world, 'ship'), Health, { current: 1 })
    const file = captureGame(s.world)
    expect(validate(JSON.parse(JSON.stringify(file))), JSON.stringify(validate.errors)).toBe(true)
  })
})

// --- large worlds (spec 0040) --------------------------------------------------------------------

const Thrust = defineComponent('save-test/Thrust', { speed: t.f32() })

/** Flies Thrust entities along +x; recentering moves them between cells as they go. */
const thrustSystem = defineSystem({
  name: 'save-test/thrust',
  setup: (world: World) => ({
    q: world.query({ with: [Thrust, Transform] }),
    time: world.resource(Time),
  }),
  run: ({ q, time }) => {
    for (const table of q.tables) {
      const speed = table.column(Thrust, 'speed')
      const tr = table.column(Transform, 'translation')
      for (let i = 0; i < table.count; i++) {
        tr[i * 3] = tr[i * 3]! + speed[i]! * time.delta
        table.markChanged(Transform, i)
      }
    }
  },
})

const FAR = 500_000_000 // cells × 2000 m = 10¹² m

function gridScene(): SceneFile {
  return {
    version: 1,
    entities: [
      {
        name: 'system',
        components: { 'transform/Grid': { cellSize: 2000 } },
        children: [
          {
            name: 'ship',
            components: {
              'core/Transform': { translation: [10, 0, 0] },
              'transform/GridCell': { cell: [FAR, 0, 0] },
              'save-test/Thrust': { speed: 30_000 },
            },
            children: [
              {
                name: 'camera',
                components: {
                  'core/Transform': { translation: [0, 2, 8] },
                  'transform/FloatingOrigin': {},
                },
              },
            ],
          },
          {
            name: 'beacon',
            components: {
              'core/Transform': { translation: [3, 0, 0] },
              'transform/GridCell': { cell: [FAR + 20, 0, 0] },
            },
          },
        ],
      },
    ],
  }
}

/**
 * A hash of the world independent of entity ids: every saved component and GlobalTransform, scene
 * entities by path, runtime entities by content, entity fields as paths.
 */
function stateHash(world: World): string {
  const keyOf = (e: unknown) =>
    typeof e === 'number' && world.isAlive(e)
      ? (world.tryGet(e as Entity, SceneMember)?.path ?? 'runtime')
      : e
  const rows: string[] = []
  for (const table of world.allTables()) {
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]! as Entity
      const out: Record<string, unknown> = {}
      for (const def of table.components) {
        if (!def.saved && def !== GlobalTransform && def !== ChildOf) continue
        const json = def.serialize(table.readComponent(def, row)) as Record<string, unknown>
        if (def === ChildOf) json.parent = keyOf(json.parent)
        if (def === GlobalTransform) json.matrix = Array.from(world.get(e, GlobalTransform).matrix)
        out[def.name] = json
      }
      rows.push(JSON.stringify([world.tryGet(e, SceneMember)?.path ?? 'runtime', out]))
    }
  }
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}

describe('large-world saves (spec 0040)', () => {
  it('saves at 10¹² m and loads in a fresh world to the millimetre, with the same world hash', async () => {
    const files = new Map<string, unknown>([[MAIN, gridScene()]])
    const a = await game({ files, thrust: true })
    await start(a)
    const w = a.world
    const system = at(w, 'system')
    // A runtime probe placed by f64 position, 10¹² m + 1.2345 km out.
    const probe = w.spawn(Transform, [Thrust, { speed: -700 }])
    placeInGrid(w, probe, system, [1e12 + 1234.5, 17, -4])
    for (let i = 0; i < 30; i++) a.app.update(1 / 60)
    // The ship crossed cells on the way.
    expect(w.get(at(w, 'system/ship'), GridCell).cell[0]).toBeGreaterThan(FAR + 5)

    const file = captureGame(w)
    expect(file.scenes[MAIN]!.changed['system/ship']).toMatchObject({
      'transform/GridCell': { cell: [expect.any(Number), 0, 0] },
    })
    const saved = file.spawned.find((x) => x.components['save-test/Thrust'])!
    expect(saved.parent).toBe('system')
    expect(saved.components['transform/GridCell']).toEqual({ cell: [FAR, 0, 0] })
    const at64 = (world: World, path: string | Entity) => {
      const e = typeof path === 'number' ? path : at(world, path)
      return [...worldPosition64(world, e, new Float64Array(3), at(world, 'system'))]
    }
    const probeAt = (world: World) =>
      world.query({ with: [Thrust, GridCell], without: [SceneMember] }).entities()[0]!
    const shipBefore = at64(w, 'system/ship')
    const probeBefore = at64(w, probe)
    const originBefore = [...worldPosition64(w, at(w, 'system/beacon'), new Float64Array(3))]

    // Keep playing the run that never saved.
    for (let i = 0; i < 30; i++) a.app.update(1 / 60)
    const expected = stateHash(w)

    // A fresh world loads the save and plays the same frames.
    const b = await game({ files, thrust: true })
    await start(b)
    await loadGame(b.world, JSON.parse(JSON.stringify(file)))
    const shipAfter = at64(b.world, 'system/ship')
    const probeAfter = at64(b.world, probeAt(b.world))
    expect(shipAfter[0]).toBeGreaterThan(1e12)
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(shipAfter[k]! - shipBefore[k]!)).toBeLessThan(1e-3)
      expect(Math.abs(probeAfter[k]! - probeBefore[k]!)).toBeLessThan(1e-3)
    }
    // Where the beacon sits relative to the camera doesn't depend on where the origin was at save time.
    const originAfter = [
      ...worldPosition64(b.world, at(b.world, 'system/beacon'), new Float64Array(3)),
    ]
    for (let k = 0; k < 3; k++)
      expect(Math.abs(originAfter[k]! - originBefore[k]!)).toBeLessThan(1e-3)
    for (let i = 0; i < 30; i++) b.app.update(1 / 60)
    expect(stateHash(b.world)).toBe(expected)
  })
})
