import {
  defineComponent,
  defineSystem,
  ProfilerResource,
  quat,
  t,
  Update,
} from '@aethervtt/shard-core'
import { cube, plane, sphere, torus } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Gpu,
  LightPresets,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  RenderStats,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { backendLine, healthLines } from './backend'
import { orbitFrom } from './camera'

/** Marks the hero objects that spin. */
const Spin = defineComponent('scene/Spin', { speed: t.f32({ default: 1 }) })
/** Marks the grid cubes, with their grid position for the wave. */
const Wave = defineComponent('scene/Wave', { x: t.f32, z: t.f32 })

const GRID = 100

const spin = defineSystem({
  name: 'scene/spin',
  setup: (world) => ({ q: world.query({ with: [Spin, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time).elapsed
    for (const table of q.tables) {
      const speed = table.column(Spin, 'speed')
      const rot = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        quat.fromEuler(rot.subarray(i * 4, i * 4 + 4), time * 0.7 * speed[i]!, time * speed[i]!, 0)
      }
      table.markChanged(Transform)
    }
  },
})

/** 10k cubes bobbing in a wave: exercises transform propagation, culling, and instancing. */
const wave = defineSystem({
  name: 'scene/wave',
  setup: (world) => ({ q: world.query({ with: [Wave, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time).elapsed
    for (const table of q.tables) {
      const x = table.column(Wave, 'x')
      const z = table.column(Wave, 'z')
      const tr = table.column(Transform, 'translation')
      for (let i = 0; i < table.count; i++) {
        const d = Math.sqrt(x[i]! * x[i]! + z[i]! * z[i]!)
        tr[i * 3 + 1] = -1.2 + Math.sin(d * 0.35 - time * 2) * 0.35
      }
      table.markChanged(Transform)
    }
  },
})

const hud = defineSystem({
  name: 'scene/hud',
  setup: () => ({ el: document.getElementById('hud') as HTMLElement, last: 0, frames: 0 }),
  run: (state, world) => {
    state.frames++
    const time = world.resource(Time).elapsed
    if (time - state.last < 0.25) return
    const fps = state.frames / (time - state.last)
    state.last = time
    state.frames = 0
    const [view, stats] = [...world.resource(RenderStats)][0] ?? ['none', undefined]
    const timings = world.resource(ProfilerResource).all()
    const rows = Object.entries(timings)
      .filter(([name]) => !name.startsWith('scene/hud'))
      .sort((a, b) => b[1].avg - a[1].avg)
      .slice(0, 8)
      .map(([name, t]) => `${name.padEnd(28)} ${t.avg.toFixed(2).padStart(6)} ms`)
    state.el.textContent = [
      `entities  ${world.entityCount.toLocaleString()}`,
      `fps       ${fps.toFixed(0)}`,
      backendLine(world.resource(Gpu)),
      ...healthLines(world),
      stats
        ? `${view}: ${stats.visible} visible, ${stats.culled} culled, ${stats.drawCalls} draws`
        : 'no camera view',
      '',
      ...rows,
    ].join('\n')
  },
})

export const scenePlugin = definePlugin({
  name: 'scene',
  dependencies: ['render/forward'],
  build(app) {
    app.addSystems(Update, spin, wave, hud)
  },
  ready(app) {
    const world = app.world
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) =>
      materials.add(new MaterialAsset(value))

    // Fill light. Metals stay dark until image-based lighting (M5) gives them something to reflect.
    world.resource(AmbientLight).brightness = 500
    world.spawn(
      [DirectionalLight, { illuminance: LightPresets.daylight }],
      [
        Transform,
        {
          rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.6, 0) as [number, number, number, number],
        },
      ],
    )
    world.spawn(Camera3d, Transform, orbitFrom([0, 7, 16], [0, 0, 0]))

    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 80 })) }],
      [MeshMaterial, { material: mat({ baseColor: [0.35, 0.36, 0.4, 1], roughness: 0.9 }) }],
      [Transform, { translation: [0, -2, 0] }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(cube({ size: 2 })) }],
      [MeshMaterial, { material: mat({ baseColor: [0.9, 0.2, 0.15, 1], roughness: 0.35 }) }],
      [Transform, { translation: [0, 1.5, 0] }],
      Spin,
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 1, segments: 48 })) }],
      [MeshMaterial, { material: mat({ baseColor: [0.95, 0.75, 0.3, 1], roughness: 0.2 }) }],
      [Transform, { translation: [-4, 1.2, 0] }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(torus({ radius: 0.9, tube: 0.3 })) }],
      [
        MeshMaterial,
        {
          material: mat({
            baseColor: [0.2, 0.5, 0.95, 1],
            roughness: 0.5,
            emissive: [0.2, 0.5, 1, 1],
            emissiveLuminance: 200,
          }),
        },
      ],
      [Transform, { translation: [4, 1.2, 0] }],
      [Spin, { speed: 0.6 }],
    )

    const small = meshes.add(cube({ size: 0.18 }))
    const colors = [
      mat({ baseColor: [0.25, 0.7, 0.45, 1], roughness: 0.6 }),
      mat({ baseColor: [0.9, 0.9, 0.92, 1], roughness: 0.4 }),
    ]
    for (let i = 0; i < GRID * GRID; i++) {
      const x = (i % GRID) - GRID / 2
      const z = Math.floor(i / GRID) - GRID / 2
      world.spawn(
        [Mesh3d, { mesh: small }],
        [MeshMaterial, { material: colors[(i + Math.floor(i / GRID)) % 2]! }],
        [Transform, { translation: [x * 0.3, -1.2, z * 0.3 - 4] }],
        [Wave, { x, z }],
      )
    }
  },
})
