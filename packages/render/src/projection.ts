import { type Entity, mat4, type World } from '@aethervtt/shard-core'
import { Cameras } from './view'

// Projection helpers (0057): where a world point lands on a camera's target, in CSS pixels, and
// back. A host positions its DOM overlays (authoring handles, labels) with them, on CameraMoved
// and on its own edits rather than every frame. They use the camera's last extracted, unjittered
// projection, so they agree with what the GPU drew.

const scratchInv = mat4.create()
const scratchKey = mat4.create()
let invValid = false

/** The inverse of a camera's unjittered view-projection, cached while it doesn't change. */
function inverse(viewProj: Float32Array): Float32Array {
  let same = invValid
  for (let i = 0; same && i < 16; i++) if (scratchKey[i] !== viewProj[i]) same = false
  if (!same) {
    mat4.copy(scratchKey, viewProj)
    invValid = mat4.invert(scratchInv, viewProj) !== null
  }
  return scratchInv
}

/**
 * Projects a world point to CSS pixels on `camera`'s target (origin top-left). Returns false when
 * the point is behind the camera (`out` is left unchanged), or the camera hasn't rendered yet.
 */
export function worldToScreen(
  world: World,
  camera: Entity,
  point: ArrayLike<number>,
  out: { [index: number]: number },
): boolean {
  const cam = world.tryResource(Cameras)?.get(camera)
  if (!cam) return false
  const m = cam.viewProjNoJitter
  const x = point[0]!
  const y = point[1]!
  const z = point[2]!
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  if (cw <= 1e-9) return false
  const width = cam.displayWidth / cam.pixelRatio
  const height = cam.displayHeight / cam.pixelRatio
  out[0] = ((cx / cw) * 0.5 + 0.5) * width
  out[1] = (0.5 - (cy / cw) * 0.5) * height
  return true
}

/**
 * The world ray under CSS pixel (x, y) of `camera`'s target: its origin on the near plane and its
 * unit direction. Orthographic rays are parallel, perspective ones start at the near plane.
 */
export function screenToRay(
  world: World,
  camera: Entity,
  x: number,
  y: number,
  outOrigin: { [index: number]: number },
  outDir: { [index: number]: number },
): void {
  const cam = world.tryResource(Cameras)?.get(camera)
  if (!cam) {
    outOrigin[0] = outOrigin[1] = outOrigin[2] = 0
    outDir[0] = outDir[1] = 0
    outDir[2] = -1
    return
  }
  const inv = inverse(cam.viewProjNoJitter)
  const nx = (x / (cam.displayWidth / cam.pixelRatio)) * 2 - 1
  const ny = 1 - (y / (cam.displayHeight / cam.pixelRatio)) * 2
  // Reversed Z: the near plane is at depth 1; 0.5 is always in front of it.
  let px = 0
  let py = 0
  let pz = 0
  for (let k = 0; k < 2; k++) {
    const d = k === 0 ? 1 : 0.5
    const wx = inv[0]! * nx + inv[4]! * ny + inv[8]! * d + inv[12]!
    const wy = inv[1]! * nx + inv[5]! * ny + inv[9]! * d + inv[13]!
    const wz = inv[2]! * nx + inv[6]! * ny + inv[10]! * d + inv[14]!
    const ww = inv[3]! * nx + inv[7]! * ny + inv[11]! * d + inv[15]!
    if (k === 0) {
      px = wx / ww
      py = wy / ww
      pz = wz / ww
    } else {
      const dx = wx / ww - px
      const dy = wy / ww - py
      const dz = wz / ww - pz
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      outDir[0] = dx / len
      outDir[1] = dy / len
      outDir[2] = dz / len
    }
  }
  outOrigin[0] = px
  outOrigin[1] = py
  outOrigin[2] = pz
}

const rayOrigin = new Float64Array(3)
const rayDir = new Float64Array(3)

/**
 * Where the ray under CSS pixel (x, y) meets the horizontal plane `y = planeY` (a floor, a ground
 * band). Returns false when it doesn't (parallel, or behind the camera).
 */
export function screenToPlane(
  world: World,
  camera: Entity,
  x: number,
  y: number,
  planeY: number,
  out: { [index: number]: number },
): boolean {
  screenToRay(world, camera, x, y, rayOrigin, rayDir)
  const dy = rayDir[1]!
  if (Math.abs(dy) < 1e-9) return false
  const t = (planeY - rayOrigin[1]!) / dy
  if (t < 0) return false
  out[0] = rayOrigin[0]! + rayDir[0]! * t
  out[1] = planeY
  out[2] = rayOrigin[2]! + rayDir[2]! * t
  return true
}
