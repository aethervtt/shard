import type { GpuContext } from '@aethervtt/shard-gpu'
import {
  CLUSTER_COUNT,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  clusterAabbs,
  clusterKey,
  clusterRange,
  lightTouchesCluster,
  VIEW_LIGHT_FLOATS,
  type ViewLightList,
} from '../clusters'
import { DataStore } from '../data-store'
import { LIGHT_FLOATS } from '../lights'
import type { CameraData } from '../view'

// Baseline tier (0064), loaded only on a baseline device: point and spot lights reach the fragment
// stage as one uniform array per view (at most BASELINE_MAX_LIGHTS), and clusters as a bitmask of
// that array's lights, one 128-bit texel per cluster, binned on the CPU. Mirrors the GPU binning
// test for test (`lightTouchesCluster`), so a light lights the same clusters on either tier.

/** Lights a view's uniform array holds on baseline (the bitmask's width). */
export const BASELINE_MAX_LIGHTS = 128

export interface BaselineViewLights {
  /** The packed light records (`@data(uniform, 128)` at binding 1). */
  lights: DataStore
  /** Four u32 of light bits per cluster (`@data` at binding 2). */
  bits: DataStore
  packed: Float32Array
  /** The light store slot of each packed light. */
  slots: Uint32Array
  words: Uint32Array
  /** What the AABBs were made for, and the AABBs (8 floats per cluster). */
  aabbKey: string
  aabbs: Float32Array
  /** Lights past the budget last frame (dropped, farthest first). */
  dropped: number
  /** Lights in view last frame, dropped ones included. */
  inView: number
  /** `dropped` as last reported to RenderHealth. */
  reported: number
  count: number
}

export function baselineViewLights(gpu: GpuContext, name: string): BaselineViewLights {
  return {
    lights: new DataStore(gpu, {
      label: `${name}/lights`,
      kind: 'uniform',
      size: BASELINE_MAX_LIGHTS * LIGHT_FLOATS * 4,
    }),
    bits: new DataStore(gpu, { label: `${name}/cluster-bits`, size: CLUSTER_COUNT * 16 }),
    packed: new Float32Array(BASELINE_MAX_LIGHTS * LIGHT_FLOATS),
    slots: new Uint32Array(BASELINE_MAX_LIGHTS),
    words: new Uint32Array(CLUSTER_COUNT * 4),
    aabbKey: '',
    aabbs: new Float32Array(CLUSTER_COUNT * 8),
    dropped: 0,
    inView: 0,
    reported: 0,
    count: 0,
  }
}

const box = new Float32Array(6)
const order = new Uint32Array(4096)
/** Sort keys when over budget: distance (1/256 m) above the list index. Unused ones sort last. */
const keys = new Float64Array(4096)

/**
 * Packs the view's visible lights (the nearest `max`, at most BASELINE_MAX_LIGHTS, when there are
 * more) and sets each one's bit in every cluster it touches. `records` is the light store's data
 * (LIGHT_FLOATS a slot); `list` the view's visible lights in view space.
 */
export function binBaselineLights(
  v: BaselineViewLights,
  list: ViewLightList,
  records: Float32Array,
  cam: CameraData,
  clusterFar: number,
  max: number,
): void {
  const budget = Math.max(0, Math.min(max, BASELINE_MAX_LIGHTS))
  const key = clusterKey(cam, clusterFar)
  if (key !== v.aabbKey) {
    v.aabbKey = key
    clusterAabbs(v.aabbs, cam, clusterFar)
  }
  const light = list.data
  const u32 = list.u32
  // Which of the list's lights, in which order: all of them, or the nearest when over budget.
  let n = Math.min(list.count, order.length)
  v.inView = n
  for (let i = 0; i < n; i++) order[i] = i
  if (n > budget) {
    // Nearest first, by the distance to each light's sphere; no allocation (a typed-array sort).
    for (let i = 0; i < keys.length; i++) {
      if (i >= n) {
        keys[i] = Number.POSITIVE_INFINITY
        continue
      }
      const o = 4 + i * VIEW_LIGHT_FLOATS
      const x = light[o]!
      const y = light[o + 1]!
      const z = light[o + 2]!
      const d = Math.max(0, Math.sqrt(x * x + y * y + z * z) - light[o + 3]!)
      keys[i] = Math.floor(Math.min(d, 1e9) * 256) * 4096 + i
    }
    keys.sort()
    for (let i = 0; i < n; i++) order[i] = keys[i]! % 4096
  }
  v.dropped = Math.max(0, n - budget)
  n = Math.min(n, budget)
  v.count = n
  v.words.fill(0)
  const [near, far] = clusterRange(cam, clusterFar)
  const logRatio = Math.log(far / near)
  for (let k = 0; k < n; k++) {
    const i = order[k]!
    const o = 4 + i * VIEW_LIGHT_FLOATS
    const slot = u32[o + 8]!
    v.slots[k] = slot
    v.packed.set(records.subarray(slot * LIGHT_FLOATS, (slot + 1) * LIGHT_FLOATS), k * LIGHT_FLOATS)
    // Candidate clusters: the depth slices and screen tiles the light's sphere can reach.
    const px = light[o]!
    const py = light[o + 1]!
    const pz = light[o + 2]!
    const range = light[o + 3]!
    const d0 = Math.max(near, -pz - range)
    const d1 = -pz + range
    if (d1 < near) continue
    // One slice and one tile of margin: the exact test below decides.
    const z0 = Math.max(0, Math.floor((Math.log(d0 / near) / logRatio) * CLUSTER_Z) - 1)
    const z1 = Math.min(CLUSTER_Z - 1, Math.floor((Math.log(d1 / near) / logRatio) * CLUSTER_Z) + 1)
    // Screen bounds of the sphere's box: x / d is monotonic in d, so its extremes are at the box's
    // nearest or farthest depth (clusterAabb's model: ndc = x · P00 / d, or x · P00 + P12).
    const p = cam.proj
    let nx0 = Number.POSITIVE_INFINITY
    let nx1 = Number.NEGATIVE_INFINITY
    let ny0 = Number.POSITIVE_INFINITY
    let ny1 = Number.NEGATIVE_INFINITY
    for (let e = 0; e < 4; e++) {
      const x = e & 1 ? px + range : px - range
      const y = e & 1 ? py + range : py - range
      for (let q = 0; q < 2; q++) {
        const d = q ? d1 : d0
        const ndcX = cam.orthographic ? x * p[0]! + p[12]! : (x * p[0]!) / d
        const ndcY = cam.orthographic ? y * p[5]! + p[13]! : (y * p[5]!) / d
        if (ndcX < nx0) nx0 = ndcX
        if (ndcX > nx1) nx1 = ndcX
        if (ndcY < ny0) ny0 = ndcY
        if (ndcY > ny1) ny1 = ndcY
      }
    }
    const x0 = Math.max(0, Math.floor(((nx0 + 1) / 2) * CLUSTER_X) - 1)
    const x1 = Math.min(CLUSTER_X - 1, Math.floor(((nx1 + 1) / 2) * CLUSTER_X) + 1)
    // Tile row 0 is the top of the screen.
    const y0 = Math.max(0, Math.floor(((1 - ny1) / 2) * CLUSTER_Y) - 1)
    const y1 = Math.min(CLUSTER_Y - 1, Math.floor(((1 - ny0) / 2) * CLUSTER_Y) + 1)
    const word = k >> 5
    const bit = 1 << (k & 31)
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const c = (z * CLUSTER_Y + y) * CLUSTER_X + x
          const a = c * 8
          box[0] = v.aabbs[a]!
          box[1] = v.aabbs[a + 1]!
          box[2] = v.aabbs[a + 2]!
          box[3] = v.aabbs[a + 4]!
          box[4] = v.aabbs[a + 5]!
          box[5] = v.aabbs[a + 6]!
          if (lightTouchesCluster(box, light, o)) v.words[c * 4 + word]! |= bit
        }
      }
    }
  }
  v.lights.write(v.packed, 0, 0, Math.max(1, n) * LIGHT_FLOATS)
  v.bits.write(v.words)
}
