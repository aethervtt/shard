import { ShardError } from '@shard/core'
import { forwardPlugin, renderPlugin } from '@shard/render'
import { App, animationFrameRunner } from '@shard/runtime'
import { TransformPlugin } from '@shard/transform'
import { galaxyPlugin, Population } from './galaxy'
import { scenePlugin } from './scene'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLElement
const demo = location.hash === '#galaxy' ? 'galaxy' : 'scene'
document.body.dataset.demo = demo

const app = new App().addPlugin(renderPlugin({ canvas, features: ['timestamp-query'] }))
if (demo === 'galaxy') {
  app.addPlugin(galaxyPlugin({ stars: 100_000, seed: 7 }))
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-change]')) {
    button.addEventListener('click', () => {
      const population = app.world.resource(Population)
      population.target = Math.max(0, population.target + Number(button.dataset.change))
    })
  }
} else {
  app.addPlugin(TransformPlugin, forwardPlugin(), scenePlugin)
}
app.setRunner(animationFrameRunner())
window.addEventListener('hashchange', () => location.reload())

// Exposed for poking at from the devtools console.
Object.assign(globalThis, { app })

app.run().catch((err: unknown) => {
  hud.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  console.error(err)
})
