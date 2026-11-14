// 0073's dressed town: Risen's shape on 0116's street town. 64 m cells along 12 m streets, each
// with two rows of houses (walls, a front door and windows, a roof) and a yard. Fragments carry no
// render handles: a client system dresses `test/Dress` entities with meshes and runtime materials
// after commit, as Risen's `risen/Dress` does. `full`: everything, and a room inside each house
// with a sofa. `far` (drawn by proxies): the outside only, the same paths, as structure/Backdrop.

import {
  type AssetRef,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  Rng,
  t,
  type World,
} from '@aethervtt/shard-core'
import { box } from '@aethervtt/shard-mesh'
import { cellParams, definePartition } from '@aethervtt/shard-partition'
import { defineGenerator, type FragmentEntity } from '@aethervtt/shard-procgen'
import { MaterialAsset, Materials, Mesh3d, Meshes, MeshMaterial } from '@aethervtt/shard-render'

export const CELL = 64
const STREET = 12
const ROWS = [STREET + 2, STREET + 28] as const

/** What the client draws here: a box kind and a colour, by name (no handles in fragments). */
export const Dress = defineComponent(
  'test/Dress',
  {
    kind: t.enum(['trim', 'mailbox', 'sofa']),
    color: t.string({ description: 'A hex colour: the runtime material is made from it.' }),
  },
  { description: 'A mesh the client makes and draws on this entity (0073 fixture).' },
)

const SIZES = { trim: [1, 0.3, 0.25], mailbox: [0.3, 1.1, 0.3], sofa: [2, 0.8, 0.9] } as const

export const DressedTownCell = defineGenerator('test/DressedTownCell', {
  params: {
    ...cellParams(['full', 'far']),
    rows: t.u8({ default: 2, description: 'Rows of houses per cell (1 or 2).' }),
    gap: t.f32({ default: 3, description: 'Least gap between houses in a row (m).' }),
  },
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
    for (const row of ROWS.slice(0, p.rows)) {
      let x = x0 + 1
      while (true) {
        const w = rng.int(9, 13)
        const d = rng.int(8, 11)
        if (x + w > x0 + CELL - 1) break
        const bz = z0 + row
        const h = rng.float() < 0.5 ? 6 : 3
        const name = `h${n++}`
        const paint = ['#9a6b4f', '#7c8a96', '#b8a07a'][rng.int(0, 2)]!
        const wall = (id: string, a: number[], b: number[]): FragmentEntity => ({
          name: id,
          components: { 'structure/Wall': { a, b, height: h, thickness: 0.2 }, ...backdrop },
        })
        const opening = (id: string, host: string, offset: number, kind: 'door' | 'window') => ({
          name: id,
          components: {
            'structure/Opening':
              kind === 'door'
                ? { wall: `${name}/${host}`, kind, offset, width: 1, height: 2.1 }
                : { wall: `${name}/${host}`, kind, offset, width: 1.2, height: 1.2, sill: 0.9 },
          },
        })
        const dress = (
          id: string,
          kind: keyof typeof SIZES,
          at: number[],
          color: string,
          scale: readonly number[] = SIZES[kind],
        ) => ({
          name: id,
          components: {
            'core/Transform': { translation: at, scale: [...scale] },
            'test/Dress': { kind, color },
          },
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
          opening('door', 'front', 1, 'door'),
          opening('window', 'front', w - 2.5, 'window'),
          opening('window-left', 'left', d / 2 - 0.6, 'window'),
          opening('window-back', 'back', w / 2 - 0.6, 'window'),
          // The outside: trim along the front's top and a mailbox in the yard, at both levels.
          dress('trim', 'trim', [x + w / 2, h - 0.2, bz - 0.2], paint, [w, 0.3, 0.25]),
          dress('mailbox', 'mailbox', [x + 1.5, 0.55, bz - 1.5], '#d0d0d0'),
        ]
        if (full)
          children.push(
            wall('inner', [x + w / 2, bz], [x + w / 2, bz + d]),
            dress('sofa', 'sofa', [x + w / 4, 0.4, bz + d / 2], '#5a3f6e'),
          )
        out.push({ name, components: { 'core/Transform': {} }, children })
        x += w + p.gap + rng.int(0, 3)
      }
    }
    return out
  },
})

/**
 * A partition over the dressed town: `full` to 96 m, `far` drawn by proxies to `far` m. `rows` 1
 * and `gap` 18 give Risen's density: about 150 houses in the 84 far cells at 320 m.
 */
export function defineDressedTown(
  name = 'dressed-town',
  far = 320,
  density: { rows?: number; gap?: number } = {},
): string {
  return definePartition(name, {
    grids: [
      {
        name: 'town',
        cellSize: CELL,
        generator: DressedTownCell,
        params: { rows: density.rows ?? 2, gap: density.gap ?? 3 },
        levels: [
          { name: 'full', range: 96 },
          { name: 'far', range: far, proxy: true },
        ],
        simulate: 96,
      },
    ],
  })
}

/** The middle of the street of cell (x, z), at eye height. */
export function streetAt(x: number, z: number, height = 2.6): [number, number, number] {
  return [x * CELL, height, z * CELL + STREET / 2]
}

/** The client's boxes and runtime materials, made once each. */
const DressAssets = defineResource<{
  meshes: Map<string, AssetRef<'Mesh'>>
  materials: Map<string, AssetRef<'Material'>>
}>('test/DressAssets', { init: () => ({ meshes: new Map(), materials: new Map() }) })

function hex(color: string): [number, number, number, number] {
  const v = Number.parseInt(color.slice(1), 16)
  const c = (k: number) => ((v >> k) & 255) / 255
  return [c(16), c(8), c(0), 1]
}

/** Client: gives every `test/Dress` entity its mesh and material once its cell commits. */
export const dressTown = defineSystem({
  name: 'test/dress-town',
  description: 'Dresses the 0073 fixture town (client).',
  setup: (world) => world.query({ with: [Dress], without: [Mesh3d] }),
  run(query, world) {
    const todo = query.entities()
    if (todo.length === 0) return
    world.initResource(DressAssets)
    const assets = world.resource(DressAssets)
    for (const e of todo as Entity[]) {
      const { kind, color } = world.get(e, Dress)
      let mesh = assets.meshes.get(kind)
      if (!mesh) {
        mesh = world.resource(Meshes).add(box()) as AssetRef<'Mesh'>
        assets.meshes.set(kind, mesh)
      }
      let material = assets.materials.get(color)
      if (!material) {
        material = world
          .resource(Materials)
          .add(new MaterialAsset({ baseColor: hex(color), roughness: 0.8 })) as AssetRef<'Material'>
        assets.materials.set(color, material)
      }
      world.add(e, Mesh3d, { mesh })
      world.add(e, MeshMaterial, { material })
    }
  },
})

/** Every dressed entity's world, for tests that count them. */
export function dressed(world: World): Entity[] {
  return world.query({ with: [Dress, Mesh3d] }).entities() as Entity[]
}
