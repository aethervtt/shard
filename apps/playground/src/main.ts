import { ShardError } from '@shard/core'
import { App, animationFrameRunner } from '@shard/runtime'
import { galaxyPlugin, Population } from './galaxy'

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const hud = document.getElementById('hud') as HTMLElement

const app = new App().addPlugin(galaxyPlugin({ canvas, stars: 100_000, seed: 7 }))
app.setRunner(animationFrameRunner())

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-change]')) {
  button.addEventListener('click', () => {
    const population = app.world.resource(Population)
    population.target = Math.max(0, population.target + Number(button.dataset.change))
  })
}

// Exposed for poking at from the devtools console.
Object.assign(globalThis, { app })

app.run().catch((err: unknown) => {
  hud.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  console.error(err)
})
