import { type AssetRef, ChildOf, Derived, type Entity, type World } from '@aethervtt/shard-core'
import { Mesh } from '@aethervtt/shard-mesh'
import { NavSource } from '@aethervtt/shard-nav'
import { Collider, RigidBody } from '@aethervtt/shard-physics'
import { Meshes } from '@aethervtt/shard-render'
import { placeInGrid, propagateSubtree, Transform } from '@aethervtt/shard-transform'
import { COLLIDER_DELAY } from '../colliders'
import { TerrainChunk } from './component'
import { cellOpen, dequantize, LEAF_SIDE, PAGE, pageHasHoles, SIDE } from './kernel'
import { BAND_ANCHOR, keyX, keyZ, nodeKey } from './pages'
import type { HeightfieldRuntime } from './runtime'
import { mainNoise } from './stack'

/** A heightfield collider tile: one leaf page as a fixed body. */
export interface ColliderTile {
  key: number
  x: number
  z: number
  /** The collider entity, or −1 while not wanted. */
  entity: Entity
  /** The terrain version its heights are from. */
  version: number
  used: number
  /** Heights (m), SIDE × SIDE, row by row along +Z: what Rapier gets. */
  heights: number[]
  /**
   * A page with open cells (spec 0120): its trimesh, the closed cells' triangles split as the
   * heightfield's are. Null: a heightfield.
   */
  mesh: AssetRef<'Mesh'> | null
}

/** A terrain's collider tiles, and when the wanted ones are due. */
export class TileSet {
  readonly tiles = new Map<number, ColliderTile>()
  /** Wanted keys → the frame each becomes a tile. */
  readonly due = new Map<number, number>()
  /** Keys wanted this frame, sorted. */
  wanted: number[] = []
  /** Tiles made from a page that had arrived, and baked on the main thread at their due frame. */
  fromPages = 0
  bakedInline = 0
  /** Tiles that are trimeshes because their page has holes (spec 0120). */
  withHoles = 0
}

export function tilesOf(rt: HeightfieldRuntime): TileSet {
  let set = rt.parts.get('colliders') as TileSet | undefined
  if (!set) {
    set = new TileSet()
    rt.parts.set('colliders', set)
  }
  return set
}

const wantedKeys = new Set<number>()

/** Leaf tiles within reach of the runtime's anchors, as sorted keys. */
export function wantedTiles(rt: HeightfieldRuntime): number[] {
  wantedKeys.clear()
  const layout = rt.layout!
  const size = layout.leafSize
  const D = layout.depth
  for (let i = 0; i < rt.anchors; i++) {
    const ax = rt.anchorPos[i * 3]!
    const az = rt.anchorPos[i * 3 + 2]!
    const r = rt.anchorRadius[i]!
    const x0 = Math.max(0, Math.floor((ax - r) / size))
    const x1 = Math.min(layout.leavesX - 1, Math.floor((ax + r) / size))
    const z0 = Math.max(0, Math.floor((az - r) / size))
    const z1 = Math.min(layout.leavesZ - 1, Math.floor((az + r) / size))
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        // The nearest point of the tile's square to the anchor.
        const dx = Math.max(x * size - ax, 0, ax - (x + 1) * size)
        const dz = Math.max(z * size - az, 0, az - (z + 1) * size)
        if (dx * dx + dz * dz <= r * r) wantedKeys.add(nodeKey(D, x, z))
      }
    }
  }
  return [...wantedKeys].sort((a, b) => a - b)
}

/**
 * Keeps a heightfield's collider tiles around its anchors (spec 0071): a leaf page within reach
 * becomes a fixed body with a Rapier heightfield exactly COLLIDER_DELAY frames after it's wanted,
 * from its page when the read has landed and baked here when it hasn't. Both are the same bytes
 * (canonical samples), so the world never depends on IO timing. Unwanted tiles despawn but stay
 * cached (least recently used out).
 */
export function updateHeightfieldColliders(
  world: World,
  rt: HeightfieldRuntime,
  frame: number,
  cacheSize: number,
): void {
  const set = tilesOf(rt)
  const pages = rt.pages
  if (!rt.ready || !pages) return
  const wanted = wantedTiles(rt)
  set.wanted = wanted
  const D = rt.layout!.depth
  for (const key of wanted) {
    const tile = set.tiles.get(key)
    if (tile && tile.version === rt.version) {
      tile.used = frame
      if (tile.entity < 0) spawnTile(world, rt, tile)
      continue
    }
    let due = set.due.get(key)
    if (due === undefined) {
      due = frame + COLLIDER_DELAY
      set.due.set(key, due)
      // Read it now (a near terrain bakes it first of all); it's used if it lands by the due frame.
      void pages.load(D, keyX(key), keyZ(key), BAND_ANCHOR, Number.MAX_VALUE).catch(() => {})
    }
    if (frame < due) continue
    set.due.delete(key)
    const cached = pages.get(key)
    const page = cached ?? pages.leafNow(mainNoise(), rt.stack!, keyX(key), keyZ(key))
    if (cached) set.fromPages++
    else set.bakedInline++
    const heights = tileHeights(rt, page, new Array<number>(SIDE * SIDE))
    if (tile) dropTile(world, set, tile)
    const holes = pageHasHoles(page.control, rt.layout!.cells)
    const next: ColliderTile = {
      key,
      x: keyX(key),
      z: keyZ(key),
      entity: -1 as Entity,
      version: rt.version,
      used: frame,
      heights,
      mesh: holes ? holeMesh(world, rt, heights, page.control) : null,
    }
    if (holes) set.withHoles++
    set.tiles.set(key, next)
    spawnTile(world, rt, next)
  }
  const keep = new Set(wanted)
  for (const key of set.due.keys()) if (!keep.has(key)) set.due.delete(key)
  for (const tile of set.tiles.values())
    if (!keep.has(tile.key) && tile.entity >= 0) despawnTile(world, tile)
  if (set.tiles.size > cacheSize) {
    const idle = [...set.tiles.values()]
      .filter((t) => t.entity < 0)
      .sort((a, b) => a.used - b.used || a.key - b.key)
    for (let i = 0; i < idle.length && set.tiles.size > cacheSize; i++) {
      dropTile(world, set, idle[i]!)
      set.tiles.delete(idle[i]!.key)
    }
  }
}

/**
 * A near terrain's leaves around its anchors (spec 0119): every leaf within an anchor's radius plus
 * a leaf is wanted ahead of its collider tile (nearest first, ahead of the camera's pages), so a
 * tile due two frames after it's wanted usually finds its page. Cached ones are kept in use.
 */
export function prefetchNearLeaves(rt: HeightfieldRuntime): void {
  const pages = rt.pages
  if (!pages?.near || !rt.streaming) return
  const layout = rt.layout!
  const size = layout.leafSize
  const D = layout.depth
  for (let i = 0; i < rt.anchors; i++) {
    const ax = rt.anchorPos[i * 3]!
    const az = rt.anchorPos[i * 3 + 2]!
    const r = rt.anchorRadius[i]! + size
    const x0 = Math.max(0, Math.floor((ax - r) / size))
    const x1 = Math.min(layout.leavesX - 1, Math.floor((ax + r) / size))
    const z0 = Math.max(0, Math.floor((az - r) / size))
    const z1 = Math.min(layout.leavesZ - 1, Math.floor((az + r) / size))
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = Math.max(x * size - ax, 0, ax - (x + 1) * size)
        const dz = Math.max(z * size - az, 0, az - (z + 1) * size)
        const d2 = dx * dx + dz * dz
        if (d2 > r * r) continue
        const key = nodeKey(D, x, z)
        if (pages.has(key)) pages.get(key)
        else if (!pages.loading(key)) {
          void pages.load(D, x, z, BAND_ANCHOR, -Math.sqrt(d2)).catch(() => {})
        }
      }
    }
  }
}

/** A leaf page's heights as its collider takes them: SIDE × SIDE metres, row by row along +Z. */
export function tileHeights(
  rt: HeightfieldRuntime,
  page: { heights: Uint16Array },
  out: number[],
): number[] {
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++)
      out[j * SIDE + i] = dequantize(page.heights[(j + 1) * LEAF_SIDE + i + 1]!, rt.lo, rt.hi)
  }
  return out
}

/**
 * A leaf's collider as a trimesh (spec 0120): its SIDE² vertices in the tile's frame (centred, as
 * the heightfield's), and two triangles per closed cell split along (i+1, j)–(i, j+1), facing up.
 */
function holeMesh(
  world: World,
  rt: HeightfieldRuntime,
  heights: number[],
  control: Uint8Array,
): AssetRef<'Mesh'> {
  const layout = rt.layout!
  const half = layout.leafSize / 2
  const sp = layout.spacing
  const positions = new Float32Array(SIDE * SIDE * 3)
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      const v = (j * SIDE + i) * 3
      positions[v] = i * sp - half
      positions[v + 1] = heights[j * SIDE + i]!
      positions[v + 2] = j * sp - half
    }
  }
  const indices: number[] = []
  for (let j = 0; j < PAGE; j++) {
    for (let i = 0; i < PAGE; i++) {
      if (cellOpen(control, layout.cells, layout.paintStep, i, j)) continue
      const a = j * SIDE + i
      indices.push(a, a + SIDE, a + 1, a + 1, a + SIDE, a + SIDE + 1)
    }
  }
  const mesh = Mesh.create({ positions, indices: Uint32Array.from(indices) })
  return world.initResource(Meshes).add(mesh) as AssetRef<'Mesh'>
}

/** Despawns a tile and drops its trimesh, if it has one. */
function dropTile(world: World, set: TileSet, tile: ColliderTile): void {
  despawnTile(world, tile)
  if (tile.mesh?.guid) {
    world.tryResource(Meshes)?.delete(tile.mesh.guid)
    set.withHoles--
  }
  tile.mesh = null
}

const center = new Float64Array(3)

function spawnTile(world: World, rt: HeightfieldRuntime, tile: ColliderTile): void {
  const size = rt.layout!.leafSize
  const e = world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [
      Collider,
      tile.mesh
        ? { shape: 'trimesh', mesh: tile.mesh }
        : {
            shape: 'heightfield',
            halfExtents: [size / 2, 1, size / 2],
            heightfield: { rows: SIDE, cols: SIDE, heights: tile.heights },
          },
    ],
    [
      TerrainChunk,
      { terrain: rt.entity, key: `${rt.layout!.depth}/${tile.x}/${tile.z}`, kind: 'collider' },
    ],
    [ChildOf, { parent: rt.entity }],
    NavSource,
    Transform,
    Derived,
  )
  center[0] = (tile.x + 0.5) * size
  center[1] = 0
  center[2] = (tile.z + 0.5) * size
  placeInGrid(world, e, rt.entity, center)
  propagateSubtree(world, e)
  tile.entity = e
}

function despawnTile(world: World, tile: ColliderTile): void {
  if (world.isAlive(tile.entity)) world.despawn(tile.entity)
  tile.entity = -1 as Entity
}

/** Drops every collider tile (terrain despawned). */
export function clearHeightfieldColliders(world: World, rt: HeightfieldRuntime): void {
  const set = tilesOf(rt)
  for (const tile of set.tiles.values()) dropTile(world, set, tile)
  set.tiles.clear()
  set.due.clear()
}
