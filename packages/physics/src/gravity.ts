import type { Query } from '@aethervtt/shard-core'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { GravitySource } from './components'

/**
 * Gravity sources packed for per-body sampling: 6 floats each (position, strength, radius, and
 * range, stored as -range - 1 for constant falloff). Filled once per step.
 */
export interface GravitySources {
  data: Float64Array
  count: number
}

export const createGravitySources = (): GravitySources => ({
  data: new Float64Array(6 * 8),
  count: 0,
})

/** Packs every source in the query (entities with GravitySource and GlobalTransform). */
export function gatherGravitySources(query: Query, out: GravitySources): void {
  let n = 0
  for (let t = 0; t < query.tables.length; t++) {
    const table = query.tables[t]!
    const m = table.column(GlobalTransform, 'matrix')
    const strength = table.column(GravitySource, 'strength')
    const radius = table.column(GravitySource, 'radius')
    const range = table.column(GravitySource, 'range')
    const falloff = table.column(GravitySource, 'falloff')
    for (let row = 0; row < table.count; row++) {
      if ((n + 1) * 6 > out.data.length) {
        const grown = new Float64Array(out.data.length * 2)
        grown.set(out.data)
        out.data = grown
      }
      const d = out.data
      d[n * 6] = m[row * 12 + 3]!
      d[n * 6 + 1] = m[row * 12 + 7]!
      d[n * 6 + 2] = m[row * 12 + 11]!
      d[n * 6 + 3] = strength[row]!
      d[n * 6 + 4] = radius[row]!
      d[n * 6 + 5] = falloff[row] === 1 ? -range[row]! - 1 : range[row]!
      n++
    }
  }
  out.count = n
}

/**
 * Gravity at a point into out[0..2]: the sum of every source's pull, or with `strongest` only the
 * strongest one's (a character's down). out[3] is the returned vector's length.
 */
export function sampleGravity(
  sources: GravitySources,
  dim: 2 | 3,
  px: number,
  py: number,
  pz: number,
  strongest: boolean,
  out: Float64Array,
): void {
  let fx = 0
  let fy = 0
  let fz = 0
  let best = 0
  const d = sources.data
  for (let i = 0; i < sources.count; i++) {
    const dx = d[i * 6]! - px
    const dy = d[i * 6 + 1]! - py
    const dz = dim === 3 ? d[i * 6 + 2]! - pz : 0
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < 1e-6) continue
    const packed = d[i * 6 + 5]!
    const constant = packed < 0
    const range = constant ? -packed - 1 : packed
    if (range > 0 && dist > range) continue
    const r = d[i * 6 + 4]!
    const accel = constant ? d[i * 6 + 3]! : d[i * 6 + 3]! * ((r * r) / (dist * dist))
    if (strongest) {
      if (accel <= best) continue
      best = accel
      fx = (dx / dist) * accel
      fy = (dy / dist) * accel
      fz = (dz / dist) * accel
    } else {
      fx += (dx / dist) * accel
      fy += (dy / dist) * accel
      fz += (dz / dist) * accel
    }
  }
  out[0] = fx
  out[1] = fy
  out[2] = fz
  out[3] = Math.sqrt(fx * fx + fy * fy + fz * fz)
}
