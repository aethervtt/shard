export { type PackItem, type PackResult, packRects, SkylinePacker } from '@aethervtt/shard-texture'
export { buildFont, type FontBuild, type FontBuildOptions, fontFromBytes } from './build'
export { type CharsetName, charsetCodepoints } from './charset'
export { Localized, SCREEN_CORNERS, ScreenText, TEXT_ALIGNS, Text } from './components'
export {
  Font,
  type FontLoadOptions,
  type FontMetricsJson,
  FontPage,
  GLYPH_PADDING,
  Glyph,
  type GlyphJson,
  RUNTIME_PAGE_SIZE,
} from './font'
export {
  atlasLabel,
  FontAssetType,
  FontImporter,
  FontImportSettings,
  type FontImportSettingsValue,
  FontStore,
  Fonts,
} from './importer'
export { hasGposKerning, readGposKerning } from './kerning'
export {
  isCjk,
  layoutText,
  measureText,
  type TextAlign,
  TextLayout,
  type TextLayoutOptions,
  type TextLine,
  type TextMetrics,
} from './layout'
export {
  installLocalization,
  KEYED_COMPONENTS,
  Locale,
  LocaleState,
  LocaleStore,
  type LocaleValue,
  type LocalizationReport,
  loadStringTables,
  localeChain,
  localeMethods,
  localeOfPath,
  localizationKeysIn,
  localizeComponent,
  localizeText,
  PLURAL_CATEGORIES,
  type PluralCategory,
  placeholdersOf,
  type StringEntry,
  StringTable,
  StringTableAssetType,
  StringTableImporter,
  StringTables,
  setLocale,
  tr,
  validateLocalization,
  validateStringTable,
} from './locale'
export {
  blitMsdf,
  generateMsdf,
  type MsdfBox,
  type MsdfOptions,
  msdfBox,
  prepareShape,
} from './msdf'
export { textPlugin } from './plugin'
export { describeText, prepareTexts, TextRenderer, TextStore } from './render'
export { TEXT_SHADERS } from './shaders'
export {
  type Contour,
  colorEdgesSimple,
  type Edge,
  EdgeColor,
  type EdgeKind,
  type OutlineCommand,
  type Shape,
  shapeBounds,
  shapeFromCommands,
} from './shape'
export {
  FontSource,
  type GlyphBitmap,
  type GlyphRaster,
  rasterizeGlyph,
  TOFU_ADVANCE,
  tofuShape,
} from './source'
