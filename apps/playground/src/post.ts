import { defineComponent, defineSystem, quat, Rng, t, Update } from '@shard/core'
import { cube, plane, sphere } from '@shard/mesh'
import {
  Antialiasing,
  AutoExposure,
  Bloom,
  Camera3d,
  ColorGrading,
  DefaultEnvironment,
  DepthOfField,
  DirectionalLight,
  Fog,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  MotionBlur,
  PhysicalCamera,
  Ssao,
  Vignette,
} from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import { lookAt, Transform } from '@shard/transform'

const Spin = defineComponent('playground/Spin', { radius: t.f32, speed: t.f32, height: t.f32 })

const spin = defineSystem({
  name: 'post-demo/spin',
  setup: (world) => ({ q: world.query({ with: [Spin, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time).elapsed
    for (const table of q.tables) {
      const r = table.column(Spin, 'radius')
      const s = table.column(Spin, 'speed')
      const h = table.column(Spin, 'height')
      const tr = table.column(Transform, 'translation')
      for (let i = 0; i < table.count; i++) {
        const a = time * s[i]!
        tr[i * 3] = Math.cos(a) * r[i]!
        tr[i * 3 + 1] = h[i]!
        tr[i * 3 + 2] = Math.sin(a) * r[i]! - 4
      }
      table.markChanged(Transform)
    }
  },
})

/** Components for `?effects=a,b` (default: all), by name. */
export const EFFECTS = {
  bloom: [Bloom, { intensity: 0.12 }],
  exposure: [AutoExposure, { compensation: 0.5 }],
  dof: [DepthOfField, { focusDistance: 9, maxBlur: 0.012 }],
  'motion-blur': [MotionBlur, {}],
  taa: [Antialiasing, { mode: 'taa' }],
  fxaa: [Antialiasing, { mode: 'fxaa' }],
  noaa: [Antialiasing, { mode: 'none' }],
  ssao: [Ssao, { radius: 0.6 }],
  fog: [Fog, { density: 0.015, heightFalloff: 0.08, sunScattering: 0.6 }],
  grading: [ColorGrading, { temperature: 0.1, saturation: 1.1, contrast: 1.05 }],
  vignette: [Vignette, { intensity: 0.25 }],
} as const

/** The components `?effects=` names (default: every effect but FXAA). */
export function effectsFromUrl(): unknown[] {
  const param = new URLSearchParams(location.search).get('effects')
  const names =
    param === null
      ? Object.keys(EFFECTS).filter((n) => n !== 'fxaa' && n !== 'noaa')
      : param.split(',')
  return names.map((n) => EFFECTS[n as keyof typeof EFFECTS]).filter((e) => e !== undefined)
}

/**
 * Every post effect on a sunlit courtyard: blocks and spheres, neon panels, orbiting balls for
 * motion blur and TAA, fog toward the horizon. `?effects=bloom,fog` picks effects (default: all
 * but fxaa); `noaa` turns MSAA off, for a baseline to measure against.
 */
export const postPlugin = definePlugin({
  name: 'post-demo',
  dependencies: ['render/forward'],
  build(app) {
    app.addSystems(Update, spin)
  },
  ready(app) {
    const world = app.world
    const effects = effectsFromUrl()
    world.resource(DefaultEnvironment).sky = { turbidity: 2.5 }
    world.spawn(
      [DirectionalLight, { illuminance: 100_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.5, 0.9, 0) as never }],
    )
    const eye: [number, number, number] = [0, 2.2, 9]
    world.spawn(
      [Camera3d, { fovY: 50 }],
      [PhysicalCamera, { aperture: 5.6, shutterSpeed: 1 / 1000, iso: 100 }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 1.2, -2]) }],
      ...(effects as unknown as []),
    )
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const mat = (v: ConstructorParameters<typeof MaterialAsset>[0]) =>
      materials.add(new MaterialAsset(v))
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 400 })) }],
      [MeshMaterial, { material: mat({ baseColor: [0.35, 0.33, 0.3, 1], roughness: 0.9 }) }],
      Transform,
    )
    const block = meshes.add(cube({ size: 1 }))
    const ball = meshes.add(sphere({ radius: 0.5, segments: 40 }))
    const rng = new Rng(4)
    const stone = [
      mat({ baseColor: [0.7, 0.68, 0.64, 1], roughness: 0.7 }),
      mat({ baseColor: [0.55, 0.3, 0.22, 1], roughness: 0.8 }),
      mat({ baseColor: [0.9, 0.8, 0.55, 1], metallic: 1, roughness: 0.3 }),
    ]
    for (let i = 0; i < 60; i++) {
      const size = rng.range(0.6, 2.2)
      world.spawn(
        [Mesh3d, { mesh: i % 3 === 2 ? ball : block }],
        [MeshMaterial, { material: stone[i % 3]! }],
        [
          Transform,
          {
            translation: [rng.range(-14, 14), size / 2, rng.range(-30, 2)],
            rotation: quat.fromEuler([0, 0, 0, 1], 0, rng.float() * 6, 0) as never,
            scale: [size, size * rng.range(0.6, 2.4), size],
          },
        ],
      )
    }
    // Neon panels in the shade: bloom's subject.
    const neon = (c: [number, number, number, number]) =>
      mat({ baseColor: [0, 0, 0, 1], emissive: c, emissiveLuminance: 400_000 })
    const panels = [neon([1, 0.2, 0.6, 1]), neon([0.2, 0.8, 1, 1]), neon([1, 0.7, 0.2, 1])]
    for (let i = 0; i < 3; i++) {
      world.spawn(
        [Mesh3d, { mesh: block }],
        [MeshMaterial, { material: panels[i]! }],
        [Transform, { translation: [(i - 1) * 3, 2.5, -5], scale: [2, 0.15, 0.1] }],
      )
    }
    for (let i = 0; i < 4; i++) {
      world.spawn(
        [Mesh3d, { mesh: ball }],
        [MeshMaterial, { material: stone[2]! }],
        [Spin, { radius: 3 + i, speed: 1.2 - i * 0.2, height: 0.6 + i * 0.3 }],
        Transform,
      )
    }
  },
})
