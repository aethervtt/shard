import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer, type ImportContext, importerFor } from '@shard/assets'
import { World } from '@shard/core'
import { createNodePlatform } from '@shard/platform-node'
import { readKtx2, Textures } from '@shard/texture'
import { afterEach, describe, expect, it } from 'vitest'
import type { FontMetricsJson } from './font'
import { FontImporter, FontImportSettings, Fonts } from './importer'
import { layoutText } from './layout'
import './index'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const interBytes = new Uint8Array(readFileSync(resolve(fixtures, 'Inter-Regular.ttf')))
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function fakeContext(settings: Record<string, unknown>) {
  const warnings: string[] = []
  const ctx: ImportContext = {
    settings: {
      ...(FontImportSettings.serialize(FontImportSettings.deserialize({})) as object),
      ...settings,
    },
    list: async () => [],
    read: async () => {
      throw new Error('no reads')
    },
    asset: async () => {
      throw new Error('no assets')
    },
    depend: () => {},
    resolve: (p) => `assets/fonts/${p}`,
    warn: (m) => {
      warnings.push(m)
    },
  }
  return { ctx, warnings }
}

describe('font importer', () => {
  it('handles .ttf and .otf', () => {
    expect(importerFor('assets/a.ttf')).toBe(FontImporter)
    expect(importerFor('assets/a.OTF')).toBe(FontImporter)
  })

  it('imports metrics JSON plus a linear RGBA8 #Atlas texture, in under 2 s for latin-extended', async () => {
    const { ctx, warnings } = fakeContext({ charset: 'latin-extended', fallback: ['jp.ttf'] })
    const t0 = performance.now()
    const result = await FontImporter.import(
      { path: 'assets/fonts/Inter-Regular.ttf', bytes: interBytes, text: () => '' },
      ctx,
    )
    const ms = performance.now() - t0
    console.log(`font import (latin-extended, KTX2 included): ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(budget(2000))
    const [main, atlas] = result.assets
    expect(result.assets).toHaveLength(2)
    expect(main).toMatchObject({ label: '', type: 'Font' })
    expect(main!.dependencies).toEqual(['#Atlas', 'assets/fonts/jp.ttf'])
    expect(main!.bytes).toBe(interBytes)
    const metrics = main!.json as unknown as FontMetricsJson
    expect(metrics).toMatchObject({ version: 1, size: 48, range: 4, charset: 'latin-extended' })
    expect(metrics.fallback).toEqual(['assets/fonts/jp.ttf'])
    expect(metrics.glyphs.length).toBeGreaterThan(320)
    expect(JSON.parse(JSON.stringify(metrics))).toEqual(metrics)
    expect(atlas).toMatchObject({ label: 'Atlas', type: 'Texture' })
    const ktx = readKtx2(atlas!.bytes!)
    expect(ktx).toMatchObject({ width: 1024, height: 512, usage: 'data', srgb: false })
    expect(ktx.levels).toHaveLength(1)
    // Charset characters the font lacks are a warning, not a failure.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/lacks 2 charset characters/)
  })

  it('custom charsets, no kerning, no outlines', async () => {
    const { ctx } = fakeContext({
      charset: 'custom',
      customCharset: 'AV',
      kerning: false,
      outlines: false,
    })
    const result = await FontImporter.import(
      { path: 'assets/fonts/Inter-Regular.ttf', bytes: interBytes, text: () => '' },
      ctx,
    )
    const metrics = result.assets[0]!.json as unknown as FontMetricsJson
    expect(metrics.glyphs.map((g) => g.u)).toEqual([0x20, 0x41, 0x56])
    expect(metrics.kerning).toEqual([])
    expect(result.assets[0]!.bytes).toBeUndefined()
  })

  it('fails with a ShardError on a file that is not a font', async () => {
    const { ctx } = fakeContext({})
    await expect(
      FontImporter.import(
        { path: 'assets/bad.ttf', bytes: new Uint8Array(64), text: () => '' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'text/font-parse-failed' })
  })

  it('loads through the asset server: atlas texture, fallback font linked, runtime glyphs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-text-'))
    roots.push(root)
    mkdirSync(join(root, 'assets/fonts'), { recursive: true })
    copyFileSync(
      resolve(fixtures, 'Inter-Regular.ttf'),
      join(root, 'assets/fonts/Inter-Regular.ttf'),
    )
    copyFileSync(resolve(fixtures, 'NotoSansJP-subset.ttf'), join(root, 'assets/fonts/jp.ttf'))
    writeFileSync(
      join(root, 'assets/fonts/Inter-Regular.ttf.meta'),
      JSON.stringify({
        guid: 'a'.repeat(32),
        settings: { charset: 'latin', fallback: ['jp.ttf'] },
      }),
    )
    writeFileSync(
      join(root, 'assets/fonts/jp.ttf.meta'),
      JSON.stringify({
        guid: 'b'.repeat(32),
        settings: { charset: 'custom', customCharset: '日本' },
      }),
    )
    const assets = assetServer(new World()).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    const report = await assets.scan()
    expect(report.failed).toEqual([])
    await assets.load('assets/fonts/Inter-Regular.ttf')
    const fonts = assets.world.resource(Fonts)
    const font = fonts.get(assets.resolve('assets/fonts/Inter-Regular.ttf'))!
    const jp = fonts.get(assets.resolve('assets/fonts/jp.ttf'))!
    expect(font.name).toContain('Inter')
    expect(font.fallbacks).toEqual([jp])
    const page = font.pages[0]!
    expect(page.ref?.path).toBe('assets/fonts/Inter-Regular.ttf#Atlas')
    const texture = assets.world.resource(Textures).get(page.ref)!
    expect(texture).toMatchObject({ width: page.width, height: page.height, usage: 'data' })
    // 日 from the fallback's atlas, 界 generated from its outlines, Ł from Inter's own outlines.
    const layout = layoutText(font, 'Hi 日界 Ł')
    const from = layout.glyphs.slice(0, layout.count).map((g) => [g.font === jp, g.runtime])
    expect(from).toEqual([
      [false, false],
      [false, false],
      [true, false],
      [true, true],
      [false, true],
    ])
    expect(font.runtimeGlyphs).toBe(1)
    expect(jp.runtimeGlyphs).toBe(1)
    expect(assets.info('assets/fonts/Inter-Regular.ttf').info).toMatchObject({ charset: 'latin' })

    // Hot reload: new settings re-import; the same Font object updates and keeps its fallbacks.
    const version = font.version
    await new Promise((r) => setTimeout(r, 10))
    writeFileSync(
      join(root, 'assets/fonts/Inter-Regular.ttf.meta'),
      JSON.stringify({
        guid: 'a'.repeat(32),
        settings: { charset: 'latin-extended', fallback: ['jp.ttf'] },
      }),
    )
    expect((await assets.scan()).failed).toEqual([])
    expect(fonts.get(assets.resolve('assets/fonts/Inter-Regular.ttf'))).toBe(font)
    expect(font.version).toBeGreaterThan(version)
    expect(font.charset).toBe('latin-extended')
    expect(font.resolve(0x141).runtime).toBe(false)
    expect(font.runtimeGlyphs).toBe(0)
    expect(font.fallbacks).toEqual([jp])
    expect(font.resolve(0x65e5).font).toBe(jp)
  })
})
