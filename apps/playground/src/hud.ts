import { defineSystem, ProfilerResource, Update, type World } from '@aethervtt/shard-core'
import { Gpu, PassCosts, RenderScale, RenderStats, setOverlays } from '@aethervtt/shard-render'
import { DisplayRate, definePlugin, gpuPassOverlap, Time } from '@aethervtt/shard-runtime'
import { backendLine, healthLines } from './backend'

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

/**
 * GPU pass timings where they overlap (0075): on tile-based GPUs (Apple's) passes run concurrently
 * and each pass's timestamps include waiting for earlier work, so they sum past the frame and say
 * nothing about which pass costs most. The HUD says so, in grey, and ranks passes by the latest
 * ablation (`perf.ablate`) when one has run.
 */
function passLines(world: World): string[] {
  const profiler = world.tryResource(ProfilerResource)
  const overlap = profiler ? gpuPassOverlap(profiler) : undefined
  if (!overlap?.overlapping) return []
  const lines = [
    `gpu passes overlapping: ${overlap.passesMs.toFixed(1)} ms of passes in a ${overlap.frameMs.toFixed(1)} ms frame`,
  ]
  const ablation = world.tryResource(PassCosts)?.latest
  if (!ablation) lines.push('  not ranked: perf.ablate measures each pass')
  else {
    const ranked = [...ablation.passes].sort((a, b) => b.ms - a.ms).slice(0, 4)
    lines.push(`  by ablation: ${ranked.map((p) => `${p.pass} ${p.ms.toFixed(2)}`).join(', ')} ms`)
  }
  return lines
}

/**
 * FPS, render scale and draw stats, four times a second. Frame time, the slowest spans and the GPU
 * frame are the engine's `perf` overlay (0074), drawn over the scene; `?perf=0` hides it.
 */
const hud = defineSystem({
  name: 'playground/hud',
  setup: (world) => {
    applyRenderScale(world)
    if (new URLSearchParams(location.search).get('perf') !== '0') setOverlays(world, { perf: true })
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
    const canvas = document.getElementById('viewport') as HTMLCanvasElement
    const scale = world.tryResource(RenderScale)
    const k = scale?.windowViews ? scale.scale : 1
    const display = world.tryResource(DisplayRate)
    state.el.textContent = [
      `entities  ${world.entityCount.toLocaleString()}`,
      `fps       ${fps.toFixed(0)}   ${canvas.width}x${canvas.height}`,
      `render    ${Math.round(canvas.width * k)}x${Math.round(canvas.height * k)}   ${k.toFixed(2)} ${scale?.mode ?? ''}${scale?.signal && scale.signal !== 'none' ? ` (${scale.signal})` : ''}`,
      `display   ${display ? `${display.hz} Hz (${display.source})` : '?'}   budget ${scale ? scale.budgetMs.toFixed(1) : '?'} ms`,
      backendLine(world.resource(Gpu)),
      ...healthLines(world),
      stats
        ? `${view}: ${stats.visible} visible, ${stats.culled} culled, ${stats.drawCalls} draws`
        : 'no camera view',
      ...hudExtras.flatMap((extra) => extra(world)),
    ].join('\n')
    const passes = passLines(world)
    if (passes.length > 0) {
      const grey = document.createElement('span')
      grey.style.color = '#999'
      grey.textContent = `\n${passes.join('\n')}`
      state.el.append(grey)
    }
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
