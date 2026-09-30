import {
  add,
  cross,
  dot,
  EPSILON,
  length,
  normalize,
  type Q4,
  qConj,
  qFromBasis,
  qKey,
  qMul,
  qRotate,
  round,
  scale,
  stableTangent,
  sub,
  type V3,
} from './math'

// Convex polytopes from point sets: the faces of a hull die, the cells of a ball die, and the
// rotations that map a point set onto itself. Everything is found by enumeration, which is exact
// for the small sets dice have and doesn't depend on the order points arrive in.

export interface Face {
  /** Vertex indices, counter-clockwise seen from outside. */
  vertices: number[]
  normal: V3
  center: V3
}

export interface Polytope {
  points: V3[]
  faces: Face[]
}

export function pointsOf(flat: ArrayLike<number>): V3[] {
  const out: V3[] = []
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i]!, flat[i + 1]!, flat[i + 2]!])
  return out
}

const compareVector = (a: V3, b: V3) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]

/**
 * The faces of the convex hull of `points`: every plane through three points with all the others
 * on one side, its coplanar points gathered into one polygon. Faces are sorted by normal, so the
 * result doesn't depend on the order of `points` beyond their indices.
 */
export function convexFaces(points: readonly V3[]): Face[] {
  const faces = new Map<string, Face>()
  const n = points.length
  for (let a = 0; a < n - 2; a++) {
    for (let b = a + 1; b < n - 1; b++) {
      for (let c = b + 1; c < n; c++) {
        let normal = cross(sub(points[b]!, points[a]!), sub(points[c]!, points[a]!))
        if (dot(normal, normal) < 1e-10) continue
        normal = normalize(normal)
        const d = dot(normal, points[a]!)
        let positive = false
        let negative = false
        for (const p of points) {
          const side = dot(normal, p) - d
          if (side > EPSILON) positive = true
          else if (side < -EPSILON) negative = true
          if (positive && negative) break
        }
        if (positive && negative) continue
        if (positive) normal = scale(normal, -1)
        const plane = dot(normal, points[a]!)
        const members: number[] = []
        for (let i = 0; i < n; i++) {
          if (Math.abs(dot(normal, points[i]!) - plane) < EPSILON * 3) members.push(i)
        }
        const key = members.join(':')
        if (faces.has(key)) continue
        let center: V3 = [0, 0, 0]
        for (const i of members) center = add(center, points[i]!)
        center = scale(center, 1 / members.length)
        faces.set(key, { vertices: orderAround(members, points, normal, center), normal, center })
      }
    }
  }
  return [...faces.values()].sort((l, r) => compareVector(l.normal, r.normal))
}

/** Sorts a face's points counter-clockwise about its normal. */
function orderAround(members: number[], points: readonly V3[], normal: V3, center: V3): number[] {
  const t = stableTangent(normal)
  const b = cross(normal, t)
  const angle = (i: number) => {
    const d = sub(points[i]!, center)
    return Math.atan2(dot(d, b), dot(d, t))
  }
  return [...members].sort((l, r) => angle(l) - angle(r))
}

/**
 * The polytope whose faces are the tangent planes at unit `normals` (distance 1 from the center):
 * a ball die's flattened cells. Each face's vertices are the corners where three planes meet,
 * one per triangle of the points' hull.
 */
export function tangentPolytope(normals: readonly V3[]): Polytope {
  const triangles = convexFaces(normals)
  const points: V3[] = []
  const cells: number[][] = normals.map(() => [])
  for (const tri of triangles) {
    // Every triangle of points on a sphere in general position is a face of their hull.
    const [a, b, c] = tri.vertices as [number, number, number]
    const na = normals[a]!
    const nb = normals[b]!
    const nc = normals[c]!
    const det = dot(na, cross(nb, nc))
    // p · na = p · nb = p · nc = 1.
    const p = scale(add(add(cross(nb, nc), cross(nc, na)), cross(na, nb)), 1 / det)
    const index = points.push(p) - 1
    for (const i of tri.vertices) cells[i]!.push(index)
  }
  const faces = normals.map((normal, i): Face => {
    let center: V3 = [0, 0, 0]
    for (const v of cells[i]!) center = add(center, points[v]!)
    center = scale(center, 1 / cells[i]!.length)
    return { vertices: orderAround(cells[i]!, points, normal, center), normal, center }
  })
  return { points, faces }
}

// --- symmetry ----------------------------------------------------------------------------------

function hasPoint(points: readonly V3[], p: V3): boolean {
  for (const q of points) {
    const dx = q[0] - p[0]
    const dy = q[1] - p[1]
    const dz = q[2] - p[2]
    if (dx * dx + dy * dy + dz * dz < EPSILON * EPSILON * 9) return true
  }
  return false
}

/** Whether rotating `points` by `q` gives the same set. */
export function isSymmetry(points: readonly V3[], q: Q4): boolean {
  for (const p of points) if (!hasPoint(points, qRotate(q, p))) return false
  return true
}

function basisOf(a: V3, b: V3, c: V3): [V3, V3, V3] | undefined {
  const x = normalize(sub(b, a))
  const ac = sub(c, a)
  const yRaw = sub(ac, scale(x, dot(ac, x)))
  if (length(yRaw) < 1e-6) return undefined
  const y = normalize(yRaw)
  return [x, y, cross(x, y)]
}

/**
 * Every proper rotation that maps the point set onto itself, sorted by their canonical form. An
 * anchor triple is sent to every triple of matching pair distances; the rotations that also map
 * every other point onto the set are the group.
 */
export function symmetryGroup(points: readonly V3[]): Q4[] {
  const n = points.length
  let anchor: [number, number, number] | undefined
  for (let b = 1; b < n && !anchor; b++) {
    for (let c = b + 1; c < n && !anchor; c++) {
      if (length(cross(sub(points[b]!, points[0]!), sub(points[c]!, points[0]!))) > 1e-4)
        anchor = [0, b, c]
    }
  }
  if (!anchor) return []
  const [p0, p1, p2] = anchor.map((i) => points[i]!) as [V3, V3, V3]
  const d01 = length(sub(p1, p0))
  const d02 = length(sub(p2, p0))
  const d12 = length(sub(p2, p1))
  const source = basisOf(p0, p1, p2)!
  const fromSource = qConj(qFromBasis(...source))
  const found = new Map<string, Q4>()
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (b === a || Math.abs(length(sub(points[b]!, points[a]!)) - d01) > EPSILON * 10) continue
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue
        if (Math.abs(length(sub(points[c]!, points[a]!)) - d02) > EPSILON * 10) continue
        if (Math.abs(length(sub(points[c]!, points[b]!)) - d12) > EPSILON * 10) continue
        const target = basisOf(points[a]!, points[b]!, points[c]!)
        if (!target) continue
        const q = qMul(qFromBasis(...target), fromSource)
        // The anchor's own center must land on the target's too (rotations about the origin).
        const moved = qRotate(q, p0)
        if (length(sub(moved, points[a]!)) > EPSILON * 10) continue
        if (!isSymmetry(points, q)) continue
        found.set(qKey(q), q.map(round) as Q4)
      }
    }
  }
  return [...found.entries()].sort(([l], [r]) => l.localeCompare(r)).map(([, q]) => q)
}
