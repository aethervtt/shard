import { defineSchema, type Entity, findComponent, t, type World } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { bakeNavigation, liveTileKeys, NO_RECAST } from './bake'
import { blockedAt } from './breach'
import { NavCache, saveNavCache } from './cache'
import { AGENT_STATUSES, DRIVES, NavAgent, NavAgentState, NavFilters, NavMesh } from './components'
import { DIAGONAL_MODES } from './grid'
import { DEFAULT_BREACH_COST } from './navmesh'
import { findPath } from './query'
import { GATE_BITS } from './recast'
import { Nav, type NavState, navState } from './state'

const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits
const r3 = (v: ArrayLike<number>) => [round(v[0]!), round(v[1]!), round(v[2]!)]

function scenePath(world: World, entity: Entity | null): string | null {
  if (entity === null || entity < 0) return null
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

/** Grids, navmeshes, and agents as data (the `nav.describe` method). */
export function describeNav(world: World) {
  const nav = navState(world)
  const cache = world.tryResource(NavCache)
  const meshEntities = world.query({ with: [NavMesh] }).entities()
  return {
    recast: nav.R !== null,
    grids: [...nav.grids.values()].map((g) => {
      let walkable = 0
      if (g.grid) for (let i = 0; i < g.grid.costs.length; i++) if (g.grid.costs[i]! > 0) walkable++
      return {
        entity: g.entity,
        path: scenePath(world, g.entity),
        source: g.source,
        size: g.grid ? [g.grid.width, g.grid.height] : null,
        cellSize: [round(g.csx), round(g.csy)],
        origin: [round(g.ox), round(g.oy)],
        diagonal: DIAGONAL_MODES[g.diagonal],
        walkableCells: walkable,
        problem: g.problem,
      }
    }),
    meshes: meshEntities.map((entity) => {
      const rt = nav.meshes.get(entity)
      if (!rt)
        return {
          entity,
          path: scenePath(world, entity),
          problem: nav.R ? 'not baked yet' : NO_RECAST,
        }
      const walkable = [...rt.tiles.values()].filter((tile) => tile.ref)
      return {
        entity,
        path: scenePath(world, entity),
        settings: rt.settings,
        tiles: walkable.length,
        emptyTiles: rt.tiles.size - walkable.length,
        polygons: rt.polygons(),
        bounds: walkable.length > 0 ? { min: r3(rt.min), max: r3(rt.max) } : null,
        lastBake: {
          ms: round(rt.stats.ms, 2),
          built: rt.stats.built,
          fromCache: rt.stats.cached,
          kept: rt.stats.kept,
          removed: rt.stats.removed,
          examined: rt.stats.examined,
          sourcesGathered: rt.stats.gathered,
        },
        filters: [...rt.named.entries()].map(([name, slot]) => ({
          name,
          crowdSlot: slot.index,
          // Breaching (0114): the states it plans through, and what a crossing costs.
          ...(slot.breach !== 0
            ? {
                breach: (Object.keys(GATE_BITS) as (keyof typeof GATE_BITS)[]).filter(
                  (k) => (slot.breach & GATE_BITS[k]) !== 0,
                ),
                breachCost:
                  world.tryResource(NavFilters)?.[name]?.breachCost ?? DEFAULT_BREACH_COST,
              }
            : {}),
        })),
        gates: [...rt.gateTiles.keys()].map((owner) => {
          // Slot sets at it (0114), by side, and how many agents wait there.
          const sets = [-1, 1].flatMap((side) => {
            const set = rt.slots.get(owner * 2 + (side > 0 ? 1 : 0))
            if (!set) return []
            let rows = 0
            for (let i = 0; i < set.count; i++) rows = Math.max(rows, set.row[i]! + 1)
            return [{ side, slots: set.count, rows, claimed: set.claimed(), open: set.open }]
          })
          let waiting = 0
          for (const a of nav.agents.values()) if (blockedAt(a) === owner) waiting++
          return {
            owner,
            polygons: rt.gatePolygons(owner),
            flags: nav.gates.byOwner.get(owner)?.flags ?? 0,
            area: nav.gates.byOwner.get(owner)?.area ?? 0,
            ...(sets.length > 0 ? { slots: sets } : {}),
            ...(waiting > 0 ? { waiting } : {}),
          }
        }),
        bakes: rt.stats.bakes,
        tilesBuilt: rt.stats.totalBuilt,
        cacheHits: rt.stats.totalCached,
        waitingForMeshes: rt.pending,
        crowd: rt.crowd
          ? { agents: rt.crowd.getActiveAgentCount(), capacity: rt.crowdCapacity }
          : null,
        problem: rt.problem,
      }
    }),
    sources: {
      triangles: nav.triangles(),
      entitySources: nav.sources.size,
      shapes: nav.shapes.size,
      gates: nav.gates.size,
      // What breach costs convert by (0114): each gate area's depths, the deepest used.
      gateDepths: gateDepths(nav),
      links: nav.links.length,
      skipped: nav.skipped.map((s) => ({ ...s, path: scenePath(world, s.entity) })),
    },
    replans: nav.replans,
    rebuild: [...nav.meshes.values()].map((rt) => ({
      entity: rt.entity,
      dirty: rt.dirty.size,
      building: rt.jobs.length,
      cold: rt.cold,
    })),
    cache: {
      tiles: cache?.tiles.size ?? 0,
      loadedFromDisk: cache?.loaded ?? 0,
      file: cache?.fs ? cache.path : null,
    },
    agents: [...nav.agents.values()]
      .filter((a) => world.isAlive(a.entity) && world.has(a.entity, NavAgent))
      .map((a) => {
        const agent = world.get(a.entity, NavAgent)
        const state = world.get(a.entity, NavAgentState)
        return {
          entity: a.entity,
          path: scenePath(world, a.entity),
          on: a.nav >= 0 ? { entity: a.nav, path: scenePath(world, a.nav), kind: a.kind } : null,
          filter: a.filter || null,
          replans: a.replans,
          status: state.status,
          ...(state.status === 'blocked' ? { gate: state.gate, row: state.row } : {}),
          ...(a.external ? { mover: 'external' } : {}),
          remaining: round(state.remaining),
          corners: state.corners,
          velocity: r3(state.velocity),
          destination: agent.target === null ? r3(agent.destination) : null,
          target:
            agent.target === null
              ? null
              : { entity: agent.target, path: scenePath(world, agent.target) },
          drive: DRIVES[a.drive],
          ...(DRIVES[a.drive] !== agent.drive
            ? {
                problem: `drive ${agent.drive} needs a ${agent.drive === 'character' ? 'CharacterController' : 'Velocity'}; moving the Transform`,
              }
            : {}),
          route: Array.from({ length: a.count }, (_, i) =>
            r3(a.corners.subarray(i * 3, i * 3 + 3)),
          ),
        }
      }),
    statuses: AGENT_STATUSES,
  }
}

export const navMethods: AppMethod[] = [
  {
    name: 'nav.path',
    description:
      'A path between two world points on the NavGrid or NavMesh containing `from` (or `nav`): status (complete, partial: ends at the closest reachable point, none), corners, length, and the gates it must breach in order (0114: shut in a state its filter breaches). Errors nav/no-navmesh and nav/out-of-bounds say why there is none.',
    params: defineSchema('nav/PathParams', {
      from: t.vec3({ required: true }),
      to: t.vec3({ required: true }),
      nav: t.entity({ description: 'The NavGrid or NavMesh entity (default: the one at from).' }),
      areas: t.json({ description: 'Area costs for this query: { "1": 10 } (0 excludes).' }),
      filter: t.string({
        description:
          'Navmeshes: the nav/Filters entry to path with (0112), such as "zombie". Empty: the default filter.',
      }),
    }),
    handler: ({ world }, p) => {
      const polys: number[] = []
      const path = findPath(world, p.from as number[], p.to as number[], {
        nav: (p.nav as Entity | null | undefined) ?? null,
        areas: (p.areas as Record<number, number> | null | undefined) ?? undefined,
        filter: (p.filter as string | undefined) || undefined,
        polys,
      })
      // The gates it must breach (0114), in order: shut in a state its filter breaches.
      const rt = path.nav === null ? undefined : world.resource(Nav).meshes.get(path.nav)
      const breach: number[] = []
      const bits = rt?.breachBits((p.filter as string | undefined) || undefined) ?? 0
      for (const ref of bits !== 0 ? polys : []) {
        const owner = rt!.refGate.get(ref)
        const gate = owner === undefined ? undefined : rt!.gateOf.get(owner)
        if (gate && (gate.flags & bits) !== 0 && !breach.includes(owner!)) breach.push(owner!)
      }
      return {
        status: path.status,
        breach,
        length: round(path.length),
        corners: Array.from({ length: path.count }, (_, i) =>
          r3(path.corners.subarray(i * 3, i * 3 + 3)),
        ),
        nav: path.nav,
        navPath: scenePath(world, path.nav),
      }
    },
  },
  {
    name: 'nav.describe',
    description:
      'Navigation state: every NavGrid (source, size, cell size, walkable cells, problem), NavMesh (tiles, polygons, bounds, last bake: ms, tiles built by Recast, from cache, kept; totals, meshes still loading), the triangles and off-mesh links baked from, the tile cache, and every NavAgent (status, remaining distance, velocity, destination or target, drive, route corners).',
    params: defineSchema('nav/DescribeParams', {}),
    handler: ({ world }) => describeNav(world),
  },
  {
    name: 'nav.bake',
    description:
      'Rebakes every NavMesh now and reports tiles built by Recast and loaded from the cache; with save (default) writes the tiles to .shard/cache/nav so the next load skips Recast. force rebuilds every tile.',
    params: defineSchema('nav/BakeParams', {
      save: t.bool({ default: true, description: 'Write the tile cache to disk.' }),
      force: t.bool({ description: 'Ignore cached and current tiles: Recast rebuilds all.' }),
    }),
    handler: async ({ world }, p) => {
      const nav = navState(world)
      const cache = world.initResource(NavCache)
      if (p.force) {
        for (const rt of nav.meshes.values()) {
          for (const tile of rt.tiles.values()) cache.tiles.delete(tile.key)
          for (const tile of [...rt.tiles.values()]) rt.removeTile(tile.tx, tile.ty)
        }
      }
      nav.dirty = true
      await bakeNavigation(world)
      const saved = p.save === false ? 0 : await saveNavCache(world, liveTileKeys(nav))
      return {
        meshes: [...nav.meshes.values()].map((rt) => ({
          entity: rt.entity,
          path: scenePath(world, rt.entity),
          tiles: [...rt.tiles.values()].filter((tile) => tile.ref).length,
          polygons: rt.polygons(),
          built: rt.stats.built,
          fromCache: rt.stats.cached,
          kept: rt.stats.kept,
          ms: round(rt.stats.ms, 2),
          problem: rt.problem,
        })),
        saved: saved > 0 ? { file: cache.path, bytes: saved } : null,
      }
    },
  },
]

/** Each gate area's least and greatest depth (0114). */
function gateDepths(nav: NavState): { area: number; min: number; max: number }[] {
  const by = new Map<number, { area: number; min: number; max: number }>()
  for (const g of nav.gates.byOwner.values()) {
    const d = by.get(g.area) ?? { area: g.area, min: Infinity, max: 0 }
    d.min = Math.min(d.min, round(g.depth))
    d.max = Math.max(d.max, round(g.depth))
    by.set(g.area, d)
  }
  return [...by.values()].sort((a, b) => a.area - b.area)
}
