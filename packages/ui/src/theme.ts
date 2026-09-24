import { AssetStore, defineAssetType, defineDataAsset, type LoadContext } from '@shard/assets'
import {
  type AnyField,
  type AssetRef,
  cloneData,
  defineResource,
  defineSchema,
  type FieldType,
  isPlainObject,
  type JsonSchema,
  type JsonValue,
  pointer,
  ShardError,
  t,
} from '@shard/core'
import { UiStyle, UiText } from './components'

/** Style fields a theme may set: every UiStyle field, and UiText's look (not its text). */
export const THEME_FIELDS: Readonly<Record<string, AnyField>> = (() => {
  const out: Record<string, AnyField> = {}
  for (const [name, field] of Object.entries(UiStyle.fields)) out[name] = field
  for (const [name, field] of Object.entries(UiText.fields)) {
    if (name !== 'text' && name !== 'key') out[name] = field
  }
  return out
})()

/** State variants a style can have (`"button:hovered"`), applied in this order over the base. */
export const THEME_STATES = ['on', 'focused', 'hovered', 'pressed', 'disabled'] as const

/** One style: the fields it sets (values as components hold them: colors linear, refs resolved). */
export type ThemeStyle = Record<string, unknown>

function unknownStyleField(path: string, key: string): ShardError {
  return new ShardError('schema/unknown-field', `Unknown style field "${key}" at ${path}`, {
    path,
    hint: `A style sets ${Object.keys(THEME_FIELDS).join(', ')}.`,
  })
}

const STYLES_DESCRIPTION =
  'Style name → fields (UiStyle and UiText: background, borderColor, borderWidth, radius, opacity, size, color, font, align, wrap, lineHeight). "name:hovered" (on, focused, hovered, pressed, disabled) overrides fields in that state.'

/**
 * The `styles` field: style name → fields. Validated and converted field by field with the
 * UiStyle and UiText schemas, so a theme takes exactly what a node does.
 */
function stylesField(): FieldType<Record<string, ThemeStyle>, 'object'> {
  const base = t.json()
  const convert = (json: unknown, toValue: boolean, ctx?: Parameters<AnyField['fromJson']>[1]) => {
    const out: Record<string, Record<string, unknown>> = {}
    if (!isPlainObject(json)) return out
    for (const [name, style] of Object.entries(json)) {
      if (!isPlainObject(style)) continue
      const s: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(style)) {
        const field = THEME_FIELDS[key]
        if (!field) continue
        s[key] = toValue ? field.fromJson(value, ctx) : field.toJson(value)
      }
      out[name] = s
    }
    return out
  }
  return {
    ...(base as unknown as FieldType<Record<string, ThemeStyle>, 'object'>),
    options: { description: STYLES_DESCRIPTION },
    defaultValue: () => ({}),
    read: (c, r) => cloneData((c as unknown[])[r] as JsonValue) as never,
    write: (c, r, v) => {
      ;(c as unknown[])[r] = cloneData(v as JsonValue)
    },
    validate(json, path, errors, ctx) {
      if (!isPlainObject(json)) {
        errors.push(
          new ShardError('schema/type-mismatch', `Expected an object of styles at ${path || '/'}`, {
            path,
            hint: 'Use { "panel": { "background": "#101820cc" } }.',
          }),
        )
        return
      }
      for (const [name, style] of Object.entries(json)) {
        const at = pointer(path, name)
        const colon = name.indexOf(':')
        const state = colon === -1 ? '' : name.slice(colon + 1)
        if (colon === 0 || (state && !(THEME_STATES as readonly string[]).includes(state))) {
          errors.push(
            new ShardError('ui/unknown-state', `"${name}" isn't a style or a style state`, {
              path: at,
              hint: `Name a style ("button") or a state of one: ${THEME_STATES.map((s) => `"button:${s}"`).join(', ')}.`,
            }),
          )
        }
        if (!isPlainObject(style)) {
          errors.push(
            new ShardError('schema/type-mismatch', `Style "${name}" must be an object`, {
              path: at,
            }),
          )
          continue
        }
        for (const [key, value] of Object.entries(style)) {
          const field = THEME_FIELDS[key]
          if (!field) errors.push(unknownStyleField(pointer(at, key), key))
          else field.validate(value, pointer(at, key), errors, ctx)
        }
      }
    },
    toJson: (v) => convert(v, false) as JsonValue as never,
    fromJson: (json, ctx) => convert(json, true, ctx) as never,
    jsonSchema: () => {
      const properties: Record<string, JsonSchema> = {}
      for (const [key, field] of Object.entries(THEME_FIELDS)) properties[key] = field.jsonSchema()
      return {
        type: 'object',
        description: STYLES_DESCRIPTION,
        additionalProperties: { type: 'object', properties, additionalProperties: false },
        propertyNames: { pattern: `^[^:]+(:(${THEME_STATES.join('|')}))?$` },
        default: {},
      }
    },
  }
}

export const UiThemeSchema = defineSchema(
  'ui/UiTheme',
  {
    font: t.handle('Font', { description: "Font for the theme's text (styles may pick others)." }),
    styles: stylesField(),
  },
  {
    description:
      'Named node styles for a UI root (*.theme.json): nodes pick one with UiNode.style; fields a node sets win.',
  },
)

/** A loaded theme: styles by name, with state variants kept separately. Hot reload bumps version. */
export class UiThemeAsset {
  font: AssetRef<'Font'> | null
  /** Style name → fields; state variants under "name:state". */
  styles: Map<string, ThemeStyle>
  version = 0

  constructor(font: AssetRef<'Font'> | null, styles: Record<string, ThemeStyle>) {
    this.font = font
    this.styles = new Map(Object.entries(styles))
  }

  copyFrom(other: UiThemeAsset): void {
    this.font = other.font
    this.styles = other.styles
    this.version++
  }

  /** Builds a theme from its JSON form (`*.theme.json`). */
  static fromJson(json: unknown, resolve?: (path: string) => AssetRef | undefined): UiThemeAsset {
    const value = UiThemeSchema.deserialize(json) as {
      font: AssetRef<'Font'> | null
      styles: Record<string, ThemeStyle>
    }
    const fix = (ref: AssetRef | null | undefined): AssetRef | null => {
      if (!ref) return null
      const resolved = ref.path ? resolve?.(ref.path) : undefined
      return resolved ? { type: ref.type, guid: resolved.guid, path: resolved.path } : ref
    }
    for (const style of Object.values(value.styles)) {
      if (style.font) style.font = fix(style.font as AssetRef)
    }
    return new UiThemeAsset(fix(value.font) as AssetRef<'Font'> | null, value.styles)
  }
}

export class UiThemeStore extends AssetStore<UiThemeAsset, 'UiTheme'> {
  constructor() {
    super('UiTheme')
  }
}

export const UiThemes = defineResource<UiThemeStore>('ui/UiThemes', {
  description: 'Loaded UI themes by guid.',
  init: () => new UiThemeStore(),
})

export const UiThemeAssetType = defineAssetType<UiThemeAsset>('UiTheme', {
  store: UiThemes,
  load: (artifact, ctx: LoadContext) =>
    UiThemeAsset.fromJson(artifact.json, (path) => ctx.resolve(path)),
  update: (existing, next) => existing.copyFrom(next),
})

/** `*.theme.json`: named styles for UI roots. */
export const UiThemeImporter = defineDataAsset('UiTheme', UiThemeSchema, { extension: 'theme' })
