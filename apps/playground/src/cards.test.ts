import type { CardTableState } from '@aethervtt/shard-cards'
import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch, decodePng } from '@aethervtt/shard-verify/node'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  checkRequired,
  servePlayground,
  webGpuUnavailable,
  webgl2Unavailable,
} from './browser-tests'

const server = await servePlayground()
const skipGpu = await webGpuUnavailable(`${server.base}/cards.html`)
const skipGl = await webgl2Unavailable(`${server.base}/cards.html`)
checkRequired('Cards WebGPU', skipGpu)
checkRequired('Cards WebGL2', skipGl)
let browser: Browser
beforeAll(async () => {
  if (!skipGpu || !skipGl) browser = await chromium.launch(browserLaunch('chromium', 1))
})
afterAll(async () => {
  await browser?.close()
  await server.close()
})

type LiveCards = {
  cardsTable: CardTableState
  cardsReady(): boolean
  cardsErrors(): { code: string; message: string }[]
}
async function ready(page: Page) {
  await page.waitForFunction(() => (globalThis as unknown as LiveCards).cardsReady?.(), undefined, {
    timeout: timeout(60_000),
  })
  expect(await page.evaluate(() => (globalThis as unknown as LiveCards).cardsErrors())).toEqual([])
}
async function colors(page: Page) {
  const shot = await decodePng(
    new Uint8Array(
      await page.locator('#cards').screenshot({ style: '.stage-mark { visibility: hidden; }' }),
    ),
  )
  let lit = 0
  for (let i = 0; i < shot.data.length; i += 4) {
    if (Math.max(shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!) > 45) lit++
  }
  return lit
}
for (const backend of ['webgpu', 'webgl2'] as const) {
  it.skipIf(backend === 'webgpu' ? skipGpu : skipGl)(
    `cards render, pick, move and switch lighting on ${backend}`,
    async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().includes('Failed to load resource'))
          errors.push(message.text())
      })
      try {
        await page.goto(`${server.base}/cards.html?backend=${backend}`)
        await ready(page)
        expect(await colors(page)).toBeGreaterThan(10_000)
        await page.locator('#scene-lights').uncheck()
        await ready(page)
        expect(await colors(page)).toBe(0)
        await page.locator('#scene-lights').check()
        await page.locator('[data-layout="hand"]').click()
        await page.locator('[data-card="1"]').click()
        await page.waitForFunction(() =>
          (globalThis as unknown as LiveCards).cardsTable.cards.some(
            (card) => card?.active && card.pose[2]! > 0.05,
          ),
        )
        expect(
          await page.evaluate(() =>
            (globalThis as unknown as LiveCards).cardsTable.cards
              .filter((card) => card?.active)
              .every((card) => !card!.tilt),
          ),
        ).toBe(true)
        await page.locator('[data-layout="stack"]').click()
        await page.locator('#automatic').check()
        expect(await page.locator('#automatic-tilt').isDisabled()).toBe(true)
        await page.locator('[data-layout="gallery"]').click()
        await ready(page)
        expect(
          await page.evaluate(
            () =>
              new Set(
                (globalThis as unknown as LiveCards).cardsTable.cards
                  .filter((card) => card?.active)
                  .map((card) => card!.data[15]),
              ).size,
          ),
        ).toBe(3)
        await page.locator('#lighting').selectOption('unlit')
        await page.waitForURL('**/*lighting=unlit*')
        await ready(page)
        await page.locator('#scene-lights').uncheck()
        await ready(page)
        expect(await colors(page)).toBeGreaterThan(10_000)
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    },
    timeout(90_000),
  )
}
