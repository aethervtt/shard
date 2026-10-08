import { AssetServerResource, assetServer } from '@aethervtt/shard-assets'
import { defineSystem, onRemove, PostUpdate, type World } from '@aethervtt/shard-core'
import type { Workers } from '@aethervtt/shard-platform'
import { computeVisibility } from '@aethervtt/shard-render'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import * as biomesModule from './biomes'
import { anchorQueries, clearColliders, gatherAnchors, updateColliders } from './colliders'
import * as componentsModule from './components'
import { Planet, TerrainBudget } from './components'
import * as heightsModule from './heights'
import { TerrainWorld } from './heights'
import * as materialModule from './material'
import { terrainMethods } from './methods'
import { clearPlanetNav, updatePlanetNav } from './nav'
import * as overlaysModule from './overlays'
import { PlanetRuntime } from './planet'
import { cleanupRender, registerNode, selectChunks } from './render'
// Registers the terrain-lod, terrain-biomes, and terrain-colliders overlays.

export interface TerrainPluginOptions {
  /** Where collider chunks sample (default: inline on the main thread). */
  workers?: Workers
}

const watching = new WeakSet<World>()

/** Re-resolve planet assets whenever a graph, biome, or texture array loads or changes. */
function watchAssets(world: World): void {
  if (watching.has(world) || !world.tryResource(AssetServerResource)) return
  watching.add(world)
  assetServer(world).onEvent((event) => {
    if (event.kind === 'loaded' || event.kind === 'modified' || event.kind === 'failed')
      world.resource(TerrainWorld).dirty = true
  })
}

/**
 * Keeps a runtime per Planet (spec 0043): resolves its graphs and biomes, measures per-depth
 * errors, tracks its frame against the floating origin, gathers anchors, and builds the collider
 * chunks around them. Runs with or without a GPU; the render side adds chunk selection on top.
 */
export const updatePlanets = defineSystem({
  name: 'terrain/planets',
  description:
    'Resolves each Planet’s graphs and biomes, measures its LOD errors, and keeps collider chunks (fixed trimesh bodies) around characters, dynamic bodies, and TerrainAnchors.',
  setup: (world) => ({
    planets: world.query({ with: [Planet] }),
    anchors: anchorQueries(world),
  }),
  run: (s, world) => {
    const state = world.resource(TerrainWorld)
    watchAssets(world)
    state.frame++
    const frame = state.frame
    for (const table of s.planets.tables) {
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]!
        if (!state.planets.has(entity)) state.planets.set(entity, new PlanetRuntime(entity))
      }
    }
    const budget = world.resource(TerrainBudget)
    const dirty = state.dirty
    state.dirty = false
    for (const rt of state.planets.values()) {
      if (!world.isAlive(rt.entity)) continue
      rt.refresh(world, dirty)
      rt.frame.update(world, rt.entity)
      if (!rt.ready) continue
      gatherAnchors(world, rt, s.anchors)
      updateColliders(world, rt, state.workers, frame, budget.colliderCache)
      updatePlanetNav(world, rt, s.anchors.agents)
    }
  },
})

/** Everything the terrain needs without a GPU: runtimes, colliders, heights. */
export function terrainPlugin(options: TerrainPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'terrain',
    provides: [biomesModule, componentsModule, heightsModule, materialModule, overlaysModule],
    dependencies: ['core/transform'],
    build(app) {
      const world = app.world
      const state = world.initResource(TerrainWorld)
      state.workers = options.workers
      world.initResource(TerrainBudget)
      world.observe(onRemove(Planet), ({ entity, world }) => {
        const rt = world.resource(TerrainWorld).planets.get(entity)
        if (!rt) return
        clearColliders(world, rt)
        clearPlanetNav(world, rt)
        cleanupRender(world, rt)
        for (const cleanup of terrainCleanups) cleanup(world, rt)
        world.resource(TerrainWorld).planets.delete(entity)
      })
      app.addSystems(PostUpdate, updatePlanets.after(TransformSystems))
      app.addMethod(...terrainMethods)
      app.addSystems(PostUpdate, selectChunks.after(updatePlanets).before(computeVisibility))
      for (const extend of terrainExtensions) extend(app)
    },
    async ready(app) {
      registerNode(app)
      for (const hook of terrainReadyHooks) await hook(app)
    },
  })
}

/** Other packages hook into the plugin here (render, overlays, and nav are built in). */
export const terrainExtensions: ((app: Parameters<Plugin['build']>[0]) => void)[] = []
export const terrainReadyHooks: ((app: Parameters<Plugin['build']>[0]) => Promise<void> | void)[] =
  []
export const terrainCleanups: ((world: World, rt: PlanetRuntime) => void)[] = []
