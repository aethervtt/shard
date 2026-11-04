import { type Entity, quat, type World } from '@aethervtt/shard-core'
import { box, cylinder } from '@aethervtt/shard-mesh'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
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
  ProceduralSky,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Terrain, TerrainSources, TerrainWorld } from '@aethervtt/shard-terrain'
import { sourceAsset } from '@aethervtt/shard-terrain/testing'
import { Grid, Transform } from '@aethervtt/shard-transform'
import {
  describeWater,
  WaterBody,
  WaterSpline,
  waterAt,
  waterOptics,
  waterSample,
} from '@aethervtt/shard-water'
import { Wind } from '@aethervtt/shard-wind'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'

/**
 * Water bodies (spec 0097, part 1): an island heightfield rising out of an ocean, a lake on its
 * plateau, and a dock, buoys and a rock above the water to see refraction (and that nothing above
 * the surface shows in it) and reflections of the sky. 1–3 move the camera (the lake, the dock,
 * from above), W cycles the wind.
 */

type Vec3 = [number, number, number]

/**
 * Island profile by distance from its middle (m): a smooth lake bowl (5 m deep in the middle, the
 * shore 35.5 m out) easing into a plateau, then a slope into the sea. Smooth, so the terrain's
 * coarser levels stay on it and keep the water under the rim hidden far away.
 */
function islandHeight(r: number): number {
  if (r < 120) return 5 + 11 * (1 - Math.exp(-((r / 40) ** 2)))
  if (r < 230) return 16 - 30 * ((r - 120) / 110) ** 1.3
  return -14 - 6 * Math.min(1, (r - 230) / 30)
}

const SIZE = 512
const LAKE_LEVEL = 11

function islandSource() {
  const n = 128
  const data = new Float32Array(n * n)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = (Math.hypot(x - (n - 1) / 2, y - (n - 1) / 2) * SIZE) / n
      data[y * n + x] = (islandHeight(r) + 20) / 40
    }
  }
  return {
    source: {
      size: [SIZE, SIZE],
      spacing: 1,
      heightRange: [-25, 25],
      seed: 5,
      height: [
        {
          image: { path: 'island' },
          at: [SIZE / 2, SIZE / 2],
          size: [SIZE, SIZE],
          rotation: 0,
          range: [-20, 20],
          blend: 'add',
          falloff: 0,
        },
      ],
      layers: [{ name: 'grass' }, { name: 'rock', triplanar: true }, { name: 'sand' }],
      paint: [
        { layer: 'grass' },
        { layer: 'sand', height: [-30, 2.5], blend: 1.5 },
        { layer: 'rock', slope: [30, 90], blend: 6 },
      ],
    },
    heightmaps: { island: { width: n, height: n, data } },
  }
}

const VIEWS: [string, Vec3, Vec3][] = [
  ['lake', [-20, 15.5, -45], [10, 10.5, 5]],
  ['dock', [205, 4, 105], [140, 1, 140]],
  ['above', [-170, 140, -230], [0, 0, 0]],
]
const WINDS = [
  ['calm', 0],
  ['breeze', 6],
  ['gale', 18],
] as const

interface Demo {
  camera: Entity
  view: number
  wind: number
}

let demo: Demo | undefined
const sample = waterSample()
const eye = new Float64Array(3)

function setView(world: World, d: Demo, i: number, from = VIEWS[i]![1], to = VIEWS[i]![2]): void {
  d.view = i
  const [component, value] = orbitFrom(from, to)
  world.add(d.camera, component, value)
}

export const waterDemoPlugin = definePlugin({
  name: 'water-demo',
  build() {
    hudExtras.push((world) => {
      const d = demo
      if (!d) return []
      const w = describeWater(world)
      const m = world.get(d.camera, Transform).translation
      eye[0] = m[0]
      eye[1] = m[1]
      eye[2] = m[2]
      waterAt(world, eye, sample)
      const gpu = w.gpuMs.water
      return [
        '',
        `water     ${w.drawn} bodies, pass ${gpu === null ? '–' : `${gpu.toFixed(2)} ms`}, ${w.zone?.rebuilds ?? 0} info redraws`,
        `below     ${sample.body === null ? 'no water' : `surface ${sample.surfaceHeight.toFixed(1)} m, ${(-sample.depth).toFixed(1)} m above it`}`,
        `wind      ${WINDS[d.wind]![0]} (${world.resource(Wind).speed} m/s)`,
        `1 lake  2 dock  3 above (${VIEWS[d.view]![0]})   w wind`,
      ]
    })
  },
  async ready(app) {
    const world = app.world
    // The terrain's bake samples its stack on the main thread too.
    await loadNoiseKernel()
    world.resource(AmbientLight).brightness = 1200
    world.resource(Wind).speed = WINDS[1][1]
    world.spawn(
      [
        DirectionalLight,
        {
          illuminance: 100_000,
          shadows: true,
          cascades: { count: 4, maxDistance: 600, splitLambda: 0.8 },
        },
      ],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.55, 2.3, 0) as never }],
    )
    const asset = sourceAsset(world, islandSource())
    const ref = world.initResource(TerrainSources).add(asset, 'island.terrain.json')
    world.spawn(
      [Grid, { cellSize: 2000 }],
      [Terrain, { source: ref }],
      [Transform, { translation: [-SIZE / 2, 0, -SIZE / 2] }],
    )
    world.spawn([WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }], Transform)
    // The lake's outline runs under the bowl's rim (the ground reaches 11 m 35.5 m out, 12 m by
    // 40 m): its shore is where the water thins out on the ground, not the outline.
    world.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake'), priority: 1 }],
      [
        WaterSpline,
        {
          points: Array.from({ length: 12 }, (_, i) => {
            const a = (i / 12) * Math.PI * 2
            const r = 41 + 1.5 * Math.sin(a * 3)
            return {
              position: [r * Math.cos(a), 0, r * Math.sin(a)] as Vec3,
              width: 0,
              depth: 0,
              flow: 0,
            }
          }),
        },
      ],
      [Transform, { translation: [0, LAKE_LEVEL, 0] }],
    )
    // A dock out from the beach, buoys, and a rock in the lake: things above the surface.
    const materials = world.resource(Materials)
    const meshes = world.resource(Meshes)
    const wood = materials.add(
      new MaterialAsset({ baseColor: [0.45, 0.3, 0.18, 1], roughness: 0.8 }),
    )
    const paint = materials.add(
      new MaterialAsset({ baseColor: [0.85, 0.12, 0.08, 1], roughness: 0.4 }),
    )
    const stone = materials.add(
      new MaterialAsset({ baseColor: [0.4, 0.4, 0.42, 1], roughness: 0.9 }),
    )
    const plank = meshes.add(box())
    const post = meshes.add(cylinder({ radius: 0.15, height: 1 }))
    const dir = [Math.SQRT1_2, 0, -Math.SQRT1_2]
    for (let k = 0; k < 14; k++) {
      const s = 175 + k * 3
      const at: Vec3 = [dir[0]! * s, 1.2, -dir[2]! * s]
      world.spawn(
        [Mesh3d, { mesh: plank }],
        [MeshMaterial, { material: wood }],
        [
          Transform,
          {
            translation: at,
            rotation: quat.fromEuler([0, 0, 0, 1], 0, Math.PI / 4, 0) as never,
            scale: [2.6, 0.2, 2.9],
          },
        ],
      )
      for (const side of [-1, 1]) {
        world.spawn(
          [Mesh3d, { mesh: post }],
          [MeshMaterial, { material: wood }],
          [Transform, { translation: [at[0] + side, -2, at[2] + side], scale: [1, 6.4, 1] }],
        )
      }
    }
    for (const [x, z] of [
      [205, 140],
      [190, 165],
      [225, 160],
    ]) {
      world.spawn(
        [Mesh3d, { mesh: meshes.add(cylinder({ radius: 0.5, height: 1 })) }],
        [MeshMaterial, { material: paint }],
        [Transform, { translation: [x!, 0.6, z!] }],
      )
    }
    world.spawn(
      [Mesh3d, { mesh: meshes.add(box()) }],
      [MeshMaterial, { material: stone }],
      [
        Transform,
        {
          translation: [6, 11.6, 4],
          rotation: quat.fromEuler([0, 0, 0, 1], 0.3, 0.7, 0.2) as never,
          scale: [5, 3, 4],
        },
      ],
    )
    const camera = world.spawn(
      [Camera3d, { fovY: 55, near: 0.1, far: 0, clearColor: [0.45, 0.6, 0.85, 1] }],
      [Exposure, { ev100: 14.5 }],
      [ProceduralSky, { turbidity: 2.5 }],
      Transform,
    )
    demo = { camera, view: 0, wind: 1 }
    setView(world, demo, 0)
    Object.assign(globalThis, {
      water: {
        demo,
        terrain: () => world.resource(TerrainWorld),
        describe: () => describeWater(world),
        look: (from: Vec3, to: Vec3) => setView(world, demo!, 0, from, to),
        at: (x: number, y: number, z: number) => ({ ...waterAt(world, [x, y, z], waterSample()) }),
      },
    })
    window.addEventListener('keydown', (e) => {
      const d = demo
      if (!d) return
      const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code)
      if (i >= 0) setView(world, d, i)
      if (e.code === 'KeyW') {
        d.wind = (d.wind + 1) % WINDS.length
        world.resource(Wind).speed = WINDS[d.wind]![1]
      }
    })
  },
})
