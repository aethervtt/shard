import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assetServer } from '@shard/assets'
import { World } from '@shard/core'
import { createNodePlatform } from '@shard/platform-node'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocaleStore,
  localeChain,
  localeOfPath,
  localizationKeysIn,
  placeholdersOf,
  validateLocalization,
  validateStringTable,
} from './locale'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function write(path: string, content: unknown) {
  const file = join(dir!, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

describe('string tables', () => {
  it('name their locale in the file name', () => {
    expect(localeOfPath('locales/en.strings.json')).toBe('en')
    expect(localeOfPath('locales/pt-br.strings.json')).toBe('pt-BR')
    expect(localeOfPath('locales/hud.pt-BR.strings.json')).toBe('pt-BR')
    expect(localeOfPath('locales/not a locale.strings.json')).toBeUndefined()
  })

  it('check plural forms', () => {
    expect(validateStringTable({ a: 'x', b: { one: 'x', other: 'y' } })).toEqual([])
    expect(
      validateStringTable({ a: { one: 'x' }, b: { single: 'x', other: 'y' }, c: 3 }).map((e) => [
        e.code,
        e.path,
      ]),
    ).toEqual([
      ['locale/bad-plural', '/a'],
      ['locale/bad-plural', '/b/single'],
      ['schema/type-mismatch', '/c'],
    ])
    expect(placeholdersOf({ one: '{n} item in {place}', other: '{n} items' })).toEqual([
      'n',
      'place',
    ])
  })

  it('format plurals by Intl.PluralRules and numbers by Intl.NumberFormat', () => {
    const store = new LocaleStore()
    const items = {
      one: '{n} item',
      few: '{n} przedmioty',
      many: '{n} przedmiotów',
      other: '{n} items',
    }
    expect(store.format(items, 'en', { n: 1 })).toBe('1 item')
    expect(store.format(items, 'en', { n: 0 })).toBe('0 items')
    expect(store.format(items, 'pt-BR', { n: 0 })).toBe('0 item')
    expect(store.format(items, 'pl', { n: 3 })).toBe('3 przedmioty')
    expect(store.format(items, 'pl', { n: 5 })).toBe('5 przedmiotów')
    expect(store.format({ zero: 'none', other: '{n}' }, 'en', { count: 0 })).toBe('none')
    expect(store.format('{a} and {b}', 'en', { a: 1500 })).toBe('1,500 and {b}')
    expect(localeChain('pt-BR', 'en')).toEqual(['pt-BR', 'pt', 'en'])
    expect(localeChain('en-GB', 'en')).toEqual(['en-GB', 'en'])
  })

  it('validate across locales: missing keys and params that differ', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shard-locale-'))
    write('locales/en.strings.json', {
      'hud.fuel': 'Fuel {amount}%',
      'hud.speed': '{speed} m/s',
      'menu.play': 'Play',
    })
    write('locales/pt-BR.strings.json', {
      'hud.fuel': 'Combustível {quantidade}%',
      'hud.speed': '{speed} m/s',
    })
    write('locales/broken.xx-!.strings.json', {})
    const world = new World()
    const server = assetServer(world).configure({
      platform: createNodePlatform({ root: dir, logTo: () => {} }),
      roots: ['locales'],
    })
    const scan = await server.scan()
    expect(scan.failed.map((f) => f.error.code)).toEqual(['locale/bad-locale'])
    const report = await validateLocalization(world)
    expect(report.locales).toEqual(['en', 'pt-BR'])
    expect(report.errors.map(({ source, error }) => [source, error.code, error.path])).toEqual([
      ['locales/pt-BR.strings.json', 'locale/param-mismatch', '/hud.fuel'],
      ['locales/pt-BR.strings.json', 'locale/missing-key', '/menu.play'],
    ])
    expect(report.errors[1]!.error.message).toBe('"menu.play" is missing in pt-BR')
  })

  it('finds the keys scenes and prefabs use', () => {
    const scene = {
      entities: [
        { name: 'a', components: { 'ui/UiText': { key: 'hud.fuel' } } },
        {
          name: 'b',
          components: { 'text/Text': { value: 'x' } },
          children: [{ name: 'c', components: { 'text/ScreenText': { key: 'hud.speed' } } }],
        },
      ],
    }
    expect(localizationKeysIn(scene)).toEqual([
      { key: 'hud.fuel', path: '/entities/0/components/ui~1UiText/key' },
      { key: 'hud.speed', path: '/entities/1/children/0/components/text~1ScreenText/key' },
    ])
  })
})
