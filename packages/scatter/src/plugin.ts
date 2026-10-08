import { AssetServerResource, assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  ChildOf,
  defineSystem,
  onRemove,
  PostUpdate,
  type World,
} from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import type { Workers } from '@aethervtt/shard-platform'
import {
  computeVisibility,
  Mesh3d,
  Meshes,
  registerShaders,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { Planet, Terrain, updatePlanets } from '@aethervtt/shard-terrain'
import { GlobalTransform, TransformSystems } from '@aethervtt/shard-transform'
import * as componentsModule from './components'
import {
  addRemoved,
  Prop,
  propIdentity,
  Removed,
  removedKey,
  ScatterBudget,
  ScatterSurface,
} from './components'
import * as foliageModule from './foliage'
import { applyWind, clearFoliage, updateFoliage, Wind } from './foliage'
import * as materialModule from './material'
import { SCATTER_SHADERS } from './material'
import { MeshSurface } from './mesh-surface'
import { scatterMethods } from './methods'
import * as overlaysModule from './overlays'
import { PlanetSurface } from './planet'
import * as previewModule from './preview'
import {
  clearChunks,
  planetScatters,
  planetSources,
  refreshSurface,
  resolveAsset,
  Scatter,
  type ScatterState,
  SurfaceScatter,
  updateProps,
} from './runtime'
import * as setModule from './set'
import { ScatterSet } from './set'
import { cameraQuery } from './viewers'

export interface ScatterPluginOptions {
  /** Where placement samples the ground (default: inline on the main thread). */
  workers?: Workers
}

const watching = new WeakSet<World>()

/** Re-resolve sets whenever an asset loads or changes (a set, a mask graph, an item mesh). */
function watchAssets(world: World): void {
  if (watching.has(world) || !world.tryResource(AssetServerResource)) return
  watching.add(world)
  assetServer(world).onEvent((event) => {
    if (event.kind === 'loaded' || event.kind === 'modified' || event.kind === 'failed')
      world.resource(Scatter).dirty = true
  })
}

/**
 * Props on every surface (spec 0045): planets with `Planet.scatter` or biome sets. Resolves each
 * surface's sets and item meshes, then places, spawns and despawns prop chunks around cameras and
 * anchors. Runs with or without a GPU (headless tests place the same props).
 */
export const updateScatter = defineSystem({
  name: 'scatter/props',
  description:
    'Places scatter props (rocks, trees, …) in chunks around cameras and TerrainAnchors, spawning them nearest first within ScatterBudget and despawning those out of range.',
  setup: (world) => ({
    cameras: cameraQuery(world),
    meshes: world.query({ with: [ScatterSurface, Mesh3d, GlobalTransform] }),
  }),
  run: (s, world) => {
    const state = world.resource(Scatter)
    watchAssets(world)
    state.frame++
    const frame = state.frame
    const budget = world.resource(ScatterBudget)
    const dirty = state.dirty
    state.dirty = false
    recordRemovals(world)
    const terrain = world.tryResource(Terrain)
    if (terrain) {
      for (const rt of terrain.planets.values()) {
        if (!world.isAlive(rt.entity) || !rt.ready) continue
        let ss = state.surfaces.get(rt.entity)
        if (!ss) {
          if (!planetScatters(world, rt)) continue
          ss = new SurfaceScatter(new PlanetSurface(rt, s.cameras))
          state.surfaces.set(rt.entity, ss)
        }
        const start = performance.now()
        const content = `${rt.version}:${rt.biomeVersion}`
        if (dirty || ss.content !== content || !ss.ready) {
          ss.content = content
          const { sources, waiting } = planetSources(world, rt)
          if (waiting) {
            ss.waiting = waiting
            continue
          }
          if (!refreshSurface(world, ss, sources, rt.settings!.seed, content)) continue
        }
        updateProps(world, ss, frame, budget, state.workers)
        updateFoliage(world, ss, frame, state.workers)
        ss.ms = performance.now() - start
      }
    }
    for (const table of s.meshes.tables) {
      const sets = world.initResource(ScatterSet.store)
      const meshes = world.initResource(Meshes)
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]!
        let ss = state.surfaces.get(entity)
        if (!ss) {
          ss = new SurfaceScatter(new MeshSurface(world, entity, s.cameras))
          state.surfaces.set(entity, ss)
        }
        const start = performance.now()
        const surface = ss.surface as MeshSurface
        const value = world.get(entity, ScatterSurface)
        const meshRef = world.get(entity, Mesh3d).mesh
        const mesh = resolveAsset(world, meshRef, (g) => meshes.get({ guid: g } as never) as Mesh)
        if (!mesh || mesh.gpu) {
          ss.waiting = `mesh ${meshRef?.path ?? meshRef?.guid ?? '(none)'}`
          continue
        }
        const set = resolveAsset(world, value.set, (g) => sets.get({ guid: g }))
        if (!set) {
          ss.waiting = `scatter set ${value.set?.path ?? value.set?.guid ?? '(none)'}`
          continue
        }
        const changed = surface.setMesh(
          mesh,
          uniformScale(world.get(entity, GlobalTransform).matrix),
        )
        const content = `${mesh.version}:${surface.scale}`
        if (dirty || changed || ss.content !== content || !ss.ready) {
          ss.content = content
          const sources = [{ path: value.set?.path ?? value.set?.guid ?? '', set, biome: -1 }]
          if (!refreshSurface(world, ss, sources, value.seed, content)) continue
        }
        updateProps(world, ss, frame, budget, state.workers)
        updateFoliage(world, ss, frame, state.workers)
        ss.ms = performance.now() - start
      }
    }
    applyWind(world, windMaterials(state))
  },
})

const used = new Set<AssetRef<'Material'> | null>()

/** Every Vegetation material scatter draws: the defaults and the rules' own. */
function windMaterials(state: ScatterState): Set<AssetRef<'Material'> | null> {
  used.clear()
  for (const ref of state.materials.values()) used.add(ref)
  for (const ss of state.surfaces.values())
    for (const items of ss.variants)
      for (const vs of items) for (const v of vs) used.add(v.material)
  return used
}

/** The average length of an affine's basis columns: its scale, if uniform. */
function uniformScale(m: ArrayLike<number>): number {
  const sx = Math.sqrt(m[0]! * m[0]! + m[4]! * m[4]! + m[8]! * m[8]!)
  const sy = Math.sqrt(m[1]! * m[1]! + m[5]! * m[5]! + m[9]! * m[9]!)
  const sz = Math.sqrt(m[2]! * m[2]! + m[6]! * m[6]! + m[10]! * m[10]!)
  return (sx + sy + sz) / 3 || 1
}

/**
 * Props despawned since last frame by something other than scatter: recorded in `Removed` if
 * their chunk is still spawned (a whole chunk or surface going away isn't a removal).
 */
function recordRemovals(world: World): void {
  const state = world.resource(Scatter)
  if (state.pendingRemovals.length === 0) return
  const removed = world.initResource(Removed)
  for (const p of state.pendingRemovals) {
    if (!world.isAlive(p.root)) continue
    addRemoved(removed, removedKey(p.rule, p.chunk, p.index))
  }
  state.pendingRemovals.length = 0
}

/** Scatter for an app: props on planets (with the terrain plugin) and mesh surfaces. */
export function scatterPlugin(options: ScatterPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'scatter',
    // Registers the scatter and foliage-chunks overlays.
    provides: [
      componentsModule,
      foliageModule,
      materialModule,
      overlaysModule,
      previewModule,
      setModule,
      Scatter,
    ],
    dependencies: ['core/transform'],
    build(app) {
      const world = app.world
      const state = world.initResource(Scatter)
      state.workers = options.workers
      world.initResource(ScatterBudget)
      world.initResource(Removed)
      world.initResource(Wind)
      world.observe(onRemove(Prop), ({ entity, world }) => {
        const st = world.resource(Scatter)
        if (st.despawning) return
        const id = propIdentity(world, entity)
        const root = world.tryGet(entity, ChildOf)?.parent
        if (!id || root === undefined || root === null) return
        st.pendingRemovals.push({ ...id, root })
      })
      world.observe(onRemove(ScatterSurface), ({ entity, world }) => {
        const st = world.resource(Scatter)
        const ss = st.surfaces.get(entity)
        if (!ss) return
        clearChunks(world, ss)
        clearFoliage(world, ss)
        st.surfaces.delete(entity)
      })
      world.observe(onRemove(Planet), ({ entity, world }) => {
        const st = world.resource(Scatter)
        const ss = st.surfaces.get(entity)
        if (!ss) return
        clearChunks(world, ss)
        clearFoliage(world, ss)
        st.surfaces.delete(entity)
      })
      app.addSystems(
        PostUpdate,
        updateScatter.after(updatePlanets).after(TransformSystems).before(computeVisibility),
      )
      app.addMethod(...scatterMethods)
    },
    ready(app) {
      const shaders = app.world.tryResource(Shaders)
      if (shaders) registerShaders(shaders, SCATTER_SHADERS)
    },
  })
}
