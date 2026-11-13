import type { Entity, Query, World } from '@aethervtt/shard-core'
import { type InterestPolicy, netSession } from '@aethervtt/shard-net'
import { PartitionState } from '@aethervtt/shard-partition'
import { FixedTime } from '@aethervtt/shard-runtime'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { HordeCell } from './components'

export interface HordeInterestOptions {
  /** Seconds between sends within `nearFactor` × replicate.range (default 1). */
  nearEvery?: number
  /** Seconds between sends further out (default 2). */
  farEvery?: number
  /** Default 1.5. */
  nearFactor?: number
  /** A cell is sent only if it reaches past this × replicate.range (default 0.8). */
  innerFactor?: number
}

/**
 * Horde cells a peer should see (0115): within the peer's last level range of its nearest focus,
 * and reaching past 0.8 × `replicate.range` (closer members are replicated themselves). Sent every
 * 1 s within 1.5 × `replicate.range`, else every 2 s. A cell the peer has keeps its place 10%
 * longer each way. Combine with `anyOf(ownerInterest(), streamInterest(), hordeInterest())`.
 */
export function hordeInterest(options: HordeInterestOptions = {}): InterestPolicy {
  const nearEvery = options.nearEvery ?? 1
  const farEvery = options.farEvery ?? 2
  const nearFactor = options.nearFactor ?? 1.5
  const innerFactor = options.innerFactor ?? 0.8
  let query: Query | undefined
  let queryWorld: World | undefined
  let focus = new Float64Array(16)
  return {
    name: 'characters/hordes',
    update(world, peer, out) {
      const rt = world.tryResource(PartitionState)?.instances.values().next().value
      const grid = rt?.partition.grids[0]
      if (!grid) return
      if (queryWorld !== world || !query) {
        queryWorld = world
        query = world.query({ with: [HordeCell] })
      }
      let n = 0
      for (let i = 0; i < peer.focus.length; i++) {
        if (n * 2 + 2 > focus.length) {
          const next = new Float64Array(focus.length * 2)
          next.set(focus)
          focus = next
        }
        if (positionOf(world, peer.focus[i]!, focus, n * 2)) n++
      }
      if (n === 0) return
      const fixed = world.resource(FixedTime)
      const perNet = fixed.step * (netSession(world).server?.config.ticksPerNet ?? 1)
      const nearTicks = Math.max(1, Math.round(nearEvery / perNet))
      const farTicks = Math.max(1, Math.round(farEvery / perNet))
      const cs = grid.cellSize
      const outer = grid.levels[grid.levels.length - 1]!.range
      const range = grid.replicateRange
      for (let t = 0; t < query.tables.length; t++) {
        const table = query.tables[t]!
        const xs = table.column(HordeCell, 'x')
        const zs = table.column(HordeCell, 'z')
        for (let row = 0; row < table.count; row++) {
          const e = table.entities[row]!
          const known = peer.knows(e)
          const every = hordeEvery(
            focus,
            n,
            cs,
            xs[row]!,
            zs[row]!,
            outer * (known ? 1.1 : 1),
            range * innerFactor * (known ? 0.9 : 1),
            range * nearFactor,
          )
          if (every === 0) continue
          out.add(e, every === 1 ? nearTicks : farTicks)
        }
      }
    },
  }
}

/**
 * 0 when a cell isn't relevant, 1 when it is within `near` of the nearest focus, 2 further out.
 * `focus` holds n (x, z) pairs. Relevant: its nearest point within `outer` of some focus, and
 * its farthest point beyond `inner` of every focus. Exported for tests.
 */
export function hordeEvery(
  focus: Float64Array,
  n: number,
  cellSize: number,
  x: number,
  z: number,
  outer: number,
  inner: number,
  near: number,
): 0 | 1 | 2 {
  const x0 = x * cellSize
  const z0 = z * cellSize
  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i < n; i++) {
    const fx = focus[i * 2]!
    const fz = focus[i * 2 + 1]!
    const dx = fx < x0 ? x0 - fx : fx > x0 + cellSize ? fx - x0 - cellSize : 0
    const dz = fz < z0 ? z0 - fz : fz > z0 + cellSize ? fz - z0 - cellSize : 0
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < nearest) nearest = d
    const fx1 = Math.max(Math.abs(fx - x0), Math.abs(fx - x0 - cellSize))
    const fz1 = Math.max(Math.abs(fz - z0), Math.abs(fz - z0 - cellSize))
    if (Math.sqrt(fx1 * fx1 + fz1 * fz1) <= inner) return 0
  }
  if (nearest > outer) return 0
  return nearest <= near ? 1 : 2
}

function positionOf(world: World, e: Entity, out: Float64Array, o: number): boolean {
  if (!world.isAlive(e)) return false
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  if (table.has(GlobalTransform)) {
    const m = table.column(GlobalTransform, 'matrix')
    out[o] = m[row * 12 + 3]!
    out[o + 1] = m[row * 12 + 11]!
    return true
  }
  if (!table.has(Transform)) return false
  const t = table.column(Transform, 'translation')
  out[o] = t[row * 3]!
  out[o + 1] = t[row * 3 + 2]!
  return true
}
