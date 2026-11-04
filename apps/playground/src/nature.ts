import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineSystem,
  type Entity,
  quat,
  Rng,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { plane } from '@aethervtt/shard-mesh'
import {
  naturePlugin,
  natureStarterFiles,
  PRESET_LOOKS,
  TREE_LOOKS,
  TREE_PRESETS,
  TreeGenerator,
  type TreeLook,
  type TreePreset,
} from '@aethervtt/shard-nature'
import { createWebWorkers } from '@aethervtt/shard-platform-web'
import {
  configureProcgenHost,
  generate,
  procgen,
  procgenPlugin,
  requestOf,
  warmGeneratorWorkers,
} from '@aethervtt/shard-procgen'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  Lod,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  ProceduralSky,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

/**
 * Procedural trees (spec 0095, experimental): EZ-Tree's 15 presets grown by nature/Tree on web
 * workers and drawn with nature/Tree materials (textured bark, leaves cut out by alpha in color and
 * shadows, wind sway), each with its two LODs. S reseeds, W cycles the wind, F switches between the
 * gallery and a forest of 500 trees from 45 generated meshes.
 */

/** The package's textures, served by Vite: `textures/…` (what natureStarterFiles copies) → URL. */
const TEXTURES = import.meta.glob<string>(
  '../../../packages/nature/assets/textures/**/*.{jpg,png}',
  { query: '?url', import: 'default', eager: true },
)

const GALLERY: TreePreset[][] = [
  ['oak_small', 'oak_medium', 'oak_large', 'bush_ash', 'bush_aspen'],
  ['ash_small', 'ash_medium', 'ash_large', 'aspen_small', 'aspen_medium'],
  ['pine_small', 'pine_medium', 'pine_large', 'aspen_large', 'bush_pine'],
]
const SPACING = 22
/** wind/Wind speeds (m/s) W cycles through. */
const WINDS = [
  ['calm', 0],
  ['breeze', 6],
  ['gale', 18],
] as const

const files = memoryPlatform()
const keys = new Set<string>()
const report: string[] = ['trees: loading textures…']
const trees: Entity[] = []
const materials = new Map<TreeLook, AssetRef<'Material'>>()
let mode: 'gallery' | 'forest' = 'gallery'
let seed = 1
let wind = 1
let busy = false
let built = { meshes: 0, ms: 0 }

const material = (preset: TreePreset) => materials.get(PRESET_LOOKS[preset])!

/** A tree's mesh and LODs, generated (or from the cache), all loaded, so `Lod` can draw. */
async function grow(world: World, preset: TreePreset, s: number) {
  const params = { species: { path: `assets/nature/species/${preset}.tree.json` } }
  const mesh = await generate(world, TreeGenerator, params, s)
  const request = requestOf(TreeGenerator, params, s)
  const lods = [1, 2].map((l) => {
    const e = procgen(world).entryFor(request, `LOD${l}`)
    return { type: 'Mesh', guid: e.guid, path: e.path } as AssetRef<'Mesh'>
  })
  await Promise.all(lods.map((ref) => assetServer(world).load(ref)))
  return {
    mesh,
    lod: {
      levels: [
        { mesh, screenSize: 0.3 },
        { mesh: lods[0]!, screenSize: 0.08 },
        { mesh: lods[1]!, screenSize: 0 },
      ],
    },
  }
}

function plant(
  world: World,
  preset: TreePreset,
  grown: Awaited<ReturnType<typeof grow>>,
  x: number,
  z: number,
  turn: number,
  scale: number,
) {
  trees.push(
    world.spawn(
      [Mesh3d, { mesh: grown.mesh }],
      [MeshMaterial, { material: material(preset) }],
      [Lod, grown.lod],
      [
        Transform,
        {
          translation: [x, 0, z],
          rotation: quat.fromEuler([0, 0, 0, 1], 0, turn, 0) as [number, number, number, number],
          scale: [scale, scale, scale],
        },
      ],
    ),
  )
}

async function rebuild(world: World): Promise<void> {
  if (busy) return
  busy = true
  const t0 = performance.now()
  for (const e of trees.splice(0)) if (world.isAlive(e)) world.despawn(e)
  const rng = new Rng(seed * 7919)
  let meshes = 0
  if (mode === 'gallery') {
    const jobs: Promise<void>[] = []
    GALLERY.forEach((row, r) => {
      row.forEach((preset, c) => {
        const turn = rng.range(0, 6.28)
        jobs.push(
          grow(world, preset, seed).then((g) => {
            meshes++
            plant(world, preset, g, (c - 2) * SPACING, (r - 1) * SPACING, turn, 1)
          }),
        )
      })
    })
    await Promise.all(jobs)
  } else {
    // Three seeds per species, reused across 500 placements spaced at least 5 m apart.
    const presets = Object.keys(TREE_PRESETS) as TreePreset[]
    const variants = await Promise.all(
      presets.flatMap((preset) =>
        [0, 1, 2].map((v) =>
          grow(world, preset, seed * 3 + v).then((g) => {
            meshes++
            return { preset, g }
          }),
        ),
      ),
    )
    const placed: number[] = []
    for (let tries = 0; placed.length < 1000 && tries < 20_000; tries++) {
      const x = rng.range(-140, 140)
      const z = rng.range(-140, 140)
      let ok = true
      for (let i = 0; i < placed.length && ok; i += 2) {
        const dx = placed[i]! - x
        const dz = placed[i + 1]! - z
        ok = dx * dx + dz * dz > 25
      }
      if (!ok) continue
      placed.push(x, z)
      const { preset, g } = variants[rng.int(0, variants.length - 1)]!
      plant(world, preset, g, x, z, rng.range(0, 6.28), rng.range(0.8, 1.2))
    }
  }
  built = { meshes, ms: performance.now() - t0 }
  busy = false
}

function applyWind(world: World) {
  world.resource(Wind).speed = WINDS[wind]![1]
}

const controls = defineSystem({
  name: 'nature-demo/controls',
  run: (_, world) => {
    if (materials.size === 0) return
    if (keys.delete('KeyW')) {
      wind = (wind + 1) % WINDS.length
      applyWind(world)
    }
    if (keys.delete('KeyS') && !busy) {
      seed++
      void rebuild(world)
    }
    if (keys.delete('KeyF') && !busy) {
      mode = mode === 'gallery' ? 'forest' : 'gallery'
      void rebuild(world)
    }
  },
})

async function start(world: World): Promise<void> {
  // A project folder in memory: the starter species and materials, and the package's textures.
  await Promise.all(
    natureStarterFiles().map(async (f) => {
      if ('text' in f) return files.fs.writeText(f.path, f.text)
      const url = TEXTURES[`../../../packages/nature/assets/${f.copy}`]
      if (!url) return
      return files.fs.writeBytes(f.path, new Uint8Array(await (await fetch(url)).arrayBuffer()))
    }),
  )
  await assetServer(world)
    .configure({ platform: files, roots: ['assets'] })
    .scan()
  for (const look of Object.keys(TREE_LOOKS) as TreeLook[]) {
    const ref = assetServer(world).resolve<'Material'>(
      `assets/nature/materials/${look}.material.json`,
    )!
    await assetServer(world).load(ref)
    materials.set(look, ref)
  }
  applyWind(world)
  report[0] = 'trees: generating…'
  const workers = createWebWorkers()
  configureProcgenHost({
    workers,
    workerModule: new URL('./nature-worker.ts', import.meta.url).href,
  })
  await warmGeneratorWorkers()
  await rebuild(world)
}

export const natureDemoPlugin = definePlugin({
  name: 'nature-demo',
  build(app) {
    app.addPlugin(procgenPlugin(), naturePlugin)
    app.addSystems(Update, controls)
    hudExtras.push(() => [
      '',
      ...(materials.size === 0 || built.meshes === 0
        ? report
        : [
            `trees     ${trees.length} (${mode}), ${built.meshes} meshes in ${built.ms.toFixed(0)} ms on workers`,
            `seed      ${seed} (S)    wind ${WINDS[wind]![0]} (W)    ${mode === 'gallery' ? 'forest' : 'gallery'} (F)`,
            ...(mode === 'gallery' ? GALLERY.map((row) => `          ${row.join('  ')}`) : []),
          ]),
    ])
  },
  async ready(app) {
    const world = app.world
    addEventListener('keydown', (e) => keys.add(e.code))
    world.spawn(
      [
        DirectionalLight,
        {
          illuminance: 80_000,
          shadows: true,
          cascades: { count: 4, maxDistance: 400, splitLambda: 0.8 },
        },
      ],
      [Transform, { rotation: lookAt([0, 0, 0], [-0.5, -1, -0.7]) }],
    )
    world.resource(AmbientLight).brightness = 9000
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 3000 })) }],
      [
        MeshMaterial,
        {
          material: world
            .resource(Materials)
            .add(new MaterialAsset({ baseColor: [0.16, 0.22, 0.09, 1], roughness: 1 })),
        },
      ],
      Transform,
    )
    world.spawn(
      [Camera3d, { fovY: 50, far: 2000, clearColor: [0.45, 0.6, 0.85, 1] }],
      [Exposure, { ev100: 14 }],
      [ProceduralSky, { turbidity: 2.5 }],
      Transform,
      orbitFrom([0, 30, 95], [0, 6, 0], { turn: 0 }),
    )
    void start(world).catch((err) => {
      report.length = 0
      report.push(`trees failed: ${(err as Error).message}`)
      console.error(err)
    })
  },
})
