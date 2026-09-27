import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import type { Entity, World } from '@aethervtt/shard-core'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { Locale, Localized, loadStringTables, setLocale, tr } from '@aethervtt/shard-text'
import { afterEach, describe, expect, it } from 'vitest'
import { UiText } from './components'
import { describeUi } from './methods'
import { addFont, node, rect, root, uiApp } from './testing'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function write(path: string, content: unknown) {
  const file = join(dir!, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(content))
}

const EN = {
  'hud.fuel': 'Fuel: {amount}%',
  'items.count': { one: '{n} item', other: '{n} items' },
  'hud.title': 'Scanner',
}
const PT = {
  'hud.fuel': 'Combustível: {amount}%',
  'items.count': { one: '{n} item', other: '{n} itens' },
}

async function localized() {
  dir = mkdtempSync(join(tmpdir(), 'shard-ui-locale-'))
  write('locales/en.strings.json', EN)
  write('locales/pt-BR.strings.json', PT)
  const ui = await uiApp()
  const server = assetServer(ui.world).configure({
    platform: createNodePlatform({ root: dir, logTo: () => {} }),
    roots: ['locales'],
  })
  await server.scan()
  await loadStringTables(ui.world)
  return ui
}

function shown(world: World, e: Entity): string {
  const find = (n: { entity: number; text?: string; children?: unknown[] }): string | undefined => {
    if (n.entity === e) return n.text
    for (const c of (n.children ?? []) as never[]) {
      const hit = find(c)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return find(describeUi(world).roots[0]!.tree as never) ?? ''
}

describe('localized UI text', () => {
  it('switching locale updates every keyed UiText on the next frame', async () => {
    const { world, frame } = await localized()
    const font = addFont(world)
    const r = root(world, 800, 600, { font })
    const text = (fields: Record<string, unknown>) => node(world, r, [UiText, { font, ...fields }])
    const fuel = text({ key: 'hud.fuel', params: { amount: 42 } })
    const items = text({ key: 'items.count', params: { n: 0 } })
    const title = text({ key: 'hud.title' })
    const plain = text({ text: 'Plain' })
    const missing = text({ key: 'hud.nope', text: 'Until it resolves' })
    frame()
    expect(shown(world, fuel)).toBe('Fuel: 42%')
    expect(shown(world, items)).toBe('0 items')
    expect(shown(world, title)).toBe('Scanner')
    expect(shown(world, plain)).toBe('Plain')
    expect(shown(world, missing)).toBe('Until it resolves')
    const wide = rect(world, fuel)[2]!

    setLocale(world, 'pt-br')
    expect(world.resource(Locale).current).toBe('pt-BR')
    // Code that translates before the frame doesn't hide the switch from the text system.
    expect(tr(world, 'hud.fuel', { amount: 1 })).toBe('Combustível: 1%')
    frame()
    expect(shown(world, fuel)).toBe('Combustível: 42%')
    // Intl.PluralRules: 0 is "one" in Portuguese, "other" in English.
    expect(shown(world, items)).toBe('0 item')
    // pt-BR → pt → en: a key only English has falls back to it.
    expect(shown(world, title)).toBe('Scanner')
    expect(world.get(title, Localized)).toEqual({ value: 'Scanner', locale: 'en' })
    expect(world.get(fuel, Localized).locale).toBe('pt-BR')
    // Layout follows the new string.
    expect(rect(world, fuel)[2]).toBeGreaterThan(wide)

    // Params format for the locale and update the text when they change.
    world.set(fuel, UiText, { params: { amount: 1234.5 } })
    world.set(items, UiText, { params: { n: 3 } })
    frame()
    expect(shown(world, fuel)).toBe('Combustível: 1.234,5%')
    expect(shown(world, items)).toBe('3 itens')
    // The authored text is untouched: saves and scene files never see translations.
    expect(world.get(fuel, UiText).text).toBe('')
    expect(tr(world, 'items.count', { n: 1 })).toBe('1 item')

    // Clearing the key shows the text again.
    world.set(fuel, UiText, { key: '', text: 'Raw' })
    frame()
    expect(shown(world, fuel)).toBe('Raw')
    expect(world.has(fuel, Localized)).toBe(false)
  })

  it('reports keys that resolve nowhere', async () => {
    const { app, world, frame } = await localized()
    const r = root(world)
    node(world, r, [UiText, { key: 'hud.nope', font: addFont(world) }])
    frame()
    const n = (describeUi(world).roots[0]!.tree as unknown as { children: { problem?: string }[] })
      .children[0]!
    expect(n.problem).toContain('locale/missing-key')
    const method = app.methods.find((m) => m.name === 'locale.missing')!
    expect(await method.handler({ app, world }, {})).toMatchObject({
      current: 'en',
      chain: ['en'],
      locales: ['en', 'pt-BR'],
      missing: { 'pt-BR': ['hud.title'] },
      requested: { en: ['hud.nope'] },
    })
  })
})
