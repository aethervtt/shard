// Camera views the controls reason in (0060): an eye, its axes and its lens, built from a control's
// own fields rather than last frame's extracted matrices, so a drag and the camera it moves agree
// within the frame, headless too. Every function writes into `out` and allocates nothing.

type Vec = { [index: number]: number }

export interface ViewBasis {
  eye: Float64Array
  /** Screen right, screen up and the look direction, unit and orthogonal. */
  right: Float64Array
  up: Float64Array
  forward: Float64Array
  orthographic: boolean
  /** Perspective: tan(fovY / 2). Orthographic: half the view height. */
  half: number
  /** Width over height. */
  aspect: number
}

export function createView(): ViewBasis {
  return {
    eye: new Float64Array(3),
    right: new Float64Array([1, 0, 0]),
    up: new Float64Array([0, 1, 0]),
    forward: new Float64Array([0, 0, -1]),
    orthographic: false,
    half: 1,
    aspect: 1,
  }
}

const DEG = Math.PI / 180

/** The orbit camera's eye offset from the target, unit length. */
export function orbitDirection(yaw: number, pitch: number, out: Vec): void {
  const y = yaw * DEG
  const p = pitch * DEG
  out[0] = Math.sin(y) * Math.cos(p)
  out[1] = Math.sin(p)
  out[2] = Math.cos(y) * Math.cos(p)
}

/** A perspective camera `distance` from `target`, looking at it from (yaw, pitch), Y up. */
export function orbitView(
  out: ViewBasis,
  target: ArrayLike<number>,
  distance: number,
  yaw: number,
  pitch: number,
  fovY: number,
  aspect: number,
): ViewBasis {
  const y = yaw * DEG
  const p = pitch * DEG
  const cy = Math.cos(y)
  const sy = Math.sin(y)
  const cp = Math.cos(p)
  const sp = Math.sin(p)
  out.eye[0] = target[0]! + sy * cp * distance
  out.eye[1] = target[1]! + sp * distance
  out.eye[2] = target[2]! + cy * cp * distance
  out.forward[0] = -sy * cp
  out.forward[1] = -sp
  out.forward[2] = -cy * cp
  // Right is horizontal: forward × Y, normalized (cos p > 0 within ±89°).
  out.right[0] = cy
  out.right[1] = 0
  out.right[2] = -sy
  // up = right × forward
  out.up[0] = -sy * sp
  out.up[1] = cp
  out.up[2] = -cy * sp
  out.orthographic = false
  out.half = Math.tan((fovY * DEG) / 2)
  out.aspect = aspect
  return out
}

/** An orthographic camera `elevation` above `target`, looking straight down, screen-up -Z. */
export function mapView(
  out: ViewBasis,
  target: ArrayLike<number>,
  elevation: number,
  orthoHeight: number,
  aspect: number,
): ViewBasis {
  out.eye[0] = target[0]!
  out.eye[1] = target[1]! + elevation
  out.eye[2] = target[2]!
  out.forward[0] = 0
  out.forward[1] = -1
  out.forward[2] = 0
  out.right[0] = 1
  out.right[1] = 0
  out.right[2] = 0
  out.up[0] = 0
  out.up[1] = 0
  out.up[2] = -1
  out.orthographic = true
  out.half = orthoHeight / 2
  out.aspect = aspect
  return out
}

/** Any camera from its position and rotation (a unit quaternion), as `Camera3d` sees it. */
export function poseView(
  out: ViewBasis,
  position: ArrayLike<number>,
  rotation: ArrayLike<number>,
  orthographic: boolean,
  fovY: number,
  orthoHeight: number,
  aspect: number,
): ViewBasis {
  const x = rotation[0]!
  const y = rotation[1]!
  const z = rotation[2]!
  const w = rotation[3]!
  out.eye[0] = position[0]!
  out.eye[1] = position[1]!
  out.eye[2] = position[2]!
  // The rotation's columns: local +X, +Y and -Z.
  out.right[0] = 1 - 2 * (y * y + z * z)
  out.right[1] = 2 * (x * y + w * z)
  out.right[2] = 2 * (x * z - w * y)
  out.up[0] = 2 * (x * y - w * z)
  out.up[1] = 1 - 2 * (x * x + z * z)
  out.up[2] = 2 * (y * z + w * x)
  out.forward[0] = -2 * (x * z + w * y)
  out.forward[1] = -2 * (y * z - w * x)
  out.forward[2] = -(1 - 2 * (x * x + y * y))
  out.orthographic = orthographic
  out.half = orthographic ? orthoHeight / 2 : Math.tan((fovY * DEG) / 2)
  out.aspect = aspect
  return out
}

/** The ray under CSS pixel (x, y) of a `width` × `height` view: origin and unit direction. */
export function viewRay(
  v: ViewBasis,
  x: number,
  y: number,
  width: number,
  height: number,
  outOrigin: Vec,
  outDir: Vec,
): void {
  const nx = ((x / width) * 2 - 1) * v.half * v.aspect
  const ny = (1 - (y / height) * 2) * v.half
  if (v.orthographic) {
    for (let i = 0; i < 3; i++) {
      outOrigin[i] = v.eye[i]! + v.right[i]! * nx + v.up[i]! * ny
      outDir[i] = v.forward[i]!
    }
    return
  }
  const dx = v.forward[0]! + v.right[0]! * nx + v.up[0]! * ny
  const dy = v.forward[1]! + v.right[1]! * nx + v.up[1]! * ny
  const dz = v.forward[2]! + v.right[2]! * nx + v.up[2]! * ny
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  outOrigin[0] = v.eye[0]!
  outOrigin[1] = v.eye[1]!
  outOrigin[2] = v.eye[2]!
  outDir[0] = dx / len
  outDir[1] = dy / len
  outDir[2] = dz / len
}

const origin = new Float64Array(3)
const dir = new Float64Array(3)

/**
 * Where the ray under CSS pixel (x, y) meets the plane `y = planeY`. False when it doesn't (it
 * runs parallel, the plane is behind the camera, or the hit is past `maxDistance`).
 */
export function viewToPlane(
  v: ViewBasis,
  x: number,
  y: number,
  width: number,
  height: number,
  planeY: number,
  out: Vec,
  maxDistance = Number.POSITIVE_INFINITY,
): boolean {
  viewRay(v, x, y, width, height, origin, dir)
  const dy = dir[1]!
  if (Math.abs(dy) < 1e-9) return false
  const t = (planeY - origin[1]!) / dy
  if (t < 0 || t > maxDistance) return false
  out[0] = origin[0]! + dir[0]! * t
  out[1] = planeY
  out[2] = origin[2]! + dir[2]! * t
  return true
}

/** Projects a world point to CSS pixels. False when it's behind the camera. */
export function viewProject(
  v: ViewBasis,
  p: ArrayLike<number>,
  width: number,
  height: number,
  out: Vec,
): boolean {
  const rx = p[0]! - v.eye[0]!
  const ry = p[1]! - v.eye[1]!
  const rz = p[2]! - v.eye[2]!
  const depth = rx * v.forward[0]! + ry * v.forward[1]! + rz * v.forward[2]!
  let sx = rx * v.right[0]! + ry * v.right[1]! + rz * v.right[2]!
  let sy = rx * v.up[0]! + ry * v.up[1]! + rz * v.up[2]!
  if (!v.orthographic) {
    if (depth <= 1e-9) return false
    sx /= depth
    sy /= depth
  }
  out[0] = (sx / (v.half * v.aspect) + 1) * 0.5 * width
  out[1] = (1 - sy / v.half) * 0.5 * height
  return true
}
