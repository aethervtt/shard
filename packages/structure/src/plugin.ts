import { type AssetRef, defineSchema, PostUpdate } from '@aethervtt/shard-core'
import { box } from '@aethervtt/shard-mesh'
import { MaterialAsset, Materials, Meshes } from '@aethervtt/shard-render'
import { type AppMethod, definePlugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { compileStructure, observeRemovals, Structure, StructureState, swingDoors } from './compile'
import {
  DoorLeaf,
  Floor,
  Opening,
  StructureChunk,
  StructureSettings,
  Wall,
  WindowPane,
} from './components'

export const structureMethods: AppMethod[] = [
  {
    name: 'structure.describe',
    description:
      'Structure: wall, opening, floor and chunk counts, the chunk grid, pieces per chunk, and the last compile (its dirty chunks and time).',
    params: defineSchema('structure/DescribeParams', {}),
    handler: ({ world }) => world.resource(Structure).describe(),
  },
]

/** A unit box from (0, 0, −½) to (1, 1, ½): door leaves hinge at their local origin. */
function leafBox() {
  const mesh = box()
  const data = mesh.data()
  const p = data.positions
  for (let i = 0; i < p.length; i += 3) {
    p[i] = p[i]! + 0.5
    p[i + 1] = p[i + 1]! + 0.5
  }
  mesh.update(data)
  return mesh
}

/**
 * Walls, openings and floors (0055): compiled into chunked, per-material meshes that rebuild only
 * where an edit lands, door leaves that swing without rebuilding anything, and window panes.
 * Needs `forwardPlugin` (render/forward).
 */
export const structurePlugin = definePlugin({
  name: 'structure',
  dependencies: ['render/forward', 'core/transform'],
  provides: [Wall, Opening, Floor, StructureChunk, DoorLeaf, WindowPane, StructureSettings],
  build(app) {
    const world = app.world
    world.initResource(StructureSettings)
    const state = new StructureState(world)
    world.insertResource(Structure, state)
    observeRemovals(world, state)
    app.addSystems(PostUpdate, swingDoors.after(compileStructure).before(TransformSystems))
    app.addSystems(PostUpdate, compileStructure.before(TransformSystems))
    app.addMethod(...structureMethods)
  },
  ready(app) {
    const world = app.world
    const state = world.resource(Structure)
    const materials = world.resource(Materials)
    state.defaultMaterial = materials.add(
      new MaterialAsset({ baseColor: [0.62, 0.6, 0.57, 1], roughness: 0.85 }),
      'structure:default',
    ) as AssetRef<'Material'>
    state.glassMaterial = materials.add(
      new MaterialAsset({
        baseColor: [0.62, 0.76, 0.86, 0.28],
        roughness: 0.05,
        alphaMode: 'alpha',
      }),
      'structure:glass',
    ) as AssetRef<'Material'>
    state.leafMesh = world.resource(Meshes).add(leafBox(), 'structure:leaf') as AssetRef<'Mesh'>
  },
})
