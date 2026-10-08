import { assetServer, findAssetPreview } from '@aethervtt/shard-assets'
import {
  defineSchema,
  isPlainObject,
  type JsonValue,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  encodePng,
  type PreviewImage,
  previewAsset,
  previewKtx2,
  toBase64,
} from '@aethervtt/shard-protocol'
import type { AppMethod } from '@aethervtt/shard-runtime'
import {
  allGenerators,
  codeHashOf,
  findGenerator,
  type Generator,
  type GenRequest,
  requestOf,
} from './generator'
import { GeneratorBindings, procgen, procgenHost } from './runtime'
import { contactSheet, parseSeeds } from './sheet'

/**
 * The generator a tool names: `star-explorer/Rock`, `scripts:Rock` or `Rock` (when one generator
 * has that name), or a `*.gen.json` path (its seed and params become defaults).
 */
export async function resolveGenerator(
  world: World,
  target: string,
): Promise<{ gen: Generator; seed?: number; params: Record<string, JsonValue>; file?: string }> {
  if (target.includes('.gen.json')) {
    const file = target.split('#')[0]!
    const server = assetServer(world)
    const entry = server.entry(`${file}#Generator`)
    if (!entry) {
      throw new ShardError(
        'procgen/unknown-generator',
        `No generator file "${file}" in the catalog`,
        {
          hint: 'Check the path, or run `shard import` for new files.',
        },
      )
    }
    await server.load(entry.guid)
    const binding = world.resource(GeneratorBindings).get(entry)!
    const gen = findGenerator(binding.generator)
    if (!gen) {
      throw new ShardError('procgen/unknown-generator', `No generator "${binding.generator}"`, {
        path: `${file}/generator`,
      })
    }
    return { gen, seed: binding.seed, params: binding.params ?? {}, file }
  }
  const name = target.startsWith('scripts:') ? target.slice('scripts:'.length) : target
  const exact = findGenerator(name)
  if (exact) return { gen: exact, params: {} }
  const matches = allGenerators().filter((g) => g.name.endsWith(`/${name}`))
  if (matches.length === 1) return { gen: matches[0]!, params: {} }
  // A short name means the project's generator over the engine's (Rock: star-explorer/Rock, not shard/Rock).
  const own = matches.filter((g) => !g.name.startsWith('shard/'))
  if (own.length === 1) return { gen: own[0]!, params: {} }
  throw new ShardError('procgen/unknown-generator', `No generator "${target}"`, {
    hint: matches.length
      ? `Several match: ${matches.map((g) => g.name).join(', ')}.`
      : `Generators: ${
          allGenerators()
            .map((g) => g.name)
            .join(', ') || '(none)'
        }.`,
  })
}

function paramsOf(value: unknown, flag = 'params'): Record<string, JsonValue> {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new ShardError('procgen/bad-params', `"${flag}" must be an object of param values`, {
      path: `/${flag}`,
    })
  }
  return value as Record<string, JsonValue>
}

export interface RunSummary {
  generator: string
  output: string
  path: string
  guid: string
  key: string | undefined
  seed: number
  /** Whether the output came from a cache (memory, disk, or already loaded) instead of a run. */
  cacheHit: boolean
  hit: string
  /** Generation time (the original run's, on a cache hit), ms. */
  ms: number
  vertices?: number
  triangles?: number
  bounds?: JsonValue
  lods?: JsonValue
  texture?: JsonValue
  entities?: number
  components?: JsonValue
  generated?: number
  warnings: { message: string; path?: string }[]
}

/** Makes (or finds) an output and summarizes it. */
export async function runGenerator(world: World, request: GenRequest): Promise<RunSummary> {
  const runtime = procgen(world)
  const gen = findGenerator(request.generator)!
  const entry = runtime.entryFor(request)
  const wasLoaded = entry.state === 'loaded'
  await assetServer(world).load(entry.guid)
  const last = runtime.lastResult(entry.guid)
  const record = runtime.recordOf(entry.guid)
  const main = record?.assets.find((a) => a.label === '')
  const info = (main?.info ?? {}) as Record<string, JsonValue>
  const hit = wasLoaded ? 'loaded' : (last?.hit ?? 'run')
  const out: RunSummary = {
    generator: gen.name,
    output: gen.outputType,
    path: entry.path,
    guid: entry.guid,
    key: last?.key,
    seed: request.seed,
    cacheHit: hit !== 'run',
    hit,
    ms: Math.round((last?.ms ?? 0) * 100) / 100,
    warnings: record?.warnings ?? [],
  }
  if (gen.output === 'mesh') {
    out.vertices = info.vertices as number
    out.triangles = info.triangles as number
    out.bounds = info.bounds
    if (info.lods) out.lods = info.lods
  } else if (gen.output === 'texture') {
    out.texture = { width: info.width!, height: info.height!, usage: info.usage!, mips: info.mips! }
  } else if (gen.output === 'entities') {
    out.entities = info.entities as number
    out.components = info.components
  }
  if (record && record.children.length > 0) out.generated = record.children.length
  return out
}

/** A picture of one output: rendered meshes and entities, textures as they are. */
export async function previewOutput(
  world: World,
  request: GenRequest,
  size: number,
): Promise<PreviewImage> {
  const runtime = procgen(world)
  const gen = findGenerator(request.generator)!
  const entry = runtime.entryFor(request)
  await assetServer(world).load(entry.guid)
  if (gen.output === 'texture') {
    const bytes = runtime.recordOf(entry.guid)?.assets.find((a) => a.label === '')?.bytes
    if (bytes) return previewKtx2(bytes, size, size)
  }
  if (gen.output === 'data') {
    throw new ShardError('procgen/no-preview', `${gen.name} makes data; there's nothing to draw`, {
      hint: 'procgen.run returns the value summary; asset.get shows it.',
    })
  }
  return previewAsset(world, entry.path, size, size)
}

const target = t.string({
  required: true,
  description:
    'A generator ("star-explorer/Rock", or "Rock" when unique) or a *.gen.json path, whose seed and params become defaults.',
})

export const procgenMethods: AppMethod[] = [
  {
    name: 'procgen.run',
    description:
      'Runs a generator (or finds its cached output) and summarizes it: output type, cache key, time, whether it was a cache hit, vertex and triangle counts and bounds (meshes), size (textures), entities and components (entities), nested outputs, warnings. The output is an asset at the returned path (procedural:…).',
    params: defineSchema('procgen/RunParams', {
      generator: target,
      params: t.json({ description: 'Param values; missing ones take the defaults.' }),
      seed: t.u32({ description: "The seed (default: the file's, or 0)." }),
    }),
    handler: async ({ world }, p) => {
      const found = await resolveGenerator(world, p.generator as string)
      const params = { ...found.params, ...paramsOf(p.params) }
      const seed = (p.seed as number) || found.seed || 0
      return runGenerator(world, requestOf(found.gen, params, seed))
    },
  },
  {
    name: 'procgen.preview',
    description:
      'A PNG of a generator output: a mesh in a neutral studio light from a three-quarter view, a texture as is, entities as a scene framed on their bounds. With seeds ("1-9" or [1, 4, 9]) it is a labelled contact sheet, one cell per seed: change a param, preview nine seeds, compare. A *.scatter.json path previews the set on a 64 m patch, from above and at eye level.',
    params: defineSchema('procgen/PreviewParams', {
      generator: target,
      params: t.json({ description: 'Param values.' }),
      seed: t.u32({ description: 'The seed, without seeds.' }),
      seeds: t.json({ description: 'Seeds for a contact sheet: "1-9", "1,5,9", or [1, 5, 9].' }),
      size: t.u32({ default: 256, min: 32, max: 1024, description: 'Pixels per cell.' }),
    }),
    handler: async ({ world }, p) => {
      const size = p.size as number
      // Another previewable asset (a *.scatter.json, 0045): its own preview.
      const asset = assetServer(world).entry(p.generator as string)
      if (asset && !(p.generator as string).includes('.gen.json') && findAssetPreview(asset.type)) {
        const image = await findAssetPreview(asset.type)!(world, asset.path, size * 2, size, {})
        const png = await encodePng(image.data, image.width, image.height)
        return {
          width: image.width,
          height: image.height,
          data: toBase64(png),
          asset: asset.path,
          type: asset.type,
        }
      }
      const found = await resolveGenerator(world, p.generator as string)
      const params = { ...found.params, ...paramsOf(p.params) }
      const seeds =
        p.seeds === undefined || p.seeds === null
          ? undefined
          : parseSeeds(p.seeds as string | number[])
      let image: PreviewImage
      const keys: string[] = []
      if (seeds && seeds.length > 0) {
        const images: PreviewImage[] = []
        for (const seed of seeds) {
          const request = requestOf(found.gen, params, seed)
          images.push(await previewOutput(world, request, size))
          const guid = procgen(world).entryFor(request).guid
          keys.push(procgen(world).lastResult(guid)?.key ?? '')
        }
        image = contactSheet(
          images,
          seeds.map((s) => `seed ${s}`),
          size,
        )
      } else {
        const request = requestOf(found.gen, params, (p.seed as number) || found.seed || 0)
        image = await previewOutput(world, request, size)
        keys.push(procgen(world).lastResult(procgen(world).entryFor(request).guid)?.key ?? '')
      }
      const png = await encodePng(image.data, image.width, image.height)
      return {
        width: image.width,
        height: image.height,
        data: toBase64(png),
        generator: found.gen.name,
        ...(seeds ? { seeds } : {}),
        keys,
      }
    },
  },
  {
    name: 'procgen.describe',
    description:
      'Every generator (params schema with units and ranges, output type, version, code hash), the output cache (records, bytes, limit), counts of runs and cache hits, jobs running now, and whether jobs run on workers.',
    params: defineSchema('procgen/DescribeParams', {}),
    handler: ({ world }) => {
      const runtime = procgen(world)
      const host = procgenHost()
      return {
        generators: allGenerators().map((g) => ({
          name: g.name,
          ...(g.description ? { description: g.description } : {}),
          output: g.outputType,
          version: g.version,
          codeHash: codeHashOf(g),
          params: g.params.jsonSchema(),
        })),
        cache: runtime.cacheStats(),
        stats: { ...runtime.stats, mainMs: Math.round(runtime.stats.mainMs * 100) / 100 },
        inFlight: runtime.inFlight(),
        workers: host.workers && host.workerModule ? host.workers.size : 0,
      }
    },
  },
]
