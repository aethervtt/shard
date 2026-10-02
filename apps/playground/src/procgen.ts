import { assetServer } from '@aethervtt/shard-assets'
import { defineSystem, type Entity, quat, Update } from '@aethervtt/shard-core'
import { createWebWorkers } from '@aethervtt/shard-platform-web'
import {
  configureProcgenHost,
  GeneratorInstance,
  generate,
  procgen,
  procgenMainThreadMs,
  procgenPlugin,
  warmGeneratorWorkers,
} from '@aethervtt/shard-procgen'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  Mesh3d,
  MeshMaterial,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { instanceEntities } from '@aethervtt/shard-scene'
import { Transform } from '@aethervtt/shard-transform'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'
import { AsteroidField, Rock } from './procgen-generators'

/**
 * Generators as assets (spec 0042): a boulder and a field of 60 rocks made on web workers from
 * seeds. The boulder's mesh bytes are checksummed against what Node makes for the example's
 * generators/boulder.gen.json, so this page shows the output is the same bytes in the browser.
 * S reseeds the field (children at unchanged paths keep their entity), R changes its roughness.
 */

/** examples/star-explorer/assets/noise/rock.noise.json. */
const ROCK_NOISE = {
  output: 'shape',
  nodes: {
    lumps: { fbm: { source: 'simplex', octaves: 3, frequency: 1.2, seed: 1 } },
    cracks: { ridged: { source: 'simplex', octaves: 3, frequency: 3.5, seed: 2 } },
    shape: { add: ['lumps', { multiply: ['cracks', 0.25] }] },
  },
}

/** What Node makes for examples/star-explorer/generators/boulder.gen.json (packages/node tests). */
const NODE_CHECKSUM = '5593aa06'

function checksum(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

const files = memoryPlatform()
const report: string[] = ['procgen: starting workers…']
const keys = new Set<string>()
let field: Entity | undefined
let seed = 7
let roughness = 0.4
let started = 0
let lastMs = 0
let worstFrame = 0
let generating = false

function fieldParams() {
  return { count: 60, roughness, material: { path: 'assets/stone.material.json' } }
}

const controls = defineSystem({
  name: 'procgen-demo/controls',
  run: (_, world) => {
    // Main-thread procgen work since the last frame.
    const ms = procgenMainThreadMs()
    if (generating) worstFrame = Math.max(worstFrame, ms - lastMs)
    lastMs = ms
    if (field === undefined) return
    const regenerate = (patch: Record<string, unknown>) => {
      generating = true
      worstFrame = 0
      started = performance.now()
      world.set(field!, GeneratorInstance, patch)
    }
    if (keys.delete('KeyS')) {
      seed = (seed * 1103515245 + 12345) % 1000
      regenerate({ seed })
    }
    if (keys.delete('KeyR')) {
      roughness = roughness === 0.4 ? 0.75 : 0.4
      regenerate({ params: fieldParams() })
    }
  },
})

async function start(world: import('@aethervtt/shard-core').World): Promise<void> {
  const workers = createWebWorkers()
  configureProcgenHost({
    workers,
    workerModule: new URL('./procgen-worker.ts', import.meta.url).href,
  })
  await warmGeneratorWorkers()
  await files.fs.writeText('assets/rock.noise.json', JSON.stringify(ROCK_NOISE))
  await files.fs.writeText(
    'assets/stone.material.json',
    JSON.stringify({ baseColor: '#8a7f74', roughness: 0.9 }),
  )
  await assetServer(world)
    .configure({ platform: files, roots: ['assets'] })
    .scan()

  // The example's boulder file: radius 2, roughness 0.45, detail 4, seed 3.
  const t0 = performance.now()
  const boulder = await generate(
    world,
    Rock,
    { radius: 2, roughness: 0.45, detail: 4, shape: { path: 'assets/rock.noise.json' } },
    3,
  )
  const ms = performance.now() - t0
  const bytes = procgen(world).recordOf(boulder.guid!)!.assets[0]!.bytes!
  const sum = checksum(bytes)
  world.spawn(
    [Mesh3d, { mesh: boulder }],
    [
      MeshMaterial,
      { material: assetServer(world).resolve<'Material'>('assets/stone.material.json')! },
    ],
    [Transform, {}],
  )
  report.length = 0
  report.push(
    `workers   ${workers.size} web workers`,
    `boulder   ${bytes.length} bytes in ${ms.toFixed(1)} ms`,
    `checksum  ${sum} ${sum === NODE_CHECKSUM ? '= Node ✓' : `≠ Node ${NODE_CHECKSUM} ✗`}`,
  )
  generating = true
  started = performance.now()
  field = world.spawn(
    [GeneratorInstance, { generator: AsteroidField, seed, params: fieldParams() }],
    [Transform, {}],
  )
}

export const procgenDemoPlugin = definePlugin({
  name: 'procgen-demo',
  build(app) {
    app.addPlugin(procgenPlugin())
    app.addSystems(Update, controls)
    hudExtras.push((world) => {
      const rocks = field === undefined ? 0 : instanceEntities(world, field).size
      if (generating && rocks === fieldParams().count) {
        generating = false
        report[3] = `field     ${rocks} rocks in ${(performance.now() - started).toFixed(0)} ms, worst frame ${worstFrame.toFixed(2)} ms main-thread procgen`
      }
      const stats = procgen(world).stats
      return [
        '',
        ...report,
        `cache     ${stats.runs} runs, ${stats.memoryHits} memory hits`,
        '',
        `field     seed ${seed} (S), roughness ${roughness} (R)`,
      ]
    })
  },
  async ready(app) {
    const world = app.world
    addEventListener('keydown', (e) => keys.add(e.code))
    world.spawn(
      [DirectionalLight, { illuminance: 90_000 }],
      [
        Transform,
        {
          rotation: quat.fromEuler([0, 0, 0, 1], -0.7, 0.6, 0) as [number, number, number, number],
        },
      ],
    )
    world.resource(AmbientLight).brightness = 1200
    world.spawn(
      [Camera3d, { fovY: 45 }],
      [Exposure, { ev100: 13 }],
      Transform,
      orbitFrom([0, 7, 22], [0, 0, 0], { turn: 5.7 }),
    )
    void start(world).catch((err) => {
      report.length = 0
      report.push(`procgen failed: ${(err as Error).message}`)
    })
  },
})
