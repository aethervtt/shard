import { defineSystem, Update, type World } from '@aethervtt/shard-core'
import type { GpuBackendChoice, GpuContext, Webgl2ContextOptions } from '@aethervtt/shard-gpu'
import { Gpu, RenderHealth } from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'

// The Backend switch (0064). Every page asks for its graphics API through `?backend=`, which the
// Backend dropdown sets: 'auto' runs WebGPU where it works and WebGL2 elsewhere; 'webgpu' and
// 'webgl2' insist. Two more URL-only switches: `?tier=baseline` previews the baseline tier on WebGPU
// (a compatibility-mode device), and `?gl=minimum` holds WebGL2 to its floor.

const params = new URLSearchParams(location.search)

export const BACKENDS: readonly GpuBackendChoice[] = ['auto', 'webgpu', 'webgl2']

export function backendChoice(): GpuBackendChoice {
  const value = params.get('backend')
  return value === 'webgpu' || value === 'webgl2' ? value : 'auto'
}

/** What `createGpuContext` and `renderPlugin` take from the URL. */
export function graphicsOptions(): {
  backend: GpuBackendChoice
  tier?: 'baseline'
  webgl2: Webgl2ContextOptions
} {
  return {
    backend: backendChoice(),
    tier: params.get('tier') === 'baseline' ? 'baseline' : undefined,
    // The playground is a dev page: GL errors are checked after every submit.
    webgl2: { profile: params.get('gl') === 'minimum' ? 'minimum' : 'native', checkErrors: true },
  }
}

/**
 * The Backend dropdown, first in `container` (or last). Choosing reloads the page with
 * `?backend=` set; the hash (the demo) stays.
 */
export function addBackendSelect(
  container: HTMLElement,
  at: 'start' | 'end' = 'start',
): HTMLSelectElement {
  const select = document.createElement('select')
  select.id = 'backend'
  select.title = 'Graphics backend (0064): auto picks WebGPU, else WebGL2'
  for (const value of BACKENDS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    select.append(option)
  }
  select.value = backendChoice()
  select.addEventListener('change', () => {
    const url = new URL(location.href)
    if (select.value === 'auto') url.searchParams.delete('backend')
    else url.searchParams.set('backend', select.value)
    location.href = url.href
  })
  const label = document.createElement('label')
  label.className = 'backend'
  label.append('Backend ', select)
  if (at === 'start') container.prepend(label)
  else container.append(label)
  return select
}

/** "backend   webgl2 · baseline  (no-webgpu)": the API, the tier, and why auto skipped better ones. */
export function backendLine(gpu: GpuContext): string {
  const why = gpu.reasons.length > 0 ? `  (${gpu.reasons.map((r) => r.code).join(', ')})` : ''
  return `backend   ${gpu.backend} · ${gpu.tier}${why}`
}

/** "health    degraded: render/feature-unsupported (terrain)": RenderHealth, when it isn't ok. */
export function healthLines(world: World): string[] {
  const health = world.tryResource(RenderHealth)
  if (!health) return []
  const issues = health.issues
    .filter((i) => i.severity === 'degraded')
    .map((i) => `${i.code}${i.ref ? ` (${i.ref})` : ''}`)
  return [`health    ${health.state}${issues.length > 0 ? `: ${issues.join(', ')}` : ''}`]
}

/**
 * Features the scene uses that the backend can't run, over the canvas: on the baseline tier a
 * compute-only demo says so instead of showing an empty frame.
 */
const unsupportedOverlay = defineSystem({
  name: 'playground/unsupported-overlay',
  setup: () => {
    const el = document.createElement('div')
    el.id = 'unsupported'
    el.style.cssText =
      'position:fixed;right:12px;bottom:12px;max-width:420px;padding:10px 12px;border-radius:6px;' +
      'background:rgba(60,20,20,0.85);color:#ffd9d0;font:12px ui-monospace,monospace;white-space:pre-wrap;display:none'
    document.body.append(el)
    return { el, shown: '' }
  },
  run: (state, world) => {
    const health = world.tryResource(RenderHealth)
    const gpu = world.tryResource(Gpu)
    const unsupported = (health?.issues ?? []).filter(
      (i) => i.code === 'render/feature-unsupported',
    )
    const text =
      unsupported.length === 0
        ? ''
        : [
            `Not on ${gpu?.backend ?? '?'} (${gpu?.tier ?? '?'} tier):`,
            ...unsupported.map((i) => `· ${i.ref ?? ''}: ${i.message}`),
          ].join('\n')
    if (text === state.shown) return
    state.shown = text
    state.el.textContent = text
    state.el.style.display = text ? 'block' : 'none'
  },
})

export const unsupportedOverlayPlugin = definePlugin({
  name: 'playground/unsupported-overlay',
  build(app) {
    app.addSystems(Update, unsupportedOverlay)
  },
})
