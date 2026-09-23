import type { Font, FontPage, Glyph } from './font'

export type TextAlign = 'left' | 'center' | 'right'

export interface TextLayoutOptions {
  /** Layout units per em (world units, or pixels for screen text). Default 1. */
  size?: number
  /** Line alignment within the block. Default 'left'. */
  align?: TextAlign
  /**
   * Pivot of the text block, normalized, y up: [0, 0] is the bottom-left corner, [1, 1] the
   * top-right, [0.5, 0.5] (default) the center. The pivot sits at the layout origin.
   */
  anchor?: readonly [number, number]
  /** Wrap lines longer than this (layout units); 0 (default) never wraps. */
  maxWidth?: number
  /** Distance between baselines, as a multiple of the size. Default 1.2. */
  lineHeight?: number
  /** Extra space between glyphs, in em. Default 0. */
  letterSpacing?: number
  /** Apply kerning pairs. Default true. */
  kerning?: boolean
}

export interface TextLine {
  /** UTF-16 range in the value: [start, end). Excludes the break's collapsed space or '\n'. */
  start: number
  end: number
  /** Advance width, trailing spaces excluded (layout units). */
  width: number
}

export interface TextMetrics {
  width: number
  height: number
  lines: TextLine[]
}

function grow<T extends Float32Array | Uint32Array | Uint16Array>(a: T, n: number): T {
  if (a.length >= n) return a
  let len = Math.max(16, a.length * 2)
  while (len < n) len *= 2
  const out = new (a.constructor as new (n: number) => T)(len)
  out.set(a)
  return out
}

/**
 * Glyph instances of a laid-out string, in reusable typed arrays: laying out into the same object
 * again doesn't allocate once its arrays are big enough. Positions are layout units, y up, with
 * the block's anchor at the origin.
 */
export class TextLayout {
  /** Glyph quads drawn (spaces and other blank glyphs aren't). */
  count = 0
  /** Per quad: x, y (bottom-left corner), width, height. */
  quads = new Float32Array(64)
  /** Per quad: u0, v0, u1, v1 in texture space (v down); (u0, v0) is the quad's top-left. */
  uvs = new Float32Array(64)
  /** Per quad: index into `pages`. */
  page = new Uint16Array(16)
  /** Per quad: UTF-16 index of its character in the value. */
  source = new Uint32Array(16)
  /** Per quad: the glyph (font, codepoint, runtime or fallback). Entries past `count` are stale. */
  glyphs: Glyph[] = []
  /** Atlas pages the quads sample, in first-use order. Entries past `pageCount` are stale. */
  pages: FontPage[] = []
  pageCount = 0
  /** Block size (layout units): widest line, and ascent to descent over all lines. */
  width = 0
  height = 0
  /** Block bounds relative to the origin (after the anchor). */
  left = 0
  bottom = 0
  lineCount = 0
  /** Per line: UTF-16 [start, end), width, first quad. */
  lineStart = new Uint32Array(8)
  lineEnd = new Uint32Array(8)
  lineWidth = new Float32Array(8)
  lineQuad = new Uint32Array(8)
  /** Characters that fell back to the missing-glyph box. */
  missing = 0
  /** Bumps on every layout. */
  version = 0

  /** Lines as objects (allocates). */
  lines(): TextLine[] {
    const out: TextLine[] = []
    for (let i = 0; i < this.lineCount; i++) {
      out.push({ start: this.lineStart[i]!, end: this.lineEnd[i]!, width: this.lineWidth[i]! })
    }
    return out
  }
}

// --- character classes -------------------------------------------------------------------------

/** CJK ideographs, kana, Hangul, and fullwidth forms: a line may break between any two. */
export function isCjk(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  )
}

/** Closing punctuation and small kana that don't start a line (a minimal kinsoku). */
const NO_BREAK_BEFORE = new Set<number>()
for (const ch of '、。，．・：；？！）」』】〕〉》〙〗ゝゞヽヾーぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ々〻‐゠〜…‥！），．：；？］｝｡｣､･ｰ') {
  NO_BREAK_BEFORE.add(ch.codePointAt(0)!)
}
/** Opening brackets that don't end a line. */
const NO_BREAK_AFTER = new Set<number>()
for (const ch of '（「『【〔〈《〘〖［｛｢') NO_BREAK_AFTER.add(ch.codePointAt(0)!)

const isSpace = (cp: number) => cp === 0x20 || cp === 0x09 || cp === 0x3000

// --- layout -----------------------------------------------------------------------------------

const scratch = new TextLayout()

/**
 * Lays out `value` into `out` (reused; its arrays grow as needed): advances and kerning, line
 * breaks at spaces (the breaking space collapses), at '\n', between CJK characters, and inside a
 * word wider than `maxWidth`; then alignment and the anchor. Doesn't allocate once `out` is big
 * enough, except when a new glyph has to be generated.
 */
export function layoutText(
  font: Font,
  value: string,
  options: TextLayoutOptions = {},
  out: TextLayout = new TextLayout(),
): TextLayout {
  const size = options.size ?? 1
  const maxWidth = options.maxWidth ?? 0
  const lineAdvance = (options.lineHeight ?? 1.2) * size
  const spacing = (options.letterSpacing ?? 0) * size
  const kerning = options.kerning !== false
  const alignFactor = options.align === 'center' ? 0.5 : options.align === 'right' ? 1 : 0
  const anchor = options.anchor
  const anchorX = anchor ? anchor[0] : 0.5
  const anchorY = anchor ? anchor[1] : 0.5
  const limit = maxWidth > 0 ? maxWidth + size * 1e-6 : Infinity

  out.count = 0
  out.lineCount = 0
  out.missing = 0
  out.version++

  const notdef = font.notdef
  let count = 0
  let quads = out.quads
  let uvs = out.uvs
  let pageOf = out.page
  let sourceOf = out.source
  const glyphs = out.glyphs
  const pages = out.pages
  let lastPage: FontPage | undefined
  let lastPageIndex = 0
  let pageCount = 0

  let lineStartChar = 0
  let lineQuad = 0
  let pen = 0
  /** Pen after the last non-space glyph on the line (the line's width). */
  let contentEnd = 0
  let contentEndChar = 0
  let prev: Glyph | null = null
  let prevCp = -1
  let prevSpace = false
  // The last break opportunity on this line.
  let opp = false
  let oppChar = 0
  let oppQuad = 0
  let oppPen = 0
  let oppWidth = 0
  let oppEnd = 0

  const n = value.length
  let i = 0
  while (i <= n) {
    let cp = -1
    let next = i + 1
    if (i < n) {
      cp = value.charCodeAt(i)
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
        const lo = value.charCodeAt(i + 1)
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = ((cp - 0xd800) << 10) + (lo - 0xdc00) + 0x10000
          next = i + 2
        }
      }
    }
    if (cp === -1 || cp === 0x0a) {
      // End of text or an explicit break: finish the line.
      out.lineCount = pushLine(out, lineStartChar, i, contentEnd, lineQuad)
      if (cp === -1) break
      lineStartChar = next
      lineQuad = count
      pen = 0
      contentEnd = 0
      contentEndChar = next
      prev = null
      prevCp = -1
      prevSpace = false
      opp = false
      i = next
      continue
    }
    if (cp === 0x0d) {
      i = next
      continue
    }
    const space = isSpace(cp)
    let g = font.resolve(cp === 0x09 ? 0x20 : cp)
    if (g === notdef) {
      if (space) g = font.resolve(0x20)
      else out.missing++
    }
    let kern = 0
    if (prev !== null) {
      kern = spacing
      if (kerning && prev.kernCount > 0 && prev.font === g.font) {
        const f = prev.font
        const keys = f.kernRight
        const target = g.codepoint
        let lo = prev.kernStart
        let hi = lo + prev.kernCount - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          const k = keys[mid]!
          if (k === target) {
            kern += f.kernValue[mid]! * size
            break
          }
          if (k < target) lo = mid + 1
          else hi = mid - 1
        }
      }
    }
    // Break opportunities before this character.
    if (!space && prev !== null) {
      if (prevSpace) {
        if (contentEnd > 0 || count > lineQuad) {
          opp = true
          oppChar = i
          oppQuad = count
          oppPen = pen + kern
          oppWidth = contentEnd
          oppEnd = contentEndChar
        }
      } else if (
        (isCjk(cp) || isCjk(prevCp)) &&
        !NO_BREAK_BEFORE.has(cp) &&
        !NO_BREAK_AFTER.has(prevCp)
      ) {
        opp = true
        oppChar = i
        oppQuad = count
        oppPen = pen + kern
        oppWidth = contentEnd
        oppEnd = i
      }
    }
    let x = pen + kern
    let advanceEnd = x + g.advance * size
    if (!space && advanceEnd > limit && (count > lineQuad || contentEnd > 0)) {
      if (opp) {
        // Break at the last opportunity; the glyphs after it move to the new line.
        out.lineCount = pushLine(out, lineStartChar, oppEnd, oppWidth, lineQuad)
        for (let q = oppQuad; q < count; q++) quads[q * 4] = quads[q * 4]! - oppPen
        lineStartChar = oppChar
        lineQuad = oppQuad
        pen -= oppPen
        contentEnd -= oppPen
        if (contentEnd < 0) contentEnd = 0
        x -= oppPen
        advanceEnd -= oppPen
        opp = false
      }
      if (advanceEnd > limit && (count > lineQuad || contentEnd > 0)) {
        // A word wider than the line: break inside it, before this character.
        out.lineCount = pushLine(out, lineStartChar, i, contentEnd, lineQuad)
        lineStartChar = i
        lineQuad = count
        advanceEnd -= x
        x = 0
        pen = 0
        contentEnd = 0
      }
    }
    if (g.visible) {
      if (count * 4 + 4 > quads.length) {
        quads = out.quads = grow(quads, count * 4 + 4)
        uvs = out.uvs = grow(uvs, count * 4 + 4)
        pageOf = out.page = grow(pageOf, count + 1)
        sourceOf = out.source = grow(sourceOf, count + 1)
      }
      const o = count * 4
      quads[o] = x + g.left * size
      quads[o + 1] = g.bottom * size
      quads[o + 2] = (g.right - g.left) * size
      quads[o + 3] = (g.top - g.bottom) * size
      uvs[o] = g.u0
      uvs[o + 1] = g.v0
      uvs[o + 2] = g.u1
      uvs[o + 3] = g.v1
      const page = g.font.pages[g.page]!
      if (page !== lastPage) {
        let p = 0
        while (p < pageCount && pages[p] !== page) p++
        if (p === pageCount) {
          if (p < pages.length) pages[p] = page
          else pages.push(page)
          pageCount++
        }
        lastPage = page
        lastPageIndex = p
      }
      pageOf[count] = lastPageIndex
      sourceOf[count] = i
      if (count < glyphs.length) glyphs[count] = g
      else glyphs.push(g)
      count++
    }
    pen = advanceEnd
    if (!space) {
      contentEnd = pen
      contentEndChar = next
    }
    prev = g
    prevCp = cp
    prevSpace = space
    i = next
  }
  out.count = count
  out.pageCount = pageCount

  // Alignment and anchor: lines stack down from the block's top; the pivot goes to the origin.
  let width = 0
  const lines = out.lineCount
  for (let l = 0; l < lines; l++) if (out.lineWidth[l]! > width) width = out.lineWidth[l]!
  const height = lines > 0 ? (font.ascent - font.descent) * size + (lines - 1) * lineAdvance : 0
  const left = -anchorX * width
  const bottom = -anchorY * height
  const top = bottom + height
  for (let l = 0; l < lines; l++) {
    const dx = left + (width - out.lineWidth[l]!) * alignFactor
    const baseline = top - font.ascent * size - l * lineAdvance
    const end = l + 1 < lines ? out.lineQuad[l + 1]! : count
    for (let q = out.lineQuad[l]!; q < end; q++) {
      quads[q * 4] = quads[q * 4]! + dx
      quads[q * 4 + 1] = quads[q * 4 + 1]! + baseline
    }
  }
  out.width = width
  out.height = height
  out.left = left
  out.bottom = bottom
  return out
}

function pushLine(out: TextLayout, start: number, end: number, width: number, quad: number) {
  const l = out.lineCount
  if (l >= out.lineStart.length) {
    out.lineStart = grow(out.lineStart, l + 1)
    out.lineEnd = grow(out.lineEnd, l + 1)
    out.lineWidth = grow(out.lineWidth, l + 1)
    out.lineQuad = grow(out.lineQuad, l + 1)
  }
  out.lineStart[l] = start
  out.lineEnd[l] = end
  out.lineWidth[l] = width
  out.lineQuad[l] = quad
  return l + 1
}

/** Measures a string without keeping glyph instances: its block size and line breaks. */
export function measureText(
  font: Font,
  value: string,
  options: TextLayoutOptions = {},
): TextMetrics {
  const layout = layoutText(font, value, options, scratch)
  return { width: layout.width, height: layout.height, lines: layout.lines() }
}
