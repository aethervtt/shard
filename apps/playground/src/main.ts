import { animationPlugin } from '@aethervtt/shard-animation'
import { audioPlugin } from '@aethervtt/shard-audio'
import { controlsPlugin } from '@aethervtt/shard-controls'
import { ShardError } from '@aethervtt/shard-core'
import { fogPlugin } from '@aethervtt/shard-fog'
import { gltfPlugin } from '@aethervtt/shard-gltf'
import { gridPlugin } from '@aethervtt/shard-grid'
import { gesturesPlugin, inputPlugin } from '@aethervtt/shard-input'
import { navGridPlugin, navPlugin } from '@aethervtt/shard-nav'
import { particlesPlugin } from '@aethervtt/shard-particles'
import { physics2dPlugin, physics3dPlugin } from '@aethervtt/shard-physics'
import {
  createDomInputSource,
  createIndexedDbStorage,
  createWebPerformance,
  createWebWorkers,
} from '@aethervtt/shard-platform-web'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import { connectToHub, createProtocolServer, DEFAULT_HUB_PORT } from '@aethervtt/shard-protocol'
import {
  ablatePasses,
  describeRender,
  forwardPlugin,
  Graph,
  pick,
  renderPlugin,
  Views,
} from '@aethervtt/shard-render'
import { materialNoisePlugin } from '@aethervtt/shard-render/noise'
import { surfacePlugin } from '@aethervtt/shard-render/surface'
import {
  App,
  animationFrameRunner,
  capturePerf,
  describeBudgets,
  describePerf,
  PerfBudgets,
  type PerfBudgetsData,
  type PerfCaptureOptions,
} from '@aethervtt/shard-runtime'
import { savePlugin } from '@aethervtt/shard-save'
import { scatterPlugin } from '@aethervtt/shard-scatter'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { spritePlugin } from '@aethervtt/shard-sprite'
import { interiorLightingPlugin, structurePlugin } from '@aethervtt/shard-structure'
import { terrainPlugin } from '@aethervtt/shard-terrain'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { uiPlugin } from '@aethervtt/shard-ui'
import { vectorPlugin } from '@aethervtt/shard-vector'
import { metricsPlugin } from '@aethervtt/shard-verify/metrics'
import { installCapturePage } from '@aethervtt/shard-verify/page'
import { animationDemoPlugin } from './animation'
import { animgraphDemoPlugin } from './animgraph'
import { atmosphereDemoPlugin } from './atmosphere'
import { audioDemoPlugin, webAudio } from './audio'
import { addBackendSelect, graphicsOptions, unsupportedOverlayPlugin } from './backend'
import { characterDemoPlugin, characterPlanetDemoPlugin } from './character'
import { character2dDemoPlugin } from './character2d'
import { crowdPlugin } from './crowd'
import { dataDemoPlugin } from './data'
import { deferredPlugin } from './deferred'
import { DEMOS } from './demos'
import { iblPlugin, skyPlugin } from './environment'
import { fpsGraphPlugin } from './fps-graph'
import { galaxyPlugin, Population } from './galaxy'
import { gridsDemoPlugin } from './grids'
import { heightfieldDemoPlugin } from './heightfield'
import { applyResolution, hudPlugin } from './hud'
import { ikDemoPlugin } from './ik'
import { interiorDemoPlugin } from './interior'
import { lensDemoPlugin } from './lens'
import { lightsPlugin } from './lights'
import { lights2dDemoPlugin } from './lights2d'
import { nav2dDemoPlugin, navDemoPlugin } from './nav'
import { noiseDemoPlugin } from './noise'
import { particlesDemoPlugin } from './particles'
import { physics2dDemoPlugin, physicsDemoPlugin, planetDemoPlugin } from './physics'
import { addDemoPicker } from './picker'
import { postPlugin } from './post'
import { prefabsDemoPlugin } from './prefabs'
import { procgenDemoPlugin } from './procgen'
import { saveDemoPlugin } from './save'
import { scatterDemoPlugin } from './scatter'
import { scenePlugin } from './scene'
import { spritesPlugin } from './sprites'
import { tabletopDemoPlugin } from './tabletop'
import { terrainDemoPlugin } from './terrain'
import { uiDemoPlugin } from './ui'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLElement
const demo = DEMOS.find((d) => location.hash === `#${d}`) ?? 'scene'
document.body.dataset.demo = demo

/**
 * Camera controls (0060): pointer input on the canvas, gestures, and Orbit and Map controls, which
 * demos put on their cameras. Demos that already add the input plugin pass false.
 */
const controls = (input = true) => [
  ...(input ? [inputPlugin({ source: createDomInputSource(canvas) })] : []),
  gesturesPlugin,
  controlsPlugin,
]

applyResolution(canvas)
const panel = document.getElementById('panel') as HTMLElement
addBackendSelect(panel)
addDemoPicker(panel, demo)
const app = new App().addPlugin(
  renderPlugin({ canvas, features: ['timestamp-query'], ...graphicsOptions() }),
  unsupportedOverlayPlugin,
)
if (demo === 'galaxy') {
  app.addPlugin(galaxyPlugin({ stars: 100_000, seed: 7 }))
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-change]')) {
    button.addEventListener('click', () => {
      const population = app.world.resource(Population)
      population.target = Math.max(0, population.target + Number(button.dataset.change))
    })
  }
} else if (demo === 'lights') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ...controls(), hudPlugin, lightsPlugin)
} else if (demo === 'ibl') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ...controls(), hudPlugin, iblPlugin)
} else if (demo === 'deferred') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin({ msaa: 1 }),
    ...controls(),
    hudPlugin,
    deferredPlugin,
  )
} else if (demo === 'crowd') {
  app.addPlugin(TransformPlugin, forwardPlugin({ msaa: 1 }), ...controls(), hudPlugin, crowdPlugin)
} else if (demo === 'post') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ...controls(), hudPlugin, postPlugin)
} else if (demo === 'lens') {
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, lensDemoPlugin)
} else if (demo === 'sprites') {
  app.addPlugin(TransformPlugin, forwardPlugin({ msaa: 1 }), spritePlugin, hudPlugin, spritesPlugin)
} else if (demo === 'particles') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    particlesPlugin,
    ...controls(),
    hudPlugin,
    particlesDemoPlugin,
  )
} else if (demo === 'physics' || demo === 'planet') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics3dPlugin(),
    ...controls(),
    hudPlugin,
    demo === 'physics' ? physicsDemoPlugin : planetDemoPlugin,
  )
} else if (demo === 'physics2d') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics2dPlugin(),
    ...controls(),
    hudPlugin,
    physics2dDemoPlugin,
  )
} else if (demo === 'character' || demo === 'character-planet') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics3dPlugin(),
    hudPlugin,
    demo === 'character' ? characterDemoPlugin : characterPlanetDemoPlugin,
  )
} else if (demo === 'character2d') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics2dPlugin(),
    hudPlugin,
    character2dDemoPlugin,
  )
} else if (demo === 'prefabs') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    ...controls(),
    hudPlugin,
    prefabsDemoPlugin,
  )
} else if (demo === 'data') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    ...controls(),
    hudPlugin,
    dataDemoPlugin,
  )
} else if (demo === 'animation') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    gltfPlugin,
    animationPlugin,
    ...controls(),
    hudPlugin,
    animationDemoPlugin,
  )
} else if (demo === 'animgraph') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    animationPlugin,
    ...controls(),
    hudPlugin,
    animgraphDemoPlugin,
  )
} else if (demo === 'ik') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    physics3dPlugin(),
    animationPlugin,
    hudPlugin,
    ikDemoPlugin,
  )
} else if (demo === 'audio') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    audioPlugin({ backend: webAudio() }),
    hudPlugin,
    audioDemoPlugin,
  )
} else if (demo === 'ui') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    inputPlugin({ source: createDomInputSource(canvas) }),
    ...controls(false),
    uiPlugin,
    hudPlugin,
    uiDemoPlugin,
  )
} else if (demo === 'nav') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics3dPlugin(),
    navPlugin,
    ...controls(),
    hudPlugin,
    navDemoPlugin,
  )
} else if (demo === 'save') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    physics3dPlugin(),
    inputPlugin({ source: createDomInputSource(canvas) }),
    audioPlugin({ backend: webAudio() }),
    uiPlugin,
    // Saves and settings survive a page reload: they live in IndexedDB.
    savePlugin({ storage: createIndexedDbStorage('shard-playground') }),
    hudPlugin,
    saveDemoPlugin,
  )
} else if (demo === 'nav2d') {
  app.addPlugin(TransformPlugin, forwardPlugin(), navGridPlugin, hudPlugin, nav2dDemoPlugin)
} else if (demo === 'lights2d') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin({ msaa: 1 }),
    spritePlugin,
    hudPlugin,
    lights2dDemoPlugin,
  )
} else if (demo === 'grids') {
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, gridsDemoPlugin)
} else if (demo === 'noise') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    materialNoisePlugin,
    ...controls(),
    hudPlugin,
    noiseDemoPlugin,
  )
} else if (demo === 'procgen') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    ...controls(),
    hudPlugin,
    procgenDemoPlugin,
  )
} else if (demo === 'terrain') {
  app.addPlugin(TransformPlugin, forwardPlugin(), terrainPlugin(), hudPlugin, terrainDemoPlugin)
} else if (demo === 'heightfield') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    terrainPlugin({ workers: createWebWorkers() }),
    hudPlugin,
    heightfieldDemoPlugin,
  )
} else if (demo === 'scatter') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    terrainPlugin(),
    ScenePlugin,
    procgenPlugin(),
    scatterPlugin(),
    hudPlugin,
    scatterDemoPlugin,
  )
} else if (demo === 'atmosphere') {
  app.addPlugin(TransformPlugin, forwardPlugin(), terrainPlugin(), hudPlugin, atmosphereDemoPlugin)
} else if (demo === 'tabletop') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    structurePlugin,
    surfacePlugin,
    gridPlugin,
    vectorPlugin,
    fogPlugin,
    ...controls(),
    hudPlugin,
    tabletopDemoPlugin,
  )
} else if (demo === 'interior') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    structurePlugin,
    interiorLightingPlugin,
    ...controls(),
    hudPlugin,
    interiorDemoPlugin,
  )
} else if (demo === 'sky') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ...controls(), hudPlugin, skyPlugin)
} else {
  app.addPlugin(TransformPlugin, forwardPlugin(), ...controls(), hudPlugin, scenePlugin)
}
app.addPlugin(fpsGraphPlugin)
// `?capture`: a page `shard capture` (0062) can drive and record, as verify.html is.
const capturing = new URLSearchParams(location.search).has('capture')
if (capturing) {
  app.addPlugin(metricsPlugin({ performance: createWebPerformance(), renderer: 'shard' }))
}
app.setRunner(animationFrameRunner())
window.addEventListener('hashchange', () => location.reload())

// Exposed for poking at from the devtools console, and for demos.test.ts: `started` once the app
// runs, `error` if it couldn't.
const playground = {
  demo,
  started: false,
  error: undefined as string | undefined,
  /** What's under a pixel of the main view: for tests comparing backends (0064). */
  pick: async (x: number, y: number) => {
    const hit = await pick(app.world, undefined, x, y)
    return hit && { entity: hit.entity, path: hit.path, distance: hit.distance }
  },
}
Object.assign(globalThis, {
  app,
  describe: () => describeRender(app.world),
  /** The profiler's aggregates and clock (0074), as `perf.describe` returns them. */
  perf: () => describePerf(app.world),
  /** The budgets and the latest measurements against them (0075), as `perf.budgets` returns them. */
  budgets: (scenario?: string) => describeBudgets(app.world, { scenario }),
  /** A capture of the next frames (0074): its summary, and the trace inline. */
  capture: (options: PerfCaptureOptions = {}) => capturePerf(app.world, options),
  playground,
})

/**
 * Performance budgets (0075), from the repo through the dev server: `perf.budgets`, the perf
 * overlay's slices and foliage's target. `?scenario=scatter-walk` declares the page's scenario. A
 * page can't read its CPU model, so it detects no machine unless `?machine=laptop` names it.
 */
async function loadBudgets() {
  const params = new URLSearchParams(location.search)
  const [budgets, machines] = await Promise.all([
    import('../../../bench/perf/budgets.json'),
    import('../../../bench/perf/machines.json'),
  ])
  app.insertResource(PerfBudgets, {
    budgets: budgets.default as unknown as PerfBudgetsData['budgets'],
    machines: machines.default as unknown as PerfBudgetsData['machines'],
    source: 'bench/perf/budgets.json',
    ...(params.get('machine') ? { machine: params.get('machine')! } : {}),
  })
  const scenario = params.get('scenario')
  if (scenario) app.perfScenario = scenario
}

/**
 * With ?hub (or ?hub=ws://host:port), the page dials out to a protocol hub (`shard serve` or
 * `shard mcp --attach`) so an agent can inspect and drive it. Off by default: no hub, no noise.
 */
async function start() {
  await loadBudgets()
  await app.init()
  const hubParam = new URLSearchParams(location.search).get('hub')
  if (hubParam !== null) {
    const url = hubParam || `ws://127.0.0.1:${DEFAULT_HUB_PORT}`
    const server = createProtocolServer(app, { frames: 'loop' })
    connectToHub(url, server, {
      name: `playground:${demo}`,
      onStatus: (on) => console.info(`[shard] hub ${on ? 'connected' : 'disconnected'}: ${url}`),
    })
  }
  playground.started = true
  if (capturing) {
    app.markUsable()
    installCapturePage(app, { steps: captureSteps() })
  }
  await app.run()
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    const off = app.onFrame(() => {
      off()
      resolve()
    })
  })

/**
 * Steps a `shard capture` plan runs on `?capture` pages (0074, 0075): `profile` captures frames
 * (summary and trace), `ablate` measures render-graph passes by ablation (default: every node the
 * last frame ran), `render` returns `render.describe`.
 */
function captureSteps(): Record<string, (args: unknown) => unknown> {
  return {
    profile: async (args) => {
      const { frames = 600 } = (args ?? {}) as { frames?: number }
      return capturePerf(app.world, { frames })
    },
    ablate: async (args) => {
      const options = (args ?? {}) as {
        passes?: string[]
        frames?: number
        rounds?: number
        together?: boolean
        groups?: Record<string, string[]>
      }
      let passes = options.passes ?? []
      if (passes.length === 0) {
        const perView = app.world.resource(Graph).describe().perView as Record<
          string,
          { order: string[] }
        >
        const ran = new Set<string>()
        for (const view of app.world.resource(Views).list) {
          for (const name of perView[view.name]?.order ?? []) ran.add(name)
        }
        passes = [...ran]
      }
      return ablatePasses(app.world, { ...options, passes }, nextFrame)
    },
    render: () => describeRender(app.world),
  }
}

start().catch((err: unknown) => {
  hud.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  playground.error = hud.textContent
  console.error(err)
})
