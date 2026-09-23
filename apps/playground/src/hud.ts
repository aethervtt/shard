import { defineSystem, ProfilerResource, Update } from '@shard/core'
import { RenderStats } from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'

/** FPS, draw stats, and the slowest systems and GPU passes, four times a second. */
const hud = defineSystem({
  name: 'playground/hud',
  setup: () => ({ el: document.getElementById('hud') as HTMLElement, last: 0, frames: 0 }),
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
    state.el.textContent = [
      `entities  ${world.entityCount.toLocaleString()}`,
      `fps       ${fps.toFixed(0)}   ${canvas.width}x${canvas.height}`,
      `gpu frame ${gpuFrame.toFixed(2)} ms`,
      stats
        ? `${view}: ${stats.visible} visible, ${stats.culled} culled, ${stats.drawCalls} draws`
        : 'no camera view',
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
