// A terrain generator for tests (spec 0119): rolling value noise from a seeded table, a flat pad
// graded into it, and weights by height and the pad. Only + − × ÷ and sqrt, so every engine gives
// the same bits. The worker test bundles this file as the project's code.
import { t } from '@aethervtt/shard-core'
import { defineTerrainGenerator } from '../generator'

export interface GroundPlan {
  table: Float64Array
  relief: number
  pad: [number, number, number, number, number]
  /** A basement's footprint in the pad (spec 0120): centre x, z, width, depth. */
  basement: [number, number, number, number]
}

function lattice(plan: GroundPlan, i: number, j: number): number {
  const h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1)
  return plan.table[(h ^ (h >>> 15)) & 255]!
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Value noise at (x, z) in lattice units, about −1 to 1. */
function value(plan: GroundPlan, x: number, z: number): number {
  const i = Math.floor(x)
  const j = Math.floor(z)
  const u = smooth(x - i)
  const v = smooth(z - j)
  const a = lattice(plan, i, j)
  const b = lattice(plan, i + 1, j)
  const c = lattice(plan, i, j + 1)
  const d = lattice(plan, i + 1, j + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** The ground without the pad. */
export function rawGround(plan: GroundPlan, x: number, z: number): number {
  let h = 0
  let amp = 1
  let f = 1 / 900
  for (let o = 0; o < 5; o++) {
    h += value(plan, x * f + o * 17.3, z * f - o * 9.1) * amp
    amp *= 0.5
    f *= 2
  }
  return 100 + h * plan.relief
}

/** How much of the pad's level the ground takes at (x, z): 1 inside, 0 past its 20 m falloff. */
export function padShare(plan: GroundPlan, x: number, z: number): number {
  const [px, pz, w, d] = plan.pad
  const dx = Math.max(0, Math.abs(x - px) - w / 2)
  const dz = Math.max(0, Math.abs(z - pz) - d / 2)
  const r = Math.sqrt(dx * dx + dz * dz)
  return r >= 20 ? 0 : smooth(1 - r / 20)
}

export function groundAt(plan: GroundPlan, x: number, z: number): number {
  const h = rawGround(plan, x, z)
  const m = padShare(plan, x, z)
  return m > 0 ? h + (plan.pad[4] - h) * m : h
}

export const TestGround = defineTerrainGenerator('shard-test/Ground', {
  params: {
    seed: t.u32({ default: 1 }),
    relief: t.f64({ default: 60, unit: 'm' }),
    pad: t.list(t.f64(), { default: [1000, 1000, 24, 16, 110] }),
    basement: t.list(t.f64(), { default: [1000, 1000, 10, 8] }),
  },
  version: 1,
  deterministicMath: true,
  prepare: ({ seed, relief, pad, basement }): GroundPlan => {
    const table = new Float64Array(256)
    let s = seed >>> 0 || 1
    for (let i = 0; i < 256; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      table[i] = ((s >>> 0) / 4294967296) * 2 - 1
    }
    return {
      table,
      relief,
      pad: pad as GroundPlan['pad'],
      basement: basement as GroundPlan['basement'],
    }
  },
  heights: (plan, area, out) => {
    for (let b = 0; b < area.nz; b++) {
      const z = area.z0 + b * area.step
      for (let a = 0; a < area.nx; a++) out[b * area.nx + a] = groundAt(plan, area.x0 + a * area.step, z)
    }
  },
  holes: (plan, area, out) => {
    const [bx, bz, w, d] = plan.basement
    for (let b = 0; b < area.nz; b++) {
      const z = area.z0 + b * area.step
      for (let a = 0; a < area.nx; a++) {
        const x = area.x0 + a * area.step
        if (Math.abs(x - bx) < w / 2 && Math.abs(z - bz) < d / 2) out[b * area.nx + a] = 1
      }
    }
  },
  // Scatter fields (spec 0121): a 10 m road along z = 1200, half density, and everywhere.
  fields: {
    road: (_plan, xz, count, out) => {
      for (let i = 0; i < count; i++) out[i] = Math.abs(xz[i * 2 + 1]! - 1200) < 5 ? 0 : 1
    },
    half: (_plan, _xz, count, out) => {
      out.fill(0.5, 0, count)
    },
    one: (_plan, _xz, count, out) => {
      out.fill(1, 0, count)
    },
  },
  layers: ['grass', 'rock', 'gravel'],
  weights: (plan, area, heights, out) => {
    for (let b = 0; b < area.nz; b++) {
      const z = area.z0 + b * area.step
      for (let a = 0; a < area.nx; a++) {
        const k = b * area.nx + a
        const pad = padShare(plan, area.x0 + a * area.step, z)
        const rock = Math.min(1, Math.max(0, (heights[k]! - 130) / 10)) * (1 - pad)
        out[k * 3] = 1 - rock - pad
        out[k * 3 + 1] = rock
        out[k * 3 + 2] = pad
      }
    }
  },
})
