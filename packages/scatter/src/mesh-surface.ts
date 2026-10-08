import { affine, ChildOf, type Entity, type Query, type World } from '@aethervtt/shard-core'
import { DEG, dcos, type Mesh } from '@aethervtt/shard-mesh'
import { type NoiseGraph, sampleNoise } from '@aethervtt/shard-noise'
import type { Workers } from '@aethervtt/shard-platform'
import { TerrainAnchor } from '@aethervtt/shard-terrain'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { writeRotation } from './planet'
import {
  type CompiledRule,
  cellRandom,
  FOLIAGE,
  inRange,
  jitterFor,
  MAX_FOLIAGE_PER_CHUNK,
  pickItem,
  STREAM_ACCEPT,
  STREAM_ITEM,
  STREAM_SCALE,
  STREAM_SHADE,
  STREAM_VARIANT,
  STREAM_X,
  STREAM_Y,
  STREAM_YAW,
} from './rules'
import {
  type ChunkPlacements,
  type FoliagePatch,
  P_CELL,
  P_ITEM,
  P_QX,
  P_SCALE,
  P_SHADE,
  P_VARIANT,
  P_X,
  type PatchJob,
  PLACEMENT_STRIDE,
  type PlacementJob,
  type Surface,
  type SurfaceChunk,
} from './surface'
import { cameraPositions } from './viewers'

/** Items a prop chunk aims for on a mesh (a square of the rule's lattice). */
const TARGET_PROPS = 256
/** Side of a foliage chunk on a mesh (m), like a planet's collider-depth chunk. */
const FOLIAGE_CHUNK = 32
/** Vertices per side of a foliage chunk's ground patch on a mesh. */
const PATCH_GRID = 33

/**
 * The mesh's triangles bucketed on an XZ grid, for vertical rays: the highest hit under a point,
 * its height and its face normal. Built once per mesh version, in the surface's metres.
 */
export class HeightIndex {
  readonly positions: Float64Array
  readonly indices: Uint32Array
  readonly minX: number
  readonly minZ: number
  readonly maxX: number
  readonly maxZ: number
  readonly minY: number
  readonly maxY: number
  readonly cell: number
  readonly cols: number
  readonly rows: number
  /** Triangles per bucket: bucket b holds tris[start[b] .. start[b + 1]). */
  readonly start: Int32Array
  readonly tris: Int32Array

  constructor(mesh: Mesh, scale: number) {
    const p = mesh.positions
    const n = p.length / 3
    this.positions = new Float64Array(n * 3)
    for (let i = 0; i < n * 3; i++) this.positions[i] = p[i]! * scale
    const idx = mesh.indices
    this.indices = idx ? Uint32Array.from(idx) : Uint32Array.from({ length: n }, (_, i) => i)
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const x = this.positions[i * 3]!
      const y = this.positions[i * 3 + 1]!
      const z = this.positions[i * 3 + 2]!
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    this.minX = minX
    this.minZ = minZ
    this.maxX = maxX
    this.maxZ = maxZ
    this.minY = minY
    this.maxY = maxY
    const tris = this.indices.length / 3
    // About four triangles per bucket.
    const area = Math.max(1e-6, (maxX - minX) * (maxZ - minZ))
    this.cell = Math.max(1e-3, Math.sqrt((area * 4) / Math.max(1, tris)))
    this.cols = Math.max(1, Math.ceil((maxX - minX) / this.cell))
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / this.cell))
    const buckets = this.cols * this.rows
    const counts = new Int32Array(buckets + 1)
    const range = (t: number, visit: (b: number) => void) => {
      const pp = this.positions
      const a = this.indices[t * 3]! * 3
      const b = this.indices[t * 3 + 1]! * 3
      const c = this.indices[t * 3 + 2]! * 3
      const x0 = Math.min(pp[a]!, pp[b]!, pp[c]!)
      const x1 = Math.max(pp[a]!, pp[b]!, pp[c]!)
      const z0 = Math.min(pp[a + 2]!, pp[b + 2]!, pp[c + 2]!)
      const z1 = Math.max(pp[a + 2]!, pp[b + 2]!, pp[c + 2]!)
      const i0 = this.clampCol(Math.floor((x0 - minX) / this.cell))
      const i1 = this.clampCol(Math.floor((x1 - minX) / this.cell))
      const j0 = this.clampRow(Math.floor((z0 - minZ) / this.cell))
      const j1 = this.clampRow(Math.floor((z1 - minZ) / this.cell))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) visit(i + j * this.cols)
    }
    for (let t = 0; t < tris; t++) range(t, (b) => counts[b + 1]!++)
    for (let b = 0; b < buckets; b++) counts[b + 1]! += counts[b]!
    this.start = counts.slice()
    const fill = counts.slice()
    this.tris = new Int32Array(counts[buckets]!)
    for (let t = 0; t < tris; t++) range(t, (b) => (this.tris[fill[b]!++] = t))
  }

  private clampCol(i: number): number {
    return Math.max(0, Math.min(this.cols - 1, i))
  }

  private clampRow(j: number): number {
    return Math.max(0, Math.min(this.rows - 1, j))
  }

  /**
   * The highest surface under (x, z): writes [height, nx, ny, nz] (the face normal, facing up) into
   * `out` and returns true, or false where the mesh isn't.
   */
  heightAt(x: number, z: number, out: Float64Array): boolean {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return false
    const i = this.clampCol(Math.floor((x - this.minX) / this.cell))
    const j = this.clampRow(Math.floor((z - this.minZ) / this.cell))
    const b = i + j * this.cols
    const p = this.positions
    let found = false
    let best = -Infinity
    for (let s = this.start[b]!; s < this.start[b + 1]!; s++) {
      const t = this.tris[s]!
      const a = this.indices[t * 3]! * 3
      const bb = this.indices[t * 3 + 1]! * 3
      const c = this.indices[t * 3 + 2]! * 3
      const ax = p[a]!
      const az = p[a + 2]!
      const bx = p[bb]!
      const bz = p[bb + 2]!
      const cx = p[c]!
      const cz = p[c + 2]!
      // Barycentric coordinates in XZ.
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(d) < 1e-12) continue
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
      const l3 = 1 - l1 - l2
      const eps = -1e-9
      if (l1 < eps || l2 < eps || l3 < eps) continue
      const y = l1 * p[a + 1]! + l2 * p[bb + 1]! + l3 * p[c + 1]!
      if (y <= best) continue
      best = y
      found = true
      const ux = bx - ax
      const uy = p[bb + 1]! - p[a + 1]!
      const uz = bz - az
      const vx = cx - ax
      const vy = p[c + 1]! - p[a + 1]!
      const vz = cz - az
      let nx = uy * vz - uz * vy
      let ny = uz * vx - ux * vz
      let nz = ux * vy - uy * vx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      if (ny < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      out[0] = y
      out[1] = nx / len
      out[2] = ny / len
      out[3] = nz / len
    }
    return found
  }
}

interface MeshJobState {
  k: number
  /** Placed directly: a mesh needs no pool (no noise to sample but masks). */
  result: ChunkPlacements | undefined
}

const hit = new Float64Array(4)
const one = new Float32Array(1)
const point = new Float32Array(3)

/**
 * A mesh entity's scatter surface (`ScatterSurface`): rules on a square lattice in its local XZ
 * plane (in metres: the entity's uniform scale is applied), heights from vertical rays.
 */
export class MeshSurface implements Surface {
  readonly kind: 'mesh' | 'heightfield' = 'mesh'
  readonly entity: Entity
  rules: CompiledRule[] = []
  masks: (NoiseGraph | undefined)[] = []
  version = 0
  index: HeightIndex | undefined
  /** The entity's uniform scale: local units to metres. */
  scale = 1
  /** Per rule: cells per chunk side, and chunk size (m). */
  cells: number[] = []
  sizes: number[] = []
  private readonly cameras: Query
  private readonly anchors: Query
  private readonly inverse = new Float32Array(12)

  constructor(world: World, entity: Entity, cameras: Query) {
    this.entity = entity
    this.cameras = cameras
    this.anchors = world.query({ with: [TerrainAnchor, GlobalTransform] })
  }

  get ready(): boolean {
    return this.index !== undefined
  }

  /** Takes the mesh (its version changes rebuild the index) and the entity's scale. */
  setMesh(mesh: Mesh, scale: number): boolean {
    if (
      this.index &&
      this.meshVersion === mesh.version &&
      this.scale === scale &&
      this.mesh === mesh
    )
      return false
    this.mesh = mesh
    this.meshVersion = mesh.version
    this.scale = scale
    this.index = new HeightIndex(mesh, scale)
    return true
  }

  private mesh: Mesh | undefined
  private meshVersion = -1

  configure(rules: CompiledRule[], masks: (NoiseGraph | undefined)[], version: number): void {
    this.rules = rules
    this.masks = masks
    this.version = version
    this.cells = rules.map((r) => {
      if (!Number.isFinite(r.cell)) return 1
      if (r.kind === FOLIAGE) {
        let k = Math.max(1, Math.round(FOLIAGE_CHUNK / r.cell))
        while (k > 1 && r.density * (k * r.cell) ** 2 > MAX_FOLIAGE_PER_CHUNK) k--
        return k
      }
      const size = r.density > 0 ? Math.sqrt(TARGET_PROPS / r.density) : 64
      return Math.max(1, Math.round(size / r.cell))
    })
    this.sizes = rules.map((r, i) => (Number.isFinite(r.cell) ? r.cell * this.cells[i]! : 64))
  }

  viewers(world: World, out: { points: Float64Array; cameras: number; anchors: number }): void {
    const m = world.get(this.entity, GlobalTransform).matrix
    if (!affine.invert(this.inverse, m)) return
    const inv = this.inverse
    const s = this.scale
    const put = (x: number, y: number, z: number, i: number) => {
      if (out.points.length < (i + 1) * 3) {
        const grown = new Float64Array((i + 1) * 6)
        grown.set(out.points)
        out.points = grown
      }
      out.points[i * 3] = (inv[0]! * x + inv[1]! * y + inv[2]! * z + inv[3]!) * s
      out.points[i * 3 + 1] = (inv[4]! * x + inv[5]! * y + inv[6]! * z + inv[7]!) * s
      out.points[i * 3 + 2] = (inv[8]! * x + inv[9]! * y + inv[10]! * z + inv[11]!) * s
    }
    const n = cameraPositions(world, this.cameras, put)
    out.cameras = n
    let a = 0
    for (const table of this.anchors.tables) {
      const enabled = table.column(TerrainAnchor, 'enabled')
      const g = table.column(GlobalTransform, 'matrix') as Float32Array
      for (let row = 0; row < table.count; row++) {
        if (!enabled[row]) continue
        put(g[row * 12 + 3]!, g[row * 12 + 7]!, g[row * 12 + 11]!, n + a)
        a++
      }
    }
    out.anchors = a
  }

  chunksNear(
    rule: CompiledRule,
    viewers: Float64Array,
    first: number,
    count: number,
    range: number,
    visit: (chunk: SurfaceChunk, distance: number) => void,
  ): void {
    const index = this.index
    if (!index) return
    const size = this.sizes[rule.index]!
    const x0 = Math.floor(index.minX / size)
    const x1 = Math.floor(index.maxX / size)
    const z0 = Math.floor(index.minZ / size)
    const z1 = Math.floor(index.maxZ / size)
    for (let v = first; v < first + count; v++) {
      const vx = viewers[v * 3]!
      const vy = viewers[v * 3 + 1]!
      const vz = viewers[v * 3 + 2]!
      const ground = index.heightAt(vx, vz, hit) ? hit[0]! : index.maxY
      const altitude = Math.max(0, vy - ground)
      if (altitude > range) continue
      const reach = Math.ceil(range / size)
      const cx = Math.floor(vx / size)
      const cz = Math.floor(vz / size)
      for (let z = Math.max(z0, cz - reach); z <= Math.min(z1, cz + reach); z++) {
        for (let x = Math.max(x0, cx - reach); x <= Math.min(x1, cx + reach); x++) {
          // Nearest point of the chunk's square to the viewer, horizontally.
          const dx = Math.max(x * size - vx, 0, vx - (x + 1) * size)
          const dz = Math.max(z * size - vz, 0, vz - (z + 1) * size)
          const distance = Math.sqrt(dx * dx + dz * dz + altitude * altitude)
          if (distance > range) continue
          visit(this.chunk(rule, x, z), distance)
        }
      }
    }
  }

  chunk(rule: CompiledRule, x: number, z: number): SurfaceChunk {
    const size = this.sizes[rule.index]!
    const center = new Float64Array(3)
    center[0] = (x + 0.5) * size
    center[2] = (z + 0.5) * size
    return {
      key: `${x}/${z}`,
      rule: rule.index,
      face: 0,
      depth: 0,
      x,
      y: z,
      center,
      extent: size * 0.71,
    }
  }

  chunkAt(rule: CompiledRule, x: number, _y: number, z: number): SurfaceChunk {
    const size = this.sizes[rule.index]!
    return this.chunk(rule, Math.floor(x / size), Math.floor(z / size))
  }

  upAt(_x: number, _y: number, _z: number, out: Float64Array): Float64Array {
    out[0] = 0
    out[1] = 1
    out[2] = 0
    return out
  }

  placeChunkRoot(world: World, root: Entity, chunk: SurfaceChunk): void {
    const s = this.scale
    world.add(root, ChildOf, { parent: this.entity })
    world.set(root, Transform, {
      translation: [chunk.center[0]! / s, chunk.center[1]! / s, chunk.center[2]! / s],
      scale: [1 / s, 1 / s, 1 / s],
    })
  }

  startPlacement(chunk: SurfaceChunk, due: number, _workers: Workers | undefined): PlacementJob {
    // Rays against an index are cheap next to noise: placed now.
    const state: MeshJobState = { k: this.cells[chunk.rule]!, result: undefined }
    state.result = this.place(this.rules[chunk.rule]!, chunk, state.k)
    return { chunk, due, ready: true, cancelled: false, state }
  }

  finishPlacement(job: PlacementJob): ChunkPlacements {
    return (job.state as MeshJobState).result!
  }

  startPatch(chunk: SurfaceChunk, _workers: Workers | undefined): PatchJob {
    return { chunk, ready: true, cancelled: false, state: undefined }
  }

  /** The chunk's ground on a 33 × 33 grid of rays, with the rule's density per vertex. */
  finishPatch(job: PatchJob): FoliagePatch {
    const { chunk } = job
    const rule = this.rules[chunk.rule]!
    const index = this.index!
    const size = this.sizes[rule.index]!
    const n = PATCH_GRID
    const count = n * n
    const positions = new Float32Array(count * 3)
    const normals = new Float32Array(count * 3)
    const density = new Float32Array(count)
    const cosLo = dcos(Math.max(0, rule.slopeLo) * DEG)
    const cosHi = dcos(Math.min(90, rule.slopeHi) * DEG)
    const slopeMask = rule.slopeLo < rule.slopeHi
    const mask = this.masks[rule.index]
    const x0 = chunk.x * size
    const z0 = chunk.y * size
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = i + j * n
        const x = x0 + (i / (n - 1)) * size
        const z = z0 + (j / (n - 1)) * size
        positions[k * 3] = x - chunk.center[0]!
        positions[k * 3 + 2] = z - chunk.center[2]!
        normals[k * 3 + 1] = 1
        if (!index.heightAt(x, z, hit)) continue
        const y = hit[0]!
        positions[k * 3 + 1] = y - chunk.center[1]!
        normals[k * 3] = hit[1]!
        normals[k * 3 + 1] = hit[2]!
        normals[k * 3 + 2] = hit[3]!
        let w = inRange(y, rule.heightLo, rule.heightHi) ? 1 : 0
        if (w > 0 && slopeMask && (hit[2]! > cosLo + 1e-12 || hit[2]! < cosHi - 1e-12)) w = 0
        if (w > 0 && mask) {
          point[0] = x
          point[1] = y
          point[2] = z
          sampleNoise(mask, rule.seed, point, one)
          if (!(one[0]! > rule.noiseAbove)) w = 0
        }
        density[k] = w
      }
    }
    const k = this.cells[rule.index]!
    const cell = size / k
    return {
      grid: n,
      positions,
      normals,
      density,
      cell0: [chunk.x * k, chunk.y * k],
      domain: 0,
      accept: Math.min(1, rule.density * cell * cell),
      jitter: jitterFor(cell, rule.spacing),
      radial: undefined,
    }
  }

  chunkTransform(world: World, chunk: SurfaceChunk, out: Float32Array): void {
    // The surface's world transform (local units) after the chunk's: translate to its center,
    // scale local units to metres.
    const g = world.get(this.entity, GlobalTransform).matrix
    const s = this.scale
    const x = chunk.center[0]! / s
    const y = chunk.center[1]! / s
    const z = chunk.center[2]! / s
    for (let r = 0; r < 3; r++) {
      out[r * 4] = g[r * 4]! / s
      out[r * 4 + 1] = g[r * 4 + 1]! / s
      out[r * 4 + 2] = g[r * 4 + 2]! / s
      out[r * 4 + 3] = g[r * 4]! * x + g[r * 4 + 1]! * y + g[r * 4 + 2]! * z + g[r * 4 + 3]!
    }
  }

  /** A chunk's placements: lattice candidates, rays down, masks, transforms. */
  place(rule: CompiledRule, chunk: SurfaceChunk, k: number): ChunkPlacements {
    const index = this.index!
    const cell = this.sizes[rule.index]! / k
    const accept = Math.min(1, rule.density * cell * cell)
    const jitter = jitterFor(cell, rule.spacing)
    const lo = (1 - jitter) / 2
    const out = new Float32Array(k * k * PLACEMENT_STRIDE)
    const cosLo = dcos(Math.max(0, rule.slopeLo) * DEG)
    const cosHi = dcos(Math.min(90, rule.slopeHi) * DEG)
    const slopeMask = rule.slopeLo < rule.slopeHi
    const mask = this.masks[rule.index]
    let n = 0
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        const gi = chunk.x * k + i
        const gj = chunk.y * k + j
        if (cellRandom(rule.seed, gi, gj, 0, STREAM_ACCEPT) >= accept) continue
        const x = (gi + lo + jitter * cellRandom(rule.seed, gi, gj, 0, STREAM_X)) * cell
        const z = (gj + lo + jitter * cellRandom(rule.seed, gi, gj, 0, STREAM_Y)) * cell
        if (!index.heightAt(x, z, hit)) continue
        const y = hit[0]!
        if (!inRange(y, rule.heightLo, rule.heightHi)) continue
        const cos = hit[2]!
        if (slopeMask && (cos > cosLo + 1e-12 || cos < cosHi - 1e-12)) continue
        if (mask) {
          point[0] = x
          point[1] = y
          point[2] = z
          sampleNoise(mask, rule.seed, point, one)
          if (!(one[0]! > rule.noiseAbove)) continue
        }
        const o = n * PLACEMENT_STRIDE
        out[o + P_ITEM] = pickItem(rule, cellRandom(rule.seed, gi, gj, 0, STREAM_ITEM))
        const item = rule.items[out[o + P_ITEM]!]!
        out[o + P_VARIANT] = Math.min(
          item.variants - 1,
          Math.floor(cellRandom(rule.seed, gi, gj, 0, STREAM_VARIANT) * item.variants),
        )
        out[o + P_X] = x - chunk.center[0]!
        out[o + P_X + 1] = y - chunk.center[1]!
        out[o + P_X + 2] = z - chunk.center[2]!
        let ux = hit[1]! * rule.align
        let uy = 1 + (hit[2]! - 1) * rule.align
        let uz = hit[3]! * rule.align
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
        ux /= ul
        uy /= ul
        uz /= ul
        writeRotation(
          ux,
          uy,
          uz,
          cellRandom(rule.seed, gi, gj, 0, STREAM_YAW) * Math.PI * 2,
          out,
          o + P_QX,
        )
        out[o + P_SCALE] =
          rule.scaleMin +
          (rule.scaleMax - rule.scaleMin) * cellRandom(rule.seed, gi, gj, 0, STREAM_SCALE)
        out[o + P_CELL] = i + j * k
        out[o + P_SHADE] = cellRandom(rule.seed, gi, gj, 0, STREAM_SHADE)
        n++
      }
    }
    return { chunk, count: n, data: out, candidates: k * k }
  }
}
