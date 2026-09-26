// Pool jobs for @shard/noise. Plain JavaScript: workers import it with no bundler or loader.
import {
  computeOrigins,
  evalProgram,
  gridOrigin,
  gridPoints,
  instantiate,
  patchOrigin,
  patchPoints,
} from './kernel.js'

/**
 * Samples `program` for one job and returns the values (moved back to the caller).
 * `job.kind` is `points` (with optional f64 `origin`), `patch`, or `grid`; patch and grid jobs
 * cover rows [row0, row1) and use the whole area's center as origin, so how a request is split
 * never changes a value.
 */
export function sample(module, program, seed, job) {
  const state = instantiate(module)
  if (job.kind === 'points') {
    const count = job.points.length / job.stride
    const out = new Float32Array(count)
    const origins = job.origin
      ? computeOrigins(program.terms, job.origin, new Int32Array(program.zeroOrigins.length))
      : program.zeroOrigins
    evalProgram(state, program, seed, origins, job.points, job.stride, count, out)
    return out
  }
  const origin = new Float64Array(4)
  let width
  let local
  if (job.kind === 'patch') {
    patchOrigin(job.area, origin)
    width = job.area.resolution
    local = patchPoints(
      job.area,
      origin,
      job.row0,
      job.row1,
      new Float32Array((job.row1 - job.row0) * width * 3),
    )
  } else {
    gridOrigin(job.area, origin)
    width = job.area.resolution[0]
    local = gridPoints(
      job.area,
      origin,
      job.row0,
      job.row1,
      new Float32Array((job.row1 - job.row0) * width * 3),
    )
  }
  const origins = computeOrigins(program.terms, origin, new Int32Array(program.zeroOrigins.length))
  const count = (job.row1 - job.row0) * width
  const out = new Float32Array(count)
  evalProgram(state, program, seed, origins, local, 3, count, out)
  return out
}
