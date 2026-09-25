import { animationPlugin } from '@shard/animation'
// Also registers the audio importer and the AudioClip asset type for every project host.
import { audioPlugin } from '@shard/audio'
import type { GpuContext } from '@shard/gpu'
// Registers the .gltf/.glb importer and the Skin/AnimationClip asset types for every project host.
import '@shard/gltf'
import { inputPlugin } from '@shard/input'
// Also registers the navgrid importer and the NavGridData asset type for every project host.
import { loadNavCache, Nav, navGridPlugin, navPlugin } from '@shard/nav'
import { particlesPlugin } from '@shard/particles'
import { physics2dPlugin, physics3dPlugin } from '@shard/physics'
import type { AudioBackend, InputSource, Platform } from '@shard/platform'
import { forwardPlugin, type RenderTarget, renderPlugin, Shaders } from '@shard/render'
import { App, LogResource, type Plugin } from '@shard/runtime'
import { type LoadedSceneHandle, loadScene, ScenePlugin } from '@shard/scene'
import { spritePlugin } from '@shard/sprite'
import { textPlugin } from '@shard/text'
import { TransformPlugin } from '@shard/transform'
// Also registers the theme importer and the UiTheme asset type for every project host.
import { uiPlugin } from '@shard/ui'
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
  /** Where sound goes (`platform.audio`). Without one, audio records voices (headless). */
  audio?: AudioBackend
}

/** An app with the manifest's engine plugins and the project plugin, not yet initialized. */
export function buildApp(options: BuildAppOptions): App {
  const { manifest } = options
  const names = new Set(manifest.plugins)
  if (names.has('sprite') || names.has('text') || names.has('particles') || names.has('animation'))
    names.add('render/forward')
  if (names.has('render/forward')) {
    names.add('render')
    names.add('core/transform')
  }
  if (
    names.has('physics3d') ||
    names.has('physics2d') ||
    names.has('audio') ||
    names.has('ui') ||
    names.has('nav') ||
    names.has('nav/grid')
  )
    names.add('core/transform')
  const app = new App({ seed: manifest.seed })
  if (names.has('core/transform')) app.addPlugin(TransformPlugin)
  if (names.has('render')) {
    app.addPlugin(
      renderPlugin({ gpu: options.gpu, canvas: options.canvas, target: options.target }),
    )
  }
  if (names.has('render/forward'))
    app.addPlugin(forwardPlugin({ msaa: manifest.window.msaa === 1 ? 1 : 4 }))
  if (names.has('sprite')) app.addPlugin(spritePlugin)
  if (names.has('text')) app.addPlugin(textPlugin)
  if (names.has('particles')) app.addPlugin(particlesPlugin)
  if (names.has('animation')) app.addPlugin(animationPlugin)
  if (names.has('physics3d')) app.addPlugin(physics3dPlugin)
  if (names.has('physics2d')) app.addPlugin(physics2dPlugin)
  if (names.has('input')) app.addPlugin(inputPlugin({ source: options.inputSource }))
  if (names.has('audio')) app.addPlugin(audioPlugin({ backend: options.audio }))
  if (names.has('ui')) app.addPlugin(uiPlugin)
  if (names.has('nav')) app.addPlugin(navPlugin)
  else if (names.has('nav/grid')) app.addPlugin(navGridPlugin)
  app.addPlugin(ScenePlugin)
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
  await loadProjectNavCache(app, platform)
  const json = JSON.parse(await platform.fs.readText(manifest.startScene))
  return loadScene(app.world, json, { id: manifest.startScene })
}

/**
 * Loads the project's `shaders/` folder into the shader library as `project::…`, and with `watch`
 * reloads a file when it changes (the running game picks it up once it compiles). Returns a
 * function that stops watching.
 */
export async function loadProjectShaders(
  app: App,
  platform: Platform,
  options: { watch?: boolean; dir?: string } = {},
): Promise<() => void> {
  const shaders = app.world.tryResource(Shaders)
  if (!shaders) return () => {}
  const dir = options.dir ?? 'shaders'
  try {
    await shaders.loadDir(platform, dir, 'project')
  } catch (err) {
    app.world.tryResource(LogResource)?.error(err)
  }
  if (options.watch && platform.fs.watch && (await platform.fs.exists(dir))) {
    return shaders.watch(platform, dir, 'project')
  }
  return () => {}
}

/**
 * Reads the project's baked navmesh tiles (`.shard/cache/nav`) so navmeshes whose geometry hasn't
 * changed load without running Recast, and lets `nav.bake` save there. Call after `app.init()`,
 * before loading scenes. Does nothing without a nav plugin.
 */
export async function loadProjectNavCache(app: App, platform: Platform): Promise<void> {
  if (!app.world.hasResource(Nav)) return
  try {
    await loadNavCache(app.world, platform.fs)
  } catch (err) {
    app.world.tryResource(LogResource)?.error(err)
  }
}
