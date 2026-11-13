import {
  defineResource,
  defineSystem,
  type Entity,
  FixedUpdate,
  PostUpdate,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import {
  GATE_CLOSED,
  GATE_LOCKED,
  Nav,
  NavMesh,
  type NavState,
  navAgents,
  navBake,
} from '@aethervtt/shard-nav'
import { definePlugin, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import {
  type BlockingShape,
  blockingTriangles,
  cutoutBlockers,
  slabBlockers,
  wallBlockers,
} from './blocking'
import { defaultStructureNav, type StructureNavSettings, StructureSettings } from './components'
import { pointAt } from './curve'
import { slabY } from './geometry'
import {
  type CutoutModel,
  type EditCursor,
  type OpeningModel,
  type StructureEdit,
  StructureModel,
  type StructureModelState,
  structureModelPlugin,
  syncStructure,
  syncStructureFixed,
} from './model'

// Structure as a navmesh source (0112): walls and floors are nav shapes, doors are area gates whose
// polygons' flags follow their state, passable windows are link gates across the wall, and hatches
// are gates over their hole. A door toggle changes flags and re-bakes nothing.

/** A door's gate state: shut doors are `closed`, locked ones `closed | locked`. */
export function doorFlags(o: OpeningModel): number {
  if (o.movement === 'none' || o.state === 'open') return 0
  return o.state === 'locked' ? GATE_CLOSED | GATE_LOCKED : GATE_CLOSED
}

/** A window's link: nobody crosses unless the game made it passable (`movement: 'none'`). */
export function windowFlags(o: OpeningModel): number {
  return o.movement === 'none' ? 0 : GATE_LOCKED
}

/** A hatch's gate: an open hatch is a hole nobody walks onto. */
export function hatchFlags(c: CutoutModel): number {
  return c.state === 'open' ? GATE_LOCKED : 0
}

export interface StructureNavState {
  cursor: EditCursor | undefined
  /** The settings object last applied (a patch replaces it), and its values. */
  seen: object | undefined
  settings: StructureNavSettings
  /** Entities with a nav shape, and with a gate. */
  shapes: Set<Entity>
  gates: Set<Entity>
  /** Doors reported too narrow, as `door:navmesh`. */
  warned: Set<string>
  /** What the last run that did something did, and this run's counts. */
  last: { shapes: number; gates: number; flags: number; removed: number; ms: number }
  run: { shapes: number; gates: number; flags: number; removed: number; ms: number }
}

export const StructureNav = defineResource<StructureNavState>('structure/Nav', {
  description:
    'Structure as a nav source (0112): the entities with nav shapes and gates, and what the last update set, flagged and removed.',
})

function settingsOf(world: World): StructureNavSettings {
  return { ...defaultStructureNav(), ...world.resource(StructureSettings).nav }
}

const p0 = new Float64Array(2)
const p1 = new Float64Array(2)

/** The point at arc length `s` and the unit normal to the left of the wall there. */
function frameAt(line: Parameters<typeof pointAt>[0], s: number, out: Float64Array): void {
  pointAt(line, Math.max(0, s - 0.01), p0)
  pointAt(line, Math.min(line.length, s + 0.01), p1)
  const tx = p1[0]! - p0[0]!
  const tz = p1[1]! - p0[1]!
  const l = Math.sqrt(tx * tx + tz * tz) || 1
  pointAt(line, s, p0)
  out[0] = p0[0]!
  out[1] = p0[1]!
  out[2] = -tz / l
  out[3] = tx / l
}

const fa = new Float64Array(4)
const fb = new Float64Array(4)

/** Convex hull of flat (x, z) pairs, counterclockwise (monotone chain). */
function hull(points: Float64Array): number[][] {
  const pts: number[][] = []
  for (let i = 0; i < points.length; i += 2) pts.push([points[i]!, points[i + 1]!])
  pts.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!)
  const lower: number[][] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper: number[][] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** Warns once per door and navmesh when the door is narrower than the navmesh's agents need. */
function checkWidth(world: World, s: StructureNavState, door: Entity, width: number): void {
  for (const table of world.query({ with: [NavMesh] }).tables) {
    for (let row = 0; row < table.count; row++) {
      const mesh = table.entities[row]! as Entity
      const nm = world.get(mesh, NavMesh)
      const cs = nm.cellSize
      // Erosion rounds the radius up to whole cells, each jamb can take a cell off the gap, and
      // the passage needs two cells left to survive contour simplification. Measured (0112): at
      // 0.1 m cells a 0.3 m agent passes 1 m doors at any alignment and no 0.9 m one.
      const need = 2 * Math.ceil(nm.agentRadius / cs - 1e-6) * cs + 4 * cs
      const key = `${door}:${mesh}`
      if (width >= need - 1e-6) {
        s.warned.delete(key)
        continue
      }
      if (s.warned.has(key)) continue
      s.warned.add(key)
      const err = new ShardError(
        'structure/door-too-narrow',
        `Door ${door} is ${width.toFixed(2)} m wide; navmesh ${mesh}'s agents need ${need.toFixed(2)} m`,
        {
          path: `/entities/${door}/structure/Opening/width`,
          hint: 'Widen the door, or give the NavMesh a smaller agentRadius or cellSize: an opening needs 2·⌈r/cs⌉·cs + 4·cs to pass at any alignment.',
        },
      )
      world
        .tryResource(LogResource)
        ?.log('warn', err.message, { code: err.code, path: err.path, hint: err.hint })
    }
  }
}

/** Sets (or removes) one entity's nav shape or gate from the model. */
function build(
  world: World,
  s: StructureNavState,
  model: StructureModelState,
  nav: NavState,
  entity: Entity,
  part: StructureEdit['part'],
): void {
  const settings = s.settings
  const shapes: BlockingShape[] = []
  const area = settings.floorArea
  if (part === 'wall') {
    const w = model.walls.get(entity)
    if (w) wallBlockers(w, shapes)
  } else if (part === 'floor' || (part === 'roof' && settings.roofs)) {
    const slab = model.slabs.get(entity)
    if (slab) slabBlockers(slab, shapes)
  } else if (part === 'opening') {
    setOpeningGate(world, s, model, nav, entity)
    return
  } else if (part === 'cutout') {
    const c = model.cutouts.get(entity)
    const host = c ? model.slabs.get(c.host) : undefined
    if (c && host && c.kind === 'hatch' && c.ring > 0) {
      cutoutBlockers(c, host, shapes)
      const outline = hull(c.points)
      let cx = 0
      let cz = 0
      for (const [x, z] of outline) {
        cx += x!
        cz += z!
      }
      const y = slabY(host.shape, cx / outline.length, cz / outline.length)
      nav.gates.set(entity, {
        points: outline,
        yMin: y - 0.5,
        yMax: y + 0.5,
        area: settings.hatchArea,
        flags: hatchFlags(c),
      })
      s.gates.add(entity)
      s.run.gates++
    } else if (s.gates.delete(entity)) nav.gates.delete(entity)
  }
  if (shapes.length === 0) {
    if (s.shapes.delete(entity)) nav.shapes.delete(entity)
    return
  }
  nav.shapes.set(entity, blockingTriangles(shapes), area)
  s.shapes.add(entity)
  s.run.shapes++
}

/** A door's area gate over its hole, or a low window's link across the wall. */
function setOpeningGate(
  world: World,
  s: StructureNavState,
  model: StructureModelState,
  nav: NavState,
  entity: Entity,
): void {
  const settings = s.settings
  const o = model.openings.get(entity)
  const w = o ? model.walls.get(o.wall) : undefined
  const index = w ? w.openings.indexOf(entity) : -1
  const g = w?.gaps
  const s0 = g && index >= 0 ? g[index * 4]! : Number.NaN
  if (!o || !w || Number.isNaN(s0)) {
    if (s.gates.delete(entity)) nav.gates.delete(entity)
    return
  }
  const s1 = g![index * 4 + 1]!
  const sill = g![index * 4 + 2]!
  const line = w.shape.line
  const half = w.shape.thickness / 2
  if (o.kind === 'door') {
    const reach = half + settings.gateMargin
    frameAt(line, s0, fa)
    frameAt(line, s1, fb)
    nav.gates.set(entity, {
      points: [
        [fa[0]! - fa[2]! * reach, fa[1]! - fa[3]! * reach],
        [fb[0]! - fb[2]! * reach, fb[1]! - fb[3]! * reach],
        [fb[0]! + fb[2]! * reach, fb[1]! + fb[3]! * reach],
        [fa[0]! + fa[2]! * reach, fa[1]! + fa[3]! * reach],
      ],
      yMin: sill - 0.5,
      yMax: sill + 0.5,
      area: settings.doorArea,
      flags: doorFlags(o),
    })
    s.gates.add(entity)
    s.run.gates++
    checkWidth(world, s, entity, s1 - s0)
    return
  }
  if (sill - w.shape.elevation > settings.windowClimb) {
    if (s.gates.delete(entity)) nav.gates.delete(entity)
    return
  }
  const reach = half + settings.windowReach
  const base = w.shape.elevation
  frameAt(line, (s0 + s1) / 2, fa)
  nav.gates.set(entity, {
    link: {
      start: [fa[0]! - fa[2]! * reach, base, fa[1]! - fa[3]! * reach],
      end: [fa[0]! + fa[2]! * reach, base, fa[1]! + fa[3]! * reach],
      radius: Math.min(0.4, (s1 - s0) / 2),
    },
    area: settings.windowArea,
    flags: windowFlags(o),
  })
  s.gates.add(entity)
  s.run.gates++
}

/** Removes every structure shape and gate, then sets every one again in entity order. */
function rebuildAll(world: World, s: StructureNavState, model: StructureModelState, nav: NavState) {
  for (const e of s.shapes) nav.shapes.delete(e)
  for (const e of s.gates) nav.gates.delete(e)
  s.shapes.clear()
  s.gates.clear()
  if (!s.settings.enabled) return
  const parts: [Entity, StructureEdit['part']][] = []
  for (const e of model.walls.keys()) parts.push([e, 'wall'])
  for (const [e, slab] of model.slabs) parts.push([e, slab.kind])
  for (const e of model.openings.keys()) parts.push([e, 'opening'])
  for (const e of model.cutouts.keys()) parts.push([e, 'cutout'])
  parts.sort((a, b) => a[0] - b[0])
  for (const [e, part] of parts) build(world, s, model, nav, e, part)
}

let current: StructureNavState
let currentModel: StructureModelState
let currentNav: NavState
let currentWorld: World

/** One edit from the log (a module function, so reading the log allocates nothing). */
function apply(edit: StructureEdit): void {
  const s = current
  const nav = currentNav
  if (edit.kind === 'removed') {
    if (s.shapes.delete(edit.entity)) nav.shapes.delete(edit.entity)
    if (s.gates.delete(edit.entity)) nav.gates.delete(edit.entity)
    s.run.removed++
  } else if (edit.kind === 'geometry') {
    build(currentWorld, s, currentModel, nav, edit.entity, edit.part)
  } else if (s.gates.has(edit.entity)) {
    const o = currentModel.openings.get(edit.entity)
    const c = currentModel.cutouts.get(edit.entity)
    const flags = o ? (o.kind === 'door' ? doorFlags(o) : windowFlags(o)) : c ? hatchFlags(c) : 0
    nav.gates.setFlags(edit.entity, flags)
    s.run.flags++
  }
}

function update(world: World): void {
  const nav = world.tryResource(Nav)
  if (!nav) return
  const s = world.resource(StructureNav)
  const model = world.resource(StructureModel)
  const raw = world.resource(StructureSettings).nav
  // Nothing new in the log and the same settings: no work, and no allocation.
  if (s.cursor !== undefined && raw === s.seen && s.cursor.at === model.offset + model.log.length)
    return
  const start = performance.now()
  // This run counts into `run`; `last` keeps the last run that did something.
  const last = s.run
  last.shapes = 0
  last.gates = 0
  last.flags = 0
  last.removed = 0
  if (s.cursor === undefined || raw !== s.seen) {
    s.seen = raw
    s.settings = settingsOf(world)
    s.cursor ??= model.cursor()
    s.cursor.at = model.offset + model.log.length
    rebuildAll(world, s, model, nav)
  } else if (s.settings.enabled) {
    current = s
    currentModel = model
    currentNav = nav
    currentWorld = world
    model.read(s.cursor, apply)
  } else {
    s.cursor.at = model.offset + model.log.length
  }
  model.compact()
  if (last.shapes + last.gates + last.flags + last.removed > 0) {
    const kept = s.last
    kept.shapes = last.shapes
    kept.gates = last.gates
    kept.flags = last.flags
    kept.removed = last.removed
    kept.ms = performance.now() - start
  }
}

/** Structure's nav shapes and gates before nav agents step, so a door shut this step holds. */
export const structureNavFixed = defineSystem({
  name: 'structure/nav-fixed',
  description: "Brings structure's nav shapes and gates up to date before NavAgents step (0112).",
  run: (_, world) => update(world),
})

/** Structure's nav shapes and gates before the bake. */
export const structureNav = defineSystem({
  name: 'structure/nav',
  description:
    "Keeps structure's nav sources in step with the structure model: walls and floors as nav shapes, doors and hatches as gates whose flags follow their state, passable windows as links (0112).",
  run: (_, world) => update(world),
})

/**
 * Structure as a navmesh source (0112): walls and floors feed navmeshes directly, and doors,
 * windows and hatches are gates a query filter decides who passes; toggling one re-bakes
 * nothing. Needs `nav`; adds `structure/model` when it's missing. Runs headless.
 */
export const structureNavPlugin: Plugin = definePlugin({
  name: 'structure/nav',
  dependencies: ['nav'],
  build(app) {
    if (!app.hasPlugin('structure/model')) app.addPlugin(structureModelPlugin)
    app.world.insertResource(StructureNav, {
      cursor: undefined,
      seen: undefined,
      settings: defaultStructureNav(),
      shapes: new Set<Entity>(),
      gates: new Set<Entity>(),
      warned: new Set<string>(),
      last: { shapes: 0, gates: 0, flags: 0, removed: 0, ms: 0 },
      run: { shapes: 0, gates: 0, flags: 0, removed: 0, ms: 0 },
    })
    app.addSystems(FixedUpdate, structureNavFixed.after(syncStructureFixed).before(navAgents))
    app.addSystems(PostUpdate, structureNav.after(syncStructure).before(navBake))
  },
  ready(app) {
    const world = app.world
    world.resource(StructureModel).sections.push(() => {
      const s = world.resource(StructureNav)
      return {
        nav: {
          shapes: s.shapes.size,
          gates: s.gates.size,
          narrowDoors: [...s.warned],
          settings: s.settings,
          last: s.last,
        },
      }
    })
  },
})
