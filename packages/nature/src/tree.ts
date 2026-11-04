import { type Rng, ShardError } from '@aethervtt/shard-core'
import { dcos, dsin, MeshBuilder, sinCos } from '@aethervtt/shard-mesh'
import type { TreeSpeciesValue } from './species'

/*
 * Growing and meshing a tree (spec 0095), ported from EZ-Tree (MIT, © 2024 Daniel Greenheck,
 * https://github.com/dgreenheck/ez-tree). Growing uses the RNG; meshing doesn't, so every level of
 * detail meshes the same skeleton.
 *
 * Differences from EZ-Tree: orientations are quaternions (EZ-Tree perturbs Euler angles; adding to
 * an XYZ Euler's x is a world-X rotation before it, and to its z a local-Z rotation after, which is
 * what this does), interpolated with nlerp; every sine and cosine comes from `sinCos`, so the same
 * seed gives the same bytes in every JavaScript engine; no trellis; bark UVs advance with length
 * so texels stay square, and leaf UVs follow Shard's convention (v down).
 */

/**
 * EZ-Tree's unit, in metres. Its bends and growth force scale with 1 / radius in that unit, so
 * growing in metres divides radii by this first and the shapes stay the same.
 */
export const EZ_UNIT = 0.18

/** Triangles a tree may have at full detail before `nature/too-big`. */
export const MAX_TREE_TRIANGLES = 2_000_000

/** Floats per section: origin xyz, orientation xyzw, radius, distance along the branch. */
const SECTION = 9
/** Floats per leaf: origin xyz, orientation xyzw, size, shade. */
const LEAF = 9

/** One grown branch: its rings, from base to tip. */
export interface SkeletonBranch {
  level: number
  /** `SECTION` floats per ring. */
  sections: Float64Array
  count: number
  segmentCount: number
  baseRadius: number
}

/** A grown tree: branches and leaf placements, ready to mesh at any detail. */
export interface TreeSkeleton {
  branches: SkeletonBranch[]
  /** `LEAF` floats per leaf. */
  leaves: Float64Array
  leafCount: number
}

/** How much of a skeleton a mesh keeps (a species' LOD entry; full detail is all 1s). */
export interface TreeDetail {
  sectionStride: number
  segmentFactor: number
  leafStride: number
  leafScale: number
  billboard: 'single' | 'double'
}

interface Pending {
  ox: number
  oy: number
  oz: number
  q: Float64Array
  length: number
  radius: number
  level: number
  sectionCount: number
  segmentCount: number
}

// --- quaternions (x, y, z, w) ------------------------------------------------------------------

const sc = new Float64Array(2)
const v3 = new Float64Array(3)

function quat(): Float64Array {
  const q = new Float64Array(4)
  q[3] = 1
  return q
}

/** out = a × b (apply b, then a). `out` may be `a` or `b`. */
function mul(a: Float64Array, b: Float64Array, out: Float64Array): Float64Array {
  const ax = a[0]!
  const ay = a[1]!
  const az = a[2]!
  const aw = a[3]!
  const bx = b[0]!
  const by = b[1]!
  const bz = b[2]!
  const bw = b[3]!
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

/** A rotation of `angle` radians about the unit axis (x, y, z). */
function axisAngle(
  x: number,
  y: number,
  z: number,
  angle: number,
  out: Float64Array,
): Float64Array {
  sinCos(angle * 0.5, sc)
  out[0] = x * sc[0]!
  out[1] = y * sc[0]!
  out[2] = z * sc[0]!
  out[3] = sc[1]!
  return out
}

/** Rotates (x, y, z) by q into `out` (xyz). */
function rotate(
  q: ArrayLike<number>,
  o: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
) {
  const qx = q[o]!
  const qy = q[o + 1]!
  const qz = q[o + 2]!
  const qw = q[o + 3]!
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + (qy * tz - qz * ty)
  out[1] = y + qw * ty + (qz * tx - qx * tz)
  out[2] = z + qw * tz + (qx * ty - qy * tx)
}

/** Normalized lerp from the quaternion at `a` to the one at `b` (shortest arc). */
function nlerp(s: Float64Array, a: number, b: number, t: number, out: Float64Array) {
  const sign = s[a]! * s[b]! + s[a + 1]! * s[b + 1]! + s[a + 2]! * s[b + 2]! + s[a + 3]! * s[b + 3]!
  const k = sign < 0 ? -t : t
  let len = 0
  for (let i = 0; i < 4; i++) {
    out[i] = s[a + i]! * (1 - t) + s[b + i]! * k
    len += out[i]! * out[i]!
  }
  len = Math.sqrt(len) || 1
  for (let i = 0; i < 4; i++) out[i] = out[i]! / len
}

// --- growing -----------------------------------------------------------------------------------

/**
 * Triangles a species makes at full detail, from its branch counts, without growing it. Throws
 * `nature/too-big` past `MAX_TREE_TRIANGLES`, before anything large is allocated.
 */
export function estimateTriangles(species: TreeSpeciesValue): number {
  const levels = species.levels
  const last = levels.length - 1
  const deciduous = species.form === 'deciduous'
  let count = 1
  let triangles = 0
  for (let l = 0; l <= last; l++) {
    const lv = levels[l]!
    triangles += count * lv.sections * lv.segments * 2
    if (l === last) break
    // Children of this level, plus a deciduous branch's continuation from its tip.
    count = count * lv.children + (deciduous ? count : 0)
  }
  const leaves = count * species.leaves.count + (deciduous ? count : 0)
  triangles += leaves * (species.leaves.billboard === 'double' ? 4 : 2)
  if (triangles > MAX_TREE_TRIANGLES) {
    // The level with the most children is usually the one to cut.
    let worst = 0
    for (let l = 1; l < last; l++) if (levels[l]!.children > levels[worst]!.children) worst = l
    throw new ShardError(
      'nature/too-big',
      `This species makes about ${Math.round(triangles / 1000)}k triangles, over the ${MAX_TREE_TRIANGLES / 1_000_000}M limit`,
      {
        path: last > 0 ? `/levels/${worst}/children` : '/leaves/count',
        hint: 'Fewer children per branch, fewer leaves per twig, or fewer sections and segments.',
      },
    )
  }
  return triangles
}

/** Grows a species' skeleton, drawing from `rng` only. */
export function growTree(species: TreeSpeciesValue, rng: Rng): TreeSkeleton {
  estimateTriangles(species)
  const levels = species.levels
  const last = levels.length - 1
  const deciduous = species.form === 'deciduous'
  const leaves = species.leaves
  const fd = species.force.direction
  const fl = Math.sqrt(fd[0] * fd[0] + fd[1] * fd[1] + fd[2] * fd[2]) || 1
  const fx = fd[0] / fl
  const fy = fd[1] / fl
  const fz = fd[2] / fl
  const strength = species.force.strength

  const skeleton: TreeSkeleton = { branches: [], leaves: new Float64Array(64 * LEAF), leafCount: 0 }
  const queue: Pending[] = []
  const trunk = levels[0]!
  queue.push({
    ox: 0,
    oy: 0,
    oz: 0,
    q: quat(),
    length: trunk.length,
    radius: trunk.radius,
    level: 0,
    sectionCount: trunk.sections,
    segmentCount: trunk.segments,
  })

  const q = quat()
  const tmp = quat()
  const parent = quat()

  const recordLeaf = (s: Float64Array, at: number) => {
    if ((skeleton.leafCount + 1) * LEAF > skeleton.leaves.length) {
      const next = new Float64Array(skeleton.leaves.length * 2)
      next.set(skeleton.leaves)
      skeleton.leaves = next
    }
    const o = skeleton.leafCount++ * LEAF
    const out = skeleton.leaves
    for (let i = 0; i < 7; i++) out[o + i] = s[at + i]!
    out[o + 7] = leaves.size * (1 + rng.range(-leaves.sizeVariance, leaves.sizeVariance))
    out[o + 8] = rng.float()
  }

  /** A random permutation of 0 … count − 1. */
  const shuffled = (count: number): Uint16Array => {
    const arr = new Uint16Array(count)
    for (let k = 0; k < count; k++) arr[k] = k
    for (let k = count - 1; k > 0; k--) {
      const r = Math.floor(rng.float() * (k + 1))
      const t = arr[k]!
      arr[k] = arr[r]!
      arr[r] = t
    }
    return arr
  }

  /**
   * Points along a parent, stratified (`count` slots from `startMin` to the tip, jittered in each)
   * with angles stratified around it in a shuffled order, so height and side are uncorrelated.
   * Writes origin and orientation (tilted `angle` degrees off the parent) into `out` per point.
   */
  const along = (
    s: Float64Array,
    n: number,
    count: number,
    startMin: number,
    angle: number,
    out: Float64Array,
    at: (i: number, start: number, alpha: number, index: number) => void,
  ) => {
    const radialOffset = rng.float()
    const heightStep = (1 - startMin) / count
    const slots = shuffled(count)
    for (let i = 0; i < count; i++) {
      const start = startMin + (i + rng.float()) * heightStep
      const index = Math.min(n - 1, Math.floor(start * (n - 1)))
      const a = index * SECTION
      const b = index === n - 1 ? a : a + SECTION
      const alpha = (start - index / (n - 1)) * (n - 1)
      out[0] = s[a]! + (s[b]! - s[a]!) * alpha
      out[1] = s[a + 1]! + (s[b + 1]! - s[a + 1]!) * alpha
      out[2] = s[a + 2]! + (s[b + 2]! - s[a + 2]!) * alpha
      nlerp(s, a + 3, b + 3, alpha, parent)
      const jitter = rng.range(-0.5, 0.5)
      const radial = 2 * Math.PI * (radialOffset + (slots[i]! + jitter) / count)
      // parent × (about Y by the radial angle × about X by the tilt)
      axisAngle(0, 1, 0, radial, tmp)
      mul(tmp, axisAngle(1, 0, 0, angle * (Math.PI / 180), q), q)
      mul(parent, q, q)
      out[3] = q[0]!
      out[4] = q[1]!
      out[5] = q[2]!
      out[6] = q[3]!
      at(i, start, alpha, index)
    }
  }

  const point = new Float64Array(SECTION)
  for (let head = 0; head < queue.length; head++) {
    const br = queue[head]!
    const lv = levels[br.level]!
    const n = br.sectionCount + 1
    const sections = new Float64Array(n * SECTION)
    q.set(br.q)
    let ox = br.ox
    let oy = br.oy
    let oz = br.oz
    let dist = 0
    const sectionLength = br.length / br.sectionCount
    for (let i = 0; i < n; i++) {
      let radius = br.radius
      if (i === br.sectionCount && br.level === last) radius = 0.001 * EZ_UNIT
      else if (deciduous) radius *= 1 - lv.taper * (i / br.sectionCount)
      else radius *= 1 - i / br.sectionCount
      const o = i * SECTION
      sections[o] = ox
      sections[o + 1] = oy
      sections[o + 2] = oz
      sections.set(q, o + 3)
      sections[o + 7] = radius
      sections[o + 8] = dist
      if (i === br.sectionCount) break

      rotate(q, 0, 0, sectionLength, 0, v3)
      ox += v3[0]!
      oy += v3[1]!
      oz += v3[2]!
      dist += sectionLength

      // Bend at random, more on thin branches.
      const r = radius / EZ_UNIT
      const g = (r > 0 ? Math.max(1, 1 / Math.sqrt(r)) : 1) * lv.gnarliness
      const dx = rng.range(-g, g)
      const dz = rng.range(-g, g)
      mul(axisAngle(1, 0, 0, dx, tmp), q, q)
      mul(q, axisAngle(0, 0, 1, dz, tmp), q)
      if (lv.twist !== 0) mul(q, axisAngle(0, 1, 0, lv.twist, tmp), q)

      // Turn toward the force direction (away with a negative strength), by at most the angle
      // between them.
      if (strength !== 0) {
        rotate(q, 0, 0, 1, 0, v3)
        let ax = v3[1]! * fz - v3[2]! * fy
        let ay = v3[2]! * fx - v3[0]! * fz
        let az = v3[0]! * fy - v3[1]! * fx
        const sinFull = Math.sqrt(ax * ax + ay * ay + az * az)
        if (sinFull > 1e-6) {
          ax /= sinFull
          ay /= sinFull
          az /= sinFull
          const cosFull = v3[0]! * fx + v3[1]! * fy + v3[2]! * fz
          const step = r > 0 ? strength / r : Number.POSITIVE_INFINITY
          const abs = Math.abs(step)
          // |step| ≥ the angle between them: turn all the way (half-angle from its cosine).
          if (abs >= Math.PI || dcos(abs) <= cosFull) {
            const s = Math.sqrt(Math.max(0, (1 - cosFull) * 0.5)) * Math.sign(step)
            tmp[0] = ax * s
            tmp[1] = ay * s
            tmp[2] = az * s
            tmp[3] = Math.sqrt(Math.max(0, (1 + cosFull) * 0.5))
          } else {
            const s = dsin(step * 0.5)
            tmp[0] = ax * s
            tmp[1] = ay * s
            tmp[2] = az * s
            tmp[3] = dcos(step * 0.5)
          }
          mul(tmp, q, q)
        }
      }
    }

    skeleton.branches.push({
      level: br.level,
      sections,
      count: n,
      segmentCount: br.segmentCount,
      baseRadius: br.radius,
    })

    const end = (n - 1) * SECTION
    // A deciduous branch continues from its tip into the next level; the last level ends in a leaf.
    if (deciduous) {
      if (br.level < last) {
        queue.push({
          ox: sections[end]!,
          oy: sections[end + 1]!,
          oz: sections[end + 2]!,
          q: sections.slice(end + 3, end + 7),
          length: levels[br.level + 1]!.length,
          radius: sections[end + 7]!,
          level: br.level + 1,
          // The same rings and sides as its parent, so the joint is seamless.
          sectionCount: br.sectionCount,
          segmentCount: br.segmentCount,
        })
      } else {
        recordLeaf(sections, end)
      }
    }

    if (br.level === last) {
      along(sections, n, leaves.count, leaves.start, leaves.angle, point, () =>
        recordLeaf(point, 0),
      )
    } else {
      const child = br.level + 1
      const cl = levels[child]!
      along(sections, n, lv.children, cl.start, cl.angle, point, (_, start, alpha, index) => {
        const a = index * SECTION
        const b = index === n - 1 ? a : a + SECTION
        queue.push({
          ox: point[0]!,
          oy: point[1]!,
          oz: point[2]!,
          q: point.slice(3, 7),
          length: cl.length * (deciduous ? 1 : 1 - start),
          radius: cl.radius * ((1 - alpha) * sections[a + 7]! + alpha * sections[b + 7]!),
          level: child,
          sectionCount: cl.sections,
          segmentCount: cl.segments,
        })
      })
    }
  }
  return skeleton
}

// --- meshing -----------------------------------------------------------------------------------

/** Full detail. */
export const FULL_DETAIL: TreeDetail = {
  sectionStride: 1,
  segmentFactor: 1,
  leafStride: 1,
  leafScale: 1,
  billboard: 'double',
}

/** Bark's part code at the outermost level (leaves are 1): sway reaches twigs, not the trunk. */
export const BARK_PART_MAX = 0.3

const n3 = new Float64Array(3)
const leafQ = quat()
const turn = quat()
const corners = new Float64Array(12)

/**
 * Meshes a skeleton into `b`: bark rings then leaf cards. uv0 is bark (wraps around, advancing with
 * length) or 0–1 across a leaf; uv1 is the part code (bark 0 to `BARK_PART_MAX` by level, leaves 1)
 * and a shade (bark 0.5, leaves random).
 */
export function meshTree(
  skeleton: TreeSkeleton,
  species: TreeSpeciesValue,
  detail: TreeDetail,
  b: MeshBuilder = MeshBuilder.create(),
): MeshBuilder {
  const last = species.levels.length - 1
  const [scaleX, scaleY] = species.bark.textureScale
  const stride = Math.max(1, Math.floor(detail.sectionStride))
  for (const br of skeleton.branches) {
    const s = br.sections
    const segments = Math.max(3, Math.round(br.segmentCount * detail.segmentFactor))
    const wraps = Math.max(1, Math.round(br.baseRadius * scaleX))
    // Metres of bark one texture width covers: v advances by length over it.
    const tile = Math.max(1e-4, (2 * Math.PI * br.baseRadius) / wraps)
    const part = last > 0 ? (BARK_PART_MAX * br.level) / last : 0
    const first = b.vertexCount
    let rings = 0
    for (let i = 0; ; i += stride) {
      // Every nth ring, and always the last, so joints stay put at every level of detail.
      const k = Math.min(i, br.count - 1)
      const o = k * SECTION
      const r = s[o + 7]!
      const v = (s[o + 8]! / tile) * scaleY
      for (let j = 0; j <= segments; j++) {
        sinCos((2 * Math.PI * (j % segments)) / segments, sc)
        rotate(s, o + 3, sc[1]!, 0, sc[0]!, n3)
        const vi = b.vertex(
          s[o]! + n3[0]! * r,
          s[o + 1]! + n3[1]! * r,
          s[o + 2]! + n3[2]! * r,
          n3[0]!,
          n3[1]!,
          n3[2]!,
          (j / segments) * wraps,
          v,
        )
        b.uv1(vi, part, 0.5)
      }
      rings++
      if (k === br.count - 1) break
    }
    const N = segments + 1
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < segments; j++) {
        const v1 = first + i * N + j
        const v2 = v1 + 1
        b.triangle(v1, v1 + N, v2).triangle(v2, v1 + N, v2 + N)
      }
    }
  }

  const leafStride = Math.max(1, Math.floor(detail.leafStride))
  const cards = detail.billboard === 'double' ? 2 : 1
  const rounded = species.leaves.roundedNormals
  const L = skeleton.leaves
  for (let i = 0; i < skeleton.leafCount; i += leafStride) {
    const o = i * LEAF
    const size = L[o + 7]! * detail.leafScale
    const shade = L[o + 8]!
    const half = size / 2
    rotate(L, o + 3, 0, 0, 1, n3)
    const nx = n3[0]!
    const ny = n3[1]!
    const nz = n3[2]!
    for (let c = 0; c < cards; c++) {
      leafQ[0] = L[o + 3]!
      leafQ[1] = L[o + 4]!
      leafQ[2] = L[o + 5]!
      leafQ[3] = L[o + 6]!
      // The second card turned a quarter about the leaf's axis.
      if (c === 1) mul(leafQ, axisAngle(0, 1, 0, Math.PI / 2, turn), leafQ)
      rotate(leafQ, 0, -half, size, 0, v3)
      corners.set(v3, 0)
      rotate(leafQ, 0, -half, 0, 0, v3)
      corners.set(v3, 3)
      rotate(leafQ, 0, half, 0, 0, v3)
      corners.set(v3, 6)
      rotate(leafQ, 0, half, size, 0, v3)
      corners.set(v3, 9)
      let cnx = nx
      let cny = ny
      let cnz = nz
      if (!rounded && c === 1) {
        rotate(leafQ, 0, 0, 0, 1, v3)
        cnx = v3[0]!
        cny = v3[1]!
        cnz = v3[2]!
      }
      const base = b.vertexCount
      for (let k = 0; k < 4; k++) {
        const cx = corners[k * 3]!
        const cy = corners[k * 3 + 1]!
        const cz = corners[k * 3 + 2]!
        let mx = cnx
        let my = cny
        let mz = cnz
        if (rounded) {
          // The card's normal leaned out toward the corner: the canopy shades as a volume.
          mx = nx + cx
          my = ny + cy
          mz = nz + cz
          const l = Math.sqrt(mx * mx + my * my + mz * mz) || 1
          mx /= l
          my /= l
          mz /= l
        }
        const u = k < 2 ? 0 : 1
        const v = k === 0 || k === 3 ? 0 : 1
        const vi = b.vertex(L[o]! + cx, L[o + 1]! + cy, L[o + 2]! + cz, mx, my, mz, u, v)
        b.uv1(vi, 1, shade)
      }
      b.quad(base, base + 1, base + 2, base + 3)
    }
  }
  return b
}
