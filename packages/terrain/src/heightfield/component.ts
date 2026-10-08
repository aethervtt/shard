import { defineComponent, t } from '@aethervtt/shard-core'
import { Visibility } from '@aethervtt/shard-render'
import { Grid, Transform } from '@aethervtt/shard-transform'

export const Terrain = defineComponent(
  'terrain/Terrain',
  {
    source: t.handle('terrain/TerrainSource', {
      description:
        'The layer stack (*.terrain.json): noise, heightmap images, splines that flatten, raise or carve, and paint layers. Baked into page packs in .shard/cache/terrain by `shard import` (or on first use).',
    }),
    errorPixels: t.f32({
      default: 2,
      min: 0.1,
      description: 'A node splits when its geometric error covers more pixels than this.',
    }),
    vertexPixels: t.f32({
      default: 4,
      min: 0,
      description:
        'Finest on-screen vertex spacing: however rough the ground, nodes stop splitting once their vertices are this many pixels apart (normals keep the finer relief in the shading). 0: no limit.',
    }),
    colliderRadius: t.f32({
      default: 96,
      min: 0,
      unit: 'm',
      description:
        'Heightfield collider tiles (and leaf-detail rendering) within this distance of every TerrainAnchor, character, dynamic body and NavAgent.',
    }),
    skirts: t.bool({
      default: true,
      description: 'Walls under chunk edges that hide cracks while neighbors change level.',
    }),
    residentDepth: t.i8({
      default: -1,
      min: -1,
      description:
        'Depths up to this stay loaded for the terrain’s life, so streaming that falls behind shows coarse ground, never a hole. −1: the deepest level whose pages fit in 8 MB.',
    }),
    scatter: t.handle('scatter/ScatterSet', {
      description:
        'Props and foliage on the terrain (*.scatter.json; needs the scatter plugin), placed per block from its heights and paint.',
    }),
  },
  {
    description:
      'A heightfield terrain (spec 0071): a bounded landscape from 256 m to 64 km a side, streamed from its baked pages through a quadtree with no cracks or popping, with Rapier heightfield colliders near bodies. Needs a Grid (its chunks are grid children); its local origin is the terrain’s corner, x and z along its sides.',
    requires: [Grid, Transform, Visibility],
  },
)

export const TerrainChunk = defineComponent(
  'terrain/TerrainChunk',
  {
    terrain: t.entity({ readonly: true }),
    key: t.string({ readonly: true, description: 'depth/x/z' }),
    kind: t.enum(['render', 'collider'], { readonly: true }),
  },
  {
    description:
      'A heightfield chunk or collider tile the terrain spawned. Rebuilt from it; never saved.',
    serialize: false,
  },
)
