import {
  type AssetRef,
  type ComponentDef,
  defineSchema,
  type JsonValue,
  type ResourceDef,
  ShardError,
  type World,
} from '@shard/core'
import type { AssetStore } from './store'

/** What an importer produced for one asset: bytes, JSON, or both. */
export interface Artifact {
  readonly bytes?: Uint8Array
  readonly json?: JsonValue
}

export interface LoadContext {
  readonly guid: string
  readonly path: string
  /**
   * Resolves an asset path to a ref with its guid. `#Label` is a sibling sub-asset of the same
   * source (resolved against its current path).
   */
  resolve(path: string): AssetRef | undefined
}

export interface AssetTypeDef<T = unknown> {
  readonly name: string
  readonly store: ResourceDef<AssetStore<T>>
  /** Turns an artifact into the runtime object. */
  load(artifact: Artifact, ctx: LoadContext): T | Promise<T>
  /**
   * Hot reload: copies `next` into the object already in the store, so everything holding it sees
   * the change (and its version bump). Without it, the store's object is replaced.
   */
  update?(existing: T, next: T): void
  /** Releases what `load` created (GPU copies are released by their owners). */
  unload?(item: T): void
}

const assetTypes = new Map<string, AssetTypeDef>()

/** Registers an asset type: its store and how to load its artifacts. */
export function defineAssetType<T>(
  name: string,
  spec: Omit<AssetTypeDef<T>, 'name'>,
): AssetTypeDef<T> {
  const def: AssetTypeDef<T> = { name, ...spec }
  assetTypes.set(name, def as AssetTypeDef)
  return def
}

export function findAssetType(name: string): AssetTypeDef | undefined {
  return assetTypes.get(name)
}

export function allAssetTypes(): AssetTypeDef[] {
  return [...assetTypes.values()]
}

// --- importers -----------------------------------------------------------------

export interface ImportSource {
  /** Project-relative path of the source file. */
  readonly path: string
  readonly bytes: Uint8Array
  text(): string
}

export interface ImportContext {
  /** Validated import settings from the `.meta` file. */
  readonly settings: Record<string, unknown>
  /**
   * Reads another file and records it as an import dependency: when it changes, this source
   * re-imports. Relative paths resolve against the source's directory.
   */
  read(path: string): Promise<Uint8Array>
  /**
   * Files directly inside a directory, as project paths, sorted. Recorded as a dependency: adding,
   * removing, or renaming a file there re-imports this source (read the files to track contents).
   */
  list(dir: string): Promise<string[]>
  /** Resolves a path relative to the source's directory to a project path. */
  resolve(path: string): string
  /** Records a non-fatal problem; shown by `asset.get` and `shard import`. */
  warn(message: string, path?: string): void
}

export interface ImportedAsset {
  /** '' for the source's main asset; otherwise the sub-asset label (`Mesh/Hull`). */
  label: string
  type: string
  bytes?: Uint8Array
  json?: JsonValue
  /** Asset paths (`materials/hull.material.json`, `a.glb#Texture/x`) the runtime object needs. */
  dependencies?: string[]
  /** Facts for `asset.get`: counts, bounds, sizes. */
  info?: Record<string, JsonValue>
}

export interface ImportResult {
  assets: ImportedAsset[]
}

export interface ImporterDef {
  readonly name: string
  /** Bump to invalidate every artifact this importer made. */
  readonly version: number
  /** File name endings it handles, e.g. `.glb` or `.material.json`. The longest match wins. */
  readonly extensions: readonly string[]
  readonly settings: ComponentDef
  /** Picks default settings for a new `.meta` from the file name (optional). */
  defaults?(path: string): Record<string, JsonValue>
  import(source: ImportSource, ctx: ImportContext): Promise<ImportResult>
}

const importers = new Map<string, ImporterDef>()

export function defineImporter(spec: ImporterDef): ImporterDef {
  for (const ext of spec.extensions) {
    if (!ext.startsWith('.')) {
      throw new ShardError('assets/invalid-importer', `Extension "${ext}" must start with "."`)
    }
  }
  importers.set(spec.name, spec)
  return spec
}

export function findImporter(name: string): ImporterDef | undefined {
  return importers.get(name)
}

export function allImporters(): ImporterDef[] {
  return [...importers.values()]
}

/** The importer for a path: the one whose extension is the longest match. */
export function importerFor(path: string): ImporterDef | undefined {
  const lower = path.toLowerCase()
  let best: ImporterDef | undefined
  let bestLength = 0
  for (const importer of importers.values()) {
    for (const ext of importer.extensions) {
      if (lower.endsWith(ext) && ext.length > bestLength) {
        best = importer
        bestLength = ext.length
      }
    }
  }
  return best
}

const NoSettings = defineSchema('assets/NoSettings', {}, { description: 'No import settings.' })

/**
 * A JSON data asset validated by a schema: `*.<extension>.json` files import as `type`. Errors
 * point into the file. The artifact is the normalized JSON, so defaults are filled in once.
 */
export function defineDataAsset(
  type: string,
  schema: ComponentDef,
  options: { extension: string },
): ImporterDef {
  defineAssetSchema(`${options.extension}.schema.json`, () => schema.jsonSchema())
  return defineImporter({
    name: `data/${options.extension}`,
    version: 1,
    extensions: [`.${options.extension}.json`],
    settings: NoSettings,
    async import(source) {
      let json: unknown
      try {
        json = JSON.parse(source.text())
      } catch (cause) {
        throw new ShardError('assets/import-failed', `${source.path} isn't valid JSON`, {
          path: source.path,
          cause,
        })
      }
      if (json && typeof json === 'object' && '$schema' in json) {
        const { $schema: _, ...rest } = json as Record<string, unknown>
        json = rest
      }
      const errors = schema.validate(json)
      if (errors.length > 0) {
        const first = errors[0]!
        throw new ShardError(
          'assets/import-failed',
          `${source.path}: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
          { path: first.path, hint: first.hint, details: errors },
        )
      }
      // Any asset path the data mentions (e.g. a material's textures) must load first.
      const dependencies = new Set<string>()
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(collect)
        else if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            if (k === 'path' && typeof v === 'string' && !v.startsWith('procedural:'))
              dependencies.add(v)
            else collect(v)
          }
        }
      }
      collect(json)
      return {
        assets: [
          {
            label: '',
            type,
            json: schema.serialize(schema.deserialize(json)),
            ...(dependencies.size ? { dependencies: [...dependencies] } : {}),
          },
        ],
      }
    },
  })
}

// --- previews ------------------------------------------------------------------

/** An RGBA8 image, row by row. */
export interface PreviewImage {
  width: number
  height: number
  data: Uint8Array
}

/** Makes a picture of an asset of one type (`asset.preview`), fitting width × height. */
export type AssetPreview = (
  world: World,
  path: string,
  width: number,
  height: number,
) => Promise<PreviewImage>

const previews = new Map<string, AssetPreview>()

/** Registers how `asset.preview` shows assets of a type, for packages that define asset types. */
export function defineAssetPreview(type: string, preview: AssetPreview): void {
  previews.set(type, preview)
}

export function findAssetPreview(type: string): AssetPreview | undefined {
  return previews.get(type)
}

// --- published schemas ---------------------------------------------------------------------------

const assetSchemas = new Map<string, () => unknown>()

/**
 * Publishes the JSON Schema of a data file format: `shard docs` writes it to
 * `.shard/schemas/<file>` so editors and agents validate as they write. Data assets register theirs.
 */
export function defineAssetSchema(file: string, schema: () => unknown): void {
  assetSchemas.set(file, schema)
}

export function allAssetSchemas(): [string, () => unknown][] {
  return [...assetSchemas]
}
