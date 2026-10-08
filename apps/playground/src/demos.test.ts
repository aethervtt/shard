// The playground's demos in real Chromium, on WebGPU and on WebGL2 (0064): each starts, draws
// something, and reports no GPU errors or page errors. On WebGL2 (the baseline tier) its health is
// ok, or names exactly what the tier can't run. Each push runs a curated set, a demo per path the
// baseline tier takes; SHARD_DEMOS=all runs every demo (the nightly sweep,
// .github/workflows/browser.yml). Needs Playwright's Chromium, with a WebGPU adapter and WebGL2
// (see browser-tests.ts).

import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch, decodePng } from '@aethervtt/shard-verify/node'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkRequired,
  type PlaygroundServer,
  servePlayground,
  webGpuUnavailable,
  webgl2Unavailable,
} from './browser-tests'
import { DEMOS, type Demo } from './demos'

const server: PlaygroundServer = await servePlayground()
const skip = await webGpuUnavailable(`${server.base}/`)
checkRequired('Playground demo', skip)
const skipGl = await webgl2Unavailable(`${server.base}/`)
checkRequired('Playground WebGL2 demo', skipGl)

/**
 * What each demo reports on the baseline tier, beyond ok: features it can't run there (compute, or
 * storage read in shaders), and lights past the tier's 128. Every other demo's health is ok.
 */
const BASELINE_ISSUES: Record<string, string[]> = {
  galaxy: ['render/feature-unsupported playground/galaxy'],
  terrain: ['render/feature-unsupported terrain'],
  atmosphere: ['render/feature-unsupported terrain'],
  lights: ['render/light-budget camera:1'],
  deferred: ['render/light-budget camera:0'],
}

/**
 * The demos each push runs: one per path the baseline tier takes, on both backends, the paths the
 * Node tests run on Dawn's compatibility mode included, since only here does a real driver compile
 * the GLSL. A path only one demo takes otherwise breaks unseen until the nightly sweep.
 */
const CURATED: readonly Demo[] = [
  'scene', // 10k instanced cubes, lit and shadowed: instance data textures, CPU culling
  'lights', // clustered lights binned on the CPU, past the tier's 128
  'ibl', // image-based lighting prefiltered into a cube map by fragment passes
  'post', // bloom, depth of field, SSAO, fog and auto exposure: passes reading depth
  'sky', // the atmosphere's LUTs, sky-view and froxels as fragment passes
  'deferred', // the G-buffer and its lighting passes
  'animation', // skinning and morph targets through the pose and deform data textures
  'particles', // the CPU simulation and depth sort, through data textures
  'lights2d', // sprites and a tilemap, lit by 2D lights binned on the CPU
  'ui', // text and UI through data textures
  'tabletop', // fog, the grid, drawings and tokens in ground bands
  'interior', // interior lighting's r32uint field and rows, read with texelFetch
  'terrain', // compute only: reports render/feature-unsupported
  'heightfield', // heights fetched in the vertex stage from the page pool (texelFetch), no compute
]

const which = process.env.SHARD_DEMOS || 'curated'
if (which !== 'curated' && which !== 'all') {
  throw new Error(`SHARD_DEMOS is curated or all, not "${which}"`)
}
const demos: readonly Demo[] = which === 'all' ? DEMOS : CURATED

let browser: Browser
beforeAll(async () => {
  if (!skip || !skipGl) browser = await chromium.launch(browserLaunch('chromium', 1))
})
afterAll(async () => {
  await browser?.close()
  await server.close()
})

interface DemoRun {
  error: string | undefined
  pageErrors: string[]
  gpuErrors: string[]
  colors: number
  backend: string
  tier: string
  reasons: string[]
  /** RenderHealth's state, and its degraded issues as `code ref`. */
  health: string
  issues: string[]
}

/**
 * Opens a demo, waits for it to start and for its pipelines to finish compiling (or `settleMs` to
 * pass: some demos stream work forever), then reads its GPU errors and what the canvas shows.
 */
async function run(
  page: Page,
  demo: string,
  settleMs: number,
  backend?: 'webgl2',
): Promise<DemoRun> {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  page.on('console', (message) => {
    // The dev server has no favicon; that 404 isn't the demo's.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      pageErrors.push(message.text())
    }
  })
  // perf=0: no perf overlay (0074), so the colors counted are the demo's own.
  await page.goto(`${server.base}/?${backend ? `backend=${backend}&` : ''}perf=0#${demo}`)
  await page.waitForFunction(() => {
    const p = (globalThis as { playground?: { started: boolean; error?: string } }).playground
    return p?.started || p?.error !== undefined
  })
  const state = await page.evaluate(async (ms) => {
    const g = globalThis as unknown as {
      playground: { error?: string }
      describe(): {
        pipelinesCompiling: number
        drawsSkipped: number
        recentErrors: { code: string; message: string }[]
        backend: string
        tier: string
        reasons: { code: string }[]
        health: { state: string; issues: { code: string; ref?: string; severity: string }[] }
      }
    }
    const none = { backend: '', tier: '', reasons: [], health: '', issues: [] }
    if (g.playground.error !== undefined) {
      return { error: g.playground.error, gpuErrors: [], ...none }
    }
    const end = performance.now() + ms
    let quiet = 0
    let frames = 0
    // At least a second of frames: a demo spawns and requests pipelines over its first frames.
    while (performance.now() < end && (quiet < 10 || frames < 60)) {
      frames++
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const d = g.describe()
      quiet = d.pipelinesCompiling === 0 && d.drawsSkipped === 0 ? quiet + 1 : 0
    }
    const d = g.describe()
    const errors = d.recentErrors.map((e) => `${e.code}: ${e.message}`)
    return {
      error: undefined,
      gpuErrors: errors,
      backend: d.backend,
      tier: d.tier,
      reasons: d.reasons.map((r) => r.code),
      health: d.health.state,
      issues: d.health.issues
        .filter((i) => i.severity === 'degraded')
        .map((i) => `${i.code} ${i.ref ?? ''}`)
        .sort(),
    }
  }, settleMs)
  // The page, clipped to the viewport: an element screenshot first waits for two frames in which
  // the element doesn't move, which a heavy demo on a software GPU may not give it in time.
  const box = await page.locator('#viewport').boundingBox()
  const shot = await decodePng(
    new Uint8Array(
      await page.screenshot(
        box ? { clip: box, timeout: timeout(30_000) } : { timeout: timeout(30_000) },
      ),
    ),
  )
  // Distinct colors, quantized to 4 bits a channel: a blank or single-color canvas has one or two.
  const seen = new Set<number>()
  const d = shot.data
  for (let i = 0; i < d.length; i += 4) {
    seen.add(((d[i]! >> 4) << 8) | ((d[i + 1]! >> 4) << 4) | (d[i + 2]! >> 4))
  }
  return { ...state, pageErrors, colors: seen.size }
}

describe.skipIf(skip)('playground demos on WebGPU', () => {
  for (const demo of demos) {
    it(
      `${demo} starts, draws, and reports no errors`,
      async () => {
        const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
        try {
          const result = await run(await context.newPage(), demo, 20_000)
          expect(result.error).toBeUndefined()
          expect(result.pageErrors).toEqual([])
          expect(result.gpuErrors).toEqual([])
          expect(result.colors).toBeGreaterThan(8)
        } finally {
          await context.close()
        }
      },
      timeout(90_000),
    )
  }
})

describe.skipIf(skip)('#heightfield in Chrome against Node (0071)', () => {
  it(
    'bakes the same pack bytes and walks to the same checksum as Node',
    async () => {
      const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
      try {
        const page = await context.newPage()
        await page.goto(`${server.base}/?perf=0#heightfield`)
        // The page compares both with the values Node pins and says = Node ✓ or ≠ Node.
        const result = await page.waitForFunction(
          () => {
            const h = (globalThis as { heightfield?: { hash: string; walk: string } }).heightfield
            return h?.hash.includes('Node') && h.walk.includes('Node') ? { ...h } : null
          },
          undefined,
          { timeout: timeout(120_000), polling: 500 },
        )
        const { hash, walk } = (await result.jsonValue()) as { hash: string; walk: string }
        expect(hash).toContain('= Node ✓')
        expect(walk).toContain('= Node ✓')
      } finally {
        await context.close()
      }
    },
    timeout(180_000),
  )
})

describe.skipIf(skipGl)('playground demos on WebGL2 (0064)', () => {
  for (const demo of demos) {
    const expected = BASELINE_ISSUES[demo] ?? []
    it(
      `${demo} starts on the baseline tier, draws, and reports ${expected.length ? expected.join(', ') : 'ok'}`,
      async () => {
        const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
        try {
          // D3D11 (ANGLE on Windows) compiles heavy shaders through FXC: seconds each, the first visit.
          const result = await run(await context.newPage(), demo, 60_000, 'webgl2')
          expect(result.error).toBeUndefined()
          expect(result.pageErrors).toEqual([])
          expect(result.gpuErrors).toEqual([])
          expect([result.backend, result.tier]).toEqual(['webgl2', 'baseline'])
          expect(result.issues).toEqual(expected)
          expect(result.health).toBe(expected.length ? 'degraded' : 'ok')
          // A feature that can't run here draws nothing, and says so instead.
          if (!expected.some((i) => i.startsWith('render/feature-unsupported'))) {
            expect(result.colors).toBeGreaterThan(8)
          }
        } finally {
          await context.close()
        }
      },
      timeout(150_000),
    )
  }

  it(
    "'auto' without WebGPU picks WebGL2, and says why",
    async () => {
      const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
      try {
        const page = await context.newPage()
        await page.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined })
        })
        const result = await run(page, 'scene', 30_000)
        expect(result.error).toBeUndefined()
        expect([result.backend, result.tier]).toEqual(['webgl2', 'baseline'])
        expect(result.reasons).toEqual(['no-webgpu'])
        expect(result.health).toBe('ok')
        expect(result.colors).toBeGreaterThan(8)
      } finally {
        await context.close()
      }
    },
    timeout(90_000),
  )
})
