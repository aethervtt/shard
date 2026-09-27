import {
  AssetStore,
  defineAssetType,
  defineImporter,
  type ImportedAsset,
} from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  defineSchema,
  type JsonValue,
  ShardError,
  t,
} from '@aethervtt/shard-core'
import { writeKtx2 } from '@aethervtt/shard-texture'
import { buildFont, type FontBuild } from './build'
import { Font, type FontMetricsJson } from './font'
import { FontSource } from './source'

export const FontImportSettings = defineSchema(
  'text/FontImportSettings',
  {
    charset: t.enum(['latin', 'latin-extended', 'custom'], {
      description:
        'Glyphs to put in the atlas. latin: ASCII, Latin-1, and typographic punctuation. latin-extended: plus Latin Extended-A. custom: the characters of customCharset.',
    }),
    customCharset: t.string({ description: 'The characters to include when charset is custom.' }),
    size: t.u32({ default: 48, min: 8, max: 512, description: 'Atlas pixels per em.' }),
    range: t.f32({
      default: 4,
      min: 1,
      max: 32,
      description:
        'Distance range in atlas pixels. Larger allows wider outlines and glows, at the cost of atlas space.',
    }),
    fallback: t.list(t.string, {
      description: 'Fonts (paths) tried in order for characters this font lacks.',
    }),
    kerning: t.bool({ default: true, description: 'Import kerning pairs.' }),
    outlines: t.bool({
      default: true,
      description:
        'Keep the font file in the artifact, so characters outside the charset are generated at runtime.',
    }),
  },
  { description: 'Import settings for fonts (.ttf, .otf): an MSDF atlas and metrics.' },
)

export interface FontImportSettingsValue {
  charset: 'latin' | 'latin-extended' | 'custom'
  customCharset: string
  size: number
  range: number
  fallback: string[]
  kerning: boolean
  outlines: boolean
}

/** Label of an atlas page's texture sub-asset: `Atlas`, then `Atlas/1`, `Atlas/2`, … */
export function atlasLabel(page: number): string {
  return page === 0 ? 'Atlas' : `Atlas/${page}`
}

export const FontImporter = defineImporter({
  name: 'font',
  version: 1,
  extensions: ['.ttf', '.otf'],
  settings: FontImportSettings,
  async import(source, ctx) {
    const s = ctx.settings as unknown as FontImportSettingsValue
    let charset: string = s.charset
    if (s.charset === 'custom') {
      if (!s.customCharset) {
        ctx.warn('charset is "custom" but customCharset is empty; importing the latin charset.')
        charset = 'latin'
      } else charset = s.customCharset
    }
    const fallback = (s.fallback ?? []).map((p) => ctx.resolve(p))
    let build: FontBuild
    try {
      build = buildFont(new FontSource(source.bytes, source.path), {
        charset,
        size: s.size,
        range: s.range,
        kerning: s.kerning,
        fallback,
      })
    } catch (err) {
      if (err instanceof ShardError) throw err
      throw new ShardError('text/import-failed', `${source.path}: ${(err as Error).message}`, {
        path: source.path,
        cause: err,
      })
    }
    if (build.missing.length > 0) {
      const list = build.missing
        .slice(0, 12)
        .map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`)
        .join(', ')
      ctx.warn(
        `The font lacks ${build.missing.length} charset characters (${list}${build.missing.length > 12 ? ', …' : ''}); they use fallbacks or the missing-glyph box.`,
      )
    }
    const metrics = build.metrics
    const labels = build.pages.map((_, i) => atlasLabel(i))
    const info: Record<string, JsonValue> = {
      name: metrics.name,
      glyphs: metrics.glyphs.length,
      pages: build.pages.length,
      atlas: build.pages.map((p) => `${p.width}x${p.height}`).join(', '),
      kerningPairs: metrics.kerning.length / 3,
      size: metrics.size,
      range: metrics.range,
      charset: metrics.charset ?? 'custom',
      missing: build.missing.length,
      outlines: s.outlines !== false,
    }
    const main: ImportedAsset = {
      label: '',
      type: 'Font',
      json: metrics as unknown as JsonValue,
      dependencies: [...labels.map((l) => `#${l}`), ...fallback],
      info,
    }
    if (s.outlines !== false) main.bytes = source.bytes
    const assets: ImportedAsset[] = [main]
    build.pages.forEach((page, i) => {
      assets.push({
        label: labels[i]!,
        type: 'Texture',
        bytes: writeKtx2({ width: page.width, height: page.height, levels: [page.pixels] }, 'data'),
        info: {
          width: page.width,
          height: page.height,
          usage: 'data',
          mips: 1,
          font: metrics.name,
        },
      })
    })
    return { assets }
  },
})

/**
 * Loaded fonts by guid. Setting a font links fallback refs (from its import settings) to the
 * fonts already loaded: the asset server loads fallbacks first, as dependencies.
 */
export class FontStore extends AssetStore<Font, 'Font'> {
  private readonly fonts = new Map<string, Font>()

  constructor() {
    super('Font')
  }

  override add(item: Font, name?: string): AssetRef<'Font'> {
    const ref = super.add(item, name)
    this.fonts.set(ref.guid!, item)
    item.linker = this
    this.link()
    return ref
  }

  override set(guid: string, item: Font): void {
    super.set(guid, item)
    this.fonts.set(guid, item)
    item.linker = this
    this.link()
  }

  override delete(guid: string): boolean {
    this.fonts.delete(guid)
    return super.delete(guid)
  }

  /** Points every font's `fallbacks` at its loaded fallback fonts. */
  link(): void {
    for (const font of this.fonts.values()) {
      if (font.fallbackRefs.length === 0) continue
      const next: Font[] = []
      for (const ref of font.fallbackRefs) {
        const fb = ref.guid ? this.fonts.get(ref.guid) : undefined
        if (fb && fb !== font) next.push(fb)
      }
      const current = font.fallbacks
      if (next.length !== current.length || next.some((f, i) => f !== current[i])) {
        font.fallbacks = next
      }
    }
  }
}

export const Fonts = defineResource<FontStore>('text/Fonts', {
  description: 'Loaded fonts by guid.',
  init: () => new FontStore(),
})

/** Fonts load from their metrics JSON; atlas pages are `#Atlas` texture sub-assets. */
export const FontAssetType = defineAssetType<Font>('Font', {
  store: Fonts,
  load: (artifact, ctx) => {
    const json = artifact.json as unknown as FontMetricsJson
    if (json?.version !== 1 || !Array.isArray(json.glyphs)) {
      throw new ShardError('text/invalid-metrics', `${ctx.path}: not font metrics`, {
        path: ctx.path,
        hint: 'Re-import the font (`shard import`).',
      })
    }
    const pageRefs = json.pages.map((_, i) => ctx.resolve(`#${atlasLabel(i)}`))
    const fallbackRefs: AssetRef[] = []
    for (const p of json.fallback ?? []) {
      const ref = ctx.resolve(p)
      if (ref) fallbackRefs.push(ref)
    }
    return Font.fromMetrics(json, { pageRefs, source: artifact.bytes, fallbackRefs })
  },
  update: (existing, next) => {
    existing.copyFrom(next)
    // Fallback settings may have changed.
    existing.linker?.link()
  },
})
