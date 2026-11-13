import {
  defineResource,
  defineSystem,
  type Entity,
  Last,
  onRemove,
  type World,
} from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Camera3d } from './camera'
import { addRenderFeatures } from './features'
import { prepareInstances } from './instances'
import { Occluder, OcclusionCulling, OcclusionPath, type OcclusionSupport } from './occlusion'
import type { OcclusionBuffer } from './occlusion-buffer'
import { RenderDescribers, RenderSet, Shaders } from './plugin'
import { registerShaders } from './shaders'

// Occlusion culling (0116). The plugin is small: its raster (occlusion-raster.ts) loads with
// import() the first time a world has a camera with OcclusionCulling or an Occluder, so apps that
// use neither don't carry it. The CPU culls test batches and instances against each camera's
// buffer; on the full tier the GPU cull tests every instance against its uploaded copy, in the same
// frame.

/** Cameras with occlusion the GPU copy holds (texture layers). */
export const MAX_OCCLUSION_CAMERAS = 4
/** Floats per camera in the GPU uniform: view matrix, projection, size. */
export const OCCLUSION_VIEW_FLOATS = 24

export interface OccluderRecord {
  entity: Entity
  /** World-space triangles, 9 floats each. */
  tris: Float32Array
  /**
   * Per triangle, which edges it shares with another triangle of the mesh (bit k: the edge opposite
   * vertex k). Shared edges are tested at pixel centers, so a quad of two triangles has no crack.
   */
  edges: Uint8Array
  count: number
  /** World bounding sphere. */
  cx: number
  cy: number
  cz: number
  r: number
  /** The cells it's in. */
  cells: number[]
  /** Last frame it was drawn into a buffer (once per buffer per raster). */
  stamp: number
  /** Its instance slot, when it has one: visibility and layers come from the slot's flags. */
  slot: number
}

export class OcclusionState {
  readonly cameras = new Map<Entity, OcclusionBuffer>()
  readonly occluders = new Map<Entity, OccluderRecord>()
  readonly grid = new Map<number, OccluderRecord[]>()
  /** Bumps when any occluder changes, appears or goes. */
  version = 0
  /** Its raster has loaded and seen every occluder (and registered its WGSL). */
  loaded = false
  stamp = 0
  readonly pending = new Set<Entity>()
  warned = false
  // GPU copy.
  texture: GPUTexture | undefined
  view: GPUTextureView | undefined
  uniform: GPUBuffer | undefined
  readonly uniformData = new Float32Array(OCCLUSION_VIEW_FLOATS * MAX_OCCLUSION_CAMERAS)
  readonly uniformU32 = new Uint32Array(this.uniformData.buffer)
  textureSize = 0
  textureHeight = 0
  generation = -1
  /** What each buffer held when it was last rasterized (to skip a still frame). */
  readonly drawn = new Map<Entity, Float64Array>()
}

export const OcclusionStateResource = defineResource<OcclusionState>('render/OcclusionState', {
  description: 'Occluders by grid cell, and each occlusion camera’s buffer (0116).',
})

type Raster = typeof import('./occlusion-raster')
let raster: Raster | undefined
let loading = false

function load(): void {
  if (loading) return
  loading = true
  void import('./occlusion-raster').then((m) => {
    raster = m
  })
}

/** Keeps the occluder registry current (once the raster has loaded). */
export const syncOccluders = defineSystem({
  name: 'render/occluders',
  description: 'Places changed occluders (0116) in world space and in the occlusion grid.',
  setup: (world) => ({
    occluders: world.query({ with: [Occluder, GlobalTransform] }),
    cameras: world.query({ with: [Camera3d, OcclusionCulling] }),
  }),
  run: ({ occluders, cameras }, world, ctx) => {
    if (!raster) {
      const any = (q: typeof cameras) => q.tables.some((t) => t.count > 0)
      if (any(occluders) || any(cameras)) load()
      return
    }
    const state = world.resource(OcclusionStateResource)
    // Loaded late: every occluder so far is new to it.
    let since = ctx.lastRunTick
    if (!state.loaded) {
      state.loaded = true
      registerShaders(world.resource(Shaders), raster.OCCLUSION_SHADERS)
      since = 0
    }
    raster.sync(world, occluders, since)
  },
})

/** Each occlusion camera's buffer for this frame: rasterized again only when something changed. */
export const rasterizeOcclusion = defineSystem({
  name: 'render/occlusion',
  description:
    'Rasterizes the occluders near each camera with OcclusionCulling into its occlusion buffer (0116).',
  setup: (world) => ({ cameras: world.query({ with: [Camera3d, OcclusionCulling] }) }),
  run: ({ cameras }, world) => {
    if (raster && world.resource(OcclusionStateResource).loaded)
      raster.rasterizeCameras(world, cameras)
  },
})

/** Uploads what changed of each camera's pyramid, for the GPU cull. */
export const uploadOcclusion = defineSystem({
  name: 'render/occlusion-upload',
  description: "Uploads occlusion cameras' pyramids for the GPU cull (0116).",
  run: (_, world) => {
    if (raster && world.resource(OcclusionStateResource).loaded) raster.upload(world)
  },
})

function support(world: World): OcclusionSupport {
  return {
    bufferOf(camera) {
      const b = world.tryResource(OcclusionStateResource)?.cameras.get(camera)
      return b?.valid ? b : undefined
    },
    gpu(gpu) {
      const state = world.resource(OcclusionStateResource)
      if (gpu.tier !== 'full' || !state.texture || !state.uniform) return undefined
      return { uniform: state.uniform, texture: state.view! }
    },
  }
}

function describeOcclusion(world: World): unknown {
  const state = world.resource(OcclusionStateResource)
  const out: Record<string, unknown> = { occluders: state.occluders.size }
  for (const [camera, b] of state.cameras) {
    out[`camera:${camera}`] = {
      width: b.width,
      height: b.height,
      occluders: b.occluders,
      triangles: b.triangles,
      ms: b.ms,
      culledBatches: b.culledBatches,
      culledInstances: b.culledInstances,
    }
  }
  return out
}

export const occlusionPlugin = definePlugin({
  name: 'render/occlusion',
  dependencies: ['render/forward'],
  provides: [OcclusionCulling, Occluder, OcclusionStateResource],
  build(app) {
    app.insertResource(OcclusionStateResource, new OcclusionState())
    app.insertResource(OcclusionPath, support(app.world))
    const world = app.world
    world.observe(onRemove(Occluder), ({ entity, world }) => {
      const state = world.tryResource(OcclusionStateResource)
      if (state && raster) raster.forget(state, entity)
    })
    app.addSystems(
      Last,
      syncOccluders.inSet(RenderSet.Prepare).after(prepareInstances),
      rasterizeOcclusion.inSet(RenderSet.Prepare).after(syncOccluders),
      uploadOcclusion.inSet(RenderSet.Prepare).after(rasterizeOcclusion),
    )
  },
  ready(app) {
    app.world.initResource(RenderDescribers).set('occlusion', describeOcclusion)
    addRenderFeatures(app.world, {
      name: 'render/occlusion',
      description: 'CPU occlusion culling for cameras with OcclusionCulling (0116).',
      nodes: [],
      baseline: { strategy: 'The same CPU buffer; the CPU cull tests every instance' },
    })
  },
})
