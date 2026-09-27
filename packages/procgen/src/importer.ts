import {
  defineAssetSchema,
  defineImportDependency,
  defineImporter,
  type ImportedAsset,
} from '@aethervtt/shard-assets'
import { defineSchema, isPlainObject, type JsonValue, ShardError } from '@aethervtt/shard-core'
import { codeHashOf, findGenerator, type Generator, requestOf, requireGenerator } from './generator'
import type { JobDependency } from './job'
import { paramHandles, runJob } from './runtime'
import { genFileSchema } from './schema'

const NoSettings = defineSchema(
  'procgen/NoSettings',
  {},
  { description: 'None: the generator, seed, and params are the file.' },
)

/** What a generator's cache entry depends on besides its params: its version and code hash. */
function generatorHash(gen: Generator): string {
  return `${gen.version}:${codeHashOf(gen)}`
}

export const generatorDependency = defineImportDependency('generator:', (id) => {
  const gen = findGenerator(id.slice('generator:'.length))
  return gen ? generatorHash(gen) : undefined
})

export const generatorSchema = defineAssetSchema('gen.schema.json', genFileSchema)

/** The parsed body of a generator file. */
export interface GenFile {
  generator: string
  seed: number
  params: Record<string, JsonValue>
}

/** Parses and checks a `*.gen.json` file's shape (not its params). Errors point into the file. */
export function parseGenFile(text: string, path: string): GenFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw new ShardError('procgen/bad-file', `${path} isn't valid JSON`, { path: '', cause })
  }
  if (!isPlainObject(json)) {
    throw new ShardError('procgen/bad-file', `${path} must be a JSON object`, { path: '' })
  }
  for (const key of Object.keys(json)) {
    if (!['$schema', 'generator', 'seed', 'params'].includes(key)) {
      throw new ShardError('procgen/bad-file', `Unknown field "${key}"`, {
        path: `/${key}`,
        hint: 'A generator file has "generator", "seed", and "params".',
      })
    }
  }
  if (typeof json.generator !== 'string' || json.generator === '') {
    throw new ShardError('procgen/bad-file', '"generator" must name a generator', {
      path: '/generator',
      hint: 'e.g. "star-explorer/Rock" (.agents/generators.md lists them).',
    })
  }
  const seed = json.seed ?? 0
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new ShardError('procgen/bad-params', '"seed" must be an integer from 0 to 4294967295', {
      path: '/seed',
    })
  }
  const params = json.params ?? {}
  if (!isPlainObject(params)) {
    throw new ShardError('procgen/bad-params', '"params" must be an object', { path: '/params' })
  }
  return { generator: json.generator, seed, params: params as Record<string, JsonValue> }
}

/**
 * `*.gen.json`: a generator, a seed, and params. Imports as the generator's output (a `Mesh` with
 * `#LOD1…` sub-assets, a `Texture`, a data value, or a `Prefab`), cached like any asset, plus a
 * `#Generator` sub-asset that `GeneratorInstance` can point at. Re-imports when the file, a loaded
 * asset, or the generator's code changes.
 */
export const GeneratorImporter = defineImporter({
  name: 'procgen',
  version: 1,
  extensions: ['.gen.json'],
  settings: NoSettings,
  async import(source, ctx) {
    const file = parseGenFile(source.text(), source.path)
    let gen: Generator
    try {
      gen = requireGenerator(file.generator)
    } catch (err) {
      throw new ShardError('procgen/unknown-generator', (err as ShardError).message, {
        path: '/generator',
        hint: (err as ShardError).hint,
      })
    }
    let request: ReturnType<typeof requestOf>
    try {
      request = requestOf(gen, file.params, file.seed)
    } catch (err) {
      const e = err as ShardError
      throw new ShardError(e.code, e.message, {
        path: e.path === '/seed' ? '/seed' : `/params${e.path ?? ''}`,
        hint: e.hint,
        details: e.details,
      })
    }
    ctx.depend(`generator:${gen.name}`, generatorHash(gen))
    const deps: JobDependency[] = []
    for (const ref of paramHandles(gen, request.params)) {
      if (!ref.path) continue
      const asset = await ctx.asset(`/${ref.path}`)
      deps.push({ guid: asset.guid, path: ref.path, type: asset.type, artifact: asset.artifact })
    }
    const result = await runJob({ ...request, deps, chain: [] })
    for (const w of result.warnings) ctx.warn(w.message, w.path)
    const assets: ImportedAsset[] = result.assets.map((a) => {
      const out: ImportedAsset = { label: a.label, type: a.type }
      if (a.bytes) out.bytes = a.bytes
      if (a.json !== undefined) out.json = a.json
      const info: Record<string, JsonValue> = { ...(a.info ?? {}) }
      if (a.label === '') {
        info.generator = gen.name
        info.seed = request.seed
        info.ms = Math.round(result.ms * 10) / 10
        if (result.children.length > 0) info.generated = result.children.length
      }
      out.info = info
      return out
    })
    assets.push({
      label: 'Generator',
      type: 'Generator',
      json: { generator: gen.name, seed: request.seed, params: request.params },
    })
    return { assets }
  },
})
