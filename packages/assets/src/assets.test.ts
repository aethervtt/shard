import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineComponent, defineResource, defineSchema, t, World } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import type { Platform } from '@aethervtt/shard-platform'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetServer, AssetStore, defineAssetType, defineDataAsset, defineImporter } from './index'

// --- a tiny test format ----------------------------------------------------------

class TextAsset {
  text: string
  version = 0
  constructor(text: string) {
    this.text = text
  }
}

const Texts = defineResource<AssetStore<TextAsset>>('test-assets/Texts', {
  init: () => new AssetStore('Text'),
})

defineAssetType<TextAsset>('Text', {
  store: Texts,
  load: (artifact) => new TextAsset(artifact.json as string),
  update: (existing, next) => {
    existing.text = next.text
    existing.version++
  },
})

let importCount = 0
const textImporter = defineImporter({
  name: 'test-text',
  version: 1,
  extensions: ['.txt'],
  settings: defineSchema('test-assets/TextSettings', { upper: t.bool() }),
  async import(source, ctx) {
    importCount++
    let text = source.text()
    // "@include other.txt" pulls another file in, making it an import dependency.
    const include = /^@include (.+)$/m.exec(text)
    if (include) {
      const other = new TextDecoder().decode(await ctx.read(include[1]!.trim()))
      text = text.replace(include[0], other)
    }
    if (text.includes('BOOM')) throw new Error('boom')
    if (ctx.settings.upper) text = text.toUpperCase()
    return { assets: [{ label: '', type: 'Text', json: text }] }
  },
})

const Note = defineSchema('test-assets/Note', {
  title: t.string({ required: true }),
  stars: t.u8({ max: 5 }),
})
defineDataAsset('Text', Note, { extension: 'note' })

const HoldsText = defineComponent('test-assets/HoldsText', { text: t.handle('Text') })

// --- helpers ---------------------------------------------------------------------

let root: string
let platform: Platform

function write(path: string, content: string) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function read(path: string) {
  return readFileSync(join(root, path), 'utf8')
}

function server(p: Platform = platform) {
  return new AssetServer(new World()).configure({ platform: p })
}

/** Bumps a file's mtime-visible content so stat-based change detection sees it. */
async function touch(path: string, content: string) {
  await new Promise((r) => setTimeout(r, 5))
  write(path, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shard-assets-'))
  platform = createNodePlatform({ root, logTo: () => {} })
  importCount = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('identity', () => {
  it('writes a .meta with a guid on first scan, and keeps it across moves', async () => {
    write('assets/a.txt', 'hello')
    const s = server()
    const report = await s.scan()
    expect(report.imported).toEqual(['assets/a.txt'])
    const meta = JSON.parse(read('assets/a.txt.meta'))
    expect(meta.guid).toMatch(/^[0-9a-f]{32}$/)
    expect(meta.importer).toBe('test-text')
    expect(meta.settings).toEqual({ upper: false })
    expect(s.resolve('assets/a.txt')?.guid).toBe(meta.guid)

    // Moved with its .meta: same guid.
    await s.move('assets/a.txt', 'assets/sub/b.txt')
    expect(existsSync(join(root, 'assets/sub/b.txt.meta'))).toBe(true)
    expect(s.resolve('assets/sub/b.txt')?.guid).toBe(meta.guid)
    expect(s.resolve('assets/a.txt')).toBeUndefined()

    // Moved without its .meta (a plain `mv`): same guid, reported.
    const fresh = server()
    await fresh.scan()
    rmSync(join(root, 'assets/sub/b.txt.meta'))
    const content = read('assets/sub/b.txt')
    rmSync(join(root, 'assets/sub/b.txt'))
    write('assets/c.txt', content)
    const moved = await fresh.scan()
    expect(moved.moved).toEqual([{ from: 'assets/sub/b.txt', to: 'assets/c.txt' }])
    expect(fresh.resolve('assets/c.txt')?.guid).toBe(meta.guid)
    expect(JSON.parse(read('assets/c.txt.meta')).guid).toBe(meta.guid)
  })

  it('move rewrites path references in scenes and data assets', async () => {
    write('assets/a.txt', 'hello')
    write(
      'scenes/main.scene.json',
      JSON.stringify({
        version: 1,
        entities: [
          {
            name: 'x',
            components: { 'test-assets/HoldsText': { text: { path: 'assets/a.txt' } } },
          },
        ],
      }),
    )
    write('scenes/other.scene.json', JSON.stringify({ version: 1, entities: [] }))
    const s = server()
    await s.scan()
    const result = await s.move('assets/a.txt', 'assets/b.txt')
    expect(result.rewritten).toEqual(['scenes/main.scene.json'])
    expect(read('scenes/main.scene.json')).toContain('"path": "assets/b.txt"')
  })
})

describe('the import cache', () => {
  it('re-imports exactly what changed: source, settings, importer version, dependency', async () => {
    write('assets/a.txt', 'a')
    write('assets/b.txt', '@include parts/shared.part')
    write('assets/parts/shared.part', 'shared v1')
    write('assets/c.txt', 'c')
    const s = server()
    expect((await s.scan()).imported).toEqual(['assets/a.txt', 'assets/b.txt', 'assets/c.txt'])

    expect((await s.scan()).imported).toEqual([])
    expect(importCount).toBe(3)

    await touch('assets/a.txt', 'a2')
    expect((await s.scan()).imported).toEqual(['assets/a.txt'])

    const meta = JSON.parse(read('assets/c.txt.meta'))
    meta.settings.upper = true
    await touch('assets/c.txt.meta', JSON.stringify(meta))
    expect((await s.scan()).imported).toEqual(['assets/c.txt'])

    await touch('assets/parts/shared.part', 'shared v2')
    expect((await s.scan()).imported).toEqual(['assets/b.txt'])

    // Rewriting a file with identical content changes its mtime but not its key: no import.
    await touch('assets/a.txt', 'a2')
    expect((await s.scan()).imported).toEqual([])

    ;(textImporter as { version: number }).version = 2
    try {
      expect((await s.scan()).imported).toEqual(['assets/a.txt', 'assets/b.txt', 'assets/c.txt'])
    } finally {
      ;(textImporter as { version: number }).version = 1
    }
  })

  it('a fresh server over the same folder reuses the cache (no imports)', async () => {
    write('assets/a.txt', 'a')
    await server().scan()
    const count = importCount
    const again = server()
    const report = await again.scan()
    expect(report.imported).toEqual([])
    expect(importCount).toBe(count)
    await again.load('assets/a.txt')
    expect(again.world.resource(Texts).get(again.resolve('assets/a.txt'))?.text).toBe('a')
  })

  it('stats 1,000 unchanged sources in under 200 ms', { timeout: timeout(60_000) }, async () => {
    for (let i = 0; i < 1000; i++)
      write(`assets/many/${Math.floor(i / 100)}/f${i}.txt`, `file ${i}`)
    await server().scan()
    const s = server()
    await s.scan() // loads the index
    const start = performance.now()
    const report = await s.scan()
    const ms = performance.now() - start
    expect(report.imported).toEqual([])
    expect(report.unchanged).toBe(1000)
    expect(ms).toBeLessThan(budget(200))
  })
})

describe('errors', () => {
  it('a data asset with a bad field fails with a pointer and other imports continue', async () => {
    write('data/good.note.json', JSON.stringify({ title: 'fine', stars: 3 }))
    write('data/bad.note.json', JSON.stringify({ title: 'too many', stars: 9 }))
    write('assets/a.txt', 'a')
    const s = server()
    const report = await s.scan()
    expect(report.imported).toEqual(['assets/a.txt', 'data/good.note.json'])
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]).toMatchObject({
      path: 'data/bad.note.json',
      error: { code: 'assets/import-failed', path: '/stars' },
    })
    expect(s.info('data/bad.note.json').error?.path).toBe('/stars')
  })

  it('invalid .meta settings fail with a pointer into the settings', async () => {
    write('assets/a.txt', 'a')
    write('assets/a.txt.meta', JSON.stringify({ guid: 'f'.repeat(32), settings: { upper: 'yes' } }))
    const report = await server().scan()
    expect(report.failed[0]).toMatchObject({
      error: { code: 'assets/invalid-meta', path: '/settings/upper' },
    })
  })

  it('a broken edit keeps the last good asset loaded', async () => {
    write('assets/a.txt', 'good')
    const s = server()
    await s.scan()
    await s.load('assets/a.txt')
    const ref = s.resolve('assets/a.txt')!
    await touch('assets/a.txt', 'BOOM')
    const report = await s.scan()
    expect(report.failed).toHaveLength(1)
    expect(s.world.resource(Texts).get(ref)?.text).toBe('good')
    expect(s.state(ref)).toBe('loaded')
    await touch('assets/a.txt', 'fixed')
    await s.scan()
    expect(s.world.resource(Texts).get(ref)?.text).toBe('fixed')
  })
})

describe('loading', () => {
  it('times the wall time loads were in flight, overlapping loads once (0062)', async () => {
    write('assets/a.txt', 'a')
    write('assets/b.txt', 'b')
    const s = server()
    await s.scan()
    expect(s.busyMs()).toBe(0)
    const start = performance.now()
    await s.whenSettled(['assets/a.txt', 'assets/b.txt'])
    const elapsed = performance.now() - start
    const busy = s.busyMs()
    expect(busy).toBeGreaterThan(0)
    expect(busy).toBeLessThanOrEqual(elapsed + 1)
    expect(s.busyMs()).toBe(busy) // nothing in flight: it stops counting
  })

  it('reloads in place, keeping the object and guid, when a loaded source changes', async () => {
    write('assets/a.txt', 'one')
    const s = server()
    await s.scan()
    await s.load('assets/a.txt')
    const ref = s.resolve('assets/a.txt')!
    const obj = s.world.resource(Texts).get(ref)!
    const events: string[] = []
    s.onEvent((e) => events.push(e.kind))
    await touch('assets/a.txt', 'two')
    await s.scan()
    expect(s.world.resource(Texts).get(ref)).toBe(obj)
    expect(obj.text).toBe('two')
    expect(obj.version).toBe(1)
    expect(events).toEqual(['modified'])
  })

  it('hot reloads through the file watcher', async () => {
    write('assets/a.txt', 'one')
    const s = server()
    await s.scan()
    await s.load('assets/a.txt')
    const scanned = new Promise<void>((resolve) => {
      void s
        .watch({ debounceMs: 20, onScan: (r) => r.imported.length > 0 && resolve() })
        .then((stop) => scanned.finally(stop))
    })
    await touch('assets/a.txt', 'two')
    await scanned
    expect(s.world.resource(Texts).get(s.resolve('assets/a.txt'))?.text).toBe('two')
  })

  it('collect unloads unreferenced assets, keeping referenced and pinned ones', async () => {
    write('assets/a.txt', 'a')
    write('assets/b.txt', 'b')
    write('assets/c.txt', 'c')
    const s = server()
    await s.scan()
    await s.whenSettled(['assets/a.txt', 'assets/b.txt', 'assets/c.txt'])
    const e = s.world.spawn([HoldsText, { text: s.resolve<'Text'>('assets/a.txt')! }])
    s.pin('assets/b.txt', 'hud')
    expect(s.collect()).toEqual(['assets/c.txt'])
    expect(s.state('assets/c.txt')).toBe('unloaded')
    expect(s.state('assets/a.txt')).toBe('loaded')
    expect(s.state('assets/b.txt')).toBe('loaded')
    s.world.despawn(e)
    s.unpin('hud')
    expect(s.collect().sort()).toEqual(['assets/a.txt', 'assets/b.txt'])
    // Unloaded assets load again on request.
    await s.load('assets/c.txt')
    expect(s.state('assets/c.txt')).toBe('loaded')
  })

  it('a host that cannot list files loads from the prebuilt catalog', async () => {
    write('assets/a.txt', 'from the cache')
    await server().scan()
    const { list: _l, stat: _s, watch: _w, ...fs } = platform.fs
    const readOnly: Platform = { ...platform, fs: { ...fs, writable: false } }
    const s = server(readOnly)
    await s.scan()
    await s.load('assets/a.txt')
    expect(s.world.resource(Texts).get(s.resolve('assets/a.txt'))?.text).toBe('from the cache')
  })

  it('reimport with new settings writes the .meta and reloads', async () => {
    write('assets/a.txt', 'quiet')
    const s = server()
    await s.scan()
    await s.load('assets/a.txt')
    await s.reimport('assets/a.txt', { settings: { upper: true } })
    expect(JSON.parse(read('assets/a.txt.meta')).settings.upper).toBe(true)
    expect(s.world.resource(Texts).get(s.resolve('assets/a.txt'))?.text).toBe('QUIET')
  })
})
