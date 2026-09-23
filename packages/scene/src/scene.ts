import { AssetStore, assetServer, defineAssetType } from '@shard/assets'
import {
  type AssetRef,
  ChildOf,
  type ComponentDef,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  findResource,
  isPlainObject,
  type JsonValue,
  onAdd,
  onRemove,
  onSet,
  PreUpdate,
  pointer,
  quat,
  type ResolvedAsset,
  type SchemaContext,
  ShardError,
  t,
  type World,
} from '@shard/core'
import { Materials, Meshes, materialFromJson, validateMaterial } from '@shard/render'
import type { Plugin } from '@shard/runtime'
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
  /** Guids of every asset the scene referenced, requested at load. */
  assets: Set<string>
}

export const SceneIndex = defineResource<Map<string, LoadedScene>>('scene/Index', {
  description: 'Loaded scenes: paths, entities, and what was authored.',
  init: () => new Map(),
})

export interface LoadedSceneHandle {
  id: string
  /** Scene path → entity. */
  entities: ReadonlyMap<string, Entity>
}

// --- scene assets and instances --------------------------------------------------

/** Scene files loaded as assets (a glTF's node tree, later prefabs), by guid. */
export const SceneAssets = defineResource<AssetStore<SceneFile, 'Scene'>>('scene/SceneAssets', {
  description: 'Scene assets (node trees) by guid.',
  init: () => new AssetStore('Scene'),
})

/**
 * Scene assets. References inside them written as `#Label` point at sibling sub-assets of the same
 * source; they're resolved against the source's current path at load, so moving the file is safe.
 */
export const SceneAssetType = defineAssetType<SceneFile>('Scene', {
  store: SceneAssets,
  load: (artifact, ctx) => {
    const base = ctx.path.split('#')[0]!
    const resolve = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolve)
      if (!value || typeof value !== 'object') return value
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        out[k] =
          k === 'path' && typeof v === 'string' && v.startsWith('#') ? `${base}${v}` : resolve(v)
      }
      return out
    }
    return resolve(artifact.json) as SceneFile
  },
})

/** Places a scene asset (e.g. `assets/ship.glb#Scene`) as generated children of this entity. */
export const SceneInstance = defineComponent(
  'scene/SceneInstance',
  {
    scene: t.handle('Scene', {
      description: 'The scene to place, e.g. { "path": "assets/ship.glb#Scene" }.',
    }),
  },
  {
    description:
      "Spawns a scene asset (a model's node tree) as children, addressable by path (ship/Hull). The children are generated: saving writes only this entity, and they respawn when the asset changes.",
  },
)

interface InstanceState {
  guid: string
  version: number
  roots: Entity[]
  paths: string[]
  sceneId: string | undefined
}

const Instances = defineResource<Map<Entity, InstanceState>>('scene/Instances', {
  description: 'Spawned SceneInstance children, to respawn on asset changes.',
  init: () => new Map(),
})

/** Per world: undoes the asset-server listener (so short-lived worlds, like previews, don't leak). */
const hooked = new WeakMap<World, () => void>()
/** Worlds with instances added or changed since the last update (the per-frame system skips the rest). */
const dirty = new WeakSet<World>()

/** Respawns instances when their scene asset reloads, even between frames. Installed once per world. */
function hookInstances(world: World): void {
  if (hooked.has(world)) return
  const off = assetServer(world).onEvent((e) => {
    if (e.kind !== 'loaded' && e.kind !== 'modified') return
    if (assetServer(world).entry(e.guid)?.type === 'Scene') updateSceneInstances(world)
  })
  hooked.set(world, off)
  world.observe(onAdd(SceneInstance), () => void dirty.add(world))
  world.observe(onSet(SceneInstance), () => void dirty.add(world))
  world.observe(onRemove(SceneInstance), () => void dirty.add(world))
}

/** Detaches a world's scene hooks from its asset server (for worlds that share another's server). */
export function releaseSceneHooks(world: World): void {
  hooked.get(world)?.()
  hooked.delete(world)
}

/** Spawns instances added at runtime (e.g. by `entity.spawn`). Does nothing on frames without changes. */
export const sceneInstancesSystem = defineSystem({
  name: 'scene/instances',
  description: 'Spawns and respawns SceneInstance children.',
  run: (_, world) => {
    if (!dirty.has(world)) return
    dirty.delete(world)
    updateSceneInstances(world)
  },
})

/** Scene support for apps: spawns SceneInstance children added while the app runs. */
export const ScenePlugin: Plugin = {
  name: 'scene',
  build(app) {
    hookInstances(app.world)
    app.addSystems(PreUpdate, sceneInstancesSystem)
  },
}

/**
 * Spawns the children of every SceneInstance whose scene asset is loaded (requesting it otherwise),
 * respawns those whose asset changed, and cleans up after removed instances.
 */
export function updateSceneInstances(world: World): void {
  hookInstances(world)
  dirty.delete(world)
  const server = assetServer(world)
  const states = world.initResource(Instances)
  for (const [entity, state] of [...states]) {
    if (world.isAlive(entity) && world.has(entity, SceneInstance)) continue
    despawnInstance(world, state)
    states.delete(entity)
  }
  const todo: [Entity, SceneFile, { guid: string; version: number }][] = []
  const q = world.query({ with: [SceneInstance] })
  for (const table of q.tables) {
    const refs = table.column(SceneInstance, 'scene')
    for (let i = 0; i < table.count; i++) {
      const ref = refs[i]
      const entity = table.entities[i]! as Entity
      const entry = ref ? server.entry(ref) : undefined
      if (!entry) continue
      if (entry.state === 'unloaded') {
        server.request(entry.guid)
        continue
      }
      if (entry.state !== 'loaded') continue
      const state = states.get(entity)
      if (state && state.guid === entry.guid && state.version === entry.version) continue
      const file = world.resource(SceneAssets).byGuid(entry.guid)
      if (file) todo.push([entity, file, entry])
    }
  }
  for (const [entity, file, entry] of todo) {
    const old = states.get(entity)
    if (old) despawnInstance(world, old)
    states.set(entity, instantiate(world, file, entity, entry))
  }
}

/** Waits for instance scene assets to load and spawns them (repeatedly, for nested instances). */
async function settleInstances(world: World): Promise<void> {
  const server = assetServer(world)
  for (let round = 0; round < 8; round++) {
    updateSceneInstances(world)
    const pending: string[] = []
    const q = world.query({ with: [SceneInstance] })
    for (const table of q.tables) {
      const refs = table.column(SceneInstance, 'scene')
      for (let i = 0; i < table.count; i++) {
        const entry = refs[i] ? server.entry(refs[i]!) : undefined
        if (entry && (entry.state === 'loading' || entry.state === 'unloaded'))
          pending.push(entry.guid)
      }
    }
    if (pending.length === 0) return
    await server.whenSettled(pending)
  }
}

function despawnInstance(world: World, state: InstanceState): void {
  for (const root of state.roots) if (world.isAlive(root)) world.despawn(root)
  const scene =
    state.sceneId === undefined ? undefined : world.tryResource(SceneIndex)?.get(state.sceneId)
  if (scene) for (const path of state.paths) scene.entities.delete(path)
}

function instantiate(
  world: World,
  file: SceneFile,
  parent: Entity,
  entry: { guid: string; version: number },
): InstanceState {
  const member = world.tryGet(parent, SceneMember)
  const scene = member ? world.tryResource(SceneIndex)?.get(member.scene) : undefined
  const flat: FlatEntity[] = []
  flatten(file.entities, '/entities', undefined, flat)
  const local = new Map<string, Entity>()
  for (const f of flat) local.set(f.path, world.reserveEntity())
  const ctx: SchemaContext = {
    resolveAsset: resolveAssets(world, file, member?.scene ?? 'instance', 'create', scene?.assets),
    resolveEntity: (path) => local.get(path),
  }
  const roots: Entity[] = []
  const paths: string[] = []
  for (const f of flat) {
    const entity = local.get(f.path)!
    const inits: [ComponentDef, Record<string, unknown>][] = []
    for (const [name, raw] of Object.entries(f.entity.components ?? {})) {
      const def = findComponent(name)
      if (!def) continue
      inits.push([def, def.deserialize(expandAliases(name, raw, '', undefined), ctx)])
    }
    const parentEntity = f.parent === undefined ? parent : local.get(f.parent)!
    inits.push([ChildOf as ComponentDef, { parent: parentEntity }])
    if (member) {
      const path = `${member.path}/${f.path}`
      inits.push([SceneMember as ComponentDef, { scene: member.scene, path }])
      scene?.entities.set(path, entity)
      paths.push(path)
    }
    world.spawnReserved(entity, inits)
    if (f.parent === undefined) roots.push(entity)
  }
  return { guid: entry.guid, version: entry.version, roots, paths, sceneId: member?.scene }
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
  const checkedProcedural = new Set<string>()
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
          if (p.startsWith('procedural:') && !checkedProcedural.has(p)) {
            try {
              parseProcedural(p.slice('procedural:'.length), {}, pointer(base, field))
              checkedProcedural.add(p) // valid: later uses of the same string need no re-check
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
