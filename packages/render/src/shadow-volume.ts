// Cascade geometry and shadow volumes (0116): where a camera's cascades sit, and whether a caster's
// shadow can reach a slice of the camera's view. The renderer's cascade fit and casterRelevant both
// use these, so they agree exactly on the same inputs.

const f32 = Math.fround

/** A camera's projection, as the cascade fit needs it. */
export interface CascadeCamera {
  /** World → view, column-major (camera looks down -Z). */
  view: ArrayLike<number>
  position: ArrayLike<number>
  forward: ArrayLike<number>
  orthographic: boolean
  fovY: number
  aspect: number
  orthoHeight: number
  near: number
}

/** The shadowed sun's cascade settings. */
export interface CascadeSun {
  /** Unit vector toward the light. */
  direction: ArrayLike<number>
  count: number
  maxDistance: number
  splitLambda: number
  /** Cached cascades move in steps of this fraction of their width; 0 snaps to texels (0116). */
  step: number
}

export const MAX_CASCADE_COUNT = 4

/**
 * Where a camera's cascades are this frame: per cascade the light-space center and radius of its
 * box, the world size of a texel, and the camera's frustum slice it shades (6 planes, inside where
 * `n · p + d ≥ 0`). `basis` rows are the light's right, up and travel direction.
 */
export interface CascadeGeometry {
  count: number
  readonly splits: Float32Array
  readonly centers: Float32Array
  readonly radius: Float32Array
  readonly texel: Float32Array
  readonly slices: Float32Array
  readonly basis: Float32Array
}

export function createCascadeGeometry(): CascadeGeometry {
  return {
    count: 0,
    splits: new Float32Array(4),
    centers: new Float32Array(12),
    radius: new Float32Array(4),
    texel: new Float32Array(4),
    slices: new Float32Array(24 * MAX_CASCADE_COUNT),
    basis: new Float32Array(9),
  }
}

/**
 * Practical split scheme: a blend of logarithmic and uniform splits. Returns the far view depth of
 * each cascade.
 */
export function cascadeSplits(
  out: Float32Array,
  count: number,
  near: number,
  far: number,
  lambda: number,
): Float32Array {
  for (let i = 1; i <= count; i++) {
    const log = near * (far / near) ** (i / count)
    const uniform = near + ((far - near) * i) / count
    out[i - 1] = lambda * log + (1 - lambda) * uniform
  }
  return out
}

/**
 * The bounding sphere of a view-frustum slice [a, b] (view depths) into `out`: its center's view
 * depth, then its radius. Depends only on the projection, so it doesn't change as the camera turns.
 */
export function sliceSphereInto(
  out: Float32Array | number[],
  cam: CascadeCamera,
  a: number,
  b: number,
): void {
  let ha: number
  let hb: number
  if (cam.orthographic) {
    const hy = cam.orthoHeight / 2
    const hx = hy * cam.aspect
    ha = hb = hx * hx + hy * hy
  } else {
    const t = Math.tan(cam.fovY / 2)
    const k = 1 + cam.aspect * cam.aspect
    ha = a * a * t * t * k
    hb = b * b * t * t * k
  }
  let c = (a + b) / 2 + (hb - ha) / (2 * (b - a))
  if (c > b) c = b
  if (c < a) c = a
  out[0] = c
  out[1] = Math.sqrt(Math.max(hb + (b - c) * (b - c), ha + (c - a) * (c - a)))
}

/** Unit basis for a light traveling along `f` (world) into `out`: right, up, forward, rows. */
export function lightBasis(out: Float32Array, fx: number, fy: number, fz: number): Float32Array {
  // up = world Y unless the light is (almost) vertical.
  let ux = 0
  let uy = 1
  let uz = 0
  if (Math.abs(fy) > 0.99) {
    ux = 1
    uy = 0
  }
  // right = normalize(f × up)
  let rx = fy * uz - fz * uy
  let ry = fz * ux - fx * uz
  let rz = fx * uy - fy * ux
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz)
  rx /= rl
  ry /= rl
  rz /= rl
  // up = right × f
  ux = ry * fz - rz * fy
  uy = rz * fx - rx * fz
  uz = rx * fy - ry * fx
  out[0] = rx
  out[1] = ry
  out[2] = rz
  out[3] = ux
  out[4] = uy
  out[5] = uz
  out[6] = fx
  out[7] = fy
  out[8] = fz
  return out
}

/**
 * The camera's frustum between view depths a and b as 6 world planes into `out` at `o`: left,
 * right, bottom, top, near (a), far (b).
 */
export function sliceFrustum(
  out: Float32Array,
  o: number,
  cam: CascadeCamera,
  a: number,
  b: number,
): void {
  const v = cam.view
  if (cam.orthographic) {
    const hy = cam.orthoHeight / 2
    const hx = hy * cam.aspect
    viewPlane(out, o, v, 1, 0, 0, hx)
    viewPlane(out, o + 4, v, -1, 0, 0, hx)
    viewPlane(out, o + 8, v, 0, 1, 0, hy)
    viewPlane(out, o + 12, v, 0, -1, 0, hy)
  } else {
    const t = Math.tan(cam.fovY / 2)
    const tx = t * cam.aspect
    viewPlane(out, o, v, 1, 0, -tx, 0)
    viewPlane(out, o + 4, v, -1, 0, -tx, 0)
    viewPlane(out, o + 8, v, 0, 1, -t, 0)
    viewPlane(out, o + 12, v, 0, -1, -t, 0)
  }
  viewPlane(out, o + 16, v, 0, 0, -1, -a)
  viewPlane(out, o + 20, v, 0, 0, 1, b)
}

/** A view-space plane (n, d) into world space at `p`: n_w = Rᵀn, d_w = n · t + d. */
function viewPlane(
  out: Float32Array,
  p: number,
  v: ArrayLike<number>,
  nx: number,
  ny: number,
  nz: number,
  d: number,
): void {
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
  nx /= l
  ny /= l
  nz /= l
  out[p] = nx * v[0]! + ny * v[1]! + nz * v[2]!
  out[p + 1] = nx * v[4]! + ny * v[5]! + nz * v[6]!
  out[p + 2] = nx * v[8]! + ny * v[9]! + nz * v[10]!
  out[p + 3] = nx * v[12]! + ny * v[13]! + nz * v[14]! + d / l
}

const slice = [0, 0]

/**
 * Fits a camera's cascades for a sun: splits, each slice's bounding sphere in light space (snapped
 * to texels, or with `sun.step` to steps of that fraction of its width, the box growing by a step
 * so the slice stays inside it), and the slice's planes.
 */
export function fitCascadeGeometry(
  out: CascadeGeometry,
  cam: CascadeCamera,
  sun: CascadeSun,
  size: number,
): void {
  const count = Math.min(MAX_CASCADE_COUNT, Math.max(1, sun.count))
  out.count = count
  const near = Math.max(cam.near, 1e-3)
  const far = Math.max(near * 1.01, sun.maxDistance)
  cascadeSplits(out.splits, count, near, far, sun.splitLambda)
  for (let i = count; i < MAX_CASCADE_COUNT; i++) out.splits[i] = 0
  // The light travels along -direction.
  const basis = lightBasis(out.basis, -sun.direction[0]!, -sun.direction[1]!, -sun.direction[2]!)
  const step = sun.step > 0 ? sun.step : 0
  let start = near
  for (let i = 0; i < count; i++) {
    const end = out.splits[i]!
    sliceSphereInto(slice, cam, start, end)
    sliceFrustum(out.slices, i * 24, cam, start, end)
    start = end
    const depth = slice[0]!
    const radius = slice[1]! * (1 + step)
    const cxw = cam.position[0]! + cam.forward[0]! * depth
    const cyw = cam.position[1]! + cam.forward[1]! * depth
    const czw = cam.position[2]! + cam.forward[2]! * depth
    const texel = (2 * radius) / size
    // Snapped so edges don't swim as the camera moves: to texels, or to steps of the width.
    const grid = step > 0 ? 2 * slice[1]! * step : texel
    out.centers[i * 3] =
      Math.floor((basis[0]! * cxw + basis[1]! * cyw + basis[2]! * czw) / grid) * grid
    out.centers[i * 3 + 1] =
      Math.floor((basis[3]! * cxw + basis[4]! * cyw + basis[5]! * czw) / grid) * grid
    out.centers[i * 3 + 2] =
      Math.floor((basis[6]! * cxw + basis[7]! * cyw + basis[8]! * czw) / grid) * grid
    out.radius[i] = radius
    out.texel[i] = texel
  }
}

/**
 * Whether a sphere's shadow can land in a view: the sphere swept along the light's travel `f` for
 * `len` meters (a capsule) meets the half-spaces `planes` (6 at `o`), grown by `margin`. Mirrors
 * `in_capsule` in the cull shader.
 */
export function capsuleInPlanes(
  planes: Float32Array,
  o: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  fx: number,
  fy: number,
  fz: number,
  len: number,
): boolean {
  const l = len > 0 ? len : 0
  for (let p = o; p < o + 24; p += 4) {
    const nx = planes[p]!
    const ny = planes[p + 1]!
    const nz = planes[p + 2]!
    const d0 = f32(nx * cx + ny * cy + nz * cz + planes[p + 3]!)
    const d1 = f32(d0 + f32(nx * fx + ny * fy + nz * fz) * l)
    if ((d0 > d1 ? d0 : d1) < -r) return false
  }
  return true
}

/**
 * The capsule test of a cascade (or a sweep packed as `fx, fy, fz, far`): the sphere swept along
 * the light to the cascade's far side, against the slice planes. A sphere wholly past the far side
 * casts nothing there.
 */
export function sweptInSlice(
  planes: Float32Array,
  o: number,
  sweep: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): boolean {
  const fx = sweep[0]!
  const fy = sweep[1]!
  const fz = sweep[2]!
  const len = f32(sweep[3]! - f32(fx * cx + fy * cy + fz * cz))
  if (len < -r) return false
  return capsuleInPlanes(planes, o, cx, cy, cz, r, fx, fy, fz, len)
}

/**
 * Quantizes a direction toward the light to `stepDeg` steps of elevation and azimuth (0116's
 * `shadowAngleStep`), in place. 0 leaves it exact.
 */
export function quantizeDirection(dir: Float32Array, stepDeg: number): void {
  if (!(stepDeg > 0)) return
  const step = (stepDeg * Math.PI) / 180
  const x = dir[0]!
  const y = Math.min(1, Math.max(-1, dir[1]!))
  const z = dir[2]!
  const el = Math.round(Math.asin(y) / step) * step
  const az = Math.round(Math.atan2(x, z) / step) * step
  const c = Math.cos(el)
  dir[0] = c * Math.sin(az)
  dir[1] = Math.sin(el)
  dir[2] = c * Math.cos(az)
}
