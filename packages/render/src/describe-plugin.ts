import { defineSchema, t, type World } from '@aethervtt/shard-core'
import { type AppMethod, definePlugin, FrameDemand } from '@aethervtt/shard-runtime'
import { describeCulling, describeLighting } from './debug-views'
import { GroundLayer } from './layers'
import { Gpu, RenderDescribers, RenderOptions, Window } from './plugin'
import { describeRenderScale } from './render-scale'
import { type FrameRecord, RenderStats } from './stats'
import { Cameras } from './view'

/** Every surface on the app's device (size, alpha mode), and which one this app renders to (0052). */
function describeSurfaces(world: World) {
  const window = world.tryResource(Window)
  return world.resource(Gpu).surfaces.map((s) => ({
    label: s.label,
    size: [s.width, s.height],
    alpha: s.alpha,
    pixelRatio: s.pixelRatio,
    thisApp: s === window,
  }))
}

/**
 * What the last frame and the last 60 wrote to the GPU, by category, and what they rebuilt (0055).
 */
function describeUploads(world: World) {
  const stats = world.resource(RenderStats)
  const bytes = (r: FrameRecord) => ({
    bytes: { ...r.bytes },
    sceneBytes: r.sceneBytes,
    created: r.created,
  })
  const rebuilds = (r: FrameRecord) => ({
    chunksRebuilt: r.chunksRebuilt,
    meshesRebuilt: r.meshesRebuilt,
    shadowMapsRendered: r.shadowMapsRendered,
  })
  return {
    frames: stats.frames,
    lastFrame: bytes(stats.lastFrame),
    recent: bytes(stats.recent),
    rebuilds: { lastFrame: rebuilds(stats.lastFrame), recent: rebuilds(stats.recent) },
  }
}

/** Ground bands (0057): entities per band, and each camera's ground draws last frame. */
function describeGround(world: World) {
  const bands: Record<string, number> = {}
  world.query({ with: [GroundLayer] }).each((_e, row, table) => {
    const band = String(table.column(GroundLayer, 'band')[row])
    bands[band] = (bands[band] ?? 0) + 1
  })
  const views: Record<string, { instances: number; draws: number }> = {}
  for (const cam of world.resource(Cameras).values())
    views[`camera:${cam.entity}`] = {
      instances: cam.ground.visible + cam.overlay.visible,
      draws: cam.ground.length + cam.overlay.length,
    }
  return { bands, views }
}

const gpuStats: AppMethod = {
  name: 'gpu.stats',
  description:
    "Live GPU buffers and textures, by owner: each app's render plugin is one, and 'gpu' holds what apps on the device share.",
  params: defineSchema('render/GpuStatsParams', {
    owner: t.string({ description: 'One owner. Empty: this app, every owner, and the total.' }),
  }),
  handler: ({ world }, p) => {
    const gpu = world.resource(Gpu)
    if (p.owner) return { owner: p.owner, ...gpu.stats(p.owner as string) }
    return {
      owner: world.resource(RenderOptions).owner,
      total: gpu.stats(),
      owners: Object.fromEntries(gpu.owners().map((o) => [o, gpu.stats(o)])),
    }
  },
}

/**
 * The lighting, culling, renderScale, surfaces, uploads, and frames sections of `render.describe`,
 * and the
 * `gpu.stats` method, for agents and the editor. Only introspection: an app that ships without it
 * renders the same.
 */
export const renderDescribePlugin = definePlugin({
  name: 'render/describe',
  dependencies: ['render/forward'],
  build(app) {
    app.addMethod(gpuStats)
  },
  ready(app) {
    const describers = app.world.initResource(RenderDescribers)
    describers.set('lighting', (world) => describeLighting(world))
    describers.set('culling', (world) => describeCulling(world))
    describers.set('renderScale', (world) => describeRenderScale(world))
    describers.set('surfaces', describeSurfaces)
    describers.set('uploads', describeUploads)
    describers.set('ground', describeGround)
    // What drives frames, and who holds an on-demand runner awake (0052).
    describers.set('frames', (world) => world.resource(FrameDemand).describe())
    describers.set('gpuObjects', (world) =>
      world.resource(Gpu).stats(world.resource(RenderOptions).owner),
    )
  },
})
