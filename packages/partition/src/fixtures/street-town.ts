// 0116's street town: 64 m cells along 12 m streets, each with two rows of one- and two-storey
// houses (roofed, a front door and windows), as a Zomboid-like town is seen from street level.
// `full`: everything. `far`: the same outer walls and roofs, as structure/Backdrop shells.

import { Rng } from '@aethervtt/shard-core'
import { defineGenerator, type FragmentEntity } from '@aethervtt/shard-procgen'
import { cellParams, definePartition } from '../partition'

const CELL = 64
/** The street runs along x on each cell's low-z side; houses front onto it. */
const STREET = 12
/** Where each row of houses starts along z, from the cell's corner. */
const ROWS = [STREET + 2, STREET + 28] as const

export const StreetTownCell = defineGenerator('test/StreetTownCell', {
  params: { ...cellParams(['full', 'far']) },
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
    let n = 0
    for (const row of ROWS) {
      let x = x0 + 1
      while (true) {
        const w = rng.int(9, 13)
        const d = rng.int(8, 11)
        if (x + w > x0 + CELL - 1) break
        const bz = z0 + row
        const h = rng.float() < 0.5 ? 6 : 3
        const name = `h${n++}`
        const wall = (id: string, a: number[], b: number[]): FragmentEntity => ({
          name: id,
          components: { 'structure/Wall': { a, b, height: h, thickness: 0.2 }, ...backdrop },
        })
        const children: FragmentEntity[] = [
          wall('front', [x, bz], [x + w, bz]),
          wall('back', [x + w, bz + d], [x, bz + d]),
          wall('left', [x, bz + d], [x, bz]),
          wall('right', [x + w, bz], [x + w, bz + d]),
          {
            name: 'roof',
            components: {
              'structure/Roof': {
                points: [
                  [x, bz],
                  [x + w, bz],
                  [x + w, bz + d],
                  [x, bz + d],
                ],
                height: h,
                pitch: 0.4,
                shadowWhenHidden: true,
              },
              ...backdrop,
            },
          },
        ]
        if (full) {
          const opening = (id: string, host: string, offset: number, kind: 'door' | 'window') => ({
            name: id,
            components: {
              'structure/Opening':
                kind === 'door'
                  ? { wall: `${name}/${host}`, kind, offset, width: 1, height: 2.1 }
                  : { wall: `${name}/${host}`, kind, offset, width: 1.2, height: 1.2, sill: 0.9 },
            },
          })
          children.push(
            opening('door', 'front', 1, 'door'),
            opening('window', 'front', w - 2.5, 'window'),
            opening('window-left', 'left', d / 2 - 0.6, 'window'),
            opening('window-back', 'back', w / 2 - 0.6, 'window'),
          )
        }
        out.push({ name, components: { 'core/Transform': {} }, children })
        x += w + rng.int(3, 6)
      }
    }
    return out
  },
})

/** A partition over the street town; `far` reaches `far` meters (512 in the scenario). */
export function defineStreetTown(name = 'street-town', far = 256): string {
  return definePartition(name, {
    grids: [
      {
        name: 'town',
        cellSize: CELL,
        generator: StreetTownCell,
        params: {},
        levels: [
          { name: 'full', range: 96 },
          { name: 'far', range: far },
        ],
        simulate: 96,
      },
    ],
  })
}

/** The middle of the street of cell (x, z), at eye height: where the walk goes. */
export function streetAt(x: number, z: number, height = 2.6): [number, number, number] {
  return [x * CELL, height, z * CELL + STREET / 2]
}

