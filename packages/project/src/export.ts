import { assetServer } from '@aethervtt/shard-assets'
import type { BuildFiles, Platform } from '@aethervtt/shard-platform'
import { configureProcgenHost, setGeneratorCodeHashes } from '@aethervtt/shard-procgen'
import { App, type Plugin } from '@aethervtt/shard-runtime'
import { type LoadedSceneHandle, loadScene, whenSceneReady } from '@aethervtt/shard-scene'
import { loadProjectNavCache, loadProjectStrings, registerProjectShaders } from './host'
import type { ManifestValue } from './manifest'

// What an export's entries need besides the boot, without the package index (and every plugin).
export { projectNet } from './define'

import { addEnginePlugins, type EnginePlugin, type PluginContext, resolvePlugins } from './plugins'

/** `build.json`: what an export holds and where (0110). */
export interface BuildJson {
  version: 1
  /** Hash of every file the export holds. */
  build: string
  engine: string
  project: { name: string; version: string }
  /** The manifest, without its `export` section. */
  manifest: ManifestValue
  /** The page's entry chunk, and the module `shard run --build` imports, in the export's folder. */
  entry: string
  headless: string
  /** Generators' code hashes (0042), as `shard dev` computes them. */
  generators: Record<string, string>
  /** Worker modules, relative to the export's folder. */
  workers: { procgen?: string }
  /** Project paths (keys of `files`) of the shader bake, project shaders and WebGL2 translations. */
  shaders: { bake?: string; project?: string; webgl2?: string }
  /** The `.shardpak` files packed entries of `files` are in (`pack` is an index into it). */
  packs?: string[]
  files: BuildFiles
}

export interface StartExportOptions extends Omit<PluginContext, 'manifest' | 'shaderBake'> {
  build: BuildJson
  /** Reads the export: `buildFs` over the host's files. */
  platform: Platform
  /** The engine plugins the export's entry imported, in `enginePlugins` order. */
  plugins: readonly EnginePlugin[]
  project: Plugin
  /** Overrides the manifest's seed. */
  seed?: number
  /** URL of the procgen worker module; jobs run inline without one (or without workers). */
  procgenWorker?: string
  /** Adds plugins (a net client) before init. */
  configure?(app: App): void | Promise<void>
  /** Load the start scene (default true). */
  startScene?: boolean
  /** False: no render, input, audio or UI plugins and no GPU, as servers run (0092). */
  display?: boolean
}

/**
 * Boots an export (0110): the engine plugins it bundled, the project, then nav, shaders, assets,
 * strings and the start scene, as `shard dev` does from the project folder.
 */
export async function startExport(
  options: StartExportOptions,
): Promise<{ app: App; scene: LoadedSceneHandle | undefined }> {
  const { build, platform } = options
  const manifest =
    options.seed === undefined ? build.manifest : { ...build.manifest, seed: options.seed }
  setGeneratorCodeHashes(build.generators)
  if (options.procgenWorker && platform.workers) {
    configureProcgenHost({ workers: platform.workers, workerModule: options.procgenWorker })
  }
  const { bake, webgl2 } = build.shaders
  const app = new App({ seed: manifest.seed })
  addEnginePlugins(app, options.plugins, resolvePlugins(manifest, { display: options.display }), {
    ...options,
    manifest,
    shaderBake: bake ? JSON.parse(await platform.fs.readText(bake)) : undefined,
    // Read only on WebGL2, so WebGPU never downloads them.
    webgl2Shaders: options.webgl2Shaders ?? (webgl2 && platform.fs.resolveUrl?.(webgl2)),
  })
  app.addPlugin(options.project)
  await options.configure?.(app)
  await app.init()
  await prepareExportApp(app, platform, build)
  let scene: LoadedSceneHandle | undefined
  if (options.startScene ?? true) {
    const json = JSON.parse(await platform.fs.readText(manifest.startScene))
    scene = loadScene(app.world, json, { id: manifest.startScene })
    await whenSceneReady(app.world, manifest.startScene)
  }
  return { app, scene }
}

/**
 * An export's game without display plugins, not initialized: the server a page runs when it hosts
 * a peer-to-peer room (0091). `prepareExportApp` after its init.
 */
export function exportServerApp(
  build: BuildJson,
  plugins: readonly EnginePlugin[],
  project: Plugin,
  platform: Platform,
): App {
  const app = new App({ seed: build.manifest.seed })
  addEnginePlugins(app, plugins, resolvePlugins(build.manifest, { display: false }), {
    manifest: build.manifest,
    platform,
  })
  app.addPlugin(project)
  return app
}

/**
 * After init: nav cache, project shaders, assets and string tables, in the order a project host
 * prepares an app (materials can name project shaders).
 */
export async function prepareExportApp(
  app: App,
  platform: Platform,
  build: BuildJson,
): Promise<void> {
  await loadProjectNavCache(app, platform)
  const shaders = build.shaders.project
  if (shaders) registerProjectShaders(app, JSON.parse(await platform.fs.readText(shaders)))
  await assetServer(app.world).configure({ platform, roots: build.manifest.assetRoots }).scan()
  await loadProjectStrings(app)
}
