import {
  defineSchema,
  type Entity,
  findComponent,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { encodePng, toBase64 } from '@aethervtt/shard-protocol'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { collidersOf } from './colliders'
import { TerrainWorld, terrainSample } from './heights'
import type { PlanetRuntime } from './planet'
import type { PlanetRender } from './render'

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  const v = world.tryGet(entity, member) as { path?: string } | undefined
  return v?.path || null
}

/** A planet from an entity id or scene path; the only planet when omitted. */
export function resolvePlanet(world: World, ref: unknown): PlanetRuntime {
  const planets = world.tryResource(TerrainWorld)?.planets
  if (!planets || planets.size === 0) {
    throw new ShardError('terrain/no-planet', 'There is no terrain/Planet in the world', {
      hint: 'Add terrain/Planet (with a Grid) to an entity, and the terrain plugin to the app.',
    })
  }
  if (ref === undefined || ref === null || ref === '') {
    if (planets.size > 1) {
      throw new ShardError('terrain/which-planet', `There are ${planets.size} planets; name one`, {
        hint: 'Pass planet: an entity id or a scene path (terrain.describe lists them).',
      })
    }
    return [...planets.values()][0]!
  }
  for (const rt of planets.values()) {
    if (rt.entity === ref) return rt
    const path = scenePath(world, rt.entity)
    if (typeof ref === 'string' && path && (path === ref || path.endsWith(`/${ref}`))) return rt
  }
  throw new ShardError('terrain/not-a-planet', `No planet matches ${JSON.stringify(ref)}`, {
    hint: 'terrain.describe lists every planet with its entity and scene path.',
  })
}

function usable(rt: PlanetRuntime): void {
  if (rt.problem) throw rt.problem
  if (!rt.ready) {
    throw new ShardError(
      'terrain/not-ready',
      `The planet is waiting for ${rt.waiting ?? 'its settings'}`,
      {
        hint: 'Its graphs and biomes load asynchronously; step a frame and ask again.',
      },
    )
  }
}

const round = (v: number, digits = 3) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/** A direction from [lat, lon] in degrees: lat from the planet's +Y axis, lon around it from +Z. */
function latlon(lat: number, lon: number): number[] {
  const a = (lat * Math.PI) / 180
  const b = (lon * Math.PI) / 180
  return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]
}

function describePlanet(world: World, rt: PlanetRuntime) {
  const s = rt.settings
  const byDepth: number[] = []
  const t = rt.tree
  let partial = 0
  for (let i = 0; i < rt.selection.renderedCount; i++) {
    const n = rt.selection.rendered[i]!
    byDepth[t.depth[n]!] = (byDepth[t.depth[n]!] ?? 0) + 1
    if (t.mask[n] !== 15) partial++
  }
  const pr = rt.parts.get('render') as PlanetRender | undefined
  const colliders = collidersOf(rt)
  let underCamera: ReturnType<typeof terrainSample> | null = null
  if (pr?.hasCamera && rt.ready) {
    const p = pr.view.position
    underCamera = terrainSample(rt, [p[0]!, p[1]!, p[2]!])
  }
  return {
    entity: rt.entity,
    path: scenePath(world, rt.entity),
    ready: rt.ready,
    waitingFor: rt.waiting,
    problem: rt.problem ? rt.problem.toJSON() : null,
    radius: s?.radius ?? null,
    heightScale: s?.heightScale ?? null,
    ocean: s ? (s.ocean ? { seaLevel: s.seaLevel } : null) : null,
    maxDepth: rt.maxDepth,
    colliderDepth: rt.colliderDepth,
    spacing: {
      finest: round(rt.spacing(rt.maxDepth)),
      colliders: round(rt.spacing(rt.colliderDepth)),
    },
    version: rt.version,
    biomes: rt.table.count,
    detail: {
      vertexPixels: s?.vertexPixels ?? null,
      // Over TerrainBudget.triangles the LOD bias rises above 1 (coarser), and falls back after.
      lodBias: round(rt.lodBias),
      triangles: rt.selection.renderedCount * 2 * ((s?.resolution ?? 33) - 1) ** 2,
    },
    selected: {
      chunks: rt.selection.renderedCount,
      byDepth: Object.fromEntries(byDepth.flatMap((c, d) => (c ? [[d, c]] : []))),
      partial,
      ocean: rt.oceanSelection.renderedCount,
      requested: rt.selection.requestedCount + rt.oceanSelection.requestedCount,
      waiting: rt.selection.waiting,
      walks: rt.selection.passes,
    },
    pool: pr
      ? {
          slots: pr.slots.length,
          shown: pr.slots.filter((x) => x.shown).length,
          inFlight: pr.jobs.length,
          generated: pr.stats.generated,
          fromColliders: pr.stats.fromColliders,
          evicted: pr.stats.evicted,
          readbacks: pr.stats.readbacks,
          jobsLastFrame: pr.stats.lastFrameJobs,
        }
      : null,
    colliders: {
      chunks: colliders.chunks.size,
      active: [...colliders.chunks.values()].filter((c) => c.entity >= 0).length,
      pending: colliders.jobs.size,
      builtOnPool: colliders.builtPool,
      builtOnMainThread: colliders.builtSync,
      anchors: rt.anchors,
    },
    underCamera: underCamera
      ? {
          height: round(underCamera.height),
          underwater: underCamera.underwater,
          biome: underCamera.biome,
          slope: round(underCamera.slope, 1),
        }
      : null,
    treeNodes: rt.tree.live,
  }
}

/** Pixels of an equirectangular map: height (sea blue by depth, land dark to light) or biomes. */
export function terrainMap(rt: PlanetRuntime, width: number, mode: 'height' | 'biomes') {
  usable(rt)
  const height = Math.max(1, Math.round(width / 2))
  const data = new Uint8Array(width * height * 4)
  const s = rt.settings!
  const top = Math.max(1, rt.highest - Math.max(s.seaLevel, rt.lowest))
  const low = Math.max(1, (s.ocean ? s.seaLevel : 0) - rt.lowest)
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width) * 360 - 180
      const sample = terrainSample(rt, latlon(lat, lon))
      const o = (y * width + x) * 4
      let r: number
      let g: number
      let b: number
      if (sample.underwater) {
        const d = Math.min(1, sample.depth / low)
        r = 20 * (1 - d)
        g = 90 * (1 - d) + 20
        b = 200 - 110 * d
      } else if (mode === 'height') {
        const k = Math.min(
          1,
          Math.max(0, (sample.height - (s.ocean ? s.seaLevel : rt.lowest)) / top),
        )
        r = 40 + 215 * k
        g = 80 + 175 * k
        b = 40 + 215 * k
      } else {
        const tint = rt.table.tints.subarray(sample.biome * 4, sample.biome * 4 + 4)
        const shade = 0.75 + 0.25 * Math.cos((sample.slope * Math.PI) / 180)
        r = Math.min(255, tint[0]! ** (1 / 2.2) * 255 * shade)
        g = Math.min(255, tint[1]! ** (1 / 2.2) * 255 * shade)
        b = Math.min(255, tint[2]! ** (1 / 2.2) * 255 * shade)
      }
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return { width, height, data }
}

const planetField = t.json({
  description: 'The planet: entity id or scene path (default: the only planet).',
})

export const terrainMethods: AppMethod[] = [
  {
    name: 'terrain.describe',
    description:
      'Planet terrain as data: per planet, the chunks selected by depth (and partial ones waiting for children), requests and chunks in flight, pool usage, generation counts, collider chunks and anchors, the vertex spacing at the finest and collider depths, and the height, biome, and slope under the camera. Problems (a bad radius, a climate graph without temperature/moisture) and what it waits for are here too.',
    params: defineSchema('terrain/DescribeParams', { planet: planetField }),
    handler: ({ world }, p) => {
      const planets = world.tryResource(TerrainWorld)?.planets
      if (!planets) return { planets: [] }
      if (p.planet !== undefined && p.planet !== null && p.planet !== '')
        return { planets: [describePlanet(world, resolvePlanet(world, p.planet))] }
      return { planets: [...planets.values()].map((rt) => describePlanet(world, rt)) }
    },
  },
  {
    name: 'terrain.sample',
    description:
      'The surface at points on a planet, from the CPU noise the colliders use (headless-safe): height (m above radius), underwater and water depth, slope (degrees), climate, and biome weights with the dominant biome. Points are directions from the planet center in its frame ([x, y, z], any length) or [lat, lon] in degrees (lat from the +Y axis’s equator, lon around it).',
    params: defineSchema('terrain/SampleParams', {
      planet: planetField,
      directions: t.json({ description: 'Directions: [[x, y, z], …] (at most 4096).' }),
      latlon: t.json({ description: 'Latitudes and longitudes in degrees: [[lat, lon], …].' }),
    }),
    handler: ({ world }, p) => {
      const rt = resolvePlanet(world, p.planet)
      usable(rt)
      const dirs: number[][] = []
      if (Array.isArray(p.directions)) for (const d of p.directions as number[][]) dirs.push(d)
      if (Array.isArray(p.latlon))
        for (const [a, b] of p.latlon as number[][]) dirs.push(latlon(a!, b!))
      if (dirs.length === 0 || dirs.length > 4096) {
        throw new ShardError(
          'terrain/bad-points',
          'Pass 1 to 4096 points in directions or latlon',
          {
            hint: 'e.g. { "latlon": [[0, 0], [45, 90]] }, or { "directions": [[0, 1, 0]] } for the north pole.',
          },
        )
      }
      return {
        samples: dirs.map((d) => {
          const s = terrainSample(rt, d)
          return {
            height: round(s.height),
            underwater: s.underwater,
            depth: round(s.depth),
            slope: round(s.slope, 2),
            temperature: round(s.temperature),
            moisture: round(s.moisture),
            latitude: round(s.latitude),
            biome: s.biome,
            biomes: s.biomes.map((w) => round(w)),
          }
        }),
      }
    },
  },
  {
    name: 'terrain.map',
    description:
      'An equirectangular PNG of a planet (width × width/2; latitude +90 at the top, longitude −180 to 180 left to right): mode "biomes" colors land by its dominant biome’s tint (shaded by slope), mode "height" dark lowlands to white peaks; water is blue, darker when deeper. One image answers "are there continents, oceans, and polar caps".',
    params: defineSchema('terrain/MapParams', {
      planet: planetField,
      size: t.u32({ default: 256, min: 16, max: 1024, description: 'Width in pixels.' }),
      mode: t.enum(['biomes', 'height']),
    }),
    handler: async ({ world }, p) => {
      const rt = resolvePlanet(world, p.planet)
      const image = terrainMap(rt, p.size as number, p.mode as 'height' | 'biomes')
      const png = await encodePng(image.data, image.width, image.height)
      return { width: image.width, height: image.height, data: toBase64(png) }
    },
  },
]
