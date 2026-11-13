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
  GATE_CUSTOM,
  GATE_LOCKED,
  GATE_SOLID,
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
  type WallModel,
} from './model'

// Structure as a navmesh source (0112): walls and floors are nav shapes, doors are area gates whose
// polygons' flags follow their state, passable windows are link gates across the wall, and hatches
// are gates over their hole. A door toggle changes flags and re-bakes nothing.

/**
 * A door's gate state: shut doors are `closed`, locked ones `closed | locked`. A barricade adds
 * `custom` (0114), open or not.
 */
export function doorFlags(o: OpeningModel): number {
  const barricade = o.barricaded ? GATE_CUSTOM : 0
  if (o.movement === 'none' || o.state === 'open') return barricade
  return (o.state === 'locked' ? GATE_CLOSED | GATE_LOCKED : GATE_CLOSED) | barricade
}

/**
 * A window's link: nobody crosses unless the game made it passable (`movement: 'none'`). A
 * barricaded one stays shut either way, with `custom` (0114).
 */
export function windowFlags(o: OpeningModel): number {
  if (o.barricaded) return GATE_LOCKED | GATE_CUSTOM
  return o.movement === 'none' ? 0 : GATE_LOCKED
}

/** A hatch's gate: an open hatch is a hole nobody walks onto, breaching or not (0114). */
export function hatchFlags(c: CutoutModel): number {
  return c.state === 'open' ? GATE_SOLID : 0
}

/** A standing Breach span (0114): shut to everyone, and only breaching filters plan through it. */
export const BREACH_FLAGS = GATE_CLOSED | GATE_LOCKED

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
  /** Breach gates by the wall they're across (0114), and spans warned for overlapping openings. */
  breachGates: Map<Entity, Set<Entity>>
  breachWarned: Set<Entity>
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
const fm = new Float64Array(4)

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

/** Removes the gates of every Breach across `wall` (0114). */
function clearBreachGates(s: StructureNavState, nav: NavState, wall: Entity): void {
  const set = s.breachGates.get(wall)
  if (!set) return
  for (const b of set) if (s.gates.delete(b)) nav.gates.delete(b)
  s.breachGates.delete(wall)
}

/**
 * Where `wall`'s Breach spans lie (0114), as sorted `[s0, s1]` pairs for its nav shape to leave
 * out, with a gate across each: the span, `gateMargin` past each face, closed and locked. A span
 * reaching into an opening stops at its edge (warned once).
 */
function breachSpans(
  world: World,
  s: StructureNavState,
  model: StructureModelState,
  nav: NavState,
  wall: Entity,
  w: WallModel,
): number[] | undefined {
  const ids = model.breachesByWall.get(wall)
  const had = s.breachGates.get(wall)
  if ((!ids || ids.size === 0) && !had) return undefined
  const settings = s.settings
  const line = w.shape.line
  const length = line.length
  const cut: number[] = []
  const kept = new Set<Entity>()
  for (const b of [...(ids ?? [])].sort((p, q) => p - q)) {
    const rec = model.breaches.get(b)
    if (!rec || rec.wall !== wall) continue
    let s0 = Math.min(length, Math.max(0, rec.offset))
    let s1 = rec.width > 0 ? Math.min(length, rec.offset + rec.width) : length
    let clipped = false
    for (let i = 0; i * 4 < w.gaps.length; i++) {
      const g0 = w.gaps[i * 4]!
      const g1 = w.gaps[i * 4 + 1]!
      if (Number.isNaN(g0) || g0 >= s1 || g1 <= s0) continue
      clipped = true
      if ((s0 + s1) / 2 < (g0 + g1) / 2) s1 = Math.min(s1, g0)
      else s0 = Math.max(s0, g1)
    }
    if (clipped && !s.breachWarned.has(b)) {
      s.breachWarned.add(b)
      const err = new ShardError(
        'structure/breach-overlaps-opening',
        `Breach ${b} reaches into an opening of wall ${wall}; it stops at the opening's edge`,
        {
          path: `/entities/${b}/structure/Breach`,
          hint: 'Move or narrow the Breach: an opening is already a way through (a door or window gate).',
        },
      )
      world
        .tryResource(LogResource)
        ?.log('warn', err.message, { code: err.code, path: err.path, hint: err.hint })
    } else if (!clipped) s.breachWarned.delete(b)
    if (s1 - s0 < 0.05) continue
    cut.push(s0, s1)
    kept.add(b)
    const reach = w.shape.thickness / 2 + settings.gateMargin
    frameAt(line, s0, fa)
    frameAt(line, s1, fb)
    frameAt(line, (s0 + s1) / 2, fm)
    const base = w.shape.elevation
    nav.gates.set(b, {
      points: [
        [fa[0]! - fa[2]! * reach, fa[1]! - fa[3]! * reach],
        [fb[0]! - fb[2]! * reach, fb[1]! - fb[3]! * reach],
        [fb[0]! + fb[2]! * reach, fb[1]! + fb[3]! * reach],
        [fa[0]! + fa[2]! * reach, fa[1]! + fa[3]! * reach],
      ],
      yMin: base - 0.5,
      yMax: base + 0.5,
      area: settings.breachArea,
      flags: BREACH_FLAGS,
      axis: [fm[2]!, fm[3]!],
    })
    s.gates.add(b)
    s.run.gates++
  }
  for (const b of had ?? []) if (!kept.has(b) && s.gates.delete(b)) nav.gates.delete(b)
  if (kept.size > 0) s.breachGates.set(wall, kept)
  else s.breachGates.delete(wall)
  // Pairs in order along the wall, for wallBlockers.
  const order = [...Array(cut.length / 2).keys()].sort((i, j) => cut[i * 2]! - cut[j * 2]!)
  return order.flatMap((i) => [cut[i * 2]!, cut[i * 2 + 1]!])
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
  if (!model.isSolid(entity, part)) {
    // A backdrop (0113): no shape, and no gate.
    if (s.gates.delete(entity)) nav.gates.delete(entity)
    if (part === 'wall') clearBreachGates(s, nav, entity)
  } else if (part === 'wall') {
    const w = model.walls.get(entity)
    if (w) wallBlockers(w, shapes, breachSpans(world, s, model, nav, entity, w))
    else clearBreachGates(s, nav, entity)
  } else if (part === 'breach') {
    // The wall it's across draws its span again, with its gate; so does the one it left.
    const host = model.breaches.get(entity)?.wall
    const left = [...s.breachGates].filter(([wall, set]) => set.has(entity) && wall !== host)
    for (const [wall] of left) build(world, s, model, nav, wall, 'wall')
    if (host !== undefined && model.walls.has(host)) build(world, s, model, nav, host, 'wall')
    return
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
    frameAt(line, (s0 + s1) / 2, fm)
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
      // Through the wall (0114): a door is usually wider than its gate is deep.
      axis: [fm[2]!, fm[3]!],
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
  s.breachGates.clear()
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
    // A wall's Breach gates go with it; a Breach gone gives its wall's span back (0114).
    clearBreachGates(s, nav, edit.entity)
    if (edit.part === 'breach' || edit.part === 'wall') {
      const hosts = [...s.breachGates].filter(([, set]) => set.has(edit.entity))
      for (const [wall, set] of hosts) {
        set.delete(edit.entity)
        if (currentModel.walls.has(wall)) build(currentWorld, s, currentModel, nav, wall, 'wall')
      }
    }
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
      breachGates: new Map<Entity, Set<Entity>>(),
      breachWarned: new Set<Entity>(),
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
          breaches: [...s.breachGates.values()].reduce((n, set) => n + set.size, 0),
          narrowDoors: [...s.warned],
          settings: s.settings,
          last: s.last,
        },
      }
    })
  },
})
