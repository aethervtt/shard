import { animationPlugin } from '@aethervtt/shard-animation'
// Also registers the audio importer and the AudioClip asset type for every project host.
import {
  audioAcousticsPlugin,
  audioEventsPlugin,
  audioMixerPlugin,
  audioMusicPlugin,
  audioPlugin,
} from '@aethervtt/shard-audio'
import { controlsPlugin } from '@aethervtt/shard-controls'
// Also registers the dice data types (skins, layouts, recipes, definitions) for every project host.
import { dicePlugin } from '@aethervtt/shard-dice'
import { effectsPlugin } from '@aethervtt/shard-effects'
import { gltfPlugin } from '@aethervtt/shard-gltf'
import type { BakedTranslations, GpuContext } from '@aethervtt/shard-gpu'
import { gesturesPlugin, inputPlugin } from '@aethervtt/shard-input'
import { naturePlugin } from '@aethervtt/shard-nature'
// Also registers the navgrid importer and the NavGridData asset type for every project host.
import { NavWorkers, navGridPlugin, navPlugin } from '@aethervtt/shard-nav'
// Also registers the noise importer and the NoiseGraph asset type for every project host.
import { noisePlugin } from '@aethervtt/shard-noise'
import { particlesPlugin } from '@aethervtt/shard-particles'
import { physics2dPlugin, physics3dPlugin } from '@aethervtt/shard-physics'
import type { AudioBackend, InputSource, Platform } from '@aethervtt/shard-platform'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import {
  forwardPlugin,
  type RenderPluginOptions,
  type RenderTarget,
  renderPlugin,
} from '@aethervtt/shard-render'
import { materialNoisePlugin } from '@aethervtt/shard-render/noise'
import type { App } from '@aethervtt/shard-runtime'
import { savePlugin } from '@aethervtt/shard-save'
import { scatterPlugin } from '@aethervtt/shard-scatter'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { spritePlugin } from '@aethervtt/shard-sprite'
import { structureModelPlugin, structurePlugin } from '@aethervtt/shard-structure'
import { structureNavPlugin } from '@aethervtt/shard-structure/nav'
import { structurePhysicsPlugin } from '@aethervtt/shard-structure/physics'
import { terrainPlugin } from '@aethervtt/shard-terrain'
// Also registers the string table importer and the StringTable asset type for every project host.
import { textPlugin } from '@aethervtt/shard-text'
import { TransformPlugin } from '@aethervtt/shard-transform'
// Also registers the theme importer and the UiTheme asset type for every project host.
import { uiPlugin } from '@aethervtt/shard-ui'
import { oceanWavesPlugin, waterPlugin } from '@aethervtt/shard-water'
import { windPlugin } from '@aethervtt/shard-wind'
import type { ManifestValue } from './manifest'

/** What engine plugins are made with: the host's devices and services. */
export interface PluginContext {
  manifest: ManifestValue
  gpu?: GpuContext
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /** Headless stand-in for the window (CLI screenshots). */
  target?: RenderTarget
  /**
   * The project's baked WebGL2 translations (`shard shaders bake`), or their URL: on WebGL2, the
   * shaders they cover load without naga (0064). WebGPU never reads them.
   */
  webgl2Shaders?: string | URL | BakedTranslations
  /** The graphics API and tier when render makes the device (0064): an export's `?backend=`. */
  backend?: RenderPluginOptions['backend']
  tier?: RenderPluginOptions['tier']
  /** Shader variants linked ahead of time (0056): an export's `shaders.bake.json` (0110). */
  shaderBake?: RenderPluginOptions['shaderBake']
  inputSource?: InputSource
  /** Where sound goes (`platform.audio`). Without one, audio records voices (headless). */
  audio?: AudioBackend
  /**
   * The host: saves and settings go to its `storage`, and saved scenes reload from its files.
   * Without one, saves live in memory.
   */
  platform?: Platform
}

/**
 * One engine plugin a project host adds: by its manifest name, or `always`. Each is its own export
 * so a bundle that imports some of them (an export, 0110) leaves the others' packages out.
 */
export interface EnginePlugin {
  readonly name: string
  /** Added whatever the manifest says. */
  readonly always?: boolean
  /** Component namespaces it brings: a scene using `sprite/…` needs `sprite` (0110). */
  readonly namespaces?: readonly string[]
  add(app: App, ctx: PluginContext, names: ReadonlySet<string>): void
}

// A project host imports sources (glTF among them) whatever the manifest installs.
export const engineGltf: EnginePlugin = {
  name: 'gltf',
  always: true,
  add: (app) => app.addPlugin(gltfPlugin),
}
export const engineCoreTransform: EnginePlugin = {
  name: 'core/transform',
  namespaces: ['transform'],
  add: (app) => app.addPlugin(TransformPlugin),
}
export const engineRender: EnginePlugin = {
  name: 'render',
  namespaces: ['render'],
  add: (app, ctx) =>
    app.addPlugin(
      renderPlugin({
        gpu: ctx.gpu,
        canvas: ctx.canvas,
        target: ctx.target,
        webgl2: ctx.webgl2Shaders ? { shaders: ctx.webgl2Shaders } : undefined,
        shaderBake: ctx.shaderBake,
        backend: ctx.backend,
        tier: ctx.tier,
      }),
    ),
}
export const engineRenderForward: EnginePlugin = {
  name: 'render/forward',
  add(app, ctx) {
    app.addPlugin(forwardPlugin({ msaa: ctx.manifest.window.msaa === 1 ? 1 : 4 }))
    // Project materials may declare noise slots (project.material({ noise })).
    app.addPlugin(materialNoisePlugin)
  },
}
export const engineSprite: EnginePlugin = {
  name: 'sprite',
  namespaces: ['sprite'],
  add: (app) => app.addPlugin(spritePlugin),
}
export const engineText: EnginePlugin = {
  name: 'text',
  namespaces: ['text'],
  add: (app) => app.addPlugin(textPlugin),
}
export const engineParticles: EnginePlugin = {
  name: 'particles',
  namespaces: ['particles'],
  add: (app) => app.addPlugin(particlesPlugin),
}
export const engineAnimation: EnginePlugin = {
  name: 'animation',
  namespaces: ['animation'],
  add: (app) => app.addPlugin(animationPlugin),
}
export const engineDice: EnginePlugin = {
  name: 'dice',
  namespaces: ['dice'],
  add: (app) => app.addPlugin(dicePlugin()),
}
export const enginePhysics3d: EnginePlugin = {
  name: 'physics3d',
  namespaces: ['physics'],
  add: (app) => app.addPlugin(physics3dPlugin()),
}
export const enginePhysics2d: EnginePlugin = {
  name: 'physics2d',
  namespaces: ['physics'],
  add: (app) => app.addPlugin(physics2dPlugin()),
}
export const engineInput: EnginePlugin = {
  name: 'input',
  add: (app, ctx) => app.addPlugin(inputPlugin({ source: ctx.inputSource })),
}
export const engineGestures: EnginePlugin = {
  name: 'gestures',
  add: (app) => app.addPlugin(gesturesPlugin),
}
export const engineControls: EnginePlugin = {
  name: 'controls',
  namespaces: ['controls'],
  add: (app) => app.addPlugin(controlsPlugin),
}
export const engineAudio: EnginePlugin = {
  name: 'audio',
  namespaces: ['audio'],
  add: (app, ctx) => app.addPlugin(audioPlugin({ backend: ctx.audio })),
}
export const engineAudioEvents: EnginePlugin = {
  name: 'audio/events',
  add: (app) => app.addPlugin(audioEventsPlugin()),
}
export const engineAudioMixer: EnginePlugin = {
  name: 'audio/mixer',
  add: (app) => app.addPlugin(audioMixerPlugin()),
}
export const engineAudioAcoustics: EnginePlugin = {
  name: 'audio/acoustics',
  add: (app) => app.addPlugin(audioAcousticsPlugin()),
}
export const engineAudioMusic: EnginePlugin = {
  name: 'audio/music',
  add: (app) => app.addPlugin(audioMusicPlugin()),
}
export const engineUi: EnginePlugin = {
  name: 'ui',
  namespaces: ['ui'],
  add: (app) => app.addPlugin(uiPlugin),
}
export const engineNav: EnginePlugin = {
  name: 'nav',
  namespaces: ['nav'],
  add(app, ctx) {
    app.addPlugin(navPlugin)
    // Tiles build on Node's worker threads (0112); browsers don't walk agents, and build inline.
    const workers = ctx.platform?.name === 'node' ? ctx.platform.workers : undefined
    if (workers) app.world.insertResource(NavWorkers, workers)
  },
}
export const engineNavGrid: EnginePlugin = {
  name: 'nav/grid',
  namespaces: ['nav'],
  add(app, _ctx, names) {
    if (!names.has('nav')) app.addPlugin(navGridPlugin)
  },
}
export const engineStructure: EnginePlugin = {
  name: 'structure',
  namespaces: ['structure'],
  add(app, _ctx, names) {
    // The model always; meshes with a display; colliders with physics3d, nav sources with nav (0112).
    app.addPlugin(names.has('render/forward') ? structurePlugin : structureModelPlugin)
    if (names.has('physics3d')) app.addPlugin(structurePhysicsPlugin)
    if (names.has('nav')) app.addPlugin(structureNavPlugin)
  },
}
export const engineTerrain: EnginePlugin = {
  name: 'terrain',
  namespaces: ['terrain'],
  add: (app, ctx) =>
    app.addPlugin(terrainPlugin({ workers: ctx.platform?.workers, fs: ctx.platform?.fs })),
}
export const engineScatter: EnginePlugin = {
  name: 'scatter',
  namespaces: ['scatter'],
  add: (app, ctx) => app.addPlugin(scatterPlugin({ workers: ctx.platform?.workers })),
}
export const engineNature: EnginePlugin = {
  name: 'nature',
  namespaces: ['nature'],
  add: (app) => app.addPlugin(naturePlugin),
}
export const engineWind: EnginePlugin = {
  name: 'wind',
  namespaces: ['wind'],
  add(app) {
    if (!app.hasPlugin('wind')) app.addPlugin(windPlugin)
  },
}
// Water works headless (waterAt), so servers keep it too.
export const engineWater: EnginePlugin = {
  name: 'water',
  namespaces: ['water'],
  add: (app) => app.addPlugin(waterPlugin()),
}
export const engineWaterWaves: EnginePlugin = {
  name: 'water/waves',
  add: (app) => app.addPlugin(oceanWavesPlugin()),
}
// noise.sample and noise.stats, whatever the manifest says: graphs are data every project can use.
export const engineNoise: EnginePlugin = {
  name: 'noise',
  always: true,
  add: (app) => app.addPlugin(noisePlugin),
}
export const engineScene: EnginePlugin = {
  name: 'scene',
  always: true,
  add: (app) => app.addPlugin(ScenePlugin),
}
export const engineEffects: EnginePlugin = {
  name: 'effects',
  namespaces: ['effects'],
  add: (app) => app.addPlugin(effectsPlugin),
}
// Generators are code every project can define: outputs, GeneratorInstance, procgen.* methods.
export const engineProcgen: EnginePlugin = {
  name: 'procgen',
  always: true,
  add: (app, ctx) =>
    app.addPlugin(
      procgenPlugin({
        fs: ctx.platform?.fs,
        storage: ctx.platform?.storage,
        cacheSize: (ctx.manifest.procgen?.cacheSize ?? 256) * 1024 * 1024,
      }),
    ),
}
export const engineSave: EnginePlugin = {
  name: 'save',
  always: true,
  add: (app, ctx) =>
    app.addPlugin(
      savePlugin({
        storage: ctx.platform?.storage,
        fs: ctx.platform?.fs,
        engine: ctx.manifest.engine,
      }),
    ),
}

/** Every engine plugin, in the order a host adds them. */
export const enginePlugins: readonly EnginePlugin[] = [
  engineGltf,
  engineCoreTransform,
  engineRender,
  engineRenderForward,
  engineSprite,
  engineText,
  engineParticles,
  engineAnimation,
  engineDice,
  enginePhysics3d,
  enginePhysics2d,
  engineInput,
  engineGestures,
  engineControls,
  engineAudio,
  engineAudioEvents,
  engineAudioMixer,
  engineAudioAcoustics,
  engineAudioMusic,
  engineUi,
  engineNav,
  engineNavGrid,
  engineStructure,
  engineTerrain,
  engineScatter,
  engineNature,
  engineWind,
  engineWater,
  engineWaterWaves,
  engineNoise,
  engineScene,
  engineEffects,
  engineProcgen,
  engineSave,
]

/** The export name of an engine plugin's row: `render/forward` is `engineRenderForward`. */
export function enginePluginExport(name: string): string {
  return `engine${name
    .split(/[/-]/)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('')}`
}

/** Plugins `display: false` leaves out. Their components still load as data. */
const DISPLAY_PLUGINS = [
  'render',
  'render/forward',
  'sprite',
  'text',
  'particles',
  'animation',
  'dice',
  'input',
  'gestures',
  'controls',
  'audio',
  'audio/events',
  'audio/mixer',
  'audio/acoustics',
  'audio/music',
  'ui',
  'scatter',
  'effects',
]

/**
 * The manifest's plugins plus everything they imply (sprite → render/forward → render…), without
 * display plugins when `display` is false. `always` plugins aren't listed.
 */
export function resolvePlugins(
  manifest: ManifestValue,
  options: { display?: boolean } = {},
): Set<string> {
  const names = new Set<string>(manifest.plugins)
  if (
    names.has('sprite') ||
    names.has('text') ||
    names.has('particles') ||
    names.has('animation') ||
    names.has('dice')
  )
    names.add('render/forward')
  if (names.has('controls')) {
    names.add('gestures')
    names.add('render/forward')
  }
  if (names.has('audio/acoustics')) names.add('audio/mixer')
  if (names.has('audio/music') || names.has('audio/mixer')) names.add('audio/events')
  if (names.has('audio/events')) names.add('audio')
  if (names.has('gestures')) names.add('input')
  if (names.has('render/forward')) {
    names.add('render')
    names.add('core/transform')
  }
  // Foliage and trees sway with the shared wind; servers keep it (it isn't display-only).
  if (names.has('water/waves')) names.add('water')
  if (names.has('scatter') || names.has('nature') || names.has('water')) names.add('wind')
  if (
    names.has('physics3d') ||
    names.has('physics2d') ||
    names.has('audio') ||
    names.has('ui') ||
    names.has('nav') ||
    names.has('nav/grid') ||
    names.has('structure') ||
    names.has('terrain') ||
    names.has('scatter') ||
    names.has('wind')
  )
    names.add('core/transform')
  if (options.display === false) for (const name of DISPLAY_PLUGINS) names.delete(name)
  return names
}

/**
 * Adds the rows to `app` in order: the `always` ones, and the others when `names` has them. `rows`
 * is `enginePlugins` in a host, or the rows an export imported (in the same order).
 */
export function addEnginePlugins(
  app: App,
  rows: readonly EnginePlugin[],
  names: ReadonlySet<string>,
  ctx: PluginContext,
): void {
  for (const row of rows) if (row.always || names.has(row.name)) row.add(app, ctx, names)
}
