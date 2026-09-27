import { assetServer, defineAssetPreview } from '@aethervtt/shard-assets'
import { defineSchema, ShardError, t, type World } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { loadNoiseKernel } from './loader'
import { NoiseGraph, NoiseGraphs } from './noise-graph'
import { sampleNoise, sampleOffset } from './sample'
import { type NoiseDomain, noiseStats, previewNoise } from './stats'

/** The most points `noise.sample` returns in one call. */
export const MAX_SAMPLE_POINTS = 4096

/** A graph from an asset path or guid (loaded if needed), or inline graph JSON to try before saving. */
export async function resolveGraph(world: World, graph: unknown): Promise<NoiseGraph> {
  await loadNoiseKernel()
  if (graph && typeof graph === 'object') return NoiseGraph.fromJson(graph)
  if (typeof graph !== 'string') {
    throw new ShardError('noise/invalid-graph', '"graph" is an asset path, a guid, or graph JSON', {
      hint: 'Pass "noise/planet.noise.json", or { "output": …, "nodes": { … } } to try a graph unsaved.',
    })
  }
  const server = assetServer(world)
  const ref = server.resolve(graph)
  if (ref?.type !== 'NoiseGraph') {
    throw new ShardError('noise/not-a-graph', `"${graph}" isn't a noise graph asset`, {
      hint: 'asset.list shows NoiseGraph assets (*.noise.json).',
    })
  }
  await server.load(ref.path ?? graph)
  const loaded = world.resource(NoiseGraphs).get(ref)
  if (!loaded)
    throw new ShardError('noise/not-loaded', `"${graph}" didn't load`, {
      hint: 'asset.status shows why.',
    })
  return loaded
}

const graphField = t.json({
  required: true,
  description: 'A NoiseGraph asset path or guid, or inline graph JSON (tried without saving).',
})

export const noiseMethods: AppMethod[] = [
  {
    name: 'noise.sample',
    description: `Values of a noise graph at up to ${MAX_SAMPLE_POINTS} points ([x, y, z], or [x, y, z, w] for 4D graphs). With origin, points are offsets from it (precise at any distance). node samples an intermediate node.`,
    params: defineSchema('noise/SampleParams', {
      graph: graphField,
      seed: t.u32({ default: 0 }),
      points: t.json({ required: true, description: 'Points: [[x, y, z], …].' }),
      origin: t.json({ description: 'f64 origin [x, y, z] the points are relative to.' }),
      node: t.string({ description: 'Sample this node instead of the output.' }),
    }),
    handler: async ({ world }, p) => {
      const graph = await resolveGraph(world, p.graph)
      const points = p.points as number[][]
      if (!Array.isArray(points) || points.length > MAX_SAMPLE_POINTS) {
        throw new ShardError(
          'noise/too-many-points',
          `points is an array of at most ${MAX_SAMPLE_POINTS} points`,
          {
            hint: 'Split the points over several calls, or use noise.stats for a summary of a whole domain.',
          },
        )
      }
      const stride = graph.program.dimensions === 4 ? 4 : 3
      const flat = new Float32Array(points.length * stride)
      points.forEach((pt, i) => {
        for (let k = 0; k < stride; k++) flat[i * stride + k] = pt[k] ?? 0
      })
      const out = new Float32Array(points.length)
      const node = (p.node as string | null | undefined) || undefined
      if (Array.isArray(p.origin))
        sampleOffset(graph, p.seed as number, p.origin as number[], flat, out, node)
      else sampleNoise(graph, p.seed as number, flat, out, node)
      return { values: Array.from(out, (v) => Math.round(v * 1e6) / 1e6) }
    },
  },
  {
    name: 'noise.stats',
    description:
      'Samples a noise graph over a plane or a sphere and summarizes it: min, max, mean, stdDev, a 16-bin histogram, and the fraction below each threshold (sphere samples weighted by area, so "below 0" is the share of the surface). Check coverage numerically, e.g. how much of a planet is under sea level.',
    params: defineSchema('noise/StatsParams', {
      graph: graphField,
      seed: t.u32({ default: 0 }),
      domain: t.enum(['plane', 'sphere'], { default: 'plane' }),
      size: t.f64({ description: 'Plane side (default: 2 × extent, or 4).' }),
      radius: t.f64({ description: 'Sphere radius (default: extent, or 1).' }),
      resolution: t.u32({ description: 'Samples per side (per face for spheres).', max: 1024 }),
      node: t.string({ description: 'Summarize this node instead of the output.' }),
      thresholds: t.json({ description: 'Values to report the fraction below, e.g. [0].' }),
    }),
    handler: async ({ world }, p) => {
      const graph = await resolveGraph(world, p.graph)
      const domain: NoiseDomain = {
        kind: p.domain as 'plane' | 'sphere',
        // Absent numbers arrive as 0: only positive sizes count.
        ...(typeof p.size === 'number' && p.size > 0 ? { size: p.size } : {}),
        ...(typeof p.radius === 'number' && p.radius > 0 ? { radius: p.radius } : {}),
        ...(typeof p.resolution === 'number' && p.resolution > 0
          ? { resolution: p.resolution }
          : {}),
      }
      return noiseStats(graph, p.seed as number, domain, {
        node: (p.node as string | null | undefined) || undefined,
        thresholds: Array.isArray(p.thresholds) ? (p.thresholds as number[]) : [],
      })
    },
  },
]

// asset.preview for NoiseGraph: { domain, seed, size, node } in options.
export const noiseGraphPreview = defineAssetPreview(
  'NoiseGraph',
  async (world, path, width, height, options) => {
    const graph = await resolveGraph(world, path)
    const o = (options ?? {}) as Record<string, unknown>
    return previewNoise(graph, width, height, {
      ...(o.domain === 'sphere' ? { domain: 'sphere' as const } : {}),
      ...(typeof o.seed === 'number' ? { seed: o.seed } : {}),
      ...(typeof o.size === 'number' ? { size: Math.max(16, Math.min(2048, o.size)) } : {}),
      ...(typeof o.node === 'string' ? { node: o.node } : {}),
      ...(typeof o.span === 'number' ? { span: o.span } : {}),
    })
  },
)
