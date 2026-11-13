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
import { CharacterSuspended, Collider, PhysicsSystems } from '@aethervtt/shard-physics'
import { Mesh3d } from '@aethervtt/shard-render'
import { type App, definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { dropAgent, navAgents } from './agents'
import { navBake } from './bake'
import * as cacheModule from './cache'
import { NavCache } from './cache'
import * as componentsModule from './components'
import {
  NavAgent,
  NavAreas,
  NavBreach,
  NavFilters,
  NavFlowField,
  NavGridDatas,
  NavSource,
  OffMeshLink,
} from './components'
import { NavFlows } from './flow-state'
import { navMethods } from './methods'
import * as overlayModule from './overlay'
import { loadRecast } from './recast'
import * as stateModule from './state'
import { LINKS, Nav, type NavState } from './state'
import { NavMovers } from './steer-state'

/** The NavSource an entity is, or sits under (its colliders and meshes bake with it). */
function rootOf(world: World, entity: Entity): Entity | undefined {
  for (let e: Entity | null = entity, depth = 0; e !== null && depth < 64; depth++) {
    if (!world.isAlive(e)) return undefined
    if (world.has(e, NavSource)) return e
    e = world.tryGet(e, ChildOf)?.parent ?? null
  }
  return undefined
}

/**
 * Marks only what an add or remove touches (0112): the source root it belongs to now and the one it
 * did, or the links. The bake gathers just those again.
 */
function observe(world: World, nav: NavState): void {
  const source = ({ entity }: { entity: Entity }) => {
    nav.dirtyRoots.add(entity)
    // A source inside another one leaves or joins its parent's subtree.
    const parent = world.tryGet(entity, ChildOf)?.parent
    const above = parent != null ? rootOf(world, parent) : undefined
    if (above !== undefined) nav.dirtyRoots.add(above)
  }
  const shape = ({ entity }: { entity: Entity }) => {
    const was = nav.rootOf.get(entity)
    if (was === LINKS) nav.linksDirty = true
    else if (was !== undefined) nav.dirtyRoots.add(was)
    const now = rootOf(world, entity)
    if (now !== undefined) nav.dirtyRoots.add(now)
  }
  world.observe(onAdd(NavSource), source)
  world.observe(onRemove(NavSource), source)
  for (const def of [OffMeshLink] as ComponentDef[]) {
    world.observe(onAdd(def), () => {
      nav.linksDirty = true
    })
    world.observe(onRemove(def), () => {
      nav.linksDirty = true
    })
  }
  for (const def of [Collider, Mesh3d, ChildOf] as ComponentDef[]) {
    world.observe(onAdd(def), shape)
    world.observe(onRemove(def), shape)
  }
  world.observe(onSet(ChildOf), shape)
  world.observe(onRemove(NavAgent), ({ entity }) => {
    dropAgent(world, entity)
    world.tryResource(NavMovers)?.drop(entity)
    // A controller nav suspended walks again once nav no longer moves it.
    if (world.isAlive(entity) && world.has(entity, CharacterSuspended)) {
      world.remove(entity, CharacterSuspended)
    }
  })
  world.observe(onRemove(NavFlowField), ({ entity }) => world.tryResource(NavFlows)?.drop(entity))
}

function build(app: App): void {
  const w = app.world
  const nav = w.initResource(Nav)
  w.initResource(NavAreas)
  w.initResource(NavFilters)
  w.initResource(NavBreach)
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
  provides: [cacheModule, componentsModule, overlayModule, stateModule],
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
  provides: [cacheModule, componentsModule, overlayModule, stateModule],
  dependencies: ['core/transform'],
  build,
})
