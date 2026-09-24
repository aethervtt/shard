import type { AssetRef } from '@shard/core'
import type { ThemeStyle, UiThemeAsset } from './theme'

/** Interaction bits a style's state variants key on. */
export const State = { On: 1, Focused: 2, Hovered: 4, Pressed: 8, Disabled: 16 } as const
const STATE_NAMES = ['on', 'focused', 'hovered', 'pressed', 'disabled'] as const

/** A node's look after its theme: what render, hit testing, and describe use. */
export class ResolvedStyle {
  background = new Float32Array(4)
  borderColor = new Float32Array(4)
  borderWidth = 0
  radius = new Float32Array(4)
  opacity = 1
  size = 16
  color = new Float32Array([1, 1, 1, 1])
  font: AssetRef<'Font'> | null = null
  align = 0
  wrap = true
  lineHeight = 1.2
}

const ALIGNS = ['start', 'center', 'end']

/** Per-field defaults: an entity field at its default takes the theme's value. */
const DEFAULTS = {
  background: [0, 0, 0, 0],
  borderColor: [0, 0, 0, 0],
  borderWidth: 0,
  radius: [0, 0, 0, 0],
  opacity: 1,
  size: 16,
  color: [1, 1, 1, 1],
  align: 0,
  wrap: 1,
  lineHeight: 1.2,
}

function sameVec(a: ArrayLike<number>, o: number, b: readonly number[]): boolean {
  for (let k = 0; k < b.length; k++) if (Math.fround(a[o + k]!) !== Math.fround(b[k]!)) return false
  return true
}

/** Theme fields for a node: its style, then state variants in order (on, focused, …). */
function themeValue(
  theme: UiThemeAsset | undefined,
  style: string,
  state: number,
  key: string,
): unknown {
  if (!theme || style === '') return undefined
  let value: unknown
  const base = theme.styles.get(style)
  if (base && key in base) value = base[key]
  if (state !== 0) {
    for (let s = 0; s < STATE_NAMES.length; s++) {
      if (!(state & (1 << s))) continue
      const variant: ThemeStyle | undefined = theme.styles.get(`${style}:${STATE_NAMES[s]}`)
      if (variant && key in variant) value = variant[key]
    }
  }
  return value
}

function pickVec(
  out: Float32Array,
  own: ArrayLike<number> | undefined,
  o: number,
  def: readonly number[],
  theme: unknown,
): void {
  if (own && !sameVec(own, o, def)) {
    for (let k = 0; k < out.length; k++) out[k] = own[o + k]!
  } else if (Array.isArray(theme)) {
    for (let k = 0; k < out.length; k++) out[k] = (theme[k] as number) ?? def[k]!
  } else {
    for (let k = 0; k < out.length; k++) out[k] = def[k]!
  }
}

function pickNum(own: number | undefined, def: number, theme: unknown): number {
  if (own !== undefined && Math.fround(own) !== Math.fround(def)) return own
  return typeof theme === 'number' ? theme : def
}

/** Column views of one table's UiStyle and UiText rows (either may be absent). */
export interface StyleColumns {
  background?: Float32Array
  borderColor?: Float32Array
  borderWidth?: Float32Array
  radius?: Float32Array
  opacity?: Float32Array
  size?: Float32Array
  color?: Float32Array
  font?: (AssetRef<'Font'> | null)[]
  align?: Uint8Array
  wrap?: Uint8Array
  lineHeight?: Float32Array
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
  pickVec(
    out.background,
    c.background,
    row * 4,
    DEFAULTS.background,
    themeValue(theme, style, state, 'background'),
  )
  pickVec(
    out.borderColor,
    c.borderColor,
    row * 4,
    DEFAULTS.borderColor,
    themeValue(theme, style, state, 'borderColor'),
  )
  out.borderWidth = pickNum(
    c.borderWidth?.[row],
    DEFAULTS.borderWidth,
    themeValue(theme, style, state, 'borderWidth'),
  )
  pickVec(out.radius, c.radius, row * 4, DEFAULTS.radius, themeValue(theme, style, state, 'radius'))
  out.opacity = pickNum(
    c.opacity?.[row],
    DEFAULTS.opacity,
    themeValue(theme, style, state, 'opacity'),
  )
  out.size = pickNum(c.size?.[row], DEFAULTS.size, themeValue(theme, style, state, 'size'))
  pickVec(out.color, c.color, row * 4, DEFAULTS.color, themeValue(theme, style, state, 'color'))
  const ownFont = c.font?.[row]
  const themeFont = themeValue(theme, style, state, 'font') as AssetRef<'Font'> | null | undefined
  out.font = ownFont ?? themeFont ?? theme?.font ?? null
  const themeAlign = themeValue(theme, style, state, 'align')
  out.align =
    c.align && c.align[row] !== DEFAULTS.align
      ? c.align[row]!
      : typeof themeAlign === 'string'
        ? Math.max(0, ALIGNS.indexOf(themeAlign))
        : DEFAULTS.align
  const themeWrap = themeValue(theme, style, state, 'wrap')
  out.wrap =
    c.wrap && c.wrap[row] !== DEFAULTS.wrap
      ? c.wrap[row] !== 0
      : typeof themeWrap === 'boolean'
        ? themeWrap
        : true
  out.lineHeight = pickNum(
    c.lineHeight?.[row],
    DEFAULTS.lineHeight,
    themeValue(theme, style, state, 'lineHeight'),
  )
  return out
}

/** The theme name a style lookup failed on, or undefined when it exists (or none is named). */
export function missingStyle(theme: UiThemeAsset | undefined, style: string): string | undefined {
  if (style === '' || !theme) return undefined
  return theme.styles.has(style) ? undefined : style
}
