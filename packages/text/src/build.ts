import { packRects } from '@shard/texture'
import { type CharsetName, charsetCodepoints } from './charset'
import {
  Font,
  type FontLoadOptions,
  type FontMetricsJson,
  GLYPH_PADDING,
  type GlyphJson,
} from './font'
import { FontSource, type GlyphBitmap, rasterizeGlyph, TOFU_ADVANCE, tofuShape } from './source'

export interface FontBuildOptions {
  /** `latin`, `latin-extended`, or a string of the characters to include. Default `latin`. */
  charset?: CharsetName | (string & {})
  /** Atlas pixels per em. Default 48. */
  size?: number
  /** Distance range in atlas pixels. Default 4. */
  range?: number
  /** Include kerning pairs. Default true. */
  kerning?: boolean
  /** Largest atlas page side (a power of two). Default 2048. */
  maxPageSize?: number
  /** Padding around each glyph in pixels. Default 1. */
  padding?: number
  /** Fallback font project paths, recorded in the metrics. */
  fallback?: string[]
}

export interface FontBuild {
  metrics: FontMetricsJson
  /** RGBA8 atlas pages (MSDF in RGB, alpha 255), row 0 at the top. */
  pages: { width: number; height: number; pixels: Uint8Array }[]
  /** Charset codepoints the font doesn't have. */
  missing: number[]
  source: FontSource
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

/**
 * Generates a font's MSDF atlas and metrics: every charset glyph the font has, packed onto
 * power-of-two pages, plus kerning between them and a missing-glyph box.
 */
export function buildFont(
  input: Uint8Array | FontSource,
  options: FontBuildOptions = {},
): FontBuild {
  const source = input instanceof FontSource ? input : new FontSource(input)
  const size = options.size ?? 48
  const range = options.range ?? 4
  const raster = { size, range }
  const upem = source.unitsPerEm
  const charset = options.charset ?? 'latin'
  const codepoints = charsetCodepoints(charset)
  const missing: number[] = []
  const entries: { json: GlyphJson; bitmap: GlyphBitmap; index: number }[] = []
  for (const cp of codepoints) {
    const index = source.glyphIndex(cp)
    if (index === 0) {
      missing.push(cp)
      continue
    }
    const bitmap = rasterizeGlyph(source.shape(index), upem, raster)
    entries.push({ json: { u: cp, a: round6(source.advance(index) / upem) }, bitmap, index })
  }
  // The missing-glyph box: the font's .notdef when it draws something, else a drawn box.
  const notdefShape = source.shape(0)
  const hasNotdef = notdefShape.contours.length > 0
  const notdef = {
    json: { u: -1, a: hasNotdef ? round6(source.advance(0) / upem) : TOFU_ADVANCE } as GlyphJson,
    bitmap: hasNotdef
      ? rasterizeGlyph(notdefShape, upem, raster)
      : rasterizeGlyph(tofuShape(), 1, raster),
    index: 0,
  }
  const all = [...entries, notdef]
  const visible = all.filter((e) => e.bitmap.plane)
  const packing = packRects(
    visible.map((e) => ({ width: e.bitmap.width, height: e.bitmap.height })),
    options.maxPageSize ?? 2048,
    options.padding ?? GLYPH_PADDING,
  )
  const pages = packing.pages.map((p) => {
    const pixels = new Uint8Array(p.width * p.height * 4)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    return { width: p.width, height: p.height, pixels }
  })
  visible.forEach((e, i) => {
    const place = packing.placements[i]!
    const page = pages[place.page]!
    const bmp = e.bitmap
    for (let row = 0; row < bmp.height; row++) {
      page.pixels.set(
        bmp.pixels.subarray(row * bmp.width * 4, (row + 1) * bmp.width * 4),
        ((place.y + row) * page.width + place.x) * 4,
      )
    }
    e.json.b = bmp.plane!.map(round6) as [number, number, number, number]
    e.json.r = [place.x, place.y, bmp.width, bmp.height]
    if (place.page !== 0) e.json.p = place.page
  })
  const kerning: number[] = []
  if (options.kerning !== false) {
    const byGlyph = new Map<number, number[]>()
    for (const e of entries) {
      const list = byGlyph.get(e.index)
      if (list) list.push(e.json.u)
      else byGlyph.set(e.index, [e.json.u])
    }
    const pairs = source.kerning(byGlyph.keys())
    const sorted = [...pairs].sort((a, b) => a[0] - b[0])
    for (const [key, value] of sorted) {
      const lefts = byGlyph.get(Math.floor(key / 65536))!
      const rights = byGlyph.get(key % 65536)!
      for (const l of lefts) for (const r of rights) kerning.push(l, r, value)
    }
  }
  const metrics: FontMetricsJson = {
    version: 1,
    name: source.name,
    size,
    range,
    unitsPerEm: upem,
    ascent: round6(source.ascender / upem),
    descent: round6(source.descender / upem),
    lineGap: round6(source.lineGap / upem),
    pages: packing.pages,
    glyphs: entries.map((e) => e.json),
    notdef: notdef.json,
    kerning,
    charset: charset === 'latin' || charset === 'latin-extended' ? charset : 'custom',
  }
  if (options.fallback?.length) metrics.fallback = [...options.fallback]
  return { metrics, pages, missing, source }
}

/**
 * A runtime font straight from a font file (no asset import): builds the atlas in code and keeps
 * the outlines for on-demand glyphs (unless `outlines` is false).
 */
export function fontFromBytes(
  bytes: Uint8Array,
  options: FontBuildOptions & { outlines?: boolean } = {},
): Font {
  const build = buildFont(bytes, options)
  const load: FontLoadOptions = {
    pixels: build.pages.map((p) => p.pixels),
    ...(options.outlines === false ? {} : { source: build.source }),
  }
  return Font.fromMetrics(build.metrics, load)
}
