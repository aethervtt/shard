// The 0112 test town: 64 m cells of box-collider buildings, at two levels.
// `full`: walls with colliders and NavSource, interior walls, props, a door and a crate.
// `far`: the same outer wall paths (shells, no colliders), nothing inside.
// `test/TownLoot` (the secrets generator) fills each crate's `test/Contents` from the secret seed.

// Engine-light on purpose: worker bundles import it. Fragments name physics/Collider and
// nav/NavSource by string; apps that spawn them import ./engine-components.

import { defineComponent, Rng, t } from '@aethervtt/shard-core'
import { defineGenerator, type FragmentEntity } from '@aethervtt/shard-procgen'
import { cellParams, definePartition } from '../partition'

export const Prop = defineComponent('test/Prop', { kind: t.u8() })
export const Container = defineComponent('test/Container', { capacity: t.u8({ default: 8 }) })
export const Contents = defineComponent('test/Contents', { items: t.list(t.string()) })
export const Door = defineComponent('test/Door', { open: t.bool() })
export const Shell = defineComponent('test/Shell', {})

const CELL = 64

function box(
  name: string,
  at: [number, number, number],
  half: [number, number, number],
  solid: boolean,
): FragmentEntity {
  const components: Record<string, Record<string, unknown>> = {
    'core/Transform': { translation: at },
  }
  if (solid) {
    components['physics/Collider'] = { shape: 'cuboid', halfExtents: half }
    components['nav/NavSource'] = {}
  } else components['test/Shell'] = {}
  return { name, components }
}

export const TownCell = defineGenerator('test/TownCell', {
  params: {
    ...cellParams(['full', 'far']),
    buildings: t.u8({ default: 4, max: 4 }),
    props: t.u16({ default: 6, max: 2000 }),
  },
  output: 'entities',
  deterministicMath: true,
  run(ctx, p) {
    const rng = new Rng(ctx.childSeed(`${p.x},${p.z}`))
    const full = p.level === 'full'
    const out: FragmentEntity[] = [
      {
        name: 'ground',
        components: {
          'core/Transform': { translation: [p.x * CELL + CELL / 2, -0.5, p.z * CELL + CELL / 2] },
          ...(full
            ? { 'physics/Collider': { shape: 'cuboid', halfExtents: [CELL / 2, 0.5, CELL / 2] } }
            : { 'test/Shell': {} }),
        },
      },
    ]
    for (let i = 0; i < p.buildings; i++) {
      const w = rng.int(5, 7)
      const d = rng.int(5, 7)
      const cx = p.x * CELL + 16 + (i % 2) * 32
      const cz = p.z * CELL + 16 + Math.floor(i / 2) * 32
      const children: FragmentEntity[] = [
        box('n', [cx, 1.5, cz - d], [w, 1.5, 0.1], full),
        box('s', [cx, 1.5, cz + d], [w, 1.5, 0.1], full),
        box('e', [cx + w, 1.5, cz], [0.1, 1.5, d], full),
        box('w', [cx - w, 1.5, cz], [0.1, 1.5, d], full),
      ]
      if (full) {
        children.push(box('inner', [cx, 1.5, cz], [0.1, 1.5, d * 0.5], true))
        children.push({
          name: 'door',
          components: { 'core/Transform': { translation: [cx, 1, cz + d] }, 'test/Door': {} },
        })
        children.push({
          name: 'crate',
          components: {
            'core/Transform': { translation: [cx + w * 0.5, 0.5, cz] },
            'test/Container': { capacity: rng.int(4, 12) },
          },
        })
        for (let k = 0; k < p.props; k++) {
          children.push({
            name: `prop-${k}`,
            components: {
              'core/Transform': {
                translation: [cx + rng.range(-w, w) * 0.8, 0.25, cz + rng.range(-d, d) * 0.8],
              },
              'test/Prop': { kind: rng.int(0, 9) },
            },
          })
        }
      }
      out.push({ name: `b${i}`, components: { 'core/Transform': {} }, children })
    }
    return out
  },
})

const LOOT = ['beans', 'axe', 'bandage', 'water', 'nails', 'hammer']

/** The crate contents: from the secret seed, so clients can't compute them. */
export const TownLoot = defineGenerator('test/TownLoot', {
  params: { ...cellParams(['full', 'far']), buildings: t.u8({ default: 4, max: 4 }), props: t.u16() },
  output: 'data',
  deterministicMath: true,
  run(ctx, p) {
    const rng = new Rng(ctx.childSeed(`loot:${p.x},${p.z}`))
    const out: Record<string, unknown> = {}
    for (let i = 0; i < p.buildings; i++) {
      const items: string[] = []
      const n = rng.int(1, 4)
      for (let k = 0; k < n; k++) items.push(LOOT[rng.int(0, LOOT.length - 1)]!)
      out[`b${i}/crate`] = { 'test/Contents': { items } }
    }
    return out as never
  },
})

export interface TownOptions {
  name?: string
  levels?: { name: string; range: number }[]
  simulate?: number
  replicate?: { range?: number; bands?: { within: number; every: number }[] }
  buildings?: number
  props?: number
  secrets?: boolean
}

/** Defines a partition over the test town (default name `test-town`). */
export function defineTown(options: TownOptions = {}): string {
  return definePartition(options.name ?? 'test-town', {
    grids: [
      {
        name: 'town',
        cellSize: CELL,
        generator: TownCell,
        params: { buildings: options.buildings ?? 4, props: options.props ?? 6 },
        levels: options.levels ?? [
          { name: 'full', range: 96 },
          { name: 'far', range: 512 },
        ],
        simulate: options.simulate ?? 160,
        replicate: options.replicate ?? {
          range: 160,
          bands: [
            { within: 48, every: 1 },
            { within: 96, every: 2 },
            { within: 160, every: 4 },
          ],
        },
        secrets:
          options.secrets === false
            ? undefined
            : { generator: TownLoot, components: ['test/Contents'] },
      },
    ],
  })
}
