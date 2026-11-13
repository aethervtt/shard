// The 0113 structure town: 64 m cells of real structure buildings (0055, 0112) and a ground floor.
// `full`: walls, a front door and a window per building, an inner wall with a door, the floor.
// `far`: the same outer walls and floor, as structure/Backdrop (drawn, no colliders, no nav).

import { Rng, t } from '@aethervtt/shard-core'
import { defineGenerator, type FragmentEntity } from '@aethervtt/shard-procgen'
import { cellParams, definePartition } from '../partition'

const CELL = 64

export const StructureTownCell = defineGenerator('test/StructureTownCell', {
  params: { ...cellParams(['full', 'far']), buildings: t.u8({ default: 4, max: 4 }) },
  output: 'entities',
  deterministicMath: true,
  run(ctx, p) {
    const rng = new Rng(ctx.childSeed(`${p.x},${p.z}`))
    const full = p.level === 'full'
    const backdrop: Record<string, Record<string, unknown>> = full ? {} : { 'structure/Backdrop': {} }
    const x0 = p.x * CELL
    const z0 = p.z * CELL
    const out: FragmentEntity[] = [
      {
        name: 'ground',
        components: {
          'structure/Floor': {
            points: [
              [x0, z0],
              [x0 + CELL, z0],
              [x0 + CELL, z0 + CELL],
              [x0, z0 + CELL],
            ],
          },
          ...backdrop,
        },
      },
    ]
    for (let i = 0; i < p.buildings; i++) {
      const w = rng.int(8, 12)
      const d = rng.int(7, 10)
      const bx = x0 + 6 + (i % 2) * 32
      const bz = z0 + 6 + Math.floor(i / 2) * 32
      const wall = (name: string, a: number[], b: number[]): FragmentEntity => ({
        name,
        components: { 'structure/Wall': { a, b, height: 3, thickness: 0.2 }, ...backdrop },
      })
      const children: FragmentEntity[] = [
        wall('front', [bx, bz], [bx + w, bz]),
        wall('back', [bx + w, bz + d], [bx, bz + d]),
        wall('left', [bx, bz + d], [bx, bz]),
        wall('right', [bx + w, bz], [bx + w, bz + d]),
      ]
      if (full) {
        const name = `b${i}`
        children.push(
          {
            name: 'door',
            components: {
              'structure/Opening': {
                wall: `${name}/front`,
                kind: 'door',
                offset: 1,
                width: 1,
                height: 2.1,
              },
            },
          },
          {
            name: 'window',
            components: {
              'structure/Opening': {
                wall: `${name}/left`,
                kind: 'window',
                offset: d / 2 - 0.6,
                width: 1.2,
                height: 1.2,
                sill: 0.9,
              },
            },
          },
          wall('inner', [bx + w / 2, bz], [bx + w / 2, bz + d]),
          {
            name: 'inner-door',
            components: {
              'structure/Opening': {
                wall: `${name}/inner`,
                kind: 'door',
                offset: d / 2 - 0.5,
                width: 1,
                height: 2.1,
              },
            },
          },
        )
      }
      out.push({ name: `b${i}`, components: { 'core/Transform': {} }, children })
    }
    return out
  },
})

/** A partition over the structure town (small rings: its nav tiles build inline in tests). */
export function defineStructureTown(name = 'structure-town'): string {
  return definePartition(name, {
    grids: [
      {
        name: 'town',
        cellSize: CELL,
        generator: StructureTownCell,
        params: { buildings: 4 },
        levels: [
          { name: 'full', range: 64 },
          { name: 'far', range: 256 },
        ],
        simulate: 96,
      },
    ],
  })
}
