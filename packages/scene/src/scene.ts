import { assetServer } from '@shard/assets'
import {
  type AssetRef,
  ChildOf,
  type ComponentDef,
  type Entity,
  findComponent,
  findResource,
  isPlainObject,
  type JsonValue,
  pointer,
  quat,
  type ResolvedAsset,
  type SchemaContext,
  ShardError,
  type World,
} from '@shard/core'
import { Materials, Meshes, materialFromJson, validateMaterial } from '@shard/render'
import { FloatingOrigin, Grid, GridCell, Transform } from '@shard/transform'
import {
  InstancePart,
  type LoadedScene,
  PrefabInstance,
  SceneIndex,
  SceneInstance,
  SceneMember,
} from './components'
import { SCENE_VERSION, type SceneAsset, type SceneEntity, type SceneFile } from './format'
import {
  currentOverrides,
  hookInstances,
  instanceKindOf,
  instanceKinds,
  settleInstances,
  validateInstance,
} from './instances'
import { PROCEDURAL_MESHES, parseProcedural, proceduralSourceFor } from './procedural'

export interface LoadedSceneHandle {
  id: string
  /** Scene path → entity. */
  entities: ReadonlyMap<string, Entity>
}

// --- aliases -------------------------------------------------------------------

/** Authoring-only fields: written in files, converted on load, written back when unchanged. */
export const ALIASES: Record<
  string,
  Record<string, { field: string; decode(json: unknown): JsonValue }>
> = {
  'core/Transform': {
    rotationEuler: {
      field: 'rotation',
      // Degrees, applied X then Y then Z.
      decode(json) {
        const [x, y, z] = (json as number[]).map((d) => (d * Math.PI) / 180)
        return [...quat.fromEuler([0, 0, 0, 1], x!, y!, z!)] as number[]
      },
    },
  },
}

export function expandAliases(
  name: string,
  json: Record<string, JsonValue>,
  base: string,
  errors: ShardError[] | undefined,
): Record<string, JsonValue> {
  const aliases = ALIASES[name]
  if (!aliases) return json
  let out = json
  for (const [alias, { field, decode }] of Object.entries(aliases)) {
    if (!(alias in json)) continue
    const value = json[alias]
    if (field in json) {
      errors?.push(
        new ShardError('scene/conflicting-fields', `Both "${alias}" and "${field}" are set`, {
          path: pointer(base, alias),
          hint: `Use one: "${alias}" is the authoring form of "${field}".`,
        }),
      )
      out = { ...out }
      delete out[alias] // reported once here, not again as an unknown field
      continue
    }
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      !value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      errors?.push(
        new ShardError('schema/type-mismatch', `"${alias}" must be [x, y, z] in degrees`, {
          path: pointer(base, alias),
        }),
      )
      continue
    }
    out = { ...out }
    delete out[alias]
    out[field] = decode(value)
  }
  return out
}

// --- asset resolution ----------------------------------------------------------

export function resolveAssets(
  world: World,
  file: { assets?: Record<string, SceneAsset> },
  sceneId: string,
  mode: 'check' | 'create',
  requested?: Set<string>,
): (ref: { guid?: string; path?: string }) => ResolvedAsset | undefined {
  const local = new Map<string, ResolvedAsset>()
  const server = assetServer(world)
  const fromCatalog = (ref: { guid?: string; path?: string }): ResolvedAsset | undefined => {
    const entry = server.entry(ref)
    if (!entry) return undefined
    if (mode === 'create') {
      server.request(entry.guid)
      requested?.add(entry.guid)
    }
    return { guid: entry.guid, path: ref.path ?? entry.path, type: entry.type }
  }
  return (ref) => {
    const path = ref.path
    if (path === undefined) {
      // A guid: the catalog first, then runtime stores (e.g. ids handed out by the protocol).
      const guid = ref.guid!
      const known = fromCatalog(ref)
      if (known) return known
      const type = guid.startsWith('mem:mesh')
        ? 'Mesh'
        : guid.startsWith('mem:material')
          ? 'Material'
          : undefined
      return type ? { guid, path: guid, type } : undefined
    }
    if (path.startsWith('#')) {
      const name = path.slice(1)
      const cached = local.get(name)
      if (cached) return cached
      const entry = file.assets?.[name]
      if (!entry) return undefined
      if (mode === 'check') return { guid: `pending:${path}`, path, type: entry.type }
      let resolved: ResolvedAsset
      if (entry.type === 'Material') {
        const store = world.tryResource(Materials)
        if (!store) return undefined
        const ref = store.add(materialFromJson(entry.value), `${sceneId}${path}`)
        resolved = { guid: ref.guid!, path, type: 'Material' }
      } else {
        const proc = parseProcedural(entry.procedural, entry.params)
        resolved = { ...procedural(world, proc.key, proc.source, proc.params), path }
      }
      local.set(name, resolved)
      return resolved
    }
    if (path.startsWith('procedural:')) {
      // Scenes repeat the same procedural ref across many entities: resolve each string once.
      const cached = local.get(path)
      if (cached) return cached
      const spec = path.slice('procedural:'.length)
      const source = proceduralSourceFor(spec)
      if (source) {
        let resolved: ResolvedAsset
        if (mode === 'check') {
          try {
            resolved = { guid: `pending:${path}`, path, type: source.check(spec).type }
          } catch {
            return undefined // reported with a better message by validateScene
          }
        } else {
          const made = source.resolve(world, spec)
          server.request(made.guid)
          requested?.add(made.guid)
          resolved = { ...made, path }
        }
        local.set(path, resolved)
        return resolved
      }
      let proc: ReturnType<typeof parseProcedural>
      try {
        proc = parseProcedural(path.slice('procedural:'.length))
      } catch (err) {
        if (mode === 'check') return undefined // reported with a better message by validateScene
        throw err
      }
      const resolved =
        mode === 'check'
          ? { guid: `pending:${proc.key}`, path, type: 'Mesh' }
          : { ...procedural(world, proc.key, proc.source, proc.params), path }
      local.set(path, resolved)
      return resolved
    }
    return fromCatalog(ref)
  }
}

/** Procedural meshes are virtual assets (`proc:<key>`), shared by every ref with the same key. */
function procedural(
  world: World,
  key: string,
  source: string,
  params: Record<string, number>,
): ResolvedAsset {
  if (!world.tryResource(Meshes)) {
    throw new ShardError(
      'scene/asset-unavailable',
      'Procedural meshes need the render/forward plugin',
    )
  }
  const entry = assetServer(world).virtual(`proc:${key}`, key, 'Mesh', () =>
    PROCEDURAL_MESHES[source]!.create(params),
  )
  return { guid: entry.guid, path: key, type: 'Mesh' }
}

/**
 * Schema context for component JSON outside a scene file (protocol, tools): entity fields accept
 * scene paths, handles accept asset paths, procedural refs (`procedural:sphere?radius=1`), and guids.
 */
export function worldSchemaContext(world: World): SchemaContext {
  hookInstances(world)
  const empty: SceneFile = { version: SCENE_VERSION, entities: [] }
  return {
    resolveEntity: (path) => findEntityByPath(world, path),
    resolveAsset: resolveAssets(world, empty, 'runtime', 'create'),
  }
}

/** Expands authoring aliases (e.g. Transform `rotationEuler`) in one component's JSON. */
export function expandComponentAliases(
  name: string,
  json: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const errors: ShardError[] = []
  const out = expandAliases(name, json, '', errors)
  if (errors.length > 0) throw errors[0]
  return out
}

// --- walking the file ----------------------------------------------------------

export interface FlatEntity {
  path: string
  parent: string | undefined
  entity: SceneEntity
  pointer: string
}

export function flatten(
  entities: readonly SceneEntity[],
  base: string,
  parent: string | undefined,
  out: FlatEntity[],
): void {
  entities.forEach((entity, i) => {
    const ptr = `${base}/${i}`
    const path = parent === undefined ? entity.name : `${parent}/${entity.name}`
    out.push({ path, parent, entity, pointer: ptr })
    if (Array.isArray(entity.children)) flatten(entity.children, `${ptr}/children`, path, out)
  })
}

export function rebase(err: ShardError, base: string): ShardError {
  return new ShardError(
    err.code,
    err.message.replace(/ at \/\S*/, ` at ${base}${err.path ?? ''}`),
    {
      path: `${base}${err.path ?? ''}`,
      hint: err.hint,
    },
  )
}

export function componentDef(name: string): ComponentDef | undefined {
  try {
    return findComponent(name)
  } catch {
    return undefined
  }
}

// --- validation ----------------------------------------------------------------

/** Every problem in a scene file, each with a JSON pointer. Empty means it will load. */
export function validateScene(
  world: World,
  json: unknown,
  options: { id?: string } = {},
): ShardError[] {
  const errors: ShardError[] = []
  if (!isPlainObject(json)) {
    return [new ShardError('scene/invalid', 'A scene file must be a JSON object', { path: '' })]
  }
  const file = json as unknown as SceneFile
  if (file.version !== SCENE_VERSION) {
    errors.push(
      new ShardError(
        'scene/unsupported-version',
        `Scene version ${JSON.stringify(file.version)} is not supported`,
        {
          path: '/version',
          hint: `Use "version": ${SCENE_VERSION}.`,
        },
      ),
    )
  }
  for (const key of Object.keys(file)) {
    if (!['$schema', 'version', 'assets', 'resources', 'entities'].includes(key)) {
      errors.push(
        new ShardError('scene/unknown-field', `Unknown scene field "${key}"`, { path: `/${key}` }),
      )
    }
  }
  validateAssetsBlock(file.assets, errors)

  if (file.resources !== undefined) {
    for (const [name, value] of Object.entries(file.resources ?? {})) {
      if (!findResource(name)) {
        errors.push(
          new ShardError('scene/unknown-resource', `Unknown resource "${name}"`, {
            path: pointer('/resources', name),
          }),
        )
      } else if (!isPlainObject(value)) {
        errors.push(
          new ShardError('schema/type-mismatch', `Resource "${name}" must be an object`, {
            path: pointer('/resources', name),
          }),
        )
      }
    }
  }

  if (!Array.isArray(file.entities)) {
    errors.push(
      new ShardError('schema/type-mismatch', '"entities" must be an array', { path: '/entities' }),
    )
    return errors
  }

  const flat: FlatEntity[] = []
  flatten(file.entities, '/entities', undefined, flat)
  validateTree(world, file, flat, errors, { id: options.id ?? 'main' })
  return dedupeErrors(errors)
}

/** Checks a file's `assets` block (scene-local materials and procedural meshes). */
export function validateAssetsBlock(
  assets: Record<string, SceneAsset> | undefined,
  errors: ShardError[],
): void {
  if (assets === undefined) return
  if (!isPlainObject(assets)) {
    errors.push(
      new ShardError('schema/type-mismatch', '"assets" must be an object', { path: '/assets' }),
    )
    return
  }
  for (const [name, entry] of Object.entries(assets)) {
    const base = pointer('/assets', name)
    if (entry?.type === 'Material') {
      // The value may name a material type ("type": "my-game/Lava"); its schema validates it.
      for (const e of validateMaterial(entry.value)) errors.push(rebase(e, `${base}/value`))
    } else if (entry?.type === 'Mesh') {
      try {
        parseProcedural(entry.procedural, entry.params, base)
      } catch (e) {
        if (e instanceof ShardError) errors.push(e)
      }
    } else {
      errors.push(
        new ShardError(
          'scene/invalid-asset',
          `Asset "${name}" needs "type": "Material" or "Mesh"`,
          {
            path: base,
            hint: 'Materials: { "type": "Material", "value": {...} }. Meshes: { "type": "Mesh", "procedural": "sphere", "params": {...} }.',
          },
        ),
      )
    }
  }
}

export interface TreeOptions {
  id: string
  /**
   * False when there's no catalog to check asset paths against (importing a prefab): only
   * file-local `#name` refs are checked; the rest are checked when a scene using it validates.
   */
  catalog?: boolean
  /** Entity paths that resolve besides the tree's own (a prefab's root is "."). */
  extraPaths?: readonly string[]
  /** A prefab tree: the first entity is the root, at path ".". */
  root?: boolean
  /** A variant: `#name` refs may name the base's assets, so missing ones aren't errors here. */
  inheritsAssets?: boolean
}

/** Names, components, entity paths, and instance overrides of a flattened entity tree. */
export function validateTree(
  world: World,
  file: { assets?: Record<string, SceneAsset> },
  flat: readonly FlatEntity[],
  errors: ShardError[],
  options: TreeOptions,
): void {
  const checkedProcedural = new Set<string>()
  const catalog = options.catalog ?? true
  const paths = new Set<string>(options.extraPaths)
  const prefab = options.root || options.extraPaths?.includes('.')
  for (const f of flat) {
    if (typeof f.entity?.name !== 'string' || f.entity.name === '' || f.entity.name.includes('/')) {
      errors.push(
        new ShardError('scene/invalid-name', 'Every entity needs a "name" (non-empty, no "/")', {
          path: `${f.pointer}/name`,
        }),
      )
      continue
    }
    if (paths.has(f.path)) {
      errors.push(
        new ShardError(
          'scene/duplicate-name',
          `Two entities are named "${f.entity.name}" under the same parent`,
          {
            path: `${f.pointer}/name`,
            hint: 'Names must be unique among siblings; they form entity paths.',
          },
        ),
      )
    }
    paths.add(f.path)
  }

  const ctx: SchemaContext = {
    resolveAsset: resolveAssets(world, file, options.id, 'check'),
    resolveEntity: (path) => (paths.has(path) ? 0 : undefined),
  }
  for (const f of flat) {
    for (const key of Object.keys(f.entity ?? {})) {
      if (!['name', 'components', 'children'].includes(key)) {
        errors.push(
          new ShardError('scene/unknown-field', `Unknown entity field "${key}"`, {
            path: pointer(f.pointer, key),
          }),
        )
      }
    }
    const components = f.entity?.components
    if (components === undefined) continue
    if (!isPlainObject(components)) {
      errors.push(
        new ShardError('schema/type-mismatch', '"components" must be an object', {
          path: `${f.pointer}/components`,
        }),
      )
      continue
    }
    for (const [name, raw] of Object.entries(components)) {
      const base = pointer(`${f.pointer}/components`, name)
      const def = componentDef(name)
      if (!def) {
        errors.push(
          new ShardError('scene/unknown-component', `Unknown component "${name}"`, {
            path: base,
            hint: 'Use a registered name like "core/Transform" or "render/Camera3d" (see .agents/components.md).',
          }),
        )
        continue
      }
      if (!def.serializable || def === ChildOf) {
        errors.push(
          new ShardError('scene/derived-component', `"${name}" can't be written in a scene`, {
            path: base,
            hint:
              def === ChildOf
                ? 'Nest the entity under "children" instead.'
                : 'It is computed by the engine each frame.',
          }),
        )
        continue
      }
      if (!isPlainObject(raw)) {
        errors.push(
          new ShardError('schema/type-mismatch', `"${name}" must be an object`, { path: base }),
        )
        continue
      }
      const expanded = expandAliases(name, raw as Record<string, JsonValue>, base, errors)
      const before = errors.length
      for (const e of def.validate(expanded, ctx)) {
        if (!catalog && isCatalogMiss(e, expanded)) continue
        if (options.inheritsAssets && isLocalMiss(e, expanded)) continue
        errors.push(rebase(e, base))
      }
      for (const { name: field, field: type } of def.layout) {
        const value = expanded[field]
        if (type.kind === 'entity' && typeof value === 'string' && !paths.has(value)) {
          errors.push(
            new ShardError('scene/unknown-entity-path', `No entity at path "${value}"`, {
              path: pointer(base, field),
              hint: `Paths join names with "/" from the top of the ${prefab ? 'prefab (its root is ".")' : 'scene'}, e.g. "${[...paths].find((p) => p !== '.') ?? 'ship/camera'}".`,
            }),
          )
        }
        if (type.kind === 'handle' && isPlainObject(value) && typeof value.path === 'string') {
          const p = value.path
          if (p.startsWith('procedural:') && !checkedProcedural.has(p)) {
            try {
              const spec = p.slice('procedural:'.length)
              const source = proceduralSourceFor(spec)
              if (source) source.check(spec, pointer(base, field))
              else parseProcedural(spec, {}, pointer(base, field))
              checkedProcedural.add(p) // valid: later uses of the same string need no re-check
            } catch (e) {
              if (e instanceof ShardError) errors.push(e)
            }
          }
        }
      }
      if ((def === PrefabInstance || def === SceneInstance) && errors.length === before) {
        validateInstance(world, def, expanded, base, f, errors, { catalog })
      } else if (errors.length === before) {
        instanceKindOf(def)?.validate?.(world, expanded, base, errors, { catalog })
      }
    }
  }
  validateGrids(flat, errors, prefab === true)
}

/**
 * Large-world placement (spec 0040): GridCell only on direct children of a Grid, translations of
 * grid children within about a cell, and at most one FloatingOrigin.
 */
function validateGrids(flat: readonly FlatEntity[], errors: ShardError[], prefab: boolean): void {
  const byPath = new Map<string, FlatEntity>()
  for (const f of flat) if (typeof f.path === 'string') byPath.set(f.path, f)
  const components = (f: FlatEntity | undefined) =>
    isPlainObject(f?.entity?.components)
      ? (f.entity.components as Record<string, unknown>)
      : undefined
  let origin: FlatEntity | undefined
  for (const f of flat) {
    const own = components(f)
    if (!own) continue
    if (own[FloatingOrigin.name] !== undefined) {
      if (origin === undefined) origin = f
      else {
        errors.push(
          new ShardError(
            'transform/multiple-origins',
            `"${f.path}" and "${origin.path}" both have FloatingOrigin`,
            {
              path: pointer(`${f.pointer}/components`, FloatingOrigin.name),
              hint: 'Keep one transform/FloatingOrigin per world, usually on the camera.',
            },
          ),
        )
      }
    }
    // A prefab's root is placed when it spawns; a variant's children sit under a root not in this file.
    if (prefab && f.path === '.') continue
    const parentPath = f.parent ?? (prefab ? '.' : undefined)
    const parent = parentPath === undefined ? undefined : byPath.get(parentPath)
    if (parentPath !== undefined && parent === undefined) continue
    const up = components(parent)
    // An instance's root components come from its prefab, which can't be seen from here.
    if (up && instanceKinds().some((k) => up[k.def.name] !== undefined)) continue
    const grid = up?.[Grid.name]
    const cell = own[GridCell.name]
    if (grid === undefined) {
      if (cell === undefined) continue
      errors.push(
        new ShardError(
          'transform/cell-outside-grid',
          `"${f.path}" has a GridCell but its parent isn't a Grid`,
          {
            path: pointer(`${f.pointer}/components`, GridCell.name),
            hint: 'Nest the entity directly under an entity with transform/Grid, or remove its GridCell.',
          },
        ),
      )
      continue
    }
    const transform = own[Transform.name]
    const translation = isPlainObject(transform) ? transform.translation : undefined
    if (!Array.isArray(translation)) continue
    const size = isPlainObject(grid) ? grid.cellSize : undefined
    const cellSize =
      typeof size === 'number' && size > 0 ? size : (Grid.fields.cellSize.defaultValue() as number)
    if (translation.some((v) => typeof v === 'number' && Math.abs(v) > cellSize)) {
      errors.push(
        new ShardError(
          'transform/translation-outside-cell',
          `"${f.path}" is more than one cell (${cellSize} m) from its cell's centre`,
          {
            path: pointer(pointer(`${f.pointer}/components`, Transform.name), 'translation'),
            hint: 'Split the position into transform/GridCell (whole cells) plus a translation under one cell, or place it with entity.patch { "position64": [x, y, z], "grid": <grid> }.',
          },
        ),
      )
    }
  }
}

/** An asset-not-found for a file-local `#name` ref. */
function isLocalMiss(e: ShardError, json: Record<string, JsonValue>): boolean {
  return e.code === 'schema/asset-not-found' && !isCatalogMiss(e, json)
}

/** An asset-not-found for a catalog path, which can't be checked without a catalog. */
function isCatalogMiss(e: ShardError, json: Record<string, JsonValue>): boolean {
  if (e.code !== 'schema/asset-not-found') return false
  let value: unknown = json
  for (const part of (e.path ?? '').split('/').slice(1)) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
    value = isPlainObject(value) || Array.isArray(value) ? (value as never)[key] : undefined
  }
  const path = isPlainObject(value) ? value.path : undefined
  return typeof path !== 'string' || !path.startsWith('#')
}

/** A specific scene error beats the generic asset-not-found for the same field; drop duplicates. */
export function dedupeErrors(errors: ShardError[]): ShardError[] {
  const specific = new Set(
    errors
      .filter((e) => !e.code.startsWith('schema/') && e.code !== 'scene/invalid')
      .map((e) => e.path),
  )
  const seen = new Set<string>()
  return errors.filter((e) => {
    if (e.code === 'schema/asset-not-found' && specific.has(e.path)) return false
    const key = `${e.code}|${e.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// --- load ----------------------------------------------------------------------

/** Validates, then spawns the scene. Throws `scene/invalid` (with every error in `details`) if invalid. */
export function loadScene(
  world: World,
  json: unknown,
  options: { id?: string } = {},
): LoadedSceneHandle {
  const id = options.id ?? 'main'
  const index = world.initResource(SceneIndex)
  if (index.has(id)) {
    throw new ShardError('scene/already-loaded', `A scene with id "${id}" is already loaded`, {
      hint: 'Use reloadScene to replace it, or pass a different id.',
    })
  }
  const errors = validateScene(world, json, { id })
  if (errors.length > 0) {
    throw new ShardError(
      'scene/invalid',
      `Scene "${id}" has ${errors.length} error${errors.length === 1 ? '' : 's'}; first: ${errors[0]!.message}`,
      { path: errors[0]!.path, hint: errors[0]!.hint, details: errors },
    )
  }
  const file = json as SceneFile
  const flat: FlatEntity[] = []
  flatten(file.entities, '/entities', undefined, flat)

  const entities = new Map<string, Entity>()
  for (const f of flat) entities.set(f.path, world.reserveEntity())
  const requested = new Set<string>()
  const ctx: SchemaContext = {
    resolveAsset: resolveAssets(world, file, id, 'create', requested),
    resolveEntity: (path) => entities.get(path),
  }

  const scene: LoadedScene = {
    id,
    file,
    order: flat.map((f) => f.path),
    entities,
    authored: new Map(),
    loaded: new Map(),
    loadedResources: new Map(),
    assets: requested,
  }

  for (const f of flat) {
    const entity = entities.get(f.path)!
    const inits: [ComponentDef, Record<string, unknown>][] = []
    for (const [name, raw] of Object.entries(f.entity.components ?? {})) {
      const def = findComponent(name)!
      inits.push([def, def.deserialize(expandAliases(name, raw, '', undefined), ctx)])
    }
    if (f.parent !== undefined)
      inits.push([ChildOf as ComponentDef, { parent: entities.get(f.parent)! }])
    inits.push([SceneMember as ComponentDef, { scene: id, path: f.path }])
    world.spawnReserved(entity, inits)
    scene.authored.set(entity, f.entity)
  }

  // Record values as stored (after f32 rounding etc.), so "unchanged" compares like with like.
  for (const entity of entities.values())
    scene.loaded.set(entity, serializeComponents(world, entity))

  for (const [name, value] of Object.entries(file.resources ?? {})) {
    const def = findResource(name)!
    const current = world.tryResource(def)
    if (isPlainObject(current)) Object.assign(current, value)
    else world.insertResource(def, structuredCloneJson(value))
    scene.loadedResources.set(name, toJson(world.resource(def)))
  }

  index.set(id, scene)
  return { id, entities }
}

/**
 * Resolves once every asset the scene referenced has loaded or failed (following their
 * dependencies). Tools wait for this before capturing, so screenshots never show half a scene.
 */
export async function whenSceneReady(world: World, id: string): Promise<void> {
  const scene = world.tryResource(SceneIndex)?.get(id)
  if (!scene) throw new ShardError('scene/not-loaded', `No scene with id "${id}" is loaded`)
  const server = assetServer(world)
  let size = -1
  // Loading can reveal more (e.g. a model's node tree); wait until the set stops growing.
  while (scene.assets.size !== size) {
    size = scene.assets.size
    await server.whenSettled(scene.assets)
    await settleInstances(world)
    for (const wait of sceneWaiters) await wait(world, scene.id)
  }
}

/** Extra readiness checks (e.g. SceneInstance children); each resolves when its part is ready. */
const sceneWaiters: ((world: World, sceneId: string) => Promise<void>)[] = []

export function addSceneReadyCheck(check: (world: World, sceneId: string) => Promise<void>): void {
  sceneWaiters.push(check)
}

/** Despawns a loaded scene's entities and loads the new file under the same id. */
export function reloadScene(world: World, id: string, json: unknown): LoadedSceneHandle {
  unloadScene(world, id, { collect: false })
  const handle = loadScene(world, json, { id })
  assetServer(world).collect()
  return handle
}

/** Despawns a scene's entities, then unloads assets nothing references any more. */
export function unloadScene(world: World, id: string, options: { collect?: boolean } = {}): void {
  const index = world.initResource(SceneIndex)
  const scene = index.get(id)
  if (!scene) return
  for (const path of scene.order) {
    const entity = scene.entities.get(path)!
    if (world.isAlive(entity)) world.despawn(entity)
  }
  index.delete(id)
  if (options.collect ?? true) assetServer(world).collect()
}

/** Finds a scene entity by path (`ship/camera`), or `sceneId:path` when several scenes are loaded. */
export function findEntityByPath(world: World, path: string): Entity | undefined {
  const index = world.tryResource(SceneIndex)
  if (!index) return undefined
  const colon = path.indexOf(':')
  if (colon !== -1) return index.get(path.slice(0, colon))?.entities.get(path.slice(colon + 1))
  for (const scene of index.values()) {
    const e = scene.entities.get(path)
    if (e !== undefined && world.isAlive(e)) return e
  }
  return undefined
}

/** The scene path of an entity, if it came from a scene. */
export function pathOfEntity(world: World, entity: Entity): string | undefined {
  return world.tryGet(entity, SceneMember)?.path
}

// --- save ----------------------------------------------------------------------

export function toJson(value: unknown): JsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v,
    ),
  )
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

export function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function serializeComponents(
  world: World,
  entity: Entity,
): Map<string, Record<string, JsonValue>> {
  const out = new Map<string, Record<string, JsonValue>>()
  for (const def of world.componentsOf(entity)) {
    if (!def.serializable || def === ChildOf) continue
    out.set(def.name, def.serialize(world.get(entity, def)))
  }
  return out
}

/**
 * Serializes a loaded scene back to its file format. Fields unchanged since load are written exactly
 * as authored (preset names, hex colors, "#asset" refs, rotationEuler, key order), so saving an
 * untouched scene reproduces the file and edits make minimal diffs.
 */
export function saveScene(world: World, id: string): SceneFile {
  const scene = world.initResource(SceneIndex).get(id)
  if (!scene) throw new ShardError('scene/not-loaded', `No scene with id "${id}" is loaded`)

  const writeEntity = (path: string): SceneEntity | undefined => {
    const entity = scene.entities.get(path)!
    if (!world.isAlive(entity)) return undefined
    const authored = scene.authored.get(entity)!
    const loaded = scene.loaded.get(entity)!
    const current = serializeComponents(world, entity)
    // An instance's generated children aren't written; what changed in them becomes its overrides.
    for (const { def } of instanceKinds()) {
      const value = current.get(def.name)
      if (value) value.overrides = currentOverrides(world, entity) ?? value.overrides!
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(authored)) {
      if (key === 'name') out.name = authored.name
      else if (key === 'components')
        out.components = writeComponents(authored.components ?? {}, loaded, current)
      else if (key === 'children') {
        out.children = (authored.children ?? [])
          .map((child) => writeEntity(`${path}/${child.name}`))
          .filter((c): c is SceneEntity => c !== undefined)
      }
    }
    if (!('components' in authored)) {
      const added = writeComponents({}, loaded, current)
      if (Object.keys(added).length > 0) out.components = added
    }
    return out as unknown as SceneEntity
  }

  const writeComponents = (
    authored: Record<string, Record<string, JsonValue>>,
    loaded: Map<string, Record<string, JsonValue>>,
    current: Map<string, Record<string, JsonValue>>,
  ) => {
    const out: Record<string, Record<string, JsonValue>> = {}
    for (const [name, authoredJson] of Object.entries(authored)) {
      const now = current.get(name)
      if (!now) continue // removed at runtime
      out[name] = writeFields(name, authoredJson, loaded.get(name) ?? {}, now)
    }
    for (const [name, now] of current) {
      if (name in authored || name === SceneMember.name || name === InstancePart.name) continue
      const before = loaded.get(name)
      if (before && equal(before, now)) continue // auto-added (required) and untouched
      out[name] = now
    }
    return out
  }

  const writeFields = (
    name: string,
    authored: Record<string, JsonValue>,
    loaded: Record<string, JsonValue>,
    now: Record<string, JsonValue>,
  ) => {
    const out: Record<string, JsonValue> = {}
    const aliases = ALIASES[name] ?? {}
    const covered = new Set<string>()
    for (const [key, value] of Object.entries(authored)) {
      const field = aliases[key]?.field ?? key
      covered.add(field)
      if (equal(now[field], loaded[field])) out[key] = value
      else out[field] = now[field]!
    }
    for (const field of Object.keys(now)) {
      if (covered.has(field)) continue
      if (!equal(now[field], loaded[field])) out[field] = now[field]!
    }
    return out
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(scene.file)) {
    if (key === 'entities') {
      out.entities = scene.file.entities
        .map((e) => writeEntity(e.name))
        .filter((e) => e !== undefined)
    } else if (key === 'resources') {
      const resources: Record<string, JsonValue> = {}
      for (const [name, authored] of Object.entries(scene.file.resources ?? {})) {
        const now = toJson(world.tryResource(findResource(name)!))
        resources[name] = equal(now, scene.loadedResources.get(name)) ? authored : now
      }
      out.resources = resources
    } else {
      out[key] = (scene.file as unknown as Record<string, unknown>)[key]
    }
  }
  return out as unknown as SceneFile
}

/** Scene JSON as written to disk: 2-space indent, trailing newline. */
export function stringifyScene(file: SceneFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

export type { AssetRef }
