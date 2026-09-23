/**
 * Glyph outlines as msdfgen shapes: contours of linear, quadratic, and cubic edge segments, plus
 * msdfgen's simple edge coloring. Built once per glyph (not a per-pixel path), so plain objects are
 * fine here; the generator flattens them into typed arrays.
 */

/** Edge colors are channel bit masks (red 1, green 2, blue 4). */
export const EdgeColor = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
} as const

export type EdgeKind = 1 | 2 | 3

export interface Edge {
  /** 1 linear, 2 quadratic, 3 cubic: the curve's degree. */
  kind: EdgeKind
  /** Control points x0, y0, x1, y1, …: 2, 3, or 4 points. */
  p: number[]
  color: number
}

export interface Contour {
  edges: Edge[]
}

export interface Shape {
  contours: Contour[]
}

/** Outline commands in font units, y up (opentype.js `path.commands`). */
export type OutlineCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' }

export function linear(x0: number, y0: number, x1: number, y1: number): Edge {
  return { kind: 1, p: [x0, y0, x1, y1], color: EdgeColor.white }
}

/** Builds a shape from path commands, closing open contours and dropping zero-length edges. */
export function shapeFromCommands(commands: readonly OutlineCommand[]): Shape {
  const contours: Contour[] = []
  let edges: Edge[] = []
  let sx = 0
  let sy = 0
  let x = 0
  let y = 0
  const close = () => {
    if (edges.length > 0 && (x !== sx || y !== sy)) edges.push(linear(x, y, sx, sy))
    if (edges.length > 0) contours.push({ edges })
    edges = []
    x = sx
    y = sy
  }
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        close()
        sx = x = c.x
        sy = y = c.y
        break
      case 'L':
        if (c.x !== x || c.y !== y) edges.push(linear(x, y, c.x, c.y))
        x = c.x
        y = c.y
        break
      case 'Q':
        if (c.x !== x || c.y !== y || c.x1 !== x || c.y1 !== y) {
          edges.push({ kind: 2, p: [x, y, c.x1, c.y1, c.x, c.y], color: EdgeColor.white })
        }
        x = c.x
        y = c.y
        break
      case 'C':
        if (c.x !== x || c.y !== y || c.x1 !== x || c.y1 !== y || c.x2 !== x || c.y2 !== y) {
          edges.push({
            kind: 3,
            p: [x, y, c.x1, c.y1, c.x2, c.y2, c.x, c.y],
            color: EdgeColor.white,
          })
        }
        x = c.x
        y = c.y
        break
      case 'Z':
        close()
        break
    }
  }
  close()
  return { contours }
}

/** A point on the edge at `t`, into `out`. */
export function edgePoint(e: Edge, t: number, out: number[]): void {
  const p = e.p
  const s = 1 - t
  if (e.kind === 1) {
    out[0] = s * p[0]! + t * p[2]!
    out[1] = s * p[1]! + t * p[3]!
  } else if (e.kind === 2) {
    const a = s * s
    const b = 2 * s * t
    const c = t * t
    out[0] = a * p[0]! + b * p[2]! + c * p[4]!
    out[1] = a * p[1]! + b * p[3]! + c * p[5]!
  } else {
    const a = s * s * s
    const b = 3 * s * s * t
    const c = 3 * s * t * t
    const d = t * t * t
    out[0] = a * p[0]! + b * p[2]! + c * p[4]! + d * p[6]!
    out[1] = a * p[1]! + b * p[3]! + c * p[5]! + d * p[7]!
  }
}

/** The (unnormalized) tangent at `t`, with msdfgen's fallbacks for degenerate control points. */
export function edgeDirection(e: Edge, t: number, out: number[]): void {
  const p = e.p
  if (e.kind === 1) {
    out[0] = p[2]! - p[0]!
    out[1] = p[3]! - p[1]!
  } else if (e.kind === 2) {
    const ax = p[2]! - p[0]!
    const ay = p[3]! - p[1]!
    const bx = p[4]! - p[2]!
    const by = p[5]! - p[3]!
    out[0] = ax + (bx - ax) * t
    out[1] = ay + (by - ay) * t
    if (out[0] === 0 && out[1] === 0) {
      out[0] = p[4]! - p[0]!
      out[1] = p[5]! - p[1]!
    }
  } else {
    const ax = p[2]! - p[0]!
    const ay = p[3]! - p[1]!
    const bx = p[4]! - p[2]!
    const by = p[5]! - p[3]!
    const cx = p[6]! - p[4]!
    const cy = p[7]! - p[5]!
    const abx = ax + (bx - ax) * t
    const aby = ay + (by - ay) * t
    const bcx = bx + (cx - bx) * t
    const bcy = by + (cy - by) * t
    out[0] = abx + (bcx - abx) * t
    out[1] = aby + (bcy - aby) * t
    if (out[0] === 0 && out[1] === 0) {
      if (t === 0) {
        out[0] = p[4]! - p[0]!
        out[1] = p[5]! - p[1]!
      } else if (t === 1) {
        out[0] = p[6]! - p[2]!
        out[1] = p[7]! - p[3]!
      }
    }
  }
}

/** Splits an edge at `t` with de Casteljau; returns [head, tail]. */
function splitAt(e: Edge, t: number): [Edge, Edge] {
  const p = e.p
  const lerp = (a: number, b: number) => a + (b - a) * t
  if (e.kind === 1) {
    const mx = lerp(p[0]!, p[2]!)
    const my = lerp(p[1]!, p[3]!)
    return [
      { kind: 1, p: [p[0]!, p[1]!, mx, my], color: e.color },
      { kind: 1, p: [mx, my, p[2]!, p[3]!], color: e.color },
    ]
  }
  if (e.kind === 2) {
    const ax = lerp(p[0]!, p[2]!)
    const ay = lerp(p[1]!, p[3]!)
    const bx = lerp(p[2]!, p[4]!)
    const by = lerp(p[3]!, p[5]!)
    const mx = lerp(ax, bx)
    const my = lerp(ay, by)
    return [
      { kind: 2, p: [p[0]!, p[1]!, ax, ay, mx, my], color: e.color },
      { kind: 2, p: [mx, my, bx, by, p[4]!, p[5]!], color: e.color },
    ]
  }
  const ax = lerp(p[0]!, p[2]!)
  const ay = lerp(p[1]!, p[3]!)
  const bx = lerp(p[2]!, p[4]!)
  const by = lerp(p[3]!, p[5]!)
  const cx = lerp(p[4]!, p[6]!)
  const cy = lerp(p[5]!, p[7]!)
  const abx = lerp(ax, bx)
  const aby = lerp(ay, by)
  const bcx = lerp(bx, cx)
  const bcy = lerp(by, cy)
  const mx = lerp(abx, bcx)
  const my = lerp(aby, bcy)
  return [
    { kind: 3, p: [p[0]!, p[1]!, ax, ay, abx, aby, mx, my], color: e.color },
    { kind: 3, p: [mx, my, bcx, bcy, cx, cy, p[6]!, p[7]!], color: e.color },
  ]
}

export function splitInThirds(e: Edge): [Edge, Edge, Edge] {
  const [a, rest] = splitAt(e, 1 / 3)
  const [b, c] = splitAt(rest, 0.5)
  return [a, b, c]
}

function reverseEdge(e: Edge): void {
  const p = e.p
  const n = p.length
  for (let i = 0; i < n / 2; i += 2) {
    const j = n - 2 - i
    const x = p[i]!
    const y = p[i + 1]!
    p[i] = p[j]!
    p[i + 1] = p[j + 1]!
    p[j] = x
    p[j + 1] = y
  }
}

export function reverseContour(c: Contour): void {
  c.edges.reverse()
  for (const e of c.edges) reverseEdge(e)
}

const shoelace = (ax: number, ay: number, bx: number, by: number) => (bx - ax) * (ay + by)

/** +1 or -1 by orientation (msdfgen's `Contour::winding`), 0 if empty. */
export function contourWinding(c: Contour): number {
  const edges = c.edges
  if (edges.length === 0) return 0
  let total = 0
  const a = [0, 0]
  const b = [0, 0]
  const cc = [0, 0]
  const d = [0, 0]
  if (edges.length === 1) {
    edgePoint(edges[0]!, 0, a)
    edgePoint(edges[0]!, 1 / 3, b)
    edgePoint(edges[0]!, 2 / 3, cc)
    total += shoelace(a[0]!, a[1]!, b[0]!, b[1]!)
    total += shoelace(b[0]!, b[1]!, cc[0]!, cc[1]!)
    total += shoelace(cc[0]!, cc[1]!, a[0]!, a[1]!)
  } else if (edges.length === 2) {
    edgePoint(edges[0]!, 0, a)
    edgePoint(edges[0]!, 0.5, b)
    edgePoint(edges[1]!, 0, cc)
    edgePoint(edges[1]!, 0.5, d)
    total += shoelace(a[0]!, a[1]!, b[0]!, b[1]!)
    total += shoelace(b[0]!, b[1]!, cc[0]!, cc[1]!)
    total += shoelace(cc[0]!, cc[1]!, d[0]!, d[1]!)
    total += shoelace(d[0]!, d[1]!, a[0]!, a[1]!)
  } else {
    const last = edges[edges.length - 1]!
    let px = last.p[0]!
    let py = last.p[1]!
    for (const e of edges) {
      total += shoelace(px, py, e.p[0]!, e.p[1]!)
      px = e.p[0]!
      py = e.p[1]!
    }
  }
  return total > 0 ? 1 : total < 0 ? -1 : 0
}

/** Exact bounds [left, bottom, right, top] of the shape, or undefined when it has no edges. */
export function shapeBounds(shape: Shape): [number, number, number, number] | undefined {
  let l = Infinity
  let b = Infinity
  let r = -Infinity
  let t = -Infinity
  const pt = [0, 0]
  const add = (x: number, y: number) => {
    if (x < l) l = x
    if (x > r) r = x
    if (y < b) b = y
    if (y > t) t = y
  }
  const extremum = (e: Edge, param: number) => {
    if (param > 0 && param < 1) {
      edgePoint(e, param, pt)
      add(pt[0]!, pt[1]!)
    }
  }
  for (const c of shape.contours) {
    for (const e of c.edges) {
      const p = e.p
      add(p[0]!, p[1]!)
      add(p[p.length - 2]!, p[p.length - 1]!)
      if (e.kind === 2) {
        for (let k = 0; k < 2; k++) {
          const den = p[k]! - 2 * p[2 + k]! + p[4 + k]!
          if (den !== 0) extremum(e, (p[k]! - p[2 + k]!) / den)
        }
      } else if (e.kind === 3) {
        for (let k = 0; k < 2; k++) {
          // Roots of the derivative: a t² + b t + c.
          const p0 = p[k]!
          const p1 = p[2 + k]!
          const p2 = p[4 + k]!
          const p3 = p[6 + k]!
          const a = -p0 + 3 * p1 - 3 * p2 + p3
          const bb = 2 * (p0 - 2 * p1 + p2)
          const cc = p1 - p0
          if (Math.abs(a) < 1e-12) {
            if (bb !== 0) extremum(e, -cc / bb)
          } else {
            const disc = bb * bb - 4 * a * cc
            if (disc >= 0) {
              const s = Math.sqrt(disc)
              extremum(e, (-bb + s) / (2 * a))
              extremum(e, (-bb - s) / (2 * a))
            }
          }
        }
      }
    }
  }
  return l <= r ? [l, b, r, t] : undefined
}

/** Splits single-edge contours in thirds so they can take three colors (msdfgen `normalize`). */
export function normalizeShape(shape: Shape): void {
  for (const c of shape.contours) {
    if (c.edges.length === 1) c.edges = splitInThirds(c.edges[0]!)
  }
}

// --- edge coloring -------------------------------------------------------------------

function isCorner(ax: number, ay: number, bx: number, by: number, crossThreshold: number) {
  return ax * bx + ay * by <= 0 || Math.abs(ax * by - ay * bx) > crossThreshold
}

function normalizeInPlace(v: number[]): void {
  const len = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]!)
  if (len === 0) {
    v[0] = 0
    v[1] = 1
  } else {
    v[0] = v[0]! / len
    v[1] = v[1]! / len
  }
}

/** msdfgen's `switchColor`; `seed` is a one-element box it consumes bits from. */
function switchColor(color: number, seed: number[], banned = EdgeColor.black as number): number {
  const combined = color & banned
  if (combined === EdgeColor.red || combined === EdgeColor.green || combined === EdgeColor.blue) {
    return combined ^ EdgeColor.white
  }
  if (color === EdgeColor.black || color === EdgeColor.white) {
    const start = [EdgeColor.cyan, EdgeColor.magenta, EdgeColor.yellow]
    const next = start[seed[0]! % 3]!
    seed[0] = Math.floor(seed[0]! / 3)
    return next
  }
  const shifted = color << (1 + (seed[0]! & 1))
  seed[0] = Math.floor(seed[0]! / 2)
  return (shifted | (shifted >> 3)) & EdgeColor.white
}

function symmetricalTrichotomy(position: number, n: number): number {
  return Math.trunc(3 + (2.875 * position) / (n - 1) - 1.4375 + 0.5) - 3
}

/**
 * msdfgen's `edgeColoringSimple`: corners are where the direction turns by more than
 * `angleThreshold` radians; edges between corners share a color, and neighbors across a corner
 * differ, so each corner is where two channels meet.
 */
export function colorEdgesSimple(shape: Shape, angleThreshold = 3, seedValue = 0): void {
  const crossThreshold = Math.sin(angleThreshold)
  const seed = [seedValue]
  const initial = [EdgeColor.cyan, EdgeColor.magenta, EdgeColor.yellow]
  let color: number = initial[seed[0]! % 3]!
  seed[0] = Math.floor(seed[0]! / 3)
  const prev = [0, 0]
  const dir = [0, 0]
  for (const contour of shape.contours) {
    const edges = contour.edges
    if (edges.length === 0) continue
    const corners: number[] = []
    edgeDirection(edges[edges.length - 1]!, 1, prev)
    for (let i = 0; i < edges.length; i++) {
      edgeDirection(edges[i]!, 0, dir)
      normalizeInPlace(prev)
      normalizeInPlace(dir)
      if (isCorner(prev[0]!, prev[1]!, dir[0]!, dir[1]!, crossThreshold)) corners.push(i)
      edgeDirection(edges[i]!, 1, prev)
    }
    if (corners.length === 0) {
      // Smooth contour: one color everywhere.
      color = switchColor(color, seed)
      for (const e of edges) e.color = color
    } else if (corners.length === 1) {
      // Teardrop: three colors around the contour.
      color = switchColor(color, seed)
      const c0 = color
      color = switchColor(color, seed)
      const colors = [c0, EdgeColor.white, color]
      const corner = corners[0]!
      if (edges.length >= 3) {
        const m = edges.length
        for (let i = 0; i < m; i++) {
          edges[(corner + i) % m]!.color = colors[1 + symmetricalTrichotomy(i, m)]!
        }
      } else {
        // Fewer than three edges for three colors: split them.
        const parts: Edge[] = new Array(7)
        const first = splitInThirds(edges[0]!)
        parts[0 + 3 * corner] = first[0]
        parts[1 + 3 * corner] = first[1]
        parts[2 + 3 * corner] = first[2]
        if (edges.length >= 2) {
          const second = splitInThirds(edges[1]!)
          parts[3 - 3 * corner] = second[0]
          parts[4 - 3 * corner] = second[1]
          parts[5 - 3 * corner] = second[2]
          parts[0]!.color = parts[1]!.color = colors[0]!
          parts[2]!.color = parts[3]!.color = colors[1]!
          parts[4]!.color = parts[5]!.color = colors[2]!
        } else {
          parts[0]!.color = colors[0]!
          parts[1]!.color = colors[1]!
          parts[2]!.color = colors[2]!
        }
        contour.edges = parts.filter((p) => p !== undefined)
      }
    } else {
      // Several corners: switch color at each, never ending on the starting color.
      const cornerCount = corners.length
      let spline = 0
      const start = corners[0]!
      const m = edges.length
      color = switchColor(color, seed)
      const initialColor = color
      for (let i = 0; i < m; i++) {
        const index = (start + i) % m
        if (spline + 1 < cornerCount && corners[spline + 1] === index) {
          spline++
          color = switchColor(
            color,
            seed,
            spline === cornerCount - 1 ? initialColor : EdgeColor.black,
          )
        }
        edges[index]!.color = color
      }
    }
  }
}
