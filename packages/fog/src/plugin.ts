import {
  defineResource,
  defineSchema,
  defineSystem,
  Last,
  ProfilerResource,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  addRenderFeatures,
  cameraOf,
  Gpu,
  Graph,
  RenderDescribers,
  RenderPhase,
  RenderSet,
  registerShaders,
  Shaders,
} from '@aethervtt/shard-render'
import { type AppMethod, definePlugin } from '@aethervtt/shard-runtime'
import {
  FogLayer,
  FogRegionsAssetType,
  FogRegionsStore,
  FogSettings,
  MAX_FOG_LAYERS,
} from './components'
import { compositeNode, FOG_COMPOSITE_SHADERS } from './composite'
import { createFogState, encodeMasks, FOG_MASK_SHADERS, type FogState, updateFog } from './masks'
import { sampleFog } from './sample'

export const FogStateResource = defineResource<FogState>('fog/State', {
  description: "Fog layers' masks on the GPU, their drawn regions, and the tessellation cache.",
  init: createFogState,
})

const prepareFog = defineSystem({
  name: 'fog/prepare',
  description:
    'Sizes each FogLayer mask and picks the regions this frame draws (appended, or all).',
  run: (_, world) => {
    const gpu = world.tryResource(Gpu)
    if (gpu) updateFog(world, world.resource(FogStateResource), gpu)
  },
})

/** `fog.describe`, and the `fog` section of `render.describe`. */
export function describeFog(world: World) {
  const state = world.resource(FogStateResource)
  const gpuMs = world.tryResource(ProfilerResource)?.timing('gpu:fog/masks')?.last ?? null
  return {
    settings: { ...world.resource(FogSettings) },
    layers: state.active.map((l, i) => ({
      entity: l.entity,
      extent: [...l.extent],
      size: [l.width, l.height],
      base: l.base,
      regions: l.drawn,
      /** Beyond the first MAX_FOG_LAYERS, a layer isn't composed. */
      composed: i < MAX_FOG_LAYERS,
      lastUpdate: l.lastUpdate,
      lastDrawn: l.lastDrawn,
    })),
    regionsDrawn: state.regionsDrawn,
    /** GPU time of the last mask update, when the device has timestamp queries. */
    gpuMs,
    tessellations: state.meshes.size,
  }
}

const fogMethods: AppMethod[] = [
  {
    name: 'fog.describe',
    description:
      'Fog layers (0058): extents, mask sizes, region counts, whether the last update appended or redrew, and its GPU time.',
    params: defineSchema('fog/DescribeParams', {}),
    handler: ({ world }) => describeFog(world),
  },
  {
    name: 'fog.sample',
    description:
      "Each fog layer's value at world (x, z), and the composite there: read from the masks, so a check needs no pixels.",
    params: defineSchema('fog/SampleParams', {
      x: t.f64({ required: true }),
      z: t.f64({ required: true }),
    }),
    handler: ({ world }, p) =>
      sampleFog(world, world.resource(FogStateResource), p.x as number, p.z as number),
  },
]

/**
 * Projected fog (0058): FogLayer masks drawn from ordered regions, and a world-space composite
 * after transparent objects. Needs the forward renderer.
 */
export const fogPlugin = definePlugin({
  name: 'fog',
  dependencies: ['render/forward'],
  provides: [FogLayer, FogSettings, FogRegionsStore, FogRegionsAssetType, FogStateResource],
  build(app) {
    app.world.initResource(FogSettings)
    app.world.initResource(FogRegionsStore)
    app.world.initResource(FogStateResource)
    app.addSystems(Last, prepareFog.inSet(RenderSet.Prepare))
    app.addMethod(...fogMethods)
  },
  ready(app) {
    const world = app.world
    registerShaders(world.resource(Shaders), { ...FOG_MASK_SHADERS, ...FOG_COMPOSITE_SHADERS })
    const state = world.resource(FogStateResource)
    addRenderFeatures(world, {
      name: 'fog',
      description:
        'Projected fog: per-layer masks from ordered regions, composited in world space.',
      nodes: ['fog/masks', 'fog/composite'],
      baseline: {
        strategy: 'The same render passes: masks drawn with a stencil, a fragment composite',
      },
      components: [FogLayer],
    })
    const graph = world.resource(Graph)
    graph.addNode('fog/masks', {
      kind: 'raw',
      phase: RenderPhase.Setup,
      sideEffects: true,
      // Masks are the same for every view: the first view of a frame draws them.
      enabled: (view) => cameraOf(view) !== undefined && state.active.length > 0,
      run: (ctx) => encodeMasks(ctx, state),
    })
    graph.addNode('fog/composite', compositeNode(state, world.resource(Gpu).tier))
    world.initResource(RenderDescribers).set('fog', describeFog)
  },
})
