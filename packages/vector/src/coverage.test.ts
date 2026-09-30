import { describe, expect, it } from 'vitest'
import { type CoverageMesh, featheredCoverage } from './coverage'

/** Coverage at a point as fog applies a region: the first triangle there wins (cores first). */
function coverageAt(mesh: CoverageMesh, x: number, z: number): number {
  const p = mesh.positions
  const c = mesh.coverage
  const idx = mesh.indices
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]!
    const b = idx[i + 1]!
    const d = idx[i + 2]!
    const ax = p[a * 2]!
    const az = p[a * 2 + 1]!
    const bx = p[b * 2]!
    const bz = p[b * 2 + 1]!
    const dx = p[d * 2]!
    const dz = p[d * 2 + 1]!
    const det = (bz - dz) * (ax - dx) + (dx - bx) * (az - dz)
    if (Math.abs(det) < 1e-12) continue
    const l1 = ((bz - dz) * (x - dx) + (dx - bx) * (z - dz)) / det
    const l2 = ((dz - az) * (x - dx) + (ax - dx) * (z - dz)) / det
    const l3 = 1 - l1 - l2
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
    return l1 * c[a]! + l2 * c[b]! + l3 * c[d]!
  }
  return 0
}

function area(mesh: CoverageMesh, from: number, to: number): number {
  const p = mesh.positions
  let total = 0
  for (let i = from; i < to; i += 3) {
    const [a, b, c] = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!]
    total +=
      Math.abs(
        (p[b * 2]! - p[a * 2]!) * (p[c * 2 + 1]! - p[a * 2 + 1]!) -
          (p[c * 2]! - p[a * 2]!) * (p[b * 2 + 1]! - p[a * 2 + 1]!),
      ) / 2
  }
  return total
}

describe('feathered coverage (0058)', () => {
  it('fills a rectangle at full coverage and ramps linearly to 0 across the feather', () => {
    const mesh = featheredCoverage({ kind: 'rect', x: 0, y: 0, w: 4, h: 2 }, { feather: 1 })
    expect(area(mesh, 0, mesh.coreIndices)).toBeCloseTo(8, 6)
    // Ring: the four sides plus a quarter disk at each corner.
    // (Arcs are chords within the error, a little inside the true circle.)
    expect(area(mesh, mesh.coreIndices, mesh.indices.length)).toBeCloseTo(12 + Math.PI, 1)
    expect(coverageAt(mesh, 2, 1)).toBe(1)
    expect(coverageAt(mesh, 2, -0.5)).toBeCloseTo(0.5, 6)
    expect(coverageAt(mesh, 4.25, 1)).toBeCloseTo(0.75, 6)
    expect(coverageAt(mesh, 2, -1.01)).toBe(0)
    // Round at a corner: 0.5 at half the feather out along the diagonal.
    const d = 0.5 / Math.SQRT2
    expect(coverageAt(mesh, 4 + d, 2 + d)).toBeCloseTo(0.5, 2)
  })

  it('feathers into holes, whatever the rings’ winding', () => {
    const outer: [number, number][] = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
    ] // clockwise: normalized
    const hole: [number, number][] = [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
    ] // counter-clockwise: normalized
    const mesh = featheredCoverage({ kind: 'polygon', outer, holes: [hole] }, { feather: 1 })
    expect(area(mesh, 0, mesh.coreIndices)).toBeCloseTo(100 - 16, 6)
    expect(coverageAt(mesh, 1, 1)).toBe(1)
    expect(coverageAt(mesh, 5, 5)).toBe(0)
    expect(coverageAt(mesh, 5, 3.5)).toBeCloseTo(0.5, 6)
    expect(coverageAt(mesh, -0.5, 5)).toBeCloseTo(0.5, 6)
  })

  it('makes a hard edge without a feather', () => {
    const mesh = featheredCoverage({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, { feather: 0 })
    expect(mesh.coreIndices).toBe(mesh.indices.length)
    expect(coverageAt(mesh, 0.5, 0.5)).toBe(1)
    expect(coverageAt(mesh, 1.001, 0.5)).toBe(0)
  })

  it('draws a brush as capsules of its radius, with round joins, caps and feather', () => {
    const points: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 4],
    ]
    const mesh = featheredCoverage({ kind: 'brush', points, radius: 0.5 }, { feather: 0.5 })
    expect(coverageAt(mesh, 2, 0.3)).toBe(1)
    expect(coverageAt(mesh, 2, 0.75)).toBeCloseTo(0.5, 6)
    expect(coverageAt(mesh, 2, -0.75)).toBeCloseTo(0.5, 6)
    expect(coverageAt(mesh, 2, 1.1)).toBe(0)
    // The round cap at the start and the outer side of the corner.
    expect(coverageAt(mesh, -0.75, 0)).toBeCloseTo(0.5, 2)
    const d = 0.75 / Math.SQRT2
    expect(coverageAt(mesh, 4 + d, -d)).toBeCloseTo(0.5, 2)
    // A single point is a disk.
    const dot = featheredCoverage({ kind: 'brush', points: [[1, 1]], radius: 1 }, { feather: 1 })
    expect(coverageAt(dot, 1, 1)).toBe(1)
    expect(coverageAt(dot, 2.5, 1)).toBeCloseTo(0.5, 2)
  })

  it('simplifies rings and brush paths within the tolerance, and keeps every point without one', () => {
    const circle: [number, number][] = []
    for (let k = 0; k < 1000; k++) {
      const a = (k / 1000) * Math.PI * 2
      circle.push([Math.cos(a) * 0.4, Math.sin(a) * 0.4])
    }
    const full = featheredCoverage({ kind: 'polygon', outer: circle }, { feather: 0 })
    expect(full.coverage.length).toBe(1000)
    const tolerance = 0.05 / 255
    const simple = featheredCoverage({ kind: 'polygon', outer: circle }, { feather: 0, tolerance })
    // A chord error of t at radius r needs π / acos(1 − t / r) points: about 100 here.
    const needed = Math.PI / Math.acos(1 - tolerance / 0.4)
    expect(simple.coverage.length).toBeLessThan(needed * 1.5)
    expect(simple.coverage.length).toBeGreaterThan(needed * 0.5)
    // Every dropped point is within the tolerance of the simplified outline.
    const kept = simple.positions
    const n = simple.coverage.length
    let worst = 0
    for (const [x, z] of circle) {
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < n; i++) {
        const ax = kept[i * 2]!
        const az = kept[i * 2 + 1]!
        const bx = kept[((i + 1) % n) * 2]!
        const bz = kept[((i + 1) % n) * 2 + 1]!
        const cx = bx - ax
        const cz = bz - az
        const t = Math.max(0, Math.min(1, ((x - ax) * cx + (z - az) * cz) / (cx * cx + cz * cz)))
        best = Math.min(best, Math.hypot(x - ax - t * cx, z - az - t * cz))
      }
      worst = Math.max(worst, best)
    }
    expect(worst).toBeLessThanOrEqual(tolerance * 1.0001)
    // A straight brush stroke drawn with many points is two points' worth of capsules.
    const line: [number, number][] = []
    for (let k = 0; k <= 200; k++) line.push([k * 0.01, 0])
    const dense = featheredCoverage({ kind: 'brush', points: line, radius: 0.1 }, { feather: 0 })
    const sparse = featheredCoverage(
      { kind: 'brush', points: line, radius: 0.1 },
      { feather: 0, tolerance: 0.001 },
    )
    expect(sparse.indices.length).toBeLessThan(dense.indices.length / 10)
    expect(coverageAt(sparse, 1, 0.05)).toBeCloseTo(1, 6)
  })

  it('tessellates a multipolygon as each polygon', () => {
    const square = (x: number): [number, number][] => [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 1],
    ]
    const mesh = featheredCoverage(
      { kind: 'multipolygon', polygons: [{ outer: square(0) }, { outer: square(5) }] },
      { feather: 0 },
    )
    expect(area(mesh, 0, mesh.coreIndices)).toBeCloseTo(2, 6)
    expect(coverageAt(mesh, 5.5, 0.5)).toBe(1)
    expect(coverageAt(mesh, 3, 0.5)).toBe(0)
  })
})
