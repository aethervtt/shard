import type { DataType } from '@shard/assets'
import {
  type AnyField,
  type AssetRef,
  type ComponentDef,
  defineSchema,
  type Fields,
  type FieldValue,
  type InferFields,
  type InitFields,
  isPlainObject,
  type JsonValue,
  ShardError,
} from '@shard/core'
import type { MeshData } from '@shard/mesh'
import type { TextureUsage } from '@shard/texture'
import type { GenContext } from './context'

// --- outputs -----------------------------------------------------------------------------------

/** What a generator makes: a kind, or a data type (0031) whose value it returns. */
export type OutputSpec = 'mesh' | 'texture' | 'data' | 'entities' | DataType

/** A mesh with its levels of detail, as `ctx.mesh.finish` returns it. */
export interface MeshResult {
  readonly kind: 'mesh'
  mesh: MeshData
  /** Lower levels of detail, finest first (sub-assets `#LOD1`, `#LOD2`, …). */
  lods: MeshData[]
}

/** A texture as `Texture.create` takes it: RGBA8 levels, or float RGBA for `usage: 'hdr'`. */
export interface TextureData {
  width: number
  height: number
  /** Default `color` (sRGB). `data` and `normal` are linear; `hdr` levels are Float32Array. */
  usage?: TextureUsage
  /** Level 0 first. With `mipmaps` and one level, the rest are generated. */
  mips: (Uint8Array | Float32Array)[]
  mipmaps?: boolean
}

/**
 * One entity of an `entities` output: a prefab file's entity (0030). Components are by name with
 * JSON values; handles may be refs (`ctx.generate` results, loaded params) or `{ path }`.
 */
export interface FragmentEntity {
  name: string
  components?: Record<string, Record<string, unknown>>
  children?: FragmentEntity[]
}

/** An `entities` output: the root entity (its components merge into the instance), or its children. */
export type Fragment = FragmentEntity | FragmentEntity[]

/** What `run` returns for an output spec. */
export type RunResult<O extends OutputSpec> = O extends 'mesh'
  ? MeshResult | MeshData
  : O extends 'texture'
    ? TextureData
    : O extends 'entities'
      ? Fragment
      : O extends DataType<infer F>
        ? InferFields<F>
        : JsonValue

/** The asset type an output spec makes. */
export type OutputAsset<O extends OutputSpec> = O extends 'mesh'
  ? 'Mesh'
  : O extends 'texture'
    ? 'Texture'
    : O extends 'entities'
      ? 'Prefab'
      : O extends DataType<Fields, infer N>
        ? N
        : 'Data'

// --- definitions -------------------------------------------------------------------------------

export interface GeneratorOptions<P extends Fields, O extends OutputSpec> {
  /** Parameters: a component schema (units, ranges, defaults, handles to what `run` loads). */
  params: P
  output: O
  /** Bump for changes the code hash can't see (a vendored table, say). Default 1. */
  version?: number
  description?: string
  /**
   * Makes the output. Pure: only `ctx.rng`, `ctx.noise`, the params, and what `ctx.load` returns.
   * Returns synchronously, or a promise when it awaits `ctx.generate`.
   */
  run(ctx: GenContext, params: InferFields<P>): RunResult<O> | Promise<RunResult<O>>
}

/**
 * A generator: `(seed, params) → output`, cached by the hash of its inputs. It's also a reference
 * to itself (`type: 'Generator'`), so it can go in a `t.handle('Generator')` field
 * (`GeneratorInstance({ generator: StarSystem })`).
 */
export interface Generator<P extends Fields = Fields, O extends OutputSpec = OutputSpec>
  extends AssetRef<'Generator'> {
  readonly name: string
  readonly description: string | undefined
  readonly params: ComponentDef<P>
  /** The output kind; `data` for data types too. */
  readonly output: 'mesh' | 'texture' | 'data' | 'entities'
  /** The asset type outputs load as: `Mesh`, `Texture`, `Prefab`, a data type's name, or `Data`. */
  readonly outputType: OutputAsset<O>
  /** The data type a `data` output is validated against, if any. */
  readonly dataType: ComponentDef | undefined
  readonly version: number
  readonly run: GeneratorOptions<P, O>['run']
}

const generators = new Map<string, Generator>()
const codeHashes = new Map<string, string>()
const sourceHashes = new Map<string, string>()

/** A small, stable string hash (two FNV-1a lanes, 64 bits as hex). Not for security. */
export function hashString(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
    b ^= b >>> 13
  }
  a ^= a >>> 15
  b ^= b >>> 16
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

function outputOf(spec: OutputSpec): {
  output: Generator['output']
  outputType: string
  dataType: ComponentDef | undefined
} {
  if (spec === 'mesh') return { output: 'mesh', outputType: 'Mesh', dataType: undefined }
  if (spec === 'texture') return { output: 'texture', outputType: 'Texture', dataType: undefined }
  if (spec === 'entities') return { output: 'entities', outputType: 'Prefab', dataType: undefined }
  if (spec === 'data') return { output: 'data', outputType: 'Data', dataType: undefined }
  if (spec && typeof spec === 'object' && typeof spec.name === 'string') {
    return { output: 'data', outputType: spec.name, dataType: spec }
  }
  throw new ShardError('procgen/bad-output', `Unknown generator output ${JSON.stringify(spec)}`, {
    hint: 'Use "mesh", "texture", "data", "entities", or a data type (project.dataAsset).',
  })
}

/**
 * Defines a generator named `name` (namespaced: `shard/Rock` for engine generators; projects use
 * `project.generator`, which prefixes the project name). Defining a name again replaces it (hot
 * reload).
 */
export function defineGenerator<const P extends Fields, const O extends OutputSpec>(
  name: string,
  options: GeneratorOptions<P, O>,
): Generator<P, O> {
  if (!/^[a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new ShardError('procgen/bad-name', `"${name}" isn't a generator name`, {
      hint: 'Generator names are "<namespace>/<Name>", e.g. "star-explorer/Rock".',
    })
  }
  const params = defineSchema(`${name}Params`, options.params, {
    description: `Parameters of the ${name} generator.`,
  })
  const out = outputOf(options.output)
  const version = options.version ?? 1
  const gen: Generator<P, O> = {
    type: 'Generator',
    guid: `generator:${name}`,
    path: name,
    name,
    description: options.description,
    params,
    output: out.output,
    outputType: out.outputType as OutputAsset<O>,
    dataType: out.dataType,
    version,
    run: options.run,
  }
  generators.set(name, gen as unknown as Generator)
  // Without a host-provided hash (the bundler's module graph), the function's source stands in.
  sourceHashes.set(name, hashString(options.run.toString()))
  return gen
}

export function findGenerator(name: string): Generator | undefined {
  return generators.get(name)
}

/** The generator a name or reference names. Throws `procgen/unknown-generator`. */
export function requireGenerator(ref: string | { name?: string; path?: string }): Generator {
  const name = typeof ref === 'string' ? ref : (ref.name ?? ref.path ?? '')
  const gen = generators.get(name)
  if (!gen) {
    throw new ShardError('procgen/unknown-generator', `No generator named "${name}"`, {
      hint: generators.size
        ? `Generators: ${[...generators.keys()].sort().join(', ')}.`
        : 'Define one with project.generator (or defineGenerator) in scripts/.',
    })
  }
  return gen
}

/** Every generator defined in this process, sorted by name. */
export function allGenerators(): Generator[] {
  return [...generators.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Sets generators' code hashes: the hash of each generator's module and what it imports inside
 * `scripts/`, from the bundler's module graph. Hosts call it before (re)loading project code; a
 * generator without one uses the hash of its `run` source.
 */
export function setGeneratorCodeHashes(hashes: Readonly<Record<string, string>>): void {
  codeHashes.clear()
  for (const [name, hash] of Object.entries(hashes)) codeHashes.set(name, hash)
}

export function codeHashOf(gen: Generator | string): string {
  const name = typeof gen === 'string' ? gen : gen.name
  return codeHashes.get(name) ?? sourceHashes.get(name) ?? ''
}

// --- params ------------------------------------------------------------------------------------

const F32_KINDS = new Set([
  'f32',
  'vec2',
  'vec3',
  'vec4',
  'quat',
  'mat3',
  'mat4',
  'affine3x4',
  'color',
])

/** f32 fields rounded to f32, keys sorted: equal inputs give equal text. */
function normalize(field: AnyField | undefined, value: JsonValue): JsonValue {
  // A handle is its path when it has one (guids differ between copies of a project).
  if (field?.kind === 'handle' && isPlainObject(value))
    return typeof value.path === 'string' ? { path: value.path } : value
  if (field && F32_KINDS.has(field.kind)) {
    if (typeof value === 'number') return Math.fround(value)
    if (Array.isArray(value)) return value.map((v) => (typeof v === 'number' ? Math.fround(v) : v))
    return value
  }
  if (field?.kind === 'list' && Array.isArray(value))
    return value.map((v) => normalize(field.item, v))
  if (field?.kind === 'struct' && isPlainObject(value)) return sortFields(field.fields, value)
  if (Array.isArray(value)) return value.map((v) => normalize(undefined, v))
  if (isPlainObject(value)) return sortFields(undefined, value as Record<string, JsonValue>)
  return value
}

function sortFields(
  fields: Fields | undefined,
  value: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const key of Object.keys(value).sort()) out[key] = normalize(fields?.[key], value[key]!)
  return out
}

/**
 * The normalized params: validated, defaults filled in, keys sorted, f32 fields at f32 precision
 * (so `1` and `1.0000000001` are the same inputs), handles as `{ path }` (or `{ guid }`). Throws
 * `procgen/bad-params` with every error in `details`.
 */
export function canonicalParams(gen: Generator, params: unknown = {}): Record<string, JsonValue> {
  const json = toParamJson(params ?? {})
  const errors = gen.params.validate(json)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new ShardError('procgen/bad-params', `${gen.name}: ${first.message}`, {
      path: first.path,
      hint: first.hint ?? `The ${gen.name} params are listed in .agents/generators.md.`,
      details: errors,
    })
  }
  const value = gen.params.serialize(gen.params.deserialize(json))
  return sortFields(gen.params.fields, value as Record<string, JsonValue>)
}

/** Params given in code: refs (`{ type, guid, path }`) become `{ guid, path }`, arrays copy. */
function toParamJson(value: unknown): JsonValue {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(toParamJson)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.type === 'string' && ('guid' in obj || 'path' in obj) && isRef(obj)) {
      const out: Record<string, JsonValue> = {}
      if (typeof obj.guid === 'string') out.guid = obj.guid
      if (typeof obj.path === 'string') out.path = obj.path
      return out
    }
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toParamJson(v)
    return out
  }
  return value as JsonValue
}

function isRef(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (key !== 'type' && key !== 'guid' && key !== 'path' && typeof obj[key] !== 'function')
      return false
  }
  return true
}

// --- requests ----------------------------------------------------------------------------------

/**
 * Param values given in code: any subset (the rest take defaults), with handles as refs or as
 * `{ path }` / `{ guid }`.
 */
export type GenParams<P extends Fields> = {
  [K in keyof P]?: NonNullable<FieldValue<P[K]>> extends AssetRef
    ? { guid?: string; path?: string } | null
    : InitFields<P>[K]
}

/** One output: a generator, its canonical params, and a seed. */
export interface GenRequest {
  readonly generator: string
  readonly params: Record<string, JsonValue>
  readonly seed: number
}

/** Makes a request, validating the params. */
export function requestOf(
  gen: Generator,
  params: GenParams<Fields> | Record<string, unknown> | undefined,
  seed: number,
): GenRequest {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new ShardError('procgen/bad-params', `${gen.name}: seed must be a u32, got ${seed}`, {
      path: '/seed',
      hint: 'Seeds are integers from 0 to 4294967295; derive child seeds with ctx.childSeed.',
    })
  }
  return { generator: gen.name, params: canonicalParams(gen, params), seed: seed >>> 0 }
}

/**
 * A request's identity: which output it names, whatever the code or loaded assets are now. Outputs
 * are registered as `gen:<identity>`, and a code or dependency change swaps the content in place.
 */
export function identityOf(request: GenRequest): string {
  return hashString(JSON.stringify([request.generator, request.params, request.seed]))
}

/** The asset guid of a request's output. */
export function guidOf(request: GenRequest): string {
  return `gen:${identityOf(request)}`
}

// --- procedural refs ---------------------------------------------------------------------------

/** The shortest decimal that is the same f32 (or the number itself when it isn't an f32). */
function shortNumber(n: number): string {
  if (Math.fround(n) !== n || Number.isInteger(n)) return String(n)
  for (let digits = 1; digits < 17; digits++) {
    const text = String(Number(n.toPrecision(digits)))
    if (Math.fround(Number(text)) === n) return text
  }
  return String(n)
}

function formatValue(value: JsonValue): string {
  if (typeof value === 'number') return shortNumber(value)
  if (typeof value === 'boolean') return String(value)
  if (isPlainObject(value) && Object.keys(value).length === 1 && typeof value.path === 'string')
    return encodeURIComponent(value.path)
  return encodeURIComponent(JSON.stringify(value))
}

/**
 * The `procedural:` path of a request (`procedural:star-explorer/Rock?radius=2&seed=3`): params
 * that differ from their defaults, sorted, then the seed. Resolves the same output anywhere.
 */
export function proceduralPath(request: GenRequest): string {
  const gen = requireGenerator(request.generator)
  const defaults = canonicalParams(gen, {})
  const parts: string[] = []
  for (const key of Object.keys(request.params)) {
    const value = request.params[key]!
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue
    // A handle written by path alone: the guid is looked up again on the way in.
    const v = isPlainObject(value) && typeof value.path === 'string' ? { path: value.path } : value
    parts.push(`${key}=${formatValue(v)}`)
  }
  parts.push(`seed=${request.seed}`)
  return `procedural:${request.generator}?${parts.join('&')}`
}

function parseValue(field: AnyField | undefined, raw: string): unknown {
  const text = decodeURIComponent(raw)
  if (field?.kind === 'handle') return { path: text }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text !== '' && Number.isFinite(Number(text))) return Number(text)
  if (/^[[{"]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/**
 * Parses `star-explorer/Rock?seed=3&radius=2` (the part after `procedural:`): numbers, bools,
 * asset paths for handles, JSON for structs and lists. Throws `procgen/unknown-generator` or
 * `procgen/bad-params` (with `path` set to `at`).
 */
export function parseProceduralRef(spec: string, at?: string): GenRequest {
  const hash = spec.indexOf('#')
  const body = hash === -1 ? spec : spec.slice(0, hash)
  const q = body.indexOf('?')
  const name = q === -1 ? body : body.slice(0, q)
  let gen: Generator
  try {
    gen = requireGenerator(name)
  } catch (err) {
    throw new ShardError((err as ShardError).code, (err as ShardError).message, {
      path: at,
      hint: (err as ShardError).hint,
    })
  }
  const params: Record<string, unknown> = {}
  let seed = 0
  if (q !== -1) {
    for (const pair of body.slice(q + 1).split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq))
      const raw = eq === -1 ? '' : pair.slice(eq + 1)
      if (key === 'seed') {
        seed = Number(raw)
        continue
      }
      if (!(key in gen.params.fields)) {
        throw new ShardError('procgen/bad-params', `${gen.name} has no parameter "${key}"`, {
          path: at,
          hint: `Parameters: ${Object.keys(gen.params.fields).join(', ') || '(none)'}, and seed.`,
        })
      }
      params[key] = parseValue(gen.params.fields[key], raw)
    }
  }
  try {
    return requestOf(gen, params, seed)
  } catch (err) {
    const e = err as ShardError
    throw new ShardError(e.code, e.message, { path: at, hint: e.hint, details: e.details })
  }
}
