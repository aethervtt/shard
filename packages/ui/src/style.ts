import type { AssetRef } from '@aethervtt/shard-core'
import { UI_GRADIENTS } from './components'
import type { ThemeStyle, UiThemeAsset } from './theme'

/** Interaction bits a style's state variants key on. */
export const State = { On: 1, Focused: 2, Hovered: 4, Pressed: 8, Disabled: 16 } as const

/** A node's look after its theme: what render, hit testing, and describe use. */
export class ResolvedStyle {
  background = new Float32Array(4)
  borderColor = new Float32Array(4)
  borderWidth = 0
  radius = new Float32Array(4)
  opacity = 1
  cut = new Float32Array(4)
  cutHeight = new Float32Array(4)
  /** Index in UI_GRADIENTS. */
  gradient = 0
  gradientColor = new Float32Array(4)
  gradientAngle = 180
  gradientRange = new Float32Array([0, 1])
  shadowColor = new Float32Array(4)
  shadowOffset = new Float32Array(2)
  shadowBlur = 0
  shadowSpread = 0
  glowColor = new Float32Array(4)
  glowBlur = 0
  glowSpread = 0
  size = 16
  color = new Float32Array([1, 1, 1, 1])
  font: AssetRef<'Font'> | null = null
  align = 0
  wrap = true
  lineHeight = 1.2
  outlineWidth = 0
  outlineColor = new Float32Array(4)
  textShadowColor = new Float32Array(4)
  textShadowOffset = new Float32Array(2)
  textShadowSoftness = 0
}

const ALIGNS = ['start', 'center', 'end']

/** Per-field defaults: an entity field at its default takes the theme's value. */
const DEFAULTS = {
  background: [0, 0, 0, 0],
  borderColor: [0, 0, 0, 0],
  borderWidth: 0,
  radius: [0, 0, 0, 0],
  opacity: 1,
  cut: [0, 0, 0, 0],
  cutHeight: [0, 0, 0, 0],
  gradient: 0,
  gradientColor: [0, 0, 0, 0],
  gradientAngle: 180,
  gradientRange: [0, 1],
  shadowColor: [0, 0, 0, 0.5],
  shadowOffset: [0, 0],
  shadowBlur: 0,
  shadowSpread: 0,
  glowColor: [1, 1, 1, 0.6],
  glowBlur: 0,
  glowSpread: 0,
  size: 16,
  color: [1, 1, 1, 1],
  align: 0,
  wrap: 1,
  lineHeight: 1.2,
  outlineWidth: 0,
  outlineColor: [0, 0, 0, 1],
  textShadowColor: [0, 0, 0, 0.6],
  textShadowOffset: [0, 0],
  textShadowSoftness: 0,
}

function sameVec(a: ArrayLike<number>, o: number, b: readonly number[]): boolean {
  for (let k = 0; k < b.length; k++) if (Math.fround(a[o + k]!) !== Math.fround(b[k]!)) return false
  return true
}

/** The theme styles a node takes fields from: its base style, then its state variants in order. */
const layers: ThemeStyle[] = []
let layerCount = 0

function gatherLayers(theme: UiThemeAsset | undefined, style: string, state: number): void {
  layerCount = 0
  if (!theme || style === '') return
  const base = theme.styles.get(style)
  if (base) layers[layerCount++] = base
  if (state === 0) return
  const variants = theme.statesOf(style)
  for (let s = 0; s < variants.length; s++) {
    const variant = variants[s]
    if (variant && state & (1 << s)) layers[layerCount++] = variant
  }
}

/** A field's value from the gathered layers: the last one that sets it. */
function themeValue(key: string): unknown {
  let value: unknown
  for (let l = 0; l < layerCount; l++) {
    const layer = layers[l]!
    if (key in layer) value = layer[key]
  }
  return value
}

function pickVec(
  out: Float32Array,
  own: ArrayLike<number> | undefined,
  row: number,
  def: readonly number[],
  key: string,
): void {
  const o = row * def.length
  if (own && !sameVec(own, o, def)) {
    for (let k = 0; k < out.length; k++) out[k] = own[o + k]!
    return
  }
  const theme = themeValue(key)
  if (Array.isArray(theme)) {
    for (let k = 0; k < out.length; k++) out[k] = (theme[k] as number) ?? def[k]!
  } else {
    for (let k = 0; k < out.length; k++) out[k] = def[k]!
  }
}

function pickNum(own: number | undefined, def: number, key: string): number {
  if (own !== undefined && Math.fround(own) !== Math.fround(def)) return own
  const theme = themeValue(key)
  return typeof theme === 'number' ? theme : def
}

function pickEnum(
  own: Uint8Array | undefined,
  row: number,
  def: number,
  key: string,
  names: readonly string[],
): number {
  if (own && own[row] !== def) return own[row]!
  const theme = themeValue(key)
  return typeof theme === 'string' ? Math.max(0, names.indexOf(theme)) : def
}

/** Column views of one table's UiStyle and UiText rows (either may be absent). */
export interface StyleColumns {
  background?: Float32Array
  borderColor?: Float32Array
  borderWidth?: Float32Array
  radius?: Float32Array
  opacity?: Float32Array
  cut?: Float32Array
  cutHeight?: Float32Array
  gradient?: Uint8Array
  gradientColor?: Float32Array
  gradientAngle?: Float32Array
  gradientRange?: Float32Array
  shadowColor?: Float32Array
  shadowOffset?: Float32Array
  shadowBlur?: Float32Array
  shadowSpread?: Float32Array
  glowColor?: Float32Array
  glowBlur?: Float32Array
  glowSpread?: Float32Array
  size?: Float32Array
  color?: Float32Array
  font?: (AssetRef<'Font'> | null)[]
  align?: Uint8Array
  wrap?: Uint8Array
  lineHeight?: Float32Array
  outlineWidth?: Float32Array
  outlineColor?: Float32Array
  textShadowColor?: Float32Array
  textShadowOffset?: Float32Array
  textShadowSoftness?: Float32Array
}

/**
 * Resolves a node's look: entity fields that differ from their default win, then the theme
 * style (with its state variants), then the defaults. `row` indexes the columns.
 */
export function resolveStyle(
  out: ResolvedStyle,
  c: StyleColumns,
  row: number,
  theme: UiThemeAsset | undefined,
  style: string,
  state: number,
): ResolvedStyle {
  const D = DEFAULTS
  gatherLayers(theme, style, state)
  pickVec(out.background, c.background, row, D.background, 'background')
  pickVec(out.borderColor, c.borderColor, row, D.borderColor, 'borderColor')
  out.borderWidth = pickNum(c.borderWidth?.[row], D.borderWidth, 'borderWidth')
  pickVec(out.radius, c.radius, row, D.radius, 'radius')
  out.opacity = pickNum(c.opacity?.[row], D.opacity, 'opacity')
  pickVec(out.cut, c.cut, row, D.cut, 'cut')
  pickVec(out.cutHeight, c.cutHeight, row, D.cutHeight, 'cutHeight')
  out.gradient = pickEnum(c.gradient, row, D.gradient, 'gradient', UI_GRADIENTS)
  pickVec(out.gradientColor, c.gradientColor, row, D.gradientColor, 'gradientColor')
  out.gradientAngle = pickNum(c.gradientAngle?.[row], D.gradientAngle, 'gradientAngle')
  pickVec(out.gradientRange, c.gradientRange, row, D.gradientRange, 'gradientRange')
  pickVec(out.shadowColor, c.shadowColor, row, D.shadowColor, 'shadowColor')
  pickVec(out.shadowOffset, c.shadowOffset, row, D.shadowOffset, 'shadowOffset')
  out.shadowBlur = pickNum(c.shadowBlur?.[row], D.shadowBlur, 'shadowBlur')
  out.shadowSpread = pickNum(c.shadowSpread?.[row], D.shadowSpread, 'shadowSpread')
  pickVec(out.glowColor, c.glowColor, row, D.glowColor, 'glowColor')
  out.glowBlur = pickNum(c.glowBlur?.[row], D.glowBlur, 'glowBlur')
  out.glowSpread = pickNum(c.glowSpread?.[row], D.glowSpread, 'glowSpread')
  out.size = pickNum(c.size?.[row], D.size, 'size')
  pickVec(out.color, c.color, row, D.color, 'color')
  const ownFont = c.font?.[row]
  const themeFont = themeValue('font') as AssetRef<'Font'> | null | undefined
  out.font = ownFont ?? themeFont ?? theme?.font ?? null
  out.align = pickEnum(c.align, row, D.align, 'align', ALIGNS)
  const themeWrap = themeValue('wrap')
  out.wrap =
    c.wrap && c.wrap[row] !== D.wrap
      ? c.wrap[row] !== 0
      : typeof themeWrap === 'boolean'
        ? themeWrap
        : true
  out.lineHeight = pickNum(c.lineHeight?.[row], D.lineHeight, 'lineHeight')
  out.outlineWidth = pickNum(c.outlineWidth?.[row], D.outlineWidth, 'outlineWidth')
  pickVec(out.outlineColor, c.outlineColor, row, D.outlineColor, 'outlineColor')
  pickVec(out.textShadowColor, c.textShadowColor, row, D.textShadowColor, 'textShadowColor')
  pickVec(out.textShadowOffset, c.textShadowOffset, row, D.textShadowOffset, 'textShadowOffset')
  out.textShadowSoftness = pickNum(
    c.textShadowSoftness?.[row],
    D.textShadowSoftness,
    'textShadowSoftness',
  )
  return out
}

/** Whether the node's fill shows: a visible background, or a gradient to a visible color. */
export function hasFill(s: ResolvedStyle): boolean {
  return s.background[3]! > 0 || (s.gradient !== 0 && s.gradientColor[3]! > 0)
}

/** The theme name a style lookup failed on, or undefined when it exists (or none is named). */
export function missingStyle(theme: UiThemeAsset | undefined, style: string): string | undefined {
  if (style === '' || !theme) return undefined
  return theme.styles.has(style) ? undefined : style
}
