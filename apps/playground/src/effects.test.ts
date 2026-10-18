import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch, decodePng } from '@aethervtt/shard-verify/node'
import { chromium } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkRequired,
  servePlayground,
  webGpuUnavailable,
  webgl2Unavailable,
} from './browser-tests'
import type { EffectsProbe } from './effects'

declare global {
  interface Window {
    effectsProbe: EffectsProbe
  }
}
const server = await servePlayground()
afterAll(() => server.close())
const evidence = process.env.SHARD_EFFECTS_EVIDENCE

describe('effect sequence browser evidence', () => {
  for (const backend of ['webgpu', 'webgl2'] as const)
    it(
      `${backend}: real spell, audio signal, pause, replay and cleanup`,
      async (ctx) => {
        const unavailable = await (backend === 'webgpu' ? webGpuUnavailable : webgl2Unavailable)(
          server.base,
        )
        checkRequired(`Effects ${backend}`, unavailable)
        if (unavailable) {
          ctx.skip(unavailable)
          return
        }
        const browser = await chromium.launch(
          browserLaunch('chromium', 1, {
            browserArgs: ['--autoplay-policy=no-user-gesture-required'],
          }),
        )
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('console', (e) => {
          if (e.type() === 'error' && !e.text().includes('404')) errors.push(e.text())
        })
        try {
          await page.goto(`${server.base}/effects.html?test&backend=${backend}`)
          await page.waitForFunction(() => !!window.effectsProbe, undefined, {
            timeout: timeout(45_000),
          })
          await page.evaluate(() => window.effectsProbe.step(3))
          const before = await page.locator('canvas').screenshot()
          await page.click('#play')
          await page.waitForFunction(
            () => window.effectsProbe.inspect().instance?.state === 'playing',
          )
          const windup = await page.evaluate(() => window.effectsProbe.step(18))
          expect(windup.targets.find((t) => t.name === 'caster')!.transform!.scale[0]).toBeCloseTo(
            1.4,
          )
          const flight = await page.evaluate(() => window.effectsProbe.step(54))
          expect(flight.backend).toBe(backend)
          expect(flight.instance?.error).toBeNull()
          expect(
            flight.targets.find((t) => t.name === 'projectile')!.transform!.translation[0],
          ).toBeCloseTo(-1)
          expect(flight.particles!.systems.some((s) => s.emitters.some((e) => e.alive > 0))).toBe(
            true,
          )
          expect(
            flight.audio.instances.some((i) =>
              i.layers.some((l) => l.presentation === 'rendering'),
            ),
          ).toBe(true)
          await page.waitForTimeout(150)
          const rms = await page.evaluate(() => window.effectsProbe.rms())
          expect(rms).toBeGreaterThan(0.00001)
          const during = await page.locator('canvas').screenshot()
          const a = await decodePng(before),
            b = await decodePng(during)
          let changed = 0
          for (let i = 0; i < a.data.length; i += 4)
            if (
              Math.abs(a.data[i]! - b.data[i]!) +
                Math.abs(a.data[i + 1]! - b.data[i + 1]!) +
                Math.abs(a.data[i + 2]! - b.data[i + 2]!) >
              20
            )
              changed++
          expect(changed).toBeGreaterThan(100)
          await page.evaluate(() => window.effectsProbe.pause(true))
          const paused = await page.evaluate(() => window.effectsProbe.step(12))
          expect(paused.instance!.time).toBeCloseTo(flight.instance!.time)
          expect(paused.audio.instances[0]!.decisionTime).toBeCloseTo(
            flight.audio.instances[0]!.decisionTime,
          )
          await page.evaluate(() => window.effectsProbe.pause(false))
          const impact = await page.evaluate(() => window.effectsProbe.step(72))
          expect(
            impact.effects.trace.entries.filter(
              (e) => e.kind === 'marker' && e.reason === 'impact',
            ),
          ).toHaveLength(1)
          expect(impact.targets.find((t) => t.name === 'impact')!.light!.intensity).toBeGreaterThan(
            10000,
          )
          expect(impact.cameraFov).toBeLessThan(50)
          if (evidence) {
            await mkdir(evidence, { recursive: true })
            await page.screenshot({ path: join(evidence, `${backend}-impact.png`) })
            await writeFile(join(evidence, `${backend}-flight.png`), during)
          }
          const cancelled = await page.evaluate(() => window.effectsProbe.cancel())
          expect(cancelled.instance!.state).toBe('cancelled')
          expect(cancelled.targets.filter((t) => t.name !== 'camera').every((t) => !t.alive)).toBe(
            true,
          )
          expect(cancelled.cameraFov).toBe(50)
          expect(cancelled.audio.instances).toEqual([])
          expect(cancelled.particles!.systems).toEqual([])
          await page.evaluate(() => window.effectsProbe.play(42, 1))
          const replay = await page.evaluate(() => window.effectsProbe.step(72))
          expect(replay.targets.find((t) => t.name === 'projectile')!.transform).toEqual(
            flight.targets.find((t) => t.name === 'projectile')!.transform,
          )
          const completed = await page.evaluate(() => window.effectsProbe.step(169))
          expect(completed.instance!.state).toBe('completed')
          expect(completed.effects.instances).toEqual([])
          expect(completed.audio.instances).toEqual([])
          expect(completed.particles!.systems).toEqual([])
          expect(completed.cameraFov).toBe(50)
          expect(errors).toEqual([])
          if (evidence)
            await writeFile(
              join(evidence, `${backend}.json`),
              JSON.stringify(
                {
                  backend,
                  rms,
                  changedPixels: changed,
                  windup,
                  flight,
                  paused,
                  impact,
                  cancelled,
                  replay,
                  completed,
                  errors,
                },
                null,
                2,
              ),
            )
          await page.evaluate(() => window.effectsProbe.dispose())
        } finally {
          await browser.close()
        }
      },
      timeout(120_000),
    )
})
