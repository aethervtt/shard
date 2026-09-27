import { ChildOf, Derived, type Entity, type Query, quat, type World } from '@aethervtt/shard-core'
import { NavMesh, NavSource } from '@aethervtt/shard-nav'
import {
  GlobalTransform,
  placeInGrid,
  propagateSubtree,
  Transform,
} from '@aethervtt/shard-transform'
import { collidersOf } from './colliders'
import { PlanetNav } from './components'
import { heightAt } from './heights'
import type { PlanetRuntime } from './planet'

/** A planet's navmesh: a tangent frame near its agents, and the NavMesh baked in it. */
interface PlanetNavState {
  frame: Entity
  navmesh: Entity
  /** The frame's origin in the planet frame. */
  anchor: Float64Array
  /** The settings the NavMesh was made with. */
  key: string
}

function stateOf(rt: PlanetRuntime): PlanetNavState | undefined {
  return rt.parts.get('nav') as PlanetNavState | undefined
}

const p = new Float64Array(3)
const sum = new Float64Array(3)

/** NavAgents near a planet (positions in its frame), for the navmesh's frame. */
export function planetAgents(rt: PlanetRuntime, query: Query, out: Float64Array[]): number {
  let n = 0
  const s = rt.settings!
  const reach = s.radius * Math.max(s.shape[0]!, s.shape[1]!, s.shape[2]!) + rt.highest + 1000
  for (const table of query.tables) {
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) {
      rt.frame.pointToPlanet(m[row * 12 + 3]!, m[row * 12 + 7]!, m[row * 12 + 11]!, p)
      if (Math.hypot(p[0]!, p[1]!, p[2]!) > reach) continue
      if (!out[n]) out[n] = new Float64Array(3)
      out[n]!.set(p)
      n++
    }
  }
  return n
}

const agents: Float64Array[] = []

/**
 * Keeps a planet's navmesh (spec 0043): a NavMesh in a tangent frame (up is radial) at the ground
 * under its NavAgents, baked from the collider chunks around them (which get NavSource), within
 * PlanetNav.radius. The frame moves (and the navmesh rebakes) once the agents' center drifts
 * half the radius away, so its tiles stay put while agents walk and while the origin moves.
 */
export function updatePlanetNav(world: World, rt: PlanetRuntime, query: Query): void {
  const state = stateOf(rt)
  if (!world.has(rt.entity, PlanetNav)) {
    if (state) clearPlanetNav(world, rt)
    return
  }
  const v = world.get(rt.entity, PlanetNav)
  // Collider chunks feed the bake.
  for (const chunk of collidersOf(rt).chunks.values()) {
    if (chunk.entity >= 0 && !world.has(chunk.entity, NavSource)) world.add(chunk.entity, NavSource)
  }
  const n = planetAgents(rt, query, agents)
  if (n === 0) return
  sum.fill(0)
  for (let i = 0; i < n; i++) {
    sum[0] = sum[0]! + agents[i]![0]!
    sum[1] = sum[1]! + agents[i]![1]!
    sum[2] = sum[2]! + agents[i]![2]!
  }
  const key = JSON.stringify([v.agentRadius, v.agentHeight, v.maxSlope, v.radius])
  const cx = sum[0]! / n
  const cy = sum[1]! / n
  const cz = sum[2]! / n
  if (state) {
    const d = Math.hypot(cx - state.anchor[0]!, cy - state.anchor[1]!, cz - state.anchor[2]!)
    if (d < v.radius * 0.5 && state.key === key && world.isAlive(state.frame)) return
  }
  // A new frame: at the ground under the agents' center, +Y radial.
  const l = Math.hypot(cx, cy, cz) || 1
  const ux = cx / l
  const uy = cy / l
  const uz = cz / l
  const r = rt.settings!.radius + heightAt(rt, ux, uy, uz)
  const anchor = new Float64Array([ux * r, uy * r, uz * r])
  const side = Math.abs(uy) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const forward = [
    uy * side[2]! - uz * side[1]!,
    uz * side[0]! - ux * side[2]!,
    ux * side[1]! - uy * side[0]!,
  ]
  const rotation = quat.lookRotation([0, 0, 0, 1], forward, [ux, uy, uz]) as [
    number,
    number,
    number,
    number,
  ]
  let frame = state?.frame
  if (frame === undefined || !world.isAlive(frame)) {
    frame = world.spawn([ChildOf, { parent: rt.entity }], Transform, Derived)
  }
  placeInGrid(world, frame, rt.entity, anchor)
  world.set(frame, Transform, { ...world.get(frame, Transform), rotation })
  propagateSubtree(world, frame)
  const settings = {
    agentRadius: v.agentRadius,
    agentHeight: v.agentHeight,
    maxSlope: v.maxSlope,
    maxClimb: Math.max(0.3, v.agentHeight * 0.3),
    // Coarser voxels than a level's: the area is hundreds of metres across.
    cellSize: Math.max(0.3, v.agentRadius / 1.5),
    cellHeight: 0.15,
    tileSize: 64,
    boundsMin: [-v.radius, -v.radius, -v.radius] as [number, number, number],
    boundsMax: [v.radius, v.radius, v.radius] as [number, number, number],
    frame,
  }
  let navmesh = state?.navmesh
  if (navmesh === undefined || !world.isAlive(navmesh))
    navmesh = world.spawn([NavMesh, settings], Derived)
  else world.set(navmesh, NavMesh, settings)
  rt.parts.set('nav', { frame, navmesh, anchor, key })
}

export function clearPlanetNav(world: World, rt: PlanetRuntime): void {
  const state = stateOf(rt)
  if (!state) return
  if (world.isAlive(state.navmesh)) world.despawn(state.navmesh)
  if (world.isAlive(state.frame)) world.despawn(state.frame)
  rt.parts.delete('nav')
}

/** The planet's NavMesh entity, if it has one. */
export function planetNavMesh(rt: PlanetRuntime): Entity | undefined {
  return stateOf(rt)?.navmesh
}
