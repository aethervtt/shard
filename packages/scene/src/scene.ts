import {
  type AssetRef,
  ChildOf,
  type ComponentDef,
  defineComponent,
  defineResource,
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
  t,
  type World,
} from '@shard/core'
import { MaterialAsset, Materials, Meshes, StandardMaterial } from '@shard/render'
import { SCENE_VERSION, type SceneEntity, type SceneFile } from './format'
import { PROCEDURAL_MESHES, parseProcedural } from './procedural'

/** Marks entities that came from a scene file. */
export const SceneMember = defineComponent(
  'scene/SceneMember',
  {
    scene: t.string({ description: 'Id of the scene this entity was loaded from.' }),
    path: t.string({ description: 'Path within the scene, e.g. "ship/camera".' }),
  },
  { description: 'Set by the scene loader.', serialize: false },
)

interface LoadedScene {
  id: string
  file: SceneFile
  /** Paths in file order (depth-first), and their entities. */
  order: string[]
  entities: Map<string, Entity>
  authored: Map<Entity, SceneEntity>
  /** Serialized component values right after load, to tell which fields changed since. */
  loaded: Map<Entity, Map<string, Record<string, JsonValue>>>
  loadedResources: Map<string, JsonValue>
}

export const SceneIndex = defineResource<Map<string, LoadedScene>>('scene/Index', {
  description: 'Loaded scenes: paths, entities, and what was authored.',
  init: () => new Map(),
})

/** Procedural meshes shared across scenes, by canonical key, so equal refs instance together. */
const ProceduralCache = defineResource<Map<string, ResolvedAsset>>('scene/ProceduralCache', {
  init: () => new Map(),
})

export interface LoadedSceneHandle {
  id: string
  /** Scene path → entity. */
  entities: ReadonlyMap<string, Entity>
}

// --- aliases -------------------------------------------------------------------

/** Authoring-only fields: written in files, converted on load, written back when unchanged. */
const ALIASES: Record<
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

function expandAliases(
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

function resolveAssets(
  world: World,
  file: SceneFile,
  sceneId: string,
  mode: 'check' | 'create',
): (ref: { guid?: string; path?: string }) => ResolvedAsset | undefined {
  const local = new Map<string, ResolvedAsset>()
  return (ref) => {
    const path = ref.path
    if (path === undefined) {
      // A runtime guid (e.g. from the protocol): trust the stores.
      const guid = ref.guid!
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
        const value = StandardMaterial.deserialize(entry.value)
        const ref = store.add(new MaterialAsset(value), `${sceneId}${path}`)
        resolved = { guid: ref.guid!, path, type: 'Material' }
      } else {
        const proc = parseProcedural(entry.procedural, entry.params)
        resolved = { ...procedural(world, proc.key, proc.source, proc.params), path }
      }
      local.set(name, resolved)
      return resolved
    }
    if (path.startsWith('procedural:')) {
      let proc: ReturnType<typeof parseProcedural>
      try {
        proc = parseProcedural(path.slice('procedural:'.length))
      } catch (err) {
        if (mode === 'check') return undefined // reported with a better message by validateScene
        throw err
      }
      if (mode === 'check') return { guid: `pending:${proc.key}`, path, type: 'Mesh' }
      return { ...procedural(world, proc.key, proc.source, proc.params), path }
    }
    return undefined // file-backed assets arrive with the asset database (M4)
  }
}

function procedural(
  world: World,
  key: string,
  source: string,
  params: Record<string, number>,
): ResolvedAsset {
  const cache = world.initResource(ProceduralCache)
  const hit = cache.get(key)
  if (hit) return hit
  const store = world.tryResource(Meshes)
  if (!store) {
    throw new ShardError(
      'scene/asset-unavailable',
      'Procedural meshes need the render/forward plugin',
    )
  }
  const ref = store.add(PROCEDURAL_MESHES[source]!.create(params), key)
  const resolved = { guid: ref.guid!, path: key, type: 'Mesh' }
  cache.set(key, resolved)
  return resolved
}

/**
 * Schema context for component JSON outside a scene file (protocol, tools): entity fields accept
 * scene paths, handles accept procedural refs (`procedural:sphere?radius=1`) and runtime guids.
 */
export function worldSchemaContext(world: World): SchemaContext {
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

interface FlatEntity {
  path: string
  parent: string | undefined
  entity: SceneEntity
  pointer: string
}

function flatten(
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

function rebase(err: ShardError, base: string): ShardError {
  return new ShardError(
    err.code,
    err.message.replace(/ at \/\S*/, ` at ${base}${err.path ?? ''}`),
    {
      path: `${base}${err.path ?? ''}`,
      hint: err.hint,
    },
  )
}

function componentDef(name: string): ComponentDef | undefined {
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

  if (file.assets !== undefined) {
    if (!isPlainObject(file.assets))
      errors.push(
        new ShardError('schema/type-mismatch', '"assets" must be an object', { path: '/assets' }),
      )
    else {
      for (const [name, entry] of Object.entries(file.assets)) {
        const base = pointer('/assets', name)
        if (entry?.type === 'Material') {
          for (const e of StandardMaterial.validate(entry.value))
            errors.push(rebase(e, `${base}/value`))
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
  }

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
  const paths = new Set<string>()
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
    resolveAsset: resolveAssets(world, file, options.id ?? 'main', 'check'),
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
      for (const e of def.validate(expanded, ctx)) errors.push(rebase(e, base))
      for (const { name: field, field: type } of def.layout) {
        const value = expanded[field]
        if (type.kind === 'entity' && typeof value === 'string' && !paths.has(value)) {
          errors.push(
            new ShardError('scene/unknown-entity-path', `No entity at path "${value}"`, {
              path: pointer(base, field),
              hint: `Paths join names with "/" from the top of the scene, e.g. "${[...paths][0] ?? 'ship/camera'}".`,
            }),
          )
        }
        if (type.kind === 'handle' && isPlainObject(value) && typeof value.path === 'string') {
          const p = value.path
          if (!p.startsWith('#') && !p.startsWith('procedural:')) {
            errors.push(
              new ShardError(
                'scene/asset-unavailable',
                `File assets like "${p}" need the asset database (M4)`,
                {
                  path: pointer(base, field),
                  hint: 'Use a scene asset ("#name") or a procedural mesh ("procedural:sphere?radius=1").',
                },
              ),
            )
          } else if (p.startsWith('procedural:')) {
            try {
              parseProcedural(p.slice('procedural:'.length), {}, pointer(base, field))
            } catch (e) {
              if (e instanceof ShardError) errors.push(e)
            }
          }
        }
      }
    }
  }
  // A specific scene error beats the generic asset-not-found for the same field; drop duplicates.
  const specific = new Set(
    errors
      .filter((e) => e.code.startsWith('scene/') && e.code !== 'scene/invalid')
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
  const ctx: SchemaContext = {
    resolveAsset: resolveAssets(world, file, id, 'create'),
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

/** Despawns a loaded scene's entities and loads the new file under the same id. */
export function reloadScene(world: World, id: string, json: unknown): LoadedSceneHandle {
  unloadScene(world, id)
  return loadScene(world, json, { id })
}

export function unloadScene(world: World, id: string): void {
  const index = world.initResource(SceneIndex)
  const scene = index.get(id)
  if (!scene) return
  for (const path of scene.order) {
    const entity = scene.entities.get(path)!
    if (world.isAlive(entity)) world.despawn(entity)
  }
  index.delete(id)
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

function toJson(value: unknown): JsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v,
    ),
  )
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function serializeComponents(world: World, entity: Entity): Map<string, Record<string, JsonValue>> {
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
      if (name in authored || name === SceneMember.name) continue
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
