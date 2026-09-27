import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { captureView, Gpu } from '@aethervtt/shard-render'
import { compareGolden } from '@aethervtt/shard-render/testing'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Biome, BiomeSet } from './biomes'
import { Planet } from './components'
import { terrainSample } from './heights'
import { terrainMap } from './methods'
import { type PlanetApp, placeCamera, planetApp, settleTerrain, sunOver } from './test-planet'

const here = dirname(fileURLToPath(import.meta.url))
let gpu: GpuContext
let continents: NoiseGraph
let climate: NoiseGraph
const R = 60_000

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  continents = await NoiseGraph.create({
    output: 'h',
    nodes: {
      base: { fbm: { source: 'simplex', octaves: 6, frequency: 2.5e-5, seed: 4 } },
      hills: { ridged: { source: 'simplex', octaves: 5, frequency: 3e-4, seed: 5 } },
      h: { add: [{ add: ['base', 0.08] }, { multiply: ['hills', 0.15] }] },
    },
  })
  climate = await NoiseGraph.create({
    output: 'temperature',
    nodes: {
      temperature: { add: [{ fbm: { octaves: 3, frequency: 2e-5, seed: 7 } }, 0.3] },
      moisture: { fbm: { octaves: 3, frequency: 3e-5, seed: 8 } },
    },
  })
})

// Descents submit frames faster than a software GPU runs them: wait for the queue before destroying.
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
}, timeout(120_000))

/** Beach, grassland, forest, rock (steep), and snow (cold: the poles and the peaks). */
function addBiomes(p: PlanetApp) {
  const w = p.world
  const biomes = w.initResource(Biome.store)
  const make = (name: string, v: Partial<ReturnType<typeof Biome.defaults>>) =>
    biomes.add({ ...Biome.defaults(), ...v }, name)
  const warm = [-0.35, 3] as [number, number]
  const flat = [0, 28] as [number, number]
  const refs = [
    make('grass', {
      temperature: warm,
      moisture: [-2, 0.1],
      slope: flat,
      tint: [0.25, 0.5, 0.15, 1],
    }),
    make('beach', {
      temperature: warm,
      height: [-400, 25],
      slope: flat,
      tint: [0.8, 0.72, 0.5, 1],
    }),
    make('forest', {
      temperature: warm,
      moisture: [0.1, 2],
      slope: flat,
      tint: [0.08, 0.3, 0.08, 1],
    }),
    make('rock', { temperature: warm, slope: [28, 90], tint: [0.35, 0.33, 0.3, 1] }),
    make('snow', { temperature: [-3, -0.35], tint: [0.95, 0.95, 1, 1], blend: 0.05 }),
  ]
  const set = w
    .initResource(BiomeSet.store)
    .add({ ...BiomeSet.defaults(), biomes: refs, latitudeBias: 1.1, snowLine: 3000 }, 'set')
  w.set(p.planet, Planet, { ...w.get(p.planet, Planet), biomes: set })
}

describe('oceans and biomes (spec 0043)', () => {
  it('maps continents, polar snow, and sea (terrain.map golden)', {
    timeout: timeout(120_000),
  }, async () => {
    const p = await planetApp(undefined, {
      radius: R,
      heightScale: 1500,
      height: continents,
      climate,
      ocean: true,
      seaLevel: 0,
    })
    addBiomes(p)
    p.app.update(1 / 60)
    const rt = p.runtime()
    expect(rt.ready).toBe(true)
    const map = terrainMap(rt, 256, 'biomes')
    const golden = compareGolden(here, 'terrain-map-biomes', map)
    expect(golden.mean).toBeLessThan(1)
    // Poles: the top and bottom rows are snow (or ice-covered sea shown as water); the middle has
    // both sea and land.
    let sea = 0
    let land = 0
    let polarSnow = 0
    let polar = 0
    for (let y = 0; y < map.height; y++) {
      const lat = 90 - ((y + 0.5) / map.height) * 180
      for (let x = 0; x < map.width; x++) {
        const lon = ((x + 0.5) / map.width) * 360 - 180
        const a = (lat * Math.PI) / 180
        const b = (lon * Math.PI) / 180
        const s = terrainSample(rt, [
          Math.cos(a) * Math.sin(b),
          Math.sin(a),
          Math.cos(a) * Math.cos(b),
        ])
        if (Math.abs(lat) < 60) {
          if (s.underwater) sea++
          else land++
        } else if (Math.abs(lat) > 75 && !s.underwater) {
          polar++
          if (s.biome === 4) polarSnow++
        }
      }
    }
    expect(sea / (sea + land)).toBeGreaterThan(0.2)
    expect(land / (sea + land)).toBeGreaterThan(0.2)
    expect(polar).toBeGreaterThan(50)
    expect(polarSnow / polar).toBeGreaterThan(0.8)
  })

  it('shows water where terrain.sample says underwater, land elsewhere', {
    timeout: timeout(120_000),
  }, async () => {
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: 1500,
      height: continents,
      climate,
      ocean: true,
      seaLevel: 0,
      width: 128,
      heightPx: 96,
      fovY: 50,
    })
    addBiomes(p)
    p.app.update(1 / 60)
    const rt = p.runtime()
    const view = [0.6, 0.35, 0.72].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const eye = view.map((v) => v * R * 1.9)
    sunOver(p, view, 60)
    placeCamera(p, eye, [0, 0, 0])
    await settleTerrain(p, 600)
    const shot = captureView(p.world, p.view)
    p.app.update(1 / 60)
    const image = await shot
    expect(p.world.resource(Gpu).errors).toEqual([])
    compareGolden(here, 'ocean-orbit', image)
    // Rays through a grid of pixels: where one meets the planet, compare the pixel with the sample.
    const m = p.world.get(p.camera, GlobalTransform).matrix
    const x = [m[0]!, m[4]!, m[8]!]
    const y = [m[1]!, m[5]!, m[9]!]
    const f = [-m[2]!, -m[6]!, -m[10]!]
    const ty = Math.tan((25 * Math.PI) / 180)
    const tx = ty * (128 / 96)
    let water = 0
    let waterOk = 0
    let dry = 0
    let dryOk = 0
    for (let py = 4; py < 96; py += 6) {
      for (let px = 4; px < 128; px += 6) {
        const a = ((px + 0.5) / 128) * 2 - 1
        const b = 1 - ((py + 0.5) / 96) * 2
        const d = [0, 1, 2].map((k) => f[k]! + x[k]! * a * tx + y[k]! * b * ty)
        const dl = Math.hypot(d[0]!, d[1]!, d[2]!)
        const bq = (eye[0]! * d[0]! + eye[1]! * d[1]! + eye[2]! * d[2]!) / dl
        const c = eye[0]! ** 2 + eye[1]! ** 2 + eye[2]! ** 2 - R * R
        const disc = bq * bq - c
        if (disc <= R * R * 0.1) continue
        const t = -bq - Math.sqrt(disc)
        const hit = [0, 1, 2].map((k) => eye[k]! + (d[k]! / dl) * t)
        const s = terrainSample(rt, hit)
        // Coasts are ambiguous at this resolution: only points clearly wet or dry count.
        if (s.underwater && s.depth < 150) continue
        if (!s.underwater && s.height < 150) continue
        const o = (py * 128 + px) * 4
        const blue =
          image.data[o + 2]! > image.data[o]! + 20 && image.data[o + 2]! > image.data[o + 1]!
        if (s.underwater) {
          water++
          if (blue) waterOk++
        } else {
          dry++
          if (!blue) dryOk++
        }
      }
    }
    expect(water).toBeGreaterThan(20)
    expect(dry).toBeGreaterThan(20)
    expect(waterOk / water).toBeGreaterThan(0.95)
    expect(dryOk / dry).toBeGreaterThan(0.95)
  })
})
