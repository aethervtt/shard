export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** A JSON Schema document. Kept loose; we only produce these. */
export type JsonSchema = { [key: string]: unknown }

/** Appends one segment to a JSON pointer, escaping `~` and `/`. */
export function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Deep copy of JSON-like data (arrays and plain objects). Other values are returned as-is. */
export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneData) as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key in value) out[key] = cloneData(value[key])
    return out as T
  }
  return value
}
