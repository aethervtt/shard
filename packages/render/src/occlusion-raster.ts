import type { Entity, Query, World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'
import { LogResource } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Meshes } from './assets'
import { CutawayView } from './cutaway'
import {
  CUTAWAY_BIT,
  INSTANCE_FLOATS,
  InstanceFlags,
  InstanceSlot,
  type InstanceStore,
  Instances,
  LAYER_SHIFT,
} from './instances'
import { MAX_OCCLUDER_TRIANGLES, Occluder, OcclusionCulling } from './occlusion'
import { OcclusionBuffer } from './occlusion-buffer'
import {
  MAX_OCCLUSION_CAMERAS,
  OCCLUSION_VIEW_FLOATS,
  type OccluderRecord,
  type OcclusionState,
  OcclusionStateResource,
} from './occlusion-plugin'
import { Gpu } from './plugin'
import { type CameraData, Cameras } from './view'
import { HiddenSetsResource } from './view-visibility'

// Occlusion culling's raster (0116), loaded with import() the first time a world has an occlusion
// camera or an occluder: the occluder registry, the CPU rasterizer, and the GPU upload. Each frame,
// the occluders near a camera with OcclusionCulling are rasterized into a small depth buffer
// (inner-conservative coverage, each triangle at its farthest depth, so nothing visible is ever
// hidden), with a pyramid of maxima. A still camera over still occluders keeps its raster.

export { OCCLUSION_SHADERS } from './occlusion-shaders'

/** Occluders are gathered from a grid of cells this many meters on a side. */
const CELL = 16
/** Occluders smaller than this many pixels across are skipped: they hide too little to pay. */
const MIN_PIXELS = 4

/** Forgets a despawned occluder. */
export function forget(state: OcclusionState, entity: Entity): void {
  const rec = state.occluders.get(entity)
  if (!rec) return
  unlink(state, rec)
  state.occluders.delete(entity)
  state.pending.delete(entity)
  state.version++
}

function cellKey(x: number, z: number): number {
  return (x + 0x8000) * 0x10000 + (z + 0x8000)
}

/** World triangles of an occluder from its mesh and world matrix (12 floats, rows). */
function placeOccluder(rec: OccluderRecord, mesh: Mesh, g: ArrayLike<number>, o: number): void {
  const p = mesh.positions
  const idx = mesh.indices
  const count = Math.min(MAX_OCCLUDER_TRIANGLES, idx ? (idx.length / 3) | 0 : (p.length / 9) | 0)
  if (rec.tris.length < count * 9) rec.tris = new Float32Array(count * 9)
  if (rec.edges.length < count) rec.edges = new Uint8Array(count)
  rec.edges.fill(0, 0, count)
  if (idx) {
    // Edges two triangles share: keyed by their vertex pair, either way round.
    const seen = new Map<number, number>()
    for (let t = 0; t < count; t++) {
      for (let k = 0; k < 3; k++) {
        const a = idx[t * 3 + ((k + 1) % 3)]!
        const b = idx[t * 3 + ((k + 2) % 3)]!
        const key = a < b ? a * 65536 + b : b * 65536 + a
        const other = seen.get(key)
        if (other === undefined) seen.set(key, t * 3 + k)
        else {
          rec.edges[t] = rec.edges[t]! | (1 << k)
          rec.edges[(other / 3) | 0] = rec.edges[(other / 3) | 0]! | (1 << (other % 3))
        }
      }
    }
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx[t * 3 + k]! : t * 3 + k
      const x = p[v * 3]!
      const y = p[v * 3 + 1]!
      const z = p[v * 3 + 2]!
      const wx = g[o]! * x + g[o + 1]! * y + g[o + 2]! * z + g[o + 3]!
      const wy = g[o + 4]! * x + g[o + 5]! * y + g[o + 6]! * z + g[o + 7]!
      const wz = g[o + 8]! * x + g[o + 9]! * y + g[o + 10]! * z + g[o + 11]!
      const q = t * 9 + k * 3
      rec.tris[q] = wx
      rec.tris[q + 1] = wy
      rec.tris[q + 2] = wz
      if (wx < minX) minX = wx
      if (wy < minY) minY = wy
      if (wz < minZ) minZ = wz
      if (wx > maxX) maxX = wx
      if (wy > maxY) maxY = wy
      if (wz > maxZ) maxZ = wz
    }
  }
  rec.count = count
  rec.cx = (minX + maxX) / 2
  rec.cy = (minY + maxY) / 2
  rec.cz = (minZ + maxZ) / 2
  const ex = (maxX - minX) / 2
  const ey = (maxY - minY) / 2
  const ez = (maxZ - minZ) / 2
  rec.r = count > 0 ? Math.sqrt(ex * ex + ey * ey + ez * ez) : 0
}

function unlink(state: OcclusionState, rec: OccluderRecord): void {
  for (const key of rec.cells) {
    const list = state.grid.get(key)
    if (!list) continue
    const i = list.indexOf(rec)
    if (i >= 0) {
      list[i] = list[list.length - 1]!
      list.pop()
    }
    if (list.length === 0) state.grid.delete(key)
  }
  rec.cells.length = 0
}

function link(state: OcclusionState, rec: OccluderRecord): void {
  if (rec.count === 0) return
  const x0 = Math.floor((rec.cx - rec.r) / CELL)
  const x1 = Math.floor((rec.cx + rec.r) / CELL)
  const z0 = Math.floor((rec.cz - rec.r) / CELL)
  const z1 = Math.floor((rec.cz + rec.r) / CELL)
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const key = cellKey(x, z)
      let list = state.grid.get(key)
      if (!list) {
        list = []
        state.grid.set(key, list)
      }
      list.push(rec)
      rec.cells.push(key)
    }
  }
}

/** Keeps the occluder registry current: changed meshes or transforms place again. */
export function sync(world: World, occluders: Query, since: number): void {
  {
    const state = world.resource(OcclusionStateResource)
    const meshes = world.resource(Meshes)
    for (const table of occluders.tables) {
      const fresh =
        table.lastChanged(Occluder) > since ||
        table.lastChanged(GlobalTransform) > since ||
        table.lastStructural > since
      if (!fresh && state.pending.size === 0) continue
      const refs = table.column(Occluder, 'mesh')
      const g = table.column(GlobalTransform, 'matrix')
      const changedG = table.changedTicks(GlobalTransform)
      const changedO = table.changedTicks(Occluder)
      const slots = table.has(InstanceSlot) ? table.column(InstanceSlot, 'slot') : undefined
      for (let i = 0; i < table.count; i++) {
        const entity = table.entities[i]! as Entity
        let rec = state.occluders.get(entity)
        const pending = state.pending.has(entity)
        if (rec && !pending && changedG[i]! <= since && changedO[i]! <= since) {
          rec.slot = slots ? slots[i]! - 1 : -1
          continue
        }
        const ref = refs[i]
        const mesh = ref ? meshes.get(ref as never) : undefined
        if (!mesh) {
          // Not loaded yet: try again next frame.
          state.pending.add(entity)
          continue
        }
        state.pending.delete(entity)
        if (!rec) {
          rec = {
            entity,
            tris: new Float32Array(0),
            edges: new Uint8Array(0),
            count: 0,
            cx: 0,
            cy: 0,
            cz: 0,
            r: 0,
            cells: [],
            stamp: -1,
            slot: -1,
          }
          state.occluders.set(entity, rec)
        } else unlink(state, rec)
        const triangles = mesh.indices ? mesh.indices.length / 3 : mesh.positions.length / 9
        if (triangles > MAX_OCCLUDER_TRIANGLES && !state.warned) {
          state.warned = true
          world
            .tryResource(LogResource)
            ?.log(
              'warn',
              `An Occluder mesh has ${triangles} triangles; the first ${MAX_OCCLUDER_TRIANGLES} are used`,
              {
                code: 'render/occluder-too-complex',
                hint: 'Give it a simpler mesh that lies inside what it draws: a few quads or a box.',
                data: { entity },
              },
            )
        }
        placeOccluder(rec, mesh, g, i * 12)
        rec.slot = slots ? slots[i]! - 1 : -1
        link(state, rec)
        state.version++
      }
    }
  }
}

/** Whether an occluder hides for `camera`: visible to it (not shadow-only), on its layers. */
function occludes(
  rec: OccluderRecord,
  store: InstanceStore,
  cam: CameraData,
  hidden: Uint32Array | undefined,
  cutting: boolean,
): boolean {
  const s = rec.slot
  if (s < 0) return true
  if (s >= store.high) return false
  const word = store.u32[s * INSTANCE_FLOATS + 13]!
  if ((word & InstanceFlags.Visible) === 0) return false
  if (((word >>> LAYER_SHIFT) & 0xffff & cam.layers) === 0) return false
  if (hidden && (hidden[s >>> 5]! & (1 << (s & 31))) !== 0) return false
  // A cutaway surface may be cut open for this camera: it hides nothing.
  if (cutting && (word & CUTAWAY_BIT) !== 0) return false
  return true
}

// Raster scratch: a triangle clipped by the near plane has up to four vertices (view space), and
// per vertex whether the polygon edge from it to the next is shared (inside the occluder).
const clip = new Float32Array(4 * 3)
const clipShared = new Uint8Array(4)
const tri = new Float32Array(9)

/**
 * Draws a view-space triangle (x, y, depth with depth > 0 in front) into level 0: pixels it fully
 * covers take its farthest depth where that's nearer than what they hold. `shared` says which of
 * its edges (bit k: opposite vertex k) another triangle of the occluder continues across.
 */
function rasterTriangle(b: OcclusionBuffer, t: Float32Array, shared: number): number {
  // Clip against the near plane, keeping each polygon edge's shared flag.
  let n = 0
  for (let k = 0; k < 3; k++) {
    const a = k * 3
    const c = ((k + 1) % 3) * 3
    // The edge from vertex k to k + 1 is opposite vertex k + 2.
    const edge = (shared >> ((k + 2) % 3)) & 1
    const da = t[a + 2]! - b.near
    const dc = t[c + 2]! - b.near
    if (da >= 0) {
      clip[n * 3] = t[a]!
      clip[n * 3 + 1] = t[a + 1]!
      clip[n * 3 + 2] = t[a + 2]!
      // Leaving inside: on toward c (or its crossing) along this edge.
      clipShared[n] = edge
      n++
    }
    if (da >= 0 !== dc >= 0) {
      const s = da / (da - dc)
      clip[n * 3] = t[a]! + (t[c]! - t[a]!) * s
      clip[n * 3 + 1] = t[a + 1]! + (t[c + 1]! - t[a + 1]!) * s
      clip[n * 3 + 2] = b.near
      // Going out, the next edge runs along the near plane (an outer edge); coming in, along this one.
      clipShared[n] = da >= 0 ? 0 : edge
      n++
    }
  }
  if (n < 3) return 0
  let far = 0
  for (let k = 0; k < n; k++) if (clip[k * 3 + 2]! > far) far = clip[k * 3 + 2]!
  // To pixels.
  const W = b.width
  const H = b.height
  for (let k = 0; k < n; k++) {
    const x = clip[k * 3]!
    const y = clip[k * 3 + 1]!
    const d = clip[k * 3 + 2]!
    const nx = b.orthographic ? x * b.sx : (x / d) * b.sx
    const ny = b.orthographic ? y * b.sy : (y / d) * b.sy
    clip[k * 3] = (nx * 0.5 + 0.5) * W
    clip[k * 3 + 1] = (0.5 - ny * 0.5) * H
  }
  // A fan from vertex 0; its inner diagonals are shared too.
  let drawn = 0
  for (let k = 1; k + 1 < n; k++) {
    const e12 = clipShared[k]!
    const e20 = k + 1 < n - 1 ? 1 : clipShared[n - 1]!
    const e01 = k > 1 ? 1 : clipShared[0]!
    drawn += fill(b, 0, k * 3, (k + 1) * 3, far, e12 | (e20 << 1) | (e01 << 2))
  }
  return drawn
}

/**
 * Fills the pixels a screen triangle fully covers, at depth `far`. An outer edge must clear each
 * pixel by half its footprint (inner-conservative); a shared edge (bit k of `shared`, opposite
 * vertex k) only by its center, so the triangle across it takes the rest.
 */
function fill(
  b: OcclusionBuffer,
  i0: number,
  i1: number,
  i2: number,
  far: number,
  shared: number,
): number {
  const x0 = clip[i0]!
  const y0 = clip[i0 + 1]!
  let x1 = clip[i1]!
  let y1 = clip[i1 + 1]!
  let x2 = clip[i2]!
  let y2 = clip[i2 + 1]!
  let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  if (area === 0) return 0
  const s0 = shared & 1
  let s1 = (shared >> 1) & 1
  let s2 = (shared >> 2) & 1
  if (area < 0) {
    // Swap vertices 1 and 2 so the edge functions are positive inside; their opposite edges swap.
    const tx = x1
    const ty = y1
    x1 = x2
    y1 = y2
    x2 = tx
    y2 = ty
    const t = s1
    s1 = s2
    s2 = t
    area = -area
  }
  const W = b.width
  const H = b.height
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)) - 1)
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)) - 1)
  if (minX > maxX || minY > maxY) return 0
  // Edge functions e = a x + b y + c, edge k opposite vertex k, positive inside.
  const a0 = y1 - y2
  const b0 = x2 - x1
  const c0 = x1 * y2 - x2 * y1
  const a1 = y2 - y0
  const b1 = x0 - x2
  const c1 = x2 * y0 - x0 * y2
  const a2 = y0 - y1
  const b2 = x1 - x0
  const c2 = x0 * y1 - x1 * y0
  const m0 = s0 ? 0 : (Math.abs(a0) + Math.abs(b0)) * 0.5
  const m1 = s1 ? 0 : (Math.abs(a1) + Math.abs(b1)) * 0.5
  const m2 = s2 ? 0 : (Math.abs(a2) + Math.abs(b2)) * 0.5
  const data = b.data
  let drawn = 0
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      if (a0 * px + b0 * py + c0 < m0) continue
      if (a1 * px + b1 * py + c1 < m1) continue
      if (a2 * px + b2 * py + c2 < m2) continue
      const i = y * W + x
      if (far < data[i]!) {
        data[i] = far
        drawn++
      }
    }
  }
  return drawn
}

/** Rasterizes one camera's occluders into its buffer. */
function rasterize(
  state: OcclusionState,
  b: OcclusionBuffer,
  cam: CameraData,
  range: number,
  store: InstanceStore,
  hidden: Uint32Array | undefined,
  cutting: boolean,
): void {
  const start = performance.now()
  const size = b.width * b.height
  b.data.fill(Number.POSITIVE_INFINITY, 0, size)
  const stamp = ++state.stamp
  const px = cam.position[0]!
  const pz = cam.position[2]!
  const r = Math.ceil(range / CELL)
  const cx = Math.floor(px / CELL)
  const cz = Math.floor(pz / CELL)
  const f = cam.frustum
  const v = b.view
  // Pixels per meter at depth 1: how big an occluder looks.
  const scale = b.orthographic ? b.sx * b.width * 0.5 : b.sy * b.height * 0.5
  let occluders = 0
  let triangles = 0
  for (let x = cx - r; x <= cx + r; x++) {
    for (let z = cz - r; z <= cz + r; z++) {
      const list = state.grid.get(cellKey(x, z))
      if (!list) continue
      for (let k = 0; k < list.length; k++) {
        const rec = list[k]!
        if (rec.stamp === stamp) continue
        rec.stamp = stamp
        const dx = rec.cx - px
        const dy = rec.cy - cam.position[1]!
        const dz = rec.cz - pz
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist - rec.r > range) continue
        let inside = true
        for (let p = 0; p < 24; p += 4) {
          if (f[p]! * rec.cx + f[p + 1]! * rec.cy + f[p + 2]! * rec.cz + f[p + 3]! < -rec.r) {
            inside = false
            break
          }
        }
        if (!inside) continue
        const depth = Math.max(dist, 1e-3)
        if (((2 * rec.r) / (b.orthographic ? 1 : depth)) * scale < MIN_PIXELS) continue
        if (!occludes(rec, store, cam, hidden, cutting)) continue
        occluders++
        const t = rec.tris
        for (let i = 0; i < rec.count; i++) {
          for (let c = 0; c < 3; c++) {
            const q = i * 9 + c * 3
            const wx = t[q]!
            const wy = t[q + 1]!
            const wz = t[q + 2]!
            tri[c * 3] = v[0]! * wx + v[4]! * wy + v[8]! * wz + v[12]!
            tri[c * 3 + 1] = v[1]! * wx + v[5]! * wy + v[9]! * wz + v[13]!
            tri[c * 3 + 2] = -(v[2]! * wx + v[6]! * wy + v[10]! * wz + v[14]!)
          }
          if (rasterTriangle(b, tri, rec.edges[i]!) > 0) triangles++
        }
      }
    }
  }
  b.buildPyramid()
  b.valid = true
  b.rasters++
  b.occluders = occluders
  b.triangles = triangles
  b.ms = performance.now() - start
}

/** Each occlusion camera's buffer for this frame: rasterized again only when something changed. */
export function rasterizeCameras(world: World, cameras: Query): void {
  {
    const state = world.resource(OcclusionStateResource)
    const extracted = world.resource(Cameras)
    const store = world.resource(Instances)
    const hiddenSets = world.tryResource(HiddenSetsResource)
    let layer = 0
    for (const b of state.cameras.values()) {
      b.valid = false
      b.layer = -1
      b.culledBatches = 0
      b.culledInstances = 0
    }
    for (const table of cameras.tables) {
      const widths = table.column(OcclusionCulling, 'width')
      const ranges = table.column(OcclusionCulling, 'range')
      const shadows = table.column(OcclusionCulling, 'shadows')
      const cutView = table.has(CutawayView) ? table.column(CutawayView, 'points') : undefined
      for (let i = 0; i < table.count; i++) {
        const entity = table.entities[i]! as Entity
        const cam = extracted.get(entity)
        if (!cam || cam.frames === 0) continue
        let b = state.cameras.get(entity)
        if (!b) {
          b = new OcclusionBuffer()
          state.cameras.set(entity, b)
        }
        const width = widths[i]!
        b.resize(width, Math.max(1, Math.round(width / Math.max(cam.aspect, 1e-3))))
        b.view.set(cam.view)
        b.shadows = shadows[i] !== 0
        b.orthographic = cam.orthographic
        b.near = cam.near
        if (cam.orthographic) {
          b.sx = 2 / (cam.orthoHeight * cam.aspect)
          b.sy = 2 / cam.orthoHeight
        } else {
          const t = Math.tan(cam.fovY / 2)
          b.sx = 1 / (t * cam.aspect)
          b.sy = 1 / t
        }
        b.layer = layer < MAX_OCCLUSION_CAMERAS ? layer++ : -1
        const hidden = hiddenSets?.sets.get(entity)
        const points = cutView?.[i] as readonly unknown[] | undefined
        const cutting = (points?.length ?? 0) > 0
        // A still camera over still occluders keeps its raster.
        let sig = state.drawn.get(entity)
        if (!sig) {
          sig = new Float64Array(16 + 8).fill(Number.NaN)
          state.drawn.set(entity, sig)
        }
        let same = sig[16] === state.version && sig[17] === store.flagsEpoch && sig[18] === b.width
        same =
          same && sig[19] === b.height && sig[20] === ranges[i] && sig[21] === (cutting ? 1 : 0)
        same = same && sig[22] === (hiddenSets?.resolves ?? -1)
        for (let k = 0; k < 16 && same; k++) if (sig[k] !== b.view[k]) same = false
        if (same && sig[23] === b.sx) {
          b.valid = true
          continue
        }
        rasterize(state, b, cam, ranges[i]!, store, hidden?.bits, cutting)
        for (let k = 0; k < 16; k++) sig[k] = b.view[k]!
        sig[16] = state.version
        sig[17] = store.flagsEpoch
        sig[18] = b.width
        sig[19] = b.height
        sig[20] = ranges[i]!
        sig[21] = cutting ? 1 : 0
        sig[22] = hiddenSets?.resolves ?? -1
        sig[23] = b.sx
      }
    }
    // Cameras that lost OcclusionCulling or went away keep no buffer.
    for (const entity of state.cameras.keys()) {
      if (!world.isAlive(entity) || !world.has(entity, OcclusionCulling)) {
        state.cameras.delete(entity)
        state.drawn.delete(entity)
      }
    }
  }
}

/** The GPU copy (full tier): every occlusion camera's pyramid in a texture layer. */
function gpuCopy(
  state: OcclusionState,
  gpu: GpuContext,
): { uniform: GPUBuffer; texture: GPUTextureView } | undefined {
  let w = 1
  let h = 1
  for (const b of state.cameras.values()) {
    if (b.layer < 0 || !b.valid) continue
    w = Math.max(w, b.width)
    h = Math.max(h, b.height)
  }
  if (
    !state.texture ||
    state.textureSize < w ||
    state.textureHeight < h ||
    state.generation !== gpu.generation
  ) {
    state.texture?.destroy()
    state.textureSize = Math.max(w, state.generation === gpu.generation ? state.textureSize : 1)
    state.textureHeight = Math.max(h, state.generation === gpu.generation ? state.textureHeight : 1)
    let levels = 1
    while (state.textureSize >> levels > 0 || state.textureHeight >> levels > 0) levels++
    state.texture = gpu.device.createTexture({
      label: 'occlusion/depth',
      size: [state.textureSize, state.textureHeight, MAX_OCCLUSION_CAMERAS],
      format: 'r32float',
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    state.view = state.texture.createView({ dimension: '2d-array' })
    state.uniform?.destroy()
    state.uniform = gpu.device.createBuffer({
      label: 'occlusion/views',
      size: state.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    state.generation = gpu.generation
    // A new texture holds nothing yet: every buffer uploads again.
    for (const b of state.cameras.values()) b.uploaded = -1
  }
  return { uniform: state.uniform!, texture: state.view! }
}

/** Uploads what changed of each camera's pyramid and the projections, after the raster. */
export function upload(world: World): void {
  {
    const state = world.resource(OcclusionStateResource)
    const gpu = world.resource(Gpu)
    if (gpu.tier !== 'full' || state.cameras.size === 0) return
    const copy = gpuCopy(state, gpu)
    if (!copy) return
    const u = state.uniformData
    const uu = state.uniformU32
    for (const b of state.cameras.values()) {
      if (b.layer < 0 || !b.valid) continue
      const o = b.layer * OCCLUSION_VIEW_FLOATS
      u.set(b.view, o)
      u[o + 16] = b.sx
      u[o + 17] = b.sy
      u[o + 18] = b.near
      u[o + 19] = b.orthographic ? 1 : 0
      uu[o + 20] = b.width
      uu[o + 21] = b.height
      uu[o + 22] = b.levels
      uu[o + 23] = 0
      if (b.uploaded === b.rasters) continue
      b.uploaded = b.rasters
      for (let l = 0; l < b.levels; l++) {
        gpu.device.queue.writeTexture(
          { texture: state.texture!, mipLevel: l, origin: { x: 0, y: 0, z: b.layer } },
          b.data,
          { offset: b.offsets[l]! * 4, bytesPerRow: b.widths[l]! * 4, rowsPerImage: b.heights[l]! },
          [b.widths[l]!, b.heights[l]!, 1],
        )
      }
    }
    gpu.device.queue.writeBuffer(state.uniform!, 0, u)
  }
}
