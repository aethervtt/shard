import { LABEL_FONT, labelAtlas } from '@aethervtt/shard-render'
import { Font, type FontMetricsJson, type GlyphJson } from './font'

/**
 * The engine's built-in fallback font (0061): printable ASCII from the gizmo label atlas (Inter at
 * 13 px), what a font that failed to load draws with. Its coverage stands in for the distance field,
 * so it reads cleanly near 13 px and softens when much larger; other characters show '?'.
 */
export function builtinFont(): Font {
  const f = LABEL_FONT
  const em = 13
  const atlas = labelAtlas()
  const pixels = new Uint8Array(f.width * f.height * 4)
  for (let i = 0; i < atlas.length; i++) {
    const c = atlas[i]!
    pixels[i * 4] = c
    pixels[i * 4 + 1] = c
    pixels[i * 4 + 2] = c
    pixels[i * 4 + 3] = 255
  }
  const glyph = (code: number): GlyphJson => {
    const index = code - 32
    const col = index % f.columns
    const row = Math.floor(index / f.columns)
    // A space advances and draws nothing, as in imported fonts.
    if (code === 32) return { u: code, a: f.advances[index]! / em }
    return {
      u: code,
      a: f.advances[index]! / em,
      b: [0, -(f.cellHeight - f.baseline) / em, f.cellWidth / em, f.baseline / em],
      r: [col * f.cellWidth, row * f.cellHeight, f.cellWidth, f.cellHeight],
    }
  }
  const glyphs: GlyphJson[] = []
  for (let code = 32; code < 127; code++) glyphs.push(glyph(code))
  const json: FontMetricsJson = {
    version: 1,
    name: 'shard-fallback',
    size: em,
    range: 1,
    unitsPerEm: 1000,
    ascent: f.baseline / em,
    descent: -(f.cellHeight - f.baseline) / em,
    lineGap: 0,
    pages: [{ width: f.width, height: f.height }],
    glyphs,
    notdef: { ...glyph(63), u: -1 },
    kerning: [],
    charset: 'custom',
  }
  return Font.fromMetrics(json, { pixels: [pixels] })
}
