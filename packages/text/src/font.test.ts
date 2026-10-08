import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { budget } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { buildFont, fontFromBytes } from './build'
import { charsetCodepoints } from './charset'
import { Font } from './font'
import { layoutText, measureText } from './layout'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const read = (name: string) => new Uint8Array(readFileSync(resolve(fixtures, name)))
const interBytes = read('Inter-Regular.ttf')
const legacyBytes = read('Inter-legacykern.ttf')
const notoBytes = read('NotoSansJP-subset.ttf')
/** Widths HarfBuzz shapes for test strings (kern feature only), font units. */
const expected = JSON.parse(
  readFileSync(resolve(fixtures, 'harfbuzz-widths.json'), 'utf8'),
) as Record<string, { unitsPerEm: number; strings: Record<string, number> }>

const inter = fontFromBytes(interBytes, { charset: 'latin-extended' })

describe('charsets', () => {
  it('latin is ASCII + Latin-1 + punctuation; latin-extended adds Latin Extended-A', () => {
    const latin = charsetCodepoints('latin')
    const ext = charsetCodepoints('latin-extended')
    expect(latin).toContain(0x41)
    expect(latin).toContain(0xe9)
    expect(latin).toContain(0x2014)
    expect(latin).not.toContain(0x141)
    expect(ext).toContain(0x141)
    expect(ext.length - latin.length).toBe(128)
    expect(charsetCodepoints('日本')).toEqual([0x20, 0x65e5, 0x672c])
  })
})

describe('font metrics', () => {
  it('advances and kerning match HarfBuzz within 0.5 px at 48 px (GPOS and legacy kern)', () => {
    const legacy = fontFromBytes(legacyBytes, { charset: 'latin' })
    for (const [file, font] of [
      ['Inter-Regular.ttf', inter],
      ['Inter-legacykern.ttf', legacy],
    ] as const) {
      const { unitsPerEm, strings } = expected[file]!
      let kerned = 0
      for (const [key, units] of Object.entries(strings)) {
        const noKern = key.endsWith('|nokern')
        const text = noKern ? key.slice(0, -7) : key
        const width = measureText(font, text, { size: 48, kerning: !noKern }).width
        expect(Math.abs(width - (units * 48) / unitsPerEm), `${file}: ${key}`).toBeLessThan(0.5)
        if (!noKern && units !== strings[`${key}|nokern`]) kerned++
      }
      expect(kerned).toBeGreaterThan(3)
    }
  })

  it('reads GPOS pair kerning (inside extension lookups) and the legacy kern table', () => {
    const av = inter.kerning(inter.glyph(0x41)!, inter.glyph(0x56)!)
    expect(av).toBeLessThan(-0.02)
    const legacy = fontFromBytes(legacyBytes, { charset: 'AVTo' })
    expect(legacy.kerning(legacy.glyph(0x41)!, legacy.glyph(0x56)!)).toBeCloseTo(-150 / 2048, 5)
    expect(legacy.metrics.kerning).toHaveLength(6)
  })

  it('normalizes font metrics to em units and round-trips through JSON', () => {
    expect(inter.ascent).toBeCloseTo(1984 / 2048, 5)
    expect(inter.descent).toBeCloseTo(-494 / 2048, 5)
    expect(inter.unitsPerEm).toBe(2048)
    const build = buildFont(interBytes, { charset: 'latin' })
    const json = JSON.parse(JSON.stringify(build.metrics))
    const font = Font.fromMetrics(json, { pixels: build.pages.map((p) => p.pixels) })
    const a = font.glyph(0x41)!
    expect(a.advance).toBeCloseTo(1413 / 2048, 5)
    expect(a.visible).toBe(true)
    expect(a.u1).toBeGreaterThan(a.u0)
    expect(a.v1).toBeGreaterThan(a.v0)
    expect(font.glyph(0x20)!.visible).toBe(false)
    expect(font.pages[0]!.texture).toMatchObject({ format: 'rgba8unorm', usage: 'data' })
    expect(measureText(font, 'AVATAR', { size: 48 }).width).toBeCloseTo(
      measureText(inter, 'AVATAR', { size: 48 }).width,
      4,
    )
  })

  it('imports the latin-extended set (≈330 glyphs) and packs it in under 2 s', () => {
    const t0 = performance.now()
    const build = buildFont(interBytes, { charset: 'latin-extended' })
    const ms = performance.now() - t0
    console.log(
      `latin-extended: ${build.metrics.glyphs.length} glyphs, ${build.metrics.kerning.length / 3} kerning pairs, ` +
        `pages ${build.pages.map((p) => `${p.width}x${p.height}`).join(', ')}, ${ms.toFixed(0)} ms`,
    )
    expect(build.metrics.glyphs.length).toBeGreaterThan(320)
    expect(build.pages).toHaveLength(1)
    expect(ms).toBeLessThan(budget('text/build-font'))
  })
})

describe('missing glyphs', () => {
  it('uses a fallback font for glyphs the font lacks, and says which font drew them', () => {
    const noto = fontFromBytes(notoBytes, { charset: '日本語の文字', outlines: false })
    const latin = fontFromBytes(interBytes, { charset: 'latin', outlines: false })
    latin.fallbacks = [noto]
    const g = latin.resolve(0x65e5)
    expect(g.font).toBe(noto)
    expect(g.runtime).toBe(false)
    expect(latin.missing.size).toBe(0)
    const layout = layoutText(latin, 'Hi 日本')
    expect(layout.count).toBe(4)
    expect(layout.pageCount).toBe(2)
    expect(layout.glyphs.slice(0, layout.count).map((x) => x.font === noto)).toEqual([
      false,
      false,
      true,
      true,
    ])
    // Nothing has it: the missing-glyph box, and the codepoint is reported.
    const box = latin.resolve(0x4e2d + 1)
    expect(box).toBe(latin.notdef)
    expect(box.visible).toBe(true)
    expect(latin.missing.has(0x4e2e)).toBe(true)
    expect(layoutText(latin, 'a丮').missing).toBe(1)
  })

  it('generates glyphs outside the charset at runtime, on a new atlas page, before fallbacks', () => {
    const font = fontFromBytes(interBytes, { charset: 'latin' })
    const other = fontFromBytes(interBytes, { charset: 'latin-extended', outlines: false })
    font.fallbacks = [other]
    const pages = font.pages.length
    const version = font.version
    // Ł is in the fallback's atlas, but the font's own outlines come first.
    const l = font.resolve(0x141)
    expect(l.font).toBe(font)
    expect(l.runtime).toBe(true)
    expect(font.runtimeGlyphs).toBe(1)
    expect(font.pages.length).toBe(pages + 1)
    const page = font.pages[l.page]!
    expect(page.runtime).toBe(true)
    expect(page.texture!.version).toBe(1)
    expect(font.version).toBeGreaterThan(version)
    // Its field is a real glyph: inside at the stem, same metrics as the imported one.
    const imported = other.glyph(0x141)!
    expect(l.advance).toBeCloseTo(imported.advance, 5)
    expect(l.w).toBe(imported.w)
    expect(l.h).toBe(imported.h)
    const px = (font: Font, g: typeof l) => {
      const p = font.pages[g.page]!
      const data = p.texture!.levels![0]!
      const out: number[] = []
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w * 4; x++) out.push(data[((g.y + y) * p.width + g.x) * 4 + x]!)
      }
      return out
    }
    expect(px(font, l)).toEqual(px(other, imported))
    // Cached: resolving again doesn't generate again; a second glyph shares the page.
    expect(font.resolve(0x141)).toBe(l)
    const arrow = font.resolve(0x2192)
    expect(arrow.page).toBe(l.page)
    expect(font.runtimeGlyphs).toBe(2)
    expect(page.texture!.version).toBe(2)
    const layout = layoutText(font, 'Łódź →')
    expect(layout.pages.slice(0, layout.pageCount)).toEqual([page, font.pages[0]])
  })

  it('generates missing glyphs from a fallback font’s outlines into its own runtime page', () => {
    const noto = fontFromBytes(notoBytes, { charset: 'あ' })
    const latin = fontFromBytes(interBytes, { charset: 'latin', outlines: false })
    latin.fallbacks = [noto]
    const g = latin.resolve(0x754c) // 界, not in noto's atlas but in its outlines
    expect(g.font).toBe(noto)
    expect(g.runtime).toBe(true)
    expect(noto.runtimeGlyphs).toBe(1)
    expect(noto.pages[g.page]!.runtime).toBe(true)
    expect(latin.runtimeGlyphs).toBe(0)
  })
})
