import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioDocument, AudioPreviewAdapter } from '@aethervtt/shard-audio-editor/model'
import type { createIsolatedAudioPreview } from '@aethervtt/shard-audio-editor/preview'
import type { JsonObject } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { createWebAudioBackend } from '@aethervtt/shard-platform-web'
import { chromium, firefox, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { createDemoAudioHost } from './audio-editor-host'
import { checkRequired, type PlaygroundServer, servePlayground } from './browser-tests'

interface Demo {
  session: { state: { document: AudioDocument }; play(): Promise<unknown> }
  preview: AudioPreviewAdapter
  host: ReturnType<typeof createDemoAudioHost>
  createIsolatedAudioPreview: typeof createIsolatedAudioPreview
  createWebAudioBackend: typeof createWebAudioBackend
}
const browserName = process.env.SHARD_EDITOR_BROWSER ?? 'chromium'
const engine = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium

describe(`audio editor real previews (${browserName})`, () => {
  let server: PlaygroundServer
  let unavailable: string | undefined
  beforeAll(async () => {
    server = await servePlayground()
    try {
      const browser = await engine.launch()
      await browser.close()
    } catch (error) {
      unavailable = String(error)
      checkRequired('Audio editor preview', unavailable)
    }
  }, timeout(30000))
  afterAll(async () => {
    await server?.close()
  })

  it(
    'unlocks on a real gesture and renders host-resolved event, mixer and music WAV evidence',
    async (ctx) => {
      if (unavailable) return ctx.skip()
      const browser = await engine.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        expect(
          await page.evaluate(() =>
            (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo.preview.inspect(),
          ),
        ).toMatchObject({ state: 'idle' })
        await page.evaluate(() => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          const button = document.createElement('button')
          button.id = 'test-audition'
          button.textContent = 'Test audition gesture'
          button.onclick = () => {
            void demo.session.play()
          }
          document.body.append(button)
        })
        await page.locator('#test-audition').click()
        await page.waitForFunction(() => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          const state = demo.preview.inspect() as { context?: string; counts?: { active: number } }
          return state.context === 'running' && (state.counts?.active ?? 0) > 0
        })
        const reports = await page.evaluate(async () => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          const event = demo.session.state.document
          const library = [...demo.host.records.values()]
          const mixer = library.find((item) => item.type === 'audio/AudioMixer')!
          const music = library.find((item) => item.type === 'audio/MusicProgram')!
          const footstep = library.find((item) => item.id.includes('-footstep-'))!
          const spell = library.find((item) => item.id.includes('-spell-'))!
          const clips = await demo.host.assets.list({ type: 'AudioClip' })
          const waveform = await demo.preview.waveform!(clips.items[0]!.id, 64)
          const outputs: { name: string; report: Record<string, unknown>; wav: number[] }[] = []
          if (demo.preview.capabilities.export) {
            for (const [name, doc] of [
              ['event', event],
              ['footstep', footstep],
              ['spell', spell],
              ['mixer', mixer],
              ['music', music],
            ] as const) {
              const plan: JsonObject =
                name === 'mixer'
                  ? { duration: 0.5, events: [{ id: 'engine', asset: { guid: event.id } }] }
                  : { duration: 0.5 }
              const output = (await demo.preview.export!(doc, plan)) as {
                wav: Uint8Array
              } & Record<string, unknown>
              const { wav, ...report } = output
              outputs.push({ name, report, wav: [...wav] })
            }
            for (const snapshot of library.filter((item) => item.type === 'audio/AudioSnapshot')) {
              const output = (await demo.preview.export!(snapshot, {
                duration: 0.5,
                mixer: { guid: mixer.id },
                events: [{ id: 'engine', asset: { guid: event.id } }],
                music: [{ id: 'music', asset: { guid: music.id } }],
                controls: [
                  {
                    at: 0.1,
                    kind: 'snapshot.acquire',
                    target: 'snapshot',
                    asset: { guid: snapshot.id },
                    value: 1,
                  },
                ],
              })) as { wav: Uint8Array } & Record<string, unknown>
              const { wav, ...report } = output
              outputs.push({
                name: snapshot.id.split('-').at(-4) ?? 'snapshot',
                report,
                wav: [...wav],
              })
            }
          }
          return {
            outputs,
            exportAvailable: demo.preview.capabilities.export,
            nativeOffline:
              typeof OfflineAudioContext !== 'undefined' &&
              typeof OfflineAudioContext.prototype.suspend === 'function' &&
              typeof OfflineAudioContext.prototype.resume === 'function',
            waveform: {
              bins: waveform.peaks.length / 2,
              duration: waveform.duration,
              max: Math.max(...waveform.peaks),
            },
            live: demo.preview.inspect(),
          }
        })
        expect(reports.waveform.bins).toBe(64)
        expect(reports.waveform.max).toBeGreaterThan(0)
        expect(reports.exportAvailable).toBe(reports.nativeOffline)
        if (browserName === 'chromium') expect(reports.outputs).toHaveLength(8)
        const destination = process.env.SHARD_AUDIO_EDITOR_EVIDENCE
        if (destination) {
          await mkdir(destination, { recursive: true })
          await writeFile(
            join(destination, `${browserName}-editor-preview-capabilities.json`),
            JSON.stringify(
              {
                exportAvailable: reports.exportAvailable,
                nativeOffline: reports.nativeOffline,
                waveform: reports.waveform,
                live: reports.live,
              },
              null,
              2,
            ),
          )
        }
        for (const output of reports.outputs) {
          const measured = output.report.measured as {
            peak: number
            rms: number
            nonfinite: number
            frames: number
          }
          expect(measured.peak).toBeGreaterThan(0)
          expect(measured.rms).toBeGreaterThan(0)
          expect(measured.nonfinite).toBe(0)
          expect(measured.frames).toBe(24000)
          expect(output.wav.slice(0, 4)).toEqual([82, 73, 70, 70])
          if (destination) {
            await writeFile(
              join(destination, `${browserName}-editor-${output.name}.wav`),
              new Uint8Array(output.wav),
            )
            await writeFile(
              join(destination, `${browserName}-editor-${output.name}.json`),
              JSON.stringify(output.report, null, 2),
            )
          }
        }
      } finally {
        await browser.close()
      }
    },
    timeout(120000),
  )

  it(
    '100 audition lifecycles release owned resources while a sibling session continues playing',
    async (ctx) => {
      if (unavailable) return ctx.skip()
      const browser = await engine.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        await page.mouse.click(10, 10)
        const result = await page.evaluate(async () => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          const add = window.addEventListener.bind(window)
          const remove = window.removeEventListener.bind(window)
          const listeners = new Map<EventListenerOrEventListenerObject, Set<string>>()
          window.addEventListener = (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: boolean | AddEventListenerOptions,
          ) => {
            if (listener && ['pointerdown', 'keydown', 'touchend'].includes(type)) {
              const types = listeners.get(listener) ?? new Set<string>()
              types.add(type)
              listeners.set(listener, types)
            }
            add(type, listener!, options)
          }
          window.removeEventListener = (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: boolean | EventListenerOptions,
          ) => {
            if (listener) {
              const types = listeners.get(listener)
              types?.delete(type)
              if (types?.size === 0) listeners.delete(listener)
            }
            remove(type, listener!, options)
          }
          const listenerCount = () =>
            [...listeners.values()].reduce((sum, types) => sum + types.size, 0)
          const root = demo.createWebAudioBackend()
          const event = demo.session.state.document
          const original = root.createSession!.bind(root)
          const children: ReturnType<typeof original>[] = []
          root.createSession = (options) => {
            const child = original(options)
            children.push(child)
            return child
          }
          const sibling = demo.createIsolatedAudioPreview({ ...demo.host, backend: root })
          await sibling.play(event)
          await new Promise<void>((resolve) => setTimeout(resolve, 30))
          sibling.inspect()
          const baseline = root.runtime.memory()
          const baselineListeners = listenerCount()
          let maxNodes = 0
          let maxVoices = 0
          let maxPinned = 0
          for (let i = 0; i < 100; i++) {
            const preview = demo.createIsolatedAudioPreview({ ...demo.host, backend: root })
            await preview.play(event)
            preview.inspect()
            await preview.dispose()
            const child = children.at(-1)!
            const memory = child.runtime!.memory()
            maxNodes = Math.max(maxNodes, memory.nodes)
            maxVoices = Math.max(maxVoices, memory.voices)
            maxPinned = Math.max(maxPinned, memory.pinned)
          }
          root.runtime.collect()
          const after = root.runtime.memory()
          const afterListeners = listenerCount()
          const playing = sibling.inspect() as {
            context: string
            counts: { active: number }
            voices: { presentation: { state: string } | null }[]
          }
          await sibling.dispose()
          root.runtime.collect()
          const final = root.runtime.memory()
          const contextBeforeRootClose = root.state
          root.dispose?.()
          const remainingListeners = listenerCount()
          window.addEventListener = add
          window.removeEventListener = remove
          return {
            cycles: 100,
            baseline,
            after,
            final,
            maxNodes,
            maxVoices,
            maxPinned,
            playing,
            contextBeforeRootClose,
            baselineListeners,
            afterListeners,
            remainingListeners,
          }
        })
        expect(result.cycles).toBe(100)
        // Backend accounting includes its one retained, disconnected output object after disposal.
        expect(result.maxNodes).toBe(1)
        expect(result.maxVoices).toBe(0)
        expect(result.after.urls).toBe(result.baseline.urls)
        expect(result.after.pinned).toBe(result.baseline.pinned)
        expect(result.final.pinned).toBe(0)
        expect(result.playing.counts.active).toBeGreaterThan(0)
        expect(
          result.playing.voices.some((voice) => voice.presentation?.state === 'rendering'),
        ).toBe(true)
        expect(result.contextBeforeRootClose).toBe('running')
        expect(result.afterListeners).toBe(result.baselineListeners)
        expect(result.remainingListeners).toBe(0)
        const destination = process.env.SHARD_AUDIO_EDITOR_EVIDENCE
        if (destination) {
          await mkdir(destination, { recursive: true })
          await writeFile(
            join(destination, `${browserName}-editor-lifecycle.json`),
            JSON.stringify(result, null, 2),
          )
        }
      } finally {
        await browser.close()
      }
    },
    timeout(120000),
  )
})
