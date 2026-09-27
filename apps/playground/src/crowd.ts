import { defineSystem, quat, Rng, Update } from '@aethervtt/shard-core'
import {
  box,
  capsule,
  cone,
  cylinder,
  type Mesh,
  plane,
  sphere,
  torus,
} from '@aethervtt/shard-mesh'
import {
  Camera3d,
  DirectionalLight,
  Exposure,
  Lod,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  VisibilityRange,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { effectsFromUrl } from './post'

const still = new URLSearchParams(location.search).has('still')

const orbit = defineSystem({
  name: 'playground/crowd-orbit',
  setup: (world) => ({ q: world.query({ with: [Camera3d, Transform] }) }),
  run: ({ q }, world) => {
    // `?still` holds the camera, for steady frame times to measure against.
    const t = still ? 0.6 : world.resource(Time).elapsed * 0.05
    const eye: [number, number, number] = [Math.sin(t) * 160, 40, Math.cos(t) * 160]
    const rotation = lookAt(eye, [0, 0, 0])
    for (const table of q.tables) {
      const tr = table.column(Transform, 'translation')
      const rot = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        tr.set(eye, i * 3)
        rot.set(rotation, i * 4)
      }
      table.markChanged(Transform)
    }
  },
})

/** 20 mesh types, each with a low-poly version for the middle distance. */
function kinds(): [Mesh, Mesh][] {
  const out: [Mesh, Mesh][] = []
  for (const segments of [8, 12, 16, 24]) {
    out.push([sphere({ radius: 0.5, segments }), sphere({ radius: 0.5, segments: 6 })])
  }
  for (const y of [0.5, 0.8, 1.2]) {
    const m = box({ x: 0.8, y, z: 0.8 })
    out.push([m, m])
  }
  for (const segments of [6, 12, 24]) {
    out.push([
      cylinder({ radius: 0.4, height: 1, segments }),
      cylinder({ radius: 0.4, height: 1, segments: 5 }),
    ])
  }
  for (const segments of [6, 16]) {
    out.push([
      cone({ radius: 0.5, height: 1.2, segments }),
      cone({ radius: 0.5, height: 1.2, segments: 4 }),
    ])
  }
  for (const segments of [8, 16]) {
    out.push([
      capsule({ radius: 0.3, height: 1.2, segments }),
      capsule({ radius: 0.3, height: 1.2, segments: 4, rings: 2 }),
    ])
  }
  for (const tube of [0.2, 0.1]) {
    out.push([
      torus({ radius: 0.4, tube }),
      torus({ radius: 0.4, tube, radialSegments: 4, tubularSegments: 8 }),
    ])
  }
  for (const y of [0.3, 0.6, 1]) {
    const m = box({ x: 0.5, y, z: 1.2 })
    out.push([m, m])
  }
  const beam = box({ x: 1.5, y: 0.3, z: 0.3 })
  out.push([beam, beam])
  return out
}

/**
 * 200k static instances of 20 mesh types over a 600 m field, under a sun with 4 shadow cascades.
 * Most have 3 LOD levels; every fifth is a small prop hidden past 120 m. `?count=` changes the
 * number, `?nolod` draws every instance at full detail. The camera orbits, so the culled sets
 * change every frame while nothing uploads.
 */
export const crowdPlugin = definePlugin({
  name: 'crowd-demo',
  dependencies: ['render/forward'],
  build(app) {
    app.addSystems(Update, orbit)
  },
  ready(app) {
    const world = app.world
    const params = new URLSearchParams(location.search)
    const count = Number(params.get('count') ?? 200_000)
    const flat = params.has('nolod')
    // `?effects=` adds post effects (see post.ts), to measure them on a GPU-bound frame.
    const post = params.has('effects') ? effectsFromUrl() : []
    world.spawn(
      [Camera3d, { fovY: 60, far: 800 }],
      [Exposure, { ev100: 14 }],
      Transform,
      ...(post as []),
    )
    world.spawn(
      [DirectionalLight, { illuminance: 60_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.8, 0.7, 0) as never }],
    )
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const rng = new Rng(11)
    const stand = meshes.add(box({ x: 0.8, y: 0.8, z: 0.8 }))
    const types = kinds().map(([hi, lo]) => {
      const mesh = meshes.add(hi)
      return {
        mesh,
        levels: [
          { mesh, screenSize: 0.04 },
          { mesh: meshes.add(lo), screenSize: 0.01 },
          { mesh: stand, screenSize: 0.002 },
        ],
      }
    })
    const looks = Array.from({ length: 8 }, () =>
      materials.add(
        new MaterialAsset({
          baseColor: [rng.range(0.2, 0.9), rng.range(0.2, 0.9), rng.range(0.2, 0.9), 1],
          roughness: rng.range(0.2, 0.9),
        }),
      ),
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 700 })) }],
      [MeshMaterial, { material: looks[0]! }],
      Transform,
    )
    for (let i = 0; i < count; i++) {
      const s = rng.range(0.6, 1.8)
      const kind = types[i % types.length]!
      const common = [
        [MeshMaterial, { material: looks[i % looks.length]! }],
        [
          Transform,
          {
            translation: [rng.range(-300, 300), s * 0.5, rng.range(-300, 300)],
            rotation: quat.fromEuler([0, 0, 0, 1], 0, rng.float() * 6.28, 0) as never,
            scale: [s, s, s],
          },
        ],
      ] as const
      if (flat) {
        world.spawn([Mesh3d, { mesh: kind.mesh }], ...common)
      } else if (i % 5 === 0) {
        world.spawn([Mesh3d, { mesh: kind.mesh }], [VisibilityRange, { end: 120 }], ...common)
      } else {
        world.spawn([Mesh3d, { mesh: kind.mesh }], [Lod, { levels: kind.levels }], ...common)
      }
    }
  },
})
