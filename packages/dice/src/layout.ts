import { defineDataType } from '@aethervtt/shard-assets'
import { type AssetRef, type FieldValue, type Infer, ShardError, t } from '@aethervtt/shard-core'
import { type DieDefinition, labelOf } from './definition'
import { findDiceGlyph } from './glyphs'

// Face layouts (0054): what each value prints, as data. A default mark for every value, plus
// per-value overrides. Baked headless into an MSDF atlas by `bakeMarks`.

const MARK_FIELDS = {
  kind: t.enum(['text', 'pips', 'glyph', 'blank'], {
    description:
      "text prints characters (the value's label unless `text` says otherwise); pips draws dots; glyph draws a registered vector path; blank prints nothing.",
  }),
  text: t.string({ description: "Text marks: what to print. Empty prints the value's label." }),
  font: t.handle('Font', {
    description: "Text marks: the font's outlines. Null uses the built-in numerals (digits only).",
  }),
  size: t.f32({ default: 1, min: 0.2, max: 2, description: "Scales the die's mark size." }),
  weight: t.f32({
    default: 0.035,
    min: -0.05,
    max: 0.12,
    unit: 'em',
    description: 'Thickens (or thins) text and glyph strokes, from the distance field.',
  }),
  underline: t.enum(['auto', 'always', 'never'], {
    description:
      'auto underlines a label that reads as another of the die’s labels upside down (6 and 9, 16 and 91).',
  }),
  count: t.u8({ max: 9, description: 'Pips: how many. 0 draws the value.' }),
  glyph: t.string({
    description: 'Glyph marks: the name of a registered glyph (defineDiceGlyph).',
  }),
  rotation: t.f32({ unit: 'deg', description: 'Turns the mark on its face, clockwise.' }),
}

export const FaceMarkSchema = t.struct(MARK_FIELDS, { description: 'One mark on a face.' })

/** A face layout: `data/**\/*.dice-layout.json`. */
export const FaceLayout = defineDataType(
  'dice/FaceLayout',
  {
    version: t.u8({ default: 1, min: 1, max: 1, description: 'Format version: 1.' }),
    id: t.string({ description: 'A name for tools and errors.' }),
    default: FaceMarkSchema,
    overrides: t.list(
      t.struct({
        value: t.u16({ min: 1, max: 100, description: 'The value (not the face) it overrides.' }),
        mark: FaceMarkSchema,
      }),
      { description: 'Marks for particular values, by value.' },
    ),
  },
  {
    extension: 'dice-layout',
    description: 'What each value of a die prints: a default mark, and overrides by value.',
  },
)

export type FaceLayoutValue = Infer<typeof FaceLayout>
export type FaceMark = FieldValue<typeof FaceMarkSchema>

/** A mark ready to draw: text resolved to characters, pips to a count. */
export interface ResolvedMark {
  kind: 'text' | 'pips' | 'glyph' | 'blank'
  text: string
  font: AssetRef | null
  size: number
  weight: number
  underline: boolean
  count: number
  glyph: string
  /** Radians, clockwise. */
  rotation: number
}

const mark = (m: Partial<FaceMark>): FaceMark => ({
  ...(FaceMarkSchema.defaultValue() as FaceMark),
  ...m,
})

/** Numbers on every face: each value's label, in the built-in numerals. */
export const NUMBERS_LAYOUT: FaceLayoutValue = {
  version: 1,
  id: 'numbers',
  default: mark({ kind: 'text' }),
  overrides: [],
}

/** Pips on every face (up to 9). */
export const PIPS_LAYOUT: FaceLayoutValue = {
  version: 1,
  id: 'pips',
  default: mark({ kind: 'pips' }),
  overrides: [],
}

/** The layout a die uses when its skin names none: pips on a d6, numbers everywhere else. */
export function defaultLayoutFor(def: DieDefinition): FaceLayoutValue {
  return def.id === 'd6' ? PIPS_LAYOUT : NUMBERS_LAYOUT
}

/** Turned 180° on the face: 6 ↔ 9, 0, 1 and 8 as they are; other digits read as nothing. */
const TURNED: Record<string, string> = { '0': '0', '1': '1', '6': '9', '8': '8', '9': '6' }

function upsideDown(label: string): string | undefined {
  let out = ''
  for (let i = label.length - 1; i >= 0; i--) {
    const c = TURNED[label[i]!]
    if (c === undefined) return undefined
    out += c
  }
  return out
}

/** Whether a label reads as another label of the die when the die is turned around. */
export function ambiguousLabel(def: DieDefinition, label: string): boolean {
  const turned = upsideDown(label)
  if (turned === undefined || turned === label) return false
  for (let v = 1; v <= def.sides; v++) if (labelOf(def, v) === turned) return true
  return false
}

/** The mark a value prints under a layout. */
export function resolveMark(
  layout: FaceLayoutValue,
  def: DieDefinition,
  value: number,
): ResolvedMark {
  const m = layout.overrides.find((o) => o.value === value)?.mark ?? layout.default
  const text = m.kind === 'text' ? m.text || labelOf(def, value) : ''
  return {
    kind: m.kind,
    text,
    font: m.font,
    size: m.size,
    weight: m.weight,
    underline:
      m.kind === 'text' &&
      (m.underline === 'always' || (m.underline === 'auto' && ambiguousLabel(def, text))),
    count: m.kind === 'pips' ? m.count || value : 0,
    glyph: m.glyph,
    rotation: (m.rotation * Math.PI) / 180,
  }
}

/**
 * What a layout can't show on a die, by value: pips past 9, a glyph that isn't registered, text a
 * font can't draw. Paths point into the layout.
 */
export function layoutProblems(
  layout: FaceLayoutValue,
  def: DieDefinition,
  canDraw: (text: string, font: AssetRef | null) => boolean = builtinCanDraw,
): ShardError[] {
  const out: ShardError[] = []
  for (let value = 1; value <= def.sides; value++) {
    const index = layout.overrides.findIndex((o) => o.value === value)
    const path = index >= 0 ? `/overrides/${index}/mark` : '/default'
    const m = resolveMark(layout, def, value)
    let problem: string | undefined
    if (m.kind === 'pips' && (m.count < 1 || m.count > 9)) problem = `${m.count} pips (1 to 9 draw)`
    else if (m.kind === 'glyph' && !findDiceGlyph(m.glyph))
      problem = m.glyph ? `glyph "${m.glyph}", which isn't registered` : 'a glyph with no name'
    else if (m.kind === 'text' && !canDraw(m.text, m.font))
      problem = `"${m.text}", which the font can't draw`
    if (problem) {
      out.push(
        new ShardError(
          'dice/layout-missing-value',
          `Layout "${layout.id}" can't show ${value} on a ${def.id}: it asks for ${problem}`,
          { path, hint: `Give value ${value} a mark the die can draw, in overrides.` },
        ),
      )
    }
  }
  return out
}

/** The built-in numerals draw digits only. */
export function builtinCanDraw(text: string, font: AssetRef | null): boolean {
  return font !== null || /^[0-9]+$/.test(text)
}
