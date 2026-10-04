import {
  type AssetRef,
  ChildOf,
  Derived,
  defineResource,
  defineSystem,
  type Entity,
  onRemove,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { Mesh, type MeshData } from '@aethervtt/shard-mesh'
import {
  ComputedVisibility,
  Cutaway,
  GpuAssetsResource,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  RenderStats,
  ShadowWhenHidden,
} from '@aethervtt/shard-render'
import { FrameDemand, LogResource, Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import {
  ContactMesh,
  type ContactSettings,
  Cutout,
  DoorLeaf,
  defaultContact,
  Floor,
  Level,
  Opening,
  Roof,
  StructureChunk,
  StructureSettings,
  Wall,
  WindowPane,
} from './components'
import { ContactQuads, contactChunks, contactQuads, emitContact } from './contact'
import { pointAt, sampleWall } from './curve'
import {
  ClipScratch,
  chunkKey,
  chunkX,
  chunkZ,
  emitFloor,
  emitWall,
  type FloorShape,
  floorChunks,
  floorShape,
  insideRing,
  MeshBuilder,
  type OpeningShape,
  type Piece,
  ringChunks,
  ringInside,
  ringShape,
  ringsOverlap,
  type SlabFrame,
  slabY,
  type WallShape,
  wallChunks,
  wallLength,
  wallPieces,
} from './geometry'

type MaterialRef = AssetRef<'Material'>

/** The key of the plain frame material: frames and door leaves without one of their own. */
export const FRAME_KEY = 'structure:frame'

/** Chunk keys fit in 32 bits; a (group, chunk) key puts the group's slot above them (0067). */
const GROUP_STRIDE = 4294967296

/**
 * Prefixes a material key for wall pieces while walls are cutaway (0070): they build meshes of
 * their own, apart from floors of the same material. Material keys (guids, paths) never start so.
 */
const WALL_KEY = '#wall/'

/** The material key of a builder key. */
function materialOf(key: string): string {
  return key.startsWith(WALL_KEY) ? key.slice(WALL_KEY.length) : key
}

interface WallRecord {
  shape: WallShape
  material: string
  pieces: Piece[]
  count: number
  /** Material key of each piece. */
  pieceMaterials: string[]
  /** (group, chunk) keys its geometry overlaps. */
  chunks: Set<number>
  /** The Level it names (null: none), and the group it draws into (the ground level if the
   * entity it names isn't a Level). */
  level: Entity | null
  group: Entity
  /** Contact shade quads (0068), and the (group, chunk) keys they have area in. */
  contact: ContactQuads
  contactChunks: Set<number>
}

/** A floor or a roof: an outline with its cutouts as holes (0067). */
interface SlabRecord {
  kind: 'floor' | 'roof'
  shape: FloorShape
  material: string
  /** (group, chunk) keys. */
  chunks: Set<number>
  level: Entity | null
  group: Entity
  /** Accepted cutouts in ring order (ring i + 1), and the material key of each framed one. */
  cutouts: Entity[]
  frameMaterials: string[]
  /** Roofs: keeps casting while hidden. */
  shadowWhenHidden: boolean
  /** Roofs: its meshes are Cutaway (0070). */
  cutaway: boolean
  /** Roofs: chunk keys of its footprint's bounds, for `roofAt`. */
  index: number[]
  /** Everything but its cutouts, and each accepted cutout's outline and frame: when only cutouts
   * change, only the chunks they cover rebuild. */
  signature: string
  rings: Map<Entity, string>
}

interface OpeningRecord {
  wall: Entity
  kind: 'door' | 'window'
  offset: number
  width: number
  height: number
  sill: number
  frameWidth: number
  frameDepth: number
  frameMaterial: string
  hinge: 'start' | 'end'
  swing: 'left' | 'right'
  state: 'closed' | 'open' | 'locked'
  /** The door leaf or window pane. */
  leaf: Entity | null
  /** How far open the leaf is (0 to 1), and where it's heading. */
  open: number
  target: number
}

interface CutoutRecord {
  host: Entity
  kind: 'hole' | 'hatch' | 'skylight'
  /** The outline, flat (x, z) pairs. */
  points: Float64Array
  frameWidth: number
  frameDepth: number
  frameMaterial: string
  hinge: number
  state: 'closed' | 'open' | 'locked'
  /** Its ring in its host's shape, or -1 when its host skipped it. */
  ring: number
  /** The hatch leaf or skylight pane, and its mesh. */
  leaf: Entity | null
  mesh: Mesh | null
  meshRef: AssetRef<'Mesh'> | null
  /** Hatches: the hinge (x, y, z), its axis (unit), and the swing's sign. */
  pivot: [number, number, number, number, number, number, number]
  open: number
  target: number
}

interface ChunkMesh {
  entity: Entity
  mesh: Mesh
  ref: AssetRef<'Mesh'>
  triangles: number
}

interface ChunkRecord {
  group: Entity
  x: number
  z: number
  walls: Set<Entity>
  slabs: Set<Entity>
  meshes: Map<string, ChunkMesh>
  /** Walls with contact shade here, and the chunk's contact mesh (0068). */
  contacts: Set<Entity>
  contact: ChunkMesh | null
}

/** What the last compile that did something did (`structure.describe`). */
export interface CompileReport {
  /** Chunks rebuilt, as `[x, z]`, and the group of each. */
  dirtyChunks: [number, number][]
  dirtyGroups: Entity[]
  chunksRebuilt: number
  meshesRebuilt: number
  /** Chunks whose contact mesh alone was rebuilt (0068): a floor edit, a contact setting. */
  contactRebuilt: number
  /** Those chunks, as `[x, z]`. */
  contactChunks: [number, number][]
  ms: number
}

/** Frame demand held while a door or hatch swings (0052). */
export const DOOR_DEMAND = 'structure/doors'

/**
 * Structure's state: the geometry of every wall, opening, floor, roof and cutout, which (group,
 * chunk) pairs each overlaps, and the per-material meshes of every one. `structure/compile` keeps
 * it current. A group is a Level, a Roof, or the ground level (`ground`); its chunk meshes are its
 * children, so hiding it is one Visibility write (0067).
 */
export class StructureState {
  readonly walls = new Map<Entity, WallRecord>()
  readonly slabs = new Map<Entity, SlabRecord>()
  readonly openings = new Map<Entity, OpeningRecord>()
  readonly cutouts = new Map<Entity, CutoutRecord>()
  /** Openings by host wall entity (including hosts that don't exist yet). */
  readonly byWall = new Map<Entity, Set<Entity>>()
  /** Cutouts by host floor or roof. */
  readonly byHost = new Map<Entity, Set<Entity>>()
  /** Every Level's elevation, to tell a move from an edit that moves nothing. */
  readonly levels = new Map<Entity, number>()
  /** Keyed by (group, chunk): see `chunkOf`. */
  readonly chunks = new Map<number, ChunkRecord>()
  readonly materials = new Map<string, MaterialRef>()
  /** Roofs by the chunks their footprints' bounds overlap (`roofAt`). */
  readonly roofIndex = new Map<number, Set<Entity>>()
  /** Group entities by slot; the ground level is slot 0. */
  readonly groups: Entity[] = []
  readonly groupSlots = new Map<Entity, number>()
  /** Doors and hatches swinging. */
  readonly moving = new Set<Entity>()
  /** The ground level's group: pieces without a Level draw under it. */
  ground: Entity = -1 as Entity
  chunkSize = 0
  curveTolerance = 0
  /** The shape each wall last reported a too-tight curve for (reported once per shape). */
  readonly warned = new Map<Entity, string>()
  /** The error each cutout last reported (reported once until it changes). */
  readonly cutoutWarned = new Map<Entity, string>()
  last: CompileReport = {
    dirtyChunks: [],
    dirtyGroups: [],
    chunksRebuilt: 0,
    meshesRebuilt: 0,
    contactRebuilt: 0,
    contactChunks: [],
    ms: 0,
  }
  /** Totals since start. */
  chunksRebuilt = 0
  compiles = 0
  defaultMaterial: MaterialRef | undefined
  glassMaterial: MaterialRef | undefined
  leafMesh: AssetRef<'Mesh'> | undefined
  readonly removedWalls: Entity[] = []
  readonly removedSlabs: Entity[] = []
  readonly removedOpenings: Entity[] = []
  readonly removedCutouts: Entity[] = []
  readonly removedLevels: Entity[] = []
  readonly dirtyWalls = new Set<Entity>()
  readonly dirtySlabs = new Set<Entity>()
  readonly dirtyChunks = new Set<number>()
  /** (group, chunk) keys whose contact mesh alone rebuilds. */
  readonly dirtyContact = new Set<number>()
  /** Walls whose contact quads are recomputed after this compile's walls and slabs. */
  readonly contactWalls = new Set<Entity>()
  /** Contact settings as last applied. */
  contact: ContactSettings = defaultContact()
  /** StructureSettings.cutawayWalls as last applied (0070). */
  cutawayWalls = false
  /** The `StructureSettings.contact` object last merged (a patch replaces it). */
  contactSeen: object | undefined
  contactMaterial: MaterialRef | undefined
  readonly contactBuilder = new MeshBuilder()
  readonly contactScratch = new ContactQuads()
  readonly builders = new Map<string, MeshBuilder>()
  readonly scratch = new ClipScratch()
  readonly overlap = new Set<number>()
  readonly region = new Set<number>()
  readonly sortedOpenings: OpeningShape[] = []
  readonly world: World
  /** Interior lighting's section of `describe` (0069), while interiorLightingPlugin is installed. */
  describeInterior: (() => unknown) | undefined

  constructor(world: World) {
    this.world = world
  }

  /** A material's key, registering its ref (the default material for none). */
  materialKey(ref: MaterialRef | null): string {
    if (!ref) return ''
    const key = ref.guid ?? ref.path ?? ''
    if (key && !this.materials.has(key)) this.materials.set(key, ref)
    return key
  }

  materialRef(key: string): MaterialRef {
    return (key ? this.materials.get(key) : undefined) ?? this.defaultMaterial!
  }

  builder(key: string): MeshBuilder {
    let b = this.builders.get(key)
    if (!b) {
      b = new MeshBuilder()
      this.builders.set(key, b)
    }
    return b
  }

  /** A group's slot (assigned on first use). */
  groupSlot(group: Entity): number {
    let slot = this.groupSlots.get(group)
    if (slot === undefined) {
      slot = this.groups.length
      this.groups.push(group)
      this.groupSlots.set(group, slot)
    }
    return slot
  }

  /** The (group, chunk) key of chunk `key` in `group`. The ground level's are plain chunk keys. */
  chunkOf(group: Entity, key: number): number {
    return this.groupSlot(group) * GROUP_STRIDE + key
  }

  chunk(composite: number): ChunkRecord {
    let c = this.chunks.get(composite)
    if (!c) {
      const key = composite % GROUP_STRIDE
      c = {
        group: this.groups[Math.floor(composite / GROUP_STRIDE)]!,
        x: chunkX(key),
        z: chunkZ(key),
        walls: new Set(),
        slabs: new Set(),
        meshes: new Map(),
        contacts: new Set(),
        contact: null,
      }
      this.chunks.set(composite, c)
    }
    return c
  }

  /** Where a piece on `level` draws: the Level, or the ground level when it has none. */
  groupOf(level: Entity | null): Entity {
    const world = this.world
    return level !== null && world.isAlive(level) && world.has(level, Level) ? level : this.ground
  }

  /** A group's elevation: its Level's, or 0. */
  baseOf(group: Entity): number {
    return group === this.ground ? 0 : (this.world.tryGet(group, Level)?.elevation ?? 0)
  }

  /** Curved walls and how finely each is sampled (0066). */
  private curves() {
    const out: { wall: Entity; samples: number; length: number }[] = []
    for (const [wall, rec] of this.walls)
      if (rec.shape.line.count > 2)
        out.push({ wall, samples: rec.shape.line.count, length: rec.shape.line.length })
    return out
  }

  /** Every group: its kind, level index, chunks and meshes, and whether it's hidden. */
  private describeGroups() {
    const world = this.world
    const out: {
      group: Entity
      kind: 'ground' | 'level' | 'roof'
      index: number
      chunks: number
      meshes: number
      contactMeshes: number
      hidden: boolean
    }[] = []
    const counts = new Map<Entity, { chunks: number; meshes: number; contact: number }>()
    for (const c of this.chunks.values()) {
      const n = counts.get(c.group) ?? { chunks: 0, meshes: 0, contact: 0 }
      n.chunks++
      n.meshes += c.meshes.size
      if (c.contact) n.contact++
      counts.set(c.group, n)
    }
    for (const group of this.groups) {
      const n = counts.get(group)
      if (!n && group !== this.ground) continue
      const roof = this.slabs.get(group)?.kind === 'roof'
      const level = world.isAlive(group) ? world.tryGet(group, Level) : undefined
      out.push({
        group,
        kind: group === this.ground ? 'ground' : roof ? 'roof' : 'level',
        index: level?.index ?? 0,
        chunks: n?.chunks ?? 0,
        meshes: n?.meshes ?? 0,
        contactMeshes: n?.contact ?? 0,
        hidden: world.isAlive(group) && world.tryGet(group, ComputedVisibility)?.visible === false,
      })
    }
    return out
  }

  /** Counts for `structure.describe`. */
  describe() {
    const size = this.chunkSize
    let meshes = 0
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    const perChunk: {
      group: Entity
      chunk: [number, number]
      walls: number
      floors: number
      meshes: number
      contactTriangles: number
    }[] = []
    let contactMeshes = 0
    let contactTriangles = 0
    for (const c of this.chunks.values()) {
      meshes += c.meshes.size
      if (c.contact) {
        contactMeshes++
        contactTriangles += c.contact.triangles
      }
      if (c.x < minX) minX = c.x
      if (c.z < minZ) minZ = c.z
      if (c.x > maxX) maxX = c.x
      if (c.z > maxZ) maxZ = c.z
      perChunk.push({
        group: c.group,
        chunk: [c.x, c.z],
        walls: c.walls.size,
        floors: c.slabs.size,
        meshes: c.meshes.size,
        contactTriangles: c.contact?.triangles ?? 0,
      })
    }
    perChunk.sort((a, b) => a.group - b.group || a.chunk[0] - b.chunk[0] || a.chunk[1] - b.chunk[1])
    let floors = 0
    for (const s of this.slabs.values()) if (s.kind === 'floor') floors++
    return {
      walls: this.walls.size,
      openings: this.openings.size,
      floors,
      roofs: this.slabs.size - floors,
      cutouts: this.cutouts.size,
      levels: this.levels.size,
      chunkSize: size,
      chunks: this.chunks.size,
      meshes,
      grid:
        this.chunks.size > 0
          ? {
              min: [minX, minZ],
              max: [maxX, maxZ],
              bounds: [minX * size, minZ * size, (maxX + 1) * size, (maxZ + 1) * size],
            }
          : null,
      groups: this.describeGroups(),
      perChunk,
      contact: {
        enabled: this.contact.enabled,
        meshes: contactMeshes,
        triangles: contactTriangles,
      },
      doorsMoving: this.moving.size,
      curves: this.curves(),
      warnings: [...this.warned.keys(), ...this.cutoutWarned.keys()],
      lastCompile: this.last,
      totals: { compiles: this.compiles, chunksRebuilt: this.chunksRebuilt },
      ...(this.describeInterior ? { interior: this.describeInterior() } : {}),
    }
  }
}

export const Structure = defineResource<StructureState>('structure/State', {
  description:
    'Walls, openings, floors, roofs and cutouts, and the chunk meshes structure compile keeps for each group.',
})

/** Records despawns and removals for the next compile (observers fire before the value goes). */
export function observeRemovals(world: World, state: StructureState): void {
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
  world.observe(onRemove(Level), ({ entity }) => {
    state.removedLevels.push(entity)
  })
}

function wallShape(
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

function log(state: StructureState, level: 'error' | 'warn', err: ShardError): void {
  state.world.tryResource(LogResource)?.log(level, err.message, {
    code: err.code,
    path: err.path,
    hint: err.hint,
  })
}

/**
 * Curves too tight for their thickness (0066): an arc whose radius is under half its thickness
 * can't be drawn and is skipped; a Bézier that folds somewhere draws as sampled. Each reports once
 * per shape.
 */
function checkCurve(
  state: StructureState,
  entity: Entity,
  value: { shape: string; thickness: number; bow: number; c0: number[]; c1: number[] },
  shape: WallShape,
): boolean {
  if (shape.line.radius >= value.thickness / 2) {
    state.warned.delete(entity)
    return true
  }
  const signature = `${value.shape}/${value.bow}/${value.c0}/${value.c1}/${value.thickness}`
  const arc = value.shape === 'arc'
  if (state.warned.get(entity) !== signature) {
    state.warned.set(entity, signature)
    log(
      state,
      arc ? 'error' : 'warn',
      new ShardError(
        arc ? 'structure/wall-too-tight' : 'structure/wall-folds',
        arc
          ? `Wall ${entity}: an arc of radius ${shape.line.radius.toFixed(3)} m can't hold a wall ${value.thickness} m thick`
          : `Wall ${entity}: the curve bends tighter than half the wall's thickness, so its inner face folds`,
        {
          path: `/entities/${entity}/structure/Wall/${arc ? 'bow' : 'c0'}`,
          hint: arc
            ? 'Bow it less, or make the wall thinner: the radius must be at least half the thickness.'
            : 'Move the control points apart, or make the wall thinner.',
        },
      ),
    )
  }
  return !arc
}

function markChunks(state: StructureState, chunks: Set<number>): void {
  for (const key of chunks) state.dirtyChunks.add(key)
}

/** Moves plain chunk keys in `state.overlap` into `out` as (group, chunk) keys. */
function groupKeys(state: StructureState, group: Entity, out: Set<number>): void {
  out.clear()
  for (const key of state.overlap) out.add(state.chunkOf(group, key))
  state.overlap.clear()
}

/** Makes a leaf, pane or hatch a child of its host's group, so it hides with it. */
function parentTo(state: StructureState, leaf: Entity | null, group: Entity): void {
  const world = state.world
  if (leaf === null || !world.isAlive(leaf)) return
  if (world.tryGet(leaf, ChildOf)?.parent !== group) world.add(leaf, ChildOf, { parent: group })
}

/** Recomputes a wall's pieces and chunk set; marks its old and new chunks dirty. */
function evaluateWall(state: StructureState, entity: Entity): void {
  const world = state.world
  const old = state.walls.get(entity)
  if (old) {
    // Walls it was joined to may lose a corner strip (0068).
    queueContactNear(state, old.chunks)
    markChunks(state, old.chunks)
    for (const key of old.chunks) state.chunks.get(key)?.walls.delete(entity)
  }
  const value = world.tryGet(entity, Wall)
  if (!value) {
    state.walls.delete(entity)
    return
  }
  const level = (value.level ?? null) as Entity | null
  const group = state.groupOf(level)
  const shape = wallShape(value, state.baseOf(group), state.curveTolerance)
  if (!checkCurve(state, entity, value, shape)) {
    state.walls.delete(entity)
    return
  }
  const material = state.materialKey(value.material as MaterialRef | null)
  // Openings on this wall, by offset (then entity, so ties are stable).
  const list = state.sortedOpenings
  list.length = 0
  const ids: Entity[] = []
  for (const o of state.byWall.get(entity) ?? []) {
    const r = state.openings.get(o)
    if (r) ids.push(o)
  }
  ids.sort((p, q) => state.openings.get(p)!.offset - state.openings.get(q)!.offset || p - q)
  for (const o of ids) list.push(state.openings.get(o)!)
  const rec: WallRecord = old ?? {
    shape,
    material,
    pieces: [],
    count: 0,
    pieceMaterials: [],
    chunks: new Set(),
    level,
    group,
    contact: new ContactQuads(),
    contactChunks: new Set(),
  }
  rec.shape = shape
  rec.material = material
  rec.level = level
  rec.group = group
  rec.count = wallPieces(shape, list, rec.pieces)
  rec.pieceMaterials.length = rec.count
  for (let i = 0; i < rec.count; i++) {
    const p = rec.pieces[i]!
    if (!p.frame) rec.pieceMaterials[i] = material
    else {
      // Frames without their own material are plain wood, not the wall's (a textured wall's
      // pattern doesn't belong on a frame).
      const frame = (list[p.source] as OpeningRecord).frameMaterial
      rec.pieceMaterials[i] = frame || FRAME_KEY
    }
  }
  wallChunks(shape, rec.pieces, rec.count, state.chunkSize, state.overlap, state.scratch)
  groupKeys(state, group, rec.chunks)
  for (const key of rec.chunks) state.chunk(key).walls.add(entity)
  markChunks(state, rec.chunks)
  state.walls.set(entity, rec)
  state.contactWalls.add(entity)
  queueContactNear(state, rec.chunks)
  for (const o of ids) {
    const r = state.openings.get(o)!
    // A leaf goes with its level when the level is despawned: grow a new one.
    if (r.leaf === null || !world.isAlive(r.leaf)) spawnLeaf(state, o, r)
    else parentTo(state, r.leaf, group)
    placeLeaf(state, o)
    dressLeaf(state, o)
  }
}

/** Reports a cutout its host skips, once until the error changes. */
function rejectCutout(
  state: StructureState,
  entity: Entity,
  code: 'structure/cutout-outside' | 'structure/cutout-overlap',
  other?: Entity,
): void {
  const signature = `${code}/${other ?? ''}`
  if (state.cutoutWarned.get(entity) === signature) return
  state.cutoutWarned.set(entity, signature)
  const rec = state.cutouts.get(entity)!
  log(
    state,
    'error',
    new ShardError(
      code,
      code === 'structure/cutout-outside'
        ? `Cutout ${entity}: its outline isn't inside its host ${rec.host}`
        : `Cutout ${entity}: its outline overlaps cutout ${other} on the same host`,
      {
        path: `/entities/${entity}/structure/Cutout/points`,
        hint:
          code === 'structure/cutout-outside'
            ? 'Keep every point inside the floor or roof, off its edge; a hole across the edge is a different outline.'
            : 'Move one of them, or merge the two into one outline.',
      },
    ),
  )
}

/** Recomputes a floor or roof: its cutouts (validated), triangulation, chunks and leaves. */
function evaluateSlab(state: StructureState, entity: Entity): void {
  const world = state.world
  const old = state.slabs.get(entity)
  const oldChunks = old ? [...old.chunks] : []
  const oldShape = old?.shape
  const oldCutouts = old?.cutouts ?? []
  const oldRings = old?.rings
  // A floor edit can flip which sides of the walls near it face a floor (0068).
  if (old?.kind === 'floor') queueContactArea(state, old.group, old.shape)
  if (old) {
    for (const key of old.chunks) state.chunks.get(key)?.slabs.delete(entity)
    for (const key of old.index) state.roofIndex.get(key)?.delete(entity)
  }
  const floor = world.tryGet(entity, Floor)
  const roof = floor ? undefined : world.tryGet(entity, Roof)
  const value = floor ?? roof
  if (!value || value.points.length < 3) {
    for (const key of oldChunks) state.dirtyChunks.add(key)
    state.slabs.delete(entity)
    for (const c of state.byHost.get(entity) ?? []) dropLeaf(state, c)
    return
  }
  const level = (value.level ?? null) as Entity | null
  const levelGroup = state.groupOf(level)
  // A roof is its own group, so it hides alone; a floor draws with its level.
  const group = roof ? entity : levelGroup
  const base = state.baseOf(levelGroup)
  const outline = new Float64Array(value.points.length * 2)
  for (let i = 0; i < value.points.length; i++) {
    outline[i * 2] = value.points[i]![0]!
    outline[i * 2 + 1] = value.points[i]![1]!
  }
  // Cutouts: each inside the outline and clear of the ones before it. Those it already has come
  // first, so a new cutout that overlaps one is the one reported; then the rest by entity.
  const ids = [...(state.byHost.get(entity) ?? [])].filter((c) => state.cutouts.has(c))
  const rank = (c: Entity) => {
    const i = oldCutouts.indexOf(c)
    return i < 0 ? oldCutouts.length : i
  }
  ids.sort((a, b) => rank(a) - rank(b) || a - b)
  const accepted: Entity[] = []
  const holes: number[][][] = []
  const frames: SlabFrame[] = []
  const frameMaterials: string[] = []
  const rings = new Map<Entity, string>()
  for (const c of ids) {
    const cut = state.cutouts.get(c)!
    cut.ring = -1
    if (cut.points.length < 6) continue
    if (!ringInside(cut.points, outline)) {
      rejectCutout(state, c, 'structure/cutout-outside')
      continue
    }
    const clash = accepted.find((a) => ringsOverlap(cut.points, state.cutouts.get(a)!.points))
    if (clash !== undefined) {
      rejectCutout(state, c, 'structure/cutout-overlap', clash)
      continue
    }
    state.cutoutWarned.delete(c)
    accepted.push(c)
    cut.ring = accepted.length
    const ring: number[][] = []
    for (let i = 0; i < cut.points.length; i += 2) ring.push([cut.points[i]!, cut.points[i + 1]!])
    holes.push(ring)
    const framed = cut.frameWidth > 1e-9
    if (framed) {
      frames.push({ ring: cut.ring, width: cut.frameWidth, depth: cut.frameDepth })
      frameMaterials.push(cut.frameMaterial || FRAME_KEY)
    }
    rings.set(
      c,
      framed
        ? `${cut.points}|${cut.frameWidth}|${cut.frameDepth}|${cut.frameMaterial}`
        : `${cut.points}`,
    )
  }
  const material = state.materialKey(value.material as MaterialRef | null)
  const signature = roof
    ? `roof|${outline}|${base + roof.height}|${roof.thickness}|${roof.pitch}|${roof.ridge}|${material}|${group}`
    : `floor|${outline}|${base + floor!.elevation}|${floor!.thickness}|${material}|${group}`
  const shape = floorShape(
    value.points,
    roof ? base + roof.height : base + floor!.elevation,
    roof
      ? {
          holes,
          frames,
          thickness: roof.thickness,
          pitch: roof.pitch,
          ridge: roof.ridge,
        }
      : { holes, frames, thickness: floor!.thickness },
  )
  const rec: SlabRecord = old ?? {
    kind: roof ? 'roof' : 'floor',
    shape,
    material: '',
    chunks: new Set(),
    level,
    group,
    cutouts: [],
    frameMaterials: [],
    shadowWhenHidden: false,
    cutaway: false,
    index: [],
    signature: '',
    rings: new Map(),
  }
  rec.kind = roof ? 'roof' : 'floor'
  rec.shape = shape
  rec.material = material
  rec.level = level
  rec.group = group
  rec.cutouts = accepted
  rec.frameMaterials = frameMaterials
  const shadow = roof?.shadowWhenHidden ?? false
  if (old && old.shadowWhenHidden !== shadow) {
    for (const key of old.chunks)
      for (const cm of state.chunks.get(key)?.meshes.values() ?? [])
        setShadowWhenHidden(state, cm, shadow)
  }
  rec.shadowWhenHidden = shadow
  const cut = roof?.cutaway ?? false
  if (old && old.cutaway !== cut) {
    for (const key of old.chunks)
      for (const cm of state.chunks.get(key)?.meshes.values() ?? [])
        setTag(state, cm.entity, Cutaway, cut)
    for (const c of old.cutouts) setTag(state, state.cutouts.get(c)?.leaf ?? null, Cutaway, cut)
  }
  rec.cutaway = cut
  floorChunks(shape, state.chunkSize, state.overlap, state.scratch)
  groupKeys(state, group, rec.chunks)
  for (const key of rec.chunks) state.chunk(key).slabs.add(entity)
  if (!old || old.signature !== signature) {
    for (const key of oldChunks) state.dirtyChunks.add(key)
    markChunks(state, rec.chunks)
  } else {
    // Only cutouts changed: the chunks each changed one covers, before and after. The rest of the
    // slab draws the same area however it's now triangulated.
    const region = state.region
    region.clear()
    const size = state.chunkSize
    for (const c of new Set([...oldRings!.keys(), ...rings.keys()])) {
      if (oldRings!.get(c) === rings.get(c)) continue
      const was = oldCutouts.indexOf(c)
      if (was >= 0) ringChunks(oldShape!, was + 1, size, region, state.scratch)
      const now = accepted.indexOf(c)
      if (now >= 0) ringChunks(shape, now + 1, size, region, state.scratch)
    }
    const before = new Set(oldChunks)
    for (const key of region) {
      const composite = state.chunkOf(group, key)
      if (before.has(composite) || rec.chunks.has(composite)) state.dirtyChunks.add(composite)
    }
  }
  rec.signature = signature
  rec.rings = rings
  rec.index.length = 0
  if (roof) {
    const size = state.chunkSize
    for (let x = Math.floor(shape.minX / size); x <= Math.floor(shape.maxX / size); x++)
      for (let z = Math.floor(shape.minZ / size); z <= Math.floor(shape.maxZ / size); z++) {
        const key = chunkKey(x, z)
        rec.index.push(key)
        let set = state.roofIndex.get(key)
        if (!set) {
          set = new Set()
          state.roofIndex.set(key, set)
        }
        set.add(entity)
      }
  }
  state.slabs.set(entity, rec)
  if (floor) queueContactArea(state, group, shape)
  for (const c of ids) {
    const cut = state.cutouts.get(c)!
    if (cut.ring < 0) dropLeaf(state, c)
    else buildLeaf(state, c, rec)
  }
}

function setShadowWhenHidden(state: StructureState, cm: ChunkMesh, on: boolean): void {
  setTag(state, cm.entity, ShadowWhenHidden, on)
}

/** Adds or removes a tag on a mesh entity structure keeps, if it's alive. */
function setTag(
  state: StructureState,
  entity: Entity | null,
  tag: typeof Cutaway | typeof ShadowWhenHidden,
  on: boolean,
): void {
  const world = state.world
  if (entity === null || !world.isAlive(entity) || world.has(entity, tag) === on) return
  if (on) world.add(entity, tag)
  else world.remove(entity, tag)
}

function forgetOpening(state: StructureState, entity: Entity): void {
  const rec = state.openings.get(entity)
  if (!rec) return
  state.byWall.get(rec.wall)?.delete(entity)
  if (state.walls.has(rec.wall)) state.dirtyWalls.add(rec.wall)
  if (rec.leaf !== null && state.world.isAlive(rec.leaf)) state.world.despawn(rec.leaf)
  state.openings.delete(entity)
  state.moving.delete(entity)
}

/** Reads a changed opening. Geometry changes dirty its wall(s); a state change only swings. */
function readOpening(state: StructureState, entity: Entity): void {
  const world = state.world
  const v = world.get(entity, Opening)
  const wall = (v.wall ?? -1) as Entity
  const frameMaterial = state.materialKey(v.frameMaterial as MaterialRef | null)
  const target = v.kind === 'door' && v.state === 'open' ? 1 : 0
  let rec = state.openings.get(entity)
  if (!rec) {
    rec = {
      wall,
      kind: v.kind,
      offset: v.offset,
      width: v.width,
      height: v.height,
      sill: v.sill,
      frameWidth: v.frameWidth,
      frameDepth: v.frameDepth,
      frameMaterial,
      hinge: v.hinge,
      swing: v.swing,
      state: v.state,
      leaf: null,
      open: target,
      target,
    }
    state.openings.set(entity, rec)
    hostSet(state.byWall, wall).add(entity)
    spawnLeaf(state, entity, rec)
    if (state.walls.has(wall) || world.isAlive(wall)) state.dirtyWalls.add(wall)
    return
  }
  const geometry =
    rec.wall !== wall ||
    rec.kind !== v.kind ||
    rec.offset !== v.offset ||
    rec.width !== v.width ||
    rec.height !== v.height ||
    rec.sill !== v.sill ||
    rec.frameWidth !== v.frameWidth ||
    rec.frameDepth !== v.frameDepth ||
    rec.frameMaterial !== frameMaterial
  const kindChanged = rec.kind !== v.kind
  if (geometry) {
    state.dirtyWalls.add(rec.wall)
    if (rec.wall !== wall) {
      state.byWall.get(rec.wall)?.delete(entity)
      hostSet(state.byWall, wall).add(entity)
      state.dirtyWalls.add(wall)
    }
  }
  rec.wall = wall
  rec.kind = v.kind
  rec.offset = v.offset
  rec.width = v.width
  rec.height = v.height
  rec.sill = v.sill
  rec.frameWidth = v.frameWidth
  rec.frameDepth = v.frameDepth
  rec.frameMaterial = frameMaterial
  const placement = geometry || rec.hinge !== v.hinge || rec.swing !== v.swing
  rec.hinge = v.hinge
  rec.swing = v.swing
  rec.state = v.state
  if (kindChanged) {
    if (rec.leaf !== null && world.isAlive(rec.leaf)) world.despawn(rec.leaf)
    rec.leaf = null
    spawnLeaf(state, entity, rec)
  } else if (placement) {
    placeLeaf(state, entity)
    dressLeaf(state, entity)
  }
  if (rec.target !== target) {
    rec.target = target
    if (state.world.resource(StructureSettings).reducedMotion) {
      rec.open = target
      placeLeaf(state, entity)
    } else state.moving.add(entity)
  }
}

function hostSet(map: Map<Entity, Set<Entity>>, host: Entity): Set<Entity> {
  let set = map.get(host)
  if (!set) {
    set = new Set()
    map.set(host, set)
  }
  return set
}

function spawnLeaf(state: StructureState, opening: Entity, rec: OpeningRecord): void {
  const world = state.world
  const material = rec.kind === 'window' ? state.glassMaterial! : state.defaultMaterial!
  const leaf = world.spawn(
    [Mesh3d, { mesh: state.leafMesh! }],
    [MeshMaterial, { material }],
    [DoorLeaf, { opening, angle: rec.open }],
    [ChildOf, { parent: state.walls.get(rec.wall)?.group ?? state.ground }],
    Transform,
    Derived,
  )
  if (rec.kind === 'window') {
    world.add(leaf, WindowPane)
    world.add(leaf, NotShadowCaster)
  }
  if (state.cutawayWalls) world.add(leaf, Cutaway)
  rec.leaf = leaf
  placeLeaf(state, opening)
  dressLeaf(state, opening)
}

const HALF_PI = Math.PI / 2
const chordA = new Float64Array(4)
const chordB = new Float64Array(4)

/**
 * Puts a door leaf (a unit box: x 0..1, y 0..1, z −½..½) at its hinge, turned by how far open it
 * is; a window pane across its hole. Writes Transform columns directly: a swinging frame is one
 * instance slot and no allocation.
 */
function placeLeaf(state: StructureState, opening: Entity): void {
  const rec = state.openings.get(opening)
  const world = state.world
  if (!rec || rec.leaf === null || !world.isAlive(rec.leaf)) return
  const wall = state.walls.get(rec.wall)
  const leaf = rec.leaf
  const table = world.entityTable(leaf)
  const row = world.entityRow(leaf)
  const scale = table.column(Transform, 'scale') as Float32Array
  if (!wall) {
    // No host yet: nothing to hang from.
    scale[row * 3] = scale[row * 3 + 1] = scale[row * 3 + 2] = 0
    table.markChanged(Transform, row)
    return
  }
  const s = wall.shape
  const len = wallLength(s)
  const o0 = Math.max(0, Math.min(len, rec.offset))
  const o1 = Math.max(o0, Math.min(len, rec.offset + rec.width))
  const fw = Math.max(0, Math.min(rec.frameWidth, (o1 - o0) / 2))
  const head = Math.min(s.height, rec.sill + rec.height)
  const bottom = rec.sill + (rec.kind === 'window' ? fw : 0)
  const height = Math.max(0, head - fw - bottom)
  const thick = rec.kind === 'window' ? Math.min(0.02, s.thickness * 0.2) : s.thickness * 0.4
  const end = rec.kind === 'door' && rec.hinge === 'end'
  // The leaf spans the chord between the opening's ends inside its frame (straight on a curve).
  const p0 = pointAt(s.line, o0 + fw, chordA)
  const p1 = pointAt(s.line, Math.max(o0 + fw, o1 - fw), chordB)
  const cx = p1[0]! - p0[0]!
  const cz = p1[1]! - p0[1]!
  const width = Math.sqrt(cx * cx + cz * cz)
  const dx = (end ? -cx : cx) / (width || 1)
  const dz = (end ? -cz : cz) / (width || 1)
  const hinge = end ? p1 : p0
  // Local +x runs from the hinge along the chord; yaw turns it there, the swing opens it.
  const yaw = Math.atan2(-dz, dx)
  const sign = (rec.swing === 'left') !== end ? 1 : -1
  const angle = yaw + (rec.kind === 'door' ? sign * rec.open * HALF_PI : 0)
  const translation = table.column(Transform, 'translation') as Float32Array
  const rotation = table.column(Transform, 'rotation') as Float32Array
  translation[row * 3] = hinge[0]!
  translation[row * 3 + 1] = s.elevation + bottom
  translation[row * 3 + 2] = hinge[1]!
  rotation[row * 4] = 0
  rotation[row * 4 + 1] = Math.sin(angle / 2)
  rotation[row * 4 + 2] = 0
  rotation[row * 4 + 3] = Math.cos(angle / 2)
  scale[row * 3] = width
  scale[row * 3 + 1] = height
  scale[row * 3 + 2] = thick
  table.markChanged(Transform, row)
  const angles = table.column(DoorLeaf, 'angle') as Float32Array
  angles[row] = rec.open
}

/** Door leaves wear the frame's material, or their wall's. Runs on edits, not while swinging. */
function dressLeaf(state: StructureState, opening: Entity): void {
  const rec = state.openings.get(opening)
  const world = state.world
  if (rec?.kind !== 'door' || rec.leaf === null || !world.isAlive(rec.leaf)) return
  const material = state.materialRef(rec.frameMaterial || FRAME_KEY)
  const current = world.get(rec.leaf, MeshMaterial).material as MaterialRef | null
  if (current?.guid !== material.guid || current?.path !== material.path)
    world.set(rec.leaf, MeshMaterial, { material })
}

// ---------------------------------------------------------------------------
// Cutouts (0067)

function forgetCutout(state: StructureState, entity: Entity): void {
  const rec = state.cutouts.get(entity)
  if (!rec) return
  dropLeaf(state, entity)
  state.byHost.get(rec.host)?.delete(entity)
  if (state.slabs.has(rec.host)) state.dirtySlabs.add(rec.host)
  state.cutouts.delete(entity)
  state.cutoutWarned.delete(entity)
}

/** Reads a changed cutout. Its outline, kind or frame dirties its host(s); its state only swings. */
function readCutout(state: StructureState, entity: Entity): void {
  const world = state.world
  const v = world.get(entity, Cutout)
  const host = (v.host ?? -1) as Entity
  const frameMaterial = state.materialKey(v.frameMaterial as MaterialRef | null)
  const target = v.kind === 'hatch' && v.state === 'open' ? 1 : 0
  const points = new Float64Array(v.points.length * 2)
  for (let i = 0; i < v.points.length; i++) {
    points[i * 2] = v.points[i]![0]!
    points[i * 2 + 1] = v.points[i]![1]!
  }
  let rec = state.cutouts.get(entity)
  if (!rec) {
    rec = {
      host,
      kind: v.kind,
      points,
      frameWidth: v.frameWidth,
      frameDepth: v.frameDepth,
      frameMaterial,
      hinge: v.hinge,
      state: v.state,
      ring: -1,
      leaf: null,
      mesh: null,
      meshRef: null,
      pivot: [0, 0, 0, 1, 0, 0, 1],
      open: target,
      target,
    }
    state.cutouts.set(entity, rec)
    hostSet(state.byHost, host).add(entity)
    state.dirtySlabs.add(host)
    return
  }
  let samePoints = rec.points.length === points.length
  for (let i = 0; samePoints && i < points.length; i++) samePoints = rec.points[i] === points[i]
  const geometry =
    rec.host !== host ||
    rec.kind !== v.kind ||
    !samePoints ||
    rec.frameWidth !== v.frameWidth ||
    rec.frameDepth !== v.frameDepth ||
    rec.frameMaterial !== frameMaterial
  if (geometry) {
    state.dirtySlabs.add(rec.host)
    if (rec.host !== host) {
      state.byHost.get(rec.host)?.delete(entity)
      hostSet(state.byHost, host).add(entity)
      state.dirtySlabs.add(host)
    }
    if (rec.kind !== v.kind) dropLeaf(state, entity)
  }
  const rehinge = !geometry && rec.hinge !== v.hinge
  rec.host = host
  rec.kind = v.kind
  rec.points = points
  rec.frameWidth = v.frameWidth
  rec.frameDepth = v.frameDepth
  rec.frameMaterial = frameMaterial
  rec.hinge = v.hinge
  rec.state = v.state
  // A new hinge is a new leaf mesh (it's built around its hinge), not a host rebuild.
  if (rehinge) {
    const slab = state.slabs.get(host)
    if (slab && rec.ring > 0) buildLeaf(state, entity, slab)
  }
  if (rec.target !== target) {
    rec.target = target
    if (state.world.resource(StructureSettings).reducedMotion) {
      rec.open = target
      placeHatch(state, entity)
    } else state.moving.add(entity)
  }
}

/** Despawns a cutout's leaf or pane and frees its mesh. */
function dropLeaf(state: StructureState, entity: Entity): void {
  const rec = state.cutouts.get(entity)
  if (!rec) return
  const world = state.world
  if (rec.leaf !== null && world.isAlive(rec.leaf)) world.despawn(rec.leaf)
  if (rec.mesh) {
    world.tryResource(GpuAssetsResource)?.releaseMesh(rec.mesh)
    world.resource(Meshes).delete(rec.meshRef!.guid!)
  }
  rec.leaf = null
  rec.mesh = null
  rec.meshRef = null
  state.moving.delete(entity)
}

const leafBuilder = new MeshBuilder()

/**
 * Builds a hatch's leaf (the hole's shape, flush with the surface, hinged on its `hinge` edge) or a
 * skylight's pane (glass across the hole), and puts it in place. Holes have neither.
 */
function buildLeaf(state: StructureState, entity: Entity, host: SlabRecord): void {
  const rec = state.cutouts.get(entity)!
  if (rec.kind === 'hole') {
    dropLeaf(state, entity)
    return
  }
  const world = state.world
  const f = host.shape
  const hatch = rec.kind === 'hatch'
  const leafShape = hatch
    ? ringShape(f, rec.ring, f.thickness > 0 ? Math.min(f.thickness, 0.06) : 0.04)
    : ringShape(f, rec.ring, 0, f.thickness > 0 ? Math.min(f.thickness / 2, 0.02) : 0.005)
  const b = leafBuilder
  b.reset()
  emitFloor(leafShape, -Infinity, -Infinity, Infinity, Infinity, b, state.scratch)
  // A hatch's mesh is built around its hinge's first point, so a rotation about the hinge swings it.
  const count = rec.points.length / 2
  const i = rec.hinge % count
  const j = (i + 1) % count
  const hx = rec.points[i * 2]!
  const hz = rec.points[i * 2 + 1]!
  const hy = slabY(f, hx, hz)
  const pivot = rec.pivot
  if (hatch) {
    const ex = rec.points[j * 2]! - hx
    const ez = rec.points[j * 2 + 1]! - hz
    const ey = slabY(f, hx + ex, hz + ez) - hy
    const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1
    // Swing the side away from the hinge up: the sign that lifts the leaf's centre.
    // Rotating about e moves the centre c along e × c, whose y is ez·cx − ex·cz.
    let cx = 0
    let cz = 0
    for (let k = 0; k < count; k++) {
      cx += rec.points[k * 2]! - hx
      cz += rec.points[k * 2 + 1]! - hz
    }
    const lift = (ez / el) * cx - (ex / el) * cz
    pivot[0] = hx
    pivot[1] = hy
    pivot[2] = hz
    pivot[3] = ex / el
    pivot[4] = ey / el
    pivot[5] = ez / el
    pivot[6] = lift >= 0 ? 1 : -1
    const p = b.positions
    for (let k = 0; k < b.vertexCount; k++) {
      p[k * 3] = p[k * 3]! - hx
      p[k * 3 + 1] = p[k * 3 + 1]! - hy
      p[k * 3 + 2] = p[k * 3 + 2]! - hz
    }
  } else {
    pivot[0] = pivot[1] = pivot[2] = 0
    pivot[3] = 1
    pivot[4] = pivot[5] = 0
    pivot[6] = 1
  }
  const data = meshData(b)
  if (rec.mesh) rec.mesh.update(data)
  else {
    rec.mesh = Mesh.create(data)
    rec.meshRef = world
      .resource(Meshes)
      .add(rec.mesh, `structure:${rec.kind}/${entity}`) as AssetRef<'Mesh'>
  }
  const material = hatch ? state.materialRef(rec.frameMaterial || FRAME_KEY) : state.glassMaterial!
  if (rec.leaf === null || !world.isAlive(rec.leaf)) {
    rec.leaf = world.spawn(
      [Mesh3d, { mesh: rec.meshRef! }],
      [MeshMaterial, { material }],
      [DoorLeaf, { opening: entity, angle: rec.open }],
      [ChildOf, { parent: host.group }],
      Transform,
      Derived,
    )
    if (!hatch) {
      world.add(rec.leaf, WindowPane)
      world.add(rec.leaf, NotShadowCaster)
    }
    if (host.cutaway) world.add(rec.leaf, Cutaway)
  } else {
    parentTo(state, rec.leaf, host.group)
    const current = world.get(rec.leaf, MeshMaterial).material as MaterialRef | null
    if (current?.guid !== material.guid || current?.path !== material.path)
      world.set(rec.leaf, MeshMaterial, { material })
  }
  placeHatch(state, entity)
}

/** Puts a hatch leaf at its hinge, turned up by how far open it is (a pane stays put). */
function placeHatch(state: StructureState, entity: Entity): void {
  const rec = state.cutouts.get(entity)
  const world = state.world
  if (!rec || rec.leaf === null || !world.isAlive(rec.leaf)) return
  const table = world.entityTable(rec.leaf)
  const row = world.entityRow(rec.leaf)
  const p = rec.pivot
  const half = (p[6]! * rec.open * HALF_PI) / 2
  const s = Math.sin(half)
  const translation = table.column(Transform, 'translation') as Float32Array
  const rotation = table.column(Transform, 'rotation') as Float32Array
  translation[row * 3] = p[0]!
  translation[row * 3 + 1] = p[1]!
  translation[row * 3 + 2] = p[2]!
  rotation[row * 4] = p[3]! * s
  rotation[row * 4 + 1] = p[4]! * s
  rotation[row * 4 + 2] = p[5]! * s
  rotation[row * 4 + 3] = Math.cos(half)
  table.markChanged(Transform, row)
  const angles = table.column(DoorLeaf, 'angle') as Float32Array
  angles[row] = rec.open
}

// ---------------------------------------------------------------------------
// Chunks

/** Rebuilds one (group, chunk)'s per-material meshes from the walls and slabs overlapping it. */
function rebuildChunk(state: StructureState, key: number): number {
  const world = state.world
  const chunk = state.chunks.get(key)
  if (!chunk) return 0
  const size = state.chunkSize
  const minX = chunk.x * size
  const minZ = chunk.z * size
  const maxX = minX + size
  const maxZ = minZ + size
  for (const b of state.builders.values()) b.reset()
  // Cutaway walls (0070) build apart from floors of the same material.
  const wallKey = state.cutawayWalls ? WALL_KEY : ''
  for (const entity of chunk.walls) {
    const rec = state.walls.get(entity)
    if (!rec) continue
    emitWall(
      rec.shape,
      rec.pieces,
      rec.count,
      minX,
      minZ,
      maxX,
      maxZ,
      (i) => state.builder(wallKey + rec.pieceMaterials[i]!),
      state.scratch,
    )
  }
  let shadowWhenHidden = false
  let cutawayRoof = false
  for (const entity of chunk.slabs) {
    const rec = state.slabs.get(entity)
    if (!rec) continue
    if (rec.shadowWhenHidden) shadowWhenHidden = true
    if (rec.cutaway) cutawayRoof = true
    emitFloor(rec.shape, minX, minZ, maxX, maxZ, state.builder(rec.material), state.scratch, (k) =>
      state.builder(rec.frameMaterials[k]!),
    )
  }
  let rebuilt = 0
  const meshes = world.resource(Meshes)
  for (const [material, b] of state.builders) {
    const existing = chunk.meshes.get(material)
    if (b.vertexCount === 0) continue
    const data = meshData(b)
    if (existing && world.isAlive(existing.entity)) {
      existing.mesh.update(data)
      existing.triangles = b.indexCount / 3
    } else {
      if (existing) dropChunkMesh(world, existing)
      const mesh = Mesh.create(data)
      const ref = meshes.add(
        mesh,
        `structure:chunk/${chunk.group}/${chunk.x},${chunk.z}/${material || 'default'}`,
      ) as AssetRef<'Mesh'>
      const entity = world.spawn(
        [Mesh3d, { mesh: ref }],
        [MeshMaterial, { material: state.materialRef(materialOf(material)) }],
        [StructureChunk, { group: chunk.group, x: chunk.x, z: chunk.z }],
        [ChildOf, { parent: chunk.group }],
        Transform,
        Derived,
      )
      if (shadowWhenHidden) world.add(entity, ShadowWhenHidden)
      if (cutawayRoof || material.startsWith(WALL_KEY)) world.add(entity, Cutaway)
      chunk.meshes.set(material, { entity, mesh, ref, triangles: b.indexCount / 3 })
    }
    rebuilt++
  }
  // Materials this chunk no longer has.
  for (const [material, cm] of chunk.meshes) {
    if ((state.builders.get(material)?.vertexCount ?? 0) > 0) continue
    dropChunkMesh(world, cm)
    chunk.meshes.delete(material)
  }
  rebuildContact(state, chunk)
  dropIfEmpty(state, key, chunk)
  return rebuilt
}

function dropIfEmpty(state: StructureState, key: number, chunk: ChunkRecord): void {
  if (
    chunk.walls.size === 0 &&
    chunk.slabs.size === 0 &&
    chunk.meshes.size === 0 &&
    chunk.contacts.size === 0 &&
    chunk.contact === null
  )
    state.chunks.delete(key)
}

// ---------------------------------------------------------------------------
// Contact shade (0068)

/** Queues the walls in these (group, chunk) keys for a contact recompute (joints may change). */
function queueContactNear(state: StructureState, keys: Set<number>): void {
  if (!state.contact.enabled) return
  for (const key of keys) {
    const chunk = state.chunks.get(key)
    if (chunk) for (const w of chunk.walls) state.contactWalls.add(w)
  }
}

/** Queues the walls in `group` within floorReach of a floor's outline for a contact recompute. */
function queueContactArea(state: StructureState, group: Entity, f: FloorShape): void {
  if (!state.contact.enabled) return
  const size = state.chunkSize
  const r = state.contact.floorReach + 0.1
  for (let x = Math.floor((f.minX - r) / size); x <= Math.floor((f.maxX + r) / size); x++)
    for (let z = Math.floor((f.minZ - r) / size); z <= Math.floor((f.maxZ + r) / size); z++) {
      const chunk = state.chunks.get(state.chunkOf(group, chunkKey(x, z)))
      if (chunk) for (const w of chunk.walls) state.contactWalls.add(w)
    }
}

/** A wall's surroundings for contactQuads: set `state`, `entity` and `rec` before each call. */
const env = {
  state: undefined as unknown as StructureState,
  entity: -1 as Entity,
  rec: undefined as unknown as WallRecord,
  seen: new Set<Entity>(),
  keys: [0, 0, 0, 0],

  floorTop(x: number, z: number, base: number): number {
    const st = env.state
    const size = st.chunkSize
    const chunk = st.chunks.get(
      st.chunkOf(env.rec.group, chunkKey(Math.floor(x / size), Math.floor(z / size))),
    )
    if (!chunk) return Number.NaN
    let best = Number.NaN
    for (const e of chunk.slabs) {
      const slab = st.slabs.get(e)
      if (slab?.kind !== 'floor') continue
      const f = slab.shape
      if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue
      if (!insideRing(f.points, 0, f.rings[1]!, x, z, false)) continue
      let hole = false
      for (let r = 1; r + 1 < f.rings.length && !hole; r++)
        hole = insideRing(f.points, f.rings[r]!, f.rings[r + 1]!, x, z, true)
      if (hole) continue
      const top = slabY(f, x, z)
      if (Number.isNaN(best) || Math.abs(top - base) < Math.abs(best - base)) best = top
    }
    return best
  },

  joint(end: 0 | 1, out: Float64Array): boolean {
    const st = env.state
    const w = env.rec.shape
    const line = w.line
    const i = end === 0 ? 0 : line.count - 1
    const ex = line.x[i]!
    const ez = line.z[i]!
    // The tangent from the left normal (−tz, tx).
    const tx = line.nz[i]!
    const tz = -line.nx[i]!
    const size = st.chunkSize
    let y0 = Infinity
    let y1 = -Infinity
    let covered = 0
    const seen = env.seen
    seen.clear()
    seen.add(env.entity)
    for (let k = 0; k < 4; k++) {
      const key = st.chunkOf(
        env.rec.group,
        chunkKey(
          Math.floor((ex + (k & 1 ? 0.05 : -0.05)) / size),
          Math.floor((ez + (k & 2 ? 0.05 : -0.05)) / size),
        ),
      )
      env.keys[k] = key
      if (env.keys.indexOf(key) < k) continue
      const chunk = st.chunks.get(key)
      if (!chunk) continue
      for (const o of chunk.walls) {
        if (seen.has(o)) continue
        seen.add(o)
        const other = st.walls.get(o)
        if (!other) continue
        const ol = other.shape.line
        const half = other.shape.thickness / 2
        // The nearest point of its centreline, and the direction there.
        let best = Infinity
        let sx = 0
        let sz = 0
        for (let j = 0; j + 1 < ol.count; j++) {
          const ax = ol.x[j]!
          const az = ol.z[j]!
          const dx = ol.x[j + 1]! - ax
          const dz = ol.z[j + 1]! - az
          const l2 = dx * dx + dz * dz
          const t = l2 > 0 ? Math.min(1, Math.max(0, ((ex - ax) * dx + (ez - az) * dz) / l2)) : 0
          const px = ax + dx * t - ex
          const pz = az + dz * t - ez
          const d = Math.sqrt(px * px + pz * pz)
          if (d < best) {
            best = d
            const l = Math.sqrt(l2) || 1
            sx = dx / l
            sz = dz / l
          }
        }
        if (best > half + 0.02) continue
        // Nearly in line is a continuation, not a corner.
        const sin = Math.abs(tx * sz - tz * sx)
        if (sin < 0.2) continue
        const lo = Math.max(w.elevation, other.shape.elevation)
        const hi = Math.min(w.elevation + w.height, other.shape.elevation + other.shape.height)
        if (hi <= lo) continue
        if (lo < y0) y0 = lo
        if (hi > y1) y1 = hi
        covered = Math.max(covered, (half - best) / sin)
      }
    }
    if (y1 <= y0) return false
    out[0] = y0
    out[1] = y1
    out[2] = covered
    return true
  },
}

/**
 * Recomputes the contact quads of the walls queued this compile, after its walls and slabs: a wall
 * whose quads changed marks its old and new contact chunks.
 */
function updateContacts(state: StructureState): void {
  if (!state.contact.enabled) {
    state.contactWalls.clear()
    return
  }
  const scratch = state.contactScratch
  const list = state.sortedOpenings
  env.state = state
  for (const e of state.contactWalls) {
    const rec = state.walls.get(e)
    if (!rec) continue
    list.length = 0
    for (const o of state.byWall.get(e) ?? []) {
      const r = state.openings.get(o)
      if (r) list.push(r)
    }
    list.sort((p, q) => p.offset - q.offset)
    env.entity = e
    env.rec = rec
    contactQuads(rec.shape, list, state.contact, env, scratch)
    if (rec.contact.equals(scratch) && sameGroup(state, rec)) continue
    for (const key of rec.contactChunks) {
      state.dirtyContact.add(key)
      state.chunks.get(key)?.contacts.delete(e)
    }
    rec.contact.copy(scratch)
    contactChunks(rec.contact, state.chunkSize, state.overlap)
    groupKeys(state, rec.group, rec.contactChunks)
    for (const key of rec.contactChunks) {
      state.chunk(key).contacts.add(e)
      state.dirtyContact.add(key)
    }
  }
  state.contactWalls.clear()
}

/** Whether a wall's contact chunks are in its current group (a level change moves them). */
function sameGroup(state: StructureState, rec: WallRecord): boolean {
  for (const key of rec.contactChunks)
    return state.groups[Math.floor(key / GROUP_STRIDE)] === rec.group
  return true
}

/** Rebuilds a (group, chunk)'s contact mesh from the walls with contact quads in it. */
function rebuildContact(state: StructureState, chunk: ChunkRecord): void {
  const world = state.world
  const b = state.contactBuilder
  b.reset()
  if (state.contact.enabled) {
    const size = state.chunkSize
    const minX = chunk.x * size
    const minZ = chunk.z * size
    for (const e of chunk.contacts) {
      const rec = state.walls.get(e)
      if (rec) emitContact(rec.contact, minX, minZ, minX + size, minZ + size, b)
    }
  }
  const cm = chunk.contact
  if (b.vertexCount === 0) {
    if (cm) dropChunkMesh(world, cm)
    chunk.contact = null
    return
  }
  const data = meshData(b)
  if (cm && world.isAlive(cm.entity)) {
    cm.mesh.update(data)
    cm.triangles = b.indexCount / 3
    return
  }
  if (cm) dropChunkMesh(world, cm)
  const mesh = Mesh.create(data)
  const ref = world
    .resource(Meshes)
    .add(mesh, `structure:contact/${chunk.group}/${chunk.x},${chunk.z}`) as AssetRef<'Mesh'>
  const entity = world.spawn(
    [Mesh3d, { mesh: ref }],
    [MeshMaterial, { material: state.contactMaterial! }],
    [StructureChunk, { group: chunk.group, x: chunk.x, z: chunk.z }],
    [ChildOf, { parent: chunk.group }],
    ContactMesh,
    NotShadowCaster,
    Transform,
    Derived,
  )
  chunk.contact = { entity, mesh, ref, triangles: b.indexCount / 3 }
}

/** Contact off: every contact mesh goes, and every wall forgets its quads. */
function dropContacts(state: StructureState): void {
  for (const [key, chunk] of state.chunks) {
    if (chunk.contact) dropChunkMesh(state.world, chunk.contact)
    chunk.contact = null
    chunk.contacts.clear()
    dropIfEmpty(state, key, chunk)
  }
  for (const rec of state.walls.values()) {
    rec.contact.reset()
    rec.contactChunks.clear()
  }
  state.dirtyContact.clear()
  state.contactWalls.clear()
}

/**
 * Brings `StructureSettings.contact` in: a patch that replaced it with only some fields is merged
 * over the values before. Returns whether anything differs from what was applied.
 */
function contactSettingsChanged(state: StructureState, settings: { contact: ContactSettings }) {
  let c = settings.contact
  if (c !== state.contactSeen) {
    c = { ...state.contact, ...c }
    settings.contact = c
    state.contactSeen = c
  }
  const a = state.contact
  return (
    c.enabled !== a.enabled ||
    c.floorReach !== a.floorReach ||
    c.cornerReach !== a.cornerReach ||
    c.opacity !== a.opacity ||
    c.maxAlpha !== a.maxAlpha ||
    c.wobble !== a.wobble ||
    c.color[0] !== a.color[0] ||
    c.color[1] !== a.color[1] ||
    c.color[2] !== a.color[2]
  )
}

/** Applies changed contact settings: a look change sets the material; the rest rebuild contact. */
function applyContactSettings(state: StructureState, next: ContactSettings): void {
  const prev = state.contact
  state.contact = { ...next, color: [next.color[0], next.color[1], next.color[2]] }
  const material = state.contactMaterial
    ? state.world.resource(Materials).get(state.contactMaterial)
    : undefined
  material?.set({
    opacity: next.opacity,
    maxAlpha: next.maxAlpha,
    color: [next.color[0], next.color[1], next.color[2]],
    wobble: next.wobble,
  })
  if (!next.enabled) {
    if (prev.enabled) dropContacts(state)
    return
  }
  if (!prev.enabled || prev.floorReach !== next.floorReach || prev.cornerReach !== next.cornerReach)
    for (const e of state.walls.keys()) state.contactWalls.add(e)
}

function dropChunkMesh(world: World, cm: ChunkMesh): void {
  if (world.isAlive(cm.entity)) world.despawn(cm.entity)
  world.tryResource(GpuAssetsResource)?.releaseMesh(cm.mesh)
  world.resource(Meshes).delete(cm.ref.guid!)
}

function meshData(b: MeshBuilder): MeshData {
  const v = b.vertexCount
  return {
    positions: b.positions.slice(0, v * 3),
    normals: b.normals.slice(0, v * 3),
    uvs: b.uvs.slice(0, v * 2),
    tangents: b.tangents.slice(0, v * 4),
    indices:
      v < 65536
        ? Uint16Array.from(b.indices.subarray(0, b.indexCount))
        : b.indices.slice(0, b.indexCount),
  }
}

/**
 * Walls turn cutaway or back (0070): every chunk with walls rebuilds, splitting wall pieces from
 * floors (or merging them back), and door leaves and window panes are tagged to match.
 */
function applyCutawayWalls(state: StructureState, on: boolean): void {
  state.cutawayWalls = on
  for (const [key, chunk] of state.chunks) if (chunk.walls.size > 0) state.dirtyChunks.add(key)
  for (const rec of state.openings.values()) setTag(state, rec.leaf, Cutaway, on)
}

/** Every chunk mesh goes, and every wall and slab is placed again (the chunk size changed). */
function resetChunks(state: StructureState): void {
  for (const chunk of state.chunks.values()) {
    for (const cm of chunk.meshes.values()) dropChunkMesh(state.world, cm)
    if (chunk.contact) dropChunkMesh(state.world, chunk.contact)
  }
  state.chunks.clear()
  state.dirtyContact.clear()
  for (const [entity, rec] of state.walls) {
    rec.chunks.clear()
    rec.contact.reset()
    rec.contactChunks.clear()
    state.dirtyWalls.add(entity)
  }
  for (const [entity, rec] of state.slabs) {
    rec.chunks.clear()
    state.dirtySlabs.add(entity)
  }
}

/**
 * Dirties every wall and slab that names `level` (it moved, appeared or went away), including
 * those drawn on the ground level while it had no Level.
 */
function dirtyLevel(state: StructureState, level: Entity): void {
  for (const [e, rec] of state.walls) if (rec.level === level) state.dirtyWalls.add(e)
  for (const [e, rec] of state.slabs) if (rec.level === level) state.dirtySlabs.add(e)
}

/**
 * The compile: gathers walls, openings, floors, roofs, cutouts and levels changed since its last
 * run (plus despawns), marks the (group, chunk) pairs their old and new geometry overlap, and
 * rebuilds exactly those. A door's or hatch's `state` marks nothing. Allocates nothing when
 * nothing changed.
 */
export const compileStructure = defineSystem({
  name: 'structure/compile',
  description:
    'Rebuilds the chunk meshes that changed walls, openings, floors, roofs and cutouts overlap (old and new geometry), per group.',
  setup: (world) => ({
    walls: world.query({ with: [Wall] }),
    floors: world.query({ with: [Floor] }),
    roofs: world.query({ with: [Roof] }),
    openings: world.query({ with: [Opening] }),
    cutouts: world.query({ with: [Cutout] }),
    levels: world.query({ with: [Level] }),
  }),
  run: ({ walls, floors, roofs, openings, cutouts, levels }, world, ctx) => {
    const state = world.resource(Structure)
    const since = ctx.lastRunTick
    const settings = world.resource(StructureSettings)
    const size = settings.chunkSize
    const tolerance = settings.curveTolerance
    const contact = contactSettingsChanged(state, settings)
    const cutawayWalls = settings.cutawayWalls === true
    let any =
      contact ||
      cutawayWalls !== state.cutawayWalls ||
      state.removedWalls.length +
        state.removedSlabs.length +
        state.removedOpenings.length +
        state.removedCutouts.length +
        state.removedLevels.length >
        0 ||
      size !== state.chunkSize ||
      tolerance !== state.curveTolerance
    if (!any) {
      for (let t = 0; t < walls.tables.length && !any; t++)
        if (walls.tables[t]!.lastChanged(Wall) > since) any = true
      for (let t = 0; t < floors.tables.length && !any; t++)
        if (floors.tables[t]!.lastChanged(Floor) > since) any = true
      for (let t = 0; t < roofs.tables.length && !any; t++)
        if (roofs.tables[t]!.lastChanged(Roof) > since) any = true
      for (let t = 0; t < openings.tables.length && !any; t++)
        if (openings.tables[t]!.lastChanged(Opening) > since) any = true
      for (let t = 0; t < cutouts.tables.length && !any; t++)
        if (cutouts.tables[t]!.lastChanged(Cutout) > since) any = true
      for (let t = 0; t < levels.tables.length && !any; t++)
        if (levels.tables[t]!.lastChanged(Level) > since) any = true
    }
    if (!any) return
    const start = performance.now()
    if (contact) applyContactSettings(state, settings.contact)
    if (cutawayWalls !== state.cutawayWalls) applyCutawayWalls(state, cutawayWalls)
    if (size !== state.chunkSize || tolerance !== state.curveTolerance) {
      state.chunkSize = size
      state.curveTolerance = tolerance
      resetChunks(state)
    }
    // Despawns first: an entity removed and added back this frame reads as new below.
    for (const e of state.removedOpenings) forgetOpening(state, e)
    state.removedOpenings.length = 0
    for (const e of state.removedCutouts) forgetCutout(state, e)
    state.removedCutouts.length = 0
    for (const e of state.removedWalls) {
      const rec = state.walls.get(e)
      if (!rec) continue
      markChunks(state, rec.chunks)
      queueContactNear(state, rec.chunks)
      for (const key of rec.chunks) state.chunks.get(key)?.walls.delete(e)
      for (const key of rec.contactChunks) {
        state.dirtyContact.add(key)
        state.chunks.get(key)?.contacts.delete(e)
      }
      state.walls.delete(e)
      for (const o of state.byWall.get(e) ?? []) placeLeaf(state, o)
    }
    state.removedWalls.length = 0
    for (const e of state.removedSlabs) {
      const rec = state.slabs.get(e)
      if (!rec) continue
      markChunks(state, rec.chunks)
      if (rec.kind === 'floor') queueContactArea(state, rec.group, rec.shape)
      for (const key of rec.chunks) state.chunks.get(key)?.slabs.delete(e)
      for (const key of rec.index) state.roofIndex.get(key)?.delete(e)
      state.slabs.delete(e)
      for (const c of state.byHost.get(e) ?? []) dropLeaf(state, c)
    }
    state.removedSlabs.length = 0
    for (const e of state.removedLevels) {
      state.levels.delete(e)
      dirtyLevel(state, e)
    }
    state.removedLevels.length = 0
    // Levels: a new one, or one whose elevation moved, moves everything on it.
    for (const table of levels.tables) {
      if (table.lastChanged(Level) <= since) continue
      const ticks = table.changedTicks(Level)
      const elevations = table.column(Level, 'elevation')
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! <= since) continue
        const e = table.entities[row]! as Entity
        const elevation = elevations[row]!
        if (state.levels.get(e) === elevation) continue
        state.levels.set(e, elevation)
        dirtyLevel(state, e)
      }
    }
    for (const table of openings.tables) {
      if (table.lastChanged(Opening) <= since) continue
      const ticks = table.changedTicks(Opening)
      for (let row = 0; row < table.count; row++)
        if (ticks[row]! > since) readOpening(state, table.entities[row]! as Entity)
    }
    for (const table of cutouts.tables) {
      if (table.lastChanged(Cutout) <= since) continue
      const ticks = table.changedTicks(Cutout)
      for (let row = 0; row < table.count; row++)
        if (ticks[row]! > since) readCutout(state, table.entities[row]! as Entity)
    }
    for (const table of walls.tables) {
      if (table.lastChanged(Wall) <= since) continue
      const ticks = table.changedTicks(Wall)
      for (let row = 0; row < table.count; row++)
        if (ticks[row]! > since) state.dirtyWalls.add(table.entities[row]! as Entity)
    }
    for (const q of [floors, roofs]) {
      const def = q === floors ? Floor : Roof
      for (const table of q.tables) {
        if (table.lastChanged(def) <= since) continue
        const ticks = table.changedTicks(def)
        for (let row = 0; row < table.count; row++)
          if (ticks[row]! > since) state.dirtySlabs.add(table.entities[row]! as Entity)
      }
    }
    for (const e of state.dirtyWalls)
      if (world.isAlive(e) && world.has(e, Wall)) evaluateWall(state, e)
    state.dirtyWalls.clear()
    for (const e of state.dirtySlabs)
      if (world.isAlive(e) && (world.has(e, Floor) || world.has(e, Roof))) evaluateSlab(state, e)
    state.dirtySlabs.clear()
    updateContacts(state)
    if (state.dirtyChunks.size === 0 && state.dirtyContact.size === 0) return
    const dirty: [number, number][] = []
    const groups: Entity[] = []
    let meshes = 0
    const keys = [...state.dirtyChunks].sort((a, b) => a - b)
    for (const key of keys) {
      const group = state.groups[Math.floor(key / GROUP_STRIDE)]!
      meshes += rebuildChunk(state, key)
      const plain = key % GROUP_STRIDE
      dirty.push([chunkX(plain), chunkZ(plain)])
      groups.push(group)
    }
    // Chunks whose contact mesh alone changed: a floor edit near walls, a contact setting.
    const contactDirty: [number, number][] = []
    for (const key of state.dirtyContact) {
      if (state.dirtyChunks.has(key)) continue
      const chunk = state.chunks.get(key)
      if (!chunk) continue
      rebuildContact(state, chunk)
      dropIfEmpty(state, key, chunk)
      contactDirty.push([chunk.x, chunk.z])
    }
    state.dirtyContact.clear()
    state.dirtyChunks.clear()
    state.last = {
      dirtyChunks: dirty,
      dirtyGroups: groups,
      chunksRebuilt: dirty.length,
      meshesRebuilt: meshes,
      contactRebuilt: contactDirty.length,
      contactChunks: contactDirty,
      ms: performance.now() - start,
    }
    state.chunksRebuilt += dirty.length
    state.compiles++
    const stats = world.tryResource(RenderStats)
    if (stats) stats.current.chunksRebuilt += dirty.length
  },
})

/**
 * The roof whose footprint contains (x, z), through the roofs indexed at that chunk: on an edge
 * counts, and a point over one of its holes still counts. With `level` (null: the ground level),
 * only roofs on that level. Ties go to the lowest entity. A host hides the roofs its viewer's
 * tokens stand under.
 */
export function roofAt(
  world: World,
  x: number,
  z: number,
  level?: Entity | null,
): Entity | undefined {
  const state = world.resource(Structure)
  const size = state.chunkSize || world.resource(StructureSettings).chunkSize
  const set = state.roofIndex.get(chunkKey(Math.floor(x / size), Math.floor(z / size)))
  if (!set) return undefined
  let best: Entity | undefined
  for (const e of set) {
    if (best !== undefined && e > best) continue
    const rec = state.slabs.get(e)
    if (!rec) continue
    if (level !== undefined) {
      const on = state.groupOf(rec.level) === state.ground ? null : rec.level
      if (on !== level) continue
    }
    const p = rec.shape.points
    if (insideRing(p, 0, rec.shape.rings[1]!, x, z, true)) best = e
  }
  return best
}

/** Scratch for `swingDoors`: Set.forEach with a module function allocates nothing per frame. */
let swingState: StructureState
let swingStep = 0

function swingOne(entity: Entity): void {
  const state = swingState
  const rec = state.openings.get(entity) ?? state.cutouts.get(entity)
  if (!rec) {
    state.moving.delete(entity)
    return
  }
  rec.open =
    rec.target > rec.open
      ? Math.min(rec.target, rec.open + swingStep)
      : Math.max(rec.target, rec.open - swingStep)
  if (state.openings.has(entity)) placeLeaf(state, entity)
  else placeHatch(state, entity)
  if (rec.open === rec.target) state.moving.delete(entity)
}

/**
 * Swings door and hatch leaves toward their state over `doorSwingMs` (at once with
 * `reducedMotion`), holding a frame demand while any moves.
 */
export const swingDoors = defineSystem({
  name: 'structure/doors',
  description:
    'Animates door and hatch leaves toward open or closed, holding a frame demand while they move.',
  run: (_, world) => {
    const state = world.resource(Structure)
    const demand = world.tryResource(FrameDemand)
    if (state.moving.size === 0) {
      demand?.set(DOOR_DEMAND, false)
      return
    }
    const settings = world.resource(StructureSettings)
    swingState = state
    swingStep = settings.reducedMotion
      ? 1
      : world.resource(Time).delta / Math.max(1e-3, settings.doorSwingMs / 1000)
    state.moving.forEach(swingOne)
    demand?.set(DOOR_DEMAND, state.moving.size > 0)
  },
})
