import {
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  Last,
  onRemove,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  extractLights,
  INTERIOR_GROUND,
  INTERIOR_LEVELS,
  type InteriorLighting,
  InteriorLightingResource,
  type LightStore,
  Lights,
  PointLight,
  RenderSet,
  SpotLight,
  setLightRow,
} from '@aethervtt/shard-render'
import { type AppMethod, definePlugin, LogResource } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Structure, type StructureState } from './compile'
import {
  Cutout,
  defaultInterior,
  Floor,
  type InteriorSettings,
  Level,
  Opening,
  Roof,
  StructureSettings,
  Wall,
} from './components'
import {
  type Barrier,
  type Bounds,
  buildRow,
  type Cover,
  clearRect,
  type FieldGrid,
  FieldLayer,
  packRect,
  RowScratch,
  rasterBarrier,
  rasterCover,
  SolveScratch,
  solveRect,
  type TexelRect,
  texelsOf,
  unpackVisibility,
} from './interior'
import { lightChannel, type PlanarOpening, planarBarriers } from './planar'

// Interior lighting (0069), the ECS half: reads structure's compiled walls, openings, floors,
// roofs and cutouts, keeps each one's barriers and cover, and turns an edit into the regions of
// the field and the light rows it touches. Render's interiorPlugin binds what this writes.

/** Per quality: field texel (m), bins per light row, filter taps, coarse cells (texels in ~1 m). */
export const INTERIOR_QUALITY = {
  low: { texel: 0.5, bins: 256, taps: 1, cells: 2 },
  medium: { texel: 0.25, bins: 512, taps: 3, cells: 4 },
  high: { texel: 0.125, bins: 1024, taps: 5, cells: 8 },
} as const

/** Wall index cells (m): rows and region rasters look up walls near them through it. */
const CELL = 4

interface WallCache {
  layer: number
  bounds: Bounds
  barriers: Barrier[]
  signature: string
  /** Index cells it's in (layer-qualified keys). */
  cells: number[]
}

interface SlabCache {
  /** Layers it covers: a roof its own level's; a floor every lower level's. */
  layers: number[]
  bounds: Bounds
  cover: Cover
  signature: string
}

interface LightCache {
  row: number
  x: number
  y: number
  z: number
  range: number
  layer: number
  /** The frame it was last seen, and the frame its row was last built. */
  frame: number
  rebuilt: number
}

interface LevelEntry {
  entity: Entity
  elevation: number
  height: number
  ambient: [number, number, number]
  fill: number
}

/** The last field solve (structure.describe → interior.lastSolve). */
export interface InteriorSolveReport {
  /** Whole-field solve (bounds grew, quality or reach changed), or a region after an edit. */
  full: boolean
  /** Regions re-solved: layer, and [minX, minZ, maxX, maxZ] in metres. */
  regions: { layer: number; bounds: [number, number, number, number] }[]
  texels: number
  sweeps: number
  /** Texels uploaded. */
  uploaded: number
  ms: number
}

/** What the plugin keeps: the field, every piece's barriers and cover, and the blocked lights. */
export class InteriorState {
  settings: InteriorSettings = defaultInterior()
  /** The `StructureSettings.interior` object last merged (a patch replaces it). */
  seen: object | undefined
  /** Settings the field and rows were last built with. */
  builtTexel = 0
  builtReach = 0
  builtBins = 0
  curveTolerance = -1
  grid: FieldGrid | undefined
  layers: FieldLayer[] = []
  levels: LevelEntry[] = []
  /** Layer of each Level entity (1 + its rank by elevation); the ground level is layer 0. */
  readonly levelLayer = new Map<Entity, number>()
  readonly walls = new Map<Entity, WallCache>()
  readonly slabs = new Map<Entity, SlabCache>()
  /** Openings' and cutouts' hosts as last seen, so an edit that moves one dirties both. */
  readonly openingWall = new Map<Entity, Entity>()
  readonly cutoutHost = new Map<Entity, Entity>()
  readonly cells = new Map<number, Set<Entity>>()
  readonly lights = new Map<Entity, LightCache>()
  /** Rows not given to a light, lowest last (`pop` hands out the lowest). */
  freeRows: number[] = []
  rowCount = 0
  rowData = new Uint32Array(0)
  /** Per layer, regions to rasterize and solve again. */
  dirty: TexelRect[][] = []
  readonly dirtyRows = new Set<Entity>()
  /** The field (and every row) is built from scratch next. */
  full = true
  /** Lights over maxBlockedLights were reported. */
  warnedRows = false
  warnedLevels = false
  last: InteriorSolveReport | null = null
  lastRows = { lights: 0, ms: 0 }
  frame = 0
  seenLights = 0
  readonly removedWalls: Entity[] = []
  readonly removedSlabs: Entity[] = []
  readonly removedOpenings: Entity[] = []
  readonly removedCutouts: Entity[] = []
  /** Point and spot lights whose component went (despawns included): their rows free first. */
  readonly removedLights: Entity[] = []
  levelsDirty = true
  /** Field regions and rows to upload this frame (unless the texture is new, and gets it all). */
  readonly uploads: { layer: number; rect: TexelRect }[] = []
  readonly rowUploads = new Set<number>()
  readonly scratch = new SolveScratch()
  readonly rowScratch = new RowScratch()
  readonly candidates: Barrier[] = []
  readonly stamp = new Map<Entity, number>()

  /** The layer pieces on `group` (a Level, or the ground level's group) draw into; -1 for none. */
  layerOfGroup(structure: StructureState, group: Entity): number {
    if (group === structure.ground) return 0
    return this.levelLayer.get(group) ?? -1
  }

  /** The table entry (and so layer) whose [floor, top) holds y: the shader's rule. */
  layerAtY(y: number): number {
    const n = Math.min(this.levels.length, INTERIOR_LEVELS)
    for (let i = 0; i < n; i++) {
      const l = this.levels[i]!
      if (y >= l.elevation && y < l.elevation + l.height) return i + 1
    }
    return 0
  }

  /** The field's value at a point: 1 outdoors, as the lighting stage reads it (without the normal offset). */
  skyAt(x: number, y: number, z: number): number {
    const g = this.grid
    if (!g) return 1
    const layer = this.layers[this.layerAtY(y)]
    if (!layer) return 1
    const i = Math.floor((x - g.ox) / g.texel)
    const j = Math.floor((z - g.oz) / g.texel)
    if (i < 0 || j < 0 || i >= g.width || j >= g.height) return 1
    const k = j * g.width + i
    const cover = layer.cover[k]!
    if (cover === Number.POSITIVE_INFINITY || y >= layer.base + cover) return 1
    return unpackVisibility(layer.packed[k]!)
  }

  describe(lighting: InteriorLighting | undefined) {
    const g = this.grid
    const lights: { light: Entity; row: number; lastRebuild: number }[] = []
    for (const [light, c] of this.lights) lights.push({ light, row: c.row, lastRebuild: c.rebuilt })
    lights.sort((a, b) => a.light - b.light)
    return {
      settings: { ...this.settings },
      sky: lighting?.sky ?? false,
      blockLights: lighting?.blocked ?? false,
      field: g
        ? {
            extent: [g.ox, g.oz, g.ox + g.width * g.texel, g.oz + g.height * g.texel],
            texel: g.texel,
            size: [g.width, g.height],
            layers: this.layers.length,
          }
        : null,
      levels: this.levels.map((l, i) => ({
        level: l.entity,
        layer: i < INTERIOR_LEVELS ? i + 1 : -1,
        elevation: l.elevation,
        height: l.height,
      })),
      lastSolve: this.last,
      lastRows: this.lastRows,
      blockedLights: lights,
      rows: { used: lights.filter((l) => l.row >= 0).length, capacity: this.rowCount },
      bytes: lighting?.bytes ?? 0,
    }
  }
}

export const Interior = defineResource<InteriorState>('structure/Interior', {
  description:
    "Interior lighting (0069): the sky visibility field per level, each piece's barriers and cover, and the wall-blocked lights' rows.",
})

const boundsOf = (b: Barrier[], grow: number): Bounds => {
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const s of b) {
    minX = Math.min(minX, s.ax, s.bx)
    minZ = Math.min(minZ, s.az, s.bz)
    maxX = Math.max(maxX, s.ax, s.bx)
    maxZ = Math.max(maxZ, s.az, s.bz)
  }
  return { minX: minX - grow, minZ: minZ - grow, maxX: maxX + grow, maxZ: maxZ + grow }
}

const cellKey = (layer: number, cx: number, cz: number) =>
  (layer + 1) * 4294967296 + (cx + 32768) * 65536 + (cz + 32768)

/** Merges a patched `StructureSettings.interior` over the values before. */
function mergeSettings(state: InteriorState, settings: { interior: InteriorSettings }): void {
  let s = settings.interior
  if (s === state.seen) return
  s = { ...state.settings, ...s }
  settings.interior = s
  state.seen = s
  state.settings = s
}

/** Reads every Level: their order by elevation gives their layers. Returns whether layers moved. */
function readLevels(world: World, state: InteriorState): boolean {
  const out: LevelEntry[] = []
  world.query({ with: [Level] }).each((entity, row, table) => {
    const a = table.column(Level, 'interiorAmbient')
    out.push({
      entity,
      elevation: table.column(Level, 'elevation')[row]!,
      height: table.column(Level, 'height')[row]!,
      ambient: [a[row * 3]!, a[row * 3 + 1]!, a[row * 3 + 2]!],
      fill: table.column(Level, 'interiorFill')[row]!,
    })
  })
  out.sort((a, b) => a.elevation - b.elevation || a.entity - b.entity)
  let moved = out.length !== state.levels.length
  for (let i = 0; !moved && i < out.length; i++) {
    const a = out[i]!
    const b = state.levels[i]!
    moved = a.entity !== b.entity || a.elevation !== b.elevation || a.height !== b.height
  }
  state.levels = out
  state.levelLayer.clear()
  for (let i = 0; i < out.length; i++)
    if (i < INTERIOR_LEVELS) state.levelLayer.set(out[i]!.entity, i + 1)
  if (out.length > INTERIOR_LEVELS && !state.warnedLevels) {
    state.warnedLevels = true
    world
      .tryResource(LogResource)
      ?.log(
        'warn',
        `${out.length} levels, but interior lighting has a field for ${INTERIOR_LEVELS}: the highest are lit as if outdoors`,
        {
          code: 'structure/too-many-levels',
          hint: `Interior lighting keeps ${INTERIOR_LEVELS} levels' fields (by elevation).`,
        },
      )
  }
  return moved
}

/** A wall's barriers as planarBarriers splits it, with heights for the rows. */
function wallBarriers(
  world: World,
  structure: StructureState,
  state: InteriorState,
  entity: Entity,
): WallCache | undefined {
  const rec = structure.walls.get(entity)
  const value = world.isAlive(entity) ? world.tryGet(entity, Wall) : undefined
  if (!rec || !value) return undefined
  const layer = state.layerOfGroup(structure, rec.group)
  if (layer < 0) return undefined
  const openings: PlanarOpening[] = []
  const sills = new Map<string, number>()
  for (const o of structure.byWall.get(entity) ?? []) {
    const v = world.isAlive(o) ? world.tryGet(o, Opening) : undefined
    if (!v || !structure.openings.has(o)) continue
    const id = String(o)
    sills.set(id, v.sill)
    openings.push({
      id,
      wall: 'w',
      kind: v.kind,
      offset: v.offset,
      width: v.width,
      state: v.state,
      sight: v.sight,
      movement: v.movement,
      light: v.light,
    })
  }
  const segments = planarBarriers(
    [
      {
        id: 'w',
        a: value.a as [number, number],
        b: value.b as [number, number],
        shape: value.shape,
        bow: value.bow,
        c0: value.c0 as [number, number],
        c1: value.c1 as [number, number],
        light: value.light,
      },
    ],
    openings,
    { tolerance: structure.curveTolerance },
  )
  const s = rec.shape
  const top = s.elevation + s.height
  const barriers: Barrier[] = []
  for (const seg of segments) {
    const field = lightChannel(seg) === 'normal'
    let height = top
    if (!field) {
      // A gap for the field: a window still blocks wall-blocked lights below its sill.
      const sill = seg.openingId !== undefined ? (sills.get(seg.openingId) ?? 0) : 0
      if (sill <= 1e-3) continue
      height = Math.min(top, s.elevation + sill)
    }
    barriers.push({
      ax: seg.a[0],
      az: seg.a[1],
      bx: seg.b[0],
      bz: seg.b[1],
      top: height,
      thickness: s.thickness,
      field,
    })
  }
  let signature = `${layer}`
  for (const b of barriers)
    signature += `|${b.ax},${b.az},${b.bx},${b.bz},${b.top},${b.thickness},${b.field}`
  return { layer, bounds: boundsOf(barriers, s.thickness), barriers, signature, cells: [] }
}

/** A floor's or roof's cover: the layers it stands over, its outline and its closed hatches. */
function slabCover(
  structure: StructureState,
  state: InteriorState,
  entity: Entity,
): SlabCache | undefined {
  const rec = structure.slabs.get(entity)
  if (!rec) return undefined
  const levelGroup = structure.groupOf(rec.level)
  const layers: number[] = []
  if (rec.kind === 'roof') {
    const l = state.layerOfGroup(structure, levelGroup)
    if (l >= 0) layers.push(l)
  } else {
    // A floor covers every level below it: the ground level, and levels lower than its own.
    const elevation = structure.baseOf(levelGroup)
    if (levelGroup !== structure.ground) {
      if (elevation > 1e-6) layers.push(0)
      for (let i = 0; i < state.levels.length && i < INTERIOR_LEVELS; i++)
        if (state.levels[i]!.elevation < elevation - 1e-6) layers.push(i + 1)
    }
  }
  if (layers.length === 0) return undefined
  const closed: number[] = []
  for (let i = 0; i < rec.cutouts.length; i++) {
    const c = structure.cutouts.get(rec.cutouts[i]!)
    if (c && c.kind === 'hatch' && c.state !== 'open') closed.push(i + 1)
  }
  const f = rec.shape
  let rings = ''
  for (const r of rec.rings.values()) rings += `;${r}`
  return {
    layers,
    bounds: { minX: f.minX, minZ: f.minZ, maxX: f.maxX, maxZ: f.maxZ },
    cover: { shape: f, closed },
    signature: `${rec.kind}|${layers}|${closed}|${rec.signature}|${rings}`,
  }
}

function indexWall(state: InteriorState, entity: Entity, c: WallCache): void {
  const b = c.bounds
  for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++)
    for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
      const key = cellKey(c.layer, cx, cz)
      let set = state.cells.get(key)
      if (!set) {
        set = new Set()
        state.cells.set(key, set)
      }
      set.add(entity)
      c.cells.push(key)
    }
}

function unindexWall(state: InteriorState, entity: Entity, c: WallCache): void {
  for (const key of c.cells) state.cells.get(key)?.delete(entity)
  c.cells.length = 0
}

/** Marks a region of a layer for a re-solve: `b` grown by twice the spill reach. */
function markRegion(state: InteriorState, layer: number, b: Bounds): void {
  if (!state.grid || state.full) return
  const rect = texelsOf(state.grid, b, 2 * state.settings.spillReach)
  if (rect.x0 >= rect.x1 || rect.z0 >= rect.z1) return
  const list = state.dirty[layer]
  if (!list) return
  // Merge with any it overlaps, until none do.
  let r = rect
  for (let i = 0; i < list.length; ) {
    const o = list[i]!
    if (o.x0 <= r.x1 && r.x0 <= o.x1 && o.z0 <= r.z1 && r.z0 <= o.z1) {
      r = {
        x0: Math.min(o.x0, r.x0),
        z0: Math.min(o.z0, r.z0),
        x1: Math.max(o.x1, r.x1),
        z1: Math.max(o.z1, r.z1),
      }
      list.splice(i, 1)
      i = 0
    } else i++
  }
  list.push(r)
}

/** Lights on `layer` whose range reaches `b`: their rows rebuild. */
function markLightsNear(state: InteriorState, layer: number, b: Bounds): void {
  for (const [entity, c] of state.lights) {
    if (c.layer !== layer) continue
    const dx = Math.max(b.minX - c.x, 0, c.x - b.maxX)
    const dz = Math.max(b.minZ - c.z, 0, c.z - b.maxZ)
    if (dx * dx + dz * dz <= c.range * c.range) state.dirtyRows.add(entity)
  }
}

const barrierKey = (b: Barrier) =>
  `${b.ax},${b.az},${b.bx},${b.bz},${b.top},${b.thickness},${b.field}`

/**
 * What changed between a wall's barriers before and after an edit: the bounds of the barriers in
 * one and not the other. A door toggle changes its opening's span alone.
 */
function changedBounds(old: WallCache, next: WallCache): Bounds | undefined {
  const before = new Set(old.barriers.map(barrierKey))
  const after = new Set(next.barriers.map(barrierKey))
  const diff: Barrier[] = []
  for (const b of old.barriers) if (!after.has(barrierKey(b))) diff.push(b)
  for (const b of next.barriers) if (!before.has(barrierKey(b))) diff.push(b)
  return diff.length > 0 ? boundsOf(diff, 0) : undefined
}

function setWall(state: InteriorState, entity: Entity, next: WallCache | undefined): void {
  const old = state.walls.get(entity)
  if (old && next && old.signature === next.signature) return
  if (old && next && old.layer === next.layer) {
    // The same wall on the same level: only the barriers that changed matter.
    const b = changedBounds(old, next)
    unindexWall(state, entity, old)
    state.walls.set(entity, next)
    indexWall(state, entity, next)
    if (b) {
      const grown = grow(b, next.barriers[0]?.thickness ?? 0)
      markRegion(state, next.layer, grown)
      markLightsNear(state, next.layer, grown)
    }
    return
  }
  if (old) {
    unindexWall(state, entity, old)
    markRegion(state, old.layer, old.bounds)
    markLightsNear(state, old.layer, old.bounds)
    state.walls.delete(entity)
  }
  if (next) {
    state.walls.set(entity, next)
    indexWall(state, entity, next)
    markRegion(state, next.layer, next.bounds)
    markLightsNear(state, next.layer, next.bounds)
  }
}

const grow = (b: Bounds, by: number): Bounds => ({
  minX: b.minX - by,
  minZ: b.minZ - by,
  maxX: b.maxX + by,
  maxZ: b.maxZ + by,
})

function setSlab(state: InteriorState, entity: Entity, next: SlabCache | undefined): void {
  const old = state.slabs.get(entity)
  if (old && next && old.signature === next.signature) return
  if (old) {
    for (const l of old.layers) markRegion(state, l, old.bounds)
    state.slabs.delete(entity)
  }
  if (next) {
    state.slabs.set(entity, next)
    for (const l of next.layers) markRegion(state, l, next.bounds)
  }
}

/** Whether `b` (grown by a margin) fits the field's extent. */
function fits(grid: FieldGrid, b: Bounds): boolean {
  const m = grid.texel * 2
  return (
    b.minX - m >= grid.ox &&
    b.minZ - m >= grid.oz &&
    b.maxX + m <= grid.ox + grid.width * grid.texel &&
    b.maxZ + m <= grid.oz + grid.height * grid.texel
  )
}

/** Everything's bounds: every wall's and every slab's. */
function allBounds(state: InteriorState): Bounds | undefined {
  let b: Bounds | undefined
  const add = (o: Bounds) => {
    b = b
      ? {
          minX: Math.min(b.minX, o.minX),
          minZ: Math.min(b.minZ, o.minZ),
          maxX: Math.max(b.maxX, o.maxX),
          maxZ: Math.max(b.maxZ, o.maxZ),
        }
      : { ...o }
  }
  for (const c of state.walls.values()) add(c.bounds)
  for (const c of state.slabs.values()) add(c.bounds)
  return b
}

/** Rasterizes and solves `rect` of a layer from every piece over it. */
function solveRegion(
  state: InteriorState,
  layer: number,
  rect: TexelRect,
  coarse: boolean,
  cells: number,
): { texels: number; sweeps: number } {
  const grid = state.grid!
  const field = state.layers[layer]!
  clearRect(grid, field, rect)
  const t = grid.texel
  const minX = grid.ox + rect.x0 * t
  const minZ = grid.oz + rect.z0 * t
  const maxX = grid.ox + rect.x1 * t
  const maxZ = grid.oz + rect.z1 * t
  for (const c of state.slabs.values()) {
    if (!c.layers.includes(layer)) continue
    const b = c.bounds
    if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue
    rasterCover(grid, field, c.cover, rect, field.base, state.scratch)
  }
  const frame = ++state.frame
  for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
    for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
      const set = state.cells.get(cellKey(layer, cx, cz))
      if (!set) continue
      for (const e of set) {
        if (state.stamp.get(e) === frame) continue
        state.stamp.set(e, frame)
        for (const b of state.walls.get(e)!.barriers)
          if (b.field) rasterBarrier(grid, field, b, rect)
      }
    }
  // A region is small: solve it tighter than a whole field, which starts from a coarse pass.
  const report = solveRect(
    grid,
    field,
    rect,
    {
      reach: state.settings.spillReach,
      coarse,
      coarseCells: cells,
      tolerance: coarse ? 1e-4 : 1e-5,
    },
    state.scratch,
  )
  // The blur reads a texel's neighbours: pack and upload a texel around the region too.
  const out = {
    x0: Math.max(0, rect.x0 - 1),
    z0: Math.max(0, rect.z0 - 1),
    x1: Math.min(grid.width, rect.x1 + 1),
    z1: Math.min(grid.height, rect.z1 + 1),
  }
  packRect(grid, field, out, state.scratch)
  state.uploads.push({ layer, rect: out })
  return report
}

/** Builds the field from scratch: a new extent around everything, every layer solved whole. */
function rebuildField(state: InteriorState, cells: number): void {
  const q = INTERIOR_QUALITY[state.settings.quality]
  const b = allBounds(state)
  state.full = false
  state.builtTexel = q.texel
  state.builtReach = state.settings.spillReach
  state.uploads.length = 0
  if (!b || state.slabs.size === 0) {
    state.grid = undefined
    state.layers = []
    state.dirty = []
    return
  }
  // Room to grow: a quarter of the size (at least 4 m) each way, on whole metres.
  const slackX = Math.max(4, (b.maxX - b.minX) / 4)
  const slackZ = Math.max(4, (b.maxZ - b.minZ) / 4)
  const ox = Math.floor(b.minX - slackX)
  const oz = Math.floor(b.minZ - slackZ)
  const width = Math.ceil((b.maxX + slackX - ox) / q.texel)
  const height = Math.ceil((b.maxZ + slackZ - oz) / q.texel)
  state.grid = { ox, oz, texel: q.texel, width, height }
  const count = 1 + Math.min(state.levels.length, INTERIOR_LEVELS)
  state.layers = []
  state.dirty = []
  for (let l = 0; l < count; l++) {
    const layer = new FieldLayer(width, height)
    layer.base = l === 0 ? 0 : state.levels[l - 1]!.elevation
    state.layers.push(layer)
    state.dirty.push([])
  }
  const start = performance.now()
  let texels = 0
  let sweeps = 0
  const all: TexelRect = { x0: 0, z0: 0, x1: width, z1: height }
  for (let l = 0; l < count; l++) {
    const r = solveRegion(state, l, all, true, cells)
    texels += r.texels
    sweeps = Math.max(sweeps, r.sweeps)
  }
  state.last = {
    full: true,
    regions: state.layers.map((_, layer) => ({
      layer,
      bounds: [ox, oz, ox + width * q.texel, oz + height * q.texel],
    })),
    texels,
    sweeps,
    uploaded: width * height * count,
    ms: performance.now() - start,
  }
}

/** Re-solves the regions edits marked. */
function solveDirty(state: InteriorState, cells: number): void {
  const grid = state.grid
  if (!grid) return
  let any = false
  for (const list of state.dirty) if (list.length > 0) any = true
  if (!any) return
  const start = performance.now()
  const regions: InteriorSolveReport['regions'] = []
  let texels = 0
  let sweeps = 0
  let uploaded = 0
  for (let l = 0; l < state.dirty.length; l++) {
    for (const rect of state.dirty[l]!) {
      const r = solveRegion(state, l, rect, false, cells)
      texels += r.texels
      sweeps = Math.max(sweeps, r.sweeps)
      const u = state.uploads[state.uploads.length - 1]!.rect
      uploaded += (u.x1 - u.x0) * (u.z1 - u.z0)
      regions.push({
        layer: l,
        bounds: [
          grid.ox + rect.x0 * grid.texel,
          grid.oz + rect.z0 * grid.texel,
          grid.ox + rect.x1 * grid.texel,
          grid.oz + rect.z1 * grid.texel,
        ],
      })
    }
    state.dirty[l]!.length = 0
  }
  state.last = { full: false, regions, texels, sweeps, uploaded, ms: performance.now() - start }
}

// --- lights ----------------------------------------------------------------------------------

function releaseRow(state: InteriorState, store: LightStore | undefined, entity: Entity): void {
  const c = state.lights.get(entity)
  if (!c) return
  if (c.row >= 0) {
    state.freeRows.push(c.row)
    state.freeRows.sort((a, b) => b - a)
  }
  state.lights.delete(entity)
  state.dirtyRows.delete(entity)
  const r = store?.byEntity.get(entity)
  if (r) setLightRow(store!, r, -1)
}

/** Builds a light's row from the walls near it on its level. */
function rebuildRow(state: InteriorState, c: LightCache, bins: number): void {
  if (c.row < 0) return
  const frame = ++state.frame
  const list = state.candidates
  let count = 0
  const r = c.range
  for (let cx = Math.floor((c.x - r) / CELL); cx <= Math.floor((c.x + r) / CELL); cx++)
    for (let cz = Math.floor((c.z - r) / CELL); cz <= Math.floor((c.z + r) / CELL); cz++) {
      const set = state.cells.get(cellKey(c.layer, cx, cz))
      if (!set) continue
      for (const e of set) {
        if (state.stamp.get(e) === frame) continue
        state.stamp.set(e, frame)
        for (const b of state.walls.get(e)!.barriers) list[count++] = b
      }
    }
  const out = state.rowData.subarray(c.row * bins, (c.row + 1) * bins)
  buildRow(out, c.x, c.y, c.z, c.range, list, count, state.rowScratch)
  list.length = 0
  c.rebuilt = state.frame
  state.rowUploads.add(c.row)
}

/** Every row free again (rows were resized, or turned off). */
function resetRows(state: InteriorState, store: LightStore | undefined, count: number): void {
  for (const [entity, c] of state.lights) {
    c.row = -1
    const r = store?.byEntity.get(entity)
    if (r) setLightRow(store!, r, -1)
  }
  state.rowCount = count
  state.freeRows = []
  for (let i = count - 1; i >= 0; i--) state.freeRows.push(i)
}

// Scratch for the per-frame light pass: module state, so a still frame allocates nothing.
const pass: {
  state: InteriorState | undefined
  store: LightStore | undefined
  frame: number
  rows: number
} = { state: undefined, store: undefined, frame: 0, rows: 0 }

function syncRow(c: LightCache, entity: Entity): void {
  const store = pass.store
  if (c.row >= 0) pass.rows++
  const r = store?.byEntity.get(entity)
  if (r && r.row !== c.row) setLightRow(store!, r, c.row)
}

function dropUnseen(c: LightCache, entity: Entity): void {
  if (c.frame !== pass.frame) releaseRow(pass.state!, pass.store, entity)
}

const POINT_AND_SPOT = [PointLight, SpotLight] as const

type Piece = typeof Wall | typeof Floor | typeof Roof | typeof Opening | typeof Cutout

/** Whether any of `q`'s tables changed `def` since `since`. */
function changedSince(
  q: { tables: readonly { lastChanged(def: Piece): number }[] },
  def: Piece,
  since: number,
): boolean {
  for (let t = 0; t < q.tables.length; t++) if (q.tables[t]!.lastChanged(def) > since) return true
  return false
}

/**
 * Keeps the field and the rows current: settings, levels, then edits (each a region of the field
 * and the rows of lights in reach), then the lights themselves. Uploads only what changed; a still
 * frame does no work and allocates nothing.
 */
export const updateInterior = defineSystem({
  name: 'structure/interior',
  description:
    "Keeps interior lighting's sky visibility field and wall-blocked light rows current with structure edits and lights (0069).",
  setup: (world) => ({
    walls: world.query({ with: [Wall] }),
    floors: world.query({ with: [Floor] }),
    roofs: world.query({ with: [Roof] }),
    openings: world.query({ with: [Opening] }),
    cutouts: world.query({ with: [Cutout] }),
    levels: world.query({ with: [Level] }),
    points: world.query({ with: [PointLight, GlobalTransform] }),
    spots: world.query({ with: [SpotLight, GlobalTransform] }),
  }),
  run: ({ walls, floors, roofs, openings, cutouts, levels, points, spots }, world, ctx) => {
    const state = world.resource(Interior)
    const lighting = world.tryResource(InteriorLightingResource)
    const structure = world.tryResource(Structure)
    if (!lighting || !structure) return
    const store = world.tryResource(Lights)
    const since = ctx.lastRunTick
    mergeSettings(state, world.resource(StructureSettings))
    const settings = state.settings
    const q = INTERIOR_QUALITY[settings.quality]

    // Levels: a new order or height moves layers, and everything is built again.
    let levelsChanged = state.levelsDirty
    for (let t = 0; t < levels.tables.length && !levelsChanged; t++)
      if (levels.tables[t]!.lastChanged(Level) > since) levelsChanged = true
    if (levelsChanged) {
      state.levelsDirty = false
      if (readLevels(world, state)) state.full = true
    }
    if (settings.sky && (q.texel !== state.builtTexel || settings.spillReach !== state.builtReach))
      state.full = true
    if (structure.curveTolerance !== state.curveTolerance) {
      state.curveTolerance = structure.curveTolerance
      state.full = true
    }

    // Edits: walls (and the openings in them), floors and roofs (and their cutouts).
    let edited =
      state.full ||
      state.removedWalls.length +
        state.removedSlabs.length +
        state.removedOpenings.length +
        state.removedCutouts.length >
        0
    if (!edited) edited = changedSince(walls, Wall, since) || changedSince(floors, Floor, since)
    if (!edited) edited = changedSince(roofs, Roof, since) || changedSince(openings, Opening, since)
    if (!edited) edited = changedSince(cutouts, Cutout, since)
    if (edited) {
      if (state.full) {
        // Everything again: every piece's barriers and cover from scratch.
        state.walls.clear()
        state.slabs.clear()
        state.cells.clear()
        state.removedWalls.length = 0
        state.removedSlabs.length = 0
        state.removedOpenings.length = 0
        state.removedCutouts.length = 0
        for (const e of structure.walls.keys()) {
          const c = wallBarriers(world, structure, state, e)
          if (c) {
            state.walls.set(e, c)
            indexWall(state, e, c)
          }
        }
        for (const e of structure.slabs.keys()) {
          const c = slabCover(structure, state, e)
          if (c) state.slabs.set(e, c)
        }
        state.openingWall.clear()
        for (const [o, rec] of structure.openings) state.openingWall.set(o, rec.wall)
        state.cutoutHost.clear()
        for (const [c, rec] of structure.cutouts) state.cutoutHost.set(c, rec.host)
        for (const e of state.lights.keys()) state.dirtyRows.add(e)
      } else {
        const wallSet = new Set<Entity>()
        const slabSet = new Set<Entity>()
        for (const e of state.removedWalls) wallSet.add(e)
        for (const e of state.removedSlabs) slabSet.add(e)
        for (const o of state.removedOpenings) {
          const w = state.openingWall.get(o)
          if (w !== undefined) wallSet.add(w)
          state.openingWall.delete(o)
        }
        for (const c of state.removedCutouts) {
          const h = state.cutoutHost.get(c)
          if (h !== undefined) slabSet.add(h)
          state.cutoutHost.delete(c)
        }
        state.removedWalls.length = 0
        state.removedSlabs.length = 0
        state.removedOpenings.length = 0
        state.removedCutouts.length = 0
        const changed = (
          q2: typeof walls,
          def: typeof Wall | typeof Floor | typeof Roof | typeof Opening | typeof Cutout,
          each: (e: Entity) => void,
        ) => {
          for (const table of q2.tables) {
            if (table.lastChanged(def) <= since) continue
            const ticks = table.changedTicks(def)
            for (let row = 0; row < table.count; row++)
              if (ticks[row]! > since) each(table.entities[row]! as Entity)
          }
        }
        changed(walls, Wall, (e) => wallSet.add(e))
        changed(floors, Floor, (e) => slabSet.add(e))
        changed(roofs, Roof, (e) => slabSet.add(e))
        changed(openings, Opening, (o) => {
          const old = state.openingWall.get(o)
          if (old !== undefined) wallSet.add(old)
          const now = structure.openings.get(o)?.wall
          if (now !== undefined) {
            wallSet.add(now)
            state.openingWall.set(o, now)
          }
        })
        changed(cutouts, Cutout, (c) => {
          const old = state.cutoutHost.get(c)
          if (old !== undefined) slabSet.add(old)
          const now = structure.cutouts.get(c)?.host
          if (now !== undefined) {
            slabSet.add(now)
            state.cutoutHost.set(c, now)
          }
        })
        for (const e of wallSet) setWall(state, e, wallBarriers(world, structure, state, e))
        for (const e of slabSet) setSlab(state, e, slabCover(structure, state, e))
        // Grown past the field: a new extent, built whole.
        const b = allBounds(state)
        if (settings.sky && b && state.slabs.size > 0 && (!state.grid || !fits(state.grid, b)))
          state.full = true
      }
    }
    if (settings.sky) {
      if (state.full) rebuildField(state, q.cells)
      else solveDirty(state, q.cells)
    } else if (state.grid) {
      // Sky visibility off: the field goes, CPU side too; turning it on builds it again.
      state.grid = undefined
      state.layers = []
      state.dirty = []
      state.full = true
    } else state.full = true

    // Lights: track the blocked ones; a move, a range or a level change rebuilds a light's row.
    const rowsWanted = settings.blockLights ? settings.maxBlockedLights : 0
    if (rowsWanted !== state.rowCount || q.bins !== state.builtBins) {
      resetRows(state, store, rowsWanted)
      state.builtBins = q.bins
      state.rowData = new Uint32Array(rowsWanted * q.bins)
      for (const e of state.lights.keys()) state.dirtyRows.add(e)
    }
    for (const e of state.removedLights) releaseRow(state, store, e)
    state.removedLights.length = 0
    const frame = ++state.frame
    let seen = 0
    for (let k = 0; k < 2; k++) {
      // Both kinds share these fields (render's pointFields).
      const def = POINT_AND_SPOT[k] as typeof PointLight
      const q2 = k === 0 ? points : spots
      for (const table of q2.tables) {
        const n = table.count
        if (n === 0) continue
        const blocked = table.column(def, 'blockedByWalls')
        const range = table.column(def, 'range')
        const g = table.column(GlobalTransform, 'matrix')
        const changed = table.changedTicks(def)
        const moved = table.changedTicks(GlobalTransform)
        for (let i = 0; i < n; i++) {
          const entity = table.entities[i]! as Entity
          let c = state.lights.get(entity)
          if (blocked[i] === 0 || !settings.blockLights) {
            if (c) releaseRow(state, store, entity)
            continue
          }
          seen++
          if (!c) {
            c = { row: -1, x: 0, y: 0, z: 0, range: 0, layer: -1, frame, rebuilt: -1 }
            state.lights.set(entity, c)
            state.dirtyRows.add(entity)
          }
          c.frame = frame
          if (c.row < 0) {
            const row = state.freeRows.pop()
            if (row !== undefined) {
              c.row = row
              state.dirtyRows.add(entity)
            } else if (!state.warnedRows) {
              state.warnedRows = true
              world.tryResource(LogResource)?.error(
                new ShardError(
                  'structure/too-many-blocked-lights',
                  `More than ${settings.maxBlockedLights} lights have blockedByWalls: the rest light through walls`,
                  {
                    hint: 'Raise StructureSettings.interior.maxBlockedLights, or block fewer lights (each row costs one texture row).',
                    path: '/resources/structure/Settings/interior/maxBlockedLights',
                  },
                ),
              )
            }
          }
          if (changed[i]! > since || moved[i]! > since || c.layer < 0) {
            const o = i * 12
            const x = g[o + 3]!
            const y = g[o + 7]!
            const z = g[o + 11]!
            const layer = state.layerAtY(y)
            if (x !== c.x || y !== c.y || z !== c.z || range[i]! !== c.range || layer !== c.layer) {
              c.x = x
              c.y = y
              c.z = z
              c.range = range[i]!
              c.layer = layer
              state.dirtyRows.add(entity)
            }
          }
        }
      }
    }
    pass.state = state
    pass.store = store
    pass.frame = frame
    pass.rows = 0
    if (seen !== state.lights.size) state.lights.forEach(dropUnseen)
    if (state.dirtyRows.size > 0) {
      const start = performance.now()
      let n = 0
      for (const entity of state.dirtyRows) {
        const c = state.lights.get(entity)
        if (!c) continue
        rebuildRow(state, c, q.bins)
        n++
      }
      state.dirtyRows.clear()
      state.lastRows = { lights: n, ms: performance.now() - start }
    }
    state.lights.forEach(syncRow)
    const anyRow = pass.rows > 0
    pass.state = undefined
    pass.store = undefined

    // The texture: the field's layers while there's cover, rows while a light has one.
    const grid = state.grid
    const sky = settings.sky && grid !== undefined
    const blockedOn = settings.blockLights && anyRow
    lighting.lost()
    lighting.configure(
      sky ? grid!.width : 0,
      sky ? grid!.height : 0,
      sky ? state.layers.length : 0,
      blockedOn ? q.bins : 0,
      blockedOn ? state.rowCount : 0,
    )
    if (lighting.stale) {
      lighting.stale = false
      if (sky)
        for (let l = 0; l < state.layers.length; l++)
          lighting.writeField(l, 0, 0, grid!.width, grid!.height, state.layers[l]!.packed)
      if (blockedOn)
        for (const c of state.lights.values())
          if (c.row >= 0)
            lighting.writeRow(c.row, state.rowData.subarray(c.row * q.bins, (c.row + 1) * q.bins))
    } else {
      if (sky)
        for (const u of state.uploads) {
          const r = u.rect
          lighting.writeField(
            u.layer,
            r.x0,
            r.z0,
            r.x1 - r.x0,
            r.z1 - r.z0,
            state.layers[u.layer]!.packed,
          )
        }
      if (blockedOn)
        for (const row of state.rowUploads)
          lighting.writeRow(row, state.rowData.subarray(row * q.bins, (row + 1) * q.bins))
    }
    state.uploads.length = 0
    state.rowUploads.clear()
    lighting.sky = sky
    lighting.blocked = blockedOn
    lighting.provided = true
    if (sky || blockedOn) writeTable(state, lighting, q)
  },
})

/** The level table: the field's grid, then each level's range, layer and ambient. */
function writeTable(
  state: InteriorState,
  lighting: InteriorLighting,
  q: (typeof INTERIOR_QUALITY)[keyof typeof INTERIOR_QUALITY],
): void {
  const g = state.grid
  lighting.setGrid(
    g?.ox ?? 0,
    g?.oz ?? 0,
    g?.texel ?? q.texel,
    g?.width ?? 0,
    g?.height ?? 0,
    q.bins,
    q.taps,
  )
  const n = Math.min(state.levels.length, INTERIOR_LEVELS)
  lighting.setLevelCount(n)
  for (let i = 0; i < n; i++) {
    const l = state.levels[i]!
    lighting.setLevel(i, l.elevation, l.elevation + l.height, i + 1, l.elevation, l.ambient, l.fill)
  }
  lighting.setLevel(INTERIOR_GROUND, 0, 0, 0, 0, GROUND_AMBIENT, defaultFill)
  lighting.writeTable()
}

const GROUND_AMBIENT = [0, 0, 0] as const
const defaultFill = 0.05

/** Sky visibility at a point (0069): 1 outdoors, else the field there. For tests and agents. */
export function skyAt(world: World, x: number, y: number, z: number): number {
  return world.tryResource(Interior)?.skyAt(x, y, z) ?? 1
}

export const interiorMethods: AppMethod[] = [
  {
    name: 'structure.skyAt',
    description:
      'Interior lighting (0069): sky visibility at a world point, 0 (sealed in) to 1 (outdoors), from the field the lighting stage reads.',
    params: defineSchema('structure/SkyAtParams', {
      x: t.f32({ unit: 'm' }),
      y: t.f32({ unit: 'm' }),
      z: t.f32({ unit: 'm' }),
    }),
    handler: ({ world }, params) => ({
      sky: skyAt(world, Number(params.x), Number(params.y), Number(params.z)),
    }),
  },
]

/**
 * Interior lighting (0069): sky visibility from the plan scales ambient and image-based light
 * (dark deep in a room, dark in a sealed one), and lights with blockedByWalls stop at their level's
 * walls and closed doors. StructureSettings.interior sets the parts, quality and spill reach;
 * Level.interiorAmbient and interiorFill light what the sky doesn't reach. Needs structurePlugin
 * and render's interiorPlugin (in forwardPlugin).
 */
export const interiorLightingPlugin = definePlugin({
  name: 'structure/interior',
  dependencies: ['structure', 'render/interior'],
  provides: [Interior],
  build(app) {
    const world = app.world
    const state = new InteriorState()
    world.insertResource(Interior, state)
    world.observe(onRemove(Wall), ({ entity }) => {
      state.removedWalls.push(entity)
    })
    world.observe(onRemove(Floor), ({ entity }) => {
      state.removedSlabs.push(entity)
    })
    world.observe(onRemove(Roof), ({ entity }) => {
      state.removedSlabs.push(entity)
    })
    world.observe(onRemove(Opening), ({ entity }) => {
      state.removedOpenings.push(entity)
    })
    world.observe(onRemove(Cutout), ({ entity }) => {
      state.removedCutouts.push(entity)
    })
    world.observe(onRemove(Level), () => {
      state.levelsDirty = true
    })
    for (const def of [PointLight, SpotLight] as const)
      world.observe(onRemove(def as typeof PointLight), ({ entity }) => {
        if (state.lights.has(entity)) state.removedLights.push(entity)
      })
    app.addSystems(Last, updateInterior.inSet(RenderSet.Extract).after(extractLights))
    app.addMethod(...interiorMethods)
  },
  ready(app) {
    const world = app.world
    const structure = world.resource(Structure)
    structure.describeInterior = () =>
      world.resource(Interior).describe(world.tryResource(InteriorLightingResource))
  },
})
