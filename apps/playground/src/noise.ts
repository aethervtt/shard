import { assetServer } from '@aethervtt/shard-assets'
import { type AssetRef, defineSystem, quat, t, Update } from '@aethervtt/shard-core'
import { sphere } from '@aethervtt/shard-mesh'
import {
  loadNoiseKernel,
  NoiseGraph,
  noiseKernel,
  noiseStats,
  poolTiming,
  sampleNoise,
  sampleSpherePatchAsync,
} from '@aethervtt/shard-noise'
import { createWebWorkers } from '@aethervtt/shard-platform-web'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  defineMaterial,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { orbitFrom } from './camera'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

/**
 * The noise library (spec 0041): the example planet graph on a sphere through a material (the GPU
 * codegen), next to the CPU kernel's numbers for the same graph. The checksum and stats match what
 * the Node tests assert, so this page shows the kernel is bitwise the same in the browser. E edits
 * the graph file (hot reload re-renders the planet), S reseeds.
 */

const GRAPH = 'assets/noise/planet.noise.json'

/** The example graph (examples/star-explorer/assets/noise/planet.noise.json). */
function planetGraph(mountains: number) {
  return {
    description: 'Planet height on the unit sphere.',
    output: 'height',
    extent: 1,
    nodes: {
      continents: {
        fbm: { source: 'simplex', octaves: 5, frequency: 0.8, gain: 0.5, lacunarity: 2.0, seed: 1 },
      },
      mountains: { ridged: { source: 'simplex', octaves: 6, frequency: 3.2, seed: 2 } },
      mask: { remap: { input: 'continents', from: [0.1, 0.4], to: [0, mountains], clamp: true } },
      warped: { warp: { input: 'mountains', by: 'continents', amount: 0.15 } },
      height: { add: ['continents', { multiply: ['warped', 'mask'] }] },
    },
  }
}

const NoisePlanet = defineMaterial('playground/NoisePlanet', {
  fields: { seed: t.f32({ default: 7 }), relief: t.f32({ default: 0.06 }) },
  shader: 'project::noise_planet',
  noise: { height: GRAPH },
})

const PLANET_WESL = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import material::noise_planet::{ NoisePlanet, noise_height };

fn sea(h: f32) -> f32 { return max(h, 0.0); }

override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  let h = noise_height(normalize(position), u32(NoisePlanet.seed));
  return normalize(position) * (1.0 + sea(h) * NoisePlanet.relief);
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let h = noise_height(normalize(in.world_position), u32(NoisePlanet.seed));
  let deep = vec3f(0.01, 0.04, 0.18);
  let shallow = vec3f(0.03, 0.18, 0.35);
  let grass = vec3f(0.12, 0.3, 0.06);
  let rock = vec3f(0.3, 0.25, 0.2);
  let snow = vec3f(0.9, 0.9, 0.95);
  var c = mix(deep, shallow, clamp(h + 1.0, 0.0, 1.0));
  if (h > 0.0) {
    c = mix(grass, rock, clamp(h * 2.5, 0.0, 1.0));
    c = mix(c, snow, clamp((h - 0.55) * 4.0, 0.0, 1.0));
  }
  p.base_color = c;
  p.roughness = select(0.9, 0.25, h <= 0.0);
  return p;
}
`

/** The Node tests' points and seed: 4096 points in ±10 from an LCG seeded with 5. */
function testPoints(): Float32Array {
  let s = 5
  const p = new Float32Array(4096 * 3)
  for (let i = 0; i < p.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    p[i] = (s / 4294967296 - 0.5) * 20
  }
  return p
}

function checksum(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** What packages/noise and packages/protocol assert in Node. */
const NODE_CHECKSUM = 'f38c31a8'
const NODE_STATS = [-0.703918, 1.446697, 0.029498, 0.476848]

const report: string[] = ['noise: loading the kernel…']
let mountains = 1
let seed = 7
let material: AssetRef<'Material'> | undefined
const keys = new Set<string>()
/** The demo's project folder (in memory: the playground has no file system). */
const files = memoryPlatform()

async function measure(): Promise<void> {
  await loadNoiseKernel()
  const kernel = noiseKernel()
  const graph = NoiseGraph.fromJson(planetGraph(1))
  const out = new Float32Array(4096)
  sampleNoise(graph, 42, testPoints(), out)
  const sum = checksum(out)
  const stats = noiseStats(graph, 7, { kind: 'sphere', resolution: 48 }, { thresholds: [0] })
  const numbers = [stats.min, stats.max, stats.mean, stats.below[0]!.fraction]
  const statsMatch = numbers.every((v, i) => v === NODE_STATS[i])

  const fbm = NoiseGraph.fromJson({
    output: 'n',
    nodes: { n: { fbm: { source: 'simplex', octaves: 6 } } },
  })
  const n = 1 << 20
  const pts = new Float32Array(n * 3)
  for (let i = 0; i < pts.length; i++) pts[i] = ((i * 2654435761) % 10007) / 100 - 50
  const values = new Float32Array(n)
  let best = Infinity
  for (let r = 0; r < 12; r++) {
    const t0 = performance.now()
    sampleNoise(fbm, 7, pts, values)
    best = Math.min(best, performance.now() - t0)
  }

  const pool = createWebWorkers()
  const patch = { face: 2, x0: -0.4, y0: 0.1, extent: 0.05, resolution: 257, radius: 6.371e6 }
  const patchOut = new Float32Array(257 * 257)
  const times: number[] = []
  let blocked = 0
  for (let r = 0; r < 30; r++) {
    poolTiming.mainThreadMs = 0
    const t0 = performance.now()
    await sampleSpherePatchAsync(pool, graph, r, patch, patchOut)
    times.push(performance.now() - t0)
    blocked = poolTiming.mainThreadMs
  }
  const settled = times.slice(15).sort((a, b) => a - b)
  report.length = 0
  report.push(
    `kernel    ${kernel.simd ? 'wasm simd128' : 'wasm scalar'}`,
    `checksum  ${sum} ${sum === NODE_CHECKSUM ? '= Node ✓' : `≠ Node ${NODE_CHECKSUM} ✗`}`,
    `stats     min ${numbers[0]} max ${numbers[1]} mean ${numbers[2]}`,
    `          ${(numbers[3]! * 100).toFixed(1)}% below 0 ${statsMatch ? '= Node ✓' : '≠ Node ✗'}`,
    `fbm ×6    ${(n / best / 1000).toFixed(1)}M points/s on this thread`,
    `257² patch ${settled[settled.length >> 1]!.toFixed(2)} ms on ${pool.size} web workers (main ${blocked.toFixed(3)} ms)`,
  )
  pool.dispose()
}

const controls = defineSystem({
  name: 'noise-demo/controls',
  run: (_, world) => {
    if (material && keys.has('KeyS')) {
      keys.delete('KeyS')
      seed = (seed * 1103515245 + 12345) % 1000
      world.resource(Materials).get(material)!.set({ seed })
    }
    if (keys.has('KeyE')) {
      keys.delete('KeyE')
      // Edit the graph file: the importer recompiles it, the material relinks and re-renders.
      mountains = mountains === 1 ? 0.2 : 1
      const server = assetServer(world)
      void files.fs
        .writeText(GRAPH, JSON.stringify(planetGraph(mountains)))
        .then(() => server.scan())
    }
  },
})

export const noiseDemoPlugin = definePlugin({
  name: 'noise-demo',
  build(app) {
    app.addSystems(Update, controls)
    hudExtras.push(() => [
      '',
      ...report,
      '',
      `graph     mountains × ${mountains} (E edits the file), seed ${seed} (S)`,
    ])
  },
  async ready(app) {
    const world = app.world
    addEventListener('keydown', (e) => keys.add(e.code))
    await files.fs.writeText(GRAPH, JSON.stringify(planetGraph(1)))
    await assetServer(world)
      .configure({ platform: files, roots: ['assets'] })
      .scan()
    world
      .resource(Shaders)
      .register('project::noise_planet', PLANET_WESL, 'shaders/noise_planet.wesl')
    material = world
      .resource(Materials)
      .add(new MaterialAsset({ roughness: 0.8, seed, relief: 0.06 }, NoisePlanet))
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(sphere({ radius: 1, segments: 192 })) }],
      [MeshMaterial, { material }],
      [Transform, {}],
    )
    world.spawn(
      [DirectionalLight, { illuminance: 90_000 }],
      [
        Transform,
        {
          rotation: quat.fromEuler([0, 0, 0, 1], -0.6, 0.7, 0) as [number, number, number, number],
        },
      ],
    )
    world.resource(AmbientLight).brightness = 800
    world.spawn(
      [Camera3d, { fovY: 40 }],
      [Exposure, { ev100: 13 }],
      Transform,
      orbitFrom([0, 1.1, 3.2], [0, 0, 0], { turn: 8.6 }),
    )
    void measure()
  },
})
