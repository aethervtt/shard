import { type AssetRef, Derived, defineSchema, PostUpdate } from '@aethervtt/shard-core'
import { box } from '@aethervtt/shard-mesh'
import { MaterialAsset, Materials, Meshes, registerShaders, Shaders } from '@aethervtt/shard-render'
import { type AppMethod, definePlugin } from '@aethervtt/shard-runtime'
import { Transform, TransformSystems } from '@aethervtt/shard-transform'
import {
  compileStructure,
  FRAME_KEY,
  observeRemovals,
  Structure,
  StructureState,
  swingDoors,
} from './compile'
import {
  ContactMesh,
  Cutout,
  DoorLeaf,
  Floor,
  Level,
  Opening,
  Roof,
  StructureChunk,
  StructureSettings,
  Wall,
  WindowPane,
} from './components'
import { CONTACT_KEY, CONTACT_SHADERS, ContactShade } from './contact-shade'

export const structureMethods: AppMethod[] = [
  {
    name: 'structure.describe',
    description:
      'Structure: wall, opening, floor, roof, cutout, level and chunk counts, the groups (ground, levels, roofs: their chunks, meshes and whether hidden), the chunk grid, pieces per chunk, and the last compile (its dirty chunks and time).',
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
 * where an edit lands, door leaves that swing without rebuilding anything, and window panes. Levels,
 * roofs and cutouts (0067): each level and roof is a group whose meshes are its children, so hiding
 * one is a Visibility write. Contact shade (0068): noisy dark strips where walls meet floors and
 * each other, one blended mesh per (group, chunk). Needs `forwardPlugin` (render/forward).
 */
export const structurePlugin = definePlugin({
  name: 'structure',
  dependencies: ['render/forward', 'core/transform'],
  provides: [
    Wall,
    Opening,
    Floor,
    Level,
    Roof,
    Cutout,
    StructureChunk,
    DoorLeaf,
    WindowPane,
    ContactMesh,
    ContactShade,
    StructureSettings,
  ],
  build(app) {
    const world = app.world
    world.initResource(StructureSettings)
    const state = new StructureState(world)
    world.insertResource(Structure, state)
    // The ground level's group: pieces without a Level are its children (0067).
    state.ground = world.spawn(Transform, Derived)
    state.groupSlot(state.ground)
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
    state.materials.set(
      FRAME_KEY,
      materials.add(
        new MaterialAsset({ baseColor: [0.29, 0.18, 0.1, 1], roughness: 0.6 }),
        FRAME_KEY,
      ) as AssetRef<'Material'>,
    )
    state.glassMaterial = materials.add(
      new MaterialAsset({
        baseColor: [0.62, 0.76, 0.86, 0.28],
        roughness: 0.05,
        alphaMode: 'alpha',
      }),
      'structure:glass',
    ) as AssetRef<'Material'>
    state.leafMesh = world.resource(Meshes).add(leafBox(), 'structure:leaf') as AssetRef<'Mesh'>
    registerShaders(world.resource(Shaders), CONTACT_SHADERS)
    const contact = state.contact
    state.contactMaterial = materials.add(
      new MaterialAsset(
        {
          opacity: contact.opacity,
          maxAlpha: contact.maxAlpha,
          color: [...contact.color],
          wobble: contact.wobble,
        },
        ContactShade,
      ),
      CONTACT_KEY,
    ) as AssetRef<'Material'>
  },
})
