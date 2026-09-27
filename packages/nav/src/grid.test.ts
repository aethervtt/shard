import { budget } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import {
  DIAGONAL_ALWAYS,
  DIAGONAL_NEVER,
  DIAGONAL_NO_CORNERS,
  GridSearch,
  gridTrace,
  NavGridData,
  nearestWalkable,
  smoothGridPath,
} from './grid'
import { maze, rng } from './test-maze'

const median = (t: number[]) => [...t].sort((a, b) => a - b)[t.length >> 1]!

/** Reference: plain Dijkstra with the same move rules and costs, no heuristic, no cleverness. */
function dijkstra(
  grid: NavGridData,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  diagonal: number,
): number {
  const w = grid.width
  const dist = new Float64Array(w * grid.height).fill(Infinity)
  const done = new Uint8Array(w * grid.height)
  const open: number[] = [sy * w + sx]
  dist[sy * w + sx] = 0
  const dirs =
    diagonal === DIAGONAL_NEVER
      ? [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ]
  while (open.length > 0) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (dist[open[i]!]! < dist[open[bi]!]!) bi = i
    const cur = open[bi]!
    open[bi] = open[open.length - 1]!
    open.pop()
    if (done[cur]) continue
    done[cur] = 1
    if (cur === gy * w + gx) return dist[cur]!
    const x = cur % w
    const y = (cur - x) / w
    for (const [dx, dy] of dirs) {
      const nx = x + dx!
      const ny = y + dy!
      const c = grid.get(nx, ny)
      if (c === 0) continue
      if (dx !== 0 && dy !== 0 && diagonal === DIAGONAL_NO_CORNERS) {
        if (grid.get(nx, y) === 0 || grid.get(x, ny) === 0) continue
      }
      const d = dist[cur]! + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * c
      if (d < dist[ny * w + nx]!) {
        dist[ny * w + nx] = d
        open.push(ny * w + nx)
      }
    }
  }
  return Infinity
}

/** Cost of a cell path under the search's rules, recomputed from the cells. */
function pathCost(grid: NavGridData, cells: Int32Array, count: number): number {
  let cost = 0
  for (let i = 1; i < count; i++) {
    const a = cells[i - 1]!
    const b = cells[i]!
    const diag = a % grid.width !== b % grid.width && Math.abs(a - b) !== 1
    cost += (diag ? Math.SQRT2 : 1) * grid.costs[b]!
  }
  return cost
}

function open(grid: NavGridData, random: () => number): [number, number] {
  for (;;) {
    const x = Math.floor(random() * grid.width)
    const y = Math.floor(random() * grid.height)
    if (grid.get(x, y) > 0) return [x, y]
  }
}

describe('grid A*', () => {
  it('finds the optimal path on a 256×256 maze, matching Dijkstra', () => {
    const grid = maze(256, 7)
    const search = new GridSearch()
    const random = rng(3)
    for (const diagonal of [DIAGONAL_NO_CORNERS, DIAGONAL_NEVER, DIAGONAL_ALWAYS]) {
      for (let k = 0; k < 6; k++) {
        const [sx, sy] = open(grid, random)
        const [gx, gy] = open(grid, random)
        expect(search.search(grid, sx, sy, gx, gy, diagonal)).toBe(true)
        const reference = dijkstra(grid, sx, sy, gx, gy, diagonal)
        expect(search.cost).toBeCloseTo(reference, 6)
        expect(pathCost(grid, search.cells, search.count)).toBeCloseTo(reference, 6)
        expect(search.cells[0]).toBe(sy * 256 + sx)
        expect(search.cells[search.count - 1]).toBe(gy * 256 + gx)
      }
    }
  })

  it('never cuts a blocked corner with no-corners, and does with always', () => {
    // . #
    // . .   from (0, 1) to (1, 0): diagonal passes the blocked (1, 1) corner.
    const grid = new NavGridData(2, 2, new Uint8Array([1, 1, 1, 0]))
    const search = new GridSearch()
    search.search(grid, 0, 1, 1, 0, DIAGONAL_NO_CORNERS)
    expect(search.count).toBe(3)
    search.search(grid, 0, 1, 1, 0, DIAGONAL_ALWAYS)
    expect(search.count).toBe(2)
  })

  it('leads to the closest reachable cell when the goal is walled off', () => {
    const grid = new NavGridData(5, 1, new Uint8Array([1, 1, 0, 1, 1]))
    const search = new GridSearch()
    expect(search.search(grid, 0, 0, 4, 0, DIAGONAL_NO_CORNERS)).toBe(false)
    expect(search.reached).toBe(false)
    expect(search.cells[search.count - 1]).toBe(1)
  })

  it('searches a 256×256 maze in under 2 ms without allocating after warm-up', async () => {
    const grid = maze(256, 11)
    const search = new GridSearch()
    const random = rng(5)
    // Long queries: corner to corner through the maze.
    const pairs: [number, number, number, number][] = []
    for (let k = 0; k < 20; k++) {
      const [sx, sy] = open(grid, random)
      const [gx, gy] = open(grid, random)
      pairs.push([sx, sy, gx, gy])
    }
    pairs.push([1, 1, 253, 253])
    for (let r = 0; r < 20; r++) for (const p of pairs) search.search(grid, ...p, 0)
    globalThis.gc?.()
    await new Promise((r) => setTimeout(r, 200))
    let collections = 0
    const observer = new PerformanceObserver((list) => {
      collections += list.getEntries().length
    })
    observer.observe({ entryTypes: ['gc'] })
    const times = new Float64Array(10 * pairs.length)
    const out = new Float32Array(2 * 512)
    const ends = new Float64Array(4)
    for (let r = 0; r < 10; r++) {
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i]!
        const t0 = performance.now()
        search.search(grid, p[0], p[1], p[2], p[3], DIAGONAL_NO_CORNERS)
        for (let k = 0; k < 4; k++) ends[k] = p[k]! + 0.5
        smoothGridPath(grid, search.cells, search.count, ends, DIAGONAL_NO_CORNERS, out, 2, 512)
        times[r * pairs.length + i] = performance.now() - t0
      }
    }
    await new Promise((r) => setTimeout(r, 50))
    observer.disconnect()
    expect(collections).toBe(0)
    expect(median([...times])).toBeLessThan(budget(2))
    // The corner-to-corner query explores most of the maze: hold it to the budget too.
    expect(
      Math.min(...[...times].filter((_, i) => i % pairs.length === pairs.length - 1)),
    ).toBeLessThan(budget(2))
  })
})

describe('grid smoothing and traces', () => {
  it('pulls a staircase in an open room into one straight segment', () => {
    const grid = new NavGridData(20, 20)
    const search = new GridSearch()
    search.search(grid, 0, 0, 19, 7, DIAGONAL_NEVER)
    const out = new Float32Array(64)
    const ends = new Float64Array([0.5, 0.5, 19.5, 7.5])
    const n = smoothGridPath(grid, search.cells, search.count, ends, 1, out, 2, 32)
    expect(n).toBe(2)
    expect([out[2], out[3]]).toEqual([19.5, 7.5])
  })

  it('bends around a wall at its end', () => {
    // A wall at x = 5 from y = 0 to 8; go from (2, 2) to (8, 2).
    const grid = new NavGridData(12, 12)
    for (let y = 0; y <= 8; y++) grid.set(5, y, 0)
    const search = new GridSearch()
    search.search(grid, 2, 2, 8, 2, DIAGONAL_NO_CORNERS)
    const out = new Float32Array(64)
    const ends = new Float64Array([2.5, 2.5, 8.5, 2.5])
    const n = smoothGridPath(grid, search.cells, search.count, ends, 0, out, 2, 32)
    expect(n).toBeGreaterThanOrEqual(3)
    expect(n).toBeLessThanOrEqual(4)
    // Every corner between the ends goes over the wall's top.
    for (let i = 1; i < n - 1; i++) expect(out[i * 2 + 1]!).toBeGreaterThan(8.9)
    for (let i = 1; i < n; i++) {
      expect(
        gridTrace(grid, out[i * 2 - 2]!, out[i * 2 - 1]!, out[i * 2]!, out[i * 2 + 1]!, 0, 255),
      ).toBe(true)
    }
  })

  it('traces to the first blocked cell', () => {
    const grid = new NavGridData(10, 1)
    grid.set(6, 0, 0)
    const hit = { t: 0, x: 0, y: 0 }
    expect(gridTrace(grid, 0.5, 0.5, 9.5, 0.5, 0, 255, hit)).toBe(false)
    expect(hit.t).toBeCloseTo(5.5 / 9, 6)
    expect(hit.x).toBeCloseTo(6, 6)
  })

  it('finds the nearest walkable cell', () => {
    const grid = new NavGridData(9, 9, new Uint8Array(81))
    grid.set(7, 4, 1)
    grid.set(4, 1, 1)
    expect(nearestWalkable(grid, 4.5, 4.5, 8)).toBe(1 * 9 + 4)
    expect(nearestWalkable(grid, 6.9, 4.5, 8)).toBe(4 * 9 + 7)
    expect(nearestWalkable(grid, 4.5, 4.5, 2)).toBe(-1)
  })
})
