import type { NavMeshRuntime } from './navmesh'
import type { Recast } from './recast'

// Detour's surface queries without the wrapper's per-call objects (0115): the raw bindings with
// result holders made once. Positions go in through reused arrays, and results come out in `surf`.
// What still allocates is inside Emscripten's bindings (none on the JS heap for these calls).

type RFilter = InstanceType<Recast['QueryFilter']>
type RawApi = Recast['Raw']
type Vec3 = InstanceType<RawApi['Vec3']>

interface Scratch {
  R: Recast
  a: number[]
  b: number[]
  ext: number[]
  vec: Vec3
  ref: InstanceType<RawApi['UnsignedIntRef']>
  over: InstanceType<RawApi['BoolRef']>
  height: InstanceType<RawApi['FloatRef']>
  visited: InstanceType<RawApi['UnsignedIntArray']>
  hit: { get_t(): number }
}

let scratch: Scratch | null = null

function sc(R: Recast): Scratch {
  if (scratch?.R === R) return scratch
  const Raw = R.Raw
  scratch = {
    R,
    a: [0, 0, 0],
    b: [0, 0, 0],
    ext: [0, 0, 0],
    vec: new Raw.Vec3(),
    ref: new Raw.UnsignedIntRef(),
    over: new Raw.BoolRef(),
    height: new Raw.FloatRef(),
    visited: new Raw.UnsignedIntArray(),
    hit: new Raw.Module.dtRaycastHit(),
  }
  return scratch
}

/** The last surface query's result: a polygon ref, a point, and (raycasts) how far it got. */
export const surf = { ref: 0, x: 0, y: 0, z: 0, t: 1 }

const DT_SUCCESS = 1 << 30
const ok = (status: number) => (status & DT_SUCCESS) !== 0

/** The polygon nearest (x, y, z) the filter passes, within (hx, hy, hx): `surf.ref` and its point. */
export function nearestPoly(
  rt: NavMeshRuntime,
  filter: RFilter,
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
): boolean {
  const s = sc(rt.R)
  s.a[0] = x
  s.a[1] = y
  s.a[2] = z
  s.ext[0] = hx
  s.ext[1] = hy
  s.ext[2] = hx
  s.ref.value = 0
  const status = rt.query.raw.findNearestPoly(s.a, s.ext, filter.raw, s.ref, s.vec, s.over)
  const ref = s.ref.value
  if (!ok(status) || ref === 0) return false
  surf.ref = ref
  surf.x = s.vec.x
  surf.y = s.vec.y
  surf.z = s.vec.z
  return true
}

/**
 * Moves from (sx, sy, sz) in polygon `ref` toward (tx, ty, tz) along the surface, sliding along
 * edges the filter doesn't pass (Detour's moveAlongSurface). `surf` gets where it ended and the
 * polygon it ended in; its height is the start's, not the surface's (`polyHeight` gives that).
 */
export function moveAlong(
  rt: NavMeshRuntime,
  filter: RFilter,
  ref: number,
  sx: number,
  sy: number,
  sz: number,
  tx: number,
  ty: number,
  tz: number,
): boolean {
  const s = sc(rt.R)
  s.a[0] = sx
  s.a[1] = sy
  s.a[2] = sz
  s.b[0] = tx
  s.b[1] = ty
  s.b[2] = tz
  const status = rt.query.raw.moveAlongSurface(ref, s.a, s.b, filter.raw, s.vec, s.visited, 16)
  if (!ok(status)) return false
  const n = s.visited.get_size()
  surf.ref = n > 0 ? s.visited.get(n - 1) : ref
  surf.x = s.vec.x
  surf.y = s.vec.y
  surf.z = s.vec.z
  return true
}

/** The surface height of polygon `ref` at (x, z) into `surf.y`; false when (x, z) is off it. */
export function polyHeight(
  rt: NavMeshRuntime,
  ref: number,
  x: number,
  y: number,
  z: number,
): boolean {
  const s = sc(rt.R)
  s.a[0] = x
  s.a[1] = y
  s.a[2] = z
  const status = rt.query.raw.getPolyHeight(ref, s.a, s.height)
  if (!ok(status)) return false
  surf.y = s.height.value
  return true
}

/** How far (`surf.t`, 0..1) a straight line from polygon `ref` gets toward a point on the surface. */
export function raycast(
  rt: NavMeshRuntime,
  filter: RFilter,
  ref: number,
  sx: number,
  sy: number,
  sz: number,
  tx: number,
  ty: number,
  tz: number,
): boolean {
  const s = sc(rt.R)
  s.a[0] = sx
  s.a[1] = sy
  s.a[2] = sz
  s.b[0] = tx
  s.b[1] = ty
  s.b[2] = tz
  const status = rt.query.raw.raycast(ref, s.a, s.b, filter.raw, 0, s.hit as never, 0)
  if (!ok(status)) return false
  const t = s.hit.get_t()
  surf.t = t > 1 ? 1 : t
  return true
}
