import {
  defineComponent,
  defineSystem,
  quat,
  Rng,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { MaterialAsset, Materials, Meshes } from './assets'
import { PhysicalCamera } from './camera'
import { DefaultEnvironment } from './environment'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import {
  Antialiasing,
  AutoExposure,
  Bloom,
  ColorGrading,
  DepthOfField,
  Fog,
  MotionBlur,
  Ssao,
  Vignette,
} from './post'

// The post stack's courtyard (`@aethervtt/shard-render/post-scene`): blocks and spheres, neon
// panels, balls orbiting for motion blur and TAA, fog toward the horizon, under a shadowed sun. The
// playground's #post page and 0075's `post-stack` scenario test both build it, with
// `postScenePlugin` moving the balls. Nothing here registers on import.

/** Each post effect's component and settings, by the name `?effects=` uses. */
export const POST_EFFECTS = {
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

export type PostEffectName = keyof typeof POST_EFFECTS

/** The full stack: every effect but the other anti-aliasing modes (TAA is on). */
export const ALL_POST_EFFECTS: readonly PostEffectName[] = (
  Object.keys(POST_EFFECTS) as PostEffectName[]
).filter((n) => n !== 'fxaa' && n !== 'noaa')

/** The components for effect names; unknown names are skipped. */
export function postEffects(names: readonly string[]): unknown[] {
  return names
    .map((n) => POST_EFFECTS[n as PostEffectName])
    .filter((e): e is (typeof POST_EFFECTS)[PostEffectName] => e !== undefined)
}

/** A ball on a circle round the courtyard. */
export const PostSpin = defineComponent('render/PostSpin', {
  radius: t.f32,
  speed: t.f32,
  height: t.f32,
})

/** Moves PostSpin balls along their circles by `Time.elapsed`. */
export const postSpin = defineSystem({
  name: 'render/post-spin',
  setup: (world) => ({ q: world.query({ with: [PostSpin, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time).elapsed
    for (const table of q.tables) {
      const r = table.column(PostSpin, 'radius')
      const s = table.column(PostSpin, 'speed')
      const h = table.column(PostSpin, 'height')
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

/** The courtyard's moving parts: PostSpin and its system. Add it with the render plugins. */
export const postScenePlugin = definePlugin({
  name: 'render/post-scene',
  dependencies: ['render'],
  provides: [PostSpin],
  build(app) {
    app.addSystems(Update, postSpin)
  },
})

/** Where the courtyard is looked at from: 9 m out, 2.2 m up. */
export const POST_EYE: [number, number, number] = [0, 2.2, 9]
export const POST_TARGET: [number, number, number] = [0, 1.2, -2]

/**
 * The `post-stack` camera path: from POST_EYE, swinging 30° either side of the courtyard's axis
 * once every 20 s and drifting 1.5 m in and out, always looking at POST_TARGET. `seconds` along it.
 */
export function postCamera(seconds: number): {
  eye: [number, number, number]
  target: [number, number, number]
} {
  const [tx, ty, tz] = POST_TARGET
  const dx = POST_EYE[0] - tx
  const dy = POST_EYE[1] - ty
  const dz = POST_EYE[2] - tz
  const flat = Math.sqrt(dx * dx + dz * dz)
  const yaw = Math.atan2(dx, dz) + (Math.PI / 6) * Math.sin((seconds * 2 * Math.PI) / 20)
  const distance = flat + 1.5 * Math.sin((seconds * 2 * Math.PI) / 13)
  return {
    eye: [tx + Math.sin(yaw) * distance, ty + dy, tz + Math.cos(yaw) * distance],
    target: [tx, ty, tz],
  }
}

/** The camera's lens: a physical exposure, so auto exposure and DoF read real values. */
export const POST_LENS = [
  PhysicalCamera,
  { aperture: 5.6, shutterSpeed: 1 / 1000, iso: 100 },
] as const

/** The courtyard, its sun and sky; the camera is the caller's. */
export function spawnPostScene(world: World): void {
  world.resource(DefaultEnvironment).sky = { turbidity: 2.5 }
  world.spawn(
    [DirectionalLight, { illuminance: 100_000, shadows: true }],
    [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.5, 0.9, 0) as never }],
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
      [PostSpin, { radius: 3 + i, speed: 1.2 - i * 0.2, height: 0.6 + i * 0.3 }],
      Transform,
    )
  }
}
