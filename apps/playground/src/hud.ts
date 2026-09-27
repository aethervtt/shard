import { defineSystem, ProfilerResource, Update, type World } from '@shard/core'
import { RenderScale, RenderStats } from '@shard/render'
import { DisplayRate, definePlugin, Time } from '@shard/runtime'

/** Extra HUD lines a demo adds (e.g. physics body counts), read each refresh. */
export const hudExtras: ((world: World) => string[])[] = []

/** `?scale=0.75` pins the render scale; `?scale=auto` (the default) lets it follow the GPU. */
function applyRenderScale(world: World): void {
  const param = new URLSearchParams(location.search).get('scale')
  const scale = world.tryResource(RenderScale)
  if (!param || !scale) return
  if (param === 'auto') scale.mode = 'auto'
  else if (Number(param) > 0) {
    scale.mode = 'fixed'
    scale.scale = Number(param)
  }
}

/** FPS, draw stats, and the slowest systems and GPU passes, four times a second. */
const hud = defineSystem({
  name: 'playground/hud',
  setup: (world) => {
    applyRenderScale(world)
    return { el: document.getElementById('hud') as HTMLElement, last: 0, frames: 0 }
  },
  run: (state, world) => {
    state.frames++
    const time = world.resource(Time).elapsed
    if (time - state.last < 0.25) return
    const fps = state.frames / (time - state.last)
    state.last = time
    state.frames = 0
    const [view, stats] = [...world.resource(RenderStats)][0] ?? ['none', undefined]
    const timings = world.resource(ProfilerResource).all()
    const rows = Object.entries(timings)
      .filter(([name]) => !name.startsWith('playground/hud') && name !== 'gpu:frame')
      .sort((a, b) => b[1].avg - a[1].avg)
      .slice(0, 10)
      .map(([name, t]) => `${name.padEnd(28)} ${t.avg.toFixed(2).padStart(6)} ms`)
    const gpuFrame = timings['gpu:frame']?.avg ?? 0
    const canvas = document.getElementById('viewport') as HTMLCanvasElement
    const scale = world.tryResource(RenderScale)
    const k = scale?.windowViews ? scale.scale : 1
    const display = world.tryResource(DisplayRate)
    state.el.textContent = [
      `entities  ${world.entityCount.toLocaleString()}`,
      `fps       ${fps.toFixed(0)}   ${canvas.width}x${canvas.height}`,
      `render    ${Math.round(canvas.width * k)}x${Math.round(canvas.height * k)}   ${k.toFixed(2)} ${scale?.mode ?? ''}${scale?.signal && scale.signal !== 'none' ? ` (${scale.signal})` : ''}`,
      `display   ${display ? `${display.hz} Hz (${display.source})` : '?'}   budget ${scale ? scale.budgetMs.toFixed(1) : '?'} ms`,
      `gpu frame ${gpuFrame.toFixed(2)} ms`,
      stats
        ? `${view}: ${stats.visible} visible, ${stats.culled} culled, ${stats.drawCalls} draws`
        : 'no camera view',
      ...hudExtras.flatMap((extra) => extra(world)),
      '',
      ...rows,
    ].join('\n')
  },
})

export const hudPlugin = definePlugin({
  name: 'playground/hud',
  build(app) {
    app.addSystems(Update, hud)
  },
})

/** `?res=1920x1080` pins the canvas's backing size, for performance measurements. */
export function applyResolution(canvas: HTMLCanvasElement): void {
  const res = new URLSearchParams(location.search).get('res')
  const match = res && /^(\d+)x(\d+)$/.exec(res)
  if (!match) return
  const dpr = globalThis.devicePixelRatio ?? 1
  canvas.style.width = `${Number(match[1]) / dpr}px`
  canvas.style.height = `${Number(match[2]) / dpr}px`
}
