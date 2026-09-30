import { describe, expect, it } from 'vitest'
import { arcOf, pointAt, sampleWall } from './curve'
import { type PlanarOpening, type PlanarWall, planarBarriers } from './planar'

// Aether's structural barrier fixtures (packages/core/test/scene-structure.test.ts): a 300 px wall
// with a 70 px door at 80, closed and open, plus a window whose sight channel is open.

const wallA: PlanarWall = { id: 'wall-a', a: [0, 0], b: [300, 0] }

function door(overrides: Partial<PlanarOpening> = {}): PlanarOpening {
  return {
    id: 'door-a',
    wall: 'wall-a',
    kind: 'door',
    offset: 80,
    width: 70,
    state: 'closed',
    sight: 'normal',
    movement: 'normal',
    ...overrides,
  }
}

describe('planarBarriers', () => {
  it('matches Aether segment for segment with the door closed', () => {
    expect(planarBarriers([wallA], [door()])).toEqual([
      {
        id: 'struct:wall-a:0',
        sourceWallId: 'wall-a',
        a: [0, 0],
        b: [80, 0],
        sight: 'normal',
        movement: 'normal',
      },
      {
        id: 'struct-opening:door-a',
        sourceWallId: 'wall-a',
        openingId: 'door-a',
        a: [80, 0],
        b: [150, 0],
        sight: 'normal',
        movement: 'normal',
      },
      {
        id: 'struct:wall-a:150',
        sourceWallId: 'wall-a',
        a: [150, 0],
        b: [300, 0],
        sight: 'normal',
        movement: 'normal',
      },
    ])
  })

  it('opens both channels of an open door', () => {
    const open = planarBarriers([wallA], [door({ state: 'open' })])
    expect(open.find((s) => s.openingId === 'door-a')).toMatchObject({
      sight: 'none',
      movement: 'none',
    })
    expect(open).toHaveLength(3)
  })

  it('keeps a window blocking movement while its sight channel is open', () => {
    const window: PlanarOpening = {
      id: 'window-a',
      wall: 'wall-a',
      kind: 'window',
      offset: 200,
      width: 60,
      sight: 'none',
      movement: 'normal',
    }
    const segments = planarBarriers([wallA], [door(), window])
    expect(segments.map((s) => s.id)).toEqual([
      'struct:wall-a:0',
      'struct-opening:door-a',
      'struct:wall-a:150',
      'struct-opening:window-a',
      'struct:wall-a:260',
    ])
    expect(segments[3]).toMatchObject({
      a: [200, 0],
      b: [260, 0],
      sight: 'none',
      movement: 'normal',
    })
  })

  it('orders openings by offset, then id, and follows diagonal walls', () => {
    const diagonal: PlanarWall = { id: 'd', a: [0, 0], b: [30, 40] }
    const segments = planarBarriers(
      [diagonal],
      [
        door({ id: 'b', wall: 'd', offset: 10, width: 5 }),
        door({ id: 'a', wall: 'd', offset: 30, width: 10 }),
      ],
    )
    expect(segments.map((s) => s.id)).toEqual([
      'struct:d:0',
      'struct-opening:b',
      'struct:d:15',
      'struct-opening:a',
      'struct:d:40',
    ])
    expect(segments[1]!.a[0]).toBeCloseTo(6, 9)
    expect(segments[1]!.a[1]).toBeCloseTo(8, 9)
    expect(segments[4]!.b).toEqual([30, 40])
  })
})

describe('planarBarriers on curved walls', () => {
  const tower: PlanarWall = { id: 'tower', a: [0, 0], b: [6, 0], shape: 'arc', bow: 3 }
  const door: PlanarOpening = {
    id: 'door',
    wall: 'tower',
    kind: 'door',
    offset: 4,
    width: 1.2,
    state: 'closed',
    sight: 'normal',
    movement: 'normal',
  }

  it('places an opening at its arc-length offset along the curve', () => {
    const segments = planarBarriers([tower], [door])
    const opening = segments.filter((s) => s.openingId === 'door')
    const line = sampleWall(tower)
    const start = pointAt(line, 4, new Float64Array(4))
    const end = pointAt(line, 5.2, new Float64Array(4))
    expect(opening[0]!.a[0]).toBeCloseTo(start[0]!, 9)
    expect(opening[0]!.a[1]).toBeCloseTo(start[1]!, 9)
    expect(opening.at(-1)!.b[0]).toBeCloseTo(end[0]!, 9)
    expect(opening.at(-1)!.b[1]).toBeCloseTo(end[1]!, 9)
    // The first segment keeps the span's id; the rest count up.
    expect(opening.map((s) => s.id)).toEqual(
      opening.map((_, k) => (k === 0 ? 'struct-opening:door' : `struct-opening:door~${k}`)),
    )
  })

  it('splits at the points compile draws, and stays within the tolerance of the curve', () => {
    const tolerance = 0.01
    const segments = planarBarriers([tower], [], { tolerance })
    const line = sampleWall(tower, tolerance)
    expect(segments).toHaveLength(line.count - 1)
    for (let i = 0; i < segments.length; i++) {
      expect(segments[i]!.a).toEqual([line.x[i], line.z[i]])
      expect(segments[i]!.b).toEqual([line.x[i + 1], line.z[i + 1]])
    }
    // Every point of the true arc is within the tolerance of a segment.
    const arc = arcOf(tower)!
    for (let k = 0; k <= 1000; k++) {
      const a = arc.from + (arc.sweep * k) / 1000
      const x = arc.cx + arc.r * Math.cos(a)
      const z = arc.cz + arc.r * Math.sin(a)
      let best = Infinity
      for (const s of segments) {
        const dx = s.b[0] - s.a[0]
        const dz = s.b[1] - s.a[1]
        const t = Math.max(
          0,
          Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / (dx * dx + dz * dz)),
        )
        best = Math.min(best, Math.hypot(x - s.a[0] - dx * t, z - s.a[1] - dz * t))
      }
      expect(best).toBeLessThanOrEqual(tolerance + 1e-9)
    }
  })
})
