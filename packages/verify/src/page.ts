import { ShardError } from '@aethervtt/shard-core'
import { Gpu, RenderScale } from '@aethervtt/shard-render'
import { type App, FrameDemand, LOADING_DEMAND } from '@aethervtt/shard-runtime'
import { MetricsResource } from './metrics/metrics'
import type { CapturePage } from './page-api'

export type { CapturePage } from './page-api'

/** What a host page gives the capture tool (0062). Every part is optional. */
export interface CaptureHost {
  /** Applies a shot's state: the camera, the active view, scene toggles. */
  apply?(state: Record<string, unknown>): void | Promise<void>
  /** Host actions a plan's steps run by name: move a token, switch scenes, reconnect. */
  steps?: Record<string, (args: unknown) => unknown>
  /** What checks read after a step: entity sets, owner and mirror counts. JSON only. */
  probe?(): unknown
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Nothing is loading: no pipeline compiling, no draw skipped for a mesh or material. */
function loading(app: App): boolean {
  const gpu = app.world.tryResource(Gpu)
  return app.world.resource(FrameDemand).isHeld(LOADING_DEMAND) || (gpu?.pipelines.pending ?? 0) > 0
}

/** No frames coming: an on-demand app asleep with no holders; a continuous one, never. */
function settled(app: App): boolean {
  const demand = app.world.resource(FrameDemand)
  return demand.mode !== 'on-demand' || (app.world.asleep && !demand.active)
}

async function idleApp(app: App, deadline: number): Promise<void> {
  for (;;) {
    if (performance.now() > deadline) {
      throw new ShardError('verify/idle-timeout', 'The app never went idle for the capture', {
        hint: `Still holding frames: ${app.world.resource(FrameDemand).held().join(', ') || 'nothing'}; pipelines compiling: ${app.world.tryResource(Gpu)?.pipelines.pending ?? 0}.`,
      })
    }
    if (loading(app) || !settled(app)) {
      await sleep(16)
      continue
    }
    // One more complete frame, waited for until it's on screen: the canvas then holds what it drew.
    await app.whenPresented()
    if (!loading(app)) return
  }
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(text)
}

/**
 * Installs `window.__shardCapture` for `shard capture`, and sets `window.__shardReady` once every
 * app has presented its first usable frame (the host calls `app.markUsable()`).
 */
export function installCapturePage(
  apps: App | readonly App[],
  host: CaptureHost = {},
): CapturePage {
  const list = Array.isArray(apps) ? (apps as readonly App[]) : [apps as App]
  const page: CapturePage = {
    async apply(state) {
      await host.apply?.(state)
    },
    async idle(timeoutMs = 30_000) {
      const deadline = performance.now() + timeoutMs
      for (const app of list) await idleApp(app, deadline)
    },
    async step(name, args, trace) {
      const run = host.steps?.[name]
      if (!run) {
        throw new ShardError('verify/unknown-step', `The page has no step "${name}"`, {
          hint: `Its steps: ${Object.keys(host.steps ?? {}).join(', ') || 'none'}.`,
        })
      }
      const result = await run(args)
      if (!trace) return { result: result ?? null }
      // Every app stamps the write; the latency is the slowest to show it.
      const latencies = await Promise.all(list.map((app) => app.trace(`step:${name}`)))
      return { result: result ?? null, latencyMs: Math.max(...latencies) }
    },
    async probe() {
      return (await host.probe?.()) ?? null
    },
    async conditions(conditions) {
      const scale = conditions.renderScale
      if (!scale) return
      for (const app of list) {
        if (!app.world.tryResource(RenderScale)) continue
        app.world.patchResource(RenderScale, { mode: scale.mode, scale: scale.scale })
      }
    },
    async snapshot(selector) {
      const canvas = document.querySelector(selector)
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new ShardError('verify/no-canvas', `No canvas matches "${selector}"`)
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new ShardError('verify/no-canvas', `The canvas "${selector}" has no pixels`)
      const png = base64(new Uint8Array(await blob.arrayBuffer()))
      return { png, width: canvas.width, height: canvas.height }
    },
    reset() {
      for (const app of list) app.world.tryResource(MetricsResource)?.reset()
    },
    record(meta) {
      for (const app of list) {
        const metrics = app.world.tryResource(MetricsResource)
        if (metrics) return metrics.record(meta)
      }
      throw new ShardError('verify/no-metrics', 'No app on this page has metrics', {
        hint: 'Add metricsPlugin() from @aethervtt/shard-verify/metrics to the app.',
      })
    },
  }
  window.__shardCapture = page
  void Promise.all(list.map((app) => app.whenUsable())).then(() => {
    window.__shardReady = true
  })
  return page
}
