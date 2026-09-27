import {
  ChildOf,
  type ComponentDef,
  type Entity,
  FixedUpdate,
  onAdd,
  onRemove,
  onSet,
  PostUpdate,
  type World,
} from '@aethervtt/shard-core'
import { Collider, PhysicsSystems } from '@aethervtt/shard-physics'
import { Mesh3d } from '@aethervtt/shard-render'
import { type App, definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { dropAgent, navAgents } from './agents'
import { navBake } from './bake'
import { NavCache } from './cache'
import { NavAgent, NavAreas, NavGridDatas, NavSource, OffMeshLink } from './components'
import { navMethods } from './methods'
import './overlay'
import { loadRecast } from './recast'
import { Nav, type NavState } from './state'

/** Whether an entity is a source or sits under one (its colliders and meshes bake). */
function underSource(world: World, entity: Entity): boolean {
  for (let e: Entity | null = entity, depth = 0; e !== null && depth < 64; depth++) {
    if (!world.isAlive(e)) return false
    if (world.has(e, NavSource)) return true
    e = world.tryGet(e, ChildOf)?.parent ?? null
  }
  return false
}

function observe(world: World, nav: NavState): void {
  const structural = () => {
    nav.dirty = true
  }
  const shape = ({ entity }: { entity: Entity }) => {
    if (nav.watched.has(entity) || underSource(world, entity)) nav.dirty = true
  }
  for (const def of [NavSource, OffMeshLink] as ComponentDef[]) {
    world.observe(onAdd(def), structural)
    world.observe(onRemove(def), structural)
  }
  for (const def of [Collider, Mesh3d, ChildOf] as ComponentDef[]) {
    world.observe(onAdd(def), shape)
    world.observe(onRemove(def), shape)
  }
  world.observe(onSet(ChildOf), shape)
  world.observe(onRemove(NavAgent), ({ entity }) => dropAgent(world, entity))
}

function build(app: App): void {
  const w = app.world
  const nav = w.initResource(Nav)
  w.initResource(NavAreas)
  w.initResource(NavCache)
  w.initResource(NavGridDatas)
  observe(w, nav)
  app.addSystems(FixedUpdate, navAgents.before(PhysicsSystems))
  app.addSystems(PostUpdate, navBake.after(TransformSystems))
  app.addMethod(...navMethods)
}

/**
 * Navigation (spec 0037): NavGrid A* for 2D, Recast navmeshes baked from NavSource geometry with
 * off-mesh links, path queries, and NavAgents steered by Detour's crowd or grid steering.
 */
export const navPlugin: Plugin = definePlugin({
  name: 'nav',
  dependencies: ['core/transform'],
  build,
  async ready(app) {
    app.world.resource(Nav).R = await loadRecast()
  },
})

/**
 * Grids only: NavGrid, path queries on grids, and grid NavAgents, without loading the Recast
 * WASM. NavMesh entities report `nav/no-navmesh`.
 */
export const navGridPlugin: Plugin = definePlugin({
  name: 'nav/grid',
  dependencies: ['core/transform'],
  build,
})
