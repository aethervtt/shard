import { defineSystem, quat, Update } from '@aethervtt/shard-core'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  DefaultEnvironment,
  DirectionalLight,
  EnvironmentMap,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  Skybox,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { Texture, Textures, toHalf } from '@aethervtt/shard-texture'
import { lookAt, Transform } from '@aethervtt/shard-transform'

/** A 2048×1024 studio environment made in code: sky gradient, a key light, two colored panels. */
function studioTexture(width = 2048, height = 1024): Texture {
  const f = new Float32Array(width * height * 4)
  for (let j = 0; j < height; j++) {
    const theta = ((j + 0.5) / height) * Math.PI
    for (let i = 0; i < width; i++) {
      const phi = ((i + 0.5) / width - 0.5) * 2 * Math.PI
      const x = Math.sin(theta) * Math.cos(phi)
      const z = Math.sin(theta) * Math.sin(phi)
      const y = Math.cos(theta)
      let c = y < 0 ? [0.08, 0.06, 0.05] : [0.25 + 0.3 * y, 0.35 + 0.35 * y, 0.6 + 0.4 * y]
      if (x * 0.55 + y * 0.64 + z * 0.53 > 0.985) c = [80, 76, 68]
      if (Math.abs(x - 0.9) < 0.1 && y < 0.4 && y > -0.1) c = [3, 0.4, 0.2]
      if (Math.abs(x + 0.9) < 0.1 && y < 0.4 && y > -0.1) c = [0.2, 1.5, 3]
      const o = (j * width + i) * 4
      f[o] = c[0]!
      f[o + 1] = c[1]!
      f[o + 2] = c[2]!
      f[o + 3] = 1
    }
  }
  return Texture.create({
    width,
    height,
    format: 'rgba16float',
    usage: 'hdr',
    mips: [new Uint8Array(toHalf(f).buffer)],
  })
}

function spheres(world: import('@aethervtt/shard-core').World) {
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const ball = meshes.add(sphere({ radius: 0.42, segments: 48 }))
  for (let m = 0; m < 2; m++) {
    for (let r = 0; r < 6; r++) {
      const material = materials.add(
        new MaterialAsset({
          baseColor: m ? [0.95, 0.75, 0.4, 1] : [0.8, 0.1, 0.1, 1],
          metallic: m,
          roughness: 0.05 + r * 0.19,
        }),
      )
      world.spawn(
        [Mesh3d, { mesh: ball }],
        [MeshMaterial, { material }],
        [Transform, { translation: [(r - 2.5) * 1, m ? 0.5 : 1.5, 0] }],
      )
    }
  }
}

/** Spheres under a 2048×1024 HDR environment; the HUD shows gpu:environment/prefilter. */
let studio: { guid: string | undefined } | undefined

const refresh = defineSystem({
  name: 'ibl-demo/refresh',
  setup: () => ({ last: 0 }),
  run: (state, w) => {
    // Re-prefilter every two seconds, so the timing stays on the HUD.
    const t = w.resource(Time).elapsed
    if (t - state.last < 2 || !studio) return
    state.last = t
    const tex = w.resource(Textures).get(studio)
    if (tex) tex.version++
  },
})

export const iblPlugin = definePlugin({
  name: 'ibl-demo',
  dependencies: ['render/forward'],
  build(app) {
    app.addSystems(Update, refresh)
  },
  ready(app) {
    const world = app.world
    const texture = world.resource(Textures).add(studioTexture())
    studio = texture
    world.spawn(
      [Camera3d, { fovY: 40 }],
      [Exposure, { ev100: 10.5 }],
      [EnvironmentMap, { texture, intensity: 1000 }],
      Skybox,
      [Transform, { translation: [0, 1, 6], rotation: lookAt([0, 1, 6], [0, 1, 0]) }],
    )
    spheres(world)
  },
})

/** A procedural sky through a day: the sun rises, crosses, and sets; shadows and IBL follow. */
let sunEntity = -1
let cameraEntity = -1

const day = defineSystem({
  name: 'sky-demo/day',
  run: (_, w) => {
    if (sunEntity < 0) return
    // A 40-second day: elevation from -8° to 70° and back.
    const t = w.resource(Time).elapsed
    const phase = (t / 40) * Math.PI * 2
    const elevation = -8 + 78 * Math.max(0, Math.sin(phase)) ** 0.8
    const e = (elevation * Math.PI) / 180
    w.set(sunEntity, Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -e, 0.8, 0) as never })
    // A matched exposure, so the day doesn't blow out or go black.
    const ev = elevation > 20 ? 14 : elevation > 0 ? 9 + elevation / 4 : 6 + elevation / 4
    w.set(cameraEntity, Exposure, { ev100: ev })
  },
})

export const skyPlugin = definePlugin({
  name: 'sky-demo',
  dependencies: ['render/forward'],
  build(app) {
    app.addSystems(Update, day)
  },
  ready(app) {
    const world = app.world
    world.resource(DefaultEnvironment).sky = { turbidity: 2.5 }
    const sun = world.spawn([DirectionalLight, { illuminance: 100_000, shadows: true }], Transform)
    const cam = world.spawn(
      [Camera3d, { fovY: 55 }],
      [Exposure, { ev100: 13 }],
      [Transform, { translation: [0, 2.5, 9], rotation: lookAt([0, 2.5, 9], [0, 1.5, 0]) }],
    )
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 400 })) }],
      [
        MeshMaterial,
        {
          material: materials.add(
            new MaterialAsset({ baseColor: [0.35, 0.33, 0.3, 1], roughness: 0.9 }),
          ),
        },
      ],
      Transform,
    )
    const block = meshes.add(cube({ size: 1 }))
    const concrete = materials.add(
      new MaterialAsset({ baseColor: [0.7, 0.68, 0.64, 1], roughness: 0.7 }),
    )
    for (let i = 0; i < 7; i++) {
      world.spawn(
        [Mesh3d, { mesh: block }],
        [MeshMaterial, { material: concrete }],
        [
          Transform,
          {
            translation: [(i - 3) * 2.2, 1 + (i % 3) * 0.6, -2 - (i % 2) * 2],
            scale: [0.8, 2 + (i % 3) * 1.2, 0.8],
          },
        ],
      )
    }
    spheres(world)
    sunEntity = sun
    cameraEntity = cam
  },
})
