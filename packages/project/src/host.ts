import type { GpuContext } from '@shard/gpu'
import { inputPlugin } from '@shard/input'
import type { InputSource, Platform } from '@shard/platform'
import { forwardPlugin, type RenderTarget, renderPlugin } from '@shard/render'
import { App, type Plugin } from '@shard/runtime'
import { type LoadedSceneHandle, loadScene } from '@shard/scene'
import { TransformPlugin } from '@shard/transform'
import type { ManifestValue } from './manifest'

export interface BuildAppOptions {
  manifest: ManifestValue
  /** The project plugin (default export of `entry`), once loaded by the host. */
  project?: Plugin
  gpu?: GpuContext
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /** Headless stand-in for the window (CLI screenshots). */
  target?: RenderTarget
  inputSource?: InputSource
}

/** An app with the manifest's engine plugins and the project plugin, not yet initialized. */
export function buildApp(options: BuildAppOptions): App {
  const { manifest } = options
  const names = new Set(manifest.plugins)
  if (names.has('render/forward')) {
    names.add('render')
    names.add('core/transform')
  }
  const app = new App({ seed: manifest.seed })
  if (names.has('core/transform')) app.addPlugin(TransformPlugin)
  if (names.has('render')) {
    app.addPlugin(
      renderPlugin({ gpu: options.gpu, canvas: options.canvas, target: options.target }),
    )
  }
  if (names.has('render/forward'))
    app.addPlugin(forwardPlugin({ msaa: manifest.window.msaa === 1 ? 1 : 4 }))
  if (names.has('input')) app.addPlugin(inputPlugin({ source: options.inputSource }))
  if (options.project) app.addPlugin(options.project)
  return app
}

/** Initializes the app and loads the start scene (id = its path). */
export async function startProject(
  app: App,
  platform: Platform,
  manifest: ManifestValue,
): Promise<LoadedSceneHandle> {
  await app.init()
  const json = JSON.parse(await platform.fs.readText(manifest.startScene))
  return loadScene(app.world, json, { id: manifest.startScene })
}
