import { AssetServerResource } from '@aethervtt/shard-assets'
import {
  defineEvent,
  defineResource,
  defineSystem,
  defineSystemSet,
  Last,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import {
  createGpuContext,
  type GpuContext,
  type Surface,
  type SurfaceAlpha,
} from '@aethervtt/shard-gpu'
import {
  definePlugin,
  FrameDemand,
  LOADING_DEMAND,
  LogResource,
  type Plugin,
} from '@aethervtt/shard-runtime'
import { type ShaderBake, ShaderLibrary } from '@aethervtt/shard-shader'
import { describeFeatures, RenderFeatures } from './features'
import { type CapturedBuffer, type CapturedImage, RenderGraph, type RenderView } from './graph'
import { healthSystem, RenderHealth, RenderHealthChanged, RenderHealthReports } from './health'
import { registerEngineShaders } from './shaders'
import { GpuMemory, RenderCounters, RenderStats } from './stats'
import type { RenderTarget } from './target'

export const Gpu = defineResource<GpuContext>('render/Gpu', {
  description: 'The GPU device, its surfaces (canvases), and caches. Apps can share one.',
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
    "Where cameras without a target render: the app's surface (canvas), or an offscreen target when headless.",
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
  /**
   * Render into this canvas: the plugin adds it as a surface of `gpu` (or of a device it makes).
   * Omit for headless (views use offscreen targets).
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /**
   * With `canvas`: 'premultiplied' composites the canvas over the page, where cameras clearing to
   * alpha 0 show what's under it (0052). Default 'opaque'.
   */
  alpha?: SurfaceAlpha
  /** Render into a surface already on `gpu` (`gpu.addSurface`). Disposing the app removes it. */
  surface?: Surface
  /**
   * An existing GPU context (e.g. Dawn in Node, or one shared with other apps). Otherwise one is
   * created in `ready` and destroyed with the app.
   */
  gpu?: GpuContext
  /** The name this app's GPU objects count under in `gpu.stats(owner)`. Default `render:<n>`. */
  owner?: string
  /**
   * Headless stand-in for the window: cameras without a target render here. Used by the CLI for
   * screenshots. Ignored when there's a canvas or surface.
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

/** Marks entities drawing a fallback for a failed asset with MissingAsset (0061). */
const markMissing = defineSystem({
  name: 'render/mark-missing',
  description: 'Puts MissingAsset on entities that reference an asset showing a fallback.',
  run: (_, world) => world.tryResource(AssetServerResource)?.markMissing(),
})

const execute = defineSystem({
  name: 'render/execute-graph',
  description: 'Runs the render graph for every view and submits.',
  run: (_, world) => {
    // Between a device loss and its replacement there's nothing to draw with (0061).
    if (world.resource(Gpu).status !== 'ok') return
    const views = world.resource(Views).list
    const window = world.tryResource(Window)
    const options = world.resource(RenderOptions)
    if (views.length === 0 && window && options.windowView) {
      views.push({ name: WINDOW_VIEW, target: window, order: 0, data: {} })
    }
    if (views.length === 0) return
    world.resource(Graph).execute(world, views)
    world.tryResource(RenderStats)?.endFrame(world.resource(Gpu).uploads(options.owner))
    // A frame that couldn't draw everything (pipelines compiling, meshes or materials still
    // loading) is followed by another, so an on-demand app doesn't stop on a half-drawn frame.
    const gpu = world.resource(Gpu)
    anyPending = gpu.pipelines.skipped > 0 || gpu.pipelines.pending > 0
    if (!anyPending) world.tryResource(RenderStats)?.forEach(notePending)
    world.tryResource(FrameDemand)?.set(LOADING_DEMAND, anyPending)
  },
})

/** Scratch for execute: Map.forEach with a module function allocates nothing per frame. */
let anyPending = false
function notePending(stats: { pending: number }): void {
  if (stats.pending > 0) anyPending = true
}

/**
 * Extra sections for `describeRender`, keyed by name. Plugins add theirs (lighting, post effects),
 * so the renderer's description grows with what's installed.
 */
export const RenderDescribers = defineResource<Map<string, (world: World) => unknown>>(
  'render/Describers',
  { description: 'Sections plugins add to render.describe.', init: () => new Map() },
)

export interface RenderOptionsValue {
  windowView: boolean
  /** What this app's GPU objects count under in `gpu.stats` (0052). */
  owner: string
}

export const RenderOptions = defineResource<RenderOptionsValue>('render/Options', {
  description: "The render plugin's settings: the fallback window view, and the app's GPU owner.",
})

/** What one app's render plugin set up, and releases on dispose. */
interface RenderAppState {
  owner: string
  gpu: GpuContext | undefined
  /** The plugin made the device, so it destroys it too. */
  ownsDevice: boolean
  surface: Surface | undefined
  /** Owners the scope replaced, innermost last (apps nest: a preview renders inside a frame). */
  readonly saved: (string | undefined)[]
  readonly unsubscribe: (() => void)[]
}

const renderApps = new WeakMap<object, RenderAppState>()
let nextOwner = 1

/**
 * The next animation frame's timestamp: the frame that composites what was submitted before it.
 * Its callbacks run later in the frame, after other work; the timestamp is when the frame began.
 */
function nextRefresh(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

/**
 * A frame is presented once the GPU has done its work and the next animation frame starts (0062).
 * Without animation frames (headless), the GPU finishing is the whole of it.
 */
function presentOn(state: RenderAppState): () => Promise<number | undefined> {
  return () => {
    const done = state.gpu!.device.queue.onSubmittedWorkDone()
    return typeof requestAnimationFrame === 'function'
      ? done.then(nextRefresh)
      : done.then(() => undefined)
  }
}

export function renderPlugin(options: RenderPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'render',
    provides: [
      // graph and device
      Gpu,
      GpuDeviceLost,
      Graph,
      RenderDescribers,
      RenderFeatures,
      RenderHealth,
      RenderHealthChanged,
      RenderHealthReports,
      RenderOptions,
      Shaders,
      Views,
      Window,
    ],
    dependencies: ['core/time'],
    build(app) {
      const state: RenderAppState = {
        owner: options.owner ?? `render:${nextOwner++}`,
        gpu: undefined,
        ownsDevice: false,
        surface: undefined,
        saved: [],
        unsubscribe: [],
      }
      renderApps.set(app, state)
      // Everything the app runs counts its buffers and textures against its owner (0052).
      app.addScope({
        enter() {
          const gpu = state.gpu
          state.saved.push(gpu?.owner)
          if (gpu) gpu.owner = state.owner
        },
        exit() {
          const previous = state.saved.pop()
          if (state.gpu && previous !== undefined) state.gpu.owner = previous
        },
      })
      app
        .insertResource(Views, { list: [] })
        .insertResource(RenderOptions, {
          windowView: options.windowView ?? true,
          owner: state.owner,
        })
        .configureSets(
          Last,
          RenderSet.Extract.after(RenderSet.Begin),
          RenderSet.Prepare.after(RenderSet.Extract),
          RenderSet.Queue.after(RenderSet.Prepare),
          RenderSet.Upload.after(RenderSet.Queue),
          RenderSet.Graph.after(RenderSet.Upload),
        )
        .addSystems(
          Last,
          begin.inSet(RenderSet.Begin),
          markMissing.inSet(RenderSet.Begin).after(begin),
          execute.inSet(RenderSet.Graph),
          healthSystem({ status: () => state.gpu?.status ?? 'ok' })
            .inSet(RenderSet.Graph)
            .after(execute),
        )
    },
    async ready(app) {
      const state = renderApps.get(app)!
      const given = options.gpu ?? options.surface?.gpu
      if (options.surface && options.gpu && options.surface.gpu !== options.gpu) {
        throw new ShardError('render/surface-device', 'The surface belongs to another GpuContext', {
          hint: 'Pass the GpuContext the surface was added to (surface.gpu), or omit gpu.',
        })
      }
      const gpu = given ?? (await createGpuContext({ features: options.features }))
      state.gpu = gpu
      state.ownsDevice = !given
      // After the await, so outside the app's scope: count what's made here against it explicitly.
      gpu.withOwner(state.owner, () => {
        app.insertResource(Gpu, gpu)
        app.insertResource(Graph, new RenderGraph(gpu))
      })
      app.setPresenter(presentOn(state))
      const shaders = options.shaders ?? new ShaderLibrary()
      if (!options.shaders) registerEngineShaders(shaders)
      if (options.shaderBake) shaders.preload(options.shaderBake)
      app.insertResource(Shaders, shaders)
      const surface =
        options.surface ??
        (options.canvas ? gpu.addSurface(options.canvas, { alpha: options.alpha }) : undefined)
      state.surface = surface
      if (surface) {
        app.insertResource(Window, surface)
        // A resize changes what's on screen: an on-demand app renders it.
        state.unsubscribe.push(surface.onResize(() => app.disposed || app.requestFrame()))
      } else if (options.target) app.insertResource(Window, options.target)
      const log = app.world.tryResource(LogResource)
      if (log) state.unsubscribe.push(gpu.onError((error) => log.error(error)))
      state.unsubscribe.push(
        gpu.onDeviceLost((info) => {
          app.world.send(GpuDeviceLost, info)
          // Recovery retries (0061); a final failure is reported and shows in RenderHealth.
          gpu.recreate().then(
            () => app.disposed || app.requestFrame(),
            () => app.disposed || app.requestFrame(),
          )
        }),
      )
    },
    dispose(app) {
      const state = renderApps.get(app)
      if (!state) return
      renderApps.delete(app)
      for (const off of state.unsubscribe.splice(0)) off()
      app.world.tryResource(Graph)?.dispose()
      state.surface?.remove()
      const gpu = state.gpu
      if (!gpu) return
      // The app's buffers and textures, wherever they were made: nodes, pools, uploads, targets.
      gpu.release(state.owner)
      if (state.ownsDevice) gpu.destroy()
    },
  })
}

/** The name this app's GPU objects count under in `gpu.stats` (0052). */
export function renderOwner(world: World): string {
  return world.resource(RenderOptions).owner
}

/** A screenshot of a view (default: the window) after the next frame renders it. */
export function captureView(world: World, view = WINDOW_VIEW): Promise<CapturedImage> {
  const shot = world.resource(Graph).capture(view)
  world.wake() // an idle on-demand app renders the frame the capture waits for
  return shot
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
  const pending = graph.capture(view, buffer)
  world.wake()
  const result = await pending
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
    features: describeFeatures(world),
    health: world.tryResource(RenderHealth) ?? { state: 'ok', issues: [] },
    // The API and tier the device runs (0064), what it can do, and why a better option was skipped.
    backend: gpu.backend,
    tier: gpu.tier,
    capabilities: gpu.capabilities,
    limits: {
      maxTextureDimension2D: gpu.device.limits.maxTextureDimension2D,
      maxColorAttachments: gpu.device.limits.maxColorAttachments,
      maxSampledTexturesPerShaderStage: gpu.device.limits.maxSampledTexturesPerShaderStage,
      maxInterStageShaderVariables: gpu.device.limits.maxInterStageShaderVariables,
      maxUniformBufferBindingSize: gpu.device.limits.maxUniformBufferBindingSize,
    },
    reasons: gpu.reasons,
  }
  const sections: Record<string, unknown> = {}
  for (const [name, fn] of world.tryResource(RenderDescribers) ?? []) sections[name] = fn(world)
  return Object.assign(base, sections) as typeof base & Record<string, unknown>
}
