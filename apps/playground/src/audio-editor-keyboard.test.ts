import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioEditorSession } from '@aethervtt/shard-audio-editor/model'
import { timeout } from '@aethervtt/shard-core/test-env'
import { chromium, firefox, type Locator, type Page, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { createDemoAudioHost } from './audio-editor-host'
import { checkRequired, type PlaygroundServer, servePlayground } from './browser-tests'

interface Demo {
  session: AudioEditorSession
  compactSession: AudioEditorSession
  host: ReturnType<typeof createDemoAudioHost>
  createAudioEditorSession: typeof import('@aethervtt/shard-audio-editor/model').createAudioEditorSession
  mountAudioEditor: typeof import('@aethervtt/shard-audio-editor/dom').mountAudioEditor
}
interface MeterFixture {
  calls: number
  failed: boolean
  container: HTMLElement
  session: AudioEditorSession
  view: ReturnType<Demo['mountAudioEditor']>
}
const browserName = process.env.SHARD_EDITOR_BROWSER ?? 'chromium'
const engine = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium

/** Find a control by actual tab traversal; never click or programmatically focus authored controls. */
async function reach(page: Page, locator: Locator): Promise<void> {
  for (let attempt = 0; attempt < 900; attempt++) {
    if (await locator.evaluate((node) => (node.getRootNode() as ShadowRoot).activeElement === node))
      return
    const backward = await locator.evaluate((node) => {
      let active: Element | null = node.ownerDocument.activeElement
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
      if (!active) return false
      let target: Node = node
      let current: Node = active
      if (target.getRootNode() !== current.getRootNode()) {
        while ((target.getRootNode() as ShadowRoot).host)
          target = (target.getRootNode() as ShadowRoot).host
        while ((current.getRootNode() as ShadowRoot).host)
          current = (current.getRootNode() as ShadowRoot).host
      }
      return !!(target.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    await page.keyboard.press(backward ? 'Shift+Tab' : 'Tab')
  }
  throw new Error(
    `Keyboard tab order could not reach ${(await locator.getAttribute('aria-label')) ?? (await locator.textContent())}: ${JSON.stringify(await locator.evaluate((node) => ({ disabled: (node as HTMLButtonElement).disabled, active: (node.getRootNode() as ShadowRoot).activeElement?.outerHTML.slice(0, 250) })))}`,
  )
}
async function activate(page: Page, locator: Locator): Promise<void> {
  await reach(page, locator)
  await page.keyboard.press('Enter')
}
async function enter(page: Page, locator: Locator, value: string): Promise<void> {
  await reach(page, locator)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(value)
  await page.keyboard.press('Tab')
}
async function tab(page: Page, scope: Locator, index: number): Promise<void> {
  await reach(page, scope.locator('[role="tab"][aria-selected="true"]'))
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowRight')
}
async function saved(page: Page, compact = false): Promise<void> {
  await activate(
    page,
    page.locator(compact ? '#compact' : '#full').getByRole('button', { name: 'Save', exact: true }),
  )
  await page.waitForFunction((compact) => {
    const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
    return !(compact ? demo.compactSession : demo.session).state.dirty
  }, compact)
}

describe(`audio editor keyboard authoring (${browserName})`, () => {
  let server: PlaygroundServer
  let unavailable: string | undefined
  beforeAll(async () => {
    server = await servePlayground()
    try {
      const browser = await engine.launch()
      await browser.close()
    } catch (error) {
      unavailable = String(error)
      checkRequired('Audio editor keyboard', unavailable)
    }
  }, timeout(30000))
  afterAll(async () => {
    await server?.close()
  })

  it(
    'creates a layer, edits curves, routes a bus, changes music sample markers, saves and auditions using the keyboard',
    async (ctx) => {
      if (unavailable) return ctx.skip()
      const browser = await engine.launch()
      try {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 800 },
          reducedMotion: 'reduce',
        })
        const failures: string[] = []
        page.on('pageerror', (error) => failures.push(error.message))
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        const full = page.locator('#full')
        const compact = page.locator('#compact')
        await activate(page, page.getByRole('button', { name: '300 px panels', exact: true }))
        await tab(page, full, 1)
        await activate(page, full.getByRole('button', { name: 'Add layers', exact: true }))
        await activate(page, full.locator('details[data-group="/layers/2"] > summary'))
        await enter(page, full.locator('[data-path="/layers/2/id"]'), 'keyboard-layer')
        await activate(page, full.locator('details[data-group="/layers/2/choices"] > summary'))
        await activate(page, full.getByRole('button', { name: 'Add choices', exact: true }))
        await activate(page, full.locator('details[data-group="/layers/2/choices/0"] > summary'))
        await activate(page, full.getByRole('button', { name: 'Choose clip', exact: true }))
        await activate(page, full.getByRole('button', { name: 'engine-low.wav', exact: true }))
        await activate(page, full.locator('details[data-group="/layers/0"] > summary'))
        await activate(page, full.locator('details[data-group="/layers/0/curves"] > summary'))
        await activate(page, full.locator('details[data-group="/layers/0/curves/0"] > summary'))
        await activate(
          page,
          full.locator('details[data-group="/layers/0/curves/0/points"] > summary'),
        )
        await enter(page, full.locator('[data-path="/layers/0/curves/0/points/1/1"]'), '-48')
        await saved(page)
        expect(
          await page.evaluate(
            () =>
              (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo.session.state
                .document!.value.layers,
          ),
        ).toHaveLength(3)
        await activate(page, full.getByRole('button', { name: 'Play', exact: true }))
        await page.waitForFunction(
          () =>
            (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo.session.state
              .previewState === 'playing',
        )
        await activate(page, full.getByRole('button', { name: 'Stop', exact: true }))

        await activate(page, compact.locator('details[data-group="/buses/1"] > summary'))
        await enter(page, compact.locator('[data-path="/buses/1/parent"]'), 'music')
        await saved(page, true)
        await tab(page, full, 0)
        await activate(page, full.getByRole('button', { name: 'Explore and combat', exact: true }))
        await activate(page, full.locator('details[data-group="/sections/0"] > summary'))
        await activate(page, full.locator('details[data-group="/sections/0/stems"] > summary'))
        await activate(page, full.locator('details[data-group="/sections/0/stems/0"] > summary'))
        await enter(page, full.locator('[data-path="/sections/0/stems/0/startSample"]'), '1')
        await saved(page)
        const results = await page.evaluate(() => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          const engine = [...demo.host.records.values()].find((record) => record.name === 'Engine')!
          return {
            engine: engine.value,
            mixer: demo.compactSession.state.document!.value,
            music: demo.session.state.document!.value,
            writes: demo.host.writes(),
          }
        })
        expect(results.engine.layers).toHaveLength(3)
        expect(results.engine.layers).toMatchObject([
          {
            curves: [
              {
                points: [
                  [0, 0],
                  [1, -48],
                ],
              },
              {},
            ],
          },
          {},
          { id: 'keyboard-layer' },
        ])
        expect(results.mixer.buses).toMatchObject([{}, { parent: 'music' }, {}, {}, {}, {}, {}])
        expect(results.music.sections).toMatchObject([
          { stems: [{ startSample: 1 }, {}, {}, {}] },
          {},
        ])
        expect(results.writes).toBe(2)
        expect(failures).toEqual([])
        const destination = process.env.SHARD_AUDIO_EDITOR_EVIDENCE
        if (destination) {
          await mkdir(destination, { recursive: true })
          await writeFile(
            join(destination, `${browserName}-keyboard-journey.json`),
            JSON.stringify(
              {
                operations: [
                  'create-layer',
                  'choose-host-clip',
                  'edit-curve-point',
                  'save-event',
                  'audition',
                  'route-bus',
                  'save-mixer',
                  'edit-sample-marker',
                  'save-music',
                ],
                input: 'Tab/Enter/arrows/text only; no click or focus APIs',
                results,
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
    timeout(180000),
  )

  it(
    'resets an inherited override and reports then atomically renames global references',
    async (ctx) => {
      if (unavailable) return ctx.skip()
      const browser = await engine.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        // Fixture setup only: authored operations below use actual keyboard commands.
        await page.evaluate(async () => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          const source = [...demo.host.records.values()].find((item) => item.name === 'Engine')!
          demo.host.records.set('inherited-engine', {
            id: 'inherited-engine',
            name: 'Inherited engine',
            type: source.type,
            revision: '1',
            value: { $extends: source.id, mode: 'oneshot', hostNote: 'preserve this field' },
          })
          await demo.session.open('inherited-engine')
        })
        const full = page.locator('#full')
        await tab(page, full, 1)
        await activate(page, full.getByRole('button', { name: 'Reset mode override', exact: true }))
        await saved(page)
        expect(
          await page.evaluate(
            () =>
              (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo.session.state
                .document!.value,
          ),
        ).toMatchObject({ hostNote: 'preserve this field' })
        expect(
          await page.evaluate(
            () =>
              'mode' in
              (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo.session.state
                .document!.value,
          ),
        ).toBe(false)
        await activate(page, full.locator('details[data-group="/layers/0"] > summary'))
        await enter(page, full.locator('[data-path="/layers/0/gainDb"]'), '-9')
        await activate(
          page,
          full.getByRole('button', { name: 'Reset layers override', exact: true }),
        )
        await page.waitForFunction(
          () =>
            !(
              'layers' in
              (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo.session.state
                .document!.value
            ),
        )
        await tab(page, full, 0)
        await activate(page, full.getByRole('button', { name: 'World parameters', exact: true }))
        await activate(page, full.locator('details[data-group="rename"] > summary'))
        await enter(page, full.getByLabel('New parameter name', { exact: true }), 'climate')
        await activate(
          page,
          full.getByRole('button', { name: 'Find dependent documents', exact: true }),
        )
        await page.waitForFunction(() => {
          const root = document.querySelector('#full [data-audio-editor]')!.shadowRoot!
          return root.textContent?.includes('Tavern mixer: 1 references')
        })
        await activate(page, full.getByRole('button', { name: 'Rename safely', exact: true }))
        await page.waitForFunction(() =>
          JSON.stringify(
            (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo.session.state
              .document!.value,
          ).includes('climate'),
        )
        const result = await page.evaluate(() => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          return {
            bank: demo.session.state.document!.value,
            mixer: [...demo.host.records.values()].find((item) => item.name === 'Tavern mixer')!
              .value,
            writes: demo.host.writes(),
          }
        })
        expect(result.bank.parameters).toMatchObject([{ name: 'climate' }])
        expect(result.mixer.curves).toMatchObject([{ parameter: 'climate' }])
        expect(result.writes).toBe(3)
      } finally {
        await browser.close()
      }
    },
    timeout(120000),
  )

  it(
    'stops meter requests when hidden, idle, disconnected or disposed',
    async (ctx) => {
      if (unavailable) return ctx.skip()
      const browser = await engine.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${server.base}/audio-editor.html`)
        await page.waitForFunction(() => 'audioEditorDemo' in globalThis)
        await page.evaluate(async () => {
          const demo = (globalThis as unknown as { audioEditorDemo: Demo }).audioEditorDemo
          const container = document.createElement('div')
          container.style.cssText = 'position:fixed;top:0;left:0;width:300px;height:500px'
          document.body.append(container)
          const fixture = { calls: 0, failed: false, container } as unknown as MeterFixture
          const session = demo.createAudioEditorSession({
            ...demo.host,
            preview: {
              mode: 'audition',
              capabilities: { play: true, control: true },
              async play() {
                return { configured: true }
              },
              stop() {},
              inspect() {
                return {}
              },
              dispose() {},
              command() {
                fixture.calls++
                if (fixture.failed) throw new Error('Disconnected fixture')
                return { available: true, peak: 0.5, rms: 0.25, at: 1 }
              },
            },
          })
          await session.open(
            [...demo.host.records.values()].find((record) => record.type === 'audio/AudioMixer')!
              .id,
          )
          fixture.session = session
          fixture.view = demo.mountAudioEditor(container, { session, layout: 'compact' })
          Object.assign(globalThis, { audioEditorMeterFixture: fixture })
          await session.play()
        })
        const count = () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { audioEditorMeterFixture: MeterFixture })
                .audioEditorMeterFixture.calls,
          )
        await page.waitForFunction(
          () =>
            (globalThis as unknown as { audioEditorMeterFixture: MeterFixture })
              .audioEditorMeterFixture.calls > 0,
        )
        await page.evaluate(() => {
          ;(
            globalThis as unknown as { audioEditorMeterFixture: MeterFixture }
          ).audioEditorMeterFixture.container.hidden = true
        })
        await page.waitForTimeout(150)
        const hidden = await count()
        await page.waitForTimeout(300)
        expect(await count()).toBe(hidden)
        await page.evaluate(() => {
          ;(
            globalThis as unknown as { audioEditorMeterFixture: MeterFixture }
          ).audioEditorMeterFixture.container.hidden = false
        })
        await page.waitForFunction(
          (before) =>
            (globalThis as unknown as { audioEditorMeterFixture: MeterFixture })
              .audioEditorMeterFixture.calls > before,
          hidden,
        )
        await page.evaluate(async () => {
          await (
            globalThis as unknown as { audioEditorMeterFixture: MeterFixture }
          ).audioEditorMeterFixture.session.stop()
        })
        const idle = await count()
        await page.waitForTimeout(300)
        expect(await count()).toBe(idle)
        await page.evaluate(async () => {
          const fixture = (globalThis as unknown as { audioEditorMeterFixture: MeterFixture })
            .audioEditorMeterFixture
          fixture.failed = true
          await fixture.session.play()
        })
        await page.waitForFunction(
          (before) =>
            (globalThis as unknown as { audioEditorMeterFixture: MeterFixture })
              .audioEditorMeterFixture.calls > before,
          idle,
        )
        const disconnected = await count()
        await page.waitForTimeout(300)
        expect(await count()).toBe(disconnected)
        await page.evaluate(async () => {
          const fixture = (globalThis as unknown as { audioEditorMeterFixture: MeterFixture })
            .audioEditorMeterFixture
          fixture.view.dispose()
          await fixture.session.dispose()
        })
        await page.waitForTimeout(300)
        expect(await count()).toBe(disconnected)
      } finally {
        await browser.close()
      }
    },
    timeout(30000),
  )
})
