import { loadNavCache, Nav } from '@aethervtt/shard-nav'
import type { Platform } from '@aethervtt/shard-platform'
import { Shaders } from '@aethervtt/shard-render'
import { App, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { type LoadedSceneHandle, loadScene } from '@aethervtt/shard-scene'
import { LocaleState, loadStringTables } from '@aethervtt/shard-text'
import type { ManifestValue } from './manifest'
import { addEnginePlugins, enginePlugins, type PluginContext, resolvePlugins } from './plugins'

export interface BuildAppOptions extends PluginContext {
  /** The project plugin (default export of `entry`), once loaded by the host. */
  project?: Plugin
  /**
   * False builds without anything that draws, plays or reads devices: no render, input, audio
   * or UI plugins, and no GPU. Servers and headless clients use it (0092). Default true.
   */
  display?: boolean
}

/** An app with the manifest's engine plugins and the project plugin, not yet initialized. */
export function buildApp(options: BuildAppOptions): App {
  const { manifest } = options
  const app = new App({ seed: manifest.seed })
  addEnginePlugins(
    app,
    enginePlugins,
    resolvePlugins(manifest, { display: options.display }),
    options,
  )
  if (options.project) app.addPlugin(options.project)
  return app
}

/**
 * Loads every string table (`locales/*.strings.json`) so keyed text resolves from the first frame.
 * Call after the asset scan, before loading scenes. Does nothing without text or UI.
 */
export async function loadProjectStrings(app: App): Promise<void> {
  if (!app.world.hasResource(LocaleState)) return
  try {
    await loadStringTables(app.world)
  } catch (err) {
    app.world.tryResource(LogResource)?.error(err)
  }
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
 * Registers project shaders from a list, as `project::…` (`shaders/water/foam.wesl` is
 * `project::water::foam`): how hosts that can't list files load them (the dev page, exports). A
 * module that fails to register is logged, and the rest still register.
 */
export function registerProjectShaders(
  app: App,
  shaders: readonly { file: string; source: string }[],
): void {
  const library = app.world.tryResource(Shaders)
  if (!library) return
  for (const { file, source } of shaders) {
    const module = `project::${file
      .replace(/^shaders\//, '')
      .replace(/\.(wesl|wgsl)$/, '')
      .split('/')
      .join('::')}`
    try {
      library.register(module, source, file)
    } catch (err) {
      app.world.resource(LogResource).error(err)
    }
  }
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
