import { assetServer, defineImporter, type ImportContext } from '@shard/assets'
import {
  defineSchema,
  type Entity,
  isPlainObject,
  type JsonValue,
  pointer,
  ShardError,
  World,
} from '@shard/core'
import { PrefabAssets, PrefabInstance } from './components'
import { type Overrides, PREFAB_VERSION, type PrefabFile, type SceneEntity } from './format'
import { currentOverrides, mergeOverridesIntoPrefab, prefabOfInstance } from './instances'
import {
  ALIASES,
  dedupeErrors,
  type FlatEntity,
  flatten,
  validateAssetsBlock,
  validateTree,
} from './scene'

const PREFAB_FIELDS = [
  '$schema',
  'version',
  'assets',
  'root',
  'extends',
  'rootComponents',
  'overrides',
  'children',
]
const VARIANT_FIELDS = ['extends', 'rootComponents', 'overrides', 'children']

/**
 * Every problem in a prefab file, each with a JSON pointer. `catalog: false` (importing) checks
 * asset paths only when they're file-local (`#name`); scenes check the rest when they validate.
 */
export function validatePrefab(
  world: World,
  json: unknown,
  options: { id?: string; catalog?: boolean } = {},
): ShardError[] {
  const errors: ShardError[] = []
  if (!isPlainObject(json)) {
    return [
      new ShardError('prefab/invalid', 'A prefab file must be a JSON object', {
        path: '',
        hint: 'Write { "version": 1, "root": { "name": "...", "components": {...}, "children": [...] } }, or a variant with "extends".',
      }),
    ]
  }
  const file = json as unknown as PrefabFile
  if (file.version !== PREFAB_VERSION) {
    errors.push(
      new ShardError(
        'prefab/unsupported-version',
        `Prefab version ${JSON.stringify(file.version)} is not supported`,
        { path: '/version', hint: `Use "version": ${PREFAB_VERSION}.` },
      ),
    )
  }
  for (const key of Object.keys(file)) {
    if (!PREFAB_FIELDS.includes(key)) {
      errors.push(
        new ShardError('prefab/unknown-field', `Unknown prefab field "${key}"`, {
          path: pointer('', key),
          hint: 'A prefab has "root" (an entity), or "extends" plus "rootComponents", "overrides", and "children" (a variant).',
        }),
      )
    }
  }
  validateAssetsBlock(file.assets, errors)
  const id = options.id ?? 'prefab'
  const catalog = options.catalog ?? true
  const isVariant = file.extends !== undefined
  if (isVariant && file.root !== undefined) {
    errors.push(
      new ShardError('prefab/invalid', 'A prefab has "root" or "extends", not both', {
        path: '/root',
        hint: 'A variant takes its root from its base: change it with "rootComponents" and "overrides".',
      }),
    )
  }
  if (!isVariant) {
    for (const key of VARIANT_FIELDS) {
      if (key !== 'extends' && key in file) {
        errors.push(
          new ShardError('prefab/unknown-field', `Only variants (with "extends") have "${key}"`, {
            path: pointer('', key),
            hint: 'Write the change into "root" directly.',
          }),
        )
      }
    }
    if (!isPlainObject(file.root)) {
      errors.push(
        new ShardError('prefab/invalid', 'A prefab needs a "root" entity (or "extends")', {
          path: '/root',
          hint: 'Give { "name": "ship", "components": {...}, "children": [...] }.',
        }),
      )
      return dedupeErrors(errors)
    }
    const flat: FlatEntity[] = [
      { path: '.', parent: undefined, entity: file.root, pointer: '/root' },
    ]
    if (Array.isArray(file.root.children))
      flatten(file.root.children, '/root/children', undefined, flat)
    else if (file.root.children !== undefined) {
      errors.push(
        new ShardError('schema/type-mismatch', '"children" must be an array', {
          path: '/root/children',
        }),
      )
    }
    validateTree(world, file, flat, errors, { id, catalog, root: true })
    return dedupeErrors(errors)
  }

  const base = file.extends as unknown
  if (
    !isPlainObject(base) ||
    (typeof base.path !== 'string' && typeof base.guid !== 'string') ||
    Object.keys(base).some((k) => k !== 'path' && k !== 'guid')
  ) {
    errors.push(
      new ShardError('schema/type-mismatch', '"extends" must be a prefab reference', {
        path: '/extends',
        hint: 'Give { "path": "prefabs/ship.prefab.json" }.',
      }),
    )
  }
  if (file.rootComponents !== undefined) {
    if (!isPlainObject(file.rootComponents)) {
      errors.push(
        new ShardError('schema/type-mismatch', '"rootComponents" must be an object', {
          path: '/rootComponents',
        }),
      )
    } else {
      // Checked as a root entity would be; fields merge onto the base's.
      const root: FlatEntity = {
        path: '.',
        parent: undefined,
        entity: { name: 'root', components: file.rootComponents },
        pointer: '',
      }
      const before = errors.length
      validateTree(world, file, [root], errors, { id, catalog, root: true, inheritsAssets: true })
      for (let i = before; i < errors.length; i++) {
        const e = errors[i]!
        errors[i] = new ShardError(
          e.code,
          e.message.replace(' at /components', ' at /rootComponents'),
          {
            path: e.path?.replace(/^\/components/, '/rootComponents'),
            hint: e.hint,
          },
        )
      }
    }
  }
  if (file.children !== undefined) {
    if (!Array.isArray(file.children)) {
      errors.push(
        new ShardError('schema/type-mismatch', '"children" must be an array', {
          path: '/children',
        }),
      )
    } else {
      const flat: FlatEntity[] = []
      flatten(file.children, '/children', undefined, flat)
      validateTree(world, file, flat, errors, {
        id,
        catalog,
        extraPaths: ['.'],
        inheritsAssets: true,
      })
    }
  }
  if (file.overrides !== undefined && !isPlainObject(file.overrides)) {
    errors.push(
      new ShardError('schema/type-mismatch', '"overrides" must be an object', {
        path: '/overrides',
        hint: 'Map paths to component patches: { "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } } }.',
      }),
    )
  }
  return dedupeErrors(errors)
}

/**
 * Flattens a variant onto its (resolved) base: root components merge field by field, children are
 * added, overrides apply to the tree (paths inside nested instances land in their overrides).
 */
export function applyVariant(base: PrefabFile, variant: PrefabFile): PrefabFile {
  const unknown: string[] = []
  const merged = mergeOverridesIntoPrefab(
    { version: PREFAB_VERSION, assets: base.assets, root: base.root },
    (variant.overrides ?? {}) as Overrides,
    (key) => unknown.push(key),
  )
  if (unknown.length > 0) {
    throw new ShardError('prefab/unknown-path', `No entity at "${unknown[0]}" in the base prefab`, {
      path: pointer('/overrides', unknown[0]!),
      hint: 'Override paths are relative to the root, e.g. "Hull" or "Hull/Cockpit".',
    })
  }
  const root = merged.root!
  const components = { ...(root.components ?? {}) }
  for (const [name, patch] of Object.entries(variant.rootComponents ?? {})) {
    const own = { ...(components[name] ?? {}) }
    for (const [alias, { field }] of Object.entries(ALIASES[name] ?? {})) {
      if (field in patch) delete own[alias]
      if (alias in patch) delete own[field]
    }
    components[name] = { ...own, ...patch }
  }
  const out: PrefabFile = {
    version: PREFAB_VERSION,
    root: {
      ...root,
      components,
      ...(variant.children?.length || root.children
        ? { children: [...(root.children ?? []), ...(variant.children ?? [])] }
        : {}),
    },
  }
  const assets = { ...(base.assets ?? {}), ...(variant.assets ?? {}) }
  if (Object.keys(assets).length > 0) out.assets = assets
  return out
}

/** Asset paths a prefab references (nested prefabs, models, materials), to load before it. */
function referencedPaths(file: PrefabFile): string[] {
  const out = new Set<string>()
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect)
    else if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'path' && typeof v === 'string') {
          if (!v.startsWith('#') && !v.startsWith('procedural:')) out.add(v)
        } else collect(v)
      }
    }
  }
  collect(file.root)
  return [...out]
}

/** Prefab paths a file points at: its base, and prefabs placed inside it. */
function prefabRefs(json: PrefabFile): string[] {
  const out: string[] = []
  if (typeof json.extends?.path === 'string') out.push(json.extends.path)
  const walk = (entities: unknown) => {
    if (!Array.isArray(entities)) return
    for (const e of entities as SceneEntity[]) {
      const ref = e?.components?.['scene/PrefabInstance']?.prefab
      if (isPlainObject(ref) && typeof ref.path === 'string') out.push(ref.path)
      walk(e?.children)
    }
  }
  walk(json.root ? [json.root] : [])
  walk(json.children)
  return out
}

function parse(text: string, path: string): PrefabFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw new ShardError('assets/import-failed', `${path} isn't valid JSON`, { path, cause })
  }
  if (isPlainObject(json) && '$schema' in json) {
    const { $schema: _, ...rest } = json
    json = rest
  }
  return json as unknown as PrefabFile
}

function invalid(path: string, errors: ShardError[]): ShardError {
  const first = errors[0]!
  return new ShardError(
    first.code.startsWith('prefab/') ? first.code : 'assets/import-failed',
    `${path}: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
    { path: first.path, hint: first.hint, details: errors },
  )
}

/** A world without a catalog: import-time validation checks structure and component schemas. */
let bare: World | undefined

/**
 * Resolves a prefab file (read with `read`) to its flattened form, following "extends". Throws
 * `prefab/cycle` if the file extends or contains itself through any chain of prefabs.
 */
async function resolvePrefab(
  path: string,
  json: PrefabFile,
  read: (path: string) => Promise<{ path: string; json: PrefabFile }>,
  chain: string[],
): Promise<{ file: PrefabFile; bases: string[] }> {
  bare ??= new World()
  const errors = validatePrefab(bare, json, { id: path, catalog: false })
  if (errors.length > 0) throw invalid(path, errors)
  // Containment cycles would deadlock loading (each waits for the other), so they fail here.
  const seen = [...chain, path]
  const visit = async (file: PrefabFile, stack: string[]): Promise<void> => {
    for (const ref of prefabRefs(file)) {
      const next = await read(ref)
      if (stack.includes(next.path)) {
        throw new ShardError(
          'prefab/cycle',
          `${seen[0]} contains or extends itself (${[...stack, next.path].join(' → ')})`,
          {
            path: seen[0],
            hint: 'A prefab can’t contain or extend itself, directly or through others.',
          },
        )
      }
      await visit(next.json, [...stack, next.path])
    }
  }
  await visit(json, seen)
  if (json.extends === undefined) return { file: json, bases: [] }
  const base = await read(json.extends.path!)
  const resolved = await resolvePrefab(base.path, base.json, read, seen)
  return { file: applyVariant(resolved.file, json), bases: [base.path, ...resolved.bases] }
}

function countEntities(root: SceneEntity | undefined): string[] {
  const out: string[] = []
  const walk = (list: readonly SceneEntity[] | undefined, prefix: string) => {
    for (const e of list ?? []) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      out.push(path)
      walk(e.children, path)
    }
  }
  walk(root?.children, '')
  return out
}

const NoSettings = defineSchema(
  'scene/PrefabSettings',
  {},
  { description: 'None: the prefab is the file.' },
)

/** `*.prefab.json`: a validated entity tree; variants are flattened onto their base here. */
export const PrefabImporter = defineImporter({
  name: 'prefab',
  version: 1,
  extensions: ['.prefab.json'],
  settings: NoSettings,
  async import(source, ctx: ImportContext) {
    const json = parse(source.text(), source.path)
    const decoder = new TextDecoder()
    const read = async (p: string) => {
      const full = ctx.resolve(p)
      let bytes: Uint8Array
      try {
        bytes = await ctx.read(p)
      } catch (cause) {
        throw new ShardError(
          'prefab/not-found',
          `${source.path} refers to ${p}, which can't be read`,
          {
            path: p,
            hint: 'Check the path: prefab paths start at an asset root, e.g. "prefabs/ship.prefab.json".',
            cause,
          },
        )
      }
      return { path: full, json: parse(decoder.decode(bytes), full) }
    }
    const { file, bases } = await resolvePrefab(source.path, json, read, [])
    const paths = countEntities(file.root)
    const dependencies = referencedPaths(file)
    return {
      assets: [
        {
          label: '',
          type: 'Prefab',
          json: file as unknown as JsonValue,
          ...(dependencies.length ? { dependencies } : {}),
          info: {
            root: file.root?.name ?? null,
            entities: paths.length + 1,
            tree: paths.slice(0, 200),
            ...(bases.length ? { extends: bases } : {}),
          },
        },
      ],
    }
  },
})

// --- prefabs made in code --------------------------------------------------------------------------

/** Registered prefab JSON per world, to re-resolve variants when their base is registered again. */
const registered = new WeakMap<World, Map<string, PrefabFile>>()

/**
 * Registers a prefab from JSON without a file (tests, tools, generated content), under `path`.
 * Registering the same path again replaces it: instances update as if the file was saved, and
 * variants registered on top of it are re-resolved. Throws with every validation error.
 */
export function registerPrefab(world: World, path: string, json: unknown): void {
  const file = json as PrefabFile
  const errors = validatePrefab(world, json, { id: path, catalog: false })
  if (errors.length > 0) {
    throw new ShardError(
      'prefab/invalid',
      `Prefab "${path}" has ${errors.length} error${errors.length === 1 ? '' : 's'}; first: ${errors[0]!.message}`,
      { path: errors[0]!.path, hint: errors[0]!.hint, details: errors },
    )
  }
  let files = registered.get(world)
  if (!files) {
    files = new Map()
    registered.set(world, files)
  }
  files.set(path, file)
  const server = assetServer(world)
  const resolve = (p: string, f: PrefabFile, chain: string[]): PrefabFile => {
    if (chain.includes(p)) {
      throw new ShardError(
        'prefab/cycle',
        `${chain[0]} extends itself (${[...chain, p].join(' → ')})`,
        {
          path: chain[0],
          hint: 'A prefab can’t contain or extend itself, directly or through others.',
        },
      )
    }
    if (f.extends === undefined) return f
    const basePath = f.extends.path ?? server.entry({ guid: f.extends.guid })?.path ?? ''
    const own = files!.get(basePath)
    const entry = server.entry(f.extends as { path?: string; guid?: string })
    const base = own
      ? resolve(basePath, own, [...chain, p])
      : entry
        ? world.resource(PrefabAssets).byGuid(entry.guid)
        : undefined
    if (!base) {
      throw new ShardError('prefab/not-loaded', `${p} extends ${basePath}, which isn't loaded`, {
        hint: 'Register (or load) the base prefab first.',
      })
    }
    return applyVariant(base, f)
  }
  const publish = (p: string, f: PrefabFile) => {
    const resolved = resolve(p, f, [])
    server.updateVirtual(`mem:prefab:${p}`, p, 'Prefab', () => resolved)
  }
  publish(path, file)
  // Variants of this prefab (directly or through others) pick up the change.
  const dependsOn = (f: PrefabFile, target: string, depth = 0): boolean => {
    const base = f.extends?.path
    if (!base || depth > 16) return false
    return base === target || (files!.has(base) && dependsOn(files!.get(base)!, target, depth + 1))
  }
  for (const [p, f] of files) if (p !== path && dependsOn(f, path)) publish(p, f)
}

/** Registered prefab JSON as it was given (before variants are flattened), or undefined. */
export function registeredPrefab(world: World, path: string): PrefabFile | undefined {
  return registered.get(world)?.get(path)
}

// --- apply to prefab -------------------------------------------------------------------------------

/** File access for `applyToPrefab` (the project folder). */
export interface PrefabFiles {
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
}

/**
 * "Apply to prefab": writes an instance's overrides into its prefab (the file, re-imported; or the
 * registered JSON), then clears the instance's overrides. Every instance picks up the change, and
 * this one ends up with nothing left to override.
 */
export async function applyToPrefab(
  world: World,
  entity: Entity,
  files?: PrefabFiles,
): Promise<{ prefab: string; applied: Overrides; file?: string }> {
  const entry = prefabOfInstance(world, entity)
  if (!entry) {
    throw new ShardError(
      'prefab/not-an-instance',
      `Entity ${entity} isn't a spawned prefab instance`,
      {
        hint: 'Pass the entity that has scene/PrefabInstance (e.g. "player-ship"), once it has spawned.',
      },
    )
  }
  const overrides = currentOverrides(world, entity) ?? {}
  const own = registeredPrefab(world, entry.path)
  const clear = () => world.set(entity, PrefabInstance, { overrides: {} })
  if (own) {
    clear()
    registerPrefab(world, entry.path, mergeOverridesIntoPrefab(own, overrides))
    return { prefab: entry.path, applied: overrides }
  }
  if (!entry.source || !files) {
    throw new ShardError('prefab/read-only', `Can't write ${entry.path} from this host`, {
      hint: 'Apply from the CLI or Studio, which can write the project folder.',
    })
  }
  const json = JSON.parse(await files.readText(entry.source)) as PrefabFile
  const merged = mergeOverridesIntoPrefab(json, overrides)
  await files.writeText(entry.source, `${JSON.stringify(merged, null, 2)}\n`)
  clear()
  await assetServer(world).reimport(entry.source)
  return { prefab: entry.path, applied: overrides, file: entry.source }
}
