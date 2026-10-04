import { describe, expect, it } from 'vitest'
import { floorShape } from './geometry'
import {
  type Barrier,
  buildRow,
  type FieldGrid,
  FieldLayer,
  packRect,
  RowScratch,
  rasterBarrier,
  rasterCover,
  SolveScratch,
  solveRect,
  type TexelRect,
  unpackBin,
  unpackVisibility,
} from './interior'

// The field and rows on their own (0069): rooms drawn as barriers and covers by hand.

const wall = (ax: number, az: number, bx: number, bz: number, top = 3): Barrier => ({
  ax,
  az,
  bx,
  bz,
  top,
  thickness: 0.2,
  field: true,
})

/** A room's four walls, [x0, x1] × [z0, z1], with a gap on its south side (z = z0) from g0 to g1. */
function room(x0: number, z0: number, x1: number, z1: number, gap?: [number, number]): Barrier[] {
  const out = [wall(x1, z0, x1, z1), wall(x1, z1, x0, z1), wall(x0, z1, x0, z0)]
  if (gap) {
    out.push(wall(x0, z0, gap[0], z0), wall(gap[1], z0, x1, z0))
  } else out.push(wall(x0, z0, x1, z0))
  return out
}

/** A grid over [-2, 14]² at `texel`. */
function grid(texel = 0.25): FieldGrid {
  const n = Math.round(16 / texel)
  return { ox: -2, oz: -2, texel, width: n, height: n }
}

function solve(
  g: FieldGrid,
  barriers: Barrier[],
  roof: [number, number][] | undefined,
  options: { coarse?: boolean; tolerance?: number; maxSweeps?: number } = {},
) {
  const layer = new FieldLayer(g.width, g.height)
  const all: TexelRect = { x0: 0, z0: 0, x1: g.width, z1: g.height }
  const scratch = new SolveScratch()
  if (roof) rasterCover(g, layer, { shape: floorShape(roof, 3), closed: [] }, all, 0, scratch)
  for (const b of barriers) rasterBarrier(g, layer, b, all)
  const report = solveRect(
    g,
    layer,
    all,
    { reach: 3, coarse: options.coarse ?? true, ...options },
    scratch,
  )
  packRect(g, layer, all, scratch)
  return { layer, report }
}

/** The packed visibility at the texel holding (x, z). */
function at(g: FieldGrid, layer: FieldLayer, x: number, z: number): number {
  const i = Math.floor((x - g.ox) / g.texel) + Math.floor((z - g.oz) / g.texel) * g.width
  return unpackVisibility(layer.packed[i]!)
}

/** Mean packed visibility over the texels whose centres are inside [x0, x1] × [z0, z1]. */
function mean(g: FieldGrid, layer: FieldLayer, x0: number, z0: number, x1: number, z1: number) {
  let sum = 0
  let n = 0
  for (let z = 0; z < g.height; z++)
    for (let x = 0; x < g.width; x++) {
      const cx = g.ox + (x + 0.5) * g.texel
      const cz = g.oz + (z + 0.5) * g.texel
      if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue
      sum += unpackVisibility(layer.packed[z * g.width + x]!)
      n++
    }
  return sum / n
}

const roofOver = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [
  [x0 - 0.5, z0 - 0.5],
  [x1 + 0.5, z0 - 0.5],
  [x1 + 0.5, z1 + 0.5],
  [x0 - 0.5, z1 + 0.5],
]

describe('sky visibility field', () => {
  it('is 0 in a sealed roofed room and 1 without its roof', () => {
    const g = grid()
    const sealed = solve(g, room(0, 0, 10, 10), roofOver(0, 0, 10, 10)).layer
    let max = 0
    for (let z = 0; z < g.height; z++)
      for (let x = 0; x < g.width; x++) {
        const cx = g.ox + (x + 0.5) * g.texel
        const cz = g.oz + (z + 0.5) * g.texel
        if (cx > 0 && cx < 10 && cz > 0 && cz < 10)
          max = Math.max(max, unpackVisibility(sealed.packed[z * g.width + x]!))
      }
    expect(max).toBe(0)
    const open = solve(g, room(0, 0, 10, 10), undefined).layer
    expect(mean(g, open, 0, 0, 10, 10)).toBe(1)
  })

  it('falls with path distance from a window, and a wider window lets in more', () => {
    const g = grid()
    const narrow = solve(g, room(0, 0, 10, 10, [4.5, 5.5]), roofOver(0, 0, 10, 10)).layer
    // Along the line straight in from the window, and around the corner of an inner wall.
    let last = 1
    for (let d = 0.25; d < 9.5; d += 0.5) {
      const v = at(g, narrow, 5, d)
      expect(v).toBeLessThanOrEqual(last + 1e-9)
      last = v
    }
    expect(at(g, narrow, 5, 0.3)).toBeGreaterThan(0.3)
    expect(at(g, narrow, 5, 9.6)).toBeLessThan(0.05)
    const wide = solve(g, room(0, 0, 10, 10, [4, 6]), roofOver(0, 0, 10, 10)).layer
    expect(mean(g, wide, 0, 0, 10, 10)).toBeGreaterThan(mean(g, narrow, 0, 0, 10, 10) * 1.3)
  })

  it('bends around a corner at a falling rate', () => {
    const g = grid()
    // A corridor: the window on the south side, a wall from (0, 4) to (7, 4) splitting the room.
    const walls = [...room(0, 0, 10, 10, [1, 3]), wall(0, 4, 7, 4)]
    const { layer } = solve(g, walls, roofOver(0, 0, 10, 10))
    // Behind the inner wall, light only arrives around its end at x = 7.
    const behind = at(g, layer, 2, 6)
    const front = at(g, layer, 2, 2)
    const corner = at(g, layer, 8.5, 6)
    expect(front).toBeGreaterThan(corner)
    expect(corner).toBeGreaterThan(behind)
    expect(behind).toBeGreaterThan(0)
  })

  it('matches a plain reference solve within 1/255', () => {
    const g = grid()
    const walls = [...room(0, 0, 10, 10, [4.5, 5.5]), wall(0, 5, 6, 5), wall(8, 0, 8, 3)]
    const fast = solve(g, walls, roofOver(0, 0, 10, 10))
    // The reference: Gauss-Seidel from nothing, no coarse pass, run until it stops moving.
    const reference = solve(g, walls, roofOver(0, 0, 10, 10), {
      coarse: false,
      tolerance: 1e-9,
      maxSweeps: 100_000,
    })
    let worst = 0
    for (let i = 0; i < fast.layer.packed.length; i++) {
      worst = Math.max(
        worst,
        Math.abs(
          unpackVisibility(fast.layer.packed[i]!) - unpackVisibility(reference.layer.packed[i]!),
        ),
      )
    }
    expect(worst).toBeLessThan(1 / 255)
    expect(fast.report.sweeps).toBeLessThan(reference.report.sweeps / 4)
  })
})

describe('light rows', () => {
  it('holds the nearest barrier per bin, with its top', () => {
    const barriers = [wall(2, -5, 2, 5, 3), wall(-1, -5, -1, 5, 1.2)]
    const out = new Uint32Array(64)
    buildRow(out, 0, 1.5, 0, 9, barriers, 2, new RowScratch())
    // Bin toward +x (angle 0): bins 32 (just above 0) — the wall at x = 2.
    const east = unpackBin(out[32]!)
    expect(east.distance).toBeCloseTo(2 + 0.05, 2)
    expect(east.top).toBeCloseTo(1.5, 2)
    // Toward −x: the low wall 1 m off, top 1.2 m (0.3 below the light).
    const west = unpackBin(out[0]!)
    expect(west.distance).toBeCloseTo(1.05, 1)
    expect(west.top).toBeCloseTo(-0.3, 2)
    // Out of range: nothing.
    const far = new Uint32Array(64)
    buildRow(far, 0, 1.5, 0, 0.5, barriers, 2, new RowScratch())
    expect(unpackBin(far[32]!).distance).toBe(Number.POSITIVE_INFINITY)
  })
})
