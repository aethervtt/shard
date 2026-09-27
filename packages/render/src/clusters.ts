import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import type { LightRecord } from './lights'
import type { CameraData } from './view'

/** Cluster grid: 16×9 screen tiles × 24 exponential depth slices. */
export const CLUSTER_X = 16
export const CLUSTER_Y = 9
export const CLUSTER_Z = 24
export const CLUSTER_COUNT = CLUSTER_X * CLUSTER_Y * CLUSTER_Z
export const MAX_LIGHTS_PER_CLUSTER = 128
/** Floats per entry in a view's light list: view-space position + range, axis + cos(outer). */
export const VIEW_LIGHT_FLOATS = 12

/** Cluster slice range for a camera: near to `clusterFar` (default: far plane, or 1 km). */
export function clusterRange(cam: CameraData, clusterFar: number): [number, number] {
  const near = Math.max(cam.near, 1e-4)
  const far = clusterFar > 0 ? clusterFar : cam.orthographic && cam.far > 0 ? cam.far : 1000
  return [near, Math.max(far, near * 1.01)]
}

/**
 * A view's clustering inputs: the visible lights in view space. Built on the CPU each frame from the
 * light store (frustum-tested), read by the GPU cluster pass and by `clusterLightsCpu`.
 */
export class ViewLightList {
  count = 0
  data = new Float32Array(4 + 64 * VIEW_LIGHT_FLOATS)
  u32 = new Uint32Array(this.data.buffer)
  /** The records of the visible lights, in list order. */
  readonly records: LightRecord[] = []

  /** Fills the list with lights whose influence sphere intersects the camera frustum. */
  build(cam: CameraData, lights: readonly (LightRecord | undefined)[], high: number): void {
    const f = cam.frustum
    const v = cam.view
    this.records.length = 0
    let n = 0
    for (let s = 0; s < high; s++) {
      const r = lights[s]
      if (!r?.alive || r.range <= 0) continue
      let inside = true
      for (let p = 0; p < 24; p += 4) {
        if (f[p]! * r.x + f[p + 1]! * r.y + f[p + 2]! * r.z + f[p + 3]! < -r.range) {
          inside = false
          break
        }
      }
      if (!inside) continue
      const o = 4 + n * VIEW_LIGHT_FLOATS
      if (o + VIEW_LIGHT_FLOATS > this.data.length) {
        const grown = new Float32Array(this.data.length * 2)
        grown.set(this.data)
        this.data = grown
        this.u32 = new Uint32Array(grown.buffer)
      }
      const d = this.data
      // View-space position (column-major view matrix).
      d[o] = v[0]! * r.x + v[4]! * r.y + v[8]! * r.z + v[12]!
      d[o + 1] = v[1]! * r.x + v[5]! * r.y + v[9]! * r.z + v[13]!
      d[o + 2] = v[2]! * r.x + v[6]! * r.y + v[10]! * r.z + v[14]!
      d[o + 3] = r.range
      d[o + 4] = v[0]! * r.dx + v[4]! * r.dy + v[8]! * r.dz
      d[o + 5] = v[1]! * r.dx + v[5]! * r.dy + v[9]! * r.dz
      d[o + 6] = v[2]! * r.dx + v[6]! * r.dy + v[10]! * r.dz
      d[o + 7] = r.cosOuter
      this.u32[o + 8] = r.slot
      this.u32[o + 9] = 0
      this.u32[o + 10] = 0
      this.u32[o + 11] = 0
      this.records.push(r)
      n++
    }
    this.count = n
    this.u32[0] = n
  }
}

const f32 = Math.fround

/**
 * The view-space AABB of cluster (x, y, z), written as [minX, minY, minZ, maxX, maxY, maxZ].
 * Mirrors `cluster_aabb` in `shard::lighting::cluster` operation for operation, in f32.
 */
export function clusterAabb(
  out: Float32Array,
  x: number,
  y: number,
  z: number,
  near: number,
  far: number,
  proj: ArrayLike<number>,
  orthographic: boolean,
): Float32Array {
  const ratio = f32(far / near)
  const d0 = f32(near * f32(ratio ** f32(z / CLUSTER_Z)))
  const d1 = f32(near * f32(ratio ** f32((z + 1) / CLUSTER_Z)))
  const x0 = f32(-1 + f32(f32(2 * x) / CLUSTER_X))
  const x1 = f32(-1 + f32(f32(2 * (x + 1)) / CLUSTER_X))
  const y1 = f32(1 - f32(f32(2 * y) / CLUSTER_Y))
  const y0 = f32(1 - f32(f32(2 * (y + 1)) / CLUSTER_Y))
  const p00 = proj[0]!
  const p11 = proj[5]!
  let minX: number
  let maxX: number
  let minY: number
  let maxY: number
  if (orthographic) {
    minX = f32(f32(x0 - proj[12]!) / p00)
    maxX = f32(f32(x1 - proj[12]!) / p00)
    minY = f32(f32(y0 - proj[13]!) / p11)
    maxY = f32(f32(y1 - proj[13]!) / p11)
  } else {
    // At depth d, ndc x maps to x·d/P00. Take the extremes over both depths.
    const ax = f32(f32(x0 * d0) / p00)
    const bx = f32(f32(x0 * d1) / p00)
    const cx = f32(f32(x1 * d0) / p00)
    const dx = f32(f32(x1 * d1) / p00)
    minX = Math.min(ax, bx, cx, dx)
    maxX = Math.max(ax, bx, cx, dx)
    const ay = f32(f32(y0 * d0) / p11)
    const by = f32(f32(y0 * d1) / p11)
    const cy = f32(f32(y1 * d0) / p11)
    const dy = f32(f32(y1 * d1) / p11)
    minY = Math.min(ay, by, cy, dy)
    maxY = Math.max(ay, by, cy, dy)
  }
  out[0] = minX
  out[1] = minY
  out[2] = -d1
  out[3] = maxX
  out[4] = maxY
  out[5] = -d0
  return out
}

/** Whether a view-space light (sphere, or cone for spots) touches a cluster AABB. Mirrors WGSL. */
export function lightTouchesCluster(box: Float32Array, light: Float32Array, o: number): boolean {
  const px = light[o]!
  const py = light[o + 1]!
  const pz = light[o + 2]!
  const range = light[o + 3]!
  // Sphere vs AABB: distance from the center to the closest point of the box.
  const cx = Math.min(Math.max(px, box[0]!), box[3]!)
  const cy = Math.min(Math.max(py, box[1]!), box[4]!)
  const cz = Math.min(Math.max(pz, box[2]!), box[5]!)
  const ex = f32(cx - px)
  const ey = f32(cy - py)
  const ez = f32(cz - pz)
  if (f32(f32(f32(ex * ex) + f32(ey * ey)) + f32(ez * ez)) > f32(range * range)) return false
  const cosOuter = light[o + 7]!
  if (cosOuter < -1) return true
  // Cone vs the box's bounding sphere (Wronski).
  const sx = f32(f32(f32(box[0]! + box[3]!) * 0.5) - px)
  const sy = f32(f32(f32(box[1]! + box[4]!) * 0.5) - py)
  const sz = f32(f32(f32(box[2]! + box[5]!) * 0.5) - pz)
  const hx = f32(f32(box[3]! - box[0]!) * 0.5)
  const hy = f32(f32(box[4]! - box[1]!) * 0.5)
  const hz = f32(f32(box[5]! - box[2]!) * 0.5)
  const radius = f32(Math.sqrt(f32(f32(f32(hx * hx) + f32(hy * hy)) + f32(hz * hz))))
  const lenSq = f32(f32(f32(sx * sx) + f32(sy * sy)) + f32(sz * sz))
  const v1 = f32(f32(f32(sx * light[o + 4]!) + f32(sy * light[o + 5]!)) + f32(sz * light[o + 6]!))
  const sinOuter = f32(Math.sqrt(Math.max(0, f32(1 - f32(cosOuter * cosOuter)))))
  const closest = f32(
    f32(cosOuter * f32(Math.sqrt(Math.max(0, f32(lenSq - f32(v1 * v1)))))) - f32(v1 * sinOuter),
  )
  if (closest > radius) return false
  if (v1 > f32(radius + range)) return false
  if (v1 < -radius) return false
  return true
}

/** Every cluster's view-space AABB, 8 floats each (min.xyz, 0, max.xyz, 0), for a camera. */
export function clusterAabbs(out: Float32Array, cam: CameraData, clusterFar: number): Float32Array {
  const [near, far] = clusterRange(cam, clusterFar)
  const box = new Float32Array(6)
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const x = c % CLUSTER_X
    const y = Math.floor(c / CLUSTER_X) % CLUSTER_Y
    const z = Math.floor(c / (CLUSTER_X * CLUSTER_Y))
    clusterAabb(box, x, y, z, near, far, cam.proj, cam.orthographic)
    out[c * 8] = box[0]!
    out[c * 8 + 1] = box[1]!
    out[c * 8 + 2] = box[2]!
    out[c * 8 + 4] = box[3]!
    out[c * 8 + 5] = box[4]!
    out[c * 8 + 6] = box[5]!
  }
  return out
}

/** A key for what the cluster AABBs depend on. */
export function clusterKey(cam: CameraData, clusterFar: number): string {
  const [near, far] = clusterRange(cam, clusterFar)
  const p = cam.proj
  return `${near}|${far}|${p[0]}|${p[5]}|${p[12]}|${p[13]}|${cam.orthographic}`
}

/** CPU clustering with the same results as the GPU pass: per cluster, the light slots. */
export function clusterLightsCpu(
  list: ViewLightList,
  cam: CameraData,
  clusterFar: number,
): { counts: Uint32Array; indices: Uint32Array; maxCount: number; overflows: number } {
  const aabbs = clusterAabbs(new Float32Array(CLUSTER_COUNT * 8), cam, clusterFar)
  const counts = new Uint32Array(CLUSTER_COUNT)
  const indices = new Uint32Array(CLUSTER_COUNT * MAX_LIGHTS_PER_CLUSTER)
  const box = new Float32Array(6)
  const light = new Float32Array(list.data.buffer)
  const u32 = list.u32
  let maxCount = 0
  let overflows = 0
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    box[0] = aabbs[c * 8]!
    box[1] = aabbs[c * 8 + 1]!
    box[2] = aabbs[c * 8 + 2]!
    box[3] = aabbs[c * 8 + 4]!
    box[4] = aabbs[c * 8 + 5]!
    box[5] = aabbs[c * 8 + 6]!
    let n = 0
    for (let i = 0; i < list.count; i++) {
      const o = 4 + i * VIEW_LIGHT_FLOATS
      if (!lightTouchesCluster(box, light, o)) continue
      if (n < MAX_LIGHTS_PER_CLUSTER) indices[c * MAX_LIGHTS_PER_CLUSTER + n] = u32[o + 8]!
      n++
    }
    counts[c] = Math.min(n, MAX_LIGHTS_PER_CLUSTER)
    if (n > maxCount) maxCount = n
    if (n > MAX_LIGHTS_PER_CLUSTER) overflows++
  }
  return { counts, indices, maxCount, overflows }
}

/** Cluster statistics from the GPU, one or two frames late. */
export interface ClusterStats {
  maxLightsPerCluster: number
  overflows: number
}

/** A view's GPU cluster buffers: light list in, counts + indices out, stats read back. */
export class ClusterBuffers {
  readonly lightList: GpuBuffer
  /** counts[CLUSTER_COUNT], then indices[CLUSTER_COUNT × MAX_LIGHTS_PER_CLUSTER]. */
  readonly clusters: GpuBuffer
  readonly stats: GpuBuffer
  readonly aabbs: GpuBuffer
  private aabbKey = ''
  private aabbGeneration = -1
  private readonly aabbData = new Float32Array(CLUSTER_COUNT * 8)
  readonly stats0 = new Uint32Array(4)
  latest: ClusterStats = { maxLightsPerCluster: 0, overflows: 0 }
  private readonly readbacks: { buffer: GPUBuffer; busy: boolean; generation: number }[] = []
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext, label: string) {
    this.gpu = gpu
    this.lightList = new GpuBuffer(gpu, {
      label: `${label}/light-list`,
      usage: GPUBufferUsage.STORAGE,
      size: (4 + 64 * VIEW_LIGHT_FLOATS) * 4,
    })
    this.clusters = new GpuBuffer(gpu, {
      label: `${label}/clusters`,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      size: CLUSTER_COUNT * (1 + MAX_LIGHTS_PER_CLUSTER) * 4,
    })
    this.aabbs = new GpuBuffer(gpu, {
      label: `${label}/cluster-aabbs`,
      usage: GPUBufferUsage.STORAGE,
      size: CLUSTER_COUNT * 8 * 4,
    })
    this.stats = new GpuBuffer(gpu, {
      label: `${label}/cluster-stats`,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      size: 16,
    })
  }

  upload(list: ViewLightList, cam: CameraData, clusterFar: number): void {
    const key = clusterKey(cam, clusterFar)
    if (key !== this.aabbKey || this.aabbGeneration !== this.gpu.generation) {
      this.aabbKey = key
      this.aabbGeneration = this.gpu.generation
      this.aabbs.write(clusterAabbs(this.aabbData, cam, clusterFar))
    }
    this.lightList.write(list.data, 0, 0, 4 + Math.max(1, list.count) * VIEW_LIGHT_FLOATS)
    this.stats.write(this.stats0)
  }

  /** Copies stats to a readback buffer; resolves into `latest` when mapped. */
  readback(encoder: GPUCommandEncoder): (() => void) | undefined {
    const gen = this.gpu.generation
    let rb = this.readbacks.find((r) => !r.busy && r.generation === gen)
    if (!rb && this.readbacks.length < 3) {
      rb = {
        buffer: this.gpu.device.createBuffer({
          label: 'cluster-stats/readback',
          size: 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
        generation: gen,
      }
      this.readbacks.push(rb)
    }
    if (!rb) {
      // Drop readbacks from a lost device.
      for (let i = this.readbacks.length - 1; i >= 0; i--)
        if (this.readbacks[i]!.generation !== gen) this.readbacks.splice(i, 1)
      return undefined
    }
    encoder.copyBufferToBuffer(this.stats.buffer, 0, rb.buffer, 0, 16)
    rb.busy = true
    const target = rb
    return () => {
      target.buffer.mapAsync(GPUMapMode.READ).then(
        () => {
          const v = new Uint32Array(target.buffer.getMappedRange().slice(0))
          target.buffer.unmap()
          target.busy = false
          this.latest = { maxLightsPerCluster: v[0]!, overflows: v[1]! }
        },
        () => {
          target.busy = false
        },
      )
    }
  }
}
