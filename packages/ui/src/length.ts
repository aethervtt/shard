import { type FieldOptions, type FieldType, type JsonSchema, ShardError } from '@shard/core'

/** A size or offset: pixels (a number), a percent of the parent (`"50%"`), or `"auto"`. */
export type UiLength = number | `${number}%` | 'auto'

/** Unit codes in the second float of a length column. */
export const LengthUnit = { Px: 0, Percent: 1, Auto: 2 } as const

const PATTERN = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|%)?\s*$/i

/** Parses a length into [value, unit], or undefined when it isn't one. */
export function parseLength(json: unknown, out: [number, number] = [0, 0]) {
  if (typeof json === 'number') {
    if (!Number.isFinite(json)) return undefined
    out[0] = json
    out[1] = LengthUnit.Px
    return out
  }
  if (typeof json !== 'string') return undefined
  if (json.trim() === 'auto') {
    out[0] = 0
    out[1] = LengthUnit.Auto
    return out
  }
  const m = PATTERN.exec(json)
  if (!m) return undefined
  out[0] = Number(m[1])
  out[1] = m[2] === '%' ? LengthUnit.Percent : LengthUnit.Px
  return out
}

function invalid(path: string, got: unknown): ShardError {
  return new ShardError(
    'ui/invalid-length',
    `${JSON.stringify(got)} at ${path || '/'} isn't a length`,
    {
      path,
      hint: 'Use pixels (120 or "120"), a percent of the parent ("50%"), or "auto".',
    },
  )
}

function toValue(value: number, unit: number): UiLength {
  if (unit === LengthUnit.Auto) return 'auto'
  // f32 columns: the shortest decimal that reads back the same (0.4, not 0.4000000059604645).
  const v = Number.isInteger(value) ? value : Number(value.toPrecision(7))
  return unit === LengthUnit.Percent ? `${v}%` : v
}

const scratch: [number, number] = [0, 0]

/**
 * A length field: one f32 column with two floats per row (value, unit), so layout reads it from a
 * TypedArray. JSON takes a number (pixels), `"120"`, `"120px"`, `"50%"`, or `"auto"`; reads give
 * a number for pixels and a string otherwise.
 */
export function uiLength(options: FieldOptions<UiLength> = {}): FieldType<UiLength, 'f32'> {
  const fallback: UiLength = options.default ?? 'auto'
  const field: FieldType<UiLength, 'f32'> = {
    kind: 'length',
    storage: 'f32',
    stride: 2,
    options,
    defaultValue: () => fallback,
    read: (c, r) => {
      const col = c as Float32Array
      return toValue(col[r * 2]!, col[r * 2 + 1]!)
    },
    write: (c, r, v) => {
      const parsed = parseLength(v, scratch)
      if (!parsed) throw invalid('', v)
      const col = c as Float32Array
      col[r * 2] = parsed[0]
      col[r * 2 + 1] = parsed[1]
    },
    validate(json, path, errors) {
      if (!parseLength(json, scratch)) errors.push(invalid(path, json))
    },
    toJson: (v) => {
      const parsed = parseLength(v, scratch)
      return parsed ? toValue(parsed[0], parsed[1]) : 'auto'
    },
    fromJson: (json) => {
      const parsed = parseLength(json, scratch)
      return parsed ? toValue(parsed[0], parsed[1]) : 'auto'
    },
    jsonSchema: () => {
      const schema: JsonSchema = {
        anyOf: [
          { type: 'number' },
          { type: 'string', pattern: '^\\s*-?(\\d+\\.?\\d*|\\.\\d+)\\s*(px|%)?\\s*$' },
          { const: 'auto' },
        ],
        default: fallback,
      }
      if (options.description) schema.description = options.description
      if (options.readonly) schema.readOnly = true
      schema['x-unit'] = 'px or %'
      return schema
    },
  }
  return field
}
