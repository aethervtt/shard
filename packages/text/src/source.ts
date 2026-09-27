/// <reference path="./opentype.d.ts" />
import { ShardError } from '@aethervtt/shard-core'
import type { Font as OpentypeFont } from 'opentype.js'
import * as opentype from 'opentype.js'

// Node loads opentype.js's CommonJS build (named exports under `default`), bundlers its ESM one.
const parse: typeof opentype.parse =
  opentype.parse ?? (opentype as unknown as { default: typeof opentype }).default.parse

import { hasGposKerning, readGposKerning } from './kerning'
import { blitMsdf, generateMsdf, msdfBox, prepareShape } from './msdf'
import { linear, type OutlineCommand, type Shape, shapeBounds, shapeFromCommands } from './shape'

type NameTable = Record<string, Record<string, string> | undefined>

/** The font's full name from its name table (opentype.js groups records by platform). */
function fontName(font: OpentypeFont): string | undefined {
  const names = font.names as unknown as Record<string, NameTable | undefined>
  for (const table of [
    names.windows,
    names.macintosh,
    names.unicode,
    names as unknown as NameTable,
  ]) {
    const full = table?.fullName ?? table?.fontFamily
    if (full && typeof full === 'object') {
      const value = full.en ?? Object.values(full)[0]
      if (typeof value === 'string') return value
    }
  }
  return undefined
}

/** A parsed font file: outlines, metrics, and kerning, in font units. */
export class FontSource {
  readonly bytes: Uint8Array
  readonly font: OpentypeFont
  readonly unitsPerEm: number
  readonly ascender: number
  readonly descender: number
  readonly lineGap: number
  readonly name: string
  private readonly cmap: Record<number, number>

  constructor(bytes: Uint8Array, path = 'font') {
    this.bytes = bytes
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      this.font = parse(buffer as ArrayBuffer, { lowMemory: true })
    } catch (cause) {
      throw new ShardError(
        'text/font-parse-failed',
        `${path}: not a font opentype.js can read (${(cause as Error).message})`,
        { path, cause, hint: 'Fonts import from .ttf and .otf files (TrueType or CFF outlines).' },
      )
    }
    const f = this.font
    this.unitsPerEm = f.unitsPerEm
    const hhea = f.tables.hhea
    this.ascender = hhea.ascender
    this.descender = hhea.descender
    this.lineGap = hhea.lineGap
    this.cmap = f.tables.cmap.glyphIndexMap
    this.name = fontName(f) ?? path
  }

  /** The glyph index for a codepoint; 0 (.notdef) when the font doesn't have it. */
  glyphIndex(codepoint: number): number {
    return this.cmap[codepoint] ?? 0
  }

  advance(glyph: number): number {
    return this.font.glyphs.get(glyph).advanceWidth ?? 0
  }

  /** The glyph's outline as a shape, in font units (y up). */
  shape(glyph: number): Shape {
    return shapeFromCommands(this.font.glyphs.get(glyph).path.commands as OutlineCommand[])
  }

  /** Kerning between the given glyphs, pair key `left * 65536 + right`, in font units. */
  kerning(glyphs: Iterable<number>): Map<number, number> {
    if (hasGposKerning(this.bytes)) return readGposKerning(this.bytes, glyphs)
    const out = new Map<number, number>()
    const wanted = new Set(glyphs)
    for (const [key, value] of Object.entries(this.font.kerningPairs ?? {})) {
      const [l, r] = key.split(',').map(Number) as [number, number]
      if (value !== 0 && wanted.has(l) && wanted.has(r)) out.set(l * 65536 + r, value)
    }
    return out
  }
}

/** A box glyph for codepoints no font has: an outlined rectangle, in em units. */
export function tofuShape(): Shape {
  const rect = (l: number, b: number, r: number, t: number, clockwise: boolean) =>
    clockwise
      ? [linear(l, b, l, t), linear(l, t, r, t), linear(r, t, r, b), linear(r, b, l, b)]
      : [linear(l, b, r, b), linear(r, b, r, t), linear(r, t, l, t), linear(l, t, l, b)]
  return {
    contours: [
      { edges: rect(0.08, 0, 0.52, 0.7, true) },
      { edges: rect(0.14, 0.06, 0.46, 0.64, false) },
    ],
  }
}

export const TOFU_ADVANCE = 0.6

/** One glyph's MSDF: RGBA pixels (row 0 at the top) and its quad in em units. */
export interface GlyphBitmap {
  width: number
  height: number
  /** RGBA8, alpha 255. Empty for blank glyphs. */
  pixels: Uint8Array
  /** Quad bounds in em units relative to the pen and baseline: left, bottom, right, top. */
  plane: [number, number, number, number] | undefined
}

export interface GlyphRaster {
  /** Pixels per em. */
  size: number
  /** Distance range in pixels. */
  range: number
}

/**
 * Generates a glyph's MSDF. `shape` is in units where one em is `unitsPerEm` (font units, or 1 for
 * shapes already in em).
 */
export function rasterizeGlyph(shape: Shape, unitsPerEm: number, raster: GlyphRaster): GlyphBitmap {
  const bounds = shapeBounds(shape)
  if (!bounds) return { width: 0, height: 0, pixels: new Uint8Array(0), plane: undefined }
  const scale = raster.size / unitsPerEm
  prepareShape(shape)
  const box = msdfBox(bounds, scale, raster.range)
  const sdf = generateMsdf(shape, box, { scale, range: raster.range })
  const pixels = new Uint8Array(box.width * box.height * 4)
  blitMsdf(sdf, box.width, box.height, pixels, box.width, 0, 0)
  const inv = 1 / unitsPerEm
  return {
    width: box.width,
    height: box.height,
    pixels,
    plane: [box.plane[0] * inv, box.plane[1] * inv, box.plane[2] * inv, box.plane[3] * inv],
  }
}
