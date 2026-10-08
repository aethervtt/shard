import type { Entity, Query, World } from '@aethervtt/shard-core'
import { DEG, dcos, sinCos } from '@aethervtt/shard-mesh'
import { type NoiseGraph, sampleNoiseAsync, sampleOffset } from '@aethervtt/shard-noise'
import type { Workers } from '@aethervtt/shard-platform'
import {
  assembleChunk,
  biomeWeights,
  buildChunk,
  type ChunkSampling,
  chunkCenter,
  chunkLayout,
  chunkSpec,
  dominantBiome,
  faceToDirection,
  heightAt,
  MAX_BIOMES,
  MAX_DEPTH,
  NOISE_OFFSET,
  nodeAt,
  nodeExtent,
  type PlanetRuntime,
  SNAP,
  sampleChunkAsync,
} from '@aethervtt/shard-terrain'
import { placeInGrid } from '@aethervtt/shard-transform'
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

/** Items a prop chunk aims for: its depth is the one nearest this many at the rule's density. */
const TARGET_PROPS = 256
/** Metres between a candidate and the two points its normal is measured from. */
const NORMAL_STEP = 0.5

/** Metres along a face edge per node at `depth` (a quarter circle over 2^depth nodes). */
export const nodeMetres = (radius: number, depth: number) => (radius * Math.PI) / 2 / 2 ** depth

/**
 * The quadtree depth a rule places at: props aim for about 256 items a chunk (64–1 024); foliage
 * uses the collider depth (about 1 m between the chunk's 33 vertices, the ground it's drawn on),
 * deeper if a chunk would hold more than one dispatch can place.
 */
export function ruleDepth(rule: CompiledRule, radius: number, colliderDepth: number): number {
  if (rule.kind === FOLIAGE) {
    let d = colliderDepth
    while (d < MAX_DEPTH && rule.density * nodeMetres(radius, d) ** 2 > MAX_FOLIAGE_PER_CHUNK) d++
    return d
  }
  if (!(rule.density > 0)) return Math.min(MAX_DEPTH, colliderDepth)
  const size = Math.sqrt(TARGET_PROPS / rule.density)
  const d = Math.round(Math.log2(nodeMetres(radius, 0) / size))
  return Math.max(0, Math.min(MAX_DEPTH, d))
}

/** Lattice cells per chunk side for a rule at a depth: cells the rule's size, aligned to chunks. */
export function cellsPerChunk(rule: CompiledRule, radius: number, depth: number): number {
  if (!Number.isFinite(rule.cell)) return 1
  return Math.max(1, Math.round(nodeMetres(radius, depth) / rule.cell))
}

interface PlanetJobState {
  k: number
  count: number
  /** Lattice cell index (i + j × k) of each candidate. */
  cells: Int32Array
  dirs: Float64Array
  /** Noise origin (f64) and local points: 3 per candidate (the point and two for its normal). */
  origin: Float64Array
  points: Float32Array
  base: Float32Array
  heights: Float32Array
  temps: Float32Array
  moist: Float32Array
  mask: Float32Array
  candidates: number
  /** Jitter etc. aren't needed after candidates; the job keeps what assembling reads. */
  pending: Promise<void> | undefined
}

const dir = new Float64Array(3)
const node = new Float64Array(3)
const corner = new Float64Array(6)
const sc = new Float64Array(2)

/** A planet's scatter surface: its rules on the cube-sphere quadtree, sampled from its graphs. */
export class PlanetSurface implements Surface {
  readonly kind = 'planet'
  readonly entity: Entity
  rules: CompiledRule[] = []
  version = 0
  /** Per rule: chunk depth and cells per chunk side. */
  depths: number[] = []
  cells: number[] = []
  /** Graph values of each rule's noise mask, by rule index (undefined: no mask). */
  masks: (NoiseGraph | undefined)[] = []
  readonly rt: PlanetRuntime
  private readonly cameras: Query

  constructor(rt: PlanetRuntime, cameras: Query) {
    this.rt = rt
    this.entity = rt.entity
    this.cameras = cameras
  }

  get ready(): boolean {
    return this.rt.ready
  }

  /** Rebuilds per-rule depths after the rules or the planet changed. */
  configure(rules: CompiledRule[], masks: (NoiseGraph | undefined)[], version: number): void {
    const s = this.rt.settings!
    this.rules = rules
    this.masks = masks
    this.version = version
    this.depths = rules.map((r) => ruleDepth(r, s.radius, this.rt.colliderDepth))
    this.cells = rules.map((r, i) => cellsPerChunk(r, s.radius, this.depths[i]!))
  }

  viewers(world: World, out: { points: Float64Array; cameras: number; anchors: number }): void {
    const rt = this.rt
    let n = cameraPositions(world, this.cameras, (x, y, z, i) => {
      if (out.points.length < (i + 1) * 3) out.points = grow(out.points, (i + 1) * 3)
      rt.frame.pointToPlanet(x, y, z, out.points, i * 3)
    })
    out.cameras = n
    for (let a = 0; a < rt.anchors; a++) {
      if (out.points.length < (n + 1) * 3) out.points = grow(out.points, (n + 1) * 3)
      out.points[n * 3] = rt.anchorPos[a * 3]!
      out.points[n * 3 + 1] = rt.anchorPos[a * 3 + 1]!
      out.points[n * 3 + 2] = rt.anchorPos[a * 3 + 2]!
      n++
    }
    out.anchors = n - out.cameras
  }

  chunksNear(
    rule: CompiledRule,
    viewers: Float64Array,
    first: number,
    count: number,
    range: number,
    visit: (chunk: SurfaceChunk, distance: number) => void,
  ): void {
    const rt = this.rt
    const s = rt.settings!
    const depth = this.depths[rule.index]!
    const n = 2 ** depth
    const ext = nodeExtent(depth)
    const size = nodeMetres(s.radius, depth)
    const reach = Math.ceil(range / (size * 0.7)) + 1
    for (let v = first; v < first + count; v++) {
      const px = viewers[v * 3]!
      const py = viewers[v * 3 + 1]!
      const pz = viewers[v * 3 + 2]!
      const len = Math.sqrt(px * px + py * py + pz * pz)
      if (!(len > 0)) continue
      const dx = px / len
      const dy = py / len
      const dz = pz / len
      // Height above the ground under the viewer: chunks are as far as the ground is level there.
      const surface = s.radius * ellipsoidScale(s.shape, dx, dy, dz) + heightAt(rt, dx, dy, dz)
      const altitude = Math.max(0, len - surface)
      if (altitude > range) continue
      nodeAt(dx, dy, dz, depth, node)
      const face = node[0]!
      const cx = node[1]!
      const cy = node[2]!
      for (let dj = -reach; dj <= reach; dj++) {
        for (let di = -reach; di <= reach; di++) {
          let f = face
          let x = cx + di
          let y = cy + dj
          if (x < 0 || y < 0 || x >= n || y >= n) {
            // Past the face's edge: the node on the next face under the extrapolated center.
            faceToDirection(face, -1 + (x + 0.5) * ext, -1 + (y + 0.5) * ext, dir)
            nodeAt(dir[0]!, dir[1]!, dir[2]!, depth, node)
            f = node[0]!
            x = node[1]!
            y = node[2]!
          }
          faceToDirection(f, -1 + (x + 0.5) * ext, -1 + (y + 0.5) * ext, dir)
          const hx = dir[0]! - dx
          const hy = dir[1]! - dy
          const hz = dir[2]! - dz
          const horizontal = s.radius * Math.sqrt(hx * hx + hy * hy + hz * hz)
          const extent = size * 0.75
          const near = Math.max(0, horizontal - extent)
          const distance = Math.sqrt(near * near + altitude * altitude)
          if (distance > range) continue
          visit(this.chunk(rule, f, depth, x, y), distance)
        }
      }
    }
  }

  /** A chunk of `rule` (its center and extent filled in). */
  chunk(rule: CompiledRule, face: number, depth: number, x: number, y: number): SurfaceChunk {
    const s = this.rt.settings!
    const center = chunkCenter(face, depth, x, y, s.radius, s.shape, new Float64Array(3))
    return {
      key: `${face}/${depth}/${x}/${y}`,
      rule: rule.index,
      face,
      depth,
      x,
      y,
      center,
      extent: nodeMetres(s.radius, depth) * 0.75,
    }
  }

  chunkAt(rule: CompiledRule, x: number, y: number, z: number): SurfaceChunk {
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    const depth = this.depths[rule.index]!
    nodeAt(x / len, y / len, z / len, depth, node)
    return this.chunk(rule, node[0]!, depth, node[1]!, node[2]!)
  }

  upAt(x: number, y: number, z: number, out: Float64Array): Float64Array {
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    out[0] = x / len
    out[1] = y / len
    out[2] = z / len
    return out
  }

  placeChunkRoot(world: World, root: Entity, chunk: SurfaceChunk): void {
    placeInGrid(world, root, this.entity, chunk.center)
  }

  startPlacement(chunk: SurfaceChunk, due: number, workers: Workers | undefined): PlacementJob {
    const rule = this.rules[chunk.rule]!
    const state = this.candidates(rule, chunk)
    const job: PlacementJob = { chunk, due, ready: false, cancelled: false, state }
    if (state.count === 0) {
      job.ready = true
      return job
    }
    if (workers && workers.size > 0) {
      const rt = this.rt
      const s = rt.settings!
      const tasks: Promise<void>[] = []
      const h = new Float32Array(state.count * 3)
      const t = new Float32Array(state.count)
      const m = new Float32Array(state.count)
      const k = new Float32Array(state.count)
      const opts = { origin: state.origin }
      if (rt.height) tasks.push(sampleNoiseAsync(workers, rt.height, s.seed, state.points, h, opts))
      if (rt.climate) {
        tasks.push(
          sampleNoiseAsync(workers, rt.climate, s.seed, state.base, t, {
            ...opts,
            node: 'temperature',
          }),
          sampleNoiseAsync(workers, rt.climate, s.seed, state.base, m, {
            ...opts,
            node: 'moisture',
          }),
        )
      }
      const mask = this.masks[rule.index]
      if (mask) tasks.push(sampleNoiseAsync(workers, mask, rule.seed, state.base, k, opts))
      state.pending = Promise.all(tasks).then(
        () => {
          if (job.cancelled || job.ready) return
          state.heights = h
          state.temps = t
          state.moist = m
          state.mask = k
          job.ready = true
        },
        () => {
          // A failed pool job is sampled inline when due.
        },
      )
    }
    return job
  }

  finishPlacement(job: PlacementJob): ChunkPlacements {
    const state = job.state as PlanetJobState
    const rule = this.rules[job.chunk.rule]!
    if (!job.ready) {
      this.sampleInline(rule, state)
      job.ready = true
    }
    return this.assemble(rule, job.chunk, state)
  }

  /**
   * A chunk's lattice: cells per side, and the chance and jitter of each cell from the chunk's real
   * size (its edges measured across the middle; cells aren't square on a cube-sphere).
   */
  lattice(rule: CompiledRule, chunk: SurfaceChunk): { k: number; accept: number; jitter: number } {
    const R = this.rt.settings!.radius
    const k = this.cells[rule.index]!
    const ext = nodeExtent(chunk.depth)
    const u0 = -1 + chunk.x * ext
    const v0 = -1 + chunk.y * ext
    const edge = (ua: number, va: number, ub: number, vb: number) => {
      faceToDirection(chunk.face, ua, va, corner, 0)
      faceToDirection(chunk.face, ub, vb, corner, 3)
      const x = corner[0]! - corner[3]!
      const y = corner[1]! - corner[4]!
      const z = corner[2]! - corner[5]!
      return R * Math.sqrt(x * x + y * y + z * z)
    }
    const cellU = edge(u0, v0 + ext / 2, u0 + ext, v0 + ext / 2) / k
    const cellV = edge(u0 + ext / 2, v0, u0 + ext / 2, v0 + ext) / k
    return {
      k,
      accept: Math.min(1, rule.density * cellU * cellV),
      jitter: jitterFor(Math.min(cellU, cellV), rule.spacing),
    }
  }

  /** The chunk's lattice cells that pass the acceptance roll, as directions and sample points. */
  private candidates(rule: CompiledRule, chunk: SurfaceChunk): PlanetJobState {
    const s = this.rt.settings!
    const R = s.radius
    const ext = nodeExtent(chunk.depth)
    const { k, accept, jitter } = this.lattice(rule, chunk)
    const cellFace = ext / k
    const u0 = -1 + chunk.x * ext
    const v0 = -1 + chunk.y * ext
    const lo = (1 - jitter) / 2
    const cells: number[] = []
    const dirs: number[] = []
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        const gi = chunk.x * k + i
        const gj = chunk.y * k + j
        if (cellRandom(rule.seed, gi, gj, chunk.face, STREAM_ACCEPT) >= accept) continue
        const fx = lo + jitter * cellRandom(rule.seed, gi, gj, chunk.face, STREAM_X)
        const fy = lo + jitter * cellRandom(rule.seed, gi, gj, chunk.face, STREAM_Y)
        faceToDirection(chunk.face, -1 + (gi + fx) * cellFace, -1 + (gj + fy) * cellFace, dir)
        cells.push(i + j * k)
        dirs.push(dir[0]!, dir[1]!, dir[2]!)
      }
    }
    const count = cells.length
    // Noise points: the candidate and two neighbors along its tangents, relative to one origin.
    const cdir = new Float64Array(3)
    faceToDirection(chunk.face, u0 + ext / 2, v0 + ext / 2, cdir)
    const origin = new Float64Array(3)
    for (let a = 0; a < 3; a++)
      origin[a] = Math.round((cdir[a]! * R + NOISE_OFFSET[a]!) / SNAP) * SNAP
    const points = new Float32Array(count * 9)
    const base = new Float32Array(count * 3)
    const step = NORMAL_STEP / R
    for (let c = 0; c < count; c++) {
      const x = dirs[c * 3]!
      const y = dirs[c * 3 + 1]!
      const z = dirs[c * 3 + 2]!
      tangents(x, y, z, t1, t2)
      for (let q = 0; q < 3; q++) {
        let px = x
        let py = y
        let pz = z
        if (q > 0) {
          const e = q === 1 ? t1 : t2
          px += e[0]! * step
          py += e[1]! * step
          pz += e[2]! * step
          const l = Math.sqrt(px * px + py * py + pz * pz)
          px /= l
          py /= l
          pz /= l
        }
        const o = (c * 3 + q) * 3
        points[o] = px * R + NOISE_OFFSET[0] - origin[0]!
        points[o + 1] = py * R + NOISE_OFFSET[1] - origin[1]!
        points[o + 2] = pz * R + NOISE_OFFSET[2] - origin[2]!
        if (q === 0) {
          base[c * 3] = points[o]!
          base[c * 3 + 1] = points[o + 1]!
          base[c * 3 + 2] = points[o + 2]!
        }
      }
    }
    return {
      k,
      count,
      cells: Int32Array.from(cells),
      dirs: Float64Array.from(dirs),
      origin,
      points,
      base,
      heights: new Float32Array(0),
      temps: new Float32Array(0),
      moist: new Float32Array(0),
      mask: new Float32Array(0),
      candidates: k * k,
      pending: undefined,
    }
  }

  startPatch(chunk: SurfaceChunk, workers: Workers | undefined): PatchJob {
    const job: PatchJob = { chunk, ready: false, cancelled: false, state: undefined }
    if (workers && workers.size > 0) {
      const sampling = sampleChunkAsync(this.rt, workers, chunk.face, chunk.depth, chunk.x, chunk.y)
      job.state = sampling
      sampling.done.then(
        () => {
          if (!job.cancelled) job.ready = true
        },
        () => {
          // Built inline when asked for.
        },
      )
    }
    return job
  }

  /**
   * The chunk's ground as terrain builds it (the collider chunk's own vertices at the collider
   * depth, so grass stands on the drawn ground), with the rule's density at each vertex: its
   * height, slope and noise masks, and its biome.
   */
  finishPatch(job: PatchJob): FoliagePatch {
    const rt = this.rt
    const s = rt.settings!
    const { chunk } = job
    const rule = this.rules[chunk.rule]!
    const spec = chunkSpec(rt, chunk.face, chunk.depth, chunk.x, chunk.y)
    const sampling = job.state as ChunkSampling | undefined
    const mesh =
      job.ready && sampling
        ? assembleChunk(spec, sampling.pts, sampling.values, sampling.temps, sampling.moist)
        : buildChunk(spec)
    const n = s.resolution
    const count = n * n
    const index = chunkLayout(n).index
    const positions = new Float32Array(count * 3)
    const normals = new Float32Array(count * 3)
    const density = new Float32Array(count)
    const d = mesh.data
    const cx = chunk.center[0]!
    const cy = chunk.center[1]!
    const cz = chunk.center[2]!
    const cosLo = dcos(Math.max(0, rule.slopeLo) * DEG)
    const cosHi = dcos(Math.min(90, rule.slopeHi) * DEG)
    const slopeMask = rule.slopeLo < rule.slopeHi
    const mask = this.masks[rule.index]
    let maskValues: Float32Array | undefined
    if (mask) {
      // The mask at every vertex, relative to the chunk's lattice origin.
      const origin = new Float64Array(3)
      const R = s.radius
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1
      for (let a = 0; a < 3; a++)
        origin[a] = Math.round(((chunk.center[a]! / cl) * R + NOISE_OFFSET[a]!) / SNAP) * SNAP
      const pts = new Float32Array(count * 3)
      for (let k = 0; k < count; k++) {
        const vi = index[k]!
        const x = cx + d.positions[vi * 3]!
        const y = cy + d.positions[vi * 3 + 1]!
        const z = cz + d.positions[vi * 3 + 2]!
        const l = Math.sqrt(x * x + y * y + z * z) || 1
        pts[k * 3] = (x / l) * R + NOISE_OFFSET[0] - origin[0]!
        pts[k * 3 + 1] = (y / l) * R + NOISE_OFFSET[1] - origin[1]!
        pts[k * 3 + 2] = (z / l) * R + NOISE_OFFSET[2] - origin[2]!
      }
      maskValues = new Float32Array(count)
      sampleOffset(mask, rule.seed, origin, pts, maskValues)
    }
    for (let k = 0; k < count; k++) {
      const vi = index[k]!
      const px = d.positions[vi * 3]!
      const py = d.positions[vi * 3 + 1]!
      const pz = d.positions[vi * 3 + 2]!
      positions[k * 3] = px
      positions[k * 3 + 1] = py
      positions[k * 3 + 2] = pz
      const nx = d.normals![vi * 3]!
      const ny = d.normals![vi * 3 + 1]!
      const nz = d.normals![vi * 3 + 2]!
      normals[k * 3] = nx
      normals[k * 3 + 1] = ny
      normals[k * 3 + 2] = nz
      const h = mesh.heights[k]!
      let w = inRange(h, rule.heightLo, rule.heightHi) ? 1 : 0
      const x = cx + px
      const y = cy + py
      const z = cz + pz
      const l = Math.sqrt(x * x + y * y + z * z) || 1
      const cos = Math.abs((nx * x + ny * y + nz * z) / l)
      if (w > 0 && slopeMask && (cos > cosLo + 1e-12 || cos < cosHi - 1e-12)) w = 0
      if (w > 0 && maskValues && !(maskValues[k]! > rule.noiseAbove)) w = 0
      if (w > 0 && rule.biome >= 0) {
        biomeWeights(
          rt.table,
          {
            temperature: d.uvs![vi * 2]!,
            moisture: d.uvs![vi * 2 + 1]!,
            height: h,
            slope: (Math.acos(Math.min(1, cos)) * 180) / Math.PI,
            latitude: y / l,
          },
          weights,
        )
        if (dominantBiome(weights, rt.table.count) !== rule.biome) w = 0
      }
      density[k] = w
    }
    const { k, accept, jitter } = this.lattice(rule, chunk)
    return {
      grid: n,
      positions,
      normals,
      density,
      cell0: [chunk.x * k, chunk.y * k],
      domain: chunk.face,
      accept,
      jitter,
      radial: [cx, cy, cz],
    }
  }

  chunkTransform(_world: World, chunk: SurfaceChunk, out: Float32Array): void {
    const m = this.rt.frame.toOrigin
    const x = chunk.center[0]!
    const y = chunk.center[1]!
    const z = chunk.center[2]!
    for (let r = 0; r < 3; r++) {
      out[r * 4] = m[r * 4]!
      out[r * 4 + 1] = m[r * 4 + 1]!
      out[r * 4 + 2] = m[r * 4 + 2]!
      out[r * 4 + 3] = m[r * 4]! * x + m[r * 4 + 1]! * y + m[r * 4 + 2]! * z + m[r * 4 + 3]!
    }
  }

  private sampleInline(rule: CompiledRule, state: PlanetJobState): void {
    const rt = this.rt
    const s = rt.settings!
    state.heights = new Float32Array(state.count * 3)
    state.temps = new Float32Array(state.count)
    state.moist = new Float32Array(state.count)
    state.mask = new Float32Array(state.count)
    if (state.count === 0) return
    if (rt.height) sampleOffset(rt.height, s.seed, state.origin, state.points, state.heights)
    if (rt.climate) {
      sampleOffset(rt.climate, s.seed, state.origin, state.base, state.temps, 'temperature')
      sampleOffset(rt.climate, s.seed, state.origin, state.base, state.moist, 'moisture')
    }
    const mask = this.masks[rule.index]
    if (mask) sampleOffset(mask, rule.seed, state.origin, state.base, state.mask)
  }

  /** Samples into placements: masks, biome, then each item's transform from its cell's hashes. */
  private assemble(
    rule: CompiledRule,
    chunk: SurfaceChunk,
    state: PlanetJobState,
  ): ChunkPlacements {
    const rt = this.rt
    const s = rt.settings!
    const R = s.radius
    const sx = s.shape[0]!
    const sy = s.shape[1]!
    const sz = s.shape[2]!
    const scale = s.heightScale
    const out = new Float32Array(state.count * PLACEMENT_STRIDE)
    const cosLo = dcos(Math.max(0, rule.slopeLo) * DEG)
    const cosHi = dcos(Math.min(90, rule.slopeHi) * DEG)
    const slopeMask = rule.slopeLo < rule.slopeHi
    let n = 0
    const k = state.k
    const cx = chunk.center[0]!
    const cy = chunk.center[1]!
    const cz = chunk.center[2]!
    for (let c = 0; c < state.count; c++) {
      const h0 = state.heights[c * 3]! * scale
      if (!inRange(h0, rule.heightLo, rule.heightHi)) continue
      if (this.masks[rule.index] && !(state.mask[c]! > rule.noiseAbove)) continue
      // The point and its two neighbors on the surface (f64, planet frame).
      for (let q = 0; q < 3; q++) {
        let x = state.dirs[c * 3]!
        let y = state.dirs[c * 3 + 1]!
        let z = state.dirs[c * 3 + 2]!
        if (q > 0) {
          tangents(x, y, z, t1, t2)
          const e = q === 1 ? t1 : t2
          const step = NORMAL_STEP / R
          x += e[0]! * step
          y += e[1]! * step
          z += e[2]! * step
          const l = Math.sqrt(x * x + y * y + z * z)
          x /= l
          y /= l
          z /= l
        }
        const r = R + state.heights[c * 3 + q]! * scale
        tri[q * 3] = x * sx * r
        tri[q * 3 + 1] = y * sy * r
        tri[q * 3 + 2] = z * sz * r
      }
      const ax = tri[3]! - tri[0]!
      const ay = tri[4]! - tri[1]!
      const az = tri[5]! - tri[2]!
      const bx = tri[6]! - tri[0]!
      const by = tri[7]! - tri[1]!
      const bz = tri[8]! - tri[2]!
      let nx = ay * bz - az * by
      let ny = az * bx - ax * bz
      let nz = ax * by - ay * bx
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      nx /= nl
      ny /= nl
      nz /= nl
      const rl = Math.sqrt(tri[0]! ** 2 + tri[1]! ** 2 + tri[2]! ** 2) || 1
      const ux = tri[0]! / rl
      const uy = tri[1]! / rl
      const uz = tri[2]! / rl
      let cos = nx * ux + ny * uy + nz * uz
      if (cos < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
        cos = -cos
      }
      if (slopeMask && (cos > cosLo + 1e-12 || cos < cosHi - 1e-12)) continue
      if (rule.biome >= 0) {
        const slope = (Math.acos(Math.min(1, cos)) * 180) / Math.PI
        biomeWeights(
          rt.table,
          {
            temperature: rt.climate ? state.temps[c]! : 0,
            moisture: rt.climate ? state.moist[c]! : 0,
            height: h0,
            slope,
            latitude: state.dirs[c * 3 + 1]!,
          },
          weights,
        )
        if (dominantBiome(weights, rt.table.count) !== rule.biome) continue
      }
      const cell = state.cells[c]!
      const gi = chunk.x * k + (cell % k)
      const gj = chunk.y * k + Math.floor(cell / k)
      const o = n * PLACEMENT_STRIDE
      out[o + P_ITEM] = pickItem(rule, cellRandom(rule.seed, gi, gj, chunk.face, STREAM_ITEM))
      const item = rule.items[out[o + P_ITEM]!]!
      out[o + P_VARIANT] = Math.min(
        item.variants - 1,
        Math.floor(cellRandom(rule.seed, gi, gj, chunk.face, STREAM_VARIANT) * item.variants),
      )
      out[o + P_X] = tri[0]! - cx
      out[o + P_X + 1] = tri[1]! - cy
      out[o + P_X + 2] = tri[2]! - cz
      // Up: from radial (0) to the surface normal (1).
      let upx = ux + (nx - ux) * rule.align
      let upy = uy + (ny - uy) * rule.align
      let upz = uz + (nz - uz) * rule.align
      const ul = Math.sqrt(upx * upx + upy * upy + upz * upz) || 1
      upx /= ul
      upy /= ul
      upz /= ul
      writeRotation(
        upx,
        upy,
        upz,
        cellRandom(rule.seed, gi, gj, chunk.face, STREAM_YAW) * Math.PI * 2,
        out,
        o + P_QX,
      )
      out[o + P_SCALE] =
        rule.scaleMin +
        (rule.scaleMax - rule.scaleMin) * cellRandom(rule.seed, gi, gj, chunk.face, STREAM_SCALE)
      out[o + P_CELL] = cell
      out[o + P_SHADE] = cellRandom(rule.seed, gi, gj, chunk.face, STREAM_SHADE)
      n++
    }
    return { chunk, count: n, data: out, candidates: state.candidates }
  }
}

const weights = new Float32Array(MAX_BIOMES)
const tri = new Float64Array(9)
const t1 = new Float64Array(3)
const t2 = new Float64Array(3)

/** Two tangents at a unit direction (the same construction as terrain.sample's). */
function tangents(x: number, y: number, z: number, e1: Float64Array, e2: Float64Array): void {
  const ax = Math.abs(y) < 0.9 ? 0 : 1
  const ay = Math.abs(y) < 0.9 ? 1 : 0
  let e1x = ay * z
  let e1y = -ax * z
  let e1z = ax * y - ay * x
  const l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z) || 1
  e1x /= l1
  e1y /= l1
  e1z /= l1
  e1[0] = e1x
  e1[1] = e1y
  e1[2] = e1z
  e2[0] = y * e1z - z * e1y
  e2[1] = z * e1x - x * e1z
  e2[2] = x * e1y - y * e1x
}

/**
 * The rotation taking +Y to `up`, after a yaw about +Y, as a quaternion (xyzw) into `out`. Trig
 * through `sinCos`, so the bits match on every host.
 */
export function writeRotation(
  ux: number,
  uy: number,
  uz: number,
  yaw: number,
  out: Float32Array,
  o: number,
): void {
  // Shortest arc from (0, 1, 0) to up: axis (uz, 0, −ux), w = 1 + uy.
  let ax = uz
  const ay = 0
  let az = -ux
  let aw = 1 + uy
  const len = Math.sqrt(ax * ax + az * az + aw * aw) || 1
  ax /= len
  az /= len
  aw /= len
  sinCos(yaw / 2, sc)
  const ys = sc[0]!
  const yc = sc[1]!
  // a ⊗ (0, ys, 0, yc)
  out[o] = ax * yc - az * ys
  out[o + 1] = aw * ys + ay * yc
  out[o + 2] = az * yc + ax * ys
  out[o + 3] = aw * yc - ay * ys
}

/** |dir ⊙ shape|: how far along `dir` the unit ellipsoid reaches. */
function ellipsoidScale(shape: ArrayLike<number>, x: number, y: number, z: number): number {
  const a = x * shape[0]!
  const b = y * shape[1]!
  const c = z * shape[2]!
  return Math.sqrt(a * a + b * b + c * c)
}

function grow(a: Float64Array, n: number): Float64Array {
  const out = new Float64Array(Math.max(n, a.length * 2))
  out.set(a)
  return out
}
