import { animationPlugin } from '@aethervtt/shard-animation'
import { audioPlugin } from '@aethervtt/shard-audio'
import { ShardError } from '@aethervtt/shard-core'
import { fogPlugin } from '@aethervtt/shard-fog'
import { gltfPlugin } from '@aethervtt/shard-gltf'
import { gridPlugin } from '@aethervtt/shard-grid'
import { inputPlugin } from '@aethervtt/shard-input'
import { navGridPlugin, navPlugin } from '@aethervtt/shard-nav'
import { particlesPlugin } from '@aethervtt/shard-particles'
import { physics2dPlugin, physics3dPlugin } from '@aethervtt/shard-physics'
import { createDomInputSource, createIndexedDbStorage } from '@aethervtt/shard-platform-web'
import { connectToHub, createProtocolServer, DEFAULT_HUB_PORT } from '@aethervtt/shard-protocol'
import { describeRender, forwardPlugin, renderPlugin } from '@aethervtt/shard-render'
import { materialNoisePlugin } from '@aethervtt/shard-render/noise'
import { App, animationFrameRunner } from '@aethervtt/shard-runtime'
import { savePlugin } from '@aethervtt/shard-save'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { spritePlugin } from '@aethervtt/shard-sprite'
import { structurePlugin } from '@aethervtt/shard-structure'
import { terrainPlugin } from '@aethervtt/shard-terrain'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { uiPlugin } from '@aethervtt/shard-ui'
import { vectorPlugin } from '@aethervtt/shard-vector'
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
import { applyResolution, hudPlugin } from './hud'
import { ikDemoPlugin } from './ik'
import { lensDemoPlugin } from './lens'
import { lightsPlugin } from './lights'
import { lights2dDemoPlugin } from './lights2d'
import { nav2dDemoPlugin, navDemoPlugin } from './nav'
import { noiseDemoPlugin } from './noise'
import { particlesDemoPlugin } from './particles'
import { physics2dDemoPlugin, physicsDemoPlugin, planetDemoPlugin } from './physics'
import { postPlugin } from './post'
import { prefabsDemoPlugin } from './prefabs'
import { procgenDemoPlugin } from './procgen'
import { saveDemoPlugin } from './save'
import { scenePlugin } from './scene'
import { spritesPlugin } from './sprites'
import { tabletopDemoPlugin } from './tabletop'
import { terrainDemoPlugin } from './terrain'
import { uiDemoPlugin } from './ui'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLElement
const demo = DEMOS.find((d) => location.hash === `#${d}`) ?? 'scene'
document.body.dataset.demo = demo

applyResolution(canvas)
addBackendSelect(document.getElementById('panel') as HTMLElement)
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
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, lightsPlugin)
} else if (demo === 'ibl') {
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, iblPlugin)
} else if (demo === 'deferred') {
  app.addPlugin(TransformPlugin, forwardPlugin({ msaa: 1 }), hudPlugin, deferredPlugin)
} else if (demo === 'crowd') {
  app.addPlugin(TransformPlugin, forwardPlugin({ msaa: 1 }), hudPlugin, crowdPlugin)
} else if (demo === 'post') {
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, postPlugin)
} else if (demo === 'lens') {
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, lensDemoPlugin)
} else if (demo === 'sprites') {
  app.addPlugin(TransformPlugin, forwardPlugin({ msaa: 1 }), spritePlugin, hudPlugin, spritesPlugin)
} else if (demo === 'particles') {
  app.addPlugin(TransformPlugin, forwardPlugin(), particlesPlugin, hudPlugin, particlesDemoPlugin)
} else if (demo === 'physics' || demo === 'planet') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics3dPlugin(),
    hudPlugin,
    demo === 'physics' ? physicsDemoPlugin : planetDemoPlugin,
  )
} else if (demo === 'physics2d') {
  app.addPlugin(TransformPlugin, forwardPlugin(), physics2dPlugin(), hudPlugin, physics2dDemoPlugin)
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
  app.addPlugin(TransformPlugin, forwardPlugin(), ScenePlugin, hudPlugin, prefabsDemoPlugin)
} else if (demo === 'data') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ScenePlugin, hudPlugin, dataDemoPlugin)
} else if (demo === 'animation') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    gltfPlugin,
    animationPlugin,
    hudPlugin,
    animationDemoPlugin,
  )
} else if (demo === 'animgraph') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
    animationPlugin,
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
  app.addPlugin(TransformPlugin, forwardPlugin(), materialNoisePlugin, hudPlugin, noiseDemoPlugin)
} else if (demo === 'procgen') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ScenePlugin, hudPlugin, procgenDemoPlugin)
} else if (demo === 'terrain') {
  app.addPlugin(TransformPlugin, forwardPlugin(), terrainPlugin(), hudPlugin, terrainDemoPlugin)
} else if (demo === 'atmosphere') {
  app.addPlugin(TransformPlugin, forwardPlugin(), terrainPlugin(), hudPlugin, atmosphereDemoPlugin)
} else if (demo === 'tabletop') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    structurePlugin,
    gridPlugin,
    vectorPlugin,
    fogPlugin,
    hudPlugin,
    tabletopDemoPlugin,
  )
} else if (demo === 'sky') {
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, skyPlugin)
} else {
  app.addPlugin(TransformPlugin, forwardPlugin(), scenePlugin)
}
app.addPlugin(fpsGraphPlugin)
app.setRunner(animationFrameRunner())
window.addEventListener('hashchange', () => location.reload())

// Exposed for poking at from the devtools console, and for demos.test.ts: `started` once the app
// runs, `error` if it couldn't.
const playground = { demo, started: false, error: undefined as string | undefined }
Object.assign(globalThis, { app, describe: () => describeRender(app.world), playground })

/**
 * With ?hub (or ?hub=ws://host:port), the page dials out to a protocol hub (`shard serve` or
 * `shard mcp --attach`) so an agent can inspect and drive it. Off by default: no hub, no noise.
 */
async function start() {
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
  await app.run()
}

start().catch((err: unknown) => {
  hud.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  playground.error = hud.textContent
  console.error(err)
})
