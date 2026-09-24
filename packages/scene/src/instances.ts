import { type AssetEntry, assetServer } from '@shard/assets'
import {
  type AssetRef,
  ChildOf,
  Commands,
  type ComponentDef,
  defineSystem,
  type Entity,
  isPlainObject,
  type JsonValue,
  onAdd,
  onRemove,
  onSet,
  PreUpdate,
  pointer,
  type SchemaContext,
  ShardError,
  World,
} from '@shard/core'
import { type Log, LogResource, type Plugin } from '@shard/runtime'
import { Transform } from '@shard/transform'
import {
  InstancePart,
  PrefabAssets,
  PrefabInstance,
  SceneAssets,
  SceneIndex,
  SceneInstance,
  SceneMember,
} from './components'
import type { Overrides, PrefabFile, SceneAsset, SceneEntity, SceneFile } from './format'
import {
  ALIASES,
  componentDef,
  equal,
  expandAliases,
  type FlatEntity,
  rebase,
  resolveAssets,
  serializeComponents,
} from './scene'

type InstanceDef = ComponentDef
type ComponentsJson = Record<string, Record<string, JsonValue>>

// --- flattening ---------------------------------------------------------------------------------
//
// An instance's generated entities are built in two steps. First the source (a prefab or a model's
// node tree) is flattened to JSON: nested instances are inlined, so paths reach through them
// (`Hull/Cockpit`), and overrides are applied as JSON patches. Then each entity's components are
// deserialized once into a template, which instances and `spawnPrefab` copy without touching JSON.

interface FlatNode {
  name: string
  /** Relative to the instance entity. */
  path: string
  /** Index of the parent node; -1 is the instance entity itself. */
  parent: number
  /** Alias-expanded component JSON. Entity fields hold paths relative to the instance ("." is it). */
  components: ComponentsJson
  /** Holds an inlined nested instance: its instance component doesn't spawn anything itself. */
  nested: boolean
}

interface Flat {
  /** A prefab root's components (merged into the instance entity); undefined for model scenes. */
  root: ComponentsJson | undefined
  /** A prefab root's name (runtime instances under a scene entity get it as their path). */
  rootName: string | undefined
  nodes: FlatNode[]
  index: Map<string, number>
  /** Removed by overrides, with their subtrees. */
  removed: Set<number>
  /** Nodes cloned by overrides (copy on write when forked from a template). */
  touched: Set<number>
  assets: Record<string, SceneAsset>
  /** Guid → version of every asset the flattening read. */
  deps: Map<string, number>
  /** Nested assets that aren't loaded yet. */
  missing: Set<string>
  /** Overrides inside the source that no longer match (reported as stale). */
  warnings: ShardError[]
}

type Report = (key: string, error: ShardError) => void

/** Paths inside nested '#name' assets are renamed per inlining, so two prefabs' '#hull' don't mix. */
let nestedCounter = 0

function sourceFile(world: World, entry: AssetEntry): PrefabFile | SceneFile | undefined {
  if (entry.type === 'Prefab') return world.tryResource(PrefabAssets)?.byGuid(entry.guid)
  if (entry.type === 'Scene') return world.tryResource(SceneAssets)?.byGuid(entry.guid)
  return undefined
}

function expandComponents(components: SceneEntity['components']): ComponentsJson {
  const out: ComponentsJson = {}
  if (!isPlainObject(components)) return out
  for (const [name, raw] of Object.entries(components)) {
    if (isPlainObject(raw))
      out[name] = expandAliases(name, raw as Record<string, JsonValue>, '', [])
  }
  return out
}

function instanceDefOf(components: ComponentsJson): InstanceDef | undefined {
  if (components[PrefabInstance.name]) return PrefabInstance
  if (components[SceneInstance.name]) return SceneInstance
  return undefined
}

function handleOf(json: Record<string, JsonValue> | undefined, field: string) {
  const ref = json?.[field]
  return isPlainObject(ref) ? (ref as { guid?: string; path?: string }) : undefined
}

/** Flattens a prefab or scene asset (nested instances inlined, their own overrides applied). */
function flattenSource(world: World, entry: AssetEntry, stack: readonly string[]): Flat {
  if (stack.includes(entry.guid)) {
    throw new ShardError(
      'prefab/cycle',
      `${entry.path} contains itself (${[...stack.map((g) => assetServer(world).entry(g)?.path ?? g), entry.path].join(' → ')})`,
      {
        path: entry.path,
        hint: 'A prefab can’t contain or extend itself, directly or through others.',
      },
    )
  }
  const file = sourceFile(world, entry)
  const flat: Flat = {
    root: undefined,
    rootName: undefined,
    nodes: [],
    index: new Map(),
    removed: new Set(),
    touched: new Set(),
    assets: { ...(file?.assets ?? {}) },
    deps: new Map([[entry.guid, entry.version]]),
    missing: new Set(),
    warnings: [],
  }
  if (!file) return flat
  let children: readonly SceneEntity[]
  if (entry.type === 'Prefab') {
    const root = (file as PrefabFile).root
    flat.root = expandComponents(root?.components)
    flat.rootName = root?.name
    children = root?.children ?? []
  } else {
    children = (file as SceneFile).entities ?? []
  }
  const add = (list: readonly SceneEntity[], prefix: string, parent: number) => {
    for (const e of list) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`
      const i = flat.nodes.length
      flat.nodes.push({
        name: e.name,
        path,
        parent,
        components: expandComponents(e.components),
        nested: false,
      })
      flat.index.set(path, i)
      if (Array.isArray(e.children)) add(e.children, path, i)
    }
  }
  add(children, '', -1)
  // Inline nested instances. Only the source's own nodes: inlined ones arrive fully expanded. A
  // prefab root may be an instance too (a model with components): its tree becomes the prefab's.
  const own = flat.nodes.length
  const server = assetServer(world)
  const next = [...stack, entry.guid]
  for (let i = flat.root ? -1 : 0; i < own; i++) {
    const components = i === -1 ? flat.root! : flat.nodes[i]!.components
    const def = instanceDefOf(components)
    if (!def) continue
    const instance = components[def.name]!
    const ref = handleOf(instance, def === PrefabInstance ? 'prefab' : 'scene')
    const nested = ref && server.entry(ref)
    if (!nested) continue
    if (nested.state === 'unloaded' || nested.state === 'loading') {
      server.request(nested.guid)
      flat.missing.add(nested.guid)
      continue
    }
    if (nested.state !== 'loaded') continue
    inline(flat, i, flattenSource(world, nested, next))
    // At the root, the instance component itself would place the tree a second time.
    if (i === -1) delete components[def.name]
    const overrides = instance.overrides
    const at = i === -1 ? '' : flat.nodes[i]!.path
    if (isPlainObject(overrides)) {
      applyOverrides(flat, overrides as Overrides, at, (key, error) => {
        flat.warnings.push(stale(`${entry.path}: ${at || flat.rootName}`, key, error))
      })
    }
  }
  return flat
}

function stale(where: string, key: string, error: ShardError): ShardError {
  return new ShardError('prefab/stale-override', `${where}: override "${key}": ${error.message}`, {
    path: error.path,
    hint: 'The prefab changed (a renamed or removed entity?). The override is kept in the file; fix or delete it.',
  })
}

/**
 * Moves a nested flattening under node `at` (-1: the prefab root): its root components merge in,
 * its nodes append after.
 */
function inline(flat: Flat, at: number, nested: Flat): void {
  const hostPath = at === -1 ? '' : flat.nodes[at]!.path
  const hostComponents = at === -1 ? flat.root! : flat.nodes[at]!.components
  const prefix = `n${nestedCounter++}~`
  for (const [name, asset] of Object.entries(nested.assets)) flat.assets[`${prefix}${name}`] = asset
  const move = (components: ComponentsJson): ComponentsJson => {
    const out: ComponentsJson = {}
    for (const [name, json] of Object.entries(components))
      out[name] = rebaseJson(name, json, hostPath, prefix)
    return out
  }
  if (nested.root) {
    // The host's own fields win over the nested root's.
    const root = move(nested.root)
    for (const [name, json] of Object.entries(root)) {
      hostComponents[name] = { ...json, ...(hostComponents[name] ?? {}) }
    }
  }
  const offset = flat.nodes.length
  for (let k = 0; k < nested.nodes.length; k++) {
    const n = nested.nodes[k]!
    const path = hostPath === '' ? n.path : `${hostPath}/${n.path}`
    flat.nodes.push({
      name: n.name,
      path,
      parent: n.parent === -1 ? at : n.parent + offset,
      components: move(n.components),
      nested: n.nested,
    })
    flat.index.set(path, offset + k)
    if (nested.removed.has(k)) flat.removed.add(offset + k)
  }
  if (at !== -1) flat.nodes[at]!.nested = true
  for (const [g, v] of nested.deps) flat.deps.set(g, v)
  for (const g of nested.missing) flat.missing.add(g)
  flat.warnings.push(...nested.warnings)
}

/** Entity paths move under `base`; '#name' assets get the inlining's prefix. */
function rebaseJson(
  name: string,
  json: Record<string, JsonValue>,
  base: string,
  prefix: string,
): Record<string, JsonValue> {
  const def = componentDef(name)
  const renameAssets = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(renameAssets)
    if (!isPlainObject(value)) return value
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        k === 'path' && typeof v === 'string' && v.startsWith('#')
          ? `#${prefix}${v.slice(1)}`
          : renameAssets(v as JsonValue)
    }
    return out
  }
  const out = renameAssets(json) as Record<string, JsonValue>
  if (def) {
    for (const { name: field, field: type } of def.layout) {
      const v = out[field]
      if (type.kind === 'entity' && typeof v === 'string' && base !== '')
        out[field] = v === '.' ? base : `${base}/${v}`
    }
  }
  return out
}

/** A copy that overrides can change without touching the original (nodes are copied on write). */
function fork(flat: Flat): Flat {
  return {
    ...flat,
    nodes: flat.nodes.slice(),
    removed: new Set(flat.removed),
    touched: new Set(),
    warnings: [],
  }
}

function touch(flat: Flat, i: number): FlatNode {
  if (flat.touched.has(i)) return flat.nodes[i]!
  const node = { ...flat.nodes[i]!, components: { ...flat.nodes[i]!.components } }
  flat.nodes[i] = node
  flat.touched.add(i)
  return node
}

function isRemoved(flat: Flat, i: number): boolean {
  for (let k = i; k !== -1; k = flat.nodes[k]!.parent) if (flat.removed.has(k)) return true
  return false
}

/** `Exhaust/particles/ParticleEmitterOverrides` → the entity path and the component name. */
function splitComponentKey(
  flat: { index: Map<string, number> },
  key: string,
): { i: number; component: string } | undefined {
  const parts = key.split('/')
  if (parts.length < 3) return undefined
  const component = parts.slice(-2).join('/')
  const i = flat.index.get(parts.slice(0, -2).join('/'))
  return i === undefined || !componentDef(component) ? undefined : { i, component }
}

type Validate = (def: ComponentDef, json: Record<string, JsonValue>) => ShardError[]

/**
 * Applies overrides (keys relative to `prefix`) to a flattening. Problems go to `report` with a
 * pointer relative to the overrides object; a bad component patch is skipped, the rest apply.
 */
function applyOverrides(
  flat: Flat,
  overrides: Overrides,
  prefix: string,
  report: Report,
  validate?: Validate,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    const at = pointer('', key)
    const full = prefix === '' ? key : `${prefix}/${key}`
    if (value === null) {
      const i = flat.index.get(full)
      if (i !== undefined) {
        flat.removed.add(i)
        continue
      }
      const cut = splitComponentKey(flat, full)
      if (cut) delete touch(flat, cut.i).components[cut.component]
      else report(key, unknownPath(key, at, flat))
      continue
    }
    if (!isPlainObject(value)) {
      report(
        key,
        new ShardError('schema/type-mismatch', `Override "${key}" must be an object or null`, {
          path: at,
          hint: 'Give { "<component>": { fields } } to change an entity, or null to remove it.',
        }),
      )
      continue
    }
    const i = flat.index.get(full)
    if (i === undefined) {
      report(key, unknownPath(key, at, flat))
      continue
    }
    for (const [name, patch] of Object.entries(value)) {
      const where = pointer(at, name)
      const def = componentDef(name)
      if (!def) {
        report(
          key,
          new ShardError('scene/unknown-component', `Unknown component "${name}"`, {
            path: where,
            hint: 'Use a registered name like "core/Transform" or "render/Camera3d" (see .agents/components.md).',
          }),
        )
        continue
      }
      if (!def.serializable || def === ChildOf) {
        report(
          key,
          new ShardError('scene/derived-component', `"${name}" can't be overridden`, {
            path: where,
          }),
        )
        continue
      }
      if (patch === null) {
        delete touch(flat, i).components[name]
        continue
      }
      if (!isPlainObject(patch)) {
        report(
          key,
          new ShardError('schema/type-mismatch', `"${name}" must be an object or null`, {
            path: where,
          }),
        )
        continue
      }
      const errors: ShardError[] = []
      const expanded = expandAliases(name, patch as Record<string, JsonValue>, where, errors)
      const merged = { ...(flat.nodes[i]!.components[name] ?? {}), ...expanded }
      if (validate) for (const e of validate(def, merged)) errors.push(rebase(e, where))
      if (errors.length > 0) {
        for (const e of errors) report(key, e)
        continue
      }
      touch(flat, i).components[name] = merged
    }
  }
}

function unknownPath(key: string, at: string, flat: Flat): ShardError {
  const names = flat.nodes.filter((n) => n.parent === -1).map((n) => n.name)
  return new ShardError('prefab/unknown-path', `No generated entity at "${key}"`, {
    path: at,
    hint: names.length
      ? `Paths are relative to the instance, e.g. "${names[0]}"${flat.nodes.find((n) => n.parent !== -1) ? ` or "${flat.nodes.find((n) => n.parent !== -1)!.path}"` : ''}. End a path with a component name to remove that component.`
      : 'This instance generates no entities.',
  })
}

// --- templates -----------------------------------------------------------------------------------

interface EntityRef {
  /** Index into the entity's components. */
  component: number
  field: string
  /** Node index; -1 is the instance entity. */
  target: number
}

interface TemplateEntity {
  path: string
  parent: number
  defs: ComponentDef[]
  values: Record<string, unknown>[]
  refs: EntityRef[]
  /** Reused per spawn: [def, value] pairs, then ChildOf, InstancePart (and SceneMember). */
  inits: [ComponentDef, Record<string, unknown>][]
  childOf: { parent: Entity }
  part: { instance: Entity; path: string }
}

interface Plan {
  flat: Flat
  root: TemplateEntity | undefined
  /** Per node; undefined where removed. */
  entities: (TemplateEntity | undefined)[]
}

interface Template extends Plan {
  entry: AssetEntry
  /** Assets the template's components reference, requested at compile (scenes wait for them). */
  requested: Set<string>
  /**
   * Resolves refs for the template and every instance's overrides: a prefab's `#name` assets are
   * created once, so an overridden entity shares them (and saves no phantom difference).
   */
  ctx: SchemaContext
  /** Serialized as stored, entity fields as paths; computed on first use (saving). */
  canonical: Map<number, Map<string, Record<string, JsonValue>>> | undefined
}

/** Entity fields are resolved per spawn; while compiling they're placeholders. */
function compileNode(
  world: World,
  flat: Flat,
  components: ComponentsJson,
  path: string,
  parent: number,
  ctx: SchemaContext,
): TemplateEntity {
  const defs: ComponentDef[] = []
  const values: Record<string, unknown>[] = []
  const refs: EntityRef[] = []
  for (const [name, json] of Object.entries(components)) {
    const def = componentDef(name)
    if (!def?.serializable || def === ChildOf) continue
    let value: Record<string, unknown>
    try {
      value = def.deserialize(json, ctx) as Record<string, unknown>
    } catch (err) {
      world.tryResource(LogResource)?.error(
        new ShardError(
          'prefab/invalid-component',
          `${path || '(root)'} ${name}: ${(err as Error).message}`,
          {
            hint: (err as ShardError).hint,
          },
        ),
      )
      continue
    }
    for (const { name: field, field: type } of def.layout) {
      const v = json[field]
      if (type.kind !== 'entity' || typeof v !== 'string') continue
      refs.push({ component: defs.length, field, target: v === '.' ? -1 : flat.index.get(v)! })
      value[field] = null
    }
    defs.push(def)
    values.push(value)
  }
  const childOf = { parent: -1 }
  const part = { instance: -1, path }
  const inits: [ComponentDef, Record<string, unknown>][] = defs.map((d, k) => [d, values[k]!])
  inits.push([ChildOf as ComponentDef, childOf], [InstancePart as ComponentDef, part])
  return { path, parent, defs, values, refs, inits, childOf, part }
}

function compileContext(world: World, flat: Flat, id: string, requested?: Set<string>) {
  return {
    resolveAsset: resolveAssets(world, flat, id, 'create', requested),
    resolveEntity: (path: string) => (path === '.' || flat.index.has(path) ? 0 : undefined),
  } satisfies SchemaContext
}

function compileTemplate(world: World, entry: AssetEntry): Template {
  const flat = flattenSource(world, entry, [])
  const requested = new Set<string>()
  const ctx = compileContext(world, flat, entry.path, requested)
  const template: Template = {
    entry,
    flat,
    root: flat.root ? compileNode(world, flat, flat.root, '', -1, ctx) : undefined,
    entities: [],
    requested,
    ctx,
    canonical: undefined,
  }
  for (let i = 0; i < flat.nodes.length; i++) {
    const n = flat.nodes[i]!
    template.entities.push(
      isRemoved(flat, i)
        ? undefined
        : compileNode(world, flat, n.components, n.path, n.parent, ctx),
    )
  }
  const log = world.tryResource(LogResource)
  for (const w of flat.warnings) warn(log, w)
  return template
}

function warn(log: Log | undefined, error: ShardError): void {
  log?.log('warn', error.message, { code: error.code, path: error.path, hint: error.hint })
}

/** The template with an instance's overrides applied (only the entities they touch recompile). */
function planFor(
  world: World,
  template: Template,
  overrides: Overrides | undefined,
  report: Report,
): Plan {
  if (!overrides || Object.keys(overrides).length === 0) return template
  const flat = fork(template.flat)
  const check = checkContext(world, flat, template.entry.path)
  applyOverrides(flat, overrides, '', report, (def, json) => def.validate(json, check))
  const ctx = template.ctx
  const entities: (TemplateEntity | undefined)[] = []
  for (let i = 0; i < flat.nodes.length; i++) {
    if (isRemoved(flat, i)) entities.push(undefined)
    else if (flat.touched.has(i)) {
      const n = flat.nodes[i]!
      entities.push(compileNode(world, flat, n.components, n.path, n.parent, ctx))
    } else entities.push(template.entities[i])
  }
  return { flat, root: template.root, entities }
}

function checkContext(world: World, flat: Flat, id: string): SchemaContext {
  return {
    resolveAsset: resolveAssets(world, flat, id, 'check'),
    resolveEntity: (path) => (path === '.' || flat.index.has(path) ? 0 : undefined),
  }
}

// --- per-world state -------------------------------------------------------------------------------

interface InstanceState {
  def: InstanceDef
  template: Template
  plan: Plan
  /** The overrides the plan was built from, as JSON text (a change respawns). */
  overridesKey: string
  overrides: Overrides
  /** Per node: the spawned entity, or -1 (removed). */
  ids: Entity[]
  sceneId: string | undefined
  paths: string[]
  /** Root fields the instance sets itself (prefabs): hot reload never overwrites them. */
  own: Map<string, Set<string>>
  /** Root component JSON last written from the template (to tell runtime changes apart). */
  applied: Map<string, Record<string, JsonValue>> | undefined
}

interface WorldInstances {
  states: Map<Entity, InstanceState>
  templates: Map<string, Template>
  off: () => void
  dirty: boolean
}

/** Per world: spawned instances, compiled templates, and the asset-server listener. */
const perWorld = new WeakMap<World, WorldInstances>()

function stateOf(world: World): WorldInstances {
  let s = perWorld.get(world)
  if (!s) {
    const off = assetServer(world).onEvent((e) => {
      if (e.kind !== 'loaded' && e.kind !== 'modified') return
      const type = assetServer(world).entry(e.guid)?.type
      if (type === 'Scene' || type === 'Prefab') updateInstances(world)
    })
    s = { states: new Map(), templates: new Map(), off, dirty: true }
    perWorld.set(world, s)
    const mark = () => {
      s!.dirty = true
    }
    for (const def of [SceneInstance, PrefabInstance] as ComponentDef[]) {
      world.observe(onAdd(def), mark)
      world.observe(onSet(def), mark)
      world.observe(onRemove(def), mark)
    }
  }
  return s
}

/** Installs the instance hooks for a world (asset reloads respawn instances, even between frames). */
export function hookInstances(world: World): void {
  stateOf(world)
}

/** Detaches a world's scene hooks from its asset server (for worlds that share another's server). */
export function releaseSceneHooks(world: World): void {
  perWorld.get(world)?.off()
  perWorld.delete(world)
}

function isCurrent(world: World, template: Template): boolean {
  const server = assetServer(world)
  for (const [guid, version] of template.flat.deps) {
    const e = server.entry(guid)
    if (!e || e.version !== version) return false
  }
  return true
}

/** The compiled template for a loaded prefab or scene asset (cached until it or a dependency reloads). */
function templateFor(world: World, entry: AssetEntry): Template {
  const s = stateOf(world)
  const cached = s.templates.get(entry.guid)
  if (cached && isCurrent(world, cached) && cached.flat.missing.size === 0) return cached
  const template = compileTemplate(world, entry)
  s.templates.set(entry.guid, template)
  return template
}

// --- spawning -------------------------------------------------------------------------------------

function resolveRefs(t: TemplateEntity, ids: readonly Entity[], instance: Entity): void {
  for (const r of t.refs) {
    const value = { ...t.values[r.component]! }
    value[r.field] = r.target === -1 ? instance : (ids[r.target] ?? -1) < 0 ? null : ids[r.target]
    t.inits[r.component]![1] = value
  }
}

interface Member {
  scene: string
  path: string
}

/** Reserves an id per generated entity (-1 where removed). */
function reserve(world: World, plan: Plan): Entity[] {
  const ids: Entity[] = new Array(plan.entities.length)
  for (let i = 0; i < plan.entities.length; i++)
    ids[i] = plan.entities[i] ? world.reserveEntity() : -1
  return ids
}

/** Spawns a plan's entities under `instance` into ids from `reserve`. */
function spawnReserved(
  world: World,
  plan: Plan,
  instance: Entity,
  ids: readonly Entity[],
  member: Member | undefined,
  paths: string[] | undefined,
): void {
  const scene = member ? world.tryResource(SceneIndex)?.get(member.scene) : undefined
  for (let i = 0; i < plan.entities.length; i++) {
    const t = plan.entities[i]
    const id = ids[i]!
    if (!t || id < 0) continue
    const parent = t.parent === -1 ? instance : ids[t.parent]!
    if (parent < 0) continue
    t.childOf.parent = parent
    t.part.instance = instance
    if (t.refs.length > 0) resolveRefs(t, ids, instance)
    if (member) {
      const path = `${member.path}/${t.path}`
      world.spawnReserved(id, [
        ...t.inits,
        [SceneMember as ComponentDef, { scene: member.scene, path }],
      ])
      scene?.entities.set(path, id)
      paths?.push(path)
    } else {
      world.spawnReserved(id, t.inits)
    }
  }
}

function despawnGenerated(world: World, state: InstanceState): void {
  for (let i = 0; i < state.ids.length; i++) {
    const t = state.plan.entities[i]
    const id = state.ids[i]!
    if (t && t.parent === -1 && world.isAlive(id)) world.despawn(id)
  }
  const scene =
    state.sceneId === undefined ? undefined : world.tryResource(SceneIndex)?.get(state.sceneId)
  if (scene) for (const path of state.paths) scene.entities.delete(path)
}

function memberOf(world: World, entity: Entity): Member | undefined {
  const m = world.tryGet(entity, SceneMember)
  return m ? { scene: m.scene, path: m.path } : undefined
}

/** Fields of the instance entity's own components: authored ones in a scene, else non-defaults. */
function ownFields(world: World, entity: Entity): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const member = world.tryGet(entity, SceneMember)
  const authored = member
    ? world.tryResource(SceneIndex)?.get(member.scene)?.authored.get(entity)
    : undefined
  if (authored) {
    for (const [name, json] of Object.entries(expandComponents(authored.components)))
      out.set(name, new Set(Object.keys(json)))
    return out
  }
  for (const def of world.componentsOf(entity)) {
    if (!def.serializable || def === ChildOf) continue
    const now = def.serialize(world.get(entity, def))
    const defaults = def.serialize(def.defaults())
    const fields = Object.keys(now).filter((f) => !equal(now[f], defaults[f]))
    if (fields.length > 0) out.set(def.name, new Set(fields))
  }
  return out
}

/**
 * Writes the prefab root's components onto the instance entity. Fields the instance sets itself
 * stay; on a reload, so do fields changed at runtime since the last write (a moving ship isn't
 * teleported back when its prefab is saved).
 */
function applyRoot(world: World, entity: Entity, state: InstanceState): void {
  const root = state.plan.root
  if (!root) return
  const canonical = canonicalOf(state.template).get(-1)!
  const prev = state.applied
  resolveRefs(root, state.ids, entity)
  const member = world.tryGet(entity, SceneMember)
  const loaded = member
    ? world.tryResource(SceneIndex)?.get(member.scene)?.loaded.get(entity)
    : undefined
  for (let k = 0; k < root.defs.length; k++) {
    const def = root.defs[k]!
    const value = root.inits[k]![1]
    if (!world.has(entity, def)) {
      if (prev?.has(def.name)) continue // removed since: keep it removed
      world.add(entity, def, value)
      loaded?.set(def.name, def.serialize(world.get(entity, def)))
      continue
    }
    const own = state.own.get(def.name)
    const before = prev?.get(def.name)
    const current = before ? def.serialize(world.get(entity, def)) : undefined
    const partial: Record<string, unknown> = {}
    const written: string[] = []
    for (const field of Object.keys(def.fields)) {
      if (own?.has(field)) continue
      // Entity fields point at generated entities, which are new after a respawn: always rewire.
      const isEntity = def.fields[field]!.kind === 'entity'
      if (!isEntity && before && current && !equal(current[field], before[field])) continue
      partial[field] = value[field]
      written.push(field)
    }
    if (written.length === 0) continue
    world.set(entity, def, partial)
    if (loaded) {
      const now = def.serialize(world.get(entity, def))
      const base = { ...(loaded.get(def.name) ?? now) }
      for (const field of written) base[field] = now[field]!
      loaded.set(def.name, base)
    }
  }
  if (prev) {
    for (const name of prev.keys()) {
      if (canonical.has(name) || state.own.has(name)) continue
      const def = componentDef(name)
      if (def) world.remove(entity, def)
    }
  }
  state.applied = canonical
}

function reportTo(world: World, where: string): Report {
  const log = world.tryResource(LogResource)
  return (key, error) => warn(log, stale(where, key, error))
}

function overridesOf(value: JsonValue | undefined): Overrides {
  return isPlainObject(value) ? (value as Overrides) : {}
}

function instantiate(
  world: World,
  entity: Entity,
  def: InstanceDef,
  template: Template,
  overrides: Overrides,
  previous: InstanceState | undefined,
): InstanceState {
  const member = memberOf(world, entity)
  const where = member ? `${member.scene}:${member.path}` : `entity ${entity}`
  const plan = planFor(world, template, overrides, reportTo(world, where))
  const ids = reserve(world, plan)
  const paths: string[] = []
  spawnReserved(world, plan, entity, ids, member, paths)
  const state: InstanceState = {
    def,
    template,
    plan,
    overridesKey: JSON.stringify(overrides),
    overrides,
    ids,
    sceneId: member?.scene,
    paths,
    own: previous?.own ?? ownFields(world, entity),
    applied: previous?.applied,
  }
  if (def === PrefabInstance) applyRoot(world, entity, state)
  const scene = member ? world.tryResource(SceneIndex)?.get(member.scene) : undefined
  if (scene) for (const g of template.requested) scene.assets.add(g)
  return state
}

/** Spawns instances system: does nothing on frames without instance or asset changes. */
export const sceneInstancesSystem = defineSystem({
  name: 'scene/instances',
  description: 'Spawns and respawns SceneInstance and PrefabInstance children.',
  run: (_, world) => {
    const s = perWorld.get(world)
    if (s?.dirty) updateInstances(world)
  },
})

/** Scene support for apps: spawns instance children added while the app runs. */
export const ScenePlugin: Plugin = {
  name: 'scene',
  build(app) {
    hookInstances(app.world)
    app.addSystems(PreUpdate, sceneInstancesSystem)
  },
}

/**
 * Spawns the children of every SceneInstance and PrefabInstance whose asset is loaded (requesting
 * it otherwise), respawns those whose asset, dependencies, or overrides changed, and cleans up after
 * removed instances. Instances inlined into another instance are part of it and skipped.
 */
export function updateInstances(world: World): void {
  const s = stateOf(world)
  s.dirty = false
  const server = assetServer(world)
  for (const [entity, state] of [...s.states]) {
    if (world.isAlive(entity) && world.has(entity, state.def)) continue
    despawnGenerated(world, state)
    s.states.delete(entity)
  }
  const todo: [Entity, InstanceDef, AssetEntry, Overrides][] = []
  for (const def of [SceneInstance, PrefabInstance] as InstanceDef[]) {
    const field = def === PrefabInstance ? 'prefab' : 'scene'
    const q = world.query({ with: [def], without: [InstancePart] })
    for (const table of q.tables) {
      const refs = table.column(def, field as never) as unknown as (AssetRef | null)[]
      const overrides = table.column(def, 'overrides' as never) as unknown as JsonValue[]
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
        const state = s.states.get(entity)
        const o = overridesOf(overrides[i])
        if (
          state &&
          state.def === def &&
          state.template.entry.guid === entry.guid &&
          isCurrent(world, state.template) &&
          state.template.flat.missing.size === 0 &&
          state.overridesKey === JSON.stringify(o)
        ) {
          continue
        }
        todo.push([entity, def, entry, o])
      }
    }
  }
  for (const [entity, def, entry, overrides] of todo) {
    let template: Template
    try {
      template = templateFor(world, entry)
    } catch (err) {
      world.tryResource(LogResource)?.error(err)
      continue
    }
    if (template.flat.missing.size > 0) continue // nested assets still loading
    const old = s.states.get(entity)
    if (old) despawnGenerated(world, old)
    s.states.set(entity, instantiate(world, entity, def, template, overrides, old))
  }
}

/** Waits for instance assets to load and spawns them (repeatedly, for nested instances). */
export async function settleInstances(world: World): Promise<void> {
  const server = assetServer(world)
  for (let round = 0; round < 8; round++) {
    updateInstances(world)
    const pending = new Set<string>()
    for (const def of [SceneInstance, PrefabInstance] as InstanceDef[]) {
      const field = def === PrefabInstance ? 'prefab' : 'scene'
      const q = world.query({ with: [def], without: [InstancePart] })
      for (const table of q.tables) {
        const refs = table.column(def, field as never) as unknown as (AssetRef | null)[]
        for (let i = 0; i < table.count; i++) {
          const entry = refs[i] ? server.entry(refs[i]!) : undefined
          if (entry && (entry.state === 'loading' || entry.state === 'unloaded'))
            pending.add(entry.guid)
        }
      }
    }
    for (const t of stateOf(world).templates.values())
      for (const g of t.flat.missing) pending.add(g)
    if (pending.size === 0) return
    await server.whenSettled(pending)
  }
}

// --- spawnPrefab -------------------------------------------------------------------------------------

export interface SpawnPrefabOptions {
  /** Fields of the root's Transform (the rest come from the prefab). */
  transform?: {
    translation?: readonly number[]
    rotation?: readonly number[]
    scale?: readonly number[]
  }
  /** Changes to generated entities, as in a scene's `PrefabInstance.overrides`. */
  overrides?: Overrides
  parent?: Entity
}

type PrefabRef = string | AssetRef | { guid?: string; path?: string }

function prefabEntry(world: World, ref: PrefabRef): AssetEntry {
  const entry = assetServer(world).entry(ref as never)
  const label = typeof ref === 'string' ? ref : (ref.path ?? ref.guid)
  if (entry?.type !== 'Prefab') {
    throw new ShardError('prefab/not-found', `No prefab "${label}" in the catalog`, {
      hint: 'Pass a *.prefab.json path under an asset root (run `shard import` for new files), or register one with registerPrefab.',
    })
  }
  return entry
}

/**
 * Loads a prefab (and everything it uses) so `spawnPrefab` can spawn it. Resolves with its
 * template ready.
 */
export async function loadPrefab(world: World, ref: PrefabRef): Promise<void> {
  const entry = prefabEntry(world, ref)
  const server = assetServer(world)
  for (let round = 0; round < 8; round++) {
    await server.load(entry.guid)
    const template = templateFor(world, entry)
    if (template.flat.missing.size === 0) return
    await server.whenSettled(template.flat.missing)
  }
}

/**
 * Spawns a prefab instance now (or, given a system's Commands, when they apply) and returns its
 * root. The prefab must be loaded (`loadPrefab`); spawning copies a compiled template, so it's cheap
 * enough for bullets. Scene files place prefabs with `scene/PrefabInstance`, which waits for loading.
 */
export function spawnPrefab(
  target: World | Commands,
  ref: PrefabRef,
  options: SpawnPrefabOptions = {},
): Entity {
  const world = target instanceof Commands ? target.world : target
  const entry = prefabEntry(world, ref)
  let template: Template | undefined
  if (entry.state === 'loaded') {
    const s = stateOf(world)
    const cached = s.templates.get(entry.guid)
    // Hot path: the cached template, checked with a map lookup per dependency.
    template = cached && isCurrent(world, cached) ? cached : templateFor(world, entry)
  }
  if (!template || template.flat.missing.size > 0) {
    throw new ShardError('prefab/not-loaded', `Prefab ${entry.path} isn't loaded`, {
      hint: 'Preload it with `await loadPrefab(world, path)`, or place it with scene/PrefabInstance, which waits for it to load.',
    })
  }
  const overrides = options.overrides
  const plan = overrides
    ? planFor(world, template, overrides, reportTo(world, `spawnPrefab ${entry.path}`))
    : template
  const root = world.reserveEntity()
  const ids = reserve(world, plan)
  const spawn = (w: World) => spawnInstance(w, entry, template, plan, root, ids, options)
  if (target instanceof Commands) target.run(spawn)
  else spawn(world)
  return root
}

function spawnInstance(
  world: World,
  entry: AssetEntry,
  template: Template,
  plan: Plan,
  root: Entity,
  ids: Entity[],
  options: SpawnPrefabOptions,
): void {
  const inits: [ComponentDef, Record<string, unknown>][] = []
  const own = new Map<string, Set<string>>()
  if (plan.root) {
    resolveRefs(plan.root, ids, root)
    for (let k = 0; k < plan.root.defs.length; k++) inits.push(plan.root.inits[k]!)
  }
  if (options.transform) {
    const k = inits.findIndex(([d]) => d === (Transform as ComponentDef))
    const value = { ...(k === -1 ? {} : inits[k]![1]), ...options.transform }
    if (k === -1) inits.push([Transform as ComponentDef, value])
    else inits[k] = [Transform as ComponentDef, value]
    own.set(Transform.name, new Set(Object.keys(options.transform)))
  }
  inits.push([
    PrefabInstance as ComponentDef,
    {
      prefab: { type: 'Prefab', guid: entry.guid, path: entry.path },
      overrides: options.overrides ?? {},
    },
  ])
  if (options.parent !== undefined)
    inits.push([ChildOf as ComponentDef, { parent: options.parent }])
  // Runtime instances belong to a scene only through their parent: then they get scene paths.
  const parent = options.parent === undefined ? undefined : memberOf(world, options.parent)
  const member = parent && {
    scene: parent.scene,
    path: `${parent.path}/${template.flat.rootName ?? 'prefab'}`,
  }
  const paths: string[] = []
  if (member) {
    inits.push([SceneMember as ComponentDef, member])
    world.tryResource(SceneIndex)?.get(member.scene)?.entities.set(member.path, root)
    paths.push(member.path)
  }
  world.spawnReserved(root, inits)
  spawnReserved(world, plan, root, ids, member, paths)
  const s = stateOf(world)
  s.states.set(root, {
    def: PrefabInstance,
    template,
    plan,
    overridesKey: JSON.stringify(options.overrides ?? {}),
    overrides: options.overrides ?? {},
    ids,
    sceneId: member?.scene,
    paths,
    own,
    applied: template.root ? canonicalOf(template).get(-1) : undefined,
  })
}

/** The generated entities of an instance, by path relative to it (e.g. "Hull/Cockpit"). */
export function instanceEntities(world: World, entity: Entity): Map<string, Entity> {
  const state = perWorld.get(world)?.states.get(entity)
  const out = new Map<string, Entity>()
  if (!state) return out
  for (let i = 0; i < state.ids.length; i++) {
    const id = state.ids[i]!
    if (id >= 0 && world.isAlive(id)) out.set(state.plan.flat.nodes[i]!.path, id)
  }
  return out
}

/** The instance entity (prefab or model) at the top of a generated entity, or the entity itself. */
export function instanceOf(world: World, entity: Entity): Entity | undefined {
  if (perWorld.get(world)?.states.has(entity)) return entity
  const part = world.tryGet(entity, InstancePart)
  return part?.instance ?? undefined
}

// --- saving ---------------------------------------------------------------------------------------

/** One scratch world serializes template values as they'd be stored (f32 rounding and all). */
let scratch: World | undefined

function canonicalOf(template: Template): Map<number, Map<string, Record<string, JsonValue>>> {
  if (template.canonical) return template.canonical
  const out = new Map<number, Map<string, Record<string, JsonValue>>>()
  const nodes = template.flat.nodes
  const pathOf = (target: number) => (target === -1 ? '.' : nodes[target]!.path)
  const add = (i: number, t: TemplateEntity) => out.set(i, canonicalComponents(t, pathOf))
  if (template.root) add(-1, template.root)
  else out.set(-1, new Map())
  for (let i = 0; i < template.entities.length; i++) {
    const t = template.entities[i]
    if (t) add(i, t)
  }
  template.canonical = out
  return out
}

function canonicalComponents(
  t: TemplateEntity,
  pathOf: (target: number) => string,
): Map<string, Record<string, JsonValue>> {
  scratch ??= new World()
  const e = scratch.spawn(
    ...t.defs.map((d, k) => [d, t.values[k]!] as [ComponentDef, Record<string, unknown>]),
  )
  const json = serializeComponents(scratch, e)
  scratch.despawn(e)
  for (const r of t.refs) {
    const comp = json.get(t.defs[r.component]!.name)
    if (comp) comp[r.field] = pathOf(r.target)
  }
  return json
}

/** An entity's components as JSON, entity fields as paths relative to the instance. */
function liveComponents(
  world: World,
  entity: Entity,
  pathOf: Map<Entity, string>,
): Map<string, Record<string, JsonValue>> {
  const json = serializeComponents(world, entity)
  for (const [name, value] of json) {
    const def = componentDef(name)!
    for (const { name: field, field: type } of def.layout) {
      const v = value[field]
      if (type.kind === 'entity' && typeof v === 'number' && pathOf.has(v))
        value[field] = pathOf.get(v)!
    }
  }
  return json
}

/** Fields to write for one component: authored forms where untouched, else what changed. */
function diffFields(
  name: string,
  authored: Record<string, JsonValue>,
  now: Record<string, JsonValue>,
  loaded: Record<string, JsonValue> | undefined,
  base: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  const aliases = ALIASES[name] ?? {}
  const covered = new Set<string>()
  for (const [key, value] of Object.entries(authored)) {
    const field = aliases[key]?.field ?? key
    covered.add(field)
    if (loaded && equal(now[field], loaded[field])) out[key] = value
    else if (base && equal(now[field], base[field])) continue
    else if (field in now) out[field] = now[field]!
  }
  const reference = base ?? loaded
  for (const field of Object.keys(now)) {
    if (covered.has(field)) continue
    if (!reference || !equal(now[field], reference[field])) out[field] = now[field]!
  }
  return out
}

/**
 * An instance's current differences from its prefab or model, as overrides: what a save writes.
 * Overrides already in the file keep their order and authored form while unchanged; stale ones
 * (paths that no longer exist) are kept. Undefined for entities that aren't spawned instances.
 */
export function currentOverrides(world: World, entity: Entity): Overrides | undefined {
  const state = perWorld.get(world)?.states.get(entity)
  if (!state) return undefined
  const { template, plan, ids } = state
  const nodes = plan.flat.nodes
  const base = canonicalOf(template)
  const pathOf = new Map<Entity, string>([[entity, '.']])
  for (let i = 0; i < ids.length; i++) if (ids[i]! >= 0) pathOf.set(ids[i]!, nodes[i]!.path)
  const alive = (i: number) => ids[i]! >= 0 && world.isAlive(ids[i]!)
  const loadedCache = new Map<number, Map<string, Record<string, JsonValue>>>()
  const loadedOf = (i: number) => {
    if (!plan.flat.touched.has(i)) return base.get(i)
    let m = loadedCache.get(i)
    if (!m && plan.entities[i]) {
      m = canonicalComponents(plan.entities[i]!, (t) => (t === -1 ? '.' : nodes[t]!.path))
      loadedCache.set(i, m)
    }
    return m
  }
  const live = new Map<number, Map<string, Record<string, JsonValue>>>()
  const liveOf = (i: number) => {
    let m = live.get(i)
    if (!m) {
      m = liveComponents(world, ids[i]!, pathOf)
      live.set(i, m)
    }
    return m
  }
  const out: Overrides = {}
  const handled = new Set<string>()
  const gone = new Set<number>()

  for (const [key, value] of Object.entries(state.overrides)) {
    const i = plan.flat.index.get(key)
    if (value === null) {
      if (i !== undefined) {
        if (!alive(i)) {
          out[key] = null
          gone.add(i)
        }
        continue
      }
      const cut = splitComponentKey(plan.flat, key)
      if (!cut)
        out[key] = null // stale: kept as written
      else if (alive(cut.i) && !liveOf(cut.i).has(cut.component)) {
        out[key] = null
        handled.add(`${cut.i}|${cut.component}`)
      }
      continue
    }
    if (i === undefined || !isPlainObject(value)) {
      out[key] = value // stale
      continue
    }
    if (!alive(i)) continue
    const entry: Record<string, Record<string, JsonValue> | null> = {}
    for (const [name, patch] of Object.entries(value)) {
      const now = liveOf(i).get(name)
      if (patch === null) {
        if (!now) {
          entry[name] = null
          handled.add(`${i}|${name}`)
        }
        continue
      }
      if (!now || !isPlainObject(patch)) continue
      handled.add(`${i}|${name}`)
      const b = base.get(i)?.get(name)
      const fields = diffFields(name, patch, now, loadedOf(i)?.get(name), b)
      if (Object.keys(fields).length > 0 || !b) entry[name] = fields
    }
    if (Object.keys(entry).length > 0) out[key] = entry
  }

  for (let i = 0; i < nodes.length; i++) {
    if (!template.entities[i]) continue // removed by the prefab itself
    const path = nodes[i]!.path
    const parent = nodes[i]!.parent
    if (!alive(i)) {
      const parentGone = parent !== -1 && (!alive(parent) || gone.has(parent))
      if (!parentGone && !gone.has(i)) out[path] = null
      gone.add(i)
      continue
    }
    const b = base.get(i) ?? new Map()
    const now = liveOf(i)
    const existing = out[path]
    const entry: Record<string, Record<string, JsonValue> | null> = isPlainObject(existing)
      ? (existing as Record<string, Record<string, JsonValue> | null>)
      : {}
    // Compared with the entity as spawned, so components that came and went along with an
    // override (a removed Mesh3d's Visibility) aren't reported again.
    const loaded = loadedOf(i)
    for (const name of b.keys()) {
      if (handled.has(`${i}|${name}`) || now.has(name) || !loaded?.has(name)) continue
      out[`${path}/${name}`] = null
    }
    for (const [name, value] of now) {
      if (handled.has(`${i}|${name}`)) continue
      const before = b.get(name)
      if (!before) {
        const spawned = loaded?.get(name)
        if (!spawned || !equal(spawned, value)) entry[name] = value
        continue
      }
      const fields: Record<string, JsonValue> = {}
      for (const field of Object.keys(value))
        if (!equal(value[field], before[field])) fields[field] = value[field]!
      if (Object.keys(fields).length > 0) entry[name] = fields
    }
    if (Object.keys(entry).length > 0) out[path] = entry
  }
  return out
}

// --- apply to prefab --------------------------------------------------------------------------------

/** What `applyToPrefab` needs from the host: the prefab file's JSON, and where to write it. */
export interface PrefabSource {
  read(path: string): Promise<unknown>
  write(path: string, json: unknown): Promise<void>
}

/**
 * Merges overrides into a prefab file's JSON: component patches merge into the authored components,
 * removals delete, and paths inside a nested instance land in that instance's overrides. Variants
 * (files with "extends") merge into their own "overrides". Returns the new JSON.
 */
export function mergeOverridesIntoPrefab(
  file: PrefabFile,
  overrides: Overrides,
  onUnknown?: (key: string) => void,
): PrefabFile {
  const out = structuredClone(file)
  if (out.extends !== undefined || !out.root) {
    const merged: Overrides = { ...(out.overrides ?? {}) }
    for (const [key, value] of Object.entries(overrides)) {
      const prev = merged[key]
      merged[key] =
        isPlainObject(prev) && isPlainObject(value)
          ? mergePatch(prev as Record<string, Record<string, JsonValue> | null>, value)
          : value
    }
    out.overrides = merged
    return out
  }
  const root = out.root
  const find = (
    path: string,
  ): { entity: SceneEntity; rest: string; parent?: SceneEntity } | undefined => {
    const parts = path.split('/')
    let list = root.children ?? []
    let parent: SceneEntity = root
    for (let k = 0; k < parts.length; k++) {
      const e = list.find((c) => c.name === parts[k])
      if (!e) {
        // Past a nested instance: the rest of the path is inside it.
        if (k > 0 && instanceDefOf(expandComponents(parent.components)))
          return { entity: parent, rest: parts.slice(k).join('/') }
        return undefined
      }
      if (k === parts.length - 1) return { entity: e, rest: '', parent }
      parent = e
      list = e.children ?? []
    }
    return undefined
  }
  const nestedOverrides = (entity: SceneEntity): Overrides => {
    entity.components ??= {}
    const comps = entity.components
    const def = instanceDefOf(comps as ComponentsJson)!
    const inst = comps[def.name]!
    if (!isPlainObject(inst.overrides)) inst.overrides = {}
    return inst.overrides as unknown as Overrides
  }
  const setNested = (host: SceneEntity, key: string, value: Overrides[string]) => {
    const target = nestedOverrides(host)
    const prev = target[key]
    target[key] =
      isPlainObject(prev) && isPlainObject(value)
        ? mergePatch(prev as Record<string, Record<string, JsonValue> | null>, value)
        : value
  }
  for (const [key, value] of Object.entries(overrides)) {
    // A trailing component name removes that component.
    const parts = key.split('/')
    const component = parts.slice(-2).join('/')
    const owner =
      value === null && parts.length >= 3 && componentDef(component) && !find(key)
        ? find(parts.slice(0, -2).join('/'))
        : undefined
    if (owner) {
      if (owner.rest === '') delete owner.entity.components?.[component]
      else setNested(owner.entity, `${owner.rest}/${component}`, null)
      continue
    }
    const hit = find(key)
    if (!hit) {
      onUnknown?.(key) // stale: nothing to apply it to
      continue
    }
    if (hit.rest !== '') {
      setNested(hit.entity, hit.rest, value)
      continue
    }
    if (value === null) {
      const siblings = hit.parent?.children
      if (siblings) siblings.splice(siblings.indexOf(hit.entity), 1)
      continue
    }
    hit.entity.components ??= {}
    const comps = hit.entity.components
    for (const [name, patch] of Object.entries(value)) {
      if (patch === null) delete comps[name]
      else comps[name] = { ...stripAliases(name, comps[name] ?? {}, patch), ...patch }
    }
  }
  return out
}

/** A field written in its authored alias (rotationEuler) is replaced when the patch sets the field. */
function stripAliases(
  name: string,
  authored: Record<string, JsonValue>,
  patch: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const aliases = ALIASES[name]
  if (!aliases) return authored
  const out = { ...authored }
  for (const [alias, { field }] of Object.entries(aliases)) {
    if (field in patch) delete out[alias]
    if (alias in patch) delete out[field]
  }
  return out
}

function mergePatch(
  a: Record<string, Record<string, JsonValue> | null>,
  b: Record<string, Record<string, JsonValue> | null>,
): Record<string, Record<string, JsonValue> | null> {
  const out = { ...a }
  for (const [name, patch] of Object.entries(b)) {
    const prev = out[name]
    out[name] = patch && prev ? { ...prev, ...patch } : patch
  }
  return out
}

/** The prefab asset an instance entity places, or undefined. */
export function prefabOfInstance(world: World, entity: Entity): AssetEntry | undefined {
  const state = perWorld.get(world)?.states.get(entity)
  return state?.def === PrefabInstance ? state.template.entry : undefined
}

// --- validation ------------------------------------------------------------------------------------

/**
 * Checks an instance component's overrides in a scene or prefab file: shape always; paths and
 * values when the asset is loaded (so `shard validate` preloads them with `loadInstanceAssets`).
 */
export function validateInstance(
  world: World,
  def: InstanceDef,
  json: Record<string, JsonValue>,
  base: string,
  f: FlatEntity,
  errors: ShardError[],
  options: { catalog: boolean },
): void {
  const overrides = json.overrides
  const at = `${base}/overrides`
  if (overrides === undefined || overrides === null) return
  if (!isPlainObject(overrides)) {
    errors.push(
      new ShardError('schema/type-mismatch', '"overrides" must be an object', {
        path: at,
        hint: 'Map paths to component patches: { "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } } }.',
      }),
    )
    return
  }
  if (!options.catalog) return
  const ref = handleOf(json, def === PrefabInstance ? 'prefab' : 'scene')
  const entry = ref && assetServer(world).entry(ref)
  if (entry?.state !== 'loaded') return
  let flat: Flat
  try {
    flat = fork(flattenSource(world, entry, []))
  } catch (err) {
    if (err instanceof ShardError)
      errors.push(new ShardError(err.code, err.message, { path: base, hint: err.hint }))
    return
  }
  const check = checkContext(world, flat, entry.path)
  applyOverrides(
    flat,
    overrides as Overrides,
    '',
    (_, e) => errors.push(rebase(e, at)),
    (d, j) => d.validate(j, check),
  )
  // Authored children sit next to the generated ones: names can't clash.
  for (const [k, child] of (f.entity.children ?? []).entries()) {
    if (typeof child?.name === 'string' && flat.index.has(child.name)) {
      errors.push(
        new ShardError(
          'prefab/duplicate-name',
          `"${child.name}" is also the name of an entity the instance generates`,
          {
            path: `${f.pointer}/children/${k}/name`,
            hint: 'Rename the child, or change the generated one with "overrides" instead.',
          },
        ),
      )
    }
  }
}

/** Loads the prefab and model assets a scene's instances use, so validation can check overrides. */
export async function loadInstanceAssets(world: World, json: unknown): Promise<void> {
  const server = assetServer(world)
  const refs = new Set<string>()
  const walk = (entities: unknown) => {
    if (!Array.isArray(entities)) return
    for (const e of entities) {
      if (!isPlainObject(e)) continue
      const comps = e.components
      if (isPlainObject(comps)) {
        for (const [name, field] of [
          [PrefabInstance.name, 'prefab'],
          [SceneInstance.name, 'scene'],
        ] as const) {
          const ref = handleOf(comps[name] as Record<string, JsonValue> | undefined, field)
          const entry = ref && server.entry(ref)
          if (entry) refs.add(entry.guid)
        }
      }
      walk(e.children)
    }
  }
  if (isPlainObject(json)) {
    walk(json.entities)
    if (isPlainObject(json.root)) walk([json.root])
  }
  // Nested prefabs load as dependencies of the ones that contain them.
  await server.whenSettled(refs)
}
