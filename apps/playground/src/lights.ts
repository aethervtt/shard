import { defineComponent, defineSystem, quat, Rng, t, Update } from '@shard/core'
import { cube, plane, sphere } from '@shard/mesh'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  PointLight,
} from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import { lookAt, Transform } from '@shard/transform'

/** Lights that circle the hall. */
const Orbit = defineComponent('lights-demo/Orbit', {
  radius: t.f32,
  speed: t.f32,
  phase: t.f32,
  height: t.f32,
})

const orbit = defineSystem({
  name: 'lights-demo/orbit',
  setup: (world) => ({ q: world.query({ with: [Orbit, Transform] }) }),
  run: ({ q }, world) => {
    const time = world.resource(Time).elapsed
    for (const table of q.tables) {
      const r = table.column(Orbit, 'radius')
      const s = table.column(Orbit, 'speed')
      const p = table.column(Orbit, 'phase')
      const h = table.column(Orbit, 'height')
      const tr = table.column(Transform, 'translation')
      for (let i = 0; i < table.count; i++) {
        const a = p[i]! + time * s[i]!
        tr[i * 3] = Math.cos(a) * r[i]!
        tr[i * 3 + 1] = h[i]! + Math.sin(a * 3) * 0.3
        tr[i * 3 + 2] = Math.sin(a) * r[i]! - 6
      }
      table.markChanged(Transform)
    }
  },
})

/** A hall of pillars lit by 256 moving point lights (4 with shadows) under a shadowed moon. */
export const lightsPlugin = definePlugin({
  name: 'lights-demo',
  dependencies: ['render/forward'],
  build(app) {
    app.addSystems(Update, orbit)
  },
  ready(app) {
    const world = app.world
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const mat = (value: ConstructorParameters<typeof MaterialAsset>[0]) =>
      materials.add(new MaterialAsset(value))
    world.resource(AmbientLight).brightness = 0.02
    world.spawn(
      [DirectionalLight, { illuminance: 0.3, color: [0.6, 0.7, 1, 1], shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -1.0, 0.7, 0) as never }],
    )
    world.spawn(
      [Camera3d, { fovY: 55, clearColor: [0.0005, 0.0006, 0.001, 1] }],
      [Exposure, { ev100: 3 }],
      [Transform, { translation: [0, 7, 14], rotation: lookAt([0, 7, 14], [0, 0, -6]) }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 80 })) }],
      [MeshMaterial, { material: mat({ baseColor: [0.5, 0.5, 0.52, 1], roughness: 0.35 }) }],
      Transform,
    )
    const pillar = meshes.add(cube({ size: 1 }))
    const stone = mat({ baseColor: [0.7, 0.66, 0.6, 1], roughness: 0.6 })
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        if ((x + z) % 2 !== 0) continue
        world.spawn(
          [Mesh3d, { mesh: pillar }],
          [MeshMaterial, { material: stone }],
          [Transform, { translation: [x * 3, 1.5, z * 3 - 6], scale: [0.6, 3, 0.6] }],
        )
      }
    }
    const ball = meshes.add(sphere({ radius: 0.9, segments: 32 }))
    const chrome = mat({ baseColor: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0.15 })
    world.spawn(
      [Mesh3d, { mesh: ball }],
      [MeshMaterial, { material: chrome }],
      [Transform, { translation: [0, 0.9, -6] }],
    )
    const rng = new Rng(11)
    const bulb = meshes.add(sphere({ radius: 0.06, segments: 8 }))
    for (let i = 0; i < 256; i++) {
      const hue = rng.float()
      const color: [number, number, number, number] = [
        0.5 + 0.5 * Math.cos(6.283 * hue),
        0.5 + 0.5 * Math.cos(6.283 * (hue - 0.33)),
        0.5 + 0.5 * Math.cos(6.283 * (hue - 0.67)),
        1,
      ]
      const shadows = i < 4
      world.spawn(
        [
          PointLight,
          { intensity: shadows ? 1500 : 250, range: shadows ? 10 : 3.5, color, shadows },
        ],
        [Mesh3d, { mesh: bulb }],
        NotShadowCaster,
        [
          MeshMaterial,
          { material: mat({ baseColor: [0, 0, 0, 1], emissive: color, emissiveLuminance: 400 }) },
        ],
        [
          Orbit,
          {
            radius: rng.range(2, 14),
            speed: rng.range(-0.4, 0.4),
            phase: rng.range(0, 6.283),
            height: rng.range(0.3, 2.5),
          },
        ],
        Transform,
      )
    }
  },
})
