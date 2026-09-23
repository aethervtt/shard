import { defineResource, type Entity, mat4, ShardError, type World } from '@shard/core'
import type { Mesh } from '@shard/mesh'
import { GlobalTransform } from '@shard/transform'
import { Meshes } from './assets'
import { drawMaterials, ForwardStateResource, PASS_PICK } from './forward'
import type { NodeContext, NodeDescriptor, RenderView } from './graph'
import { RenderPhase } from './graph'
import { Lod, Mesh3d } from './instances'
import { DebugOverlays } from './overlays'
import { Graph, Views } from './plugin'
import { type CameraData, cameraOf } from './view'
import { ComputedVisibility } from './visibility'

export interface PickHit {
  entity: Entity
  /** Scene path, when the entity came from a scene. */
  path: string | undefined
  /** World position of the surface under the pixel. */
  position: [number, number, number]
  /** World normal of that surface, facing the camera. */
  normal: [number, number, number]
  /** Meters from the camera (from the ray origin, for raycasts). */
  distance: number
}

interface PickRequest {
  x: number
  y: number
  resolve: (hit: PickHit | undefined) => void
  reject: (error: unknown) => void
}

/**
 * Something that draws pickable things into the picking pass besides meshes (sprites). It gets
 * the pass with the picking targets bound (PICK_TARGETS: r32uint entity id, rgba32float normal
 * and depth) and a depth32float attachment (reversed Z, compare greater).
 */
export type PickDrawer = (ctx: NodeContext, cam: CameraData) => void

export interface PickingState {
  /** Requests per view name, served by the next frame that renders the view. */
  pending: Map<string, PickRequest[]>
  drawers: Map<string, PickDrawer>
  /** Views whose pick pass skipped a draw (a pipeline still compiling): their picks wait a frame. */
  incomplete: Set<string>
}

export const Picking = defineResource<PickingState>('render/Picking', {
  description: 'GPU picking: pending pick requests per view, and extra pick drawers (sprites).',
  init: () => ({ pending: new Map(), drawers: new Map(), incomplete: new Set() }),
})

/** The camera view `pick` and `render.capture` use by default: the first to render. */
export function primaryView(world: World): RenderView | undefined {
  let best: RenderView | undefined
  for (const view of world.resource(Views).list) {
    if (!cameraOf(view)) continue
    if (!best || view.order < best.order) best = view
  }
  return best
}

/**
 * What's under pixel (x, y) of a camera's view (pixels from the top left): the entity, its scene
 * path, and the world position and normal of the surface. Resolves after the next frame renders
 * the view; undefined when nothing's there. Meshes (instanced and LOD too) and world-space sprites
 * are pickable; gizmos and screen-space sprites and text aren't.
 */
export function pick(
  world: World,
  camera: Entity | undefined,
  x: number,
  y: number,
): Promise<PickHit | undefined> {
  const name = camera !== undefined ? `camera:${camera}` : primaryView(world)?.name
  if (!name) {
    return Promise.reject(
      new ShardError('render/no-view', 'Nothing to pick from: no camera renders to a target', {
        hint: 'Spawn an entity with Camera3d, or pass the camera to pick from.',
      }),
    )
  }
  const picking = world.resource(Picking)
  return new Promise((resolve, reject) => {
    let list = picking.pending.get(name)
    if (!list) {
      list = []
      picking.pending.set(name, list)
    }
    list.push({ x, y, resolve, reject })
  })
}

/** The picking pass: meshes, then the extra drawers, into the pick targets of views with requests. */
export function pickNode(world: World): NodeDescriptor {
  const picking = world.resource(Picking)
  return {
    kind: 'render',
    phase: RenderPhase.Debug,
    enabled: (view) =>
      cameraOf(view) !== undefined && (picking.pending.get(view.name)?.length ?? 0) > 0,
    reads: ['culled'],
    writes: ['pick-id', 'pick-normal', 'pick-depth'],
    color: [
      { resource: 'pick-id', clear: { r: 0, g: 0, b: 0, a: 0 } },
      { resource: 'pick-normal', clear: { r: 0, g: 0, b: 0, a: 0 } },
    ],
    depth: { resource: 'pick-depth', clear: 0 },
    run: (ctx) => {
      const cam = cameraOf(ctx.view)!
      const state = ctx.world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      const skipped = ctx.gpu.pipelines.skipped
      // Opaque then blended: every visible mesh, nearest wins.
      drawMaterials(ctx, state, pv, cam, cam.draws, PASS_PICK)
      if (cam.deferred) drawMaterials(ctx, state, pv, cam, cam.forwardOnly, PASS_PICK)
      drawMaterials(ctx, state, pv, cam, cam.transparent, PASS_PICK)
      for (const draw of picking.drawers.values()) draw(ctx, cam)
      if (ctx.gpu.pipelines.skipped > skipped) picking.incomplete.add(ctx.view.name)
    },
  }
}

const inv = new Float32Array(16)

/** Copies the requested pixels out of the pick targets and resolves the requests once mapped. */
export function pickReadbackNode(world: World): NodeDescriptor {
  const picking = world.resource(Picking)
  return {
    kind: 'raw',
    phase: RenderPhase.Debug + 1,
    enabled: (view) =>
      cameraOf(view) !== undefined && (picking.pending.get(view.name)?.length ?? 0) > 0,
    reads: ['pick-id', 'pick-normal'],
    sideEffects: true,
    run: (ctx) => {
      const requests = picking.pending.get(ctx.view.name)
      if (!requests || requests.length === 0) return
      // Something wasn't drawn: answer next frame rather than miss it.
      if (picking.incomplete.delete(ctx.view.name)) return
      picking.pending.set(ctx.view.name, [])
      const cam = cameraOf(ctx.view)!
      const device = ctx.gpu.device
      const id = ctx.texture('pick-id')
      const normal = ctx.texture('pick-normal')
      // One 256-byte row per target per request: id, then normal and depth.
      const buffer = device.createBuffer({
        label: 'pick/readback',
        size: requests.length * 512,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      const width = id.width
      const height = id.height
      requests.forEach((r, i) => {
        const x = Math.min(width - 1, Math.max(0, Math.floor(r.x)))
        const y = Math.min(height - 1, Math.max(0, Math.floor(r.y)))
        const origin = { x, y }
        ctx.encoder.copyTextureToBuffer(
          { texture: id, origin },
          { buffer, offset: i * 512, bytesPerRow: 256 },
          [1, 1],
        )
        ctx.encoder.copyTextureToBuffer(
          { texture: normal, origin },
          { buffer, offset: i * 512 + 256, bytesPerRow: 256 },
          [1, 1],
        )
      })
      if (!mat4.invert(inv, cam.viewProjNoJitter)) inv.fill(0)
      const unproject = new Float32Array(inv)
      const eye = Float32Array.from(cam.position)
      const name = ctx.world.resource(DebugOverlays).name
      const w = ctx.world
      ctx.afterSubmit(() => {
        buffer.mapAsync(GPUMapMode.READ).then(
          () => {
            const bytes = buffer.getMappedRange()
            requests.forEach((r, i) => {
              const entity = new Uint32Array(bytes, i * 512, 1)[0]!
              const n = new Float32Array(bytes, i * 512 + 256, 4)
              const d = n[3]!
              if (!(d > 0)) {
                r.resolve(undefined)
                return
              }
              const px = Math.min(width - 1, Math.max(0, Math.floor(r.x))) + 0.5
              const py = Math.min(height - 1, Math.max(0, Math.floor(r.y))) + 0.5
              const nx = (px / width) * 2 - 1
              const ny = 1 - (py / height) * 2
              const m = unproject
              const hw = m[3]! * nx + m[7]! * ny + m[11]! * d + m[15]!
              const position: [number, number, number] = [
                (m[0]! * nx + m[4]! * ny + m[8]! * d + m[12]!) / hw,
                (m[1]! * nx + m[5]! * ny + m[9]! * d + m[13]!) / hw,
                (m[2]! * nx + m[6]! * ny + m[10]! * d + m[14]!) / hw,
              ]
              const dx = position[0] - eye[0]!
              const dy = position[1] - eye[1]!
              const dz = position[2] - eye[2]!
              r.resolve({
                entity: entity as Entity,
                path: w.isAlive(entity) ? name(w, entity) : undefined,
                position,
                normal: [n[0]!, n[1]!, n[2]!],
                distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
              })
            })
            buffer.unmap()
            buffer.destroy()
          },
          (error) => {
            for (const r of requests) r.reject(error)
            buffer.destroy()
          },
        )
      })
    },
  }
}

/** Adds the picking targets and nodes to the graph. */
export function addPickNodes(world: World): void {
  const graph = world.resource(Graph)
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  graph.declare({ name: 'pick-id', format: 'r32uint', usage })
  graph.declare({ name: 'pick-normal', format: 'rgba32float', usage })
  graph.declare({ name: 'pick-depth', format: 'depth32float' })
  graph.addNode('picking', pickNode(world))
  graph.addNode('picking/readback', pickReadbackNode(world))
}

// --- CPU raycast ---------------------------------------------------------------------------------

export interface RaycastOptions {
  /** Ignore hits farther than this (m). Default: no limit. */
  maxDistance?: number
  /** Every hit along the ray, nearest first (default: only the nearest). */
  all?: boolean
  /** Test bounds only, never triangles. */
  boundsOnly?: boolean
}

interface Item {
  entity: Entity
  mesh: Mesh
  /** World matrix rows (12) and their inverse (12). */
  m: Float32Array
  inv: Float32Array
  box: Float32Array
}

/** A bounding volume hierarchy over the world bounds of mesh entities, rebuilt when they change. */
interface Bvh {
  items: Item[]
  /** Node boxes (6 floats each) and, per node, [left, right, 0] (inner) or [first item, 0, count]. */
  boxes: Float32Array
  nodes: Int32Array
  order: Int32Array
  count: number
  tick: number
  tables: number
}

const BvhResource = defineResource<{ bvh: Bvh | undefined }>('render/RaycastBvh', {
  description: 'The CPU raycast acceleration structure.',
  init: () => ({ bvh: undefined }),
})

function meshOf(world: World, entity: Entity): Mesh | undefined {
  const meshes = world.tryResource(Meshes)
  if (!meshes) return undefined
  const lod = world.tryGet(entity, Lod)
  const ref = lod?.levels[0]?.mesh ?? world.get(entity, Mesh3d).mesh
  return ref ? meshes.get(ref as never) : undefined
}

function invertAffine(m: Float32Array, out: Float32Array): void {
  const a = m[0]!
  const b = m[1]!
  const c = m[2]!
  const tx = m[3]!
  const d = m[4]!
  const e = m[5]!
  const f = m[6]!
  const ty = m[7]!
  const g = m[8]!
  const h = m[9]!
  const i = m[10]!
  const tz = m[11]!
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const s = det !== 0 ? 1 / det : 0
  out[0] = A * s
  out[1] = -(b * i - c * h) * s
  out[2] = (b * f - c * e) * s
  out[4] = B * s
  out[5] = (a * i - c * g) * s
  out[6] = -(a * f - c * d) * s
  out[8] = C * s
  out[9] = -(a * h - b * g) * s
  out[10] = (a * e - b * d) * s
  out[3] = -(out[0]! * tx + out[1]! * ty + out[2]! * tz)
  out[7] = -(out[4]! * tx + out[5]! * ty + out[6]! * tz)
  out[11] = -(out[8]! * tx + out[9]! * ty + out[10]! * tz)
}

function worldBox(bb: ArrayLike<number>, m: Float32Array, out: Float32Array): void {
  for (let r = 0; r < 3; r++) {
    const o = r * 4
    let lo = m[o + 3]!
    let hi = m[o + 3]!
    for (let k = 0; k < 3; k++) {
      const x = m[o + k]! * bb[k]!
      const y = m[o + k]! * bb[k + 3]!
      lo += Math.min(x, y)
      hi += Math.max(x, y)
    }
    out[r] = lo
    out[r + 3] = hi
  }
}

function buildBvh(world: World, tick: number, tables: number): Bvh {
  const items: Item[] = []
  for (const table of world.query({ with: [Mesh3d, GlobalTransform, ComputedVisibility] }).tables) {
    const g = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
    const vis = table.column(ComputedVisibility, 'visible')
    for (let i = 0; i < table.count; i++) {
      if (!vis[i]) continue
      const entity = table.entities[i]!
      const mesh = meshOf(world, entity)
      if (!mesh) continue
      const m = g.slice(i * 12, i * 12 + 12)
      const inverse = new Float32Array(12)
      invertAffine(m, inverse)
      const box = new Float32Array(6)
      worldBox(mesh.bounds, m, box)
      items.push({ entity, mesh, m, inv: inverse, box })
    }
  }
  const n = Math.max(1, items.length)
  const boxes = new Float32Array(n * 2 * 6)
  const nodes = new Int32Array(n * 2 * 3)
  const order = new Int32Array(items.length).map((_, i) => i)
  let count = 0
  const build = (start: number, end: number): number => {
    const node = count++
    const b = boxes.subarray(node * 6, node * 6 + 6)
    b.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
    for (let k = start; k < end; k++) {
      const ib = items[order[k]!]!.box
      for (let a = 0; a < 3; a++) {
        if (ib[a]! < b[a]!) b[a] = ib[a]!
        if (ib[a + 3]! > b[a + 3]!) b[a + 3] = ib[a + 3]!
      }
    }
    if (end - start <= 4) {
      nodes[node * 3] = start
      nodes[node * 3 + 2] = end - start
      return node
    }
    // Split at the median along the longest axis.
    let axis = 0
    for (let a = 1; a < 3; a++) if (b[a + 3]! - b[a]! > b[axis + 3]! - b[axis]!) axis = a
    const part = Array.from(order.subarray(start, end)).sort(
      (p, q) =>
        items[p]!.box[axis]! +
        items[p]!.box[axis + 3]! -
        (items[q]!.box[axis]! + items[q]!.box[axis + 3]!),
    )
    order.set(part, start)
    const mid = (start + end) >> 1
    const left = build(start, mid)
    const right = build(mid, end)
    nodes[node * 3] = left
    nodes[node * 3 + 1] = right
    nodes[node * 3 + 2] = 0
    return node
  }
  if (items.length > 0) build(0, items.length)
  return { items, boxes, nodes, order, count, tick, tables }
}

/** The BVH, rebuilt when a mesh entity moved, changed mesh, appeared, or went away. */
function bvhOf(world: World): Bvh {
  const r = world.initResource(BvhResource)
  const q = world.query({ with: [Mesh3d, GlobalTransform, ComputedVisibility] })
  let tick = 0
  for (const table of q.tables) {
    tick = Math.max(
      tick,
      table.lastStructural,
      table.lastChanged(GlobalTransform),
      table.lastChanged(Mesh3d),
      table.lastChanged(ComputedVisibility),
    )
  }
  const cur = r.bvh
  if (!cur || cur.tick !== tick || cur.tables !== q.tables.length)
    r.bvh = buildBvh(world, tick, q.tables.length)
  return r.bvh!
}

function slabs(
  o: ArrayLike<number>,
  d: ArrayLike<number>,
  b: ArrayLike<number>,
  max: number,
): number {
  let t0 = 0
  let t1 = max
  for (let a = 0; a < 3; a++) {
    const inv = 1 / d[a]!
    let near = (b[a]! - o[a]!) * inv
    let far = (b[a + 3]! - o[a]!) * inv
    if (near > far) {
      const t = near
      near = far
      far = t
    }
    if (Number.isNaN(near)) near = -Infinity
    if (Number.isNaN(far)) far = Infinity
    if (near > t0) t0 = near
    if (far < t1) t1 = far
    if (t0 > t1) return -1
  }
  return t0
}

const lo = new Float64Array(3)
const ld = new Float64Array(3)
const ln = new Float64Array(3)

/**
 * Nearest hit (distance along the local ray, which is the world distance) of a local ray against
 * a mesh's triangles; the local normal lands in `ln`. -1 on a miss.
 */
function intersectMesh(mesh: Mesh, max: number): number {
  const p = mesh.positions
  const idx = mesh.indices
  const tris = idx ? idx.length / 3 : p.length / 9
  let best = -1
  for (let t = 0; t < tris; t++) {
    const i0 = (idx ? idx[t * 3]! : t * 3) * 3
    const i1 = (idx ? idx[t * 3 + 1]! : t * 3 + 1) * 3
    const i2 = (idx ? idx[t * 3 + 2]! : t * 3 + 2) * 3
    const e1x = p[i1]! - p[i0]!
    const e1y = p[i1 + 1]! - p[i0 + 1]!
    const e1z = p[i1 + 2]! - p[i0 + 2]!
    const e2x = p[i2]! - p[i0]!
    const e2y = p[i2 + 1]! - p[i0 + 1]!
    const e2z = p[i2 + 2]! - p[i0 + 2]!
    const px = ld[1]! * e2z - ld[2]! * e2y
    const py = ld[2]! * e2x - ld[0]! * e2z
    const pz = ld[0]! * e2y - ld[1]! * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) continue
    const invDet = 1 / det
    const sx = lo[0]! - p[i0]!
    const sy = lo[1]! - p[i0 + 1]!
    const sz = lo[2]! - p[i0 + 2]!
    const u = (sx * px + sy * py + sz * pz) * invDet
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = (ld[0]! * qx + ld[1]! * qy + ld[2]! * qz) * invDet
    if (v < 0 || u + v > 1) continue
    const dist = (e2x * qx + e2y * qy + e2z * qz) * invDet
    if (dist < 0 || dist > max || (best >= 0 && dist >= best)) continue
    best = dist
    ln[0] = e1y * e2z - e1z * e2y
    ln[1] = e1z * e2x - e1x * e2z
    ln[2] = e1x * e2y - e1y * e2x
  }
  return best
}

/** Local ray against the local bounds; the face normal lands in `ln`. */
function intersectLocalBox(bb: ArrayLike<number>, max: number): number {
  const t = slabs(lo, ld, bb, max)
  if (t < 0) return -1
  let axis = 0
  let bestGap = Infinity
  for (let a = 0; a < 3; a++) {
    const p = lo[a]! + ld[a]! * t
    const gap = Math.min(Math.abs(p - bb[a]!), Math.abs(p - bb[a + 3]!))
    if (gap < bestGap) {
      bestGap = gap
      axis = a
    }
  }
  ln[0] = ln[1] = ln[2] = 0
  ln[axis] = ld[axis]! > 0 ? -1 : 1
  return t
}

/**
 * Casts a ray against mesh entities on the CPU: their bounds (through a BVH), then their triangles.
 * Works without a GPU. Direction needn't be normalized. Hits come back nearest first; normals face
 * the ray. Physics (M6) adds collider hits behind this same function.
 */
export function raycast(
  world: World,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  options: RaycastOptions = {},
): PickHit[] {
  const dl = Math.sqrt(direction[0]! ** 2 + direction[1]! ** 2 + direction[2]! ** 2)
  if (dl === 0) return []
  const d = [direction[0]! / dl, direction[1]! / dl, direction[2]! / dl]
  const max = options.maxDistance ?? Infinity
  const bvh = bvhOf(world)
  const name = world.tryResource(DebugOverlays)?.name
  const hits: PickHit[] = []
  let nearest = max
  const stack = [0]
  while (stack.length > 0 && bvh.items.length > 0) {
    const node = stack.pop()!
    const limit = options.all ? max : nearest
    if (slabs(origin, d, bvh.boxes.subarray(node * 6, node * 6 + 6), limit) < 0) continue
    const count = bvh.nodes[node * 3 + 2]!
    if (count === 0) {
      stack.push(bvh.nodes[node * 3]!, bvh.nodes[node * 3 + 1]!)
      continue
    }
    const first = bvh.nodes[node * 3]!
    for (let k = first; k < first + count; k++) {
      const item = bvh.items[bvh.order[k]!]!
      if (slabs(origin, d, item.box, options.all ? max : nearest) < 0) continue
      const iv = item.inv
      for (let r = 0; r < 3; r++) {
        lo[r] =
          iv[r * 4]! * origin[0]! +
          iv[r * 4 + 1]! * origin[1]! +
          iv[r * 4 + 2]! * origin[2]! +
          iv[r * 4 + 3]!
        ld[r] = iv[r * 4]! * d[0]! + iv[r * 4 + 1]! * d[1]! + iv[r * 4 + 2]! * d[2]!
      }
      const limit2 = options.all ? max : nearest
      const cpu = !options.boundsOnly && item.mesh.positions?.length > 0
      const t = cpu ? intersectMesh(item.mesh, limit2) : intersectLocalBox(item.mesh.bounds, limit2)
      if (t < 0) continue
      // Local normal to world: through the inverse transpose (rows of the inverse as columns).
      let nx = iv[0]! * ln[0]! + iv[4]! * ln[1]! + iv[8]! * ln[2]!
      let ny = iv[1]! * ln[0]! + iv[5]! * ln[1]! + iv[9]! * ln[2]!
      let nz = iv[2]! * ln[0]! + iv[6]! * ln[1]! + iv[10]! * ln[2]!
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      nx /= nl
      ny /= nl
      nz /= nl
      if (nx * d[0]! + ny * d[1]! + nz * d[2]! > 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      hits.push({
        entity: item.entity,
        path: name?.(world, item.entity),
        position: [origin[0]! + d[0]! * t, origin[1]! + d[1]! * t, origin[2]! + d[2]! * t],
        normal: [nx, ny, nz],
        distance: t,
      })
      if (t < nearest) nearest = t
    }
  }
  hits.sort((a, b) => a.distance - b.distance)
  return options.all ? hits : hits.slice(0, 1)
}
