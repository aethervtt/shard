// The profiler in real Chromium (0074): playground pages are cross-origin isolated, so the clock
// steps 5 µs; WebGL2 times passes where the timer extension exists. Needs Playwright's Chromium
// with WebGPU (see browser-tests.ts).

import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch } from '@aethervtt/shard-verify/node'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkRequired,
  type PlaygroundServer,
  servePlayground,
  webGpuUnavailable,
} from './browser-tests'

const server: PlaygroundServer = await servePlayground()
const noWebGpu = await webGpuUnavailable(`${server.base}/`)
checkRequired('Profiler', noWebGpu)

let browser: Browser
beforeAll(async () => {
  if (!noWebGpu) browser = await chromium.launch(browserLaunch('chromium', 1))
})
afterAll(async () => {
  await browser?.close()
  await server.close()
})

interface Perf {
  clock: { resolutionMs: number; isolated: boolean }
  frame: { avg: number } | null
  gpu: 'unavailable' | { frame: { avg: number } | null; passes: { span: string }[] }
}

async function perfOf(page: Page, url: string): Promise<Perf> {
  await page.goto(url)
  await page.waitForFunction(
    () => {
      const g = globalThis as unknown as { playground?: { started: boolean; error?: string } }
      return g.playground?.started === true || g.playground?.error !== undefined
    },
    undefined,
    { timeout: timeout(60_000) },
  )
  // A second of frames, so GPU timings have landed.
  await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  return page.evaluate(() => (globalThis as unknown as { perf(): Perf }).perf())
}

describe.skipIf(noWebGpu)('the profiler in Chromium (0074)', () => {
  it(
    'playground pages are isolated, with a clock under 0.02 ms',
    async () => {
      const page = await browser.newPage()
      try {
        const response = await page.goto(`${server.base}/`)
        expect(response?.headers()['cross-origin-embedder-policy']).toBe('credentialless')
        const perf = await perfOf(page, `${server.base}/`)
        expect(perf.clock.isolated).toBe(true)
        expect(perf.clock.resolutionMs).toBeGreaterThan(0)
        expect(perf.clock.resolutionMs).toBeLessThan(0.02)
        expect(perf.frame?.avg).toBeGreaterThan(0)
      } finally {
        await page.close()
      }
    },
    timeout(90_000),
  )

  it(
    'on WebGL2, gpu:frame is non-zero with the timer extension, and unavailable without',
    async () => {
      const page = await browser.newPage()
      try {
        const perf = await perfOf(page, `${server.base}/?backend=webgl2`)
        const timer = await page.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl2')
          return gl?.getExtension('EXT_disjoint_timer_query_webgl2') != null
        })
        if (!timer) expect(perf.gpu).toBe('unavailable')
        else {
          expect(perf.gpu).not.toBe('unavailable')
          expect((perf.gpu as Exclude<Perf['gpu'], 'unavailable'>).frame?.avg).toBeGreaterThan(0)
        }
      } finally {
        await page.close()
      }
    },
    timeout(90_000),
  )

  it(
    'a capture on WebGPU has a GPU span per render pass',
    async () => {
      const page = await browser.newPage()
      try {
        await perfOf(page, `${server.base}/`)
        const result = await page.evaluate(async () => {
          const g = globalThis as unknown as {
            capture(o: object): Promise<{ trace: { traceEvents: { name: string; ph: string }[] } }>
            describe(): {
              perView: Record<string, { order: string[] }>
              order: { name: string; kind: string }[]
            }
          }
          const { trace } = await g.capture({ frames: 30 })
          const d = g.describe()
          const kinds = Object.fromEntries(d.order.map((o) => [o.name, o.kind]))
          const passes = [...new Set(Object.values(d.perView).flatMap((v) => v.order))].filter(
            (n) => kinds[n] !== 'raw',
          )
          const names = new Set(trace.traceEvents.filter((e) => e.ph === 'X').map((e) => e.name))
          return {
            passes,
            missing: passes.filter((n) => !names.has(`gpu:${n}`)),
            frame: names.has('gpu:frame'),
          }
        })
        expect(result.passes.length).toBeGreaterThan(0)
        expect(result.frame).toBe(true)
        expect(result.missing).toEqual([])
      } finally {
        await page.close()
      }
    },
    timeout(90_000),
  )
})
