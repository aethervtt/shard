import { describe, expect, it } from 'vitest'
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
