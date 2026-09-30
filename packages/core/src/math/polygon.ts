// Polygons in the plane, as flat `[x0, y0, x1, y1, ...]` arrays: area, ear clipping with holes,
// and clipping to an axis-aligned rectangle. Structure floors (0055) and vector shapes and fog
// (0057, 0058) share them.

/** The signed area of a ring. Positive when counter-clockwise (y up). */
export function signedArea(points: ArrayLike<number>, start = 0, end = points.length >> 1): number {
  let area = 0
  for (let i = start, j = end - 1; i < end; j = i++) {
    area += points[j * 2]! * points[i * 2 + 1]! - points[i * 2]! * points[j * 2 + 1]!
  }
  return area / 2
}

/** The total area of triangles given by `indices` into flat xy `points`. */
export function trianglesArea(points: ArrayLike<number>, indices: ArrayLike<number>): number {
  let area = 0
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]! * 2
    const b = indices[i + 1]! * 2
    const c = indices[i + 2]! * 2
    area += Math.abs(
      (points[b]! - points[a]!) * (points[c + 1]! - points[a + 1]!) -
        (points[c]! - points[a]!) * (points[b + 1]! - points[a + 1]!),
    )
  }
  return area / 2
}

interface Node {
  /** Vertex index into the input. */
  i: number
  x: number
  y: number
  prev: Node
  next: Node
  /** Removed from the ring (an ear was cut). */
  gone: boolean
}

/**
 * Triangulates a simple polygon, with optional holes, by ear clipping. `points` holds the outer
 * ring first, then each hole; `holes` lists the vertex index where each hole starts. Either
 * winding works for any ring. Returns vertex indices, three per triangle, counter-clockwise.
 * Holes are bridged to the outer ring first, so the result covers the polygon minus its holes.
 */
export function triangulate(points: ArrayLike<number>, holes: ArrayLike<number> = []): number[] {
  const out: number[] = []
  const count = points.length >> 1
  const outerEnd = holes.length > 0 ? holes[0]! : count
  let outer = ring(points, 0, outerEnd, true)
  if (!outer || outer.next === outer.prev) return out
  if (holes.length > 0) outer = eliminateHoles(points, holes, outer, count)
  earcut(outer, out, 0)
  return out
}

/** A doubly linked ring of `points[start..end)`, wound counter-clockwise if `ccw`, else clockwise. */
function ring(
  points: ArrayLike<number>,
  start: number,
  end: number,
  ccw: boolean,
): Node | undefined {
  if (end - start < 3) return undefined
  const forward = signedArea(points, start, end) > 0 === ccw
  let last: Node | undefined
  if (forward) for (let i = start; i < end; i++) last = insert(i, points, last)
  else for (let i = end - 1; i >= start; i--) last = insert(i, points, last)
  // Drop a closing duplicate of the first point.
  if (last && last.x === last.next.x && last.y === last.next.y) {
    const next = last.next
    remove(last)
    last = next
  }
  return last
}

function insert(i: number, points: ArrayLike<number>, last: Node | undefined): Node {
  const node = { i, x: points[i * 2]!, y: points[i * 2 + 1]!, gone: false } as Node
  if (!last) {
    node.prev = node
    node.next = node
  } else {
    node.next = last.next
    node.prev = last
    last.next.prev = node
    last.next = node
  }
  return node
}

function remove(node: Node): void {
  node.next.prev = node.prev
  node.prev.next = node.next
  node.gone = true
}

/** Twice the signed area of triangle (a, b, c); positive when counter-clockwise. */
function area2(a: Node, b: Node, c: Node): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointInTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  )
}

function isEar(ear: Node): boolean {
  const a = ear.prev
  const b = ear
  const c = ear.next
  if (area2(a, b, c) <= 0) return false
  for (let p = c.next; p !== a; p = p.next) {
    if (
      (p.x === a.x && p.y === a.y) ||
      (p.x === b.x && p.y === b.y) ||
      (p.x === c.x && p.y === c.y)
    )
      continue
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area2(p.prev, p, p.next) <= 0)
      return false
  }
  return true
}

function earcut(start: Node, out: number[], pass: number): void {
  let ear: Node = start
  let stop = ear
  while (ear.prev !== ear.next) {
    const prev = ear.prev
    const next = ear.next
    if (isEar(ear)) {
      out.push(prev.i, ear.i, next.i)
      remove(ear)
      // Skip the next vertex: it just became part of an ear's edge and rarely is one itself.
      ear = next.next
      stop = next.next
      continue
    }
    ear = next
    if (ear === stop) {
      // No ear found in a full lap: clean up degenerate vertices, then split, then give up.
      if (pass === 0) earcut(filterPoints(ear), out, 1)
      else if (pass === 1) earcut(cureLocalIntersections(filterPoints(ear), out), out, 2)
      else if (pass === 2) splitEarcut(ear, out)
      return
    }
  }
}

/** Removes collinear and duplicate vertices. */
function filterPoints(start: Node): Node {
  let p = start
  let end = start
  let again: boolean
  do {
    again = false
    if ((p.x === p.next.x && p.y === p.next.y) || area2(p.prev, p, p.next) === 0) {
      remove(p)
      p = end = p.prev
      if (p === p.next) break
      again = true
    } else p = p.next
  } while (again || p !== end)
  return end
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = Math.sign(area2(p1, q1, p2))
  const o2 = Math.sign(area2(p1, q1, q2))
  const o3 = Math.sign(area2(p2, q2, p1))
  const o4 = Math.sign(area2(p2, q2, q1))
  return o1 !== o2 && o3 !== o4
}

function locallyInside(a: Node, b: Node): boolean {
  return area2(a.prev, a, a.next) < 0
    ? area2(a, b, a.next) >= 0 && area2(a, a.prev, b) >= 0
    : area2(a, b, a.prev) < 0 || area2(a, a.next, b) < 0
}

/** Cuts ears whose two neighbours cross (a self-touching ring after bridging). */
function cureLocalIntersections(start: Node, out: number[]): Node {
  let p = start
  do {
    const a = p.prev
    const b = p.next.next
    if (
      !(a.x === b.x && a.y === b.y) &&
      intersects(a, p, p.next, b) &&
      locallyInside(a, b) &&
      locallyInside(b, a)
    ) {
      out.push(a.i, p.i, b.i)
      remove(p)
      remove(p.next)
      p = start = b
    }
    p = p.next
  } while (p !== start)
  return filterPoints(p)
}

function middleInside(a: Node, b: Node): boolean {
  let p = a
  let inside = false
  const px = (a.x + b.x) / 2
  const py = (a.y + b.y) / 2
  do {
    if (
      p.y > py !== p.next.y > py &&
      p.next.y !== p.y &&
      px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x
    )
      inside = !inside
    p = p.next
  } while (p !== a)
  return inside
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a
  do {
    if (
      p.i !== a.i &&
      p.next.i !== a.i &&
      p.i !== b.i &&
      p.next.i !== b.i &&
      intersects(p, p.next, a, b)
    )
      return true
    p = p.next
  } while (p !== a)
  return false
}

function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !intersectsPolygon(a, b) &&
    locallyInside(a, b) &&
    locallyInside(b, a) &&
    middleInside(a, b)
  )
}

/** Links a and b with a two-way bridge, splitting the ring into two. Returns b's copy. */
function splitPolygon(a: Node, b: Node): Node {
  const a2 = { i: a.i, x: a.x, y: a.y, gone: false } as Node
  const b2 = { i: b.i, x: b.x, y: b.y, gone: false } as Node
  const an = a.next
  const bp = b.prev
  a.next = b
  b.prev = a
  a2.next = an
  an.prev = a2
  b2.next = a2
  a2.prev = b2
  bp.next = b2
  b2.prev = bp
  return b2
}

/** Last resort: split the ring along a valid diagonal and triangulate both halves. */
function splitEarcut(start: Node, out: number[]): void {
  let a = start
  do {
    let b = a.next.next
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b)
        a = filterPoints(a)
        c = filterPoints(c)
        earcut(a, out, 0)
        earcut(c, out, 0)
        return
      }
      b = b.next
    }
    a = a.next
  } while (a !== start)
}

function eliminateHoles(
  points: ArrayLike<number>,
  holes: ArrayLike<number>,
  outer: Node,
  count: number,
): Node {
  const queue: Node[] = []
  for (let h = 0; h < holes.length; h++) {
    const start = holes[h]!
    const end = h + 1 < holes.length ? holes[h + 1]! : count
    const list = ring(points, start, end, false)
    if (!list) continue
    // Each hole's leftmost vertex, bridged in left-to-right order.
    let left = list
    let p = list
    do {
      if (p.x < left.x || (p.x === left.x && p.y < left.y)) left = p
      p = p.next
    } while (p !== list)
    queue.push(left)
  }
  queue.sort((a, b) => a.x - b.x || a.y - b.y)
  for (const hole of queue) outer = filterPoints(eliminateHole(hole, outer))
  return outer
}

function eliminateHole(hole: Node, outer: Node): Node {
  const bridge = findHoleBridge(hole, outer)
  if (!bridge) return outer
  const reverse = splitPolygon(bridge, hole)
  filterPoints(reverse)
  return filterPoints(bridge)
}

/** An outer-ring vertex the hole's leftmost vertex can see (David Eberly's method). */
function findHoleBridge(hole: Node, outer: Node): Node | undefined {
  let p = outer
  const hx = hole.x
  const hy = hole.y
  let qx = -Infinity
  let m: Node | undefined
  // The nearest edge crossing a ray cast left from the hole's vertex.
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y)
      if (x <= hx && x > qx) {
        qx = x
        m = p.x < p.next.x ? p : p.next
        if (x === hx) return m
      }
    }
    p = p.next
  } while (p !== outer)
  if (!m) return undefined
  // Of the vertices inside the triangle (hole, crossing, m), the one with the smallest angle.
  const stop = m
  const mx = m.x
  const my = m.y
  let tanMin = Infinity
  p = m
  do {
    if (
      hx >= p.x &&
      p.x >= mx &&
      hx !== p.x &&
      pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)
    ) {
      const tan = Math.abs(hy - p.y) / (hx - p.x)
      if (
        locallyInside(p, hole) &&
        (tan < tanMin ||
          (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))
      ) {
        m = p
        tanMin = tan
      }
    }
    p = p.next
  } while (p !== stop)
  return m
}

function sectorContainsSector(m: Node, p: Node): boolean {
  return area2(m.prev, m, p.prev) < 0 && area2(p.next, m, m.next) < 0
}

/**
 * Clips a convex polygon (flat xy, `n` points, in `src`) to the rectangle
 * `[minX, maxX] × [minY, maxY]` (Sutherland–Hodgman). Writes the result to `out` and returns its
 * point count (0 when nothing is inside). `out` and `scratch` need room for `n + 4` points.
 */
export function clipToRect(
  src: ArrayLike<number>,
  n: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  out: Float64Array,
  scratch: Float64Array,
): number {
  let count = clipEdge(src, n, scratch, 0, minX, 1)
  count = clipEdge(scratch, count, out, 0, maxX, -1)
  count = clipEdge(out, count, scratch, 1, minY, 1)
  count = clipEdge(scratch, count, out, 1, maxY, -1)
  return count
}

/** Keeps the part of a polygon where `sign * (p[axis] - at) >= 0`. */
function clipEdge(
  src: ArrayLike<number>,
  n: number,
  dst: Float64Array,
  axis: number,
  at: number,
  sign: number,
): number {
  let count = 0
  if (n === 0) return 0
  let px = src[(n - 1) * 2]!
  let py = src[(n - 1) * 2 + 1]!
  let pd = sign * ((axis === 0 ? px : py) - at)
  for (let i = 0; i < n; i++) {
    const x = src[i * 2]!
    const y = src[i * 2 + 1]!
    const d = sign * ((axis === 0 ? x : y) - at)
    if (d >= 0) {
      if (pd < 0) {
        const t = pd / (pd - d)
        dst[count * 2] = px + (x - px) * t
        dst[count * 2 + 1] = py + (y - py) * t
        count++
      }
      dst[count * 2] = x
      dst[count * 2 + 1] = y
      count++
    } else if (pd >= 0) {
      const t = pd / (pd - d)
      dst[count * 2] = px + (x - px) * t
      dst[count * 2 + 1] = py + (y - py) * t
      count++
    }
    px = x
    py = y
    pd = d
  }
  return count
}
