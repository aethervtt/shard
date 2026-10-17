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
        expect(evidence.domainTails.muted).toBeLessThan(1e-6)
        expect(evidence.domainTails.unrelatedOldTail).toBeCloseTo(0.25, 4)
        expect(evidence.domainTails.newMusic).toBeCloseTo(0.5, 4)
        expect(evidence.domainTails.retired).toBeLessThan(evidence.domainTails.overlap)
        expect(evidence.musicTransitions.linear.middle).toBeCloseTo(0.5, 3)
        expect(evidence.musicTransitions.equalPower.middle).toBeCloseTo(Math.SQRT1_2, 3)
        for (const transition of Object.values(evidence.musicTransitions)) {
          expect(transition.at).toBeCloseTo(2.05, 5)
          expect(transition.after).toBeCloseTo(0.25, 3)
          expect(transition.stinger).toBeCloseTo(1, 3)
          expect(transition.paused).toBeLessThan(1e-6)
        }
        expect(evidence.instanceSends.first).toBeCloseTo(0.125, 4)
        expect(evidence.instanceSends.second).toBeCloseTo(0.25, 4)
        expect(evidence.musicLoops.duration).toBe(60)
        expect(evidence.musicLoops.peaks).toHaveLength(31)
        expect(Math.min(...evidence.musicLoops.amplitudes)).toBeGreaterThan(0.4)
        expect(evidence.musicLoops.unexpected).toBe(0)
        expect(evidence.delayBeforeCap).toBeGreaterThan(0.001)
        expect(evidence.delayAfterCap).toBeLessThan(1e-6)
        expect(evidence.reverbBeforeCap).toBeGreaterThan(0.1)
        expect(evidence.reverbAfterCap).toBeLessThan(1e-6)
        expect(evidence.postFaderSilent).toBeLessThan(1e-6)
        expect(evidence.session.aRight).toBeGreaterThan(0.01)
        expect(Math.abs(evidence.session.aLeft)).toBeLessThan(1e-6)
        expect(evidence.session.bLeft).toBeGreaterThan(0.01)
        expect(Math.abs(evidence.session.bRight)).toBeLessThan(1e-6)
        expect(evidence.session.memory.decodedBytes).toBe(0)
        expect(evidence.session.memory.voices).toBe(0)
        expect(evidence.session.memory.nodes).toBe(1)
        for (let i = 0; i < evidence.musicLoops.peaks.length; i++)
          expect(
            Math.abs(evidence.musicLoops.peaks[i]! - evidence.musicLoops.expected[i]!),
          ).toBeLessThanOrEqual(1)
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
