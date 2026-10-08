// Browser acceptance for 0062, against the verification fixture (verify.html) in real Chromium.
// Needs Playwright's Chromium (`pnpm exec playwright install chromium`) and a WebGPU adapter: a
// GPU, or Mesa's software Vulkan driver, which is how CI's browser job runs it. Without them the
// tests skip, unless SHARD_BROWSER_TESTS=required (CI), where that's a failure. The latency test is
// a timing check, so it holds under `pnpm bench` only.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import {
  type CapturePlan,
  checkThresholds,
  parsePlan,
  perfRecordJsonSchema,
  type RgbaImage,
} from '@aethervtt/shard-verify'
import { browserLaunch, decodePng, runCapture } from '@aethervtt/shard-verify/node'
import { chromium } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webgl2Unavailable } from './browser-tests'

const root = join(import.meta.dirname, '..')
let server: ViteDevServer
let base = ''
let out = ''

/** Why browser tests can't run here, or undefined when they can. */
async function unavailable(url: string): Promise<string | undefined> {
  try {
    const browser = await chromium.launch(browserLaunch('chromium', 1))
    try {
      const page = await browser.newPage()
      await page.goto(url)
      const ok = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()))
      return ok ? undefined : 'Chromium has no WebGPU adapter here'
    } finally {
      await browser.close()
    }
  } catch (err) {
    return (err as Error).message.split('\n')[0]
  }
}

server = await createServer({ root, configFile: false, logLevel: 'error', server: { port: 0 } })
await server.listen()
base = server.resolvedUrls!.local[0]!.replace(/\/$/, '')
const skip = await unavailable(`${base}/verify.html`)
if (skip && process.env.SHARD_BROWSER_TESTS === 'required') {
  throw new Error(`0062 browser tests are required here, but can't run: ${skip}`)
}
if (skip) console.warn(`0062 browser tests skipped: ${skip}`)

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'shard-capture-'))
})
afterAll(async () => {
  await server.close()
  await rm(out, { recursive: true, force: true })
})

/**
 * A plan against this run's dev server, with the render scale pinned unless it says otherwise: under
 * load (the whole suite on one GPU), the controller would lower it and change the pixels.
 */
function plan(json: Record<string, unknown>): CapturePlan {
  return parsePlan({
    canvas: '#table',
    viewport: [640, 360],
    conditions: { renderScale: { mode: 'fixed', scale: 1 } },
    ...json,
    url: `${base}/verify.html`,
  })
}

/**
 * A plan from `plans/`. Its latency budgets (`step.latencyMs` matchers) are timing checks: they
 * hold under `pnpm bench`, and elsewhere only check that a latency was measured. CI renders on the
 * CPU, where a traced step takes about a second to show.
 */
function fromFile(
  name: string,
  patch: (json: Record<string, unknown>) => void = () => {},
): CapturePlan {
  const json = JSON.parse(readFileSync(join(root, 'plans', name), 'utf8'))
  if (timingMode !== 'bench') {
    for (const step of json.steps ?? []) {
      for (const checks of Object.values(step.expect ?? {}) as Record<string, unknown>[]) {
        if ('step.latencyMs' in checks) checks['step.latencyMs'] = { min: 0 }
      }
    }
  }
  patch(json)
  return plan(json)
}

let runs = 0
/** Runs a plan into a directory of its own, and says which. */
async function capture(p: CapturePlan) {
  const dir = join(out, `run-${runs++}`)
  return { ...(await runCapture(p, { out: dir })), dir }
}
const png = async (dir: string, id: string) =>
  decodePng(new Uint8Array(readFileSync(join(dir, `${id}.png`))))

describe.skipIf(skip)('browser captures (0062)', () => {
  it(
    'captures a static shot with the same PNG hash twice in a row, at DPR 1 and 2',
    async () => {
      const p = plan({
        dpr: [1, 2],
        shots: [
          { name: 'map-close', state: { view: 'map', zoom: 4, target: [-2.5, 0, 1.5] } },
          { name: 'oblique', state: { view: 'tabletop', pitch: 35, yaw: 30 } },
        ],
      })
      const first = await capture(p)
      const second = await capture(p)
      const hashes = (run: typeof first) => run.manifest.shots.map((s) => [s.id, s.hash])
      expect(hashes(second)).toEqual(hashes(first))
      const sizes = first.manifest.shots.map((s) => [s.id, s.width, s.height])
      expect(sizes).toEqual([
        ['chromium/main/map-close@1x', 640, 360],
        ['chromium/main/oblique@1x', 640, 360],
        ['chromium/main/map-close@2x', 1280, 720],
        ['chromium/main/oblique@2x', 1280, 720],
      ])
    },
    timeout(120_000),
  )

  it(
    'keeps alpha in a canvas-only capture of the transparent dice surface',
    async () => {
      const run = await capture(plan({ shots: [{ name: 'dice', canvas: '#dice' }] }))
      const image = await png(run.dir, 'chromium/main/dice@1x')
      let clear = 0
      let partial = 0
      let solid = 0
      for (let i = 3; i < image.data.length; i += 4) {
        const a = image.data[i]!
        if (a === 0) clear++
        else if (a === 255) solid++
        else partial++
      }
      // The page around the dice, the dice themselves, and their shadows and edges between.
      expect(clear).toBeGreaterThan(image.width * image.height * 0.5)
      expect(solid).toBeGreaterThan(1000)
      expect(partial).toBeGreaterThan(200)
    },
    timeout(60_000),
  )

  it(
    'captures GM and player separately, and a page capture includes the DOM over the canvas',
    async () => {
      const run = await capture(
        plan({
          clients: [
            { name: 'gm', role: 'gm' },
            { name: 'player', role: 'player' },
          ],
          shots: [{ name: 'canvas' }, { name: 'page', scope: 'page' }],
        }),
      )
      const dir = run.dir
      expect(run.manifest.shots.map((s) => s.id)).toEqual([
        'chromium/gm/canvas@1x',
        'chromium/gm/page@1x',
        'chromium/player/canvas@1x',
        'chromium/player/page@1x',
      ])
      const gm = await png(dir, 'chromium/gm/canvas@1x')
      const player = await png(dir, 'chromium/player/canvas@1x')
      const gmPage = await png(dir, 'chromium/gm/page@1x')
      const at = (image: RgbaImage, x: number, y: number) =>
        Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3))
      // The player's fog darkens the board's far corner, which the GM sees lit.
      const corner = at(gm, 200, 120).reduce((a, b) => a + b, 0)
      expect(at(player, 200, 120).reduce((a, b) => a + b, 0)).toBeLessThan(corner * 0.6)
      // The top bar is DOM: the page capture has it, the canvas capture has the scene there.
      // The bar is rgba(20, 23, 30, 0.9) over the scene.
      const bar = at(gmPage, 4, 4)
      for (const [i, c] of [20, 23, 30].entries()) expect(Math.abs(bar[i]! - c)).toBeLessThan(10)
      expect(at(gm, 4, 4)).not.toEqual(at(gmPage, 4, 4))
    },
    timeout(60_000),
  )
})

describe.skipIf(skip)('browser performance records (0062)', () => {
  it(
    'records every PerfRecord field in the playground, and the record validates against its schema',
    async () => {
      const run = await capture(
        plan({
          fixture: 'verify-tabletop',
          scenarios: [
            {
              name: 'moves',
              seconds: 1,
              steps: [
                { name: 'a', run: 'move', args: { name: 'goblin', to: [0.5, 0.5] }, trace: true },
                { name: 'b', run: 'move', args: { name: 'goblin', to: [2.5, 0.5] }, trace: true },
                { name: 'pan', args: { seconds: 1 } },
              ],
            },
          ],
        }),
      )
      const [record] = run.records
      const { default: Ajv } = await import('ajv/dist/2020')
      const validate = new Ajv({ strict: false }).compile(perfRecordJsonSchema())
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true)
      expect(record).toMatchObject({
        version: 2,
        renderer: 'shard',
        fixture: 'verify-tabletop',
        scenario: 'moves',
        device: { dpr: 1, viewport: [640, 360] },
      })
      expect(record!.device.gpu).not.toBe('unknown')
      expect(record!.device.ua).toContain('Chrome')
      for (const phase of ['total', 'modules', 'device', 'pipelines'] as const) {
        expect(record!.coldStart[phase], phase).toBeGreaterThan(0)
      }
      expect(record!.firstUsableFrame).toBeGreaterThan(record!.coldStart.total)
      expect(record!.patchToFrame.n).toBe(2)
      expect(record!.patchToFrame.p95).toBeGreaterThan(0)
      expect(record!.frameTime.n).toBeGreaterThan(0)
      expect(record!.frameTime.gpuP95).toBeGreaterThan(0)
      expect(record!.gpuMemory.bytes).toBeGreaterThan(0)
      expect(record!.gpuMemory.byCategory.targets).toBeGreaterThan(0)
      expect(record!.download.decoded).toBeGreaterThan(0)
    },
    timeout(60_000),
  )

  it(
    'records scale 1 for every frame with the render scale fixed, and the controller never moves it',
    async () => {
      const scenario = {
        name: 'pan',
        seconds: 1.5,
        steps: [{ name: 'pan', args: { seconds: 1.5 } }],
      }
      const pinned = await capture(
        plan({
          dpr: [2],
          conditions: { renderScale: { mode: 'fixed', scale: 1 } },
          scenarios: [scenario],
        }),
      )
      expect(pinned.records[0]!.renderScale).toEqual({ mode: 'fixed', min: 1, max: 1 })
      // Unpinned, the same run is under the controller.
      const free = await capture(plan({ dpr: [2], conditions: {}, scenarios: [scenario] }))
      expect(free.records[0]!.renderScale.mode).toBe('auto')
    },
    timeout(60_000),
  )

  it.skipIf(timingMode !== 'bench')(
    "measures patchToFrame within one refresh of when the token's pixels change on screen",
    async () => {
      const browser = await chromium.launch(browserLaunch('chromium', 1))
      try {
        const context = await browser.newContext({ viewport: { width: 960, height: 540 } })
        const page = await context.newPage()
        await page.goto(`${base}/verify.html?role=gm`)
        await page.waitForFunction(() => window.__shardReady === true)
        await page.evaluate(() =>
          window.__shardCapture!.apply({ view: 'map', zoom: 1, labels: false }),
        )
        await page.evaluate(() => window.__shardCapture!.idle())
        const period = await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const times: number[] = []
              const tick = (t: number) => {
                times.push(t)
                if (times.length < 31) requestAnimationFrame(tick)
                else {
                  const gaps = times.slice(1).map((t, i) => t - times[i]!)
                  resolve(gaps.sort((a, b) => a - b)[15]!)
                }
              }
              requestAnimationFrame(tick)
            }),
        )
        // From outside the page: the compositor's frames, each with the time it was drawn.
        const cdp = await context.newCDPSession(page)
        const frames: { at: number; data: string }[] = []
        cdp.on('Page.screencastFrame', (f) => {
          frames.push({ at: f.metadata.timestamp! * 1000, data: f.data })
          void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId })
        })
        await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
        await page.waitForTimeout(300)
        const gaps: number[] = []
        for (let i = 0; i < 8; i++) {
          const to: [number, number] = i % 2 === 0 ? [-1.5, 2.5] : [4.5, -3.5]
          // Where the goblin lands on screen: the map shows 16 m of height, north up.
          const x = Math.round(((to[0] / (8 * (960 / 540)) + 1) / 2) * 960)
          const y = Math.round(((1 + to[1] / 8) / 2) * 540)
          const before = frames.length
          const inside = await page.evaluate(async (to) => {
            const at = performance.timeOrigin + performance.now()
            const step = await window.__shardCapture!.step('move', { name: 'goblin', to }, true)
            return { at, latency: step.latencyMs! }
          }, to)
          await page.waitForTimeout(200)
          const pixel = async (data: string) => {
            const image = await decodePng(Buffer.from(data, 'base64'))
            const o = (y * image.width + x) * 4
            return image.data[o]! + image.data[o + 1]! + image.data[o + 2]!
          }
          const baseline = await pixel(frames[before - 1]!.data)
          let outside: number | undefined
          for (const frame of frames.slice(before)) {
            if (Math.abs((await pixel(frame.data)) - baseline) > 30) {
              outside = frame.at - inside.at
              break
            }
          }
          expect(outside, `move ${i}: no frame showed the goblin`).toBeDefined()
          gaps.push(Math.abs(inside.latency - outside!))
        }
        // Timestamps are rounded to 0.1 ms or so on both sides.
        const shown = `gaps ${gaps.map((g) => g.toFixed(2))}`
        for (const gap of gaps) expect(gap, shown).toBeLessThanOrEqual(period + 0.5)
      } finally {
        await browser.close()
      }
    },
    timeout(60_000),
  )
})

describe.skipIf(skip)('dice in the browser (0054)', () => {
  it(
    'plays 32 dice to rest in the fixture, each showing its value, a canvas capture keeping alpha, the record within the plan',
    async () => {
      const p = fromFile('dice.json')
      const run = await capture(p)
      expect(run.failures).toEqual([])
      // The landed roll, canvas scope: the page shows through wherever no die or shadow is.
      const image = await png(run.dir, 'chromium/main/landed-32@1x')
      let clear = 0
      let solid = 0
      let partial = 0
      for (let i = 3; i < image.data.length; i += 4) {
        const a = image.data[i]!
        if (a === 0) clear++
        else if (a === 255) solid++
        else partial++
      }
      expect(clear).toBeGreaterThan(image.width * image.height * 0.6)
      expect(solid).toBeGreaterThan(2000)
      expect(partial).toBeGreaterThan(500)
      const [record] = run.records
      expect(record!.scenario).toBe('dice-32')
      // Frames all through its second; how many is timing (CI's software GPU draws about 30).
      expect(record!.frameTime.n).toBeGreaterThan(timingMode === 'bench' ? 60 : 0)
      // Frame time and long tasks are timing: the plan's thresholds hold under pnpm bench (CI
      // renders on the CPU).
      if (timingMode === 'bench') {
        const check = checkThresholds(run.records, p.thresholds)
        expect(check.breaches).toEqual([])
      }
    },
    timeout(180_000),
  )
})

describe.skipIf(skip)('the visibility flow (0062)', () => {
  it(
    'passes for a correct player, GM view unaffected',
    async () => {
      const run = await capture(fromFile('visibility.json'))
      expect(run.failures).toEqual([])
      expect(run.manifest.steps.map((s) => s.name)).toEqual([
        'into-vision',
        'out-of-vision',
        'vision-moves',
        'scene-switch',
        'disconnect',
        'moved-while-away',
        'reconnect',
      ])
      // Each checked step captured both clients.
      expect(run.manifest.shots.filter((s) => s.client === 'player')).toHaveLength(5)
    },
    timeout(120_000),
  )

  it(
    'fails when the player keeps a token after it leaves vision, naming the step and the client',
    async () => {
      const run = await capture(
        fromFile('visibility.json', (json) => {
          ;(json.clients as { query?: object }[])[1]!.query = { fault: 'keep-token' }
        }),
      )
      expect(run.pass).toBe(false)
      expect(run.failures[0]).toMatchObject({
        step: 'out-of-vision',
        client: 'player',
        path: 'entities',
        message: 'expected it not to include "goblin"',
      })
      expect(run.failures.every((f) => f.client === 'player')).toBe(true)
    },
    timeout(120_000),
  )

  it(
    'fails when the player keeps an old-scene entity after a switch, naming the step and the client',
    async () => {
      const run = await capture(
        fromFile('visibility.json', (json) => {
          ;(json.clients as { query?: object }[])[1]!.query = { fault: 'keep-scene' }
        }),
      )
      expect(run.pass).toBe(false)
      expect(run.failures).toContainEqual(
        expect.objectContaining({
          step: 'scene-switch',
          client: 'player',
          path: 'owners.oldScene',
          message: 'expected 0, got 1',
        }),
      )
      expect(run.failures.some((f) => f.step === 'out-of-vision')).toBe(false)
    },
    timeout(120_000),
  )
})

// Stage 3 of 0064: the same fixture and plans on WebGL2. The plans ask the page for the backend
// (`backend: 'webgl2'`, as ?backend=webgl2); one device draws both canvases, the table and the
// transparent dice overlay, from a canvas of its own.
const skipGl = await webgl2Unavailable(`${base}/verify.html`)
if (skipGl && process.env.SHARD_BROWSER_TESTS === 'required') {
  throw new Error(`0064 WebGL2 browser tests are required here, but can't run: ${skipGl}`)
}

describe.skipIf(skipGl)('the fixture on WebGL2 (0064)', () => {
  const gl = (p: CapturePlan): CapturePlan => ({ ...p, backend: 'webgl2' })

  it(
    'captures the same PNG hash twice in a row, and fog shows the player less than the GM',
    async () => {
      const p = gl(
        plan({
          clients: [
            { name: 'gm', role: 'gm' },
            { name: 'player', role: 'player' },
          ],
          // The default view first (the fog check reads it), then a close map view.
          shots: [
            { name: 'canvas' },
            { name: 'map-close', state: { view: 'map', zoom: 4, target: [-2.5, 0, 1.5] } },
          ],
        }),
      )
      const first = await capture(p)
      const second = await capture(p)
      const hashes = (run: typeof first) => run.manifest.shots.map((s) => [s.id, s.hash])
      expect(hashes(second)).toEqual(hashes(first))
      const gm = await png(first.dir, 'chromium/gm/canvas@1x')
      const player = await png(first.dir, 'chromium/player/canvas@1x')
      const at = (image: RgbaImage, x: number, y: number) =>
        Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3))
      const corner = at(gm, 200, 120).reduce((a, b) => a + b, 0)
      expect(corner).toBeGreaterThan(30)
      expect(at(player, 200, 120).reduce((a, b) => a + b, 0)).toBeLessThan(corner * 0.6)
    },
    timeout(180_000),
  )

  it(
    'plays 32 dice to rest over the page, keeping the dice canvas transparent around them',
    async () => {
      const run = await capture(gl(fromFile('dice.json')))
      expect(run.failures).toEqual([])
      const image = await png(run.dir, 'chromium/main/landed-32@1x')
      let clear = 0
      let solid = 0
      for (let i = 3; i < image.data.length; i += 4) {
        const a = image.data[i]!
        if (a === 0) clear++
        else if (a === 255) solid++
      }
      expect(clear).toBeGreaterThan(image.width * image.height * 0.6)
      expect(solid).toBeGreaterThan(2000)
    },
    timeout(240_000),
  )

  it(
    'passes the visibility flow for a correct player',
    async () => {
      const run = await capture(gl(fromFile('visibility.json')))
      expect(run.failures).toEqual([])
      expect(run.manifest.shots.filter((s) => s.client === 'player')).toHaveLength(5)
    },
    timeout(180_000),
  )
})
