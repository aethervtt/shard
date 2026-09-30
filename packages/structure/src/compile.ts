import {
  type AssetRef,
  Derived,
  defineResource,
  defineSystem,
  type Entity,
  onRemove,
  type World,
} from '@aethervtt/shard-core'
import { Mesh, type MeshData } from '@aethervtt/shard-mesh'
import {
  GpuAssetsResource,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  RenderStats,
} from '@aethervtt/shard-render'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import {
  DoorLeaf,
  Floor,
  Opening,
  StructureChunk,
  StructureSettings,
  Wall,
  WindowPane,
} from './components'
import {
  ClipScratch,
  chunkX,
  chunkZ,
  emitFloor,
  emitWall,
  type FloorShape,
  floorChunks,
  floorShape,
  MeshBuilder,
  type OpeningShape,
  type Piece,
  type WallShape,
  wallChunks,
  wallLength,
  wallPieces,
} from './geometry'

type MaterialRef = AssetRef<'Material'>

interface WallRecord {
  shape: WallShape
  material: string
  pieces: Piece[]
  count: number
  /** Material key of each piece. */
  pieceMaterials: string[]
  /** Chunks its geometry overlaps. */
  chunks: Set<number>
}

interface FloorRecord {
  shape: FloorShape
  material: string
  chunks: Set<number>
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

interface ChunkMesh {
  entity: Entity
  mesh: Mesh
  ref: AssetRef<'Mesh'>
}

interface ChunkRecord {
  x: number
  z: number
  walls: Set<Entity>
  floors: Set<Entity>
  meshes: Map<string, ChunkMesh>
}

/** What the last compile that did something did (`structure.describe`). */
export interface CompileReport {
  /** Chunks rebuilt, as `[x, z]`. */
  dirtyChunks: [number, number][]
  chunksRebuilt: number
  meshesRebuilt: number
  ms: number
}

/** Frame demand held while a door swings (0052). */
export const DOOR_DEMAND = 'structure/doors'

/**
 * Structure's state: the geometry of every wall, opening and floor, which chunks each overlaps,
 * and the per-material meshes of every chunk. `structure/compile` keeps it current.
 */
export class StructureState {
  readonly walls = new Map<Entity, WallRecord>()
  readonly floors = new Map<Entity, FloorRecord>()
  readonly openings = new Map<Entity, OpeningRecord>()
  /** Openings by host wall entity (including hosts that don't exist yet). */
  readonly byWall = new Map<Entity, Set<Entity>>()
  readonly chunks = new Map<number, ChunkRecord>()
  readonly materials = new Map<string, MaterialRef>()
  /** Doors swinging. */
  readonly moving = new Set<Entity>()
  chunkSize = 0
  last: CompileReport = { dirtyChunks: [], chunksRebuilt: 0, meshesRebuilt: 0, ms: 0 }
  /** Totals since start. */
  chunksRebuilt = 0
  compiles = 0
  defaultMaterial: MaterialRef | undefined
  glassMaterial: MaterialRef | undefined
  leafMesh: AssetRef<'Mesh'> | undefined
  readonly removedWalls: Entity[] = []
  readonly removedFloors: Entity[] = []
  readonly removedOpenings: Entity[] = []
  readonly dirtyWalls = new Set<Entity>()
  readonly dirtyFloors = new Set<Entity>()
  readonly dirtyChunks = new Set<number>()
  readonly builders = new Map<string, MeshBuilder>()
  readonly scratch = new ClipScratch()
  readonly overlap = new Set<number>()
  readonly sortedOpenings: OpeningShape[] = []
  readonly world: World

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

  chunk(key: number): ChunkRecord {
    let c = this.chunks.get(key)
    if (!c) {
      c = { x: chunkX(key), z: chunkZ(key), walls: new Set(), floors: new Set(), meshes: new Map() }
      this.chunks.set(key, c)
    }
    return c
  }

  /** Counts for `structure.describe`. */
  describe() {
    const size = this.chunkSize
    let meshes = 0
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    const perChunk: { chunk: [number, number]; walls: number; floors: number; meshes: number }[] =
      []
    for (const c of this.chunks.values()) {
      meshes += c.meshes.size
      if (c.x < minX) minX = c.x
      if (c.z < minZ) minZ = c.z
      if (c.x > maxX) maxX = c.x
      if (c.z > maxZ) maxZ = c.z
      perChunk.push({
        chunk: [c.x, c.z],
        walls: c.walls.size,
        floors: c.floors.size,
        meshes: c.meshes.size,
      })
    }
    perChunk.sort((a, b) => a.chunk[0] - b.chunk[0] || a.chunk[1] - b.chunk[1])
    return {
      walls: this.walls.size,
      openings: this.openings.size,
      floors: this.floors.size,
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
      perChunk,
      doorsMoving: this.moving.size,
      lastCompile: this.last,
      totals: { compiles: this.compiles, chunksRebuilt: this.chunksRebuilt },
    }
  }
}

export const Structure = defineResource<StructureState>('structure/State', {
  description: 'Walls, openings, floors and the chunk meshes structure compile keeps for them.',
})

/** Records despawns and removals for the next compile (observers fire before the value goes). */
export function observeRemovals(world: World, state: StructureState): void {
  world.observe(onRemove(Wall), ({ entity }) => {
    state.removedWalls.push(entity)
  })
  world.observe(onRemove(Floor), ({ entity }) => {
    state.removedFloors.push(entity)
  })
  world.observe(onRemove(Opening), ({ entity }) => {
    state.removedOpenings.push(entity)
  })
}

function wallShape(value: {
  a: number[]
  b: number[]
  height: number
  thickness: number
  elevation: number
}): WallShape {
  return {
    ax: value.a[0]!,
    az: value.a[1]!,
    bx: value.b[0]!,
    bz: value.b[1]!,
    height: value.height,
    thickness: value.thickness,
    elevation: value.elevation,
  }
}

function markChunks(state: StructureState, chunks: Set<number>): void {
  for (const key of chunks) state.dirtyChunks.add(key)
}

/** Recomputes a wall's pieces and chunk set; marks its old and new chunks dirty. */
function evaluateWall(state: StructureState, entity: Entity): void {
  const world = state.world
  const old = state.walls.get(entity)
  if (old) {
    markChunks(state, old.chunks)
    for (const key of old.chunks) state.chunks.get(key)?.walls.delete(entity)
  }
  const value = world.tryGet(entity, Wall)
  if (!value) {
    state.walls.delete(entity)
    return
  }
  const shape = wallShape(value)
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
  }
  rec.shape = shape
  rec.material = material
  rec.count = wallPieces(shape, list, rec.pieces)
  rec.pieceMaterials.length = rec.count
  for (let i = 0; i < rec.count; i++) {
    const p = rec.pieces[i]!
    if (!p.frame) rec.pieceMaterials[i] = material
    else {
      const frame = (list[p.source] as OpeningRecord).frameMaterial
      rec.pieceMaterials[i] = frame || material
    }
  }
  rec.chunks.clear()
  wallChunks(shape, rec.pieces, rec.count, state.chunkSize, rec.chunks, state.scratch)
  for (const key of rec.chunks) state.chunk(key).walls.add(entity)
  markChunks(state, rec.chunks)
  state.walls.set(entity, rec)
  for (const o of ids) {
    placeLeaf(state, o)
    dressLeaf(state, o)
  }
}

function evaluateFloor(state: StructureState, entity: Entity): void {
  const old = state.floors.get(entity)
  if (old) {
    markChunks(state, old.chunks)
    for (const key of old.chunks) state.chunks.get(key)?.floors.delete(entity)
  }
  const value = state.world.tryGet(entity, Floor)
  if (!value || value.points.length < 3) {
    state.floors.delete(entity)
    return
  }
  const rec: FloorRecord = {
    shape: floorShape(value.points, value.elevation),
    material: state.materialKey(value.material as MaterialRef | null),
    chunks: old?.chunks ?? new Set(),
  }
  rec.chunks.clear()
  floorChunks(rec.shape, state.chunkSize, rec.chunks, state.scratch)
  for (const key of rec.chunks) state.chunk(key).floors.add(entity)
  markChunks(state, rec.chunks)
  state.floors.set(entity, rec)
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
    hostSet(state, wall).add(entity)
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
      hostSet(state, wall).add(entity)
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

function hostSet(state: StructureState, wall: Entity): Set<Entity> {
  let set = state.byWall.get(wall)
  if (!set) {
    set = new Set()
    state.byWall.set(wall, set)
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
    Transform,
    Derived,
  )
  if (rec.kind === 'window') {
    world.add(leaf, WindowPane)
    world.add(leaf, NotShadowCaster)
  }
  rec.leaf = leaf
  placeLeaf(state, opening)
  dressLeaf(state, opening)
}

const HALF_PI = Math.PI / 2

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
  const dx = (s.bx - s.ax) / len
  const dz = (s.bz - s.az) / len
  const o0 = Math.max(0, Math.min(len, rec.offset))
  const o1 = Math.max(o0, Math.min(len, rec.offset + rec.width))
  const fw = Math.max(0, Math.min(rec.frameWidth, (o1 - o0) / 2))
  const head = Math.min(s.height, rec.sill + rec.height)
  const bottom = rec.sill + (rec.kind === 'window' ? fw : 0)
  const width = Math.max(0, o1 - o0 - 2 * fw)
  const height = Math.max(0, head - fw - bottom)
  const thick = rec.kind === 'window' ? Math.min(0.02, s.thickness * 0.2) : s.thickness * 0.4
  const end = rec.kind === 'door' && rec.hinge === 'end'
  const at = end ? o1 - fw : o0 + fw
  // Local +x runs along the wall from the hinge; yaw turns it there, the swing opens it.
  const yaw = end ? Math.atan2(dz, -dx) : Math.atan2(-dz, dx)
  const sign = (rec.swing === 'left') !== end ? 1 : -1
  const angle = yaw + (rec.kind === 'door' ? sign * rec.open * HALF_PI : 0)
  const translation = table.column(Transform, 'translation') as Float32Array
  const rotation = table.column(Transform, 'rotation') as Float32Array
  translation[row * 3] = s.ax + dx * at
  translation[row * 3 + 1] = s.elevation + bottom
  translation[row * 3 + 2] = s.az + dz * at
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
  const wall = state.walls.get(rec.wall)
  const material = state.materialRef(rec.frameMaterial || wall?.material || '')
  const current = world.get(rec.leaf, MeshMaterial).material as MaterialRef | null
  if (current?.guid !== material.guid || current?.path !== material.path)
    world.set(rec.leaf, MeshMaterial, { material })
}

/** Rebuilds one chunk's per-material meshes from the walls and floors overlapping it. */
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
      (i) => state.builder(rec.pieceMaterials[i]!),
      state.scratch,
    )
  }
  for (const entity of chunk.floors) {
    const rec = state.floors.get(entity)
    if (!rec) continue
    emitFloor(rec.shape, minX, minZ, maxX, maxZ, state.builder(rec.material), state.scratch)
  }
  let rebuilt = 0
  const meshes = world.resource(Meshes)
  for (const [material, b] of state.builders) {
    const existing = chunk.meshes.get(material)
    if (b.vertexCount === 0) continue
    const data = meshData(b)
    if (existing) {
      existing.mesh.update(data)
    } else {
      const mesh = Mesh.create(data)
      const ref = meshes.add(
        mesh,
        `structure:chunk/${chunk.x},${chunk.z}/${material || 'default'}`,
      ) as AssetRef<'Mesh'>
      const entity = world.spawn(
        [Mesh3d, { mesh: ref }],
        [MeshMaterial, { material: state.materialRef(material) }],
        [StructureChunk, { x: chunk.x, z: chunk.z }],
        Transform,
        Derived,
      )
      chunk.meshes.set(material, { entity, mesh, ref })
    }
    rebuilt++
  }
  // Materials this chunk no longer has.
  for (const [material, cm] of chunk.meshes) {
    if ((state.builders.get(material)?.vertexCount ?? 0) > 0) continue
    dropChunkMesh(world, cm)
    chunk.meshes.delete(material)
  }
  if (chunk.walls.size === 0 && chunk.floors.size === 0 && chunk.meshes.size === 0)
    state.chunks.delete(key)
  return rebuilt
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
    indices:
      v < 65536
        ? Uint16Array.from(b.indices.subarray(0, b.indexCount))
        : b.indices.slice(0, b.indexCount),
  }
}

/** Every chunk mesh goes, and every wall and floor is placed again (the chunk size changed). */
function resetChunks(state: StructureState): void {
  for (const chunk of state.chunks.values())
    for (const cm of chunk.meshes.values()) dropChunkMesh(state.world, cm)
  state.chunks.clear()
  for (const [entity, rec] of state.walls) {
    rec.chunks.clear()
    state.dirtyWalls.add(entity)
  }
  for (const [entity, rec] of state.floors) {
    rec.chunks.clear()
    state.dirtyFloors.add(entity)
  }
}

/**
 * The compile: gathers walls, openings and floors changed since its last run (plus despawns),
 * marks the chunks their old and new geometry overlap, and rebuilds exactly those. A door's
 * `state` marks nothing. Allocates nothing when nothing changed.
 */
export const compileStructure = defineSystem({
  name: 'structure/compile',
  description:
    'Rebuilds the chunk meshes that changed walls, openings and floors overlap (old and new geometry).',
  setup: (world) => ({
    walls: world.query({ with: [Wall] }),
    floors: world.query({ with: [Floor] }),
    openings: world.query({ with: [Opening] }),
  }),
  run: ({ walls, floors, openings }, world, ctx) => {
    const state = world.resource(Structure)
    const since = ctx.lastRunTick
    const size = world.resource(StructureSettings).chunkSize
    let any =
      state.removedWalls.length + state.removedFloors.length + state.removedOpenings.length > 0 ||
      size !== state.chunkSize
    if (!any) {
      for (let t = 0; t < walls.tables.length && !any; t++)
        if (walls.tables[t]!.lastChanged(Wall) > since) any = true
      for (let t = 0; t < floors.tables.length && !any; t++)
        if (floors.tables[t]!.lastChanged(Floor) > since) any = true
      for (let t = 0; t < openings.tables.length && !any; t++)
        if (openings.tables[t]!.lastChanged(Opening) > since) any = true
    }
    if (!any) return
    const start = performance.now()
    if (size !== state.chunkSize) {
      state.chunkSize = size
      resetChunks(state)
    }
    // Despawns first: an entity removed and added back this frame reads as new below.
    for (const e of state.removedOpenings) forgetOpening(state, e)
    state.removedOpenings.length = 0
    for (const e of state.removedWalls) {
      const rec = state.walls.get(e)
      if (!rec) continue
      markChunks(state, rec.chunks)
      for (const key of rec.chunks) state.chunks.get(key)?.walls.delete(e)
      state.walls.delete(e)
      for (const o of state.byWall.get(e) ?? []) placeLeaf(state, o)
    }
    state.removedWalls.length = 0
    for (const e of state.removedFloors) {
      const rec = state.floors.get(e)
      if (!rec) continue
      markChunks(state, rec.chunks)
      for (const key of rec.chunks) state.chunks.get(key)?.floors.delete(e)
      state.floors.delete(e)
    }
    state.removedFloors.length = 0
    for (const table of openings.tables) {
      if (table.lastChanged(Opening) <= since) continue
      const ticks = table.changedTicks(Opening)
      for (let row = 0; row < table.count; row++)
        if (ticks[row]! > since) readOpening(state, table.entities[row]! as Entity)
    }
    for (const table of walls.tables) {
      if (table.lastChanged(Wall) <= since) continue
      const ticks = table.changedTicks(Wall)
      for (let row = 0; row < table.count; row++)
        if (ticks[row]! > since) state.dirtyWalls.add(table.entities[row]! as Entity)
    }
    for (const table of floors.tables) {
      if (table.lastChanged(Floor) <= since) continue
      const ticks = table.changedTicks(Floor)
      for (let row = 0; row < table.count; row++)
        if (ticks[row]! > since) state.dirtyFloors.add(table.entities[row]! as Entity)
    }
    for (const e of state.dirtyWalls)
      if (world.isAlive(e) && world.has(e, Wall)) evaluateWall(state, e)
    state.dirtyWalls.clear()
    for (const e of state.dirtyFloors)
      if (world.isAlive(e) && world.has(e, Floor)) evaluateFloor(state, e)
    state.dirtyFloors.clear()
    if (state.dirtyChunks.size === 0) return
    const dirty: [number, number][] = []
    let meshes = 0
    const keys = [...state.dirtyChunks].sort((a, b) => a - b)
    for (const key of keys) {
      meshes += rebuildChunk(state, key)
      dirty.push([chunkX(key), chunkZ(key)])
    }
    state.dirtyChunks.clear()
    state.last = {
      dirtyChunks: dirty,
      chunksRebuilt: dirty.length,
      meshesRebuilt: meshes,
      ms: performance.now() - start,
    }
    state.chunksRebuilt += dirty.length
    state.compiles++
    const stats = world.tryResource(RenderStats)
    if (stats) stats.current.chunksRebuilt += dirty.length
  },
})

/** Scratch for `swingDoors`: Set.forEach with a module function allocates nothing per frame. */
let swingState: StructureState
let swingStep = 0

function swingOne(opening: Entity): void {
  const state = swingState
  const rec = state.openings.get(opening)
  if (!rec) {
    state.moving.delete(opening)
    return
  }
  rec.open =
    rec.target > rec.open
      ? Math.min(rec.target, rec.open + swingStep)
      : Math.max(rec.target, rec.open - swingStep)
  placeLeaf(state, opening)
  if (rec.open === rec.target) state.moving.delete(opening)
}

/**
 * Swings door leaves toward their state over `doorSwingMs` (at once with `reducedMotion`),
 * holding a frame demand while any moves.
 */
export const swingDoors = defineSystem({
  name: 'structure/doors',
  description:
    'Animates door leaves toward open or closed, holding a frame demand while they move.',
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
