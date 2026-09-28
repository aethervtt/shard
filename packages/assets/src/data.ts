import {
  type AnyField,
  type AssetRef,
  type ComponentDef,
  type ComponentOptions,
  cloneData,
  defineResource,
  defineSchema,
  type Fields,
  type InferFields,
  isPlainObject,
  isRedefinable,
  type JsonSchema,
  type JsonValue,
  pointer,
  type ResourceDef,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { assetServer, normalizePath } from './server'
import { AssetStore } from './store'
import {
  type AssetTypeDef,
  defineAssetSchema,
  defineAssetType,
  defineImporter,
  findAssetType,
  findImporter,
  type ImportContext,
  type ImporterDef,
  type ImportResult,
  type ImportSource,
  type LoadContext,
  registryConflict,
} from './types'

const NoSettings = defineSchema('assets/NoSettings', {}, { description: 'No import settings.' })

const decoder = new TextDecoder()

/** A number that changes whenever the schema does, so a changed type re-imports its files. */
function schemaVersion(schema: ComponentDef): number {
  const text = JSON.stringify(schema.jsonSchema())
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0 || 1
}

/** The file format's JSON Schema: the type's fields plus `$schema` and `$extends`. */
function fileSchema(schema: ComponentDef): JsonSchema {
  const base = schema.jsonSchema()
  return {
    ...base,
    properties: {
      $schema: { type: 'string', description: 'Path to this JSON Schema, for editors.' },
      $extends: {
        type: 'object',
        description:
          'Makes this file a variant: it starts from the base file (same type) and overrides fields.',
        properties: { path: { type: 'string', minLength: 1 } },
        required: ['path'],
        additionalProperties: false,
      },
      ...(base.properties as Record<string, JsonSchema>),
    },
  }
}

interface DataFile {
  body: Record<string, unknown>
  extends: unknown
}

function parseDataFile(path: string, text: string): DataFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw new ShardError('assets/import-failed', `${path} isn't valid JSON`, { path: '', cause })
  }
  if (!isPlainObject(json)) {
    throw new ShardError('assets/import-failed', `${path} must be a JSON object`, { path: '' })
  }
  const { $schema: _, $extends, ...body } = json
  return { body, extends: $extends }
}

/**
 * Where a `$extends` in `from` points. The importer resolves paths against the file being imported;
 * a base's own relative `$extends` is relative to the base.
 */
function resolveBase(
  ctx: ImportContext,
  source: string,
  from: string,
  ref: unknown,
  at: string,
): string {
  if (!isPlainObject(ref) || typeof ref.path !== 'string' || ref.path === '') {
    throw new ShardError('schema/type-mismatch', `"$extends" in ${from} must be { "path": ... }`, {
      path: at,
      hint: 'Give the base file by path: { "path": "data/weapons/laser.weapon.json" }.',
    })
  }
  const path = ref.path
  if (from === source || path.startsWith('/')) return ctx.resolve(path)
  const viaSource = ctx.resolve(path)
  // A path that starts at an asset root resolves to itself; others are relative to `from`.
  if (viaSource === normalizePath(path)) return viaSource
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  return normalizePath(`${dir}/${path}`)
}

/**
 * Merges one file over the value so far: struct fields merge field by field, everything else
 * (numbers, lists, handles) replaces. Records which file set each field.
 */
function mergeLayer(
  fields: Fields | undefined,
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
  at: string,
  file: string,
  setBy: Map<string, string>,
): void {
  for (const [key, value] of Object.entries(layer)) {
    const path = pointer(at, key)
    const field = fields?.[key]
    const current = target[key]
    if (field?.kind === 'struct' && isPlainObject(value) && isPlainObject(current)) {
      mergeLayer(field.fields, current, value, path, file, setBy)
      continue
    }
    target[key] = cloneData(value)
    for (const k of [...setBy.keys()]) if (k.startsWith(`${path}/`)) setBy.delete(k)
    setBy.set(path, file)
  }
}

/** The file that set the value at a JSON pointer (the importing file if none did). */
function ownerOf(setBy: Map<string, string>, path: string | undefined, fallback: string): string {
  let best = ''
  let owner = fallback
  for (const [k, file] of setBy) {
    if ((path === k || path?.startsWith(`${k}/`)) && k.length > best.length) {
      best = k
      owner = file
    }
  }
  return owner
}

async function importData(
  source: ImportSource,
  ctx: ImportContext,
  type: string,
  schema: ComponentDef,
  extension: string,
): Promise<ImportResult> {
  const own = parseDataFile(source.path, source.text())
  // The chain from this file down to its root base: each layer merges over the one before it.
  const layers: { path: string; body: Record<string, unknown> }[] = [
    { path: source.path, body: own.body },
  ]
  const chain = [source.path]
  let next = own.extends
  let from = source.path
  while (next !== undefined) {
    const at = from === source.path ? '/$extends' : ''
    const basePath = resolveBase(ctx, source.path, from, next, at)
    if (chain.includes(basePath)) {
      throw new ShardError(
        'data/extends-cycle',
        `${[...chain, basePath].join(' → ')} extends itself`,
        { path: '/$extends', hint: 'Point "$extends" at a file that does not extend this one.' },
      )
    }
    if (!basePath.toLowerCase().endsWith(extension)) {
      throw new ShardError(
        'data/extends-type-mismatch',
        `${from} extends ${basePath}, which isn't a ${type} (*${extension})`,
        { path: '/$extends', hint: `A variant's base must be another *${extension} file.` },
      )
    }
    let bytes: Uint8Array
    try {
      bytes = await ctx.read(`/${basePath}`)
    } catch (cause) {
      throw new ShardError('assets/not-found', `${from} extends ${basePath}, which doesn't exist`, {
        path: '/$extends',
        hint: 'Check the path; it starts at the project root, e.g. "data/weapons/laser.weapon.json".',
        cause,
      })
    }
    const base = parseDataFile(basePath, decoder.decode(bytes))
    chain.push(basePath)
    layers.unshift({ path: basePath, body: base.body })
    next = base.extends
    from = basePath
  }

  const merged: Record<string, unknown> = {}
  const setBy = new Map<string, string>()
  for (const layer of layers) mergeLayer(schema.fields, merged, layer.body, '', layer.path, setBy)

  const errors = schema.validate(merged)
  if (errors.length > 0) {
    const first = errors[0]!
    const owner = ownerOf(setBy, first.path, source.path)
    const where = owner === source.path ? source.path : `${owner} (a base of ${source.path})`
    throw new ShardError(
      'assets/import-failed',
      `${where}: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
      { path: first.path, hint: first.hint, details: errors },
    )
  }
  const value = schema.serialize(schema.deserialize(merged))

  // Any asset path the data mentions (a material's textures, a weapon's prefab) loads first.
  const dependencies = new Set<string>()
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        if (k === 'path' && typeof item === 'string' && !item.startsWith('procedural:'))
          dependencies.add(item)
        else collect(item)
      }
    }
  }
  collect(value)
  const info: Record<string, JsonValue> | undefined =
    chain.length > 1
      ? {
          extends: chain.slice(1),
          setBy: Object.fromEntries([...setBy].sort(([a], [b]) => a.localeCompare(b))),
        }
      : undefined
  return {
    assets: [
      {
        label: '',
        type,
        json: value,
        ...(dependencies.size ? { dependencies: [...dependencies] } : {}),
        ...(info ? { info } : {}),
      },
    ],
  }
}

/**
 * A JSON data asset validated by a schema: `*.<extension>.json` files import as `type`. Errors
 * point into the file. A file can `$extends` another of the same type and override fields; the
 * artifact is the merged, normalized value, so defaults are filled in once. The importer version
 * follows the schema, so changing the schema re-imports every file.
 */
export function defineDataAsset(
  type: string,
  schema: ComponentDef,
  options: { extension: string },
): ImporterDef {
  const name = `data/${options.extension}`
  const extension = `.${options.extension}.json`
  const existing = findImporter(name)
  if (
    existing &&
    existing.dataType !== type &&
    !(existing.dataType !== undefined && isRedefinable(existing.dataType))
  ) {
    throw new ShardError(
      'assets/duplicate-extension',
      `"*${extension}" is already imported as ${existing.dataType ?? existing.name}`,
      { hint: 'Every data type needs its own extension. Pick another one.' },
    )
  }
  const published = defineAssetSchema(`${options.extension}.schema.json`, () => fileSchema(schema))
  return defineImporter({
    name,
    version: schemaVersion(schema),
    extensions: [extension],
    settings: NoSettings,
    dataType: type,
    schema,
    fileSchema: published,
    import: (source, ctx) => importData(source, ctx, type, schema, extension),
  })
}

// --- project data types ------------------------------------------------------------------------

/** A data asset type: its schema (this object), asset type, store, and importer. */
export interface DataType<F extends Fields = Fields, N extends string = string>
  extends ComponentDef<F> {
  readonly name: N
  /** Files are `*.<extension>.json`. */
  readonly extension: string
  readonly type: AssetTypeDef<InferFields<F>>
  /** The loaded values by guid: `world.resource(Weapon.store).get(ref)`. */
  readonly store: ResourceDef<AssetStore<InferFields<F>, N>>
  readonly importer: ImporterDef
}

export interface DataTypeOptions extends Pick<ComponentOptions, 'version' | 'migrate'> {
  /** Files are `*.<extension>.json`. Unique across importers. */
  extension: string
  description?: string
}

const dataTypes = new Map<string, DataType>()
/** Each data type's definition as a string: an equal one defined again is the same type (0052). */
const dataSignatures = new Map<string, string>()

/** Fills in the guid of every handle in a loaded value, so store lookups work without a path. */
function resolveHandles(fields: Fields, value: Record<string, unknown>, ctx: LoadContext): void {
  for (const key in fields) resolveHandle(fields[key]!, value[key], ctx)
}

function resolveHandle(field: AnyField, value: unknown, ctx: LoadContext): void {
  if (value === null || value === undefined) return
  if (field.kind === 'handle') {
    const ref = value as AssetRef
    const resolved = ctx.resolve(ref.path ?? ref.guid ?? '')
    if (resolved) {
      ref.guid = resolved.guid
      ref.path = resolved.path
    }
  } else if (field.kind === 'struct' && field.fields) {
    resolveHandles(field.fields, value as Record<string, unknown>, ctx)
  } else if (field.kind === 'list' && field.item) {
    for (const item of value as unknown[]) resolveHandle(field.item, item, ctx)
  }
}

/**
 * Defines a data asset type from component-schema fields: `*.<extension>.json` files are
 * validated, imported, and loaded into `store` as plain values. Reloads update the stored object in
 * place, so code holding it sees new numbers. Projects use `project.dataAsset`.
 */
export function defineDataType<const N extends string, const F extends Fields>(
  name: N,
  fields: F,
  options: DataTypeOptions,
): DataType<F, N> {
  const signature = JSON.stringify({
    extension: options.extension,
    version: options.version ?? null,
    description: options.description ?? null,
    fields: Object.entries(fields).map(([key, field]) => [key, field.jsonSchema()]),
  })
  const existing = dataTypes.get(name)
  if (existing && !isRedefinable(name)) {
    // Two apps loading the same project define its data types twice: that's one type.
    if (dataSignatures.get(name) === signature) return existing as unknown as DataType<F, N>
    throw registryConflict('Data type', name)
  }
  const schema = defineSchema(name, fields, {
    description: options.description,
    version: options.version,
    migrate: options.migrate,
  })
  const store = defineResource<AssetStore<InferFields<F>, N>>(`${name}Assets`, {
    description: `Loaded ${name} data assets, by guid.`,
    init: () => new AssetStore<InferFields<F>, N>(name),
  })
  const type = defineAssetType<InferFields<F>>(name, {
    store: store as unknown as ResourceDef<AssetStore<InferFields<F>>>,
    load: (artifact, ctx) => {
      const value = schema.deserialize(artifact.json) as Record<string, unknown>
      resolveHandles(fields, value, ctx)
      return value as InferFields<F>
    },
    update: (existing, next) => {
      const target = existing as Record<string, unknown>
      for (const key of Object.keys(target)) if (!(key in next)) delete target[key]
      Object.assign(target, next)
    },
  })
  const importer = defineDataAsset(name, schema, { extension: options.extension })
  const def: DataType<F, N> = {
    ...schema,
    name,
    extension: options.extension,
    type,
    store,
    importer,
  }
  dataTypes.set(name, def as unknown as DataType)
  dataSignatures.set(name, signature)
  return def
}

export function findDataType(name: string): DataType | undefined {
  return dataTypes.get(name)
}

/** Every data type defined with `defineDataType`, sorted by name. */
export function allDataTypes(): DataType[] {
  return [...dataTypes.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// --- runtime -----------------------------------------------------------------------------------

/**
 * Loads every asset of a type (optionally under a path prefix) and resolves to their values, sorted
 * by path. Assets that fail to load are left out (their errors are logged). For item databases and
 * loot tables.
 */
export function loadAll<F extends Fields, N extends string>(
  world: World,
  type: DataType<F, N>,
  options?: { prefix?: string },
): Promise<InferFields<F>[]>
export function loadAll(
  world: World,
  type: string,
  options?: { prefix?: string },
): Promise<unknown[]>
export async function loadAll(
  world: World,
  type: string | DataType,
  options: { prefix?: string } = {},
): Promise<unknown[]> {
  const name = typeof type === 'string' ? type : type.name
  const def = findAssetType(name)
  if (!def) {
    throw new ShardError('assets/unknown-type', `No asset type "${name}" is registered`, {
      hint: 'Define it (project.dataAsset) before loading its files.',
    })
  }
  const server = assetServer(world)
  const entries = server.all(name, options)
  await Promise.allSettled(entries.map((e) => server.load(e.guid)))
  const store = world.initResource(def.store)
  const out: unknown[] = []
  for (const e of entries) {
    const value = store.byGuid(e.guid)
    if (value !== undefined) out.push(value)
  }
  return out
}

/**
 * Checks the handles in every imported data asset (and whatever an importer's `check` covers) against the catalog: each must name an asset
 * that exists and has the field's type (`schema/asset-type-mismatch`). Importing can't check this,
 * since the catalog is still being built; `shard validate` runs it after a scan.
 */
export async function validateDataAssets(
  world: World,
): Promise<{ source: string; errors: ShardError[] }[]> {
  const server = assetServer(world)
  const out: { source: string; errors: ShardError[] }[] = []
  for (const entry of server.list()) {
    if (entry.label !== '' || entry.source === undefined || entry.error) continue
    const importer = server.importerOf(entry.source)
    if (!importer?.schema && !importer?.check) continue
    const { json } = await server.artifact(entry.guid)
    const resolveAsset = (ref: { guid: string | undefined; path: string | undefined }) => {
      const e = server.entry(ref)
      return e ? { guid: e.guid, path: e.path, type: e.type } : undefined
    }
    const errors = [
      ...(importer.schema?.validate(json, { resolveAsset }) ?? []),
      ...(importer.check?.(json, resolveAsset) ?? []),
    ]
    if (errors.length > 0) out.push({ source: entry.source, errors })
  }
  return out
}
