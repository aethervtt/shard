import {
  defineEvent,
  defineResource,
  defineSystem,
  defineSystemSet,
  Last,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { definePlugin, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { type ShaderBake, ShaderLibrary } from '@aethervtt/shard-shader'
import { type CapturedBuffer, type CapturedImage, RenderGraph, type RenderView } from './graph'
import { registerEngineShaders } from './shaders'
import { GpuMemory, RenderCounters, RenderStats } from './stats'
import { type RenderTarget, WindowTarget } from './target'

export const Gpu = defineResource<GpuContext>('render/Gpu', {
  description: 'The GPU device, caches, and canvas.',
})

export const Graph = defineResource<RenderGraph>('render/Graph', {
  description: 'Render graph nodes, run for every view each frame.',
})

export const Shaders = defineResource<ShaderLibrary>('render/Shaders', {
  description: 'WESL shader modules: engine (shard::), plugins, and project (project::).',
})

export const Views = defineResource<{ list: RenderView[] }>('render/Views', {
  description: 'Views to render this frame. Rebuilt every frame by extract systems.',
})

export const Window = defineResource<RenderTarget>('render/Window', {
  description:
    'Where cameras without a target render: the canvas swapchain, or an offscreen target when headless.',
})

export const GpuDeviceLost = defineEvent<{ reason: string; message: string }>(
  'render/GpuDeviceLost',
  {
    description: 'The GPU device was lost; the renderer is recreating it.',
  },
)

/**
 * The frame's render work, in `Last`, in this order. Plugins add systems to these sets:
 * Begin clears per-frame state, Extract reads the world, Prepare uploads, Queue builds draw lists,
 * Upload writes what the queue produced, Graph runs the render graph and submits.
 */
export const RenderSet = {
  Begin: defineSystemSet('render/Begin'),
  Extract: defineSystemSet('render/Extract'),
  Prepare: defineSystemSet('render/Prepare'),
  Queue: defineSystemSet('render/Queue'),
  Upload: defineSystemSet('render/Upload'),
  Graph: defineSystemSet('render/Graph'),
} as const

export interface RenderPluginOptions {
  /** Render into this canvas. Omit for headless (views use offscreen targets). */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /** An existing GPU context (e.g. Dawn in Node). Otherwise one is created in `ready`. */
  gpu?: GpuContext
  /**
   * Headless stand-in for the window: cameras without a target render here. Used by the CLI for
   * screenshots. Ignored when there's a canvas.
   */
  target?: RenderTarget
  features?: GPUFeatureName[]
  /** An existing shader library to share (e.g. a preview rendering the game's own shaders). */
  shaders?: ShaderLibrary
  /**
   * Shader variants linked ahead of time (`Shaders.bake()` after a run, saved as JSON). With every
   * variant baked, WESL never loads (spec 0056).
   */
  shaderBake?: ShaderBake
  /**
   * Adds a 'window' view each frame when there's a canvas and no extract system added a view.
   * Default true. Camera plugins turn this off by adding their own views.
   */
  windowView?: boolean
}

const WINDOW_VIEW = 'window'

const begin = defineSystem({
  name: 'render/begin-frame',
  description: 'Clears the frame view list.',
  run: (_, world) => {
    world.resource(Views).list.length = 0
    world.resource(Gpu).pipelines.skipped = 0
  },
})

const execute = defineSystem({
  name: 'render/execute-graph',
  description: 'Runs the render graph for every view and submits.',
  setup: () => ({ recovering: { value: false } }),
  run: ({ recovering }, world) => {
    if (recovering.value) return
    const views = world.resource(Views).list
    const window = world.tryResource(Window)
    const options = world.resource(RenderOptions)
    if (views.length === 0 && window && options.windowView) {
      views.push({ name: WINDOW_VIEW, target: window, order: 0, data: {} })
    }
    if (views.length === 0) return
    world.resource(Graph).execute(world, views)
  },
})

/**
 * Extra sections for `describeRender`, keyed by name. Plugins add theirs (lighting, post effects),
 * so the renderer's description grows with what's installed.
 */
export const RenderDescribers = defineResource<Map<string, (world: World) => unknown>>(
  'render/Describers',
  { description: 'Sections plugins add to render.describe.', init: () => new Map() },
)

export const RenderOptions =
  defineResource<Required<Pick<RenderPluginOptions, 'windowView'>>>('render/Options')

export function renderPlugin(options: RenderPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'render',
    provides: [
      // graph and device
      Gpu,
      GpuDeviceLost,
      Graph,
      RenderDescribers,
      RenderOptions,
      Shaders,
      Views,
      Window,
    ],
    dependencies: ['core/time'],
    build(app) {
      app
        .insertResource(Views, { list: [] })
        .insertResource(RenderOptions, { windowView: options.windowView ?? true })
        .configureSets(
          Last,
          RenderSet.Extract.after(RenderSet.Begin),
          RenderSet.Prepare.after(RenderSet.Extract),
          RenderSet.Queue.after(RenderSet.Prepare),
          RenderSet.Upload.after(RenderSet.Queue),
          RenderSet.Graph.after(RenderSet.Upload),
        )
        .addSystems(Last, begin.inSet(RenderSet.Begin), execute.inSet(RenderSet.Graph))
    },
    async ready(app) {
      const gpu =
        options.gpu ??
        (await createGpuContext({ canvas: options.canvas, features: options.features }))
      app.insertResource(Gpu, gpu)
      app.insertResource(Graph, new RenderGraph(gpu))
      const shaders = options.shaders ?? new ShaderLibrary()
      if (!options.shaders) registerEngineShaders(shaders)
      if (options.shaderBake) shaders.preload(options.shaderBake)
      app.insertResource(Shaders, shaders)
      if (gpu.context) app.insertResource(Window, new WindowTarget(gpu))
      else if (options.target) app.insertResource(Window, options.target)
      const log = app.world.tryResource(LogResource)
      if (log) gpu.onError((error) => log.error(error))
      gpu.onDeviceLost((info) => {
        app.world.send(GpuDeviceLost, info)
        void gpu.recreate()
      })
    },
  })
}

/** A screenshot of a view (default: the window) after the next frame renders it. */
export function captureView(world: World, view = WINDOW_VIEW): Promise<CapturedImage> {
  return world.resource(Graph).capture(view)
}

/**
 * Any texture of a view after the next frame renders it, as floats: `hdr` (in cd/m²: the
 * pre-exposure is divided out), `post-hdr` (the same after the HDR post effects: aerial
 * perspective, fog, bloom…), `depth`, G-buffer channels, effect buffers.
 */
export async function captureBuffer(
  world: World,
  view: string,
  buffer: string,
): Promise<CapturedBuffer> {
  const graph = world.resource(Graph)
  const result = await graph.capture(view, buffer)
  if (!('format' in result)) {
    const data = new Float32Array(result.data.length)
    for (let i = 0; i < data.length; i++) data[i] = result.data[i]! / 255
    return { width: result.width, height: result.height, format: 'rgba8unorm', data }
  }
  if (buffer === 'hdr' || buffer === 'scene-color' || buffer === 'post-hdr') {
    const exposure = (graph.lastViewData(view)?.camera as { exposure?: number } | undefined)
      ?.exposure
    if (exposure) {
      const d = result.data
      for (let i = 0; i < d.length; i++) if (i % 4 !== 3) d[i] = d[i]! / exposure
    }
  }
  return result
}

/** What the renderer is doing: graph order, culled nodes, views, pending pipelines. For agents. */
export function describeRender(world: World) {
  const graph = world.tryResource(Graph)
  const gpu = world.tryResource(Gpu)
  if (!graph || !gpu) {
    throw new ShardError('render/not-ready', 'The renderer has not initialized yet', {
      hint: 'Await app.init() so the render plugin can create the GPU device.',
    })
  }
  const base = {
    ...graph.describe(),
    views: world.resource(Views).list.map((v) => ({
      name: v.name,
      target: v.target.label,
      size: [v.target.width, v.target.height],
      renderSize: [v.width ?? v.target.width, v.height ?? v.target.height],
      order: v.order,
    })),
    pipelinesCompiling: gpu.pipelines.pending,
    drawsSkipped: gpu.pipelines.skipped,
    gpuTimings: gpu.features.has('timestamp-query'),
    stats: Object.fromEntries(world.tryResource(RenderStats) ?? []),
    counters: { ...(world.tryResource(RenderCounters) ?? { taaResets: 0, originShifts: 0 }) },
    memory: world.tryResource(GpuMemory) ?? { textures: 0, textureBytes: 0 },
    recentErrors: gpu.errors.slice(-5).map((e) => e.toJSON()),
  }
  const sections: Record<string, unknown> = {}
  for (const [name, fn] of world.tryResource(RenderDescribers) ?? []) sections[name] = fn(world)
  return Object.assign(base, sections) as typeof base & Record<string, unknown>
}
