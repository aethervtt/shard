import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { timeout } from '@aethervtt/shard-core/test-env'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { audioProbes } from './audio-probes'
import { checkRequired, type PlaygroundServer, servePlayground } from './browser-tests'

describe('audio offline browser evidence', () => {
  let server: PlaygroundServer, unavailable: string | undefined
  beforeAll(async () => {
    server = await servePlayground()
    try {
      const browser = await chromium.launch({ headless: true })
      await browser.close()
    } catch (error) {
      unavailable = String(error)
      checkRequired('Audio', unavailable)
    }
  }, timeout(30000))
  afterAll(async () => {
    await server?.close()
  })
  it(
    'renders hierarchy, filters, sends, sample-aligned stems and envelopes through the live backend',
    async (ctx) => {
      if (unavailable) {
        ctx.skip()
        return
      }
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        await page.goto(`${server.base}/audio.html`)
        await page.waitForFunction(() => 'audioProbes' in globalThis)
        const evidence = await page.evaluate(() =>
          (globalThis as unknown as { audioProbes: typeof audioProbes }).audioProbes(),
        )
        const destination = process.env.SHARD_AUDIO_EVIDENCE
        if (destination) {
          await mkdir(destination, { recursive: true })
          await writeFile(
            join(destination, 'browser-signals.json'),
            JSON.stringify(evidence, null, 2),
          )
        }
        expect(evidence.hierarchy).toBeCloseTo(0.125, 4)
        expect(evidence.attenuationDb).toBeLessThan(-12)
        expect(Math.abs(evidence.delaySample - 12000)).toBeLessThanOrEqual(1)
        expect(evidence.stemIndex).toBe(2400)
        expect(evidence.stemPeak).toBeCloseTo(2, 3)
        expect(evidence.fadeMiddle).toBeCloseTo(0.5 * Math.SQRT1_2, 3)
        expect(evidence.fadeEnd).toBeLessThan(1e-6)
        expect(evidence.sharedBytes).toBe(48000 * 4)
        expect(evidence.survivingBytes).toBe(evidence.sharedBytes)
        expect(evidence.collectedBytes).toBe(0)
        expect(evidence.capabilities.offline).toBe(true)
      } finally {
        await browser.close()
      }
    },
    timeout(60000),
  )
})
