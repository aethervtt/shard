import type { AssetRef } from '@aethervtt/shard-core'
import { SkylinePacker, Texture } from '@aethervtt/shard-texture'
import { FontSource, rasterizeGlyph } from './source'

/** One glyph in the metrics JSON. Lengths are em units; the atlas box is in pixels. */
export interface GlyphJson {
  /** Codepoint; -1 for the missing-glyph box. */
  u: number
  /** Advance width. */
  a: number
  /** Quad bounds relative to the pen on the baseline (y up): left, bottom, right, top. */
  b?: [number, number, number, number]
  /** Atlas box: x, y (top-left), width, height, in pixels. The quad maps to its texel centers. */
  r?: [number, number, number, number]
  /** Atlas page (default 0). */
  p?: number
}

/**
 * A font's imported metrics: the `Font` asset's JSON artifact. Everything a layout needs, plus
 * where each glyph sits in the atlas pages (the `#Atlas` texture sub-assets).
 */
export interface FontMetricsJson {
  version: 1
  name: string
  /** Atlas pixels per em. */
  size: number
  /** Distance range in atlas pixels. */
  range: number
  /** The source font's units per em (kerning values are in these units). */
  unitsPerEm: number
  /** Em units: ascent above the baseline (positive), descent below it (negative), line gap. */
  ascent: number
  descent: number
  lineGap: number
  pages: { width: number; height: number }[]
  glyphs: GlyphJson[]
  notdef: GlyphJson
  /** Kerning pairs as flat triples: left codepoint, right codepoint, adjustment in font units. */
  kerning: number[]
  /** Project paths of fallback fonts, tried in order for missing glyphs. */
  fallback?: string[]
  /** What the atlas covers: `latin`, `latin-extended`, or `custom`. */
  charset?: string
}

/** An atlas page. Imported pages point at their texture asset; runtime pages own a Texture. */
export class FontPage {
  readonly font: Font
  readonly index: number
  readonly width: number
  readonly height: number
  /** The page's texture asset (`font.ttf#Atlas`), for imported fonts. */
  ref: AssetRef | undefined
  /**
   * The page's pixels, for runtime pages and fonts built in code. Its `version` bumps when glyphs
   * are added, so the renderer re-uploads it.
   */
  texture: Texture | undefined
  /** Made at runtime for glyphs outside the imported set. */
  readonly runtime: boolean
  /** @internal Free space, for runtime pages. */
  packer: SkylinePacker | undefined

  constructor(
    font: Font,
    index: number,
    init: { width: number; height: number; ref?: AssetRef; texture?: Texture; runtime?: boolean },
  ) {
    this.font = font
    this.index = index
    this.width = init.width
    this.height = init.height
    this.ref = init.ref
    this.texture = init.texture
    this.runtime = init.runtime ?? false
    this.packer = undefined
  }
}

/** A glyph ready for layout. Plane bounds in em units; uv in texture space (v down). */
export class Glyph {
  readonly codepoint: number
  /** The font whose atlas holds the glyph (a fallback's, for fallback glyphs). */
  readonly font: Font
  readonly advance: number
  readonly left: number
  readonly bottom: number
  readonly right: number
  readonly top: number
  /** Index into `font.pages`. */
  readonly page: number
  /** Atlas box in pixels. */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Texture coordinates of the quad: (u0, v0) is its top-left. */
  readonly u0: number
  readonly v0: number
  readonly u1: number
  readonly v1: number
  /** Generated at runtime rather than imported. */
  readonly runtime: boolean
  /** Whether it draws anything (spaces don't). */
  readonly visible: boolean
  /** @internal Range of this glyph's kerning pairs (as the left glyph) in its font's tables. */
  kernStart = 0
  kernCount = 0

  constructor(font: Font, json: GlyphJson, runtime: boolean) {
    this.font = font
    this.codepoint = json.u
    this.advance = json.a
    this.runtime = runtime
    const b = json.b
    const r = json.r
    this.page = json.p ?? 0
    if (b && r) {
      this.left = b[0]
      this.bottom = b[1]
      this.right = b[2]
      this.top = b[3]
      this.x = r[0]
      this.y = r[1]
      this.w = r[2]
      this.h = r[3]
      const page = font.pages[this.page]
      const pw = page?.width ?? 1
      const ph = page?.height ?? 1
      this.u0 = (r[0] + 0.5) / pw
      this.v0 = (r[1] + 0.5) / ph
      this.u1 = (r[0] + r[2] - 0.5) / pw
      this.v1 = (r[1] + r[3] - 0.5) / ph
      this.visible = true
    } else {
      this.left = this.bottom = this.right = this.top = 0
      this.x = this.y = this.w = this.h = 0
      this.u0 = this.v0 = this.u1 = this.v1 = 0
      this.visible = false
    }
  }
}

export interface FontLoadOptions {
  /** RGBA8 pixels per page, for fonts built in code (each becomes a Texture). */
  pixels?: readonly Uint8Array[]
  /** Texture asset refs per page, for imported fonts. */
  pageRefs?: readonly (AssetRef | undefined)[]
  /** The font file, for on-demand glyphs outside the imported set. */
  source?: Uint8Array | FontSource
  /** Fallback font refs, linked by the `Fonts` store. */
  fallbackRefs?: readonly AssetRef[]
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

/** Side of new runtime atlas pages (pixels). */
export const RUNTIME_PAGE_SIZE = 512
/** Padding around glyphs in atlas pages (pixels). */
export const GLYPH_PADDING = 1

/**
 * A runtime font: glyph metrics and atlas pages. `resolve` finds a glyph for any codepoint: this
 * font's atlas, then an on-demand glyph from its own outlines, then each fallback (atlas, then
 * on-demand), then the missing-glyph box. Resolved codepoints are cached.
 */
export class Font {
  name: string
  size: number
  range: number
  unitsPerEm: number
  ascent: number
  descent: number
  lineGap: number
  charset: string
  pages: FontPage[] = []
  /** Glyphs this font holds (imported and generated), by codepoint. */
  glyphs = new Map<number, Glyph>()
  notdef!: Glyph
  /** Bumps when glyphs or pages are added (on-demand glyphs), or on hot reload. */
  version = 0
  /** Glyphs generated at runtime so far. */
  runtimeGlyphs = 0
  /** Codepoints nothing could draw (they show the missing-glyph box). */
  readonly missing = new Set<number>()
  /** Fallback fonts from the import settings, before the `Fonts` store links them. */
  fallbackRefs: AssetRef[] = []
  /** The metrics' fallback paths (project paths). */
  fallbackPaths: string[] = []
  /** @internal The store that links this font's fallbacks (set by `FontStore`). */
  linker: { link(): void } | undefined
  /** @internal Kerning tables: right codepoints and em adjustments, grouped by left glyph. */
  kernRight: Int32Array = new Int32Array(0)
  kernValue: Float32Array = new Float32Array(0)
  private _fallbacks: Font[] = []
  private resolved = new Map<number, Glyph>()
  private sourceBytes: Uint8Array | undefined
  private _source: FontSource | undefined
  private json: FontMetricsJson

  private constructor(json: FontMetricsJson) {
    this.json = json
    this.name = json.name
    this.size = json.size
    this.range = json.range
    this.unitsPerEm = json.unitsPerEm
    this.ascent = json.ascent
    this.descent = json.descent
    this.lineGap = json.lineGap
    this.charset = json.charset ?? 'custom'
  }

  /** Builds a font from its metrics JSON and its atlas pages (pixels or texture refs). */
  static fromMetrics(json: FontMetricsJson, options: FontLoadOptions = {}): Font {
    const font = new Font(json)
    font.pages = json.pages.map((p, i) => {
      const pixels = options.pixels?.[i]
      return new FontPage(font, i, {
        width: p.width,
        height: p.height,
        ref: options.pageRefs?.[i],
        texture: pixels
          ? Texture.create({
              width: p.width,
              height: p.height,
              mips: [pixels],
              usage: 'data',
              cpu: true,
            })
          : undefined,
      })
    })
    for (const g of json.glyphs) font.glyphs.set(g.u, new Glyph(font, g, false))
    font.notdef = new Glyph(font, json.notdef, false)
    font.setKerning(json.kerning)
    if (options.source instanceof FontSource) font._source = options.source
    else font.sourceBytes = options.source
    font.fallbackRefs = [...(options.fallbackRefs ?? [])]
    font.fallbackPaths = [...(json.fallback ?? [])]
    font.resolved = new Map(font.glyphs)
    return font
  }

  /** The metrics this font was loaded from. */
  get metrics(): FontMetricsJson {
    return this.json
  }

  /** Line height in em: ascent - descent + line gap. */
  get lineHeight(): number {
    return this.ascent - this.descent + this.lineGap
  }

  get fallbacks(): readonly Font[] {
    return this._fallbacks
  }

  /** Sets the fallback fonts, tried in order. Clears the resolved-glyph cache. */
  set fallbacks(fonts: readonly Font[]) {
    this._fallbacks = [...fonts]
    this.invalidate()
  }

  /** Forgets resolved fallback and missing glyphs (after fallbacks change). */
  invalidate(): void {
    this.resolved = new Map(this.glyphs)
    this.missing.clear()
    this.version++
  }

  /** Whether on-demand glyphs can be generated (the font's outlines are available). */
  get hasOutlines(): boolean {
    return this._source !== undefined || this.sourceBytes !== undefined
  }

  /** The parsed font file, parsed on first use; undefined without outlines. */
  get source(): FontSource | undefined {
    if (!this._source && this.sourceBytes)
      this._source = new FontSource(this.sourceBytes, this.name)
    return this._source
  }

  /** This font's own glyph for a codepoint (imported or already generated), no fallbacks. */
  glyph(codepoint: number): Glyph | undefined {
    return this.glyphs.get(codepoint)
  }

  /** A glyph for any codepoint; never undefined (the missing-glyph box at worst). */
  resolve(codepoint: number): Glyph {
    const g = this.resolved.get(codepoint)
    return g !== undefined ? g : this.resolveSlow(codepoint)
  }

  /** Whether a codepoint resolves to a real glyph (here, on demand, or in a fallback). */
  has(codepoint: number): boolean {
    return this.resolve(codepoint) !== this.notdef
  }

  /** Kerning between two glyphs, in em (0 across fonts). */
  kerning(left: Glyph, right: Glyph): number {
    if (left.font !== right.font || left.kernCount === 0) return 0
    const f = left.font
    const target = right.codepoint
    let lo = left.kernStart
    let hi = lo + left.kernCount - 1
    const keys = f.kernRight
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const k = keys[mid]!
      if (k === target) return f.kernValue[mid]!
      if (k < target) lo = mid + 1
      else hi = mid - 1
    }
    return 0
  }

  private resolveSlow(codepoint: number): Glyph {
    let g = this.find(codepoint, 0)
    if (!g) {
      g = this.notdef
      this.missing.add(codepoint)
    }
    this.resolved.set(codepoint, g)
    return g
  }

  private find(codepoint: number, depth: number): Glyph | undefined {
    const own = this.glyphs.get(codepoint)
    if (own) return own
    const made = this.generate(codepoint)
    if (made) return made
    if (depth < 4) {
      for (const fb of this._fallbacks) {
        if (fb === this) continue
        const g = fb.find(codepoint, depth + 1)
        if (g) return g
      }
    }
    return undefined
  }

  /**
   * Generates a glyph from this font's outlines into a runtime atlas page, if the font has the
   * codepoint. Bumps `version` and the page texture's version.
   */
  generate(codepoint: number): Glyph | undefined {
    const source = this.source
    if (!source) return undefined
    const index = source.glyphIndex(codepoint)
    if (index === 0) return undefined
    const bitmap = rasterizeGlyph(source.shape(index), source.unitsPerEm, this)
    const json: GlyphJson = { u: codepoint, a: round6(source.advance(index) / source.unitsPerEm) }
    if (bitmap.plane) {
      const spot = this.allocate(bitmap.width, bitmap.height)
      const page = this.pages[spot.page]!
      const data = page.texture!.levels![0]!
      for (let row = 0; row < bitmap.height; row++) {
        data.set(
          bitmap.pixels.subarray(row * bitmap.width * 4, (row + 1) * bitmap.width * 4),
          ((spot.y + row) * page.width + spot.x) * 4,
        )
      }
      page.texture!.version++
      json.b = bitmap.plane.map(round6) as [number, number, number, number]
      json.r = [spot.x, spot.y, bitmap.width, bitmap.height]
      json.p = spot.page
    }
    const glyph = new Glyph(this, json, true)
    this.glyphs.set(codepoint, glyph)
    this.resolved.set(codepoint, glyph)
    this.runtimeGlyphs++
    this.version++
    return glyph
  }

  /** Finds room for a w×h box on a runtime page, adding a page when the last one is full. */
  private allocate(w: number, h: number): { page: number; x: number; y: number } {
    const pad = GLYPH_PADDING
    const last = this.pages[this.pages.length - 1]
    if (last?.runtime && last.packer) {
      const spot = last.packer.insert(w + pad * 2, h + pad * 2)
      if (spot) return { page: last.index, x: spot.x + pad, y: spot.y + pad }
    }
    let side = RUNTIME_PAGE_SIZE
    while (side < Math.max(w, h) + pad * 2) side *= 2
    const pixels = new Uint8Array(side * side * 4)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    const page = new FontPage(this, this.pages.length, {
      width: side,
      height: side,
      runtime: true,
      texture: Texture.create({
        width: side,
        height: side,
        mips: [pixels],
        usage: 'data',
        cpu: true,
      }),
    })
    page.packer = new SkylinePacker(side, side)
    this.pages.push(page)
    const spot = page.packer.insert(w + pad * 2, h + pad * 2)!
    return { page: page.index, x: spot.x + pad, y: spot.y + pad }
  }

  private setKerning(triples: readonly number[]): void {
    const n = Math.floor(triples.length / 3)
    const order = new Int32Array(n)
    for (let i = 0; i < n; i++) order[i] = i
    order.sort(
      (a, b) => triples[a * 3]! - triples[b * 3]! || triples[a * 3 + 1]! - triples[b * 3 + 1]!,
    )
    this.kernRight = new Int32Array(n)
    this.kernValue = new Float32Array(n)
    const inv = 1 / this.unitsPerEm
    let i = 0
    while (i < n) {
      const left = triples[order[i]! * 3]!
      const start = i
      while (i < n && triples[order[i]! * 3] === left) {
        this.kernRight[i] = triples[order[i]! * 3 + 1]!
        this.kernValue[i] = triples[order[i]! * 3 + 2]! * inv
        i++
      }
      const g = this.glyphs.get(left)
      if (g) {
        g.kernStart = start
        g.kernCount = i - start
      }
    }
  }

  /** Hot reload: takes over another font's data, keeping this object (and its fallbacks). */
  copyFrom(next: Font): void {
    this.json = next.json
    this.name = next.name
    this.size = next.size
    this.range = next.range
    this.unitsPerEm = next.unitsPerEm
    this.ascent = next.ascent
    this.descent = next.descent
    this.lineGap = next.lineGap
    this.charset = next.charset
    this.fallbackRefs = next.fallbackRefs
    this.fallbackPaths = next.fallbackPaths
    this.sourceBytes = next.sourceBytes
    this._source = next._source
    this.runtimeGlyphs = 0
    // Glyphs and pages point at their font; rebuild them against this one.
    this.pages = next.pages.map(
      (p) =>
        new FontPage(this, p.index, {
          width: p.width,
          height: p.height,
          ref: p.ref,
          texture: p.texture,
          runtime: p.runtime,
        }),
    )
    this.glyphs = new Map()
    for (const g of next.json.glyphs) this.glyphs.set(g.u, new Glyph(this, g, false))
    this.notdef = new Glyph(this, next.json.notdef, false)
    this.setKerning(next.json.kerning)
    this.invalidate()
  }
}
