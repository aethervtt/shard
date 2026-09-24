import { animationPlugin } from '@shard/animation'
import { ShardError } from '@shard/core'
import { particlesPlugin } from '@shard/particles'
import { physics2dPlugin, physics3dPlugin } from '@shard/physics'
import { connectToHub, createProtocolServer, DEFAULT_HUB_PORT } from '@shard/protocol'
import { describeRender, forwardPlugin, renderPlugin } from '@shard/render'
import { App, animationFrameRunner } from '@shard/runtime'
import { ScenePlugin } from '@shard/scene'
import { spritePlugin } from '@shard/sprite'
import { TransformPlugin } from '@shard/transform'
import { animationDemoPlugin } from './animation'
import { animgraphDemoPlugin } from './animgraph'
import { characterDemoPlugin, characterPlanetDemoPlugin } from './character'
import { character2dDemoPlugin } from './character2d'
import { crowdPlugin } from './crowd'
import { dataDemoPlugin } from './data'
import { deferredPlugin } from './deferred'
import { iblPlugin, skyPlugin } from './environment'
import { fpsGraphPlugin } from './fps-graph'
import { galaxyPlugin, Population } from './galaxy'
import { applyResolution, hudPlugin } from './hud'
import { ikDemoPlugin } from './ik'
import { lightsPlugin } from './lights'
import { particlesDemoPlugin } from './particles'
import { physics2dDemoPlugin, physicsDemoPlugin, planetDemoPlugin } from './physics'
import { postPlugin } from './post'
import { prefabsDemoPlugin } from './prefabs'
import { scenePlugin } from './scene'
import { spritesPlugin } from './sprites'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLElement
const DEMOS = [
  'scene',
  'galaxy',
  'lights',
  'ibl',
  'sky',
  'deferred',
  'crowd',
  'post',
  'sprites',
  'particles',
  'physics',
  'planet',
  'physics2d',
  'character',
  'character-planet',
  'character2d',
  'prefabs',
  'data',
  'animation',
  'animgraph',
  'ik',
] as const
const demo = DEMOS.find((d) => location.hash === `#${d}`) ?? 'scene'
document.body.dataset.demo = demo

applyResolution(canvas)
const app = new App().addPlugin(renderPlugin({ canvas, features: ['timestamp-query'] }))
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
} else if (demo === 'sprites') {
  app.addPlugin(TransformPlugin, forwardPlugin({ msaa: 1 }), spritePlugin, hudPlugin, spritesPlugin)
} else if (demo === 'particles') {
  app.addPlugin(TransformPlugin, forwardPlugin(), particlesPlugin, hudPlugin, particlesDemoPlugin)
} else if (demo === 'physics' || demo === 'planet') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics3dPlugin,
    hudPlugin,
    demo === 'physics' ? physicsDemoPlugin : planetDemoPlugin,
  )
} else if (demo === 'physics2d') {
  app.addPlugin(TransformPlugin, forwardPlugin(), physics2dPlugin, hudPlugin, physics2dDemoPlugin)
} else if (demo === 'character' || demo === 'character-planet') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    physics3dPlugin,
    hudPlugin,
    demo === 'character' ? characterDemoPlugin : characterPlanetDemoPlugin,
  )
} else if (demo === 'character2d') {
  app.addPlugin(TransformPlugin, forwardPlugin(), physics2dPlugin, hudPlugin, character2dDemoPlugin)
} else if (demo === 'prefabs') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ScenePlugin, hudPlugin, prefabsDemoPlugin)
} else if (demo === 'data') {
  app.addPlugin(TransformPlugin, forwardPlugin(), ScenePlugin, hudPlugin, dataDemoPlugin)
} else if (demo === 'animation') {
  app.addPlugin(
    TransformPlugin,
    forwardPlugin(),
    ScenePlugin,
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
    physics3dPlugin,
    animationPlugin,
    hudPlugin,
    ikDemoPlugin,
  )
} else if (demo === 'sky') {
  app.addPlugin(TransformPlugin, forwardPlugin(), hudPlugin, skyPlugin)
} else {
  app.addPlugin(TransformPlugin, forwardPlugin(), scenePlugin)
}
app.addPlugin(fpsGraphPlugin)
app.setRunner(animationFrameRunner())
window.addEventListener('hashchange', () => location.reload())

// Exposed for poking at from the devtools console.
Object.assign(globalThis, { app, describe: () => describeRender(app.world) })

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
  await app.run()
}

start().catch((err: unknown) => {
  hud.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  console.error(err)
})
