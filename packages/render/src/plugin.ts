import {
  defineEvent,
  defineResource,
  defineSystem,
  defineSystemSet,
  Last,
  ShardError,
  type World,
} from '@shard/core'
import { createGpuContext, type GpuContext } from '@shard/gpu'
import { definePlugin, LogResource, type Plugin } from '@shard/runtime'
import { ShaderLibrary } from '@shard/shader'
import { type CapturedImage, RenderGraph, type RenderView } from './graph'
import { registerEngineShaders } from './shaders'
import { RenderStats } from './stats'
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
 * Graph runs the render graph and submits.
 */
export const RenderSet = {
  Begin: defineSystemSet('render/Begin'),
  Extract: defineSystemSet('render/Extract'),
  Prepare: defineSystemSet('render/Prepare'),
  Queue: defineSystemSet('render/Queue'),
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
    const options = world.resource(Options)
    if (views.length === 0 && window && options.windowView) {
      views.push({ name: WINDOW_VIEW, target: window, order: 0, data: {} })
    }
    if (views.length === 0) return
    world.resource(Graph).execute(world, views)
  },
})

const Options = defineResource<Required<Pick<RenderPluginOptions, 'windowView'>>>('render/Options')

export function renderPlugin(options: RenderPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'render',
    dependencies: ['core/time'],
    build(app) {
      app
        .insertResource(Views, { list: [] })
        .insertResource(Options, { windowView: options.windowView ?? true })
        .configureSets(
          Last,
          RenderSet.Extract.after(RenderSet.Begin),
          RenderSet.Prepare.after(RenderSet.Extract),
          RenderSet.Queue.after(RenderSet.Prepare),
          RenderSet.Graph.after(RenderSet.Queue),
        )
        .addSystems(Last, begin.inSet(RenderSet.Begin), execute.inSet(RenderSet.Graph))
    },
    async ready(app) {
      const gpu =
        options.gpu ??
        (await createGpuContext({ canvas: options.canvas, features: options.features }))
      app.insertResource(Gpu, gpu)
      app.insertResource(Graph, new RenderGraph(gpu))
      const shaders = new ShaderLibrary()
      registerEngineShaders(shaders)
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

/** What the renderer is doing: graph order, culled nodes, views, pending pipelines. For agents. */
export function describeRender(world: World) {
  const graph = world.tryResource(Graph)
  const gpu = world.tryResource(Gpu)
  if (!graph || !gpu) {
    throw new ShardError('render/not-ready', 'The renderer has not initialized yet', {
      hint: 'Await app.init() so the render plugin can create the GPU device.',
    })
  }
  return {
    ...graph.describe(),
    views: world.resource(Views).list.map((v) => ({
      name: v.name,
      target: v.target.label,
      size: [v.target.width, v.target.height],
      order: v.order,
    })),
    pipelinesCompiling: gpu.pipelines.pending,
    drawsSkipped: gpu.pipelines.skipped,
    gpuTimings: gpu.features.has('timestamp-query'),
    stats: Object.fromEntries(world.tryResource(RenderStats) ?? []),
    recentErrors: gpu.errors.slice(-5).map((e) => e.toJSON()),
  }
}
