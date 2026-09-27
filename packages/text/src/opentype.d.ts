// The subset of opentype.js (which ships no types) that @aethervtt/shard-text uses.
declare module 'opentype.js' {
  export type PathCommand =
    | { type: 'M'; x: number; y: number }
    | { type: 'L'; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Z' }

  export interface Glyph {
    index: number
    name: string | null
    advanceWidth: number | undefined
    leftSideBearing: number | undefined
    path: { commands: PathCommand[] }
  }

  export interface Font {
    unitsPerEm: number
    ascender: number
    descender: number
    numGlyphs: number
    outlinesFormat: 'truetype' | 'cff'
    names: Record<string, Record<string, string> | undefined>
    glyphs: { get(index: number): Glyph }
    kerningPairs: Record<string, number>
    tables: {
      cmap: { glyphIndexMap: Record<number, number> }
      hhea: { ascender: number; descender: number; lineGap: number }
      os2?: { sTypoAscender: number; sTypoDescender: number; sTypoLineGap: number }
      [name: string]: unknown
    }
  }

  export function parse(buffer: ArrayBuffer, options?: { lowMemory?: boolean }): Font
}
