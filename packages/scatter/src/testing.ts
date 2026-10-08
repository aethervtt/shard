/**
 * Test helpers (not a test): a small planet with three biomes, each scattering its own set, for
 * scatter's tests, the playground's #scatter page, and the placement checksum Node and Chrome
 * must agree on.
 */
import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { NoiseGraph } from '@aethervtt/shard-noise'
import type { Platform } from '@aethervtt/shard-platform'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import type { Plugin } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Biome, BiomeSet, Planet } from '@aethervtt/shard-terrain'
import { type PlanetApp, planetApp } from '@aethervtt/shard-terrain/testing'
import { Transform } from '@aethervtt/shard-transform'
import { Prop, propIdentity } from './components'
import { scatterPlugin } from './plugin'
import { Scatter } from './runtime'
import { ScatterSet } from './set'

/** Radius of the test planet (m): small, so tests are quick, with relief and three biomes. */
export const TEST_RADIUS = 20_000

export const TEST_HEIGHT = {
  output: 'h',
  nodes: {
    hills: { fbm: { source: 'simplex', octaves: 5, frequency: 4e-4, seed: 21 } },
    ridges: { ridged: { source: 'simplex', octaves: 4, frequency: 1.5e-4, seed: 22 } },
    h: { add: ['hills', { multiply: ['ridges', 0.6] }] },
  },
}

export const TEST_CLIMATE = {
  output: 'temperature',
  nodes: {
    temperature: { add: [{ fbm: { octaves: 2, frequency: 1e-4, seed: 23 } }, 0.6] },
    moisture: { fbm: { octaves: 3, frequency: 1.2e-3, seed: 24 } },
  },
}

/** Grassland: grass, bushes, the odd boulder. */
export const GRASSLAND_SET = {
  rules: [
    {
      name: 'boulders',
      items: [{ generator: 'shard/Rock', params: { radius: 0.9, detail: 3 }, variants: 4 }],
      density: 0.003,
      spacing: 6,
      align: 0.7,
      scale: [0.6, 1.5],
      sink: 0.15,
      collider: 'convex',
      range: 300,
    },
    {
      name: 'bushes',
      items: [{ generator: 'shard/Bush', variants: 4 }],
      density: 0.02,
      spacing: 2.5,
      masks: { slope: [0, 22] },
      scale: [0.7, 1.3],
      avoid: ['boulders'],
      range: 150,
    },
    {
      name: 'grass',
      kind: 'foliage',
      items: [{ generator: 'shard/GrassClump', variants: 4 }],
      density: 5,
      masks: { slope: [0, 25] },
      align: 0.4,
      scale: [0.7, 1.4],
      avoid: ['boulders'],
      range: 50,
    },
  ],
}

/** Forest: trees, undergrowth, sparse grass. */
export const FOREST_SET = {
  rules: [
    {
      name: 'trees',
      items: [{ generator: 'shard/Tree', variants: 6 }],
      density: 0.02,
      spacing: 4,
      masks: { slope: [0, 25] },
      scale: [0.7, 1.3],
      sink: 0.02,
      collider: 'ball',
      range: 400,
    },
    {
      name: 'bushes',
      items: [{ generator: 'shard/Bush', params: { radius: 0.6 }, variants: 3 }],
      density: 0.05,
      spacing: 1.5,
      avoid: ['trees'],
      range: 120,
    },
    {
      name: 'grass',
      kind: 'foliage',
      items: [{ generator: 'shard/GrassClump', params: { height: 0.4 }, variants: 3 }],
      density: 2,
      avoid: ['trees'],
      range: 40,
    },
  ],
}

/** Rock: boulders and crystals on the slopes. */
export const ROCK_SET = {
  rules: [
    {
      name: 'boulders',
      items: [{ generator: 'shard/Rock', params: { radius: 1.5, roughness: 0.6 }, variants: 6 }],
      density: 0.012,
      spacing: 5,
      align: 1,
      scale: [0.5, 2],
      sink: 0.25,
      collider: 'convex',
      range: 400,
    },
    {
      name: 'crystals',
      items: [{ generator: 'shard/Crystal', variants: 4 }],
      density: 0.004,
      spacing: 6,
      align: 0.5,
      avoid: ['boulders'],
      range: 250,
    },
  ],
}

export interface ScatterPlanet extends PlanetApp {
  sets: AssetRef[]
}

/**
 * The three-biome test planet with scatter (and procgen, which makes the items' meshes). With a
 * GPU it renders (and draws foliage); without one, props alone are placed and spawned.
 */
export async function scatterPlanet(
  gpu: GpuContext | undefined,
  platform: Platform,
  options: {
    width?: number
    height?: number
    extra?: Plugin[]
    workers?: boolean
    /** MSAA samples (the playground's #scatter page draws with 4). Default 1. */
    msaa?: 1 | 4
    /** A fixed render scale, upscaled after (the page's window view). */
    renderScale?: number
    /** A set for the whole planet (Planet.scatter), on top of the biomes'. */
    planetSet?: unknown
  } = {},
): Promise<ScatterPlanet> {
  const p = await planetApp(gpu, {
    radius: TEST_RADIUS,
    heightScale: 250,
    height: await NoiseGraph.create(TEST_HEIGHT),
    climate: await NoiseGraph.create(TEST_CLIMATE),
    seed: 3,
    width: options.width ?? 160,
    heightPx: options.height ?? 100,
    msaa: options.msaa,
    renderScale: options.renderScale,
    physics: false,
    clearColor: [0.45, 0.6, 0.85, 1],
    extra: [
      ScenePlugin,
      procgenPlugin(),
      scatterPlugin({ workers: options.workers ? platform.workers : undefined }),
      ...(options.extra ?? []),
    ],
  })
  const w = p.world
  await assetServer(w).configure({ platform }).scan()
  const sets = w.initResource(ScatterSet.store)
  const grassland = sets.add(ScatterSet.deserialize(GRASSLAND_SET as never), 'grassland.scatter')
  const forest = sets.add(ScatterSet.deserialize(FOREST_SET as never), 'forest.scatter')
  const rocks = sets.add(ScatterSet.deserialize(ROCK_SET as never), 'rocks.scatter')
  const biomes = w.initResource(Biome.store)
  // Handles as JSON: guid and path, no type.
  const json = (ref: AssetRef) => ({ guid: ref.guid, path: ref.path })
  const biome = (value: Record<string, unknown>) =>
    json(biomes.add(Biome.deserialize(value as never)))
  const set = w.initResource(BiomeSet.store).add(
    BiomeSet.deserialize({
      biomes: [
        biome({
          moisture: [-2, 0.15],
          slope: [0, 24],
          tint: [0.32, 0.5, 0.18, 1],
          scatter: json(grassland),
        }),
        biome({
          moisture: [0.15, 2],
          slope: [0, 24],
          tint: [0.12, 0.3, 0.1, 1],
          scatter: json(forest),
        }),
        biome({ slope: [24, 90], tint: [0.42, 0.4, 0.37, 1], scatter: json(rocks) }),
      ],
      latitudeBias: 0,
    } as never),
  )
  const everywhere = options.planetSet
    ? (sets.add(
        ScatterSet.deserialize(options.planetSet as never),
        'planet.scatter',
      ) as AssetRef<'scatter/ScatterSet'>)
    : null
  w.set(p.planet, Planet, { biomes: set as AssetRef<'terrain/BiomeSet'>, scatter: everywhere })
  return { ...p, sets: [grassland, forest, rocks] }
}

/** Steps until every surface's scatter is ready and nothing is placing (or the frames run out). */
export async function settleScatter(p: PlanetApp, maxFrames = 600): Promise<number> {
  let quiet = 0
  for (let f = 0; f < maxFrames; f++) {
    p.app.update(1 / 60)
    await new Promise((r) => setTimeout(r, 1))
    const state = p.world.resource(Scatter)
    let busy = state.surfaces.size === 0
    for (const ss of state.surfaces.values()) {
      if (ss.problem) throw ss.problem
      if (!ss.ready) busy = true
      for (const c of ss.chunks.values()) {
        if (c.job) busy = true
        const spawning = c.root < 0 || (c.placements !== undefined && c.next < c.placements.count)
        if (c.wanted === state.frame && spawning) busy = true
      }
      for (const fr of ss.foliage.values())
        for (const c of fr.chunks.values()) if (c.job || c.slot < 0) busy = true
    }
    quiet = busy ? 0 : quiet + 1
    if (quiet >= 3) return f
  }
  return maxFrames
}

/**
 * FNV-1a over every spawned prop: its rule, chunk, index and local transform (f32 bits), sorted.
 * The same planet and viewers give the same number on every host.
 */
export function placementChecksum(world: World): { checksum: string; props: number } {
  const rows: string[] = []
  const f = new Float32Array(10)
  const u = new Uint32Array(f.buffer)
  for (const table of world.query({ with: [Prop, Transform] }).tables) {
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]! as Entity
      const p = propIdentity(world, e)!
      const t = world.get(e, Transform)
      f.set(t.translation, 0)
      f.set(t.rotation, 3)
      f.set(t.scale, 7)
      rows.push(`${p.rule}|${p.chunk}|${p.index}|${Array.from(u).join(',')}`)
    }
  }
  rows.sort()
  let h = 0x811c9dc5
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) h = Math.imul(h ^ r.charCodeAt(i), 0x01000193)
    h = Math.imul(h ^ 10, 0x01000193)
  }
  return { checksum: (h >>> 0).toString(16).padStart(8, '0'), props: rows.length }
}
