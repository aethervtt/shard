import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch, decodePng, encodePng } from '@aethervtt/shard-verify/node'
import { chromium } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkRequired,
  servePlayground,
  webGpuUnavailable,
  webgl2Unavailable,
} from './browser-tests'
import type { VfxProbe } from './vfx'

declare global {
  interface Window {
    vfxProbe: VfxProbe
  }
}
const server = await servePlayground()
afterAll(() => server.close())
const evidence = process.env.SHARD_VFX_EVIDENCE
async function changed(before: Uint8Array, after: Uint8Array) {
  const a = await decodePng(before),
    b = await decodePng(after)
  expect([a.width, a.height]).toEqual([b.width, b.height])
  let count = 0
  for (let i = 0; i < a.data.length; i += 4)
    if (
      Math.abs(a.data[i]! - b.data[i]!) +
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) +
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) >
      20
    )
      count++
  return count
}
describe('VFX browser evidence', () => {
  for (const backend of ['webgpu', 'webgl2'] as const)
    it(
      `${backend}: real ribbons, moving beam, projected decal, pause and cleanup`,
      async (ctx) => {
        const unavailable = await (backend === 'webgpu' ? webGpuUnavailable : webgl2Unavailable)(
          server.base,
        )
        checkRequired(`VFX ${backend}`, unavailable)
        if (unavailable) {
          ctx.skip(unavailable)
          return
        }
        const browser = await chromium.launch(browserLaunch('chromium', 1))
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('console', (e) => {
          if (e.type() === 'error' && !e.text().includes('404')) errors.push(e.text())
        })
        try {
          await page.goto(
            `${server.base}/vfx.html?test&backend=${backend}${backend === 'webgl2' ? '&gl=minimum' : ''}`,
          )
          await page.waitForFunction(() => !!window.vfxProbe, undefined, {
            timeout: timeout(45_000),
          })
          await page.evaluate(() => window.vfxProbe.step(3))
          const clip = (await page.locator('canvas').boundingBox())!
          await page.click('#play')
          const flight = await page.evaluate(() => window.vfxProbe.step(36))
          expect(flight.backend).toBe(backend)
          expect(flight.ribbons.records).toHaveLength(2)
          expect(flight.ribbons.records.every((r) => r.vertices > 0 && r.error === null)).toBe(true)
          expect(flight.ribbons.records.every((r) => r.texture === 'ready')).toBe(true)
          const full = await page.screenshot({ clip })
          await page.evaluate(() => {
            window.vfxProbe.toggle('trail', false)
            return window.vfxProbe.step(0)
          })
          const withoutTrail = await page.screenshot({ clip }),
            trailPixels = await changed(full, withoutTrail)
          expect(trailPixels).toBeGreaterThan(100)
          await page.evaluate(() => {
            window.vfxProbe.toggle('trail', true)
            window.vfxProbe.toggle('beam', false)
            return window.vfxProbe.step(0)
          })
          const withoutBeam = await page.screenshot({ clip }),
            beamPixels = await changed(full, withoutBeam)
          expect(beamPixels).toBeGreaterThan(30)
          await page.evaluate(() => {
            window.vfxProbe.toggle('beam', true)
            window.vfxProbe.occlude(true)
            return window.vfxProbe.step(0)
          })
          const blocked = await page.screenshot({ clip })
          await page.evaluate(() => {
            window.vfxProbe.toggle('beam', false)
            return window.vfxProbe.step(0)
          })
          const blockedWithoutBeam = await page.screenshot({ clip })
          expect(await changed(blocked, blockedWithoutBeam)).toBe(0)
          await page.evaluate(() => {
            window.vfxProbe.toggle('beam', true)
            window.vfxProbe.occlude(false)
            window.vfxProbe.pause(true)
          })
          const paused = await page.evaluate(() => window.vfxProbe.step(12))
          expect(paused.instance!.time).toBeCloseTo(flight.instance!.time)
          expect(paused.geometry).toEqual(flight.geometry)
          await page.evaluate(() => window.vfxProbe.pause(false))
          const impact = await page.evaluate(() => window.vfxProbe.step(60))
          expect(impact.decals.records[0]!.triangles).toBeGreaterThanOrEqual(4)
          expect(impact.decals.records[0]!.error).toBeNull()
          expect(impact.decals.records[0]!.texture).toBe('ready')
          const mark = await page.screenshot({ clip })
          await page.evaluate(() => {
            window.vfxProbe.toggle('decal', false)
            return window.vfxProbe.step(0)
          })
          const noMark = await page.screenshot({ clip }),
            decalPixels = await changed(mark, noMark)
          expect(decalPixels).toBeGreaterThan(100)
          await page.evaluate(() => {
            window.vfxProbe.toggle('decal', true)
            window.vfxProbe.receiver(false)
            return window.vfxProbe.step(0)
          })
          const excluded = await page.screenshot({ clip })
          expect(await changed(noMark, excluded)).toBe(0)
          expect(
            (await page.evaluate(() => window.vfxProbe.inspect())).decals.records[0]!.vertices,
          ).toBe(0)
          await page.evaluate(() => {
            window.vfxProbe.receiver(true)
            window.vfxProbe.camera()
            return window.vfxProbe.step(0)
          })
          const ortho = await page.screenshot({ clip })
          expect(await changed(mark, ortho)).toBeGreaterThan(1000)
          await page.evaluate(() => {
            window.vfxProbe.camera()
            return window.vfxProbe.step(0)
          })
          const fading = await page.evaluate(() => window.vfxProbe.step(162))
          expect(fading.decals.records[0]!.age).toBeGreaterThan(3)
          expect(fading.decals.records[0]!.opacity).toBeGreaterThan(0)
          expect(fading.decals.records[0]!.opacity).toBeLessThan(0.5)
          const faded = await page.screenshot({ clip })
          await page.evaluate(() => {
            window.vfxProbe.toggle('decal', false)
            return window.vfxProbe.step(0)
          })
          expect(await changed(faded, await page.screenshot({ clip }))).toBeGreaterThan(50)
          await page.evaluate(() => {
            window.vfxProbe.toggle('decal', true)
            return window.vfxProbe.step(0)
          })
          if (evidence) {
            await mkdir(evidence, { recursive: true })
            await writeFile(join(evidence, `${backend}-ribbons.png`), full)
            await writeFile(join(evidence, `${backend}-decal.png`), mark)
            await writeFile(join(evidence, `${backend}-orthographic.png`), ortho)
            await page.screenshot({ path: join(evidence, `${backend}-fading.png`) })
          }
          await page.evaluate(() => window.vfxProbe.cancel())
          const cancelled = await page.evaluate(() => window.vfxProbe.step(0))
          expect(cancelled.ribbons.records).toEqual([])
          expect(cancelled.decals.records).toEqual([])
          expect(cancelled.gpuRecords).toEqual({ ribbons: 0, decals: 0 })
          expect(cancelled.receiverAlive && cancelled.floorAlive).toBe(true)
          expect(cancelled.endpoint).toEqual([1.100000023841858, 1.5, 0])
          await page.evaluate(() => window.vfxProbe.play(42))
          const replay = await page.evaluate(() => window.vfxProbe.step(36))
          expect(replay.geometry).toEqual(flight.geometry)
          const completed = await page.evaluate(() => window.vfxProbe.step(265))
          expect(completed.instance!.state).toBe('completed')
          expect(completed.gpuRecords).toEqual({ ribbons: 0, decals: 0 })
          expect(completed.render.recentErrors).toEqual([])
          expect(errors).toEqual([])
          if (evidence)
            await writeFile(
              join(evidence, `${backend}.json`),
              JSON.stringify(
                {
                  backend,
                  trailPixels,
                  beamPixels,
                  decalPixels,
                  flight,
                  paused,
                  impact,
                  fading,
                  cancelled,
                  replay,
                  completed,
                  errors,
                },
                null,
                2,
              ),
            )
          await page.evaluate(() => window.vfxProbe.dispose())
        } catch (error) {
          if (evidence) {
            await mkdir(evidence, { recursive: true })
            const snapshot = await page.evaluate(() => window.vfxProbe?.inspect()).catch(() => null)
            await writeFile(
              join(evidence, `${backend}-failure.json`),
              JSON.stringify({ error: String(error), errors, snapshot }, null, 2),
            )
            await page.screenshot({ path: join(evidence, `${backend}-failure.png`) })
            if (snapshot) {
              const gpu = await page.evaluate(() => window.vfxProbe.capture())
              await writeFile(
                join(evidence, `${backend}-failure-gpu.png`),
                encodePng(new Uint8Array(gpu.data), gpu.width, gpu.height),
              )
            }
          }
          throw error
        } finally {
          await browser.close()
        }
      },
      timeout(180_000),
    )
})
