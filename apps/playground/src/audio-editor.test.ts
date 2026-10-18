import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { timeout } from '@aethervtt/shard-core/test-env'
import { chromium, firefox, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkRequired, type PlaygroundServer, servePlayground } from './browser-tests'

const browserName = process.env.SHARD_EDITOR_BROWSER ?? 'chromium'
const engine = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium

describe(`embeddable audio editor (${browserName})`, () => {
  let server: PlaygroundServer, unavailable: string | undefined
  beforeAll(async () => {
    server = await servePlayground()
    try {
      const browser = await engine.launch()
      await browser.close()
    } catch (error) {
      unavailable = String(error)
      checkRequired('Audio editor', unavailable)
    }
  }, timeout(30000))
  afterAll(async () => {
    await server?.close()
  })
  it(
    'edits, saves and resizes independent shadow widgets at 300 px in both themes',
    async (ctx) => {
      if (unavailable) return ctx.skip()
      const browser = await engine.launch()
      const errors: string[] = []
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 1000 },
          reducedMotion: 'reduce',
        })
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        const full = page.locator('#full')
        await full.getByRole('tab', { name: 'Event', exact: true }).click()
        await full.locator('details[data-group="/layers/0"] > summary').click()
        // Use the same numeric control reachable by keyboard; all edits flow through model commands.
        const gain = full.locator('[data-path="/layers/0/gainDb"]')
        await gain.fill('-6')
        await gain.press('Tab')
        await full.getByRole('button', { name: 'Save', exact: true }).click()
        await page.waitForFunction(() => {
          const demo = (
            globalThis as unknown as { audioEditorDemo: { session: { state: { dirty: boolean } } } }
          ).audioEditorDemo
          return !demo.session.state.dirty
        })
        expect(
          await page.evaluate(() => {
            const demo = (
              globalThis as unknown as {
                audioEditorDemo: { host: { writes(): number }; compactHost: { writes(): number } }
              }
            ).audioEditorDemo
            return [demo.host.writes(), demo.compactHost.writes()]
          }),
        ).toEqual([1, 0])
        await page.getByRole('button', { name: '300 px panels' }).click()
        const destination = process.env.SHARD_AUDIO_EDITOR_EVIDENCE
        if (destination) await mkdir(destination, { recursive: true })
        for (const theme of ['dark', 'light']) {
          await page.locator('#theme').selectOption(theme)
          for (const name of ['Event', 'Mixer', 'Music', 'Parameters', 'Diagnostics', 'Library']) {
            await full.getByRole('tab', { name, exact: true }).click()
            const layout = await full.evaluate((element) => {
              const root = element.querySelector('[data-audio-editor]')?.shadowRoot
              const width = element.clientWidth
              const toolbar = root?.querySelector('[role="toolbar"]')
              return {
                width,
                toolbarWidth: toolbar?.getBoundingClientRect().width ?? 0,
                hostScroll: element.scrollWidth,
              }
            })
            expect(layout.width).toBeLessThanOrEqual(300)
            expect(layout.hostScroll).toBeLessThanOrEqual(302)
          }
          if (destination)
            await page.screenshot({
              path: join(destination, `${browserName}-${theme}-300px.png`),
              fullPage: true,
            })
        }
        await page.evaluate(() => {
          document.body.style.zoom = '2'
        })
        await full.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded()
        expect(await full.getByRole('button', { name: 'Save', exact: true }).isVisible()).toBe(true)
        if (destination) {
          await page.screenshot({
            path: join(destination, `${browserName}-200-percent.png`),
            fullPage: true,
          })
          await writeFile(
            join(destination, `${browserName}-capabilities.json`),
            JSON.stringify(
              await page.evaluate(() => ({
                userAgent: navigator.userAgent,
                audioContext: typeof AudioContext !== 'undefined',
                offlineAudioContext: typeof OfflineAudioContext !== 'undefined',
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                studioWebview: false,
              })),
              null,
              2,
            ),
          )
          await writeFile(
            join(destination, `${browserName}-accessibility.yaml`),
            await page.locator('#full').ariaSnapshot(),
          )
        }
        expect(errors).toEqual([])
      } finally {
        await browser.close()
      }
    },
    timeout(60000),
  )
})
