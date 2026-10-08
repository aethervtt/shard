import { assetServer } from '@aethervtt/shard-assets'
import {
  allComponents,
  ChildOf,
  Children,
  type ComponentDef,
  defineSchema,
  type Entity,
  findComponent,
  findResource,
  isPlainObject,
  type JsonValue,
  Last,
  PostUpdate,
  ProfilerResource,
  type ResourceDef,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  describeInput,
  injectInput,
  type SimulatedGesture,
  simulateGestures,
  startRecording,
  startReplay,
  stopRecording,
} from '@aethervtt/shard-input'
import type { Platform } from '@aethervtt/shard-platform'
import {
  captureBuffer,
  captureShadowMap,
  captureView,
  DebugOverlays,
  type DebugView,
  describeRender,
  Gizmos,
  Gpu,
  isOverlayOn,
  OffscreenTarget,
  OVERLAYS,
  overlayNames,
  type PickHit,
  pick,
  raycast,
  Shaders,
  setDebugView,
  setOverlays,
  Views,
  Window,
} from '@aethervtt/shard-render'
import {
  type App,
  AppControlResource,
  capturePerf,
  describePerf,
  type LogEntry,
  LogResource,
  Time,
} from '@aethervtt/shard-runtime'
import {
  applyToPrefab,
  currentOverrides,
  expandComponentAliases,
  findEntityByPath,
  instanceEntities,
  loadPrefab,
  loadScene,
  type Overrides,
  pathOfEntity,
  reloadScene,
  SceneIndex,
  saveScene,
  spawnPrefab,
  stringifyScene,
  validateScene,
  whenSceneReady,
  worldSchemaContext,
} from '@aethervtt/shard-scene'
import { Fonts, measureText } from '@aethervtt/shard-text'
import {
  createPlacement,
  FloatingOrigin,
  Grid,
  gridOf,
  placeInGrid,
  placementOf,
  Transform,
  worldPosition64,
} from '@aethervtt/shard-transform'
import { encodePng, toBase64 } from './png'

const CAPTURE_DEBUG_VIEWS = ['clusters', 'cascades', 'lod', 'culling', 'none']

import { previewAsset } from './preview'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params: unknown
}

export interface MethodDef {
  name: string
  description: string
  params: ComponentDef
  handler(ctx: HandlerContext, params: Record<string, unknown>): unknown
}

export interface HandlerContext {
  app: App
  world: World
  options: ProtocolServerOptions
}

export interface ProtocolServerOptions {
  /**
   * 'manual': the host has no frame loop (headless servers, tests); `time.step` runs frames itself.
   * 'loop': a runner drives frames; `time.step` waits for it. Default 'manual'.
   */
  frames?: 'manual' | 'loop'
  /** For scene files by path. */
  platform?: Platform
  /** Extra methods from the host (e.g. `project.reload`), added to the built-in ones. */
  methods?: readonly MethodDef[]
  /**
   * The only methods this server answers (0061): everything else, `subscribe` included, fails with
   * `protocol/method-not-allowed`. A host that forwards requests from hosted mods passes the few
   * it allows; omit it for agents and tools, which get every method.
   */
  allow?: readonly string[]
}

const ERROR = { parse: -32700, invalid: -32600, notFound: -32601, params: -32602, shard: -32000 }

// --- helpers -------------------------------------------------------------------

function resolveEntity(world: World, ref: unknown): Entity {
  if (typeof ref === 'number' && world.isAlive(ref)) return ref
  if (typeof ref === 'string') {
    const e = findEntityByPath(world, ref)
    if (e !== undefined) return e
  }
  throw new ShardError('protocol/unknown-entity', `No live entity ${JSON.stringify(ref)}`, {
    hint: 'Pass an entity id from world.query, or a scene path like "ship/camera".',
  })
}

function knownComponent(name: string): ComponentDef {
  const def = findComponent(name)
  if (!def) {
    throw new ShardError('protocol/unknown-component', `Unknown component "${name}"`, {
      hint: 'schema.list returns every component name.',
    })
  }
  return def
}

function requireOwner(world: World, name: string) {
  const owner = world.owners.find(name)
  if (!owner) {
    throw new ShardError('protocol/unknown-owner', `No live owner "${name}"`, {
      hint: 'owners.describe with no name lists every live owner.',
    })
  }
  return owner
}

/** A component a protocol write may name: ownership is a grant from host code (0061). */
function requireComponent(name: string): ComponentDef {
  const def = knownComponent(name)
  if (def.hostOnly) {
    throw new ShardError(
      'core/owner-not-authorable',
      `"${name}" can't be written through the protocol`,
      {
        hint: 'Ownership comes from host code holding an Owner (world.owners).',
      },
    )
  }
  return def
}

function toJson(value: unknown): JsonValue {
  const seen = new WeakSet()
  return JSON.parse(
    JSON.stringify(value, (_, v) => {
      if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
      if (typeof v === 'function') return undefined
      if (v instanceof Map) return Object.fromEntries(v)
      if (v instanceof Set) return [...v]
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]'
        seen.add(v)
      }
      return v
    }) ?? 'null',
  )
}

function entityJson(world: World, entity: Entity, only?: readonly string[]) {
  const components: Record<string, JsonValue> = {}
  for (const def of world.componentsOf(entity)) {
    if (!def.serializable && def !== ChildOf) continue
    if (only && !only.includes(def.name)) continue
    components[def.name] = def.serialize(world.get(entity, def))
  }
  const path = pathOfEntity(world, entity)
  const out: {
    id: Entity
    path?: string
    components: typeof components
    worldPosition64?: number[]
  } = path === undefined ? { id: entity, components } : { id: entity, path, components }
  // With grids, GlobalTransform is relative to the floating origin; this is the exact f64 position.
  if (!only && hasGrids(world) && world.has(entity, Transform))
    out.worldPosition64 = [...worldPosition64(world, entity, new Float64Array(3))]
  return out
}

function hasGrids(world: World): boolean {
  return world.query({ with: [Grid] }).count() > 0
}

function firstOf(world: World, def: ComponentDef): Entity | undefined {
  return world.query({ with: [def] }).entities()[0]
}

/** The grid tree for app.describe (spec 0040): each grid and where the floating origin is. */
function describeGrids(world: World) {
  const place = createPlacement()
  const refOf = (e: Entity) => pathOfEntity(world, e) ?? e
  const grids = world
    .query({ with: [Grid] })
    .entities()
    .map((e) => {
      placementOf(world, e, place, true)
      const children = world.tryGet(e, Children)?.entities ?? []
      return {
        grid: refOf(e),
        cellSize: world.get(e, Grid).cellSize,
        parent: place.grid < 0 ? null : refOf(place.grid),
        cell: [...place.cell],
        entities: children.filter((c) => c !== null).length,
      }
    })
  const originEntity = firstOf(world, FloatingOrigin)
  let origin: { entity: Entity | string; grid: Entity | string | null; cell: number[] } | null =
    null
  if (originEntity !== undefined) {
    placementOf(world, originEntity, place, true)
    origin = {
      entity: refOf(originEntity),
      grid: place.grid < 0 ? null : refOf(place.grid),
      cell: [...place.cell],
    }
  }
  return { grids, origin }
}

/** Validates and converts component JSON; throws with every error (pointer-prefixed) in `details`. */
function prepareComponents(world: World, input: Record<string, unknown>, base: string) {
  const ctx = worldSchemaContext(world)
  const out: [ComponentDef, Record<string, unknown>][] = []
  const errors: ShardError[] = []
  for (const [name, raw] of Object.entries(input)) {
    const def = requireComponent(name)
    if (!isPlainObject(raw)) {
      errors.push(
        new ShardError('schema/type-mismatch', `"${name}" must be an object`, {
          path: `${base}/${name}`,
        }),
      )
      continue
    }
    const json = expandComponentAliases(name, raw as Record<string, JsonValue>)
    const problems = def.validate(json, ctx)
    for (const p of problems) {
      errors.push(
        new ShardError(p.code, p.message, {
          path: `${base}/${name.replace('/', '~1')}${p.path ?? ''}`,
          hint: p.hint,
        }),
      )
    }
    if (problems.length === 0) out.push([def, def.deserialize(json, ctx)])
  }
  if (errors.length > 0) {
    throw new ShardError(
      'protocol/invalid-components',
      `${errors.length} invalid value(s); first: ${errors[0]!.message}`,
      {
        path: errors[0]!.path,
        hint: errors[0]!.hint,
        details: errors,
      },
    )
  }
  return out
}

async function readJson(ctx: HandlerContext, file: string): Promise<unknown> {
  if (!ctx.options.platform)
    throw new ShardError('protocol/no-files', "This host can't read files; pass JSON instead")
  return JSON.parse(await ctx.options.platform.fs.readText(file))
}

/** Renders the current state without advancing simulation (propagation + render only). */
function renderOnly(app: App): void {
  app.runSchedule(PostUpdate)
  app.runSchedule(Last)
}

/**
 * Waits until shaders and pipelines have compiled, so a capture shows everything instead of a frame
 * where draws were skipped. `render` produces a frame (render-only, or waiting for the loop).
 */
async function whenRenderReady(world: World, render: () => Promise<void> | void): Promise<void> {
  const gpu = world.tryResource(Gpu)
  const shaders = world.tryResource(Shaders)
  if (!gpu) return
  for (let i = 0; i < 20; i++) {
    await render()
    await shaders?.whenIdle()
    await gpu.pipelines.whenIdle()
    if (gpu.pipelines.skipped === 0 && gpu.pipelines.pending === 0) return
  }
}

/** Checks overlay names, so a typo is an error rather than nothing drawn. */
function checkOverlays(list: unknown): string[] {
  const names = (list as string[] | undefined) ?? []
  const known = overlayNames()
  for (const name of names) {
    if (!known.includes(name)) {
      throw new ShardError('protocol/unknown-overlay', `Unknown overlay "${name}"`, {
        hint: `Overlays: ${known.join(', ')}.`,
      })
    }
  }
  return names
}

/** Exactly these overlays on (others off), with a filter; returns a function that restores. */
function applyOverlays(world: World, names: string[], components: string[], path: string) {
  const o = world.resource(DebugOverlays)
  const all = overlayNames()
  const before = {
    on: Object.fromEntries(all.map((k) => [k, isOverlayOn(o, k)])),
    filter: { ...o.filter },
  }
  setOverlays(world, Object.fromEntries(all.map((k) => [k, names.includes(k)])), {
    components,
    path,
  })
  return () => setOverlays(world, before.on, before.filter)
}

function hitJson(hit: PickHit) {
  return {
    entity: hit.entity,
    path: hit.path ?? null,
    position: hit.position,
    normal: hit.normal,
    distance: hit.distance,
  }
}

/** Resolves after the loop's next frame. */
function nextFrame(app: App): Promise<void> {
  return new Promise((resolve) => {
    const off = app.onFrame(() => {
      off()
      resolve()
    })
  })
}

/** A depth buffer as grayscale: nearest (reversed-Z: largest) white, background black. */
function depthImage(map: { width: number; height: number; data: Float32Array }) {
  let lo = Number.POSITIVE_INFINITY
  let hi = 0
  for (let i = 0; i < map.data.length; i += 4) {
    const d = map.data[i]!
    if (d > 0) {
      if (d < lo) lo = d
      if (d > hi) hi = d
    }
  }
  const data = new Uint8Array(map.width * map.height * 4)
  const span = hi > lo ? hi - lo : 1
  for (let i = 0; i < map.data.length; i += 4) {
    const d = map.data[i]!
    const v = d > 0 ? Math.round(40 + ((d - lo) / span) * 215) : 0
    data[i] = data[i + 1] = data[i + 2] = v
    data[i + 3] = 255
  }
  return { width: map.width, height: map.height, data }
}

/** entity.patch's position64/grid, checked before anything changes. */
function placementParams(
  world: World,
  entity: Entity,
  p: Record<string, unknown>,
): { grid: Entity; position: number[] } | undefined {
  const position = p.position64 as number[] | undefined
  const hasGrid = p.grid !== null && p.grid !== undefined
  if (!position || position.length === 0) {
    if (hasGrid) {
      throw new ShardError('protocol/invalid-position64', '"grid" needs "position64"', {
        path: '/position64',
        hint: 'Pass { "position64": [x, y, z], "grid": <grid> } together.',
      })
    }
    return undefined
  }
  if (position.length !== 3 || !position.every((v) => Number.isFinite(v))) {
    throw new ShardError('protocol/invalid-position64', '"position64" must be [x, y, z]', {
      path: '/position64',
      hint: 'Three finite numbers in metres, e.g. [3.8e8, 0, 0].',
    })
  }
  const grid = hasGrid ? resolveEntity(world, p.grid) : gridOf(world, entity)
  if (grid === undefined || !world.has(grid, Grid)) {
    throw new ShardError(
      'protocol/not-a-grid',
      hasGrid ? `${JSON.stringify(p.grid)} is not a Grid` : 'The entity is not in a grid',
      {
        path: '/grid',
        hint: 'Pass "grid": the id or path of an entity with transform/Grid.',
      },
    )
  }
  return { grid, position }
}

// --- methods -------------------------------------------------------------------

const s = <F extends Parameters<typeof defineSchema>[1]>(name: string, fields: F) =>
  defineSchema(`protocol/${name}`, fields)
const entityRef = () =>
  t.entity({ required: true, description: 'Entity id, or scene path like "ship/camera".' })
const none = s('None', {})

export const METHODS: MethodDef[] = [
  {
    name: 'app.describe',
    description:
      'Plugins, schedules, and systems in run order; renderer and input state when present.',
    params: none,
    handler: ({ app, world }) => {
      const out: Record<string, unknown> = { ...app.describe(), entities: world.entityCount }
      if (world.tryResource(Views)) out.render = describeRender(world)
      try {
        out.input = describeInput(world)
      } catch {}
      out.scenes = [...(world.tryResource(SceneIndex)?.keys() ?? [])]
      if (hasGrids(world)) out.grids = describeGrids(world)
      return toJson(out)
    },
  },
  {
    name: 'schema.list',
    description: 'Every defined component with its description and JSON Schema.',
    params: none,
    handler: () =>
      allComponents()
        .filter((d) => !d.name.startsWith('protocol/'))
        .map((d) => ({
          name: d.name,
          description: d.description,
          serializable: d.serializable,
          requires: d.requires.map((r) => r.name),
        })),
  },
  {
    name: 'schema.get',
    description: "One component's JSON Schema (fields, types, ranges, presets, descriptions).",
    params: s('SchemaGetParams', {
      name: t.string({ required: true, description: 'Component name, e.g. "render/Camera3d".' }),
    }),
    handler: (_, p) => knownComponent(p.name as string).jsonSchema(),
  },
  {
    name: 'world.stats',
    description: 'Entity and archetype counts, and table memory.',
    params: none,
    handler: ({ world }) => world.stats(),
  },
  {
    name: 'world.query',
    description:
      'Entities that have every component in `with` and none in `without`, with their component values.',
    params: s('QueryParams', {
      with: t.list(t.string, { description: 'Component names the entity must have.' }),
      without: t.list(t.string, { description: 'Component names the entity must not have.' }),
      fields: t.list(t.string, { description: 'Only include these components (default: all).' }),
      limit: t.u32({ default: 50, min: 1, description: 'Maximum entities returned.' }),
    }),
    handler: ({ world }, p) => {
      const q = world.query({
        with: (p.with as string[]).map(requireComponent),
        without: (p.without as string[]).map(requireComponent),
      })
      const fields = (p.fields as string[]).length > 0 ? (p.fields as string[]) : undefined
      const ids = q.entities().slice(0, p.limit as number)
      return { total: q.count(), entities: ids.map((e) => entityJson(world, e, fields)) }
    },
  },
  {
    name: 'entity.get',
    description:
      'All components of one entity as JSON. With grids, also worldPosition64: its exact position relative to the floating origin.',
    params: s('EntityGetParams', { entity: entityRef() }),
    handler: ({ world }, p) => entityJson(world, resolveEntity(world, p.entity)),
  },
  {
    name: 'entity.spawn',
    description: 'Spawns an entity from component JSON (validated; required components are added).',
    params: s('SpawnParams', {
      components: t.json({ description: 'Component values by name, as in scene files.' }),
      parent: t.entity({ description: 'Optional parent entity or path.' }),
    }),
    handler: ({ world }, p) => {
      const inits = prepareComponents(
        world,
        (p.components ?? {}) as Record<string, unknown>,
        '/components',
      )
      if (p.parent !== null && p.parent !== undefined)
        inits.push([ChildOf as ComponentDef, { parent: resolveEntity(world, p.parent) }])
      const entity = world.spawn(...inits)
      return entityJson(world, entity)
    },
  },
  {
    name: 'entity.patch',
    description:
      'Merges fields into components (adding missing ones). All values are validated before anything changes; null removes a component. position64 + grid places the entity at an exact f64 position in a grid (cell and translation computed for you).',
    params: s('PatchParams', {
      entity: entityRef(),
      components: t.json({ description: 'Partial values by component name.' }),
      position64: t.list(t.f64, {
        description:
          "Exact position [x, y, z] in metres in `grid`'s frame; sets GridCell, Transform.translation, and the parent.",
      }),
      grid: t.entity({
        description: 'Grid entity or path for position64 (default: the grid the entity is in).',
      }),
    }),
    handler: ({ world }, p) => {
      const entity = resolveEntity(world, p.entity)
      const place = placementParams(world, entity, p)
      const patch = (p.components ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = {}
      const removals: ComponentDef[] = []
      for (const [name, value] of Object.entries(patch)) {
        const def = requireComponent(name)
        if (value === null) {
          removals.push(def)
          continue
        }
        const current = world.has(entity, def) ? def.serialize(world.get(entity, def)) : {}
        const partial = value as Record<string, JsonValue>
        // An authoring alias replaces the field it stands for.
        const base = { ...current } as Record<string, JsonValue>
        if (name === 'core/Transform' && 'rotationEuler' in partial) delete base.rotation
        merged[name] = { ...base, ...partial }
      }
      const prepared = prepareComponents(world, merged, '/components') // throws before any change
      for (const [def, value] of prepared) {
        if (world.has(entity, def)) world.set(entity, def, value)
        else world.add(entity, def, value)
      }
      for (const def of removals) world.remove(entity, def)
      if (place) placeInGrid(world, entity, place.grid, place.position)
      return entityJson(world, entity)
    },
  },
  {
    name: 'owners.describe',
    description:
      'Owners (0061). With a name: its usage (entities, triangles, textures, bytes), limits, child owners, asset leases and GPU objects. Without: every live owner.',
    params: s('OwnersDescribeParams', { name: t.string() }),
    handler: ({ world }, p) =>
      p.name
        ? world.owners.describe(requireOwner(world, p.name as string))
        : { owners: world.owners.list() },
  },
  {
    name: 'owners.release',
    description:
      'Releases an owner and its child owners: despawns their entities, drops their asset leases (unloading assets nobody else leases, with their GPU objects).',
    params: s('OwnersReleaseParams', { name: t.string({ required: true }) }),
    handler: ({ world }, p) => {
      const owner = requireOwner(world, p.name as string)
      const entities = world.owners.describe(owner).usage.entities
      world.owners.release(owner)
      return { released: owner.name, entities }
    },
  },
  {
    name: 'entity.despawn',
    description: 'Despawns an entity (and its children unless recursive is false).',
    params: s('DespawnParams', { entity: entityRef(), recursive: t.bool({ default: true }) }),
    handler: ({ world }, p) => {
      const entity = resolveEntity(world, p.entity)
      if (p.recursive) world.despawn(entity)
      else world.despawnSingle(entity)
      return { despawned: entity }
    },
  },
  {
    name: 'resource.get',
    description: "A resource's current value as JSON.",
    params: s('ResourceGetParams', { name: t.string({ required: true }) }),
    handler: ({ world }, p) => {
      const def = findResource(p.name as string)
      if (!def || !world.hasResource(def)) {
        throw new ShardError(
          'protocol/unknown-resource',
          `Resource "${p.name}" is not in the world`,
        )
      }
      return toJson(world.resource(def))
    },
  },
  {
    name: 'resource.set',
    description:
      'Merges fields into a plain-object resource (e.g. render/AmbientLight), marking it changed and waking an on-demand app.',
    params: s('ResourceSetParams', { name: t.string({ required: true }), value: t.json() }),
    handler: ({ world }, p) => {
      const def = findResource(p.name as string)
      if (def?.hostOnly) {
        throw new ShardError(
          'core/owner-not-authorable',
          `Resource "${p.name}" is written by the host only`,
          {
            hint: 'Host code sets it; the protocol can read it with resource.get.',
          },
        )
      }
      const current = def && world.tryResource(def)
      if (!def || !isPlainObject(current)) {
        throw new ShardError(
          'protocol/unsettable-resource',
          `Resource "${p.name}" can't be set from JSON`,
          {
            hint: 'Only resources that are plain JSON objects can be set.',
          },
        )
      }
      if (!isPlainObject(p.value))
        throw new ShardError('schema/type-mismatch', '"value" must be an object', {
          path: '/value',
        })
      world.patchResource(def as ResourceDef<object>, p.value)
      return toJson(current)
    },
  },
  {
    name: 'time.pause',
    description: 'Pauses the game (rendering continues showing the last frame).',
    params: none,
    handler: ({ world }) => {
      world.resource(AppControlResource).paused = true
      return { paused: true, frame: world.resource(Time).frame }
    },
  },
  {
    name: 'time.resume',
    description: 'Resumes a paused game.',
    params: none,
    handler: ({ app, world }) => {
      const control = world.resource(AppControlResource)
      control.paused = false
      control.pausedByError = false
      app.requestFrame() // an idle on-demand app starts again
      return { paused: false, frame: world.resource(Time).frame }
    },
  },
  {
    name: 'time.step',
    description: 'Pauses and runs exactly `frames` frames at the fixed timestep, then returns.',
    params: s('StepParams', {
      frames: t.u32({ default: 1, min: 1, max: 100000, description: 'Frames to run.' }),
    }),
    handler: async ({ app, world, options }, p) => {
      const control = world.resource(AppControlResource)
      const done = control.step(p.frames as number)
      done.catch(() => {}) // the error surfaces through pump (manual) or the await below (loop)
      if ((options.frames ?? 'manual') === 'manual') app.pump()
      await done
      return { frame: world.resource(Time).frame, elapsed: world.resource(Time).elapsed }
    },
  },
  {
    name: 'render.capture',
    description:
      'A PNG of a camera view (default: the first camera). Renders the current state without advancing time.',
    params: s('CaptureParams', {
      camera: t.entity({ description: 'Camera entity or path (default: first camera view).' }),
      width: t.u32({
        min: 0,
        max: 4096,
        description: 'Resize the headless target first (0 = keep).',
      }),
      height: t.u32({ min: 0, max: 4096 }),
      debug: t.string({
        description:
          "A debug view instead of the image: 'clusters' (lights per cluster heat map), 'cascades' (cascades tinted by index), 'lod' (meshes tinted by LOD level: green, yellow, orange, red), 'shadow-map:<light>[:<layer>]' (a light's raw shadow map), or 'culling' (freezes what the camera culls with, and keeps it frozen for later captures while the camera moves; 'none' unfreezes).",
      }),
      overlays: t.list(t.string, {
        description: `Debug overlays drawn into this capture only: ${OVERLAYS.join(', ')}, plus any a plugin registers (e.g. colliders). 'labels' writes each entity's scene path next to it; 'bounds' outlines what the renderer thinks is there.`,
      }),
      filter: t.string({
        description: 'Limit overlays to entities whose scene path starts with this, e.g. "ship/".',
      }),
      components: t.list(t.string, {
        description: 'Limit overlays to entities with all these components.',
      }),
      buffer: t.string({
        description:
          "Raw floats of a render buffer instead of the display image: 'hdr' (luminance in cd/m², before post-processing and tonemapping), 'post-hdr' (after the HDR effects, pre-exposed), 'depth', 'velocity' (screen motion in uv units, TAA and motion blur), 'ssao' (ambient occlusion), 'bloom' (the glow's first level), 'dof-half' (color and signed CoC in pixels), or another graph texture. Returned as base64 little-endian rgba32float.",
      }),
    }),
    handler: async ({ app, world, options }, p) => {
      const window = world.tryResource(Window)
      if (
        window instanceof OffscreenTarget &&
        (p.width as number) > 0 &&
        (p.height as number) > 0
      ) {
        window.resize(p.width as number, p.height as number)
      }
      const view =
        p.camera !== null && p.camera !== undefined
          ? `camera:${resolveEntity(world, p.camera)}`
          : undefined
      // A paused or loop-less app renders no frames on its own; render one without advancing time.
      const renderNow =
        (options.frames ?? 'manual') === 'manual' || world.resource(AppControlResource).paused
      if (world.resource(Views).list.length === 0) renderOnly(app) // views are rebuilt each frame
      const name = view ?? world.resource(Views).list[0]?.name
      if (!name)
        throw new ShardError(
          'protocol/no-view',
          'Nothing to capture: no camera renders to a target',
        )
      const debug = (p.debug as string) || ''
      const cameraEntity = Number(name.slice('camera:'.length))
      if (debug.startsWith('shadow-map:')) {
        await whenRenderReady(world, () => (renderNow ? renderOnly(app) : nextFrame(app)))
        const [, lightRef, layer] = debug.split(':')
        const light = resolveEntity(world, /^\d+$/.test(lightRef!) ? Number(lightRef) : lightRef)
        const map = await captureShadowMap(world, light, Number(layer ?? 0), cameraEntity)
        const image = depthImage(map)
        return {
          mimeType: 'image/png',
          width: image.width,
          height: image.height,
          data: toBase64(await encodePng(image.data, image.width, image.height)),
        }
      }
      if (debug && !CAPTURE_DEBUG_VIEWS.includes(debug)) {
        throw new ShardError('protocol/unknown-debug-view', `Unknown debug view "${debug}"`, {
          hint: "Use 'clusters', 'cascades', 'lod', 'culling', 'none', or 'shadow-map:<light>'.",
        })
      }
      if (debug) setDebugView(world, cameraEntity, debug as DebugView)
      // 'culling' stays frozen so later captures show what it culled; 'none' has nothing to undo.
      const restore = debug !== '' && debug !== 'culling' && debug !== 'none'
      const overlays = checkOverlays(p.overlays)
      const restoreOverlays =
        overlays.length > 0
          ? applyOverlays(
              world,
              overlays,
              (p.components as string[] | undefined) ?? [],
              (p.filter as string) || '',
            )
          : undefined
      try {
        await whenRenderReady(world, () => (renderNow ? renderOnly(app) : nextFrame(app)))
        if (p.buffer) {
          const shot = captureBuffer(world, name, p.buffer as string)
          if (renderNow) renderOnly(app)
          else await nextFrame(app)
          const b = await shot
          return {
            mimeType: 'application/octet-stream',
            format: 'rgba32float',
            source: b.format,
            width: b.width,
            height: b.height,
            data: toBase64(new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength)),
          }
        }
        const shot = captureView(world, name)
        if (renderNow) renderOnly(app)
        const image = await shot
        return {
          mimeType: 'image/png',
          width: image.width,
          height: image.height,
          data: toBase64(await encodePng(image.data, image.width, image.height)),
        }
      } finally {
        if (restore) setDebugView(world, cameraEntity, 'none')
        restoreOverlays?.()
      }
    },
  },
  {
    name: 'render.pick',
    description:
      "What's under a pixel of a camera view (x, y from the top left, in the capture's pixels): the entity, its scene path, and the world position, normal, and distance of the surface. Meshes and world sprites are pickable. null when nothing is there.",
    params: s('PickParams', {
      camera: t.entity({ description: 'Camera entity or path (default: the first camera view).' }),
      x: t.f32({ required: true }),
      y: t.f32({ required: true }),
    }),
    handler: async ({ app, world, options }, p) => {
      const manual =
        (options.frames ?? 'manual') === 'manual' || world.resource(AppControlResource).paused
      if (world.resource(Views).list.length === 0) renderOnly(app)
      const camera =
        p.camera !== null && p.camera !== undefined ? resolveEntity(world, p.camera) : undefined
      let done = false
      const result = pick(world, camera, p.x as number, p.y as number).finally(() => {
        done = true
      })
      // The pick resolves after a frame renders it (a second one if its pipelines were compiling).
      for (let i = 0; i < 30 && !done; i++) {
        if (manual) renderOnly(app)
        else await nextFrame(app)
        await world.tryResource(Gpu)?.pipelines.whenIdle()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const hit = await result
      return hit ? hitJson(hit) : null
    },
  },
  {
    name: 'world.raycast',
    description:
      'Casts a ray against mesh entities on the CPU (bounds, then triangles): hits nearest first, each with entity, scene path, position, normal, and distance. Needs no GPU or frame.',
    params: s('RaycastParams', {
      origin: t.vec3({ required: true }),
      direction: t.vec3({ required: true }),
      maxDistance: t.f32({ min: 0, description: 'Ignore hits past this (0: no limit).' }),
      all: t.bool({ description: 'Every entity along the ray, not just the nearest.' }),
    }),
    handler: ({ world }, p) => {
      const hits = raycast(world, p.origin as number[], p.direction as number[], {
        maxDistance: (p.maxDistance as number) || undefined,
        all: p.all as boolean,
      })
      return { hits: hits.map(hitJson) }
    },
  },
  {
    name: 'debug.overlays',
    description: `Shows debug overlays in every frame until changed (render.capture's "overlays" draws them into one capture instead). Pass the full set to show: ${OVERLAYS.join(', ')}, plus plugin overlays (colliders with physics); [] turns them off. Returns what's on.`,
    params: s('OverlaysParams', {
      overlays: t.list(t.string, { description: 'Overlays to show; the rest turn off.' }),
      filter: t.string({ description: 'Only entities whose scene path starts with this.' }),
      components: t.list(t.string, { description: 'Only entities with all these components.' }),
    }),
    handler: ({ world }, p) => {
      const names = checkOverlays(p.overlays)
      applyOverlays(
        world,
        names,
        (p.components as string[] | undefined) ?? [],
        (p.filter as string) || '',
      )
      const o = world.resource(DebugOverlays)
      return { overlays: overlayNames().filter((k) => isOverlayOn(o, k)), filter: o.filter }
    },
  },
  {
    name: 'debug.gizmos',
    description:
      'What gizmos drew last frame, as data: line segments (from, to, color, depthTest, width) and labels (position, text). Overlays count too.',
    params: s('GizmosParams', {
      limit: t.u32({ default: 200, max: 100000, description: 'Most line segments to list.' }),
    }),
    handler: ({ world }, p) => toJson(world.resource(Gizmos).describe(p.limit as number)),
  },
  {
    name: 'render.describe',
    description:
      'Render graph order, views, pipelines compiling, per-view stats, recent GPU errors.',
    params: none,
    handler: ({ world }) => toJson(describeRender(world)),
  },
  {
    name: 'input.inject',
    description:
      'Queues input for the next frame: a key, a mouse button, or an action ("<map>.<action>").',
    params: s('InjectParams', {
      key: t.string({ description: 'KeyboardEvent.code, e.g. "KeyW".' }),
      mouse: t.enum(['', 'left', 'middle', 'right']),
      action: t.string({
        description: 'Action as "<map>.<action>", e.g. "star-explorer/Controls.thrust".',
      }),
      pressed: t.bool({ default: true }),
      value: t.f32({ description: 'Analog value for actions (default 1 when pressed).' }),
    }),
    handler: ({ world }, p) => {
      if (p.action)
        injectInput(world, {
          action: p.action as string,
          pressed: p.pressed as boolean,
          value: (p.value as number) || undefined,
        })
      else if (p.key) injectInput(world, { key: p.key as string, pressed: p.pressed as boolean })
      else if (p.mouse)
        injectInput(world, { mouse: p.mouse as 'left', pressed: p.pressed as boolean })
      else
        throw new ShardError('protocol/invalid-params', 'Give one of key, mouse, or action', {
          path: '',
        })
      return { queued: true }
    },
  },
  {
    name: 'input.simulate',
    description:
      'Plays pointer gestures a step per frame, in CSS pixels, so controls and drags run headless (0060): [{ drag: { from: [x, y], to: [x, y], button, pointer, modifiers, frames, cancel } }, { pinch: { center, from, to, twist, pan, frames } }, { wheel: { at, dy, dx, modifiers } }, { tap: [x, y] }, { wait: frames }]. Needs gesturesPlugin. Returns how many frames they take.',
    params: s('SimulateParams', {
      gestures: t.json({ required: true, description: 'The gestures, played one after another.' }),
    }),
    handler: ({ world }, p) => {
      if (!Array.isArray(p.gestures))
        throw new ShardError('protocol/invalid-params', 'gestures must be a list', {
          path: '/gestures',
        })
      return { frames: simulateGestures(world, p.gestures as SimulatedGesture[]) }
    },
  },
  {
    name: 'input.record',
    description: 'Starts recording input, or stops and returns the recording.',
    params: s('RecordParams', { action: t.enum(['start', 'stop']) }),
    handler: ({ world }, p) =>
      p.action === 'stop'
        ? { recording: stopRecording(world) }
        : (startRecording(world), { recording: true }),
  },
  {
    name: 'input.replay',
    description: 'Replays a recording from the next frame, ignoring live input until it ends.',
    params: s('ReplayParams', { recording: t.string({ required: true }) }),
    handler: ({ world }, p) => {
      startReplay(world, p.recording as string)
      return { replaying: true }
    },
  },
  {
    name: 'scene.validate',
    description: 'Every error in a scene (by file path or inline JSON), each with a JSON pointer.',
    params: s('SceneValidateParams', { file: t.string(), json: t.json() }),
    handler: async (ctx, p) => {
      const json = p.file ? await readJson(ctx, p.file as string) : p.json
      const errors = validateScene(ctx.world, json)
      return { valid: errors.length === 0, errors: errors.map((e) => e.toJSON()) }
    },
  },
  {
    name: 'scene.load',
    description:
      'Loads a scene (replacing a loaded scene with the same id). Returns entity paths and ids.',
    params: s('SceneLoadParams', {
      file: t.string(),
      json: t.json(),
      id: t.string({ description: 'Defaults to the file path.' }),
      wait: t.bool({
        default: true,
        description: 'Wait until every referenced asset has loaded or failed (default true).',
      }),
    }),
    handler: async (ctx, p) => {
      const json = p.file ? await readJson(ctx, p.file as string) : p.json
      const id = (p.id as string) || (p.file as string) || 'main'
      const loaded = ctx.world.initResource(SceneIndex).has(id)
        ? reloadScene(ctx.world, id, json)
        : loadScene(ctx.world, json, { id })
      if (p.wait !== false) await whenSceneReady(ctx.world, id)
      const failed = assetServer(ctx.world)
        .list({ state: 'failed' })
        .map((e) => ({ path: e.path, error: e.error?.message }))
      return {
        id,
        entities: Object.fromEntries(loaded.entities),
        ...(failed.length > 0 ? { failedAssets: failed } : {}),
      }
    },
  },
  {
    name: 'scene.save',
    description:
      'Serializes a loaded scene; unchanged fields keep their authored form. Optionally writes the file.',
    params: s('SceneSaveParams', { id: t.string({ required: true }), write: t.bool() }),
    handler: async (ctx, p) => {
      const file = saveScene(ctx.world, p.id as string)
      if (p.write) {
        if (!ctx.options.platform?.fs.writable)
          throw new ShardError('protocol/no-files', "This host can't write files")
        await ctx.options.platform.fs.writeText(p.id as string, stringifyScene(file))
      }
      return file
    },
  },
  {
    name: 'prefab.spawn',
    description:
      'Spawns a prefab instance (loading the prefab first). Returns the root entity and its generated entities by path relative to the root.',
    params: s('PrefabSpawnParams', {
      prefab: t.string({
        required: true,
        description: 'Prefab path or guid, e.g. "prefabs/ship.prefab.json".',
      }),
      transform: t.json({
        description: 'Root Transform fields, e.g. { "translation": [0, 5, 0] }.',
      }),
      overrides: t.json({
        description:
          'Changes to generated entities: { "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } } }.',
      }),
      parent: t.entity({ description: 'Optional parent entity or path.' }),
    }),
    handler: async ({ world }, p) => {
      await loadPrefab(world, p.prefab as string)
      const transform = p.transform as Record<string, number[]> | null
      const root = spawnPrefab(world, p.prefab as string, {
        ...(transform ? { transform } : {}),
        ...(p.overrides ? { overrides: p.overrides as Overrides } : {}),
        ...(p.parent !== null && p.parent !== undefined
          ? { parent: resolveEntity(world, p.parent) }
          : {}),
      })
      return { root, paths: Object.fromEntries(instanceEntities(world, root)) }
    },
  },
  {
    name: 'prefab.overrides',
    description:
      "An instance's current differences from its prefab (or model), as the overrides a scene save would write.",
    params: s('PrefabOverridesParams', { entity: entityRef() }),
    handler: ({ world }, p) => {
      const entity = resolveEntity(world, p.entity)
      const overrides = currentOverrides(world, entity)
      if (!overrides) {
        throw new ShardError(
          'prefab/not-an-instance',
          `Entity ${JSON.stringify(p.entity)} isn't a spawned instance`,
          {
            hint: 'Pass the entity with scene/PrefabInstance or scene/SceneInstance, e.g. "player-ship".',
          },
        )
      }
      return { entity, overrides }
    },
  },
  {
    name: 'prefab.apply',
    description:
      "Apply to prefab: writes an instance's overrides into its prefab file and clears them. Every instance of the prefab picks up the change.",
    params: s('PrefabApplyParams', { entity: entityRef() }),
    handler: async ({ world, options }, p) =>
      applyToPrefab(
        world,
        resolveEntity(world, p.entity),
        options.platform?.fs.writable ? options.platform.fs : undefined,
      ),
  },
  {
    name: 'asset.list',
    description:
      'Assets in the catalog: path, type, and state (unloaded, loading, loaded, failed). Filter by type, path prefix, or state.',
    params: s('AssetListParams', {
      type: t.string({ description: 'e.g. "Mesh", "Material", "Texture".' }),
      prefix: t.string({ description: 'Path prefix, e.g. "assets/ships/".' }),
      state: t.string({ description: 'unloaded, loading, loaded, or failed.' }),
      limit: t.u32({ default: 200 }),
    }),
    handler: ({ world }, p) => {
      const all = assetServer(world).list({
        type: (p.type as string) || undefined,
        prefix: (p.prefix as string) || undefined,
        state: (p.state as never) || undefined,
      })
      return {
        total: all.length,
        assets: all.slice(0, p.limit as number).map((e) => ({
          path: e.path,
          type: e.type,
          state: e.state,
          ...(e.error ? { error: e.error.message } : {}),
        })),
      }
    },
  },
  {
    name: 'asset.get',
    description:
      'Everything about one asset: guid, type, state, importer and settings, dependencies and dependents, sub-assets, facts (counts, bounds), warnings, and the last error. Data assets include their value, and variants their $extends chain and which file set each field.',
    params: s('AssetGetParams', {
      asset: t.string({ required: true, description: 'Asset path or guid.' }),
    }),
    handler: async ({ world }, p) => {
      const assets = assetServer(world)
      const info = toJson(assets.info(p.asset as string)) as Record<string, unknown>
      // Data assets show their merged value (see info.extends and info.setBy for variants).
      if (info.source && assets.importerOf(info.source as string)?.schema && info.artifact)
        info.value = (await assets.artifact(p.asset as string)).json
      return info
    },
  },
  {
    name: 'asset.import',
    description:
      'Re-imports one source (optionally with new import settings, merged into its .meta), or scans every asset root when "asset" is omitted.',
    params: s('AssetImportParams', {
      asset: t.string({ description: 'Source path or sub-asset path. Omit to scan everything.' }),
      settings: t.json({ description: 'Import settings to change, e.g. { "scale": 0.01 }.' }),
      force: t.bool({ description: 'Re-import even if nothing changed.' }),
    }),
    handler: async ({ world }, p) => {
      const assets = assetServer(world)
      if (!p.asset) return toJson(await assets.scan({ force: p.force === true }))
      const settings = p.settings as Record<string, never> | null
      return toJson(await assets.reimport(p.asset as string, settings ? { settings } : {}))
    },
  },
  {
    name: 'asset.move',
    description:
      'Moves an asset source and its .meta, then rewrites references to it in scenes and data assets. Returns the files it rewrote.',
    params: s('AssetMoveParams', {
      from: t.string({ required: true }),
      to: t.string({ required: true }),
    }),
    handler: ({ world }, p) => assetServer(world).move(p.from as string, p.to as string),
  },
  {
    name: 'asset.preview',
    description:
      'A PNG of an asset: a texture (top mip), a material on a sphere, a mesh or scene framed from its bounds, or a noise graph in grayscale (options: domain plane|sphere, seed, size, node to see an intermediate node). Renders in a private world; the game is untouched.',
    params: s('AssetPreviewParams', {
      asset: t.string({ required: true, description: 'Asset path or guid.' }),
      width: t.u32({ default: 256, min: 16, max: 2048 }),
      height: t.u32({ default: 256, min: 16, max: 2048 }),
      options: t.json({
        description:
          'Type-specific options. NoiseGraph: { domain: "plane" | "sphere", seed, size, node }.',
      }),
    }),
    handler: async ({ world }, p) => {
      const image = await previewAsset(
        world,
        p.asset as string,
        p.width as number,
        p.height as number,
        (p.options as Record<string, unknown> | null | undefined) ?? undefined,
      )
      const png = await encodePng(image.data, image.width, image.height)
      return { width: image.width, height: image.height, data: toBase64(png) }
    },
  },
  {
    name: 'text.measure',
    description:
      'Lays out a string without rendering it: width, height, and line breaks, in the units of size (world units for Text, pixels for ScreenText). Use it to size a label before placing it.',
    params: s('TextMeasureParams', {
      font: t.string({ required: true, description: 'Font asset path or guid.' }),
      value: t.string({ required: true }),
      size: t.f32({ default: 1, min: 0 }),
      maxWidth: t.f32({ min: 0, description: 'Wrap width (0: none).' }),
      lineHeight: t.f32({ default: 1.2 }),
      align: t.enum(['left', 'center', 'right']),
    }),
    handler: async ({ world }, p) => {
      const server = assetServer(world)
      const ref = server.resolve(p.font as string)
      if (ref) await server.load(ref.path ?? (p.font as string))
      const font = world.resource(Fonts).get(ref as never)
      if (!font) {
        throw new ShardError('text/not-loaded', `No font "${p.font}"`, {
          hint: 'asset.list shows fonts (type Font); pass a .ttf or .otf path.',
        })
      }
      const m = measureText(font, p.value as string, {
        size: p.size as number,
        maxWidth: p.maxWidth as number,
        lineHeight: p.lineHeight as number,
        align: (['left', 'center', 'right'] as const)[p.align as number] ?? 'left',
      })
      const value = p.value as string
      return {
        width: m.width,
        height: m.height,
        lines: m.lines.map((l) => ({ text: value.slice(l.start, l.end), width: l.width })),
      }
    },
  },
  {
    name: 'perf.describe',
    description:
      'Profiler aggregates (0074) over the last 120 runs of each span (last, avg, p95, max ms): the frame, each schedule and its command application, systems and other main-thread spans, GPU passes and the GPU frame ("unavailable" without timestamp queries), worker jobs, async spans; memory (GPU ledger by category, JS heap, ECS tables); and the clock (resolution, isolated, timings under four steps are "coarse").',
    params: s('PerfDescribeParams', {
      spans: t.list(t.string, {
        description:
          'Only spans these keys cover: a key covers a span it equals or prefixes up to a "/" ("render" covers "render/opaque").',
      }),
      top: t.u32({ default: 30, min: 1, max: 1000, description: 'Most spans listed per track.' }),
    }),
    handler: ({ world }, p) => {
      const spans = p.spans as string[] | undefined
      return toJson(
        describePerf(world, {
          spans: spans && spans.length > 0 ? spans : undefined,
          top: p.top as number,
        }),
      )
    },
  },
  {
    name: 'perf.capture',
    description:
      'Captures a span timeline (0074) over the next `frames` frames, or with `until.frameMs` a flight recorder that keeps `before` frames and stops `after` frames past the first frame over it. Returns a summary: frame CPU/GPU/interval p50/p95/max, the top spans, and the 5 worst frames, each with the spans most above their median ("over"): the lead for a hitch. The Chrome trace (Perfetto, chrome://tracing) goes to .shard/captures/ (tracePath) where the host can write, else inline (trace).',
    params: s('PerfCaptureParams', {
      frames: t.u32({ min: 0, max: 100000, description: 'Frames to capture (default 300).' }),
      until: t.struct({
        frameMs: t.f32({
          min: 0,
          description: 'Flight recorder: stop after the first frame whose CPU time is over this.',
        }),
      }),
      before: t.u32({
        default: 120,
        max: 100000,
        description: 'Flight recorder: frames kept before.',
      }),
      after: t.u32({ default: 30, max: 100000, description: 'Flight recorder: frames after.' }),
      timeout: t.f32({
        default: 60,
        min: 0,
        description: 'Flight recorder: seconds to wait for a slow frame.',
      }),
      sample: t.bool({
        description:
          "Also sample JavaScript (V8's profiler in Node, JS Self-Profiling in browsers): the hottest functions join the summary.",
      }),
      devtools: t.bool({
        description: "Also show spans in Chrome's Performance panel (performance.measure).",
      }),
      write: t.bool({ default: true, description: 'Write the trace file when the host can.' }),
    }),
    handler: async ({ app, world, options }, p) => {
      const frameMs = (p.until as { frameMs: number } | undefined)?.frameMs ?? 0
      const manual = (options.frames ?? 'manual') === 'manual'
      const gpu = world.tryResource(Gpu) !== undefined
      return toJson(
        await capturePerf(world, {
          frames: (p.frames as number) || 300,
          until: frameMs > 0 ? { frameMs } : undefined,
          before: p.before as number,
          after: p.after as number,
          timeout: p.timeout as number,
          sample: p.sample as boolean,
          devtools: p.devtools as boolean,
          write: p.write as boolean,
          // Headless: run the frames here, letting GPU readbacks land between them.
          step: manual
            ? async () => {
                app.update(1 / app.fixedHz)
                if (gpu) await new Promise((resolve) => setTimeout(resolve, 0))
              }
            : undefined,
        }),
      )
    },
  },
  {
    name: 'perf.reset',
    description: "Clears the profiler's aggregates: perf.describe starts over.",
    params: none,
    handler: ({ world }) => {
      world.resource(ProfilerResource).reset()
      return null
    },
  },
  {
    name: 'log.tail',
    description: 'Recent log entries (errors from systems, the GPU, and shaders land here).',
    params: s('LogParams', {
      count: t.u32({ default: 50, min: 1 }),
      level: t.enum(['debug', 'info', 'warn', 'error']),
    }),
    handler: ({ world }, p) =>
      world.resource(LogResource).tail(p.count as number, p.level as 'debug'),
  },
  {
    name: 'errors.recent',
    description: 'Recent errors with code, path, and hint.',
    params: s('ErrorsParams', { count: t.u32({ default: 20, min: 1 }) }),
    handler: ({ world }, p) => world.resource(LogResource).errors(p.count as number),
  },
]

export type Topic = 'log' | 'error' | 'frame' | 'project'

export interface ProtocolServer {
  readonly methods: readonly MethodDef[]
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined>
  /** Receives notifications for subscribed topics. Returns an unsubscribe function. */
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void
  /** Sends a notification on `topic` to subscribers (hosts use it for e.g. project reloads). */
  publish(topic: Topic, params: unknown): void
  close(): void
}

/** Serves the protocol for one app. Transports feed requests into `handle`. */
export function createProtocolServer(
  app: App,
  options: ProtocolServerOptions = {},
): ProtocolServer {
  const ctx: HandlerContext = { app, world: app.world, options }
  const byName = new Map([...METHODS, ...(options.methods ?? [])].map((m) => [m.name, m]))
  const listeners = new Set<(n: JsonRpcNotification) => void>()
  const topics = new Set<Topic>()
  const notify = (method: string, params: unknown) => {
    for (const l of listeners) l({ jsonrpc: '2.0', method, params })
  }
  const offLog = app.world.resource(LogResource).subscribe((entry: LogEntry) => {
    if (topics.has('log')) notify('log', entry)
    if (topics.has('error') && entry.level === 'error') notify('error', entry)
  })
  const offFrame = app.onFrame((frame) => {
    if (topics.has('frame')) notify('frame', { frame })
  })

  const subscribe: MethodDef = {
    name: 'subscribe',
    description: 'Subscribes to notifications: "log", "error", "frame", "project" (reloads).',
    params: s('SubscribeParams', {
      topics: t.list(t.enum(['log', 'error', 'frame', 'project'])),
      unsubscribe: t.bool(),
    }),
    handler: (_, p) => {
      for (const topic of p.topics as Topic[]) {
        if (p.unsubscribe) topics.delete(topic)
        else topics.add(topic)
      }
      return { topics: [...topics] }
    },
  }
  byName.set(subscribe.name, subscribe)
  // Methods plugins contributed (physics, audio, ...). Looked up per request: plugins can add
  // them after the server starts, and a project reload replaces the project's own.
  const allow = options.allow ? new Set(options.allow) : undefined
  const lookup = (name: string): MethodDef | undefined =>
    allow && !allow.has(name)
      ? undefined
      : (byName.get(name) ?? app.methods.find((m) => m.name === name))
  const allowed = (m: MethodDef) => !allow || allow.has(m.name)

  const server: ProtocolServer = {
    get methods() {
      return [...byName.values(), ...app.methods.filter((m) => !byName.has(m.name))].filter(allowed)
    },
    async handle(request) {
      const id = request.id ?? null
      const isNotification = request.id === undefined
      const reply = (body: Omit<JsonRpcResponse, 'jsonrpc' | 'id'>): JsonRpcResponse | undefined =>
        isNotification ? undefined : { jsonrpc: '2.0', id, ...body }
      if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        return reply({ error: { code: ERROR.invalid, message: 'Invalid JSON-RPC request' } })
      }
      if (allow && !allow.has(request.method)) {
        const err = new ShardError(
          'protocol/method-not-allowed',
          `"${request.method}" isn't allowed on this server`,
          { hint: `This host allows: ${[...allow].join(', ')}.` },
        )
        return reply({ error: { code: ERROR.shard, message: err.message, data: err.toJSON() } })
      }
      const method = lookup(request.method)
      if (!method) {
        return reply({
          error: {
            code: ERROR.notFound,
            message: `Unknown method "${request.method}"`,
            data: { methods: server.methods.map((m) => m.name) },
          },
        })
      }
      const raw = request.params ?? {}
      const problems = method.params.validate(raw)
      if (problems.length > 0) {
        const err = new ShardError(
          'protocol/invalid-params',
          `${problems.length} invalid parameter(s): ${problems[0]!.message}`,
          {
            path: problems[0]!.path,
            hint: problems[0]!.hint,
            details: problems,
          },
        )
        return reply({ error: { code: ERROR.params, message: err.message, data: err.toJSON() } })
      }
      try {
        // Entity params accept scene paths; resolve them like scene files do.
        const params = method.params.deserialize(raw, worldSchemaContext(app.world)) as Record<
          string,
          unknown
        >
        const result = await method.handler(ctx, params)
        return reply({ result: result ?? null })
      } catch (err) {
        const shard =
          err instanceof ShardError
            ? err
            : new ShardError('protocol/internal', err instanceof Error ? err.message : String(err))
        return reply({ error: { code: ERROR.shard, message: shard.message, data: shard.toJSON() } })
      }
    },
    onNotification(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(topic, params) {
      if (topics.has(topic)) notify(topic, params)
    },
    close() {
      offLog()
      offFrame()
      listeners.clear()
    },
  }
  return server
}
