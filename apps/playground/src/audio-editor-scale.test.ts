import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import type { drawAudioWaveform, mountAudioEditor } from '@aethervtt/shard-audio-editor/dom'
import type {
  createAudioEditorSession,
  createMemoryAudioHost,
} from '@aethervtt/shard-audio-editor/model'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkRequired, type PlaygroundServer, servePlayground } from './browser-tests'

type Demo = {
  mountAudioEditor: typeof mountAudioEditor
  createAudioEditorSession: typeof createAudioEditorSession
  createMemoryAudioHost: typeof createMemoryAudioHost
  drawAudioWaveform: typeof drawAudioWaveform
}

describe('audio editor scale evidence', () => {
  let server: PlaygroundServer, unavailable: string | undefined
  beforeAll(async () => {
    server = await servePlayground()
    try {
      const browser = await chromium.launch()
      await browser.close()
    } catch (error) {
      unavailable = String(error)
      checkRequired('Audio editor scale', unavailable)
    }
  }, timeout(30000))
  afterAll(async () => {
    await server?.close()
  })
  it(
    'bounds a 10,000 asset catalog and releases 100 mounted views',
    async (ctx) => {
      if (unavailable) return ctx.skip()
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        const result = await page.evaluate(async () => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          let resolves = 0
          const host = demo.createMemoryAudioHost({
            scope: 'large-world',
            documents: [],
            assets: Array.from({ length: 10000 }, (_, index) => ({
              id: `opaque:${index}`,
              name: `Audio ${index}`,
              revision: '1',
              type: 'AudioClip',
              content: { bytes: new Uint8Array() },
            })),
          })
          const resolve = host.assets.resolve.bind(host.assets)
          host.assets.resolve = (...args) => {
            resolves++
            return resolve(...args)
          }
          const session = demo.createAudioEditorSession(host)
          const container = document.createElement('div')
          document.body.append(container)
          const view = demo.mountAudioEditor(container, { session })
          await new Promise((done) => setTimeout(done, 100))
          const rows = view.root.querySelectorAll('.catalog-row').length
          const next = [...view.root.querySelectorAll('button')].find(
            (button) => button.textContent === 'Next assets',
          )
          next?.click()
          await new Promise((done) => setTimeout(done, 100))
          const secondRows = view.root.querySelectorAll('.catalog-row').length
          view.dispose()
          for (let index = 0; index < 100; index++) {
            const mounted = demo.mountAudioEditor(container, { session })
            mounted.dispose()
          }
          await session.dispose()
          const childrenAfterDispose = container.childElementCount
          container.remove()
          return {
            rows,
            secondRows,
            resolves,
            childrenAfterDispose,
            totalAssets: 10000,
            mountCycles: 100,
          }
        })
        expect(result.rows).toBeGreaterThan(0)
        expect(result.rows).toBeLessThanOrEqual(100)
        expect(result.secondRows).toBeLessThanOrEqual(100)
        expect(result.resolves).toBe(0)
        expect(result.childrenAfterDispose).toBe(0)
        const destination = process.env.SHARD_AUDIO_EDITOR_EVIDENCE
        if (destination) {
          await mkdir(destination, { recursive: true })
          await writeFile(join(destination, 'catalog-scale.json'), JSON.stringify(result, null, 2))
        }
      } finally {
        await browser.close()
      }
    },
    timeout(30000),
  )
  it(
    'records the real envelope drawing phase at 1280×720 DPR 2',
    async (ctx) => {
      // Explicit pipeline measurement, never incidental work in correctness tests or local runs.
      if (unavailable || process.env.SHARD_AUDIO_EDITOR_MEASURE !== '1') return ctx.skip()
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 720 },
          deviceScaleFactor: 2,
        })
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        const measurement = await page.evaluate(async () => {
          const { drawAudioWaveform } = (globalThis as unknown as { audioEditorDemo: Demo })
            .audioEditorDemo
          const stage = document.createElement('main')
          stage.style.cssText =
            'position:fixed;inset:0;width:1280px;height:720px;background:#171b24;display:flex;padding-top:40px;box-sizing:border-box'
          const lanes = document.createElement('div'),
            buses = document.createElement('div')
          lanes.style.width = '1050px'
          buses.style.width = '230px'
          stage.append(lanes, buses)
          document.body.append(stage)
          const contexts: CanvasRenderingContext2D[] = [],
            meters: HTMLMeterElement[] = []
          for (let index = 0; index < 16; index++) {
            const canvas = document.createElement('canvas')
            canvas.width = 2100
            canvas.height = 80
            canvas.style.cssText = 'display:block;width:1050px;height:40px'
            canvas.setAttribute('aria-label', `Waveform lane ${index + 1}`)
            lanes.append(canvas)
            contexts.push(canvas.getContext('2d')!)
          }
          for (let index = 0; index < 32; index++) {
            const meter = document.createElement('meter')
            meter.min = 0
            meter.max = 1
            meter.setAttribute('aria-label', `Bus meter ${index + 1}`)
            meter.style.cssText = 'display:block;width:220px;height:20px'
            buses.append(meter)
            meters.push(meter)
          }
          const peaks = Float32Array.from(
            { length: 512 },
            (_, index) => Math.sin(index * 0.1) * 0.8,
          )
          const samples: number[] = []
          for (let frame = 0; frame < 120; frame++) {
            await new Promise(requestAnimationFrame)
            const start = performance.now()
            for (const context of contexts) drawAudioWaveform(context, peaks, 2100, 80, '#98c7ff')
            for (let index = 0; index < meters.length; index++)
              meters[index]!.value = ((frame + index) % 100) / 100
            const duration = performance.now() - start
            if (frame >= 20) samples.push(duration)
          }
          samples.sort((a, b) => a - b)
          return {
            medianMs: samples[Math.floor(samples.length / 2)]!,
            p95Ms: samples[Math.floor(samples.length * 0.95)]!,
            samples: samples.length,
            viewport: [1280, 720],
            dpr: devicePixelRatio,
            waveformLanes: 16,
            busMeters: 32,
            bins: 512,
            phase:
              'Canvas envelope commands and DOM meter writes; excludes compositor, layout and decoding',
            userAgent: navigator.userAgent,
          }
        })
        expect(measurement.medianMs).toBeLessThan(budget('audio-editor/draw'))
        const destination = process.env.SHARD_AUDIO_EDITOR_EVIDENCE
        if (destination) {
          await mkdir(destination, { recursive: true })
          await page.screenshot({ path: join(destination, 'drawing-1280x720-dpr2.png') })
          const resolved = process.env.SHARD_BUDGETS
            ? JSON.parse(process.env.SHARD_BUDGETS)
            : undefined
          await writeFile(
            join(destination, 'drawing-performance.json'),
            JSON.stringify(
              {
                key: 'audio-editor/draw',
                ...measurement,
                hardware: { cpu: cpus()[0]?.model, platform: platform(), release: release() },
                namedMachine: resolved?.machine ?? null,
                enforced: resolved?.enforce === true,
                proposedTargetMs: 8,
              },
              null,
              2,
            ),
          )
        }
      } finally {
        await browser.close()
      }
    },
    timeout(30000),
  )
})
