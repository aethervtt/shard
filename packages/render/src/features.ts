import { type ComponentDef, defineResource, type Query, type World } from '@aethervtt/shard-core'
import { LogResource } from '@aethervtt/shard-runtime'
import { clearHealthIssue, raiseHealthIssue } from './health'

const missingPlugins = new WeakMap<World, Set<string>>()

/**
 * Logs `render/feature-missing` once per world and plugin: `what` asked for a feature whose
 * `plugin` (one forwardPlugin includes) isn't installed, and `outcome` is what happens instead.
 */
export function warnFeatureMissing(
  world: World,
  what: string,
  plugin: string,
  outcome: string,
): void {
  let seen = missingPlugins.get(world)
  if (!seen) {
    seen = new Set()
    missingPlugins.set(world, seen)
  }
  if (seen.has(plugin)) return
  seen.add(plugin)
  world
    .tryResource(LogResource)
    ?.log('warn', `${what}, but ${plugin} isn't installed; ${outcome}`, {
      code: 'render/feature-missing',
      hint: `Add ${plugin} from '@aethervtt/shard-render' (forwardPlugin includes it).`,
    })
}

// Render features and what they do on each tier (0064). Every graph node belongs to one feature,
// which says how it runs on the baseline tier (no storage buffers in vertex or fragment shaders,
// no compute) or that it doesn't. A registry test builds every render plugin and checks it.

/** How a feature runs on the baseline tier: a short account of its strategy there. */
export interface BaselineStrategy {
  strategy: string
}

export interface RenderFeature {
  /** `package/feature`, e.g. `render/bloom`. */
  readonly name: string
  readonly description: string
  /** The graph nodes it adds. */
  readonly nodes: readonly string[]
  /** What it does on the baseline tier, or `'unsupported'`. */
  readonly baseline: BaselineStrategy | 'unsupported'
  /** Components that mean a scene uses it (for `render/feature-unsupported` on baseline). */
  readonly components?: readonly ComponentDef[]
}

export const RenderFeatures = defineResource<Map<string, RenderFeature>>('render/Features', {
  description: 'Render features installed, the graph nodes each adds, and its baseline strategy.',
  init: () => new Map(),
})

/** Registers features a plugin installs. Plugins call it where they add their graph nodes. */
export function addRenderFeatures(world: World, ...features: RenderFeature[]): void {
  const registry = world.initResource(RenderFeatures)
  for (const feature of features) registry.set(feature.name, feature)
}

/** The feature a graph node belongs to, if one registered it. */
export function featureOfNode(world: World, node: string): RenderFeature | undefined {
  for (const feature of world.tryResource(RenderFeatures)?.values() ?? []) {
    if (feature.nodes.includes(node)) return feature
  }
  return undefined
}

/** `render.describe → features`: each installed feature, its nodes, and its baseline strategy. */
export function describeFeatures(world: World) {
  return [...(world.tryResource(RenderFeatures)?.values() ?? [])].map((f) => ({
    name: f.name,
    nodes: [...f.nodes],
    baseline: f.baseline === 'unsupported' ? 'unsupported' : f.baseline.strategy,
  }))
}

const unsupported = new WeakMap<Map<string, RenderFeature>, { size: number; nodes: Set<string> }>()

/**
 * The graph nodes of features the baseline tier doesn't run (`baseline: 'unsupported'`): the
 * graph skips them on a baseline device, so they never ask for what it lacks.
 */
export function unsupportedNodes(world: World): ReadonlySet<string> {
  const registry = world.initResource(RenderFeatures)
  let cached = unsupported.get(registry)
  // Features are only ever added: the count says whether the set is current.
  if (!cached || cached.size !== registry.size) {
    const nodes = new Set<string>()
    for (const f of registry.values())
      if (f.baseline === 'unsupported') for (const n of f.nodes) nodes.add(n)
    cached = { size: registry.size, nodes }
    unsupported.set(registry, cached)
  }
  return cached.nodes
}

/**
 * Raises `render/feature-unsupported` for `feature` (a feature, or a part of one) that a scene uses
 * on the baseline tier: RenderHealth turns degraded until `clearUnsupported`.
 */
export function reportUnsupported(world: World, feature: string, message: string): void {
  raiseHealthIssue(world, {
    code: 'render/feature-unsupported',
    severity: 'degraded',
    ref: feature,
    message,
  })
}

export function clearUnsupported(world: World, feature: string): void {
  clearHealthIssue(world, 'render/feature-unsupported', feature)
}

const usage = new WeakMap<World, { queries: Map<ComponentDef, Query>; reported: Set<string> }>()

/**
 * On the baseline tier: reports each unsupported feature whose components are in the world, and
 * clears the report once they're gone. A query per component, made once; issues change only when
 * a feature's use does.
 */
export function checkUnsupportedFeatures(world: World): void {
  let state = usage.get(world)
  if (!state) {
    state = { queries: new Map(), reported: new Set() }
    usage.set(world, state)
  }
  const queries = state.queries
  for (const f of world.initResource(RenderFeatures).values()) {
    if (f.baseline !== 'unsupported' || !f.components) continue
    let used = false
    for (const c of f.components) {
      let q = queries.get(c)
      if (!q) {
        q = world.query({ with: [c] })
        queries.set(c, q)
      }
      for (const table of q.tables) if (table.count > 0) used = true
    }
    if (used === state.reported.has(f.name)) continue
    if (used) {
      state.reported.add(f.name)
      reportUnsupported(
        world,
        f.name,
        `${f.name} (${f.description}) runs on the full tier only (WebGPU with compute and storage in shaders): it draws nothing here`,
      )
    } else {
      state.reported.delete(f.name)
      clearUnsupported(world, f.name)
    }
  }
}
