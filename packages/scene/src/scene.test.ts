import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChildOf, defineComponent, t, vec3, World } from '@aethervtt/shard-core'
import { budget } from '@aethervtt/shard-core/test-env'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  AmbientLight,
  Camera3d,
  captureView,
  DirectionalLight,
  Exposure,
  ExposurePresets,
  forwardPlugin,
  LightPresets,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { Grid, GridCell, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import type { SceneFile } from './format'
import {
  findEntityByPath,
  loadScene,
  reloadScene,
  saveScene,
  stringifyScene,
  validateScene,
} from './scene'
import { sceneJsonSchema } from './schema'

/** A component with an entity reference, to test path resolution. */
const Follow = defineComponent('test/Follow', { target: t.entity, distance: t.f32({ default: 5 }) })

function world(): World {
  const w = new World()
  w.initResource(Meshes)
  w.initResource(Materials)
  w.initResource(AmbientLight)
  return w
}

const ship: SceneFile = {
  $schema: '../.shard/schemas/scene.schema.json',
  version: 1,
  assets: {
    hull: { type: 'Material', value: { baseColor: '#8a93a6', metallic: 1, roughness: 0.35 } },
    rock: { type: 'Mesh', procedural: 'sphere', params: { radius: 2, segments: 12 } },
  },
  resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 800 } },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'direct-sun' },
        'core/Transform': { rotationEuler: [-50, 30, 0] },
      },
    },
    {
      name: 'ship',
      components: {
        'core/Transform': { translation: [0, 2, 0] },
        'render/Mesh3d': { mesh: { path: 'procedural:box?x=4&y=1&z=8' } },
        'render/MeshMaterial': { material: { path: '#hull' } },
      },
      children: [
        {
          name: 'camera',
          components: {
            'render/Camera3d': { fovY: 70 },
            'render/Exposure': { ev100: 'sunny' },
            'core/Transform': { translation: [0, 3, 12] },
            'test/Follow': { target: 'ship' },
          },
        },
      ],
    },
    { name: 'rock', components: { 'render/Mesh3d': { mesh: { path: '#rock' } } } },
    {
      name: 'rock2',
      components: { 'render/Mesh3d': { mesh: { path: 'procedural:box?z=8&y=1&x=4' } } },
    },
  ],
}

describe('loading', () => {
  it('spawns hierarchy, resolves paths, presets, aliases, and assets', () => {
    const w = world()
    const { entities } = loadScene(w, ship)
    const sun = entities.get('sun')!
    const shipE = entities.get('ship')!
    const camera = entities.get('ship/camera')!
    expect(w.get(camera, ChildOf).parent).toBe(shipE)
    expect(w.get(sun, DirectionalLight).illuminance).toBe(LightPresets['direct-sun'])
    expect(w.get(camera, Exposure).ev100).toBeCloseTo(ExposurePresets.sunny)
    expect(w.get(camera, Follow).target).toBe(shipE)
    // rotationEuler [-50, 30, 0] rotates -Z (the light's forward) downward.
    const fwd = vec3.transformQuat([0, 0, 0], [0, 0, -1], w.get(sun, Transform).rotation)
    expect(fwd[1]).toBeLessThan(-0.5)
    // Scene material and procedural mesh resolved into the stores.
    const material = w.resource(Materials).get(w.get(shipE, MeshMaterial).material)!
    expect(material.value.metallic).toBe(1)
    // Equal procedural refs (param order aside) share one mesh, so they instance together.
    expect(w.get(entities.get('rock2')!, Mesh3d).mesh?.guid).toBe(w.get(shipE, Mesh3d).mesh?.guid)
    expect(w.resource(AmbientLight).brightness).toBe(800)
    expect(findEntityByPath(w, 'ship/camera')).toBe(camera)
  })

  it('adds required components with defaults', () => {
    const w = world()
    const { entities } = loadScene(w, ship)
    expect(w.has(entities.get('rock')!, Transform)).toBe(true)
  })

  it('refuses to load an invalid scene, reporting every error', () => {
    const w = world()
    expect(() =>
      loadScene(w, { version: 1, entities: [{ name: 'x', components: { 'core/Nope': {} } }] }),
    ).toThrow(
      expect.objectContaining({
        code: 'scene/invalid',
        details: [expect.objectContaining({ code: 'scene/unknown-component' })],
      }),
    )
    expect(w.entityCount).toBe(0)
  })
})

describe('validation', () => {
  const broken = {
    version: 1,
    assets: { bad: { type: 'Mesh', procedural: 'donut' } },
    entities: [
      {
        name: 'a',
        components: {
          'render/Camera3d': { fovY: 'wide', projection: 'fisheye' },
          'render/DirectionalLight': { illuminance: 'noon' },
          'core/GlobalTransform': {},
          'core/Transform': { rotation: [0, 0, 0, 1], rotationEuler: [0, 0, 0] },
          'test/Follow': { target: 'missing/entity' },
          'render/MeshMaterial': { material: { path: '#nope' } },
        },
      },
      { name: 'a', components: { 'render/Mesh3d': { mesh: { path: 'assets/ship.glb#Mesh0' } } } },
      { name: 'b', components: { 'render/Mesh3d': { mesh: { path: 'procedural:dodecahedron' } } } },
      { name: 'c', color: 'red' },
    ],
  }

  it('reports every error with a JSON pointer', () => {
    const errors = validateScene(world(), broken).map((e) => [e.code, e.path])
    expect(errors).toEqual(
      expect.arrayContaining([
        ['scene/unknown-procedural', '/assets/bad'],
        ['schema/type-mismatch', '/entities/0/components/render~1Camera3d/fovY'],
        ['schema/type-mismatch', '/entities/0/components/render~1Camera3d/projection'],
        ['schema/unknown-preset', '/entities/0/components/render~1DirectionalLight/illuminance'],
        ['scene/derived-component', '/entities/0/components/core~1GlobalTransform'],
        ['scene/conflicting-fields', '/entities/0/components/core~1Transform/rotationEuler'],
        ['scene/unknown-entity-path', '/entities/0/components/test~1Follow/target'],
        ['schema/asset-not-found', '/entities/0/components/render~1MeshMaterial/material'],
        ['scene/duplicate-name', '/entities/1/name'],
        ['schema/asset-not-found', '/entities/1/components/render~1Mesh3d/mesh'],
        ['scene/unknown-procedural', '/entities/2/components/render~1Mesh3d/mesh'],
        ['scene/unknown-field', '/entities/3/color'],
      ]),
    )
    expect(errors.length).toBe(12)
  })

  it('accepts the example scene', () => {
    expect(validateScene(world(), ship)).toEqual([])
  })

  it('the composed JSON Schema agrees with validation on schema-level fixtures', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const check = ajv.compile(sceneJsonSchema())
    const fixtures: [string, unknown][] = [
      ['example', ship],
      ['empty', { version: 1, entities: [] }],
      ['wrong version', { version: 2, entities: [] }],
      [
        'bad field type',
        {
          version: 1,
          entities: [{ name: 'x', components: { 'render/Camera3d': { fovY: 'wide' } } }],
        },
      ],
      [
        'preset name',
        {
          version: 1,
          entities: [
            { name: 'x', components: { 'render/DirectionalLight': { illuminance: 'overcast' } } },
          ],
        },
      ],
      [
        'unknown preset',
        {
          version: 1,
          entities: [
            { name: 'x', components: { 'render/DirectionalLight': { illuminance: 'noon' } } },
          ],
        },
      ],
      [
        'unknown component',
        { version: 1, entities: [{ name: 'x', components: { 'core/Nope': {} } }] },
      ],
      [
        'derived component',
        { version: 1, entities: [{ name: 'x', components: { 'core/GlobalTransform': {} } }] },
      ],
      [
        'both rotations',
        {
          version: 1,
          entities: [
            {
              name: 'x',
              components: {
                'core/Transform': { rotation: [0, 0, 0, 1], rotationEuler: [0, 0, 0] },
              },
            },
          ],
        },
      ],
      ['unknown entity field', { version: 1, entities: [{ name: 'x', color: 'red' }] }],
      ['missing name', { version: 1, entities: [{ components: {} }] }],
      ['slash in name', { version: 1, entities: [{ name: 'a/b' }] }],
      [
        'bad asset',
        { version: 1, assets: { m: { type: 'Mesh', procedural: 'donut' } }, entities: [] },
      ],
    ]
    for (const [label, fixture] of fixtures) {
      expect(check(fixture), label).toBe(validateScene(world(), fixture).length === 0)
    }
  })
})

describe('saving', () => {
  it('reproduces the file exactly when nothing changed', () => {
    const w = world()
    loadScene(w, ship)
    expect(stringifyScene(saveScene(w, 'main'))).toBe(stringifyScene(ship))
  })

  it('writes only what changed, keeping authored forms elsewhere', () => {
    const w = world()
    const { entities } = loadScene(w, ship)
    const camera = entities.get('ship/camera')!
    w.set(camera, Camera3d, { fovY: 50 })
    w.set(entities.get('ship')!, Transform, { translation: [1, 2, 3] })
    w.remove(entities.get('rock')!, Mesh3d)
    w.despawn(entities.get('rock2')!)
    const saved = saveScene(w, 'main')
    const cam = saved.entities[1]!.children![0]!.components!
    expect(cam['render/Camera3d']).toEqual({ fovY: 50 })
    expect(cam['render/Exposure']).toEqual({ ev100: 'sunny' }) // preset name kept
    expect(saved.entities[0]!.components!['core/Transform']).toEqual({
      rotationEuler: [-50, 30, 0],
    })
    expect(saved.entities[1]!.components!['core/Transform']).toEqual({ translation: [1, 2, 3] })
    expect(saved.entities[2]!.components).toEqual({}) // Mesh3d removed; untouched required parts omitted
    expect(saved.entities.map((e) => e.name)).toEqual(['sun', 'ship', 'rock'])
  })

  it('writes a changed rotation as a quaternion, replacing rotationEuler', () => {
    const w = world()
    const { entities } = loadScene(w, ship)
    w.set(entities.get('sun')!, Transform, { rotation: [0, 0, 0, 1] })
    expect(saveScene(w, 'main').entities[0]!.components!['core/Transform']).toEqual({
      rotation: [0, 0, 0, 1],
    })
  })
})

describe('large-world grids (spec 0040)', () => {
  const galaxy: SceneFile = {
    version: 1,
    entities: [
      {
        name: 'galaxy',
        components: { 'transform/Grid': { cellSize: 1e12 } },
        children: [
          {
            name: 'system',
            components: {
              'transform/Grid': { cellSize: 2000, hysteresis: 50 },
              'transform/GridCell': { cell: [2147483000, -2147483000, 7] },
            },
            children: [
              {
                name: 'ship',
                components: {
                  'core/Transform': { translation: [12.5, 0, -3] },
                  'transform/GridCell': { cell: [-2147483648, 0, 2147483647] },
                },
                children: [{ name: 'camera', components: { 'transform/FloatingOrigin': {} } }],
              },
            ],
          },
        ],
      },
    ],
  }

  it('round-trips cells near ±2³¹ and an f64 cell size exactly', () => {
    const w = world()
    expect(validateScene(w, galaxy)).toEqual([])
    const { entities } = loadScene(w, galaxy)
    expect(w.get(entities.get('galaxy')!, Grid).cellSize).toBe(1e12)
    expect(w.get(entities.get('galaxy/system')!, GridCell).cell).toEqual([
      2147483000, -2147483000, 7,
    ])
    expect(w.get(entities.get('galaxy/system/ship')!, GridCell).cell).toEqual([
      -2147483648, 0, 2147483647,
    ])
    expect(stringifyScene(saveScene(w, 'main'))).toBe(stringifyScene(galaxy))
    // A changed cell is written like any field.
    w.set(entities.get('galaxy/system/ship')!, GridCell, { cell: [5, 6, -2147483648] })
    const saved = saveScene(w, 'main')
    const ship = saved.entities[0]!.children![0]!.children![0]!.components!
    expect(ship['transform/GridCell']).toEqual({ cell: [5, 6, -2147483648] })
  })

  it('reports misplaced cells, absolute translations, and a second origin', () => {
    const bad: SceneFile = {
      version: 1,
      entities: [
        {
          name: 'system',
          components: { 'transform/Grid': { cellSize: 500 } },
          children: [
            // 10⁶ m written as a translation: should be a cell plus an offset.
            { name: 'moon', components: { 'core/Transform': { translation: [1e6, 0, 0] } } },
            { name: 'ok', components: { 'core/Transform': { translation: [-499, 0, 0] } } },
            {
              name: 'ship',
              components: { 'transform/GridCell': { cell: [1, 0, 0] } },
              children: [
                // A grandchild doesn't carry a cell.
                { name: 'turret', components: { 'transform/GridCell': { cell: [0, 0, 0] } } },
                { name: 'camera', components: { 'transform/FloatingOrigin': {} } },
              ],
            },
          ],
        },
        { name: 'stray', components: { 'transform/GridCell': { cell: [0, 0, 1] } } },
        { name: 'second', components: { 'transform/FloatingOrigin': {} } },
        { name: 'fraction', components: { 'transform/GridCell': { cell: [0.5, 0, 2 ** 31] } } },
      ],
    }
    const errors = validateScene(world(), bad).map((e) => [e.code, e.path])
    expect(errors).toHaveLength(7)
    expect(errors).toEqual(
      expect.arrayContaining([
        [
          'transform/translation-outside-cell',
          '/entities/0/children/0/components/core~1Transform/translation',
        ],
        [
          'transform/cell-outside-grid',
          '/entities/0/children/2/children/0/components/transform~1GridCell',
        ],
        ['transform/cell-outside-grid', '/entities/1/components/transform~1GridCell'],
        ['transform/multiple-origins', '/entities/2/components/transform~1FloatingOrigin'],
        ['schema/type-mismatch', '/entities/3/components/transform~1GridCell/cell/0'],
        ['schema/out-of-range', '/entities/3/components/transform~1GridCell/cell/2'],
        ['transform/cell-outside-grid', '/entities/3/components/transform~1GridCell'],
      ]),
    )
    expect(() => loadScene(world(), bad)).toThrow(/7 errors/)
  })
})

describe('reloading', () => {
  it('replaces the scene and leaves other entities alone', () => {
    const w = world()
    const bystander = w.spawn(Transform)
    loadScene(w, ship)
    const before = w.entityCount
    reloadScene(w, 'main', {
      version: 1,
      entities: [{ name: 'only', components: { 'core/Transform': {} } }],
    })
    expect(w.isAlive(bystander)).toBe(true)
    expect(findEntityByPath(w, 'ship')).toBeUndefined()
    expect(findEntityByPath(w, 'only')).toBeDefined()
    expect(w.entityCount).toBeLessThan(before)
  })
})

describe('performance', () => {
  it('loads 10k entities in under 100 ms', () => {
    const file: SceneFile = {
      version: 1,
      assets: { gray: { type: 'Material', value: { baseColor: '#777777' } } },
      entities: Array.from({ length: 10_000 }, (_, i) => ({
        name: `cube-${i}`,
        components: {
          'core/Transform': { translation: [i % 100, 0, Math.floor(i / 100)] },
          'render/Mesh3d': { mesh: { path: 'procedural:cube?size=0.5' } },
          'render/MeshMaterial': { material: { path: '#gray' } },
        },
      })),
    }
    loadScene(world(), file, { id: 'warmup' })
    // Best of three: the budget is for the load, not for other test processes sharing the CPU.
    let ms = Infinity
    for (let run = 0; run < 3; run++) {
      const w = world()
      const start = performance.now()
      loadScene(w, file)
      ms = Math.min(ms, performance.now() - start)
      expect(w.entityCount).toBe(10_000)
    }
    expect(ms).toBeLessThan(budget(100))
  })
})

describe('rendering', () => {
  it('renders a scene as authored (golden image)', async () => {
    const gpu = await createNodeGpuContext()
    const target = new OffscreenTarget(gpu, { label: 'scene-golden', width: 64, height: 64 })
    const app = new App().addPlugin(TransformPlugin, renderPlugin({ gpu, target }), forwardPlugin())
    await app.init()
    const { entities } = loadScene(app.world, {
      version: 1,
      assets: {
        hull: { type: 'Material', value: { baseColor: '#c0392b', roughness: 0.4 } },
        ground: { type: 'Material', value: { baseColor: '#5d6d7e', roughness: 0.9 } },
      },
      resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 1000 } },
      entities: [
        {
          name: 'sun',
          components: {
            'render/DirectionalLight': { illuminance: 'daylight' },
            'core/Transform': { rotationEuler: [-50, 30, 0] },
          },
        },
        {
          name: 'ground',
          components: {
            'core/Transform': { translation: [0, -1, 0] },
            'render/Mesh3d': { mesh: { path: 'procedural:plane?size=20' } },
            'render/MeshMaterial': { material: { path: '#ground' } },
          },
        },
        {
          name: 'ship',
          components: {
            'core/Transform': { rotationEuler: [0, 35, 0] },
            'render/Mesh3d': { mesh: { path: 'procedural:box?x=1.5&y=0.6&z=3' } },
            'render/MeshMaterial': { material: { path: '#hull' } },
          },
          children: [
            {
              name: 'dome',
              components: {
                'core/Transform': { translation: [0, 0.4, 0.4] },
                'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=0.4' } },
              },
            },
            {
              name: 'camera',
              components: {
                'render/Camera3d': { fovY: 60 },
                'core/Transform': { translation: [0, 2, 6], rotationEuler: [-15, 0, 0] },
              },
            },
          ],
        },
      ],
    })
    expect(entities.size).toBe(5)
    for (let i = 0; i < 40; i++) {
      app.update(1 / 60)
      await app.world.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
    }
    const shot = captureView(app.world, `camera:${entities.get('ship/camera')}`)
    app.update(1 / 60)
    const image = await shot

    const golden = join(
      dirname(fileURLToPath(import.meta.url)),
      '__golden__',
      'authored-scene.rgba',
    )
    if (!existsSync(golden)) {
      mkdirSync(dirname(golden), { recursive: true })
      writeFileSync(golden, image.data)
      console.warn(`Wrote new golden image: ${golden}`)
    }
    const expected = new Uint8Array(readFileSync(golden))
    let sum = 0
    for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i]! - image.data[i]!)
    expect(sum / expected.length).toBeLessThan(1.5)
    gpu.destroy()
  })
})
