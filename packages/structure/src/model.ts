import {
  type ComponentDef,
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  FixedUpdate,
  onAdd,
  onRemove,
  PostUpdate,
  type Query,
  type World,
} from '@aethervtt/shard-core'
import { type AppMethod, definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import {
  Backdrop,
  Breach,
  Cutout,
  Floor,
  Level,
  Opening,
  Roof,
  StructureSettings,
  Wall,
} from './components'
import { sampleWall } from './curve'
import {
  type FloorShape,
  floorShape,
  type OpeningShape,
  type Piece,
  ringInside,
  ringsOverlap,
  type WallShape,
  wallPieces,
} from './geometry'

// The structure model (0112): what every wall, opening, floor, roof and cutout is, as geometry,
// with no render code. A headless server runs it alone; colliders (`./physics`) and, with render,
// nothing else read it. Each sync appends what changed to an edit log that consumers read from
// their own cursor, so none of them rescans the world.

/** A wall's centreline, extruded, and its solid pieces (frames left out: they don't block). */
export interface WallModel {
  shape: WallShape
  pieces: Piece[]
  count: number
  /** Its openings by offset; `gaps[i * 4]` is opening i's hole `[s0, s1, sill, head]`. */
  openings: Entity[]
  gaps: number[]
  level: Entity | null
  /** False for a backdrop (structure/Backdrop on it or its level): no colliders, no nav. */
  solid: boolean
  signature: string
}

export interface OpeningModel {
  wall: Entity
  kind: 'door' | 'window'
  offset: number
  width: number
  height: number
  sill: number
  state: 'closed' | 'open' | 'locked'
  movement: 'normal' | 'none'
  barricaded: boolean
}

/** A breachable span of a wall (0114), as its component says: nav works out where it lies. */
export interface BreachModel {
  wall: Entity
  offset: number
  width: number
}

export interface SlabModel {
  kind: 'floor' | 'roof'
  shape: FloorShape
  /** Accepted cutouts in ring order (cutout i is ring i + 1). */
  cutouts: Entity[]
  level: Entity | null
  /** False for a backdrop (structure/Backdrop on it or its level): no colliders, no nav. */
  solid: boolean
  signature: string
}

export interface CutoutModel {
  host: Entity
  kind: 'hole' | 'hatch' | 'skylight'
  /** Flat (x, z) pairs. */
  points: Float64Array
  state: 'closed' | 'open' | 'locked'
  /** Its ring in its host's shape, or -1 when the host skipped it. */
  ring: number
}

/**
 * What an edit is of. A Breach on a wall's own entity logs as that wall's `wall` edit (the log
 * has one part per entity); one on its own entity logs as `breach`.
 */
export type EditPart = 'wall' | 'opening' | 'floor' | 'roof' | 'cutout' | 'breach'

/**
 * One change: `geometry` (its shape changed, or it appeared), `state` (a door, window or hatch
 * opened, shut, locked, or changed `movement`), or `removed`.
 */
export interface StructureEdit {
  entity: Entity
  part: EditPart
  kind: 'geometry' | 'state' | 'removed'
}

/** Where a consumer has read the edit log to. */
export interface EditCursor {
  at: number
}

/** A wall's shape from its component, standing on `base` (its level's elevation). */
export function wallShape(
  value: {
    a: number[]
    b: number[]
    height: number
    thickness: number
    elevation: number
    shape: 'straight' | 'arc' | 'bezier'
    bow: number
    c0: number[]
    c1: number[]
  },
  base: number,
  tolerance: number,
): WallShape {
  return {
    ax: value.a[0]!,
    az: value.a[1]!,
    bx: value.b[0]!,
    bz: value.b[1]!,
    height: value.height,
    thickness: value.thickness,
    elevation: base + value.elevation,
    line: sampleWall(value, tolerance),
  }
}

/**
 * Whether a curved wall can be built (0066): an arc tighter than half its thickness can't; a
 * Bézier that folds still builds as sampled.
 */
export function curveDrawable(value: { shape: string; thickness: number }, s: WallShape): boolean {
  return s.line.radius >= value.thickness / 2 || value.shape !== 'arc'
}

export interface CutoutVerdict {
  entity: Entity
  /** null: accepted. */
  problem: null | 'structure/cutout-outside' | 'structure/cutout-overlap'
  /** The accepted cutout it overlaps. */
  other?: Entity
}

/**
 * Which of a host's cutouts it takes (0067): each must lie inside `outline` and clear of those
 * accepted before it. Those in `previous` (the last accepted order) go first, so a new cutout that
 * overlaps an old one is the one skipped; then the rest by entity. Outlines under 3 points are
 * left out of the result.
 */
export function acceptCutouts(
  ids: Entity[],
  previous: readonly Entity[],
  outline: Float64Array,
  pointsOf: (e: Entity) => Float64Array,
): CutoutVerdict[] {
  const rank = (c: Entity) => {
    const i = previous.indexOf(c)
    return i < 0 ? previous.length : i
  }
  ids.sort((a, b) => rank(a) - rank(b) || a - b)
  const accepted: Entity[] = []
  const out: CutoutVerdict[] = []
  for (const c of ids) {
    const points = pointsOf(c)
    if (points.length < 6) continue
    if (!ringInside(points, outline)) {
      out.push({ entity: c, problem: 'structure/cutout-outside' })
      continue
    }
    const clash = accepted.find((a) => ringsOverlap(points, pointsOf(a)))
    if (clash !== undefined) {
      out.push({ entity: c, problem: 'structure/cutout-overlap', other: clash })
      continue
    }
    accepted.push(c)
    out.push({ entity: c, problem: null })
  }
  return out
}

/** The model: records by entity, and the edit log since the slowest consumer. */
export class StructureModelState {
  readonly walls = new Map<Entity, WallModel>()
  readonly openings = new Map<Entity, OpeningModel>()
  readonly slabs = new Map<Entity, SlabModel>()
  readonly cutouts = new Map<Entity, CutoutModel>()
  /** Breachable spans (0114), and them by wall. */
  readonly breaches = new Map<Entity, BreachModel>()
  readonly breachesByWall = new Map<Entity, Set<Entity>>()
  /** Openings by host wall, and cutouts by host floor or roof (hosts may not exist yet). */
  readonly byWall = new Map<Entity, Set<Entity>>()
  readonly byHost = new Map<Entity, Set<Entity>>()
  readonly levels = new Map<Entity, number>()
  /** Entries from `offset` on; cursors index absolutely. */
  readonly log: StructureEdit[] = []
  offset = 0
  readonly cursors = new Set<EditCursor>()
  /** The tick of the last sync: changes after it are new. */
  seen = 0
  curveTolerance = Number.NaN
  syncs = 0
  /** What the last sync that changed something logged, and how long it took. */
  last = { edits: 0, ms: 0 }
  readonly removed: { entity: Entity; part: EditPart | 'level' }[] = []
  /** Entities that gained or lost structure/Backdrop since the last sync. */
  readonly backdrops: Entity[] = []
  /** Sections other structure plugins add to `structure.describe` (render, colliders). */
  readonly sections: (() => Record<string, unknown>)[] = []
  readonly world: World

  constructor(world: World) {
    this.world = world
  }

  /** A new consumer, reading from the next edit on. */
  cursor(): EditCursor {
    const c = { at: this.offset + this.log.length }
    this.cursors.add(c)
    return c
  }

  /** Calls `visit` with each edit past `cursor`, in order, and moves it to the end. */
  read(cursor: EditCursor, visit: (edit: StructureEdit) => void): void {
    const end = this.offset + this.log.length
    for (let i = Math.max(cursor.at, this.offset); i < end; i++) visit(this.log[i - this.offset]!)
    cursor.at = end
  }

  /** Drops entries every cursor has read. */
  compact(): void {
    if (this.log.length === 0) return
    let min = this.offset + this.log.length
    for (const c of this.cursors) if (c.at < min) min = c.at
    const drop = min - this.offset
    if (drop > 0) {
      this.log.splice(0, drop)
      this.offset = min
    }
  }

  /** Whether a piece blocks: no structure/Backdrop on it or on its level. */
  solidOf(entity: Entity, level: Entity | null): boolean {
    const world = this.world
    if (world.has(entity, Backdrop)) return false
    return level === null || !world.isAlive(level) || !world.has(level, Backdrop)
  }

  /** Whether an edit's piece is solid: its own record's, or its host's for openings and cutouts. */
  isSolid(entity: Entity, part: EditPart): boolean {
    if (part === 'wall') return this.walls.get(entity)?.solid ?? true
    if (part === 'floor' || part === 'roof') return this.slabs.get(entity)?.solid ?? true
    if (part === 'opening') {
      const o = this.openings.get(entity)
      return o ? (this.walls.get(o.wall)?.solid ?? true) : true
    }
    if (part === 'breach') {
      const b = this.breaches.get(entity)
      return b ? (this.walls.get(b.wall)?.solid ?? true) : true
    }
    const c = this.cutouts.get(entity)
    return c ? (this.slabs.get(c.host)?.solid ?? true) : true
  }

  /** Where a piece on `level` stands: its Level's elevation, or 0. */
  baseOf(level: Entity | null): number {
    const world = this.world
    if (level === null || !world.isAlive(level)) return 0
    return world.tryGet(level, Level)?.elevation ?? 0
  }

  describe() {
    let floors = 0
    for (const s of this.slabs.values()) if (s.kind === 'floor') floors++
    return {
      walls: this.walls.size,
      openings: this.openings.size,
      floors,
      roofs: this.slabs.size - floors,
      cutouts: this.cutouts.size,
      breaches: this.breaches.size,
      levels: this.levels.size,
      syncs: this.syncs,
      log: this.log.length,
      lastSync: this.last,
    }
  }
}

export const StructureModel = defineResource<StructureModelState>('structure/Model', {
  description:
    'The structure model (0112): every wall, opening, floor, roof and cutout as geometry, with no render code, and the edit log colliders and nav read.',
})

function hostSet(map: Map<Entity, Set<Entity>>, host: Entity): Set<Entity> {
  let set = map.get(host)
  if (!set) {
    set = new Set()
    map.set(host, set)
  }
  return set
}

/** Edits gathered during one sync, logged in entity order at its end. */
interface Batch {
  geometry: Map<Entity, EditPart>
  state: Map<Entity, EditPart>
  removed: Map<Entity, EditPart>
  walls: Set<Entity>
  slabs: Set<Entity>
}

const shapes: OpeningShape[] = []

function evaluateWall(model: StructureModelState, entity: Entity, batch: Batch): void {
  const world = model.world
  const v = world.tryGet(entity, Wall)
  if (!v) return
  const level = (v.level ?? null) as Entity | null
  const base = model.baseOf(level)
  const shape = wallShape(v, base, model.curveTolerance)
  const ids = [...(model.byWall.get(entity) ?? [])].filter((o) => model.openings.has(o))
  ids.sort((p, q) => model.openings.get(p)!.offset - model.openings.get(q)!.offset || p - q)
  const solid = model.solidOf(entity, level)
  let signature = `${v.a}|${v.b}|${v.height}|${v.thickness}|${v.elevation}|${v.shape}|${v.bow}|${v.c0}|${v.c1}|${base}|${model.curveTolerance}|${level}|${solid}`
  for (const o of ids) {
    const r = model.openings.get(o)!
    signature += `|${o}:${r.kind}:${r.offset}:${r.width}:${r.height}:${r.sill}`
  }
  const old = model.walls.get(entity)
  if (old && old.signature === signature) return
  const drawable = curveDrawable(v, shape)
  const rec: WallModel = old ?? {
    shape,
    pieces: [],
    count: 0,
    openings: [],
    gaps: [],
    level,
    solid,
    signature: '',
  }
  rec.shape = shape
  rec.level = level
  rec.solid = solid
  rec.signature = signature
  rec.openings = ids
  shapes.length = 0
  for (const o of ids) {
    const r = model.openings.get(o)!
    // No frames: they stand off the face and block nothing.
    shapes.push({
      kind: r.kind,
      offset: r.offset,
      width: r.width,
      height: r.height,
      sill: r.sill,
      frameWidth: 0,
      frameDepth: 0,
    })
  }
  rec.count = drawable ? wallPieces(shape, shapes, rec.pieces, rec.gaps) : 0
  if (!drawable) rec.gaps.fill(Number.NaN)
  model.walls.set(entity, rec)
  batch.geometry.set(entity, 'wall')
  for (const o of ids) batch.geometry.set(o, 'opening')
}

function evaluateSlab(model: StructureModelState, entity: Entity, batch: Batch): void {
  const world = model.world
  const floor = world.tryGet(entity, Floor)
  const roof = floor ? undefined : world.tryGet(entity, Roof)
  const value = floor ?? roof
  const part: EditPart = roof ? 'roof' : 'floor'
  const old = model.slabs.get(entity)
  if (!value || value.points.length < 3) {
    if (old) {
      model.slabs.delete(entity)
      batch.removed.set(entity, old.kind)
      for (const c of old.cutouts) batch.geometry.set(c, 'cutout')
    }
    return
  }
  const level = (value.level ?? null) as Entity | null
  const base = model.baseOf(level)
  const outline = new Float64Array(value.points.length * 2)
  for (let i = 0; i < value.points.length; i++) {
    outline[i * 2] = value.points[i]![0]!
    outline[i * 2 + 1] = value.points[i]![1]!
  }
  const ids = [...(model.byHost.get(entity) ?? [])].filter((c) => model.cutouts.has(c))
  const verdicts = acceptCutouts(
    ids,
    old?.cutouts ?? [],
    outline,
    (c) => model.cutouts.get(c)!.points,
  )
  const accepted: Entity[] = []
  const holes: number[][][] = []
  for (const c of ids) model.cutouts.get(c)!.ring = -1
  for (const v of verdicts) {
    if (v.problem !== null) continue
    const cut = model.cutouts.get(v.entity)!
    accepted.push(v.entity)
    cut.ring = accepted.length
    const ring: number[][] = []
    for (let i = 0; i < cut.points.length; i += 2) ring.push([cut.points[i]!, cut.points[i + 1]!])
    holes.push(ring)
  }
  const solid = model.solidOf(entity, level)
  let signature = roof
    ? `roof|${outline}|${base + roof.height}|${roof.thickness}|${roof.pitch}|${roof.ridge}|${level}|${solid}`
    : `floor|${outline}|${base + floor!.elevation}|${floor!.thickness}|${level}|${solid}`
  for (const c of accepted) signature += `|${c}:${model.cutouts.get(c)!.points}`
  if (old && old.signature === signature && old.kind === part) return
  const shape = floorShape(
    value.points,
    roof ? base + roof.height : base + floor!.elevation,
    roof
      ? { holes, thickness: roof.thickness, pitch: roof.pitch, ridge: roof.ridge }
      : { holes, thickness: floor!.thickness },
  )
  model.slabs.set(entity, {
    kind: part as 'floor' | 'roof',
    shape,
    cutouts: accepted,
    level,
    solid,
    signature,
  })
  batch.geometry.set(entity, part)
  for (const c of ids) batch.geometry.set(c, 'cutout')
  for (const c of old?.cutouts ?? []) batch.geometry.set(c, 'cutout')
}

function readOpening(model: StructureModelState, entity: Entity, batch: Batch): void {
  const v = model.world.get(entity, Opening)
  const wall = (v.wall ?? -1) as Entity
  const rec = model.openings.get(entity)
  if (!rec) {
    model.openings.set(entity, {
      wall,
      kind: v.kind,
      offset: v.offset,
      width: v.width,
      height: v.height,
      sill: v.sill,
      state: v.state,
      movement: v.movement,
      barricaded: v.barricaded,
    })
    hostSet(model.byWall, wall).add(entity)
    batch.walls.add(wall)
    batch.geometry.set(entity, 'opening')
    return
  }
  const geometry =
    rec.wall !== wall ||
    rec.kind !== v.kind ||
    rec.offset !== v.offset ||
    rec.width !== v.width ||
    rec.height !== v.height ||
    rec.sill !== v.sill
  if (geometry) {
    batch.walls.add(rec.wall)
    if (rec.wall !== wall) {
      model.byWall.get(rec.wall)?.delete(entity)
      hostSet(model.byWall, wall).add(entity)
      batch.walls.add(wall)
    }
    batch.geometry.set(entity, 'opening')
  } else if (
    rec.state !== v.state ||
    rec.movement !== v.movement ||
    rec.barricaded !== v.barricaded
  ) {
    batch.state.set(entity, 'opening')
  }
  rec.wall = wall
  rec.kind = v.kind
  rec.offset = v.offset
  rec.width = v.width
  rec.height = v.height
  rec.sill = v.sill
  rec.state = v.state
  rec.movement = v.movement
  rec.barricaded = v.barricaded
}

/** A Breach added or changed (0114): its own edit, or its wall's when it's on the wall. */
function readBreach(model: StructureModelState, entity: Entity, batch: Batch): void {
  const v = model.world.get(entity, Breach)
  const wall = (v.wall ?? entity) as Entity
  const rec = model.breaches.get(entity)
  if (rec && rec.wall === wall && rec.offset === v.offset && rec.width === v.width) return
  if (rec && rec.wall !== wall) model.breachesByWall.get(rec.wall)?.delete(entity)
  hostSet(model.breachesByWall, wall).add(entity)
  model.breaches.set(entity, { wall, offset: v.offset, width: v.width })
  batch.geometry.set(entity, model.walls.has(entity) ? 'wall' : 'breach')
}

function readCutout(model: StructureModelState, entity: Entity, batch: Batch): void {
  const v = model.world.get(entity, Cutout)
  const host = (v.host ?? -1) as Entity
  const points = new Float64Array(v.points.length * 2)
  for (let i = 0; i < v.points.length; i++) {
    points[i * 2] = v.points[i]![0]!
    points[i * 2 + 1] = v.points[i]![1]!
  }
  const rec = model.cutouts.get(entity)
  if (!rec) {
    model.cutouts.set(entity, { host, kind: v.kind, points, state: v.state, ring: -1 })
    hostSet(model.byHost, host).add(entity)
    batch.slabs.add(host)
    batch.geometry.set(entity, 'cutout')
    return
  }
  let same = rec.points.length === points.length
  for (let i = 0; same && i < points.length; i++) same = rec.points[i] === points[i]
  if (rec.host !== host || rec.kind !== v.kind || !same) {
    batch.slabs.add(rec.host)
    if (rec.host !== host) {
      model.byHost.get(rec.host)?.delete(entity)
      hostSet(model.byHost, host).add(entity)
      batch.slabs.add(host)
    }
    batch.geometry.set(entity, 'cutout')
  } else if (rec.state !== v.state) {
    batch.state.set(entity, 'cutout')
  }
  rec.host = host
  rec.kind = v.kind
  rec.points = points
  rec.state = v.state
}

function changed(q: Query, def: ComponentDef, since: number): boolean {
  for (let t = 0; t < q.tables.length; t++) if (q.tables[t]!.lastChanged(def) > since) return true
  return false
}

function forEachChanged(q: Query, def: ComponentDef, since: number, visit: (e: Entity) => void) {
  for (const t of q.tables) {
    if (t.lastChanged(def) <= since) continue
    const ticks = t.changedTicks(def)
    for (let row = 0; row < t.count; row++)
      if (ticks[row]! > since) visit(t.entities[row]! as Entity)
  }
}

/**
 * Brings the model up to date with everything changed since its last sync, and logs the edits.
 * Runs in FixedUpdate (before physics) and PostUpdate; the second run of a frame usually finds
 * nothing. Allocates nothing when nothing changed.
 */
export function syncModel(
  world: World,
  queries: ReturnType<typeof modelQueries>,
  thisTick: number,
): void {
  const model = world.resource(StructureModel)
  const since = model.seen
  model.seen = thisTick
  const { walls, floors, roofs, openings, cutouts, levels, breaches } = queries
  const tolerance = world.resource(StructureSettings).curveTolerance
  const any =
    model.removed.length > 0 ||
    model.backdrops.length > 0 ||
    tolerance !== model.curveTolerance ||
    changed(walls, Wall, since) ||
    changed(floors, Floor, since) ||
    changed(roofs, Roof, since) ||
    changed(openings, Opening, since) ||
    changed(cutouts, Cutout, since) ||
    changed(levels, Level, since) ||
    changed(breaches, Breach, since)
  if (!any) return
  const start = performance.now()
  const batch: Batch = {
    geometry: new Map(),
    state: new Map(),
    removed: new Map(),
    walls: new Set(),
    slabs: new Set(),
  }
  if (tolerance !== model.curveTolerance) {
    model.curveTolerance = tolerance
    for (const e of model.walls.keys()) batch.walls.add(e)
  }
  for (const { entity, part } of model.removed) {
    if (part === 'opening') {
      const rec = model.openings.get(entity)
      if (!rec) continue
      model.byWall.get(rec.wall)?.delete(entity)
      model.openings.delete(entity)
      batch.walls.add(rec.wall)
      batch.removed.set(entity, part)
    } else if (part === 'cutout') {
      const rec = model.cutouts.get(entity)
      if (!rec) continue
      model.byHost.get(rec.host)?.delete(entity)
      model.cutouts.delete(entity)
      batch.slabs.add(rec.host)
      batch.removed.set(entity, part)
    } else if (part === 'wall') {
      const rec = model.walls.get(entity)
      if (!rec) continue
      model.walls.delete(entity)
      batch.removed.set(entity, part)
      // Its openings lose their hole.
      for (const o of rec.openings) if (model.openings.has(o)) batch.geometry.set(o, 'opening')
    } else if (part === 'breach') {
      const rec = model.breaches.get(entity)
      if (!rec) continue
      model.breaches.delete(entity)
      model.breachesByWall.get(rec.wall)?.delete(entity)
      // On a wall that stays, it's that wall's edit: its span closes again for nav.
      if (model.walls.has(entity) && world.isAlive(entity) && world.has(entity, Wall))
        batch.geometry.set(entity, 'wall')
      else batch.removed.set(entity, part)
    } else if (part === 'floor' || part === 'roof') {
      const rec = model.slabs.get(entity)
      if (!rec) continue
      model.slabs.delete(entity)
      batch.removed.set(entity, rec.kind)
      for (const c of rec.cutouts) if (model.cutouts.has(c)) batch.geometry.set(c, 'cutout')
    } else {
      model.levels.delete(entity)
      dirtyLevel(model, entity, batch)
    }
  }
  model.removed.length = 0
  // A backdrop turned on or off: the piece, or every piece on the level, is evaluated again.
  for (const e of model.backdrops) {
    if (model.walls.has(e)) batch.walls.add(e)
    if (model.slabs.has(e)) batch.slabs.add(e)
    dirtyLevel(model, e, batch)
  }
  model.backdrops.length = 0
  forEachChanged(levels, Level, since, (e) => {
    const elevation = world.get(e, Level).elevation
    if (model.levels.get(e) === elevation) return
    model.levels.set(e, elevation)
    dirtyLevel(model, e, batch)
  })
  forEachChanged(openings, Opening, since, (e) => readOpening(model, e, batch))
  forEachChanged(cutouts, Cutout, since, (e) => readCutout(model, e, batch))
  forEachChanged(walls, Wall, since, (e) => batch.walls.add(e))
  forEachChanged(floors, Floor, since, (e) => batch.slabs.add(e))
  forEachChanged(roofs, Roof, since, (e) => batch.slabs.add(e))
  for (const e of batch.walls)
    if (world.isAlive(e) && world.has(e, Wall)) evaluateWall(model, e, batch)
  for (const e of batch.slabs)
    if (world.isAlive(e) && (world.has(e, Floor) || world.has(e, Roof)))
      evaluateSlab(model, e, batch)
  // After walls, so a Breach on a new wall's own entity is that wall's edit.
  forEachChanged(breaches, Breach, since, (e) => readBreach(model, e, batch))
  // In entity order, so consumers build in the same order on every run.
  let edits = 0
  const append = (map: Map<Entity, EditPart>, kind: StructureEdit['kind']) => {
    for (const entity of [...map.keys()].sort((a, b) => a - b)) {
      model.log.push({ entity, part: map.get(entity)!, kind })
      edits++
    }
  }
  for (const e of batch.removed.keys()) {
    batch.geometry.delete(e)
    batch.state.delete(e)
  }
  for (const e of batch.geometry.keys()) batch.state.delete(e)
  append(batch.removed, 'removed')
  append(batch.geometry, 'geometry')
  append(batch.state, 'state')
  if (model.cursors.size === 0) {
    model.offset += model.log.length
    model.log.length = 0
  }
  if (edits > 0) {
    model.syncs++
    model.last = { edits, ms: performance.now() - start }
  }
}

/**
 * Every wall and slab naming `level` moves (it moved, appeared or went away). Records keep the
 * entity they name even while it isn't a Level, so pieces that stood on the ground level move too.
 */
function dirtyLevel(model: StructureModelState, level: Entity, batch: Batch): void {
  for (const [e, rec] of model.walls) if (rec.level === level) batch.walls.add(e)
  for (const [e, rec] of model.slabs) if (rec.level === level) batch.slabs.add(e)
}

function modelQueries(world: World) {
  return {
    walls: world.query({ with: [Wall] }),
    floors: world.query({ with: [Floor] }),
    roofs: world.query({ with: [Roof] }),
    openings: world.query({ with: [Opening] }),
    cutouts: world.query({ with: [Cutout] }),
    levels: world.query({ with: [Level] }),
    breaches: world.query({ with: [Breach] }),
  }
}

/** The model's sync before physics, so an edit made in Update is solid in this step. */
export const syncStructureFixed = defineSystem({
  name: 'structure/sync-fixed',
  description: 'Brings the structure model up to date before physics steps (0112).',
  setup: modelQueries,
  run: (q, world, ctx) => syncModel(world, q, ctx.thisRunTick),
})

/** The model's sync in PostUpdate, before structure compile draws. */
export const syncStructure = defineSystem({
  name: 'structure/sync',
  description:
    'Brings the structure model up to date with changed walls, openings, floors, roofs, cutouts and levels, and logs the edits (0112).',
  setup: modelQueries,
  run: (q, world, ctx) => syncModel(world, q, ctx.thisRunTick),
})

export const structureMethods: AppMethod[] = [
  {
    name: 'structure.describe',
    description:
      'Structure: wall, opening, floor, roof, cutout, level and chunk counts, the groups (ground, levels, roofs: their chunks, meshes and whether hidden), the chunk grid, pieces per chunk, the last compile (its dirty chunks and time), the model (0112) and colliders.',
    params: defineSchema('structure/DescribeParams', {}),
    handler: ({ world }) => {
      const model = world.resource(StructureModel)
      const out: Record<string, unknown> = { model: model.describe() }
      for (const section of model.sections) Object.assign(out, section())
      return out
    },
  },
]

/**
 * The structure model (0112): walls, openings, floors, roofs, cutouts and levels as geometry, kept
 * current by `structure/sync` with no render code. `structurePlugin` (meshes) and
 * `structurePhysicsPlugin` (colliders) add it when it's missing.
 */
export const structureModelPlugin: Plugin = definePlugin({
  name: 'structure/model',
  dependencies: ['core/transform'],
  provides: [Wall, Opening, Floor, Level, Roof, Cutout, Backdrop, Breach, StructureSettings],
  build(app) {
    const world = app.world
    world.initResource(StructureSettings)
    const model = new StructureModelState(world)
    world.insertResource(StructureModel, model)
    const removed =
      (part: EditPart) =>
      ({ entity }: { entity: Entity }) => {
        model.removed.push({ entity, part })
      }
    world.observe(onRemove(Wall), removed('wall'))
    world.observe(onRemove(Floor), removed('floor'))
    world.observe(onRemove(Roof), removed('roof'))
    world.observe(onRemove(Opening), removed('opening'))
    world.observe(onRemove(Cutout), removed('cutout'))
    world.observe(onRemove(Breach), removed('breach'))
    const backdrop = ({ entity }: { entity: Entity }) => {
      model.backdrops.push(entity)
    }
    world.observe(onAdd(Backdrop), backdrop)
    world.observe(onRemove(Backdrop), backdrop)
    world.observe(onRemove(Level), ({ entity }) => {
      model.removed.push({ entity, part: 'level' })
    })
    app.addSystems(FixedUpdate, syncStructureFixed)
    app.addSystems(PostUpdate, syncStructure.before(TransformSystems))
    app.addMethod(...structureMethods)
  },
})
