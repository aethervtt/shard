import type { SelectionView } from './quadtree'

/** A selection view with room for four side planes. */
export function createView(): SelectionView {
  return {
    position: new Float64Array(3),
    frustum: new Float64Array(16),
    wide: new Float64Array(16),
    planes: 0,
    pixelsPerRadian: 1000,
  }
}

/**
 * Fills a selection view for a perspective camera at `position` (planet frame, f64) with unit axes
 * `right`, `up`, and `forward` (the direction it looks): the four side planes through the camera
 * (near and far are left out; the horizon culls far terrain), and pixels per radian for a viewport
 * `height` pixels tall.
 */
export function perspectiveView(
  out: SelectionView,
  position: ArrayLike<number>,
  right: ArrayLike<number>,
  up: ArrayLike<number>,
  forward: ArrayLike<number>,
  fovY: number,
  aspect: number,
  height: number,
): SelectionView {
  out.position[0] = position[0]!
  out.position[1] = position[1]!
  out.position[2] = position[2]!
  const hy = fovY / 2
  const hx = Math.atan(Math.tan(hy) * aspect)
  const cx = Math.cos(hx)
  const sx = Math.sin(hx)
  const cy = Math.cos(hy)
  const sy = Math.sin(hy)
  const f = out.frustum
  // Inward normals: each side plane leans toward the view axis.
  plane(f, 0, right, forward, cx, sx, position)
  plane(f, 1, right, forward, -cx, sx, position)
  plane(f, 2, up, forward, cy, sy, position)
  plane(f, 3, up, forward, -cy, sy, position)
  // The same, 1.5× wider (capped short of 90°).
  const wx = Math.min(1.45, hx * 1.5)
  const wy = Math.min(1.45, hy * 1.5)
  const w = out.wide
  plane(w, 0, right, forward, Math.cos(wx), Math.sin(wx), position)
  plane(w, 1, right, forward, -Math.cos(wx), Math.sin(wx), position)
  plane(w, 2, up, forward, Math.cos(wy), Math.sin(wy), position)
  plane(w, 3, up, forward, -Math.cos(wy), Math.sin(wy), position)
  out.planes = 4
  out.pixelsPerRadian = height / (2 * Math.tan(hy))
  return out
}

function plane(
  f: Float64Array,
  i: number,
  side: ArrayLike<number>,
  forward: ArrayLike<number>,
  a: number,
  b: number,
  p: ArrayLike<number>,
): void {
  let nx = side[0]! * a + forward[0]! * b
  let ny = side[1]! * a + forward[1]! * b
  let nz = side[2]! * a + forward[2]! * b
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
  nx /= len
  ny /= len
  nz /= len
  f[i * 4] = nx
  f[i * 4 + 1] = ny
  f[i * 4 + 2] = nz
  f[i * 4 + 3] = -(nx * p[0]! + ny * p[1]! + nz * p[2]!)
}

/** A view that sees in every direction (no side planes): selection culls by the horizon only. */
export function omniView(out: SelectionView, position: ArrayLike<number>, pixelsPerRadian: number) {
  out.position[0] = position[0]!
  out.position[1] = position[1]!
  out.position[2] = position[2]!
  out.planes = 0
  out.pixelsPerRadian = pixelsPerRadian
  return out
}
