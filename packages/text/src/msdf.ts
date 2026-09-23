/**
 * Multi-channel signed distance fields: a TypeScript port of msdfgen's core.
 *
 * - Per-channel perpendicular ("pseudo") distance with msdfgen's `MultiDistanceSelector`, per-edge
 *   distance caches, and the `OverlappingContourCombiner` (correct fields for overlapping contours).
 * - A scanline pass that fixes the sign of any texel whose median disagrees with the nonzero fill.
 * - msdfgen's edge-priority error correction: protect corners and edges, find texels whose linear
 *   or bilinear interpolation makes an artifact, and flatten those to their median.
 *
 * Everything per pixel runs on typed arrays that grow once and are reused across glyphs.
 * Coordinates follow msdfgen: shape units, y up; bitmap row 0 is the bottom row.
 */
import {
  colorEdgesSimple,
  contourWinding,
  EdgeColor,
  edgeDirection,
  normalizeShape,
  reverseContour,
  type Shape,
  shapeBounds,
} from './shape'

const MAX = Number.MAX_VALUE
const DELTA_FACTOR = 1.001
const CUBIC_SEARCH_STARTS = 4
const CUBIC_SEARCH_STEPS = 4

// --- flattened shape -------------------------------------------------------------------

let edgeCap = 0
/** Control points, 8 per edge. */
let P = new Float64Array(0)
let KIND = new Uint8Array(0)
let COLOR = new Uint8Array(0)
let PREV = new Int32Array(0)
let NEXT = new Int32Array(0)
/** direction(0) and direction(1), normalized (zero vectors become (0, 1)). */
let D0 = new Float64Array(0)
let D1 = new Float64Array(0)
/** direction(0) and direction(1), raw (msdfgen's fallbacks for degenerate control points). */
let R0 = new Float64Array(0)
let R1 = new Float64Array(0)
/** direction(0) and direction(1), normalized allowing zero. */
let Z0 = new Float64Array(0)
let Z1 = new Float64Array(0)
/** Normalized corner bisectors at the edge's start and end (msdfgen's domain distance). */
let BA = new Float64Array(0)
let BB = new Float64Array(0)
// Edge distance caches.
let CPX = new Float64Array(0)
let CPY = new Float64Array(0)
let CABS = new Float64Array(0)
let CAD = new Float64Array(0)
let CBD = new Float64Array(0)
let CAP = new Float64Array(0)
let CBP = new Float64Array(0)

let contourCap = 0
let CSTART = new Int32Array(0)
let CEND = new Int32Array(0)
let WINDING = new Int8Array(0)
/** Selector state per contour and channel (index contour * 3 + channel). */
let STD = new Float64Array(0)
let STDOT = new Float64Array(0)
let SNE = new Int32Array(0)
let SNP = new Float64Array(0)
let SNEG = new Float64Array(0)
let SPOS = new Float64Array(0)
let SPX = new Float64Array(0)
let SPY = new Float64Array(0)
/** Per-contour channel distances for the current pixel. */
let CD = new Float64Array(0)

let edgeCount = 0
let contourCount = 0

/** Merged selectors (shape, inner, outer) × channel: true distance, dot, near param, neg, pos. */
const MTD = new Float64Array(9)
const MTDOT = new Float64Array(9)
const MNE = new Int32Array(9)
const MNP = new Float64Array(9)
const MNEG = new Float64Array(9)
const MPOS = new Float64Array(9)
/** Resolved distances: shape, inner, outer, result × channel. */
const MD = new Float64Array(12)

/** distance, dot, param from the last edge evaluation. */
const SD = new Float64Array(3)
const ROOTS = new Float64Array(3)
const V = [0, 0]

function ensureEdges(n: number): void {
  if (n <= edgeCap) return
  edgeCap = Math.max(n, edgeCap * 2, 64)
  P = new Float64Array(edgeCap * 8)
  KIND = new Uint8Array(edgeCap)
  COLOR = new Uint8Array(edgeCap)
  PREV = new Int32Array(edgeCap)
  NEXT = new Int32Array(edgeCap)
  D0 = new Float64Array(edgeCap * 2)
  D1 = new Float64Array(edgeCap * 2)
  R0 = new Float64Array(edgeCap * 2)
  R1 = new Float64Array(edgeCap * 2)
  Z0 = new Float64Array(edgeCap * 2)
  Z1 = new Float64Array(edgeCap * 2)
  BA = new Float64Array(edgeCap * 2)
  BB = new Float64Array(edgeCap * 2)
  CPX = new Float64Array(edgeCap)
  CPY = new Float64Array(edgeCap)
  CABS = new Float64Array(edgeCap)
  CAD = new Float64Array(edgeCap)
  CBD = new Float64Array(edgeCap)
  CAP = new Float64Array(edgeCap)
  CBP = new Float64Array(edgeCap)
}

function ensureContours(n: number): void {
  if (n <= contourCap) return
  contourCap = Math.max(n, contourCap * 2, 16)
  CSTART = new Int32Array(contourCap)
  CEND = new Int32Array(contourCap)
  WINDING = new Int8Array(contourCap)
  STD = new Float64Array(contourCap * 3)
  STDOT = new Float64Array(contourCap * 3)
  SNE = new Int32Array(contourCap * 3)
  SNP = new Float64Array(contourCap * 3)
  SNEG = new Float64Array(contourCap * 3)
  SPOS = new Float64Array(contourCap * 3)
  SPX = new Float64Array(contourCap)
  SPY = new Float64Array(contourCap)
  CD = new Float64Array(contourCap * 3)
}

function normalized(out: Float64Array, o: number, x: number, y: number, allowZero: boolean) {
  const len = Math.sqrt(x * x + y * y)
  if (len === 0) {
    out[o] = 0
    out[o + 1] = allowZero ? 0 : 1
  } else {
    out[o] = x / len
    out[o + 1] = y / len
  }
}

/** Copies the shape into the typed arrays and precomputes per-edge directions. */
function flatten(shape: Shape): void {
  let n = 0
  for (const c of shape.contours) n += c.edges.length
  ensureEdges(n)
  ensureContours(shape.contours.length)
  edgeCount = n
  contourCount = shape.contours.length
  let e = 0
  for (let ci = 0; ci < shape.contours.length; ci++) {
    const contour = shape.contours[ci]!
    CSTART[ci] = e
    WINDING[ci] = contourWinding(contour)
    const m = contour.edges.length
    for (let k = 0; k < m; k++) {
      const edge = contour.edges[k]!
      const o = e * 8
      const p = edge.p
      for (let j = 0; j < 8; j++) P[o + j] = 0
      for (let j = 0; j < p.length; j++) P[o + j] = p[j]!
      if (edge.kind === 1) {
        P[o + 6] = p[2]!
        P[o + 7] = p[3]!
      } else if (edge.kind === 2) {
        P[o + 6] = p[4]!
        P[o + 7] = p[5]!
      }
      KIND[e] = edge.kind
      COLOR[e] = edge.color
      PREV[e] = CSTART[ci]! + ((k + m - 1) % m)
      NEXT[e] = CSTART[ci]! + ((k + 1) % m)
      edgeDirection(edge, 0, V)
      R0[e * 2] = V[0]!
      R0[e * 2 + 1] = V[1]!
      normalized(D0, e * 2, V[0]!, V[1]!, false)
      normalized(Z0, e * 2, V[0]!, V[1]!, true)
      edgeDirection(edge, 1, V)
      R1[e * 2] = V[0]!
      R1[e * 2 + 1] = V[1]!
      normalized(D1, e * 2, V[0]!, V[1]!, false)
      normalized(Z1, e * 2, V[0]!, V[1]!, true)
      e++
    }
    CEND[ci] = e
  }
  for (let i = 0; i < edgeCount; i++) {
    const pv = PREV[i]!
    const nx = NEXT[i]!
    normalized(BA, i * 2, Z1[pv * 2]! + Z0[i * 2]!, Z1[pv * 2 + 1]! + Z0[i * 2 + 1]!, true)
    normalized(BB, i * 2, Z1[i * 2]! + Z0[nx * 2]!, Z1[i * 2 + 1]! + Z0[nx * 2 + 1]!, true)
  }
}

/** End point x (t = 1) of edge i. */
const endX = (i: number) => P[i * 8 + 6]!
const endY = (i: number) => P[i * 8 + 7]!

// --- equation solving (msdfgen equation-solver) -----------------------------------------

function solveQuadratic(a: number, b: number, c: number): number {
  if (a === 0 || Math.abs(b) > 1e12 * Math.abs(a)) {
    if (b === 0) return c === 0 ? -1 : 0
    ROOTS[0] = -c / b
    return 1
  }
  let dscr = b * b - 4 * a * c
  if (dscr > 0) {
    dscr = Math.sqrt(dscr)
    ROOTS[0] = (-b + dscr) / (2 * a)
    ROOTS[1] = (-b - dscr) / (2 * a)
    return 2
  }
  if (dscr === 0) {
    ROOTS[0] = -b / (2 * a)
    return 1
  }
  return 0
}

function solveCubicNormed(a: number, b: number, c: number): number {
  const a2 = a * a
  let q = (1 / 9) * (a2 - 3 * b)
  const r = (1 / 54) * (a * (2 * a2 - 9 * b) + 27 * c)
  const r2 = r * r
  const q3 = q * q * q
  const a3 = a / 3
  if (r2 < q3) {
    let t = r / Math.sqrt(q3)
    if (t < -1) t = -1
    if (t > 1) t = 1
    t = Math.acos(t)
    q = -2 * Math.sqrt(q)
    ROOTS[0] = q * Math.cos(t / 3) - a3
    ROOTS[1] = q * Math.cos((t + 2 * Math.PI) / 3) - a3
    ROOTS[2] = q * Math.cos((t - 2 * Math.PI) / 3) - a3
    return 3
  }
  const u = (r < 0 ? 1 : -1) * Math.cbrt(Math.abs(r) + Math.sqrt(r2 - q3))
  const v = u === 0 ? 0 : q / u
  ROOTS[0] = u + v - a3
  if (u === v || Math.abs(u - v) < 1e-12 * Math.abs(u + v)) {
    ROOTS[1] = -0.5 * (u + v) - a3
    return 2
  }
  return 1
}

function solveCubic(a: number, b: number, c: number, d: number): number {
  if (a !== 0) {
    const bn = b / a
    if (Math.abs(bn) < 1e6) return solveCubicNormed(bn, c / a, d / a)
  }
  return solveQuadratic(b, c, d)
}

// --- edge distances -----------------------------------------------------------------------

/** msdfgen `EdgeSegment::signedDistance` into SD (distance, dot, param). */
function edgeSignedDistance(i: number, px: number, py: number): void {
  const o = i * 8
  const kind = KIND[i]!
  const x0 = P[o]!
  const y0 = P[o + 1]!
  if (kind === 1) {
    const x1 = P[o + 2]!
    const y1 = P[o + 3]!
    const aqx = px - x0
    const aqy = py - y0
    const abx = x1 - x0
    const aby = y1 - y0
    const abLen2 = abx * abx + aby * aby
    const param = (aqx * abx + aqy * aby) / abLen2
    const eqx = (param > 0.5 ? x1 : x0) - px
    const eqy = (param > 0.5 ? y1 : y0) - py
    const endpointDistance = Math.sqrt(eqx * eqx + eqy * eqy)
    const abLen = Math.sqrt(abLen2)
    SD[2] = param
    if (param > 0 && param < 1) {
      const ortho = (aby * aqx - abx * aqy) / abLen
      if (Math.abs(ortho) < endpointDistance) {
        SD[0] = ortho
        SD[1] = 0
        return
      }
    }
    SD[0] = (aqx * aby - aqy * abx > 0 ? 1 : -1) * endpointDistance
    const eqLen = endpointDistance
    const dot = eqLen === 0 ? aby / abLen : (abx * eqx + aby * eqy) / (abLen * eqLen)
    SD[1] = Math.abs(dot)
    return
  }
  if (kind === 2) {
    const x1 = P[o + 2]!
    const y1 = P[o + 3]!
    const x2 = P[o + 4]!
    const y2 = P[o + 5]!
    const qax = x0 - px
    const qay = y0 - py
    const abx = x1 - x0
    const aby = y1 - y0
    const brx = x2 - x1 - abx
    const bry = y2 - y1 - aby
    const a = brx * brx + bry * bry
    const b = 3 * (abx * brx + aby * bry)
    const c = 2 * (abx * abx + aby * aby) + (qax * brx + qay * bry)
    const d = qax * abx + qay * aby
    // Endpoint candidates first; msdfgen uses the raw direction for the sign and param.
    let ex = R0[i * 2]!
    let ey = R0[i * 2 + 1]!
    let minDistance = (ex * qay - ey * qax > 0 ? 1 : -1) * Math.sqrt(qax * qax + qay * qay)
    let param = -(qax * ex + qay * ey) / (ex * ex + ey * ey)
    const bqx = x2 - px
    const bqy = y2 - py
    const distB = Math.sqrt(bqx * bqx + bqy * bqy)
    if (distB < Math.abs(minDistance)) {
      ex = R1[i * 2]!
      ey = R1[i * 2 + 1]!
      minDistance = (ex * bqy - ey * bqx > 0 ? 1 : -1) * distB
      param = ((px - x1) * ex + (py - y1) * ey) / (ex * ex + ey * ey)
    }
    // The curve lies in its control points' box: when the box is farther than the nearer
    // endpoint, no interior point can be nearer, and the cubic solve can be skipped.
    const bx0 = x0 < x1 ? (x0 < x2 ? x0 : x2) : x1 < x2 ? x1 : x2
    const bx1 = x0 > x1 ? (x0 > x2 ? x0 : x2) : x1 > x2 ? x1 : x2
    const by0 = y0 < y1 ? (y0 < y2 ? y0 : y2) : y1 < y2 ? y1 : y2
    const by1 = y0 > y1 ? (y0 > y2 ? y0 : y2) : y1 > y2 ? y1 : y2
    const ox = px < bx0 ? bx0 - px : px > bx1 ? px - bx1 : 0
    const oy = py < by0 ? by0 - py : py > by1 ? py - by1 : 0
    const solutions = ox * ox + oy * oy > minDistance * minDistance ? 0 : solveCubic(a, b, c, d)
    for (let s = 0; s < solutions; s++) {
      const t = ROOTS[s]!
      if (t > 0 && t < 1) {
        const qex = qax + 2 * t * abx + t * t * brx
        const qey = qay + 2 * t * aby + t * t * bry
        const distance = Math.sqrt(qex * qex + qey * qey)
        if (distance <= Math.abs(minDistance)) {
          const dx = abx + t * brx
          const dy = aby + t * bry
          minDistance = (dx * qey - dy * qex > 0 ? 1 : -1) * distance
          param = t
        }
      }
    }
    SD[0] = minDistance
    SD[2] = param
    if (param >= 0 && param <= 1) SD[1] = 0
    else if (param < 0.5) SD[1] = endpointDot(i, true, qax, qay)
    else SD[1] = endpointDot(i, false, bqx, bqy)
    return
  }
  // Cubic.
  const x1 = P[o + 2]!
  const y1 = P[o + 3]!
  const x2 = P[o + 4]!
  const y2 = P[o + 5]!
  const x3 = P[o + 6]!
  const y3 = P[o + 7]!
  const qax = x0 - px
  const qay = y0 - py
  const abx = x1 - x0
  const aby = y1 - y0
  const brx = x2 - x1 - abx
  const bry = y2 - y1 - aby
  const asx = x3 - x2 - (x2 - x1) - brx
  const asy = y3 - y2 - (y2 - y1) - bry
  let ex = R0[i * 2]!
  let ey = R0[i * 2 + 1]!
  let minDistance = (ex * qay - ey * qax > 0 ? 1 : -1) * Math.sqrt(qax * qax + qay * qay)
  let param = -(qax * ex + qay * ey) / (ex * ex + ey * ey)
  const bqx = x3 - px
  const bqy = y3 - py
  const distB = Math.sqrt(bqx * bqx + bqy * bqy)
  if (distB < Math.abs(minDistance)) {
    ex = R1[i * 2]!
    ey = R1[i * 2 + 1]!
    minDistance = (ex * bqy - ey * bqx > 0 ? 1 : -1) * distB
    param = ((ex - bqx) * ex + (ey - bqy) * ey) / (ex * ex + ey * ey)
  }
  for (let s = 0; s <= CUBIC_SEARCH_STARTS; s++) {
    let t = s / CUBIC_SEARCH_STARTS
    let qex = qax + 3 * t * abx + 3 * t * t * brx + t * t * t * asx
    let qey = qay + 3 * t * aby + 3 * t * t * bry + t * t * t * asy
    let d1x = 3 * abx + 6 * t * brx + 3 * t * t * asx
    let d1y = 3 * aby + 6 * t * bry + 3 * t * t * asy
    let d2x = 6 * brx + 6 * t * asx
    let d2y = 6 * bry + 6 * t * asy
    let improved = t - (qex * d1x + qey * d1y) / (d1x * d1x + d1y * d1y + qex * d2x + qey * d2y)
    if (improved > 0 && improved < 1) {
      let remaining = CUBIC_SEARCH_STEPS
      do {
        t = improved
        qex = qax + 3 * t * abx + 3 * t * t * brx + t * t * t * asx
        qey = qay + 3 * t * aby + 3 * t * t * bry + t * t * t * asy
        d1x = 3 * abx + 6 * t * brx + 3 * t * t * asx
        d1y = 3 * aby + 6 * t * bry + 3 * t * t * asy
        if (--remaining === 0) break
        d2x = 6 * brx + 6 * t * asx
        d2y = 6 * bry + 6 * t * asy
        improved = t - (qex * d1x + qey * d1y) / (d1x * d1x + d1y * d1y + qex * d2x + qey * d2y)
      } while (improved > 0 && improved < 1)
      const distance = Math.sqrt(qex * qex + qey * qey)
      if (distance < Math.abs(minDistance)) {
        minDistance = (d1x * qey - d1y * qex > 0 ? 1 : -1) * distance
        param = t
      }
    }
  }
  SD[0] = minDistance
  SD[2] = param
  if (param >= 0 && param <= 1) SD[1] = 0
  else if (param < 0.5) SD[1] = endpointDot(i, true, qax, qay)
  else SD[1] = endpointDot(i, false, bqx, bqy)
}

/** |dot(direction.normalize(), q.normalize())| at an endpoint. */
function endpointDot(i: number, start: boolean, qx: number, qy: number): number {
  const dx = start ? D0[i * 2]! : D1[i * 2]!
  const dy = start ? D0[i * 2 + 1]! : D1[i * 2 + 1]!
  const len = Math.sqrt(qx * qx + qy * qy)
  if (len === 0) return Math.abs(dy)
  return Math.abs((dx * qx + dy * qy) / len)
}

/**
 * msdfgen `distanceToPerpendicularDistance`: beyond an endpoint, the distance to the tangent line
 * extended from it, when that's nearer. Returns the adjusted distance.
 */
function perpendicular(i: number, distance: number, px: number, py: number, param: number) {
  if (param < 0) {
    const dx = D0[i * 2]!
    const dy = D0[i * 2 + 1]!
    const aqx = px - P[i * 8]!
    const aqy = py - P[i * 8 + 1]!
    if (aqx * dx + aqy * dy < 0) {
      const perp = aqx * dy - aqy * dx
      if (Math.abs(perp) <= Math.abs(distance)) return perp
    }
  } else if (param > 1) {
    const dx = D1[i * 2]!
    const dy = D1[i * 2 + 1]!
    const bqx = px - endX(i)
    const bqy = py - endY(i)
    if (bqx * dx + bqy * dy > 0) {
      const perp = bqx * dy - bqy * dx
      if (Math.abs(perp) <= Math.abs(distance)) return perp
    }
  }
  return distance
}

// --- selectors ------------------------------------------------------------------------------

function resetSelectors(px: number, py: number): void {
  for (let c = 0; c < contourCount; c++) {
    const dx = px - SPX[c]!
    const dy = py - SPY[c]!
    const delta = DELTA_FACTOR * Math.sqrt(dx * dx + dy * dy)
    SPX[c] = px
    SPY[c] = py
    for (let ch = 0; ch < 3; ch++) {
      const s = c * 3 + ch
      const td = STD[s]! + (STD[s]! > 0 ? 1 : -1) * delta
      STD[s] = td
      SNEG[s] = -Math.abs(td)
      SPOS[s] = Math.abs(td)
      SNE[s] = -1
      SNP[s] = 0
    }
  }
}

function isEdgeRelevant(s: number, e: number, delta: number): boolean {
  const ad = CAD[e]!
  const bd = CBD[e]!
  if (CABS[e]! - delta <= Math.abs(STD[s]!) || Math.abs(ad) < delta || Math.abs(bd) < delta) {
    return true
  }
  if (ad > 0) {
    const ap = CAP[e]!
    if (ap < 0 ? ap + delta >= SNEG[s]! : ap - delta <= SPOS[s]!) return true
  }
  if (bd > 0) {
    const bp = CBP[e]!
    if (bp < 0 ? bp + delta >= SNEG[s]! : bp - delta <= SPOS[s]!) return true
  }
  return false
}

function addTrue(s: number, e: number, d: number, dot: number, param: number): void {
  const ad = Math.abs(d)
  const at = Math.abs(STD[s]!)
  if (ad < at || (ad === at && dot < STDOT[s]!)) {
    STD[s] = d
    STDOT[s] = dot
    SNE[s] = e
    SNP[s] = param
  }
}

function addPerpendicular(s: number, d: number): void {
  if (d <= 0 && d > SNEG[s]!) SNEG[s] = d
  if (d >= 0 && d < SPOS[s]!) SPOS[s] = d
}

/** msdfgen `MultiDistanceSelector::addEdge` for edge e of contour c. */
function addEdge(c: number, e: number, px: number, py: number): void {
  const color = COLOR[e]!
  const cdx = px - CPX[e]!
  const cdy = py - CPY[e]!
  const delta = DELTA_FACTOR * Math.sqrt(cdx * cdx + cdy * cdy)
  const base = c * 3
  if (
    !(
      (color & EdgeColor.red && isEdgeRelevant(base, e, delta)) ||
      (color & EdgeColor.green && isEdgeRelevant(base + 1, e, delta)) ||
      (color & EdgeColor.blue && isEdgeRelevant(base + 2, e, delta))
    )
  ) {
    return
  }
  edgeSignedDistance(e, px, py)
  const d = SD[0]!
  const dot = SD[1]!
  const param = SD[2]!
  if (color & EdgeColor.red) addTrue(base, e, d, dot, param)
  if (color & EdgeColor.green) addTrue(base + 1, e, d, dot, param)
  if (color & EdgeColor.blue) addTrue(base + 2, e, d, dot, param)
  CPX[e] = px
  CPY[e] = py
  CABS[e] = Math.abs(d)
  const o = e * 8
  const apx = px - P[o]!
  const apy = py - P[o + 1]!
  const bpx = px - endX(e)
  const bpy = py - endY(e)
  const add = apx * BA[e * 2]! + apy * BA[e * 2 + 1]!
  const bdd = -(bpx * BB[e * 2]! + bpy * BB[e * 2 + 1]!)
  if (add > 0) {
    let pd = d
    // getPerpendicularDistance(pd, ap, -aDir)
    const dirx = -Z0[e * 2]!
    const diry = -Z0[e * 2 + 1]!
    if (apx * dirx + apy * diry > 0) {
      const perp = apx * diry - apy * dirx
      if (Math.abs(perp) < Math.abs(pd)) {
        pd = -perp
        if (color & EdgeColor.red) addPerpendicular(base, pd)
        if (color & EdgeColor.green) addPerpendicular(base + 1, pd)
        if (color & EdgeColor.blue) addPerpendicular(base + 2, pd)
      }
    }
    CAP[e] = pd
  }
  if (bdd > 0) {
    let pd = d
    const dirx = Z1[e * 2]!
    const diry = Z1[e * 2 + 1]!
    if (bpx * dirx + bpy * diry > 0) {
      const perp = bpx * diry - bpy * dirx
      if (Math.abs(perp) < Math.abs(pd)) {
        pd = perp
        if (color & EdgeColor.red) addPerpendicular(base, pd)
        if (color & EdgeColor.green) addPerpendicular(base + 1, pd)
        if (color & EdgeColor.blue) addPerpendicular(base + 2, pd)
      }
    }
    CBP[e] = pd
  }
  CAD[e] = add
  CBD[e] = bdd
}

/** A selector's channel distance (msdfgen `computeDistance`). */
function selectorDistance(
  td: number,
  ne: number,
  np: number,
  neg: number,
  pos: number,
  px: number,
  py: number,
): number {
  let minDistance = td < 0 ? neg : pos
  if (ne >= 0) {
    const d = perpendicular(ne, td, px, py, np)
    if (Math.abs(d) < Math.abs(minDistance)) minDistance = d
  }
  return minDistance
}

function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
}

function resetMerged(m: number): void {
  for (let ch = 0; ch < 3; ch++) {
    const k = m * 3 + ch
    MTD[k] = -MAX
    MTDOT[k] = 0
    MNE[k] = -1
    MNP[k] = 0
    MNEG[k] = -MAX
    MPOS[k] = MAX
  }
}

function merge(m: number, c: number): void {
  for (let ch = 0; ch < 3; ch++) {
    const k = m * 3 + ch
    const s = c * 3 + ch
    const a = Math.abs(STD[s]!)
    const b = Math.abs(MTD[k]!)
    if (a < b || (a === b && STDOT[s]! < MTDOT[k]!)) {
      MTD[k] = STD[s]!
      MTDOT[k] = STDOT[s]!
      MNE[k] = SNE[s]!
      MNP[k] = SNP[s]!
    }
    if (SNEG[s]! > MNEG[k]!) MNEG[k] = SNEG[s]!
    if (SPOS[s]! < MPOS[k]!) MPOS[k] = SPOS[s]!
  }
}

/** Channel distances of merged selector m into MD[m * 3 …]. */
function mergedDistance(m: number, px: number, py: number): void {
  for (let ch = 0; ch < 3; ch++) {
    const k = m * 3 + ch
    MD[k] = selectorDistance(MTD[k]!, MNE[k]!, MNP[k]!, MNEG[k]!, MPOS[k]!, px, py)
  }
}

const cdMedian = (c: number) => median(CD[c * 3]!, CD[c * 3 + 1]!, CD[c * 3 + 2]!)
const mdMedian = (m: number) => median(MD[m * 3]!, MD[m * 3 + 1]!, MD[m * 3 + 2]!)

function setResultFromContour(c: number): void {
  MD[9] = CD[c * 3]!
  MD[10] = CD[c * 3 + 1]!
  MD[11] = CD[c * 3 + 2]!
}

function setResultFromMerged(m: number): void {
  MD[9] = MD[m * 3]!
  MD[10] = MD[m * 3 + 1]!
  MD[11] = MD[m * 3 + 2]!
}

/** The distance at p into MD[9..11] (msdfgen `OverlappingContourCombiner::distance`). */
function distanceAt(px: number, py: number): void {
  resetSelectors(px, py)
  for (let c = 0; c < contourCount; c++) {
    const end = CEND[c]!
    for (let e = CSTART[c]!; e < end; e++) addEdge(c, e, px, py)
  }
  for (let c = 0; c < contourCount; c++) {
    for (let ch = 0; ch < 3; ch++) {
      const s = c * 3 + ch
      CD[s] = selectorDistance(STD[s]!, SNE[s]!, SNP[s]!, SNEG[s]!, SPOS[s]!, px, py)
    }
  }
  resetMerged(0)
  resetMerged(1)
  resetMerged(2)
  for (let c = 0; c < contourCount; c++) {
    const m = cdMedian(c)
    merge(0, c)
    if (WINDING[c]! > 0 && m >= 0) merge(1, c)
    if (WINDING[c]! < 0 && m <= 0) merge(2, c)
  }
  mergedDistance(0, px, py)
  mergedDistance(1, px, py)
  mergedDistance(2, px, py)
  const inner = mdMedian(1)
  const outer = mdMedian(2)
  let winding = 0
  if (inner >= 0 && Math.abs(inner) <= Math.abs(outer)) {
    setResultFromMerged(1)
    winding = 1
    for (let c = 0; c < contourCount; c++) {
      if (WINDING[c]! > 0) {
        const cm = cdMedian(c)
        if (Math.abs(cm) < Math.abs(outer) && cm > median(MD[9]!, MD[10]!, MD[11]!)) {
          setResultFromContour(c)
        }
      }
    }
  } else if (outer <= 0 && Math.abs(outer) < Math.abs(inner)) {
    setResultFromMerged(2)
    winding = -1
    for (let c = 0; c < contourCount; c++) {
      if (WINDING[c]! < 0) {
        const cm = cdMedian(c)
        if (Math.abs(cm) < Math.abs(inner) && cm < median(MD[9]!, MD[10]!, MD[11]!)) {
          setResultFromContour(c)
        }
      }
    }
  } else {
    setResultFromMerged(0)
    return
  }
  for (let c = 0; c < contourCount; c++) {
    if (WINDING[c]! !== winding) {
      const cm = cdMedian(c)
      const rm = median(MD[9]!, MD[10]!, MD[11]!)
      if (cm * rm >= 0 && Math.abs(cm) < Math.abs(rm)) setResultFromContour(c)
    }
  }
  if (median(MD[9]!, MD[10]!, MD[11]!) === mdMedian(0)) setResultFromMerged(0)
}

function resetCaches(): void {
  for (let e = 0; e < edgeCount; e++) {
    CPX[e] = 0
    CPY[e] = 0
    CABS[e] = 0
    CAD[e] = 0
    CBD[e] = 0
    CAP[e] = 0
    CBP[e] = 0
  }
  for (let s = 0; s < contourCount * 3; s++) {
    STD[s] = -MAX
    STDOT[s] = 0
    SNE[s] = -1
  }
  for (let c = 0; c < contourCount; c++) {
    SPX[c] = 0
    SPY[c] = 0
  }
}

/** Minimum true signed distance over all edges (for the orientation check). */
function trueDistance(px: number, py: number): number {
  let best = -MAX
  let bestDot = 0
  for (let e = 0; e < edgeCount; e++) {
    edgeSignedDistance(e, px, py)
    const a = Math.abs(SD[0]!)
    const b = Math.abs(best)
    if (a < b || (a === b && SD[1]! < bestDot)) {
      best = SD[0]!
      bestDot = SD[1]!
    }
  }
  return best
}

// --- scanline sign correction --------------------------------------------------------------------

let pieceCap = 0
/** Monotonic-in-y pieces of edges: edge, t0, t1, y0, y1. */
let PE = new Int32Array(0)
let PT = new Float64Array(0)
let pieceCount = 0
let hitCap = 0
let HX = new Float64Array(0)
let HD = new Int8Array(0)

function ensurePieces(n: number): void {
  if (n <= pieceCap) return
  pieceCap = Math.max(n, pieceCap * 2, 64)
  const pe = new Int32Array(pieceCap)
  const pt = new Float64Array(pieceCap * 4)
  pe.set(PE)
  pt.set(PT)
  PE = pe
  PT = pt
}

function ensureHits(n: number): void {
  if (n <= hitCap) return
  hitCap = Math.max(n, hitCap * 2, 64)
  HX = new Float64Array(hitCap)
  HD = new Int8Array(hitCap)
}

function pointX(e: number, t: number): number {
  const o = e * 8
  const k = KIND[e]!
  const s = 1 - t
  if (k === 1) return s * P[o]! + t * P[o + 2]!
  if (k === 2) return s * s * P[o]! + 2 * s * t * P[o + 2]! + t * t * P[o + 4]!
  return (
    s * s * s * P[o]! +
    3 * s * s * t * P[o + 2]! +
    3 * s * t * t * P[o + 4]! +
    t * t * t * P[o + 6]!
  )
}

function pointY(e: number, t: number): number {
  const o = e * 8 + 1
  const k = KIND[e]!
  const s = 1 - t
  if (k === 1) return s * P[o]! + t * P[o + 2]!
  if (k === 2) return s * s * P[o]! + 2 * s * t * P[o + 2]! + t * t * P[o + 4]!
  return (
    s * s * s * P[o]! +
    3 * s * s * t * P[o + 2]! +
    3 * s * t * t * P[o + 4]! +
    t * t * t * P[o + 6]!
  )
}

function addPiece(e: number, t0: number, t1: number): void {
  if (t1 <= t0) return
  ensurePieces(pieceCount + 1)
  const y0 = pointY(e, t0)
  const y1 = pointY(e, t1)
  if (y0 === y1) return
  PE[pieceCount] = e
  PT[pieceCount * 4] = t0
  PT[pieceCount * 4 + 1] = t1
  PT[pieceCount * 4 + 2] = y0
  PT[pieceCount * 4 + 3] = y1
  pieceCount++
}

/** Splits every edge where dy/dt = 0 so each piece crosses a scanline at most once. */
function buildPieces(): void {
  pieceCount = 0
  for (let e = 0; e < edgeCount; e++) {
    const o = e * 8 + 1
    const k = KIND[e]!
    let n = 0
    if (k === 2) {
      const den = P[o]! - 2 * P[o + 2]! + P[o + 4]!
      if (den !== 0) {
        ROOTS[0] = (P[o]! - P[o + 2]!) / den
        n = 1
      }
    } else if (k === 3) {
      const p0 = P[o]!
      const p1 = P[o + 2]!
      const p2 = P[o + 4]!
      const p3 = P[o + 6]!
      n = solveQuadratic(-p0 + 3 * p1 - 3 * p2 + p3, 2 * (p0 - 2 * p1 + p2), p1 - p0)
      if (n < 0) n = 0
      if (n === 2 && ROOTS[0]! > ROOTS[1]!) {
        const tmp = ROOTS[0]!
        ROOTS[0] = ROOTS[1]!
        ROOTS[1] = tmp
      }
    }
    let t = 0
    for (let r = 0; r < n; r++) {
      const root = ROOTS[r]!
      if (root > t && root < 1) {
        addPiece(e, t, root)
        t = root
      }
    }
    addPiece(e, t, 1)
  }
}

/** Crossings of the scanline y, sorted by x. Half-open in y, so vertices count once. */
function scanline(y: number): number {
  let n = 0
  ensureHits(pieceCount)
  for (let i = 0; i < pieceCount; i++) {
    const y0 = PT[i * 4 + 2]!
    const y1 = PT[i * 4 + 3]!
    const lo = y0 < y1 ? y0 : y1
    const hi = y0 < y1 ? y1 : y0
    if (y < lo || y >= hi) continue
    const e = PE[i]!
    let t0 = PT[i * 4]!
    let t1 = PT[i * 4 + 1]!
    let x: number
    if (KIND[e] === 1) {
      const o = e * 8
      const t = (y - P[o + 1]!) / (P[o + 3]! - P[o + 1]!)
      x = P[o]! + (P[o + 2]! - P[o]!) * t
    } else {
      const up = y1 > y0
      for (let it = 0; it < 40; it++) {
        const tm = 0.5 * (t0 + t1)
        const ym = pointY(e, tm)
        if (ym < y === up) t0 = tm
        else t1 = tm
      }
      x = pointX(e, 0.5 * (t0 + t1))
    }
    // Insertion sort by x.
    let j = n
    while (j > 0 && HX[j - 1]! > x) {
      HX[j] = HX[j - 1]!
      HD[j] = HD[j - 1]!
      j--
    }
    HX[j] = x
    HD[j] = y1 > y0 ? 1 : -1
    n++
  }
  return n
}

// --- error correction (msdfgen MSDFErrorCorrection, edge priority) -------------------------------

const ERROR = 1
const PROTECTED = 2
const ARTIFACT_T_EPSILON = 0.01
const PROTECTION_RADIUS_TOLERANCE = 1.001
const MIN_DEVIATION_RATIO = 10 / 9

let stencilCap = 0
let STENCIL = new Uint8Array(0)
const T2 = new Float64Array(2)
const LQ = new Float64Array(6)

function interpolatedMedian(sdf: Float32Array, a: number, b: number, t: number): number {
  return median(
    sdf[a]! + (sdf[b]! - sdf[a]!) * t,
    sdf[a + 1]! + (sdf[b + 1]! - sdf[a + 1]!) * t,
    sdf[a + 2]! + (sdf[b + 2]! - sdf[a + 2]!) * t,
  )
}

/** Bilinear median along the diagonal: a + l t + q t² per channel (LQ holds l then q). */
function interpolatedMedianQ(sdf: Float32Array, a: number, t: number): number {
  return median(
    t * (t * LQ[3]! + LQ[0]!) + sdf[a]!,
    t * (t * LQ[4]! + LQ[1]!) + sdf[a + 1]!,
    t * (t * LQ[5]! + LQ[2]!) + sdf[a + 2]!,
  )
}

const CANDIDATE = 1
const ARTIFACT = 2

function rangeTest(
  span: number,
  isProtected: boolean,
  at: number,
  bt: number,
  xt: number,
  am: number,
  bm: number,
  xm: number,
): number {
  if (
    (am > 0.5 && bm > 0.5 && xm <= 0.5) ||
    (am < 0.5 && bm < 0.5 && xm >= 0.5) ||
    (!isProtected && median(am, bm, xm) !== xm)
  ) {
    const axSpan = (xt - at) * span
    const bxSpan = (bt - xt) * span
    if (!(xm >= am - axSpan && xm <= am + axSpan && xm >= bm - bxSpan && xm <= bm + bxSpan)) {
      return CANDIDATE | ARTIFACT
    }
    return CANDIDATE
  }
  return 0
}

function linearArtifactInner(
  sdf: Float32Array,
  span: number,
  isProtected: boolean,
  am: number,
  bm: number,
  a: number,
  b: number,
  dA: number,
  dB: number,
): boolean {
  const t = dA / (dA - dB)
  if (t > ARTIFACT_T_EPSILON && t < 1 - ARTIFACT_T_EPSILON) {
    const xm = interpolatedMedian(sdf, a, b, t)
    return (rangeTest(span, isProtected, 0, 1, t, am, bm, xm) & ARTIFACT) !== 0
  }
  return false
}

function hasLinearArtifact(
  sdf: Float32Array,
  span: number,
  isProtected: boolean,
  am: number,
  a: number,
  b: number,
): boolean {
  const bm = median(sdf[b]!, sdf[b + 1]!, sdf[b + 2]!)
  return (
    Math.abs(am - 0.5) >= Math.abs(bm - 0.5) &&
    (linearArtifactInner(
      sdf,
      span,
      isProtected,
      am,
      bm,
      a,
      b,
      sdf[a + 1]! - sdf[a]!,
      sdf[b + 1]! - sdf[b]!,
    ) ||
      linearArtifactInner(
        sdf,
        span,
        isProtected,
        am,
        bm,
        a,
        b,
        sdf[a + 2]! - sdf[a + 1]!,
        sdf[b + 2]! - sdf[b + 1]!,
      ) ||
      linearArtifactInner(
        sdf,
        span,
        isProtected,
        am,
        bm,
        a,
        b,
        sdf[a]! - sdf[a + 2]!,
        sdf[b]! - sdf[b + 2]!,
      ))
  )
}

function diagonalArtifactInner(
  sdf: Float32Array,
  span: number,
  isProtected: boolean,
  am: number,
  dm: number,
  a: number,
  dA: number,
  dBC: number,
  dD: number,
  tEx0: number,
  tEx1: number,
): boolean {
  const n = solveQuadratic(dD - dBC + dA, dBC - dA - dA, dA)
  if (n <= 0) return false
  T2[0] = ROOTS[0]!
  T2[1] = ROOTS[1]!
  for (let i = 0; i < n; i++) {
    const t = T2[i]!
    if (t > ARTIFACT_T_EPSILON && t < 1 - ARTIFACT_T_EPSILON) {
      const xm = interpolatedMedianQ(sdf, a, t)
      let flags = rangeTest(span, isProtected, 0, 1, t, am, dm, xm)
      if (tEx0 > 0 && tEx0 < 1) {
        const em = interpolatedMedianQ(sdf, a, tEx0)
        flags |=
          tEx0 > t
            ? rangeTest(span, isProtected, 0, tEx0, t, am, em, xm)
            : rangeTest(span, isProtected, tEx0, 1, t, em, dm, xm)
      }
      if (tEx1 > 0 && tEx1 < 1) {
        const em = interpolatedMedianQ(sdf, a, tEx1)
        flags |=
          tEx1 > t
            ? rangeTest(span, isProtected, 0, tEx1, t, am, em, xm)
            : rangeTest(span, isProtected, tEx1, 1, t, em, dm, xm)
      }
      if (flags & ARTIFACT) return true
    }
  }
  return false
}

function hasDiagonalArtifact(
  sdf: Float32Array,
  span: number,
  isProtected: boolean,
  am: number,
  a: number,
  b: number,
  c: number,
  d: number,
): boolean {
  const dm = median(sdf[d]!, sdf[d + 1]!, sdf[d + 2]!)
  if (Math.abs(am - 0.5) < Math.abs(dm - 0.5)) return false
  for (let ch = 0; ch < 3; ch++) {
    const abc = sdf[a + ch]! - sdf[b + ch]! - sdf[c + ch]!
    LQ[ch] = -sdf[a + ch]! - abc
    LQ[3 + ch] = sdf[d + ch]! + abc
  }
  const tEx0 = (-0.5 * LQ[0]!) / LQ[3]!
  const tEx1 = (-0.5 * LQ[1]!) / LQ[4]!
  const tEx2 = (-0.5 * LQ[2]!) / LQ[5]!
  // Where each pair of channels meets: (1 - 0), (2 - 1), (0 - 2).
  for (let k = 0; k < 3; k++) {
    const hi = k === 2 ? 0 : k + 1
    const lo = k
    const dA = sdf[a + hi]! - sdf[a + lo]!
    const dBC = sdf[b + hi]! - sdf[b + lo]! + sdf[c + hi]! - sdf[c + lo]!
    const dD = sdf[d + hi]! - sdf[d + lo]!
    const e0 = k === 0 ? tEx0 : k === 1 ? tEx1 : tEx2
    const e1 = k === 0 ? tEx1 : k === 1 ? tEx2 : tEx0
    if (diagonalArtifactInner(sdf, span, isProtected, am, dm, a, dA, dBC, dD, e0, e1)) return true
  }
  return false
}

/** Channels (bit mask) whose zero crossing between texels a and b is where the median crosses. */
function edgeBetweenTexels(sdf: Float32Array, a: number, b: number): number {
  let mask = 0
  for (let ch = 0; ch < 3; ch++) {
    const t = (sdf[a + ch]! - 0.5) / (sdf[a + ch]! - sdf[b + ch]!)
    if (t > 0 && t < 1) {
      const c0 = sdf[a]! + (sdf[b]! - sdf[a]!) * t
      const c1 = sdf[a + 1]! + (sdf[b + 1]! - sdf[a + 1]!) * t
      const c2 = sdf[a + 2]! + (sdf[b + 2]! - sdf[a + 2]!) * t
      const cc = ch === 0 ? c0 : ch === 1 ? c1 : c2
      if (median(c0, c1, c2) === cc) mask |= 1 << ch
    }
  }
  return mask
}

function protectExtremeChannels(sdf: Float32Array, texel: number, m: number, mask: number): void {
  const i = texel * 3
  if (
    (mask & 1 && sdf[i]! !== m) ||
    (mask & 2 && sdf[i + 1]! !== m) ||
    (mask & 4 && sdf[i + 2]! !== m)
  ) {
    STENCIL[texel] = STENCIL[texel]! | PROTECTED
  }
}

function protectCorners(shape: Shape, w: number, h: number, scale: number, tx: number, ty: number) {
  for (const contour of shape.contours) {
    const edges = contour.edges
    if (edges.length === 0) continue
    let prev = edges[edges.length - 1]!
    for (const edge of edges) {
      const common = prev.color & edge.color
      if (!(common & (common - 1))) {
        const px = scale * (edge.p[0]! + tx)
        const py = scale * (edge.p[1]! + ty)
        const l = Math.floor(px - 0.5)
        const b = Math.floor(py - 0.5)
        const r = l + 1
        const t = b + 1
        if (l < w && b < h && r >= 0 && t >= 0) {
          if (l >= 0 && b >= 0) STENCIL[b * w + l] = STENCIL[b * w + l]! | PROTECTED
          if (r < w && b >= 0) STENCIL[b * w + r] = STENCIL[b * w + r]! | PROTECTED
          if (l >= 0 && t < h) STENCIL[t * w + l] = STENCIL[t * w + l]! | PROTECTED
          if (r < w && t < h) STENCIL[t * w + r] = STENCIL[t * w + r]! | PROTECTED
        }
      }
      prev = edge
    }
  }
}

const med3 = (sdf: Float32Array, i: number) => median(sdf[i]!, sdf[i + 1]!, sdf[i + 2]!)

function protectEdges(sdf: Float32Array, w: number, h: number, rangePx: number): void {
  let radius = PROTECTION_RADIUS_TOLERANCE / rangePx
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = y * w + x
      const lm = med3(sdf, a * 3)
      const rm = med3(sdf, (a + 1) * 3)
      if (Math.abs(lm - 0.5) + Math.abs(rm - 0.5) < radius) {
        const mask = edgeBetweenTexels(sdf, a * 3, (a + 1) * 3)
        protectExtremeChannels(sdf, a, lm, mask)
        protectExtremeChannels(sdf, a + 1, rm, mask)
      }
    }
  }
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const a = y * w + x
      const bm = med3(sdf, a * 3)
      const tm = med3(sdf, (a + w) * 3)
      if (Math.abs(bm - 0.5) + Math.abs(tm - 0.5) < radius) {
        const mask = edgeBetweenTexels(sdf, a * 3, (a + w) * 3)
        protectExtremeChannels(sdf, a, bm, mask)
        protectExtremeChannels(sdf, a + w, tm, mask)
      }
    }
  }
  radius = (PROTECTION_RADIUS_TOLERANCE * Math.SQRT2) / rangePx
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const lb = y * w + x
      const rb = lb + 1
      const lt = lb + w
      const rt = lt + 1
      const mlb = med3(sdf, lb * 3)
      const mrb = med3(sdf, rb * 3)
      const mlt = med3(sdf, lt * 3)
      const mrt = med3(sdf, rt * 3)
      if (Math.abs(mlb - 0.5) + Math.abs(mrt - 0.5) < radius) {
        const mask = edgeBetweenTexels(sdf, lb * 3, rt * 3)
        protectExtremeChannels(sdf, lb, mlb, mask)
        protectExtremeChannels(sdf, rt, mrt, mask)
      }
      if (Math.abs(mrb - 0.5) + Math.abs(mlt - 0.5) < radius) {
        const mask = edgeBetweenTexels(sdf, rb * 3, lt * 3)
        protectExtremeChannels(sdf, rb, mrb, mask)
        protectExtremeChannels(sdf, lt, mlt, mask)
      }
    }
  }
}

function findErrors(sdf: Float32Array, w: number, h: number, rangePx: number): void {
  const hSpan = MIN_DEVIATION_RATIO / rangePx
  const dSpan = (MIN_DEVIATION_RATIO * Math.SQRT2) / rangePx
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const c = i * 3
      const cm = med3(sdf, c)
      const prot = (STENCIL[i]! & PROTECTED) !== 0
      const l = (i - 1) * 3
      const r = (i + 1) * 3
      const b = (i - w) * 3
      const t = (i + w) * 3
      const error =
        (x > 0 && hasLinearArtifact(sdf, hSpan, prot, cm, c, l)) ||
        (y > 0 && hasLinearArtifact(sdf, hSpan, prot, cm, c, b)) ||
        (x < w - 1 && hasLinearArtifact(sdf, hSpan, prot, cm, c, r)) ||
        (y < h - 1 && hasLinearArtifact(sdf, hSpan, prot, cm, c, t)) ||
        (x > 0 && y > 0 && hasDiagonalArtifact(sdf, dSpan, prot, cm, c, l, b, b - 3)) ||
        (x < w - 1 && y > 0 && hasDiagonalArtifact(sdf, dSpan, prot, cm, c, r, b, b + 3)) ||
        (x > 0 && y < h - 1 && hasDiagonalArtifact(sdf, dSpan, prot, cm, c, l, t, t - 3)) ||
        (x < w - 1 && y < h - 1 && hasDiagonalArtifact(sdf, dSpan, prot, cm, c, r, t, t + 3))
      if (error) STENCIL[i] = STENCIL[i]! | ERROR
    }
  }
}

// --- public API ------------------------------------------------------------------------------

export interface MsdfOptions {
  /** Pixels per shape unit. */
  scale: number
  /** Distance range in pixels: the field spans ±range/2 around the outline. */
  range: number
  /** Corner angle threshold for edge coloring, radians. Default 3. */
  angleThreshold?: number
  /** Run the scanline sign pass (default true). */
  scanline?: boolean
  /** Run edge-priority error correction (default true). */
  errorCorrection?: boolean
}

/** Where a glyph's bitmap sits relative to the shape (msdf-atlas-gen's box wrapping). */
export interface MsdfBox {
  width: number
  height: number
  /** Shape-space translation: pixel x = (shapeX + tx) * scale. */
  tx: number
  ty: number
  /** Quad bounds in shape units (pixel center to pixel center): left, bottom, right, top. */
  plane: [number, number, number, number]
}

/** The bitmap box for bounds: padded by half the range, centered, one spare pixel. */
export function msdfBox(
  bounds: readonly [number, number, number, number],
  scale: number,
  range: number,
): MsdfBox {
  const pad = (0.5 * range) / scale
  const l = bounds[0] - pad
  const b = bounds[1] - pad
  const r = bounds[2] + pad
  const t = bounds[3] + pad
  const w = scale * (r - l)
  const h = scale * (t - b)
  const width = Math.ceil(w) + 1
  const height = Math.ceil(h) + 1
  const tx = -l + (0.5 * (width - w)) / scale
  const ty = -b + (0.5 * (height - h)) / scale
  return {
    width,
    height,
    tx,
    ty,
    plane: [
      -tx + 0.5 / scale,
      -ty + 0.5 / scale,
      -tx + (width - 0.5) / scale,
      -ty + (height - 0.5) / scale,
    ],
  }
}

/**
 * Prepares a shape for MSDF: splits single-edge contours, fixes the orientation so the outside is
 * negative, and colors the edges. Mutates the shape.
 */
export function prepareShape(shape: Shape, angleThreshold = 3): void {
  normalizeShape(shape)
  const bounds = shapeBounds(shape)
  if (!bounds) return
  flatten(shape)
  const px = bounds[0] - (bounds[2] - bounds[0]) - 1
  const py = bounds[1] - (bounds[3] - bounds[1]) - 1
  if (trueDistance(px, py) > 0) for (const c of shape.contours) reverseContour(c)
  colorEdgesSimple(shape, angleThreshold)
}

let floatCap = 0
let FLOATS = new Float32Array(0)

/**
 * Generates the MSDF of a prepared shape into a reused float buffer (3 channels, normalized so 0.5
 * is the outline, row 0 at the bottom). Returns the buffer; valid until the next call.
 */
export function generateMsdf(shape: Shape, box: MsdfBox, options: MsdfOptions): Float32Array {
  const { width: w, height: h, tx, ty } = box
  const scale = options.scale
  const rangeUnits = options.range / scale
  const n = w * h
  if (n * 3 > floatCap) {
    floatCap = Math.max(n * 3, floatCap * 2)
    FLOATS = new Float32Array(floatCap)
  }
  if (n > stencilCap) {
    stencilCap = Math.max(n, stencilCap * 2)
    STENCIL = new Uint8Array(stencilCap)
  }
  const sdf = FLOATS
  flatten(shape)
  if (edgeCount === 0) {
    sdf.fill(0, 0, n * 3)
    return sdf
  }
  resetCaches()
  const invRange = 1 / rangeUnits
  for (let y = 0; y < h; y++) {
    const py = (y + 0.5) / scale - ty
    const leftToRight = (y & 1) === 0
    for (let k = 0; k < w; k++) {
      const x = leftToRight ? k : w - 1 - k
      const px = (x + 0.5) / scale - tx
      distanceAt(px, py)
      const o = (y * w + x) * 3
      sdf[o] = MD[9]! * invRange + 0.5
      sdf[o + 1] = MD[10]! * invRange + 0.5
      sdf[o + 2] = MD[11]! * invRange + 0.5
    }
  }
  if (options.scanline !== false) {
    buildPieces()
    for (let y = 0; y < h; y++) {
      const hits = scanline((y + 0.5) / scale - ty)
      let hit = 0
      let winding = 0
      for (let x = 0; x < w; x++) {
        const px = (x + 0.5) / scale - tx
        while (hit < hits && HX[hit]! < px) winding += HD[hit++]!
        const fill = winding !== 0
        const o = (y * w + x) * 3
        const m = med3(sdf, o)
        if (m !== 0.5 && m > 0.5 !== fill) {
          sdf[o] = 1 - sdf[o]!
          sdf[o + 1] = 1 - sdf[o + 1]!
          sdf[o + 2] = 1 - sdf[o + 2]!
        }
      }
    }
  }
  if (options.errorCorrection !== false) {
    STENCIL.fill(0, 0, n)
    protectCorners(shape, w, h, scale, tx, ty)
    protectEdges(sdf, w, h, options.range)
    findErrors(sdf, w, h, options.range)
    for (let i = 0; i < n; i++) {
      if (STENCIL[i]! & ERROR) {
        const m = med3(sdf, i * 3)
        sdf[i * 3] = m
        sdf[i * 3 + 1] = m
        sdf[i * 3 + 2] = m
      }
    }
  }
  return sdf
}

/**
 * Writes a generated field into an RGBA8 image with row 0 at the top (flipping msdfgen's rows),
 * at (x, y). Alpha is 255.
 */
export function blitMsdf(
  sdf: Float32Array,
  w: number,
  h: number,
  out: Uint8Array,
  outWidth: number,
  x: number,
  y: number,
): void {
  for (let row = 0; row < h; row++) {
    const src = (h - 1 - row) * w * 3
    let dst = ((y + row) * outWidth + x) * 4
    for (let col = 0; col < w; col++) {
      const s = src + col * 3
      for (let ch = 0; ch < 3; ch++) {
        const v = sdf[s + ch]!
        out[dst + ch] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
      }
      out[dst + 3] = 255
      dst += 4
    }
  }
}
