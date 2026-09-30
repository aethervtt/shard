import { type ComponentDef, defineResource, type World } from '@aethervtt/shard-core'

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
