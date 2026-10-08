import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { budget } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { fontFromBytes } from './build'
import { layoutText, measureText, TextLayout } from './layout'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const read = (name: string) => new Uint8Array(readFileSync(resolve(fixtures, name)))
const inter = fontFromBytes(read('Inter-Regular.ttf'), { charset: 'latin', outlines: false })
const noto = fontFromBytes(read('NotoSansJP-subset.ttf'), {
  charset: 'あいうえおかきくけこのはを日本語文字漢字東京世界星探検宇宙惑新旧大小中国人、。「」',
  outlines: false,
})
const cjk = fontFromBytes(read('Inter-Regular.ttf'), { charset: 'latin', outlines: false })
cjk.fallbacks = [noto]

const text = (value: string, lines: { start: number; end: number }[]) =>
  lines.map((l) => value.slice(l.start, l.end))

describe('line breaking', () => {
  it('wraps at spaces, collapsing the breaking space, and keeps lines within maxWidth', () => {
    const value = 'The quick brown fox jumps over the lazy dog'
    const size = 10
    const maxWidth = measureText(inter, 'The quick brown', { size }).width + 0.01
    const m = measureText(inter, value, { size, maxWidth })
    expect(text(value, m.lines)).toEqual(['The quick brown', 'fox jumps over', 'the lazy dog'])
    for (const line of m.lines) {
      expect(line.width).toBeLessThanOrEqual(maxWidth)
      expect(line.width).toBeCloseTo(
        measureText(inter, value.slice(line.start, line.end), { size }).width,
        4,
      )
    }
    // Several spaces at a break collapse too; leading spaces of the text stay.
    expect(text('aa   bb', measureText(inter, 'aa   bb', { maxWidth: 1.4 }).lines)).toEqual([
      'aa',
      'bb',
    ])
  })

  it("breaks at '\\n', and force-breaks a word longer than the line", () => {
    const m = measureText(inter, 'one\ntwo\n\nthree')
    expect(text('one\ntwo\n\nthree', m.lines)).toEqual(['one', 'two', '', 'three'])
    const long = 'Supercalifragilistic'
    const lines = measureText(inter, long, { size: 1, maxWidth: 3 }).lines
    expect(lines.length).toBeGreaterThan(2)
    expect(lines.map((l) => long.slice(l.start, l.end)).join('')).toBe(long)
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(3)
    // A single glyph wider than the line still gets its own line.
    expect(measureText(inter, 'WW', { maxWidth: 0.1 }).lines).toHaveLength(2)
  })

  it('breaks between any two CJK characters, and between CJK and Latin', () => {
    const value = '日本語文字漢字東京'
    const em = noto.glyph(0x65e5)!.advance
    const m = measureText(cjk, value, { size: 1, maxWidth: em * 3 + 0.001 })
    expect(text(value, m.lines)).toEqual(['日本語', '文字漢', '字東京'])
    const mixed = 'abc日本'
    const w = measureText(cjk, 'abc日', { size: 1 }).width + 0.001
    expect(text(mixed, measureText(cjk, mixed, { maxWidth: w }).lines)).toEqual(['abc日', '本'])
    // Closing punctuation doesn't start a line; opening brackets don't end one.
    const punct = '日本。「東京」'
    const lines = text(punct, measureText(cjk, punct, { maxWidth: em * 2 + 0.001 }).lines)
    for (const l of lines) {
      expect(l.startsWith('。')).toBe(false)
      expect(l.startsWith('」')).toBe(false)
      expect(l.endsWith('「')).toBe(false)
    }
    expect(lines.join('')).toBe(punct)
  })
})

describe('placement', () => {
  const value = 'Wide line here\nshort'
  const lines = measureText(inter, value, { size: 1 }).lines
  const [wide, short] = [lines[0]!.width, lines[1]!.width]
  /** x of each line's first glyph pen position (quad x minus the glyph's left bearing). */
  const lineX = (layout: TextLayout) =>
    [0, 1].map((l) => {
      const q = layout.lineQuad[l]!
      return layout.quads[q * 4]! - layout.glyphs[q]!.left
    })

  it('aligns lines left, center, and right within the block', () => {
    const left = layoutText(inter, value, { align: 'left', anchor: [0, 0] })
    expect(lineX(left)[0]).toBeCloseTo(0, 5)
    expect(lineX(left)[1]).toBeCloseTo(0, 5)
    const center = layoutText(inter, value, { align: 'center', anchor: [0, 0] })
    expect(lineX(center)[0]).toBeCloseTo(0, 5)
    expect(lineX(center)[1]).toBeCloseTo((wide - short) / 2, 5)
    const right = layoutText(inter, value, { align: 'right', anchor: [0, 0] })
    expect(lineX(right)[1]).toBeCloseTo(wide - short, 5)
    expect(right.width).toBeCloseTo(wide, 5)
  })

  it('puts the anchor at the origin (y up) and stacks lines by lineHeight', () => {
    const size = 2
    const block = layoutText(inter, value, { size, anchor: [0.5, 0.5], lineHeight: 1.5 })
    const height = (inter.ascent - inter.descent) * size + 1.5 * size
    expect(block.height).toBeCloseTo(height, 5)
    expect(block.left).toBeCloseTo(-block.width / 2, 5)
    expect(block.bottom).toBeCloseTo(-height / 2, 5)
    const bl = layoutText(inter, value, { size, anchor: [0, 0], lineHeight: 1.5 })
    expect(bl.left).toBeCloseTo(0, 6)
    // First baseline sits ascent below the top; the second one lineHeight lower.
    const baseline = (layout: TextLayout, l: number) => {
      const q = layout.lineQuad[l]!
      return layout.quads[q * 4 + 1]! - layout.glyphs[q]!.bottom * size
    }
    expect(baseline(bl, 0)).toBeCloseTo(height - inter.ascent * size, 4)
    expect(baseline(bl, 0) - baseline(bl, 1)).toBeCloseTo(1.5 * size, 4)
    const tr = layoutText(inter, value, { size, anchor: [1, 1] })
    expect(tr.left).toBeCloseTo(-tr.width, 5)
    expect(tr.bottom).toBeCloseTo(-tr.height, 5)
  })

  it('writes quads, uvs, pages, and source indices for visible glyphs only', () => {
    const layout = layoutText(inter, 'A b', { size: 48, anchor: [0, 0] })
    expect(layout.count).toBe(2)
    expect(Array.from(layout.source.subarray(0, 2))).toEqual([0, 2])
    const a = inter.glyph(0x41)!
    expect(layout.quads[2]).toBeCloseTo((a.right - a.left) * 48, 4)
    expect(Array.from(layout.uvs.subarray(0, 4))).toEqual(
      [a.u0, a.v0, a.u1, a.v1].map((v) => Math.fround(v)),
    )
    expect(layout.pages.slice(0, layout.pageCount)).toEqual([inter.pages[0]])
    const spaced = measureText(inter, 'AB', { letterSpacing: 0.1 }).width
    expect(spaced - measureText(inter, 'AB').width).toBeCloseTo(0.1, 5)
  })
})

describe('performance', () => {
  it('lays out 10k changing glyphs (1000 counters of 10 chars) in under 2 ms per frame', () => {
    const layouts = Array.from({ length: 1000 }, () => new TextLayout())
    const options = { size: 0.5, align: 'center', anchor: [0.5, 0.5] } as const
    const frame = (f: number) => {
      let glyphs = 0
      for (let i = 0; i < 1000; i++) {
        glyphs += layoutText(
          inter,
          `HP${(f * 7919 + i * 104729) % 10000000}`.padEnd(10, '0'),
          options,
          layouts[i],
        ).count
      }
      return glyphs
    }
    for (let f = 0; f < 60; f++) frame(f)
    const frames = 100
    let total = 0
    const t0 = performance.now()
    for (let f = 0; f < frames; f++) total += frame(f + 60)
    const ms = (performance.now() - t0) / frames
    console.log(`layout: ${(total / frames).toFixed(0)} glyphs per frame, ${ms.toFixed(3)} ms`)
    expect(total / frames).toBe(10000)
    expect(ms).toBeLessThan(budget('text/layout', { count: total / frames }))
  })
})
