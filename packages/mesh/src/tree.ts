import { Rng } from '@aethervtt/shard-core'
import { type MeshBuilder, perpendicular } from './builder'
import { DEG, sinCos } from './trig'

export interface TreeSkeletonOptions {
  /** The trunk: length (m), base radius (m), and segments along it. */
  trunk?: { length?: number; radius?: number; segments?: number }
  /** Children per branch (default 4). */
  branches?: number
  /** Levels of branches below the trunk (default 2; 0 is a bare trunk). */
  levels?: number
  /** Degrees between a child and its parent (default 45). */
  spread?: number
  /** A child's length as a fraction of its parent's (default 0.55). */
  lengthScale?: number
  /** A child's base radius as a fraction of its parent's radius where it starts (default 0.7). */
  radiusScale?: number
  /** Tip radius as a fraction of the base radius (default 0.35). */
  taper?: number
  /** Downward bend per metre of branch (default 0.08; negative bends up). */
  gravity?: number
  /** Random wander of a branch's direction per segment (default 0.15). */
  wobble?: number
  /** Where along its parent the first child starts, 0 to 1 (default 0.35). */
  start?: number
  seed: number
}

/** One branch: a polyline with a radius per point. */
export interface TreeBranch {
  /** 0 is the trunk. */
  level: number
  /** Index of the parent branch, or −1 for the trunk. */
  parent: number
  /** xyz per point, base first. */
  points: Float64Array
  radii: Float64Array
}

export interface TreeSkeleton {
  branches: TreeBranch[]
  /** Highest point (m). */
  height: number
}

const sc = new Float64Array(2)

/**
 * A recursive branch graph (spec 0045): a trunk up +Y from the origin, each branch sprouting
 * `branches` children along its upper part, bent by `gravity` and a seeded wobble. Deterministic
 * per seed on every host (seeded RNG, trig through `sinCos`).
 */
export function treeSkeleton(options: TreeSkeletonOptions): TreeSkeleton {
  const rng = new Rng(options.seed)
  const trunkLength = options.trunk?.length ?? 6
  const trunkRadius = options.trunk?.radius ?? 0.25
  const segments = Math.max(2, options.trunk?.segments ?? 8)
  const children = Math.max(0, Math.floor(options.branches ?? 4))
  const levels = Math.max(0, Math.floor(options.levels ?? 2))
  const spread = (options.spread ?? 45) * DEG
  const lengthScale = options.lengthScale ?? 0.55
  const radiusScale = options.radiusScale ?? 0.7
  const taper = options.taper ?? 0.35
  const gravity = options.gravity ?? 0.08
  const wobble = options.wobble ?? 0.15
  const start = options.start ?? 0.35
  const branches: TreeBranch[] = []
  let height = 0

  const grow = (
    level: number,
    parent: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    length: number,
    radius: number,
  ) => {
    const n = Math.max(2, Math.ceil(segments / (level + 1)))
    const points = new Float64Array((n + 1) * 3)
    const radii = new Float64Array(n + 1)
    const step = length / n
    let x = ox
    let y = oy
    let z = oz
    for (let i = 0; i <= n; i++) {
      points[i * 3] = x
      points[i * 3 + 1] = y
      points[i * 3 + 2] = z
      radii[i] = radius * (1 - (1 - taper) * (i / n))
      if (y > height) height = y
      if (i === n) break
      x += dx * step
      y += dy * step
      z += dz * step
      // Bend: gravity pulls the direction down; wobble nudges it sideways.
      dy -= gravity * step * (level === 0 ? 0.2 : 1)
      dx += (rng.float() - 0.5) * wobble
      dy += (rng.float() - 0.5) * wobble * 0.5
      dz += (rng.float() - 0.5) * wobble
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      dx /= len
      dy /= len
      dz /= len
    }
    const index = branches.length
    branches.push({ level, parent, points, radii })
    if (level >= levels || children === 0) return
    const side = new Float64Array(3)
    const other = new Float64Array(3)
    // Children spread around the parent by the golden angle, from `start` to the tip.
    const azimuth0 = rng.float() * Math.PI * 2
    for (let c = 0; c < children; c++) {
      const t = start + (1 - start) * ((c + 0.3 + rng.float() * 0.4) / children)
      const f = t * n
      const i = Math.min(n - 1, Math.floor(f))
      const k = f - i
      const px = points[i * 3]! + (points[i * 3 + 3]! - points[i * 3]!) * k
      const py = points[i * 3 + 1]! + (points[i * 3 + 4]! - points[i * 3 + 1]!) * k
      const pz = points[i * 3 + 2]! + (points[i * 3 + 5]! - points[i * 3 + 2]!) * k
      let tx = points[i * 3 + 3]! - points[i * 3]!
      let ty = points[i * 3 + 4]! - points[i * 3 + 1]!
      let tz = points[i * 3 + 5]! - points[i * 3 + 2]!
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
      tx /= tl
      ty /= tl
      tz /= tl
      perpendicular(tx, ty, tz, side)
      // other = t × side
      other[0] = ty * side[2]! - tz * side[1]!
      other[1] = tz * side[0]! - tx * side[2]!
      other[2] = tx * side[1]! - ty * side[0]!
      sinCos(azimuth0 + c * 2.399963229728653 + (rng.float() - 0.5) * 0.5, sc)
      const sx = side[0]! * sc[1]! + other[0]! * sc[0]!
      const sy = side[1]! * sc[1]! + other[1]! * sc[0]!
      const sz = side[2]! * sc[1]! + other[2]! * sc[0]!
      sinCos(spread * (0.8 + rng.float() * 0.4), sc)
      let cx = tx * sc[1]! + sx * sc[0]!
      let cy = ty * sc[1]! + sy * sc[0]!
      let cz = tz * sc[1]! + sz * sc[0]!
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1
      cx /= cl
      cy /= cl
      cz /= cl
      const r = radii[i]! + (radii[i + 1]! - radii[i]!) * k
      // Higher children are shorter, like a real crown.
      const len = length * lengthScale * (1.15 - 0.4 * t) * (0.85 + rng.float() * 0.3)
      grow(level + 1, index, px, py, pz, cx, cy, cz, len, r * radiusScale)
    }
  }

  grow(0, -1, 0, 0, 0, 0, 1, 0, trunkLength, trunkRadius)
  return { branches, height }
}

/**
 * Skins a skeleton with tubes (`sides` around each; fewer on deeper levels), appended to `b`.
 * Returns the index of the first vertex added.
 */
export function tubeAlong(
  b: MeshBuilder,
  skeleton: TreeSkeleton,
  options: { sides?: number; minSides?: number; vScale?: number } = {},
): number {
  const first = b.vertexCount
  const sides = options.sides ?? 8
  const minSides = options.minSides ?? 3
  for (const branch of skeleton.branches) {
    const s = Math.max(minSides, sides >> branch.level)
    b.tube(branch.points, branch.radii, { sides: s, caps: true, vScale: options.vScale ?? 1 })
  }
  return first
}

export interface LeafCardOptions {
  /** Cards per metre of branch (default 6). */
  density?: number
  /** Card size in metres (default 0.35). */
  size?: number
  /** Branch levels that carry leaves (default: the deepest level). */
  levels?: readonly number[]
  /**
   * `quad`: a square with UVs into a leaf atlas cell (alpha-tested texture). `leaf`: a pointed
   * six-vertex leaf shape that needs no texture (default).
   */
  shape?: 'quad' | 'leaf'
  /** Atlas columns and rows: each card picks a cell (default [1, 1]). */
  atlas?: readonly [number, number]
  /** How far cards droop, 0 (facing out) to 1 (hanging) (default 0.3). */
  droop?: number
  seed: number
}

/**
 * Leaf cards along the given branch levels, appended to `b`: each card is two-sided (front and
 * back faces), so it lights correctly with any material. Returns the index of the first vertex.
 */
export function leafCards(
  b: MeshBuilder,
  skeleton: TreeSkeleton,
  options: LeafCardOptions,
): number {
  const first = b.vertexCount
  const rng = new Rng(options.seed)
  const deepest = skeleton.branches.reduce((m, br) => Math.max(m, br.level), 0)
  const levels = new Set(options.levels ?? [deepest])
  const density = options.density ?? 6
  const size = options.size ?? 0.35
  const shape = options.shape ?? 'leaf'
  const cols = options.atlas?.[0] ?? 1
  const rows = options.atlas?.[1] ?? 1
  const droop = options.droop ?? 0.3
  const side = new Float64Array(3)
  for (const branch of skeleton.branches) {
    if (!levels.has(branch.level)) continue
    const p = branch.points
    const n = p.length / 3 - 1
    for (let i = 0; i < n; i++) {
      const ax = p[i * 3]!
      const ay = p[i * 3 + 1]!
      const az = p[i * 3 + 2]!
      let tx = p[i * 3 + 3]! - ax
      let ty = p[i * 3 + 4]! - ay
      let tz = p[i * 3 + 5]! - az
      const segment = Math.sqrt(tx * tx + ty * ty + tz * tz)
      if (!(segment > 0)) continue
      tx /= segment
      ty /= segment
      tz /= segment
      // Whole cards per segment, with the fraction rounded by the RNG (density holds on average).
      const want = segment * density
      const cards = Math.floor(want) + (rng.float() < want - Math.floor(want) ? 1 : 0)
      for (let c = 0; c < cards; c++) {
        const t = rng.float()
        const ox = ax + tx * segment * t
        const oy = ay + ty * segment * t
        const oz = az + tz * segment * t
        // Out from the branch at a random angle, drooping toward −Y.
        perpendicular(tx, ty, tz, side)
        sinCos(rng.float() * Math.PI * 2, sc)
        const bx = ty * side[2]! - tz * side[1]!
        const by = tz * side[0]! - tx * side[2]!
        const bz = tx * side[1]! - ty * side[0]!
        let ux = side[0]! * sc[1]! + bx * sc[0]! + tx * 0.5
        let uy = side[1]! * sc[1]! + by * sc[0]! + ty * 0.5 - droop
        let uz = side[2]! * sc[1]! + bz * sc[0]! + tz * 0.5
        const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
        ux /= ul
        uy /= ul
        uz /= ul
        // The card's width axis: across the leaf, roughly horizontal.
        let wx = uy * 0 - uz * 1
        let wy = uz * 0 - ux * 0
        let wz = ux * 1 - uy * 0
        let wl = Math.sqrt(wx * wx + wy * wy + wz * wz)
        if (wl < 1e-6) {
          wx = 1
          wy = 0
          wz = 0
          wl = 1
        }
        wx /= wl
        wy /= wl
        wz /= wl
        // Normal = w × u (tilted toward the sky by construction).
        let nx = wy * uz - wz * uy
        let ny = wz * ux - wx * uz
        let nz = wx * uy - wy * ux
        if (ny < 0) {
          nx = -nx
          ny = -ny
          nz = -nz
          wx = -wx
          wy = -wy
          wz = -wz
        }
        const s = size * (0.75 + rng.float() * 0.5)
        const cell = Math.floor(rng.float() * cols * rows)
        const cu = (cell % cols) / cols
        const cv = Math.floor(cell / cols) / rows
        // Card outline in (across, along) units: a quad, or a pointed leaf.
        const outline =
          shape === 'quad'
            ? [-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1]
            : [0, 0, 0.3, 0.3, 0.32, 0.65, 0, 1, -0.32, 0.65, -0.3, 0.3]
        const count = outline.length / 2
        for (let face = 0; face < 2; face++) {
          const sign = face === 0 ? 1 : -1
          const base = b.vertexCount
          for (let k = 0; k < count; k++) {
            const a = outline[k * 2]! * s
            const l = outline[k * 2 + 1]! * s
            b.vertex(
              ox + wx * a + ux * l,
              oy + wy * a + uy * l,
              oz + wz * a + uz * l,
              nx * sign,
              ny * sign,
              nz * sign,
              cu + (outline[k * 2]! + 0.5) / cols,
              cv + (1 - outline[k * 2 + 1]!) / rows,
            )
          }
          for (let k = 1; k < count - 1; k++) {
            if (face === 0) b.triangle(base, base + k, base + k + 1)
            else b.triangle(base, base + k + 1, base + k)
          }
        }
      }
    }
  }
  return first
}
