/**
 * Alpha outlines for `shape: 'sprite'` occluders: marching squares over a region's alpha at 0.5,
 * the largest loop kept, simplified with Douglas–Peucker until it has at most `maxPoints` points.
 * Runs in the atlas importer, so outlines cost nothing at runtime.
 */

/** Marching-squares segments per case (tl 8, tr 4, br 2, bl 1), as edge pairs: T 0, R 1, B 2, L 3. */
const CASES: readonly (readonly number[])[] = [
  [],
  [3, 2],
  [2, 1],
  [3, 1],
  [0, 1],
  [], // saddle, resolved by the center
  [0, 2],
  [0, 3],
  [0, 3],
  [0, 2],
  [], // saddle
  [0, 1],
  [3, 1],
  [2, 1],
  [3, 2],
  [],
]

/**
 * Closed loops (x, y pairs in pixels, y down, pixel (x, y) spanning [x, x + 1]) where alpha crosses
 * `threshold`, interpolated between pixel centers. `alpha(x, y)` is 0..1 and 0 outside the region.
 */
export function traceAlpha(
  width: number,
  height: number,
  alpha: (x: number, y: number) => number,
  threshold = 0.5,
): number[][] {
  // Corners are pixel centers with a one-pixel empty border: corner (i, j) is pixel (i − 1, j − 1).
  const cw = width + 2
  const ch = height + 2
  const a = new Float32Array(cw * ch)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) a[(y + 1) * cw + x + 1] = alpha(x, y)
  const inside = (i: number, j: number) => a[j * cw + i]! >= threshold
  // Edge ids: horizontal edge from corner (i, j) is (j · cw + i) · 2, vertical is that + 1.
  const px = new Map<number, number>()
  const py = new Map<number, number>()
  const nbr = new Map<number, number[]>()
  const point = (id: number) => {
    if (px.has(id)) return
    const k = id >> 1
    const i = k % cw
    const j = (k - i) / cw
    const i2 = id & 1 ? i : i + 1
    const j2 = id & 1 ? j + 1 : j
    const v0 = a[j * cw + i]!
    const v1 = a[j2 * cw + i2]!
    const t = v1 === v0 ? 0.5 : Math.min(1, Math.max(0, (threshold - v0) / (v1 - v0)))
    px.set(id, i - 0.5 + (i2 - i) * t)
    py.set(id, j - 0.5 + (j2 - j) * t)
  }
  const link = (p: number, q: number) => {
    point(p)
    point(q)
    const l = nbr.get(p)
    if (l) l.push(q)
    else nbr.set(p, [q])
    const m = nbr.get(q)
    if (m) m.push(p)
    else nbr.set(q, [p])
  }
  for (let j = 0; j < ch - 1; j++) {
    for (let i = 0; i < cw - 1; i++) {
      const c =
        (inside(i, j) ? 8 : 0) |
        (inside(i + 1, j) ? 4 : 0) |
        (inside(i + 1, j + 1) ? 2 : 0) |
        (inside(i, j + 1) ? 1 : 0)
      if (c === 0 || c === 15) continue
      const e = [
        (j * cw + i) * 2,
        (j * cw + i + 1) * 2 + 1,
        ((j + 1) * cw + i) * 2,
        (j * cw + i) * 2 + 1,
      ]
      if (c === 5 || c === 10) {
        const center =
          (a[j * cw + i]! + a[j * cw + i + 1]! + a[(j + 1) * cw + i + 1]! + a[(j + 1) * cw + i]!) /
            4 >=
          threshold
        // Connected diagonal through the center cuts off the other two corners.
        const cutTlBr = (c === 5) === center
        if (cutTlBr) {
          link(e[0]!, e[3]!)
          link(e[2]!, e[1]!)
        } else {
          link(e[0]!, e[1]!)
          link(e[3]!, e[2]!)
        }
        continue
      }
      const s = CASES[c]!
      link(e[s[0]!]!, e[s[1]!]!)
    }
  }
  const loops: number[][] = []
  const done = new Set<number>()
  for (const start of nbr.keys()) {
    if (done.has(start)) continue
    const loop: number[] = []
    let cur: number | undefined = start
    while (cur !== undefined && !done.has(cur)) {
      done.add(cur)
      loop.push(px.get(cur)!, py.get(cur)!)
      const n: number[] = nbr.get(cur)!
      cur = !done.has(n[0]!) ? n[0] : n[1]
    }
    if (loop.length >= 6) loops.push(loop)
  }
  return loops
}

/** Signed area of a closed loop (x, y pairs). */
export function loopArea(p: ArrayLike<number>): number {
  let s = 0
  const n = p.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++)
    s += p[j * 2]! * p[i * 2 + 1]! - p[i * 2]! * p[j * 2 + 1]!
  return s / 2
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  const x = ax + t * dx - px
  const y = ay + t * dy - py
  return Math.sqrt(x * x + y * y)
}

/** Distance from a point to a closed polygon's boundary. */
export function distanceToLoop(x: number, y: number, p: ArrayLike<number>): number {
  let best = Number.POSITIVE_INFINITY
  const n = p.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    best = Math.min(best, segDist(x, y, p[j * 2]!, p[j * 2 + 1]!, p[i * 2]!, p[i * 2 + 1]!))
  }
  return best
}

function dp(p: number[], first: number, last: number, eps: number, keep: Uint8Array): void {
  let worst = -1
  let at = -1
  const n = p.length / 2
  const ax = p[first * 2]!
  const ay = p[first * 2 + 1]!
  const bx = p[(last % n) * 2]!
  const by = p[(last % n) * 2 + 1]!
  for (let k = first + 1; k < last; k++) {
    const d = segDist(p[k * 2]!, p[k * 2 + 1]!, ax, ay, bx, by)
    if (d > worst) {
      worst = d
      at = k
    }
  }
  if (worst > eps) {
    keep[at] = 1
    dp(p, first, at, eps, keep)
    dp(p, at, last, eps, keep)
  }
}

/** Douglas–Peucker on a closed loop: every dropped point stays within `eps` of the result. */
export function simplifyLoop(p: number[], eps: number): number[] {
  const n = p.length / 2
  if (n <= 3) return p.slice()
  // Split at the point farthest from the first, so both halves are open chains.
  let far = 0
  let fd = -1
  for (let k = 1; k < n; k++) {
    const dx = p[k * 2]! - p[0]!
    const dy = p[k * 2 + 1]! - p[1]!
    if (dx * dx + dy * dy > fd) {
      fd = dx * dx + dy * dy
      far = k
    }
  }
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[far] = 1
  dp(p, 0, far, eps, keep)
  dp(p, far, n, eps, keep)
  const out: number[] = []
  for (let k = 0; k < n; k++) if (keep[k]) out.push(p[k * 2]!, p[k * 2 + 1]!)
  return out
}

/**
 * A region's outline: the largest alpha loop, simplified to within `eps` texels, loosened until
 * it has at most `maxPoints` points. Pixel coordinates (y down); empty when nothing is opaque.
 */
export function alphaOutline(
  width: number,
  height: number,
  alpha: (x: number, y: number) => number,
  options: { eps?: number; maxPoints?: number } = {},
): number[] {
  const loops = traceAlpha(width, height, alpha)
  if (loops.length === 0) return []
  let best = loops[0]!
  for (const l of loops) if (Math.abs(loopArea(l)) > Math.abs(loopArea(best))) best = l
  const maxPoints = options.maxPoints ?? 32
  let eps = options.eps ?? 0.5
  let out = simplifyLoop(best, eps)
  while (out.length / 2 > maxPoints) {
    eps *= 1.25
    out = simplifyLoop(best, eps)
  }
  return out
}
