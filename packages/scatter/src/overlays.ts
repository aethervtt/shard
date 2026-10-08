import { hash32, type World } from '@aethervtt/shard-core'
import { defineOverlay } from '@aethervtt/shard-render'
import { Scatter } from './runtime'
import { P_SCALE, P_X, PLACEMENT_STRIDE } from './surface'

const rows = new Float32Array(12)
const a = new Float32Array(3)
const b = new Float32Array(3)
const colors = new Map<string, number[]>()

/** A steady, distinct color per rule (by its id). */
function ruleColor(id: string): number[] {
  let c = colors.get(id)
  if (c) return c
  let h = 0
  for (let i = 0; i < id.length; i++) h = hash32(h, id.charCodeAt(i))
  const hue = (h % 360) / 60
  const x = 1 - Math.abs((hue % 2) - 1)
  const rgb =
    hue < 1
      ? [1, x, 0]
      : hue < 2
        ? [x, 1, 0]
        : hue < 3
          ? [0, 1, x]
          : hue < 4
            ? [0, x, 1]
            : hue < 5
              ? [x, 0, 1]
              : [1, 0, x]
  c = [...rgb, 1]
  colors.set(id, c)
  return c
}

function toWorld(x: number, y: number, z: number, out: Float32Array): Float32Array {
  out[0] = rows[0]! * x + rows[1]! * y + rows[2]! * z + rows[3]!
  out[1] = rows[4]! * x + rows[5]! * y + rows[6]! * z + rows[7]!
  out[2] = rows[8]! * x + rows[9]! * y + rows[10]! * z + rows[11]!
  return out
}

/** Spawned props as dots (a short upright tick per item), colored by rule. */
export const scatterOverlay = defineOverlay({
  name: 'scatter',
  description:
    'Scatter placements: a tick at every spawned prop, colored by rule (each rule keeps its color), to see density, spacing and masks at a glance.',
  draw: (world: World, g) => {
    const state = world.tryResource(Scatter)
    if (!state) return
    for (const ss of state.surfaces.values()) {
      for (const c of ss.chunks.values()) {
        if (c.root < 0 || !c.placements) continue
        const rule = ss.surface.rules[c.chunk.rule]!
        const color = ruleColor(rule.id)
        ss.surface.chunkTransform(world, c.chunk, rows)
        const p = c.placements
        ss.surface.upAt(c.chunk.center[0]!, c.chunk.center[1]!, c.chunk.center[2]!, up)
        for (let i = 0; i < p.count; i++) {
          const o = i * PLACEMENT_STRIDE
          const x = p.data[o + P_X]!
          const y = p.data[o + P_X + 1]!
          const z = p.data[o + P_X + 2]!
          const s = 0.6 * p.data[o + P_SCALE]!
          toWorld(x, y, z, a)
          toWorld(x + up[0]! * s, y + up[1]! * s, z + up[2]! * s, b)
          g.line(a, b, color)
        }
      }
    }
  },
})

const up = new Float64Array(3)
const LIVE = [0.3, 1, 0.5, 1]
const WAITING = [1, 0.75, 0.2, 1]

/** Foliage chunks' borders on the ground (green when placed on the GPU, amber while building). */
export const foliageChunksOverlay = defineOverlay({
  name: 'foliage-chunks',
  description:
    'GPU foliage chunks: each one’s border on the ground, green once placed on the GPU and amber while its ground patch is still being built.',
  draw: (world: World, g) => {
    const state = world.tryResource(Scatter)
    if (!state) return
    for (const ss of state.surfaces.values()) {
      for (const f of ss.foliage.values()) {
        for (const c of f.chunks.values()) {
          if (!c.corners) continue
          ss.surface.chunkTransform(world, c.chunk, rows)
          const color = c.slot >= 0 ? LIVE : WAITING
          for (let k = 0; k < 4; k++) {
            const n = (k + 1) % 4
            toWorld(c.corners[k * 3]!, c.corners[k * 3 + 1]!, c.corners[k * 3 + 2]!, a)
            toWorld(c.corners[n * 3]!, c.corners[n * 3 + 1]!, c.corners[n * 3 + 2]!, b)
            g.line(a, b, color)
          }
        }
      }
    }
  },
})
