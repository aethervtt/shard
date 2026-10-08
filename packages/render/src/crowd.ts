import { quat, Rng, type World } from '@aethervtt/shard-core'
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
import { Transform } from '@aethervtt/shard-transform'
import { MaterialAsset, Materials, Meshes } from './assets'
import { Lod, Mesh3d, MeshMaterial, VisibilityRange } from './instances'
import { DirectionalLight } from './lights'

// 0022's crowd (`@aethervtt/shard-render/crowd`): 200k static instances of 20 mesh types with LOD
// chains, under a sun with 4 shadow cascades. The playground's #crowd page and 0075's `crowd`
// scenario test both build it with `spawnCrowd`. Nothing here registers on import.

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

export interface CrowdOptions {
  /** Instances (default 200 000). */
  count?: number
  /** Every instance at full detail, no LOD (the playground's `?nolod`). */
  flat?: boolean
}

/**
 * The crowd's turntable: 160 m out and 40 m up, looking at the field's centre, `angle` radians
 * round (the playground turns it 2.86° a second).
 */
export function crowdCamera(angle: number): {
  eye: [number, number, number]
  target: [number, number, number]
} {
  return { eye: [Math.sin(angle) * 160, 40, Math.cos(angle) * 160], target: [0, 0, 0] }
}

/**
 * 200k static instances of 20 mesh types over a 600 m field, under a sun with 4 shadow cascades.
 * Most have 3 LOD levels; every fifth is a small prop hidden past 120 m. The camera is the
 * caller's (`crowdCamera` places the turntable).
 */
export function spawnCrowd(world: World, options: CrowdOptions = {}): void {
  const count = options.count ?? 200_000
  const flat = options.flat ?? false
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
}
