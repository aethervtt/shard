import type { Entity } from '../ecs/entity'
import { ShardError } from '../error'
import { cloneData, isPlainObject, type JsonSchema, type JsonValue, pointer } from '../json'
import { HEX_COLOR, hexToLinear, linearToHex } from './color'

export type NumericStorage = 'f32' | 'f64' | 'i8' | 'i16' | 'i32' | 'u8' | 'u16' | 'u32'
export type Storage = NumericStorage | 'object'

export type TypedArrayFor<S extends Storage> = S extends 'f32'
  ? Float32Array
  : S extends 'f64'
    ? Float64Array
    : S extends 'i8'
      ? Int8Array
      : S extends 'i16'
        ? Int16Array
        : S extends 'i32'
          ? Int32Array
          : S extends 'u8'
            ? Uint8Array
            : S extends 'u16'
              ? Uint16Array
              : S extends 'u32'
                ? Uint32Array
                : never

export type TypedArray = TypedArrayFor<NumericStorage>
export type Column = TypedArray | unknown[]

export type FieldKind =
  | NumericStorage
  | 'bool'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'quat'
  | 'color'
  | 'enum'
  | 'entity'
  | 'string'
  | 'handle'
  | 'list'
  | 'struct'
  | 'json'

export interface FieldOptions<V> {
  /** Written for agents and tools: what the field means, not its type. */
  description?: string
  default?: V
  /** Numeric fields and each component of vectors. */
  min?: number
  max?: number
  unit?: string
  hidden?: boolean
  readonly?: boolean
  /** Missing values are an error instead of taking the default. */
  required?: boolean
}

/** A reference to an asset. `guid` is the identity; `path` is for readers. */
export interface AssetRef<T extends string = string> {
  readonly type: T
  guid: string | undefined
  path: string | undefined
}

export interface ResolvedAsset {
  readonly guid: string
  readonly path: string
  readonly type: string
}

/** Optional hooks for things the schema can't know on its own. */
export interface SchemaContext {
  /** Resolves an entity path (e.g. `lobby/sofa_02`) to an entity. */
  resolveEntity?(path: string): Entity | undefined
  /** Looks up an asset by guid or path, for validation and to fill in the other half. */
  resolveAsset?(ref: { guid?: string; path?: string }): ResolvedAsset | undefined
}

export interface FieldType<V = unknown, S extends Storage = Storage> {
  readonly kind: FieldKind
  readonly storage: S
  /** Values per row in the column (3 for vec3). */
  readonly stride: number
  readonly options: FieldOptions<V>
  /** Phantom, for type inference only. */
  readonly __value?: V
  defaultValue(): V
  read(column: Column, row: number): V
  write(column: Column, row: number, value: V): void
  validate(json: unknown, path: string, errors: ShardError[], ctx: SchemaContext | undefined): void
  toJson(value: V): JsonValue
  fromJson(json: unknown, ctx: SchemaContext | undefined): V
  jsonSchema(): JsonSchema
}

export type AnyField = FieldType<unknown, Storage>
export type Fields = Record<string, AnyField>

export type FieldValue<T> = T extends FieldType<infer V, Storage> ? V : never
export type InferFields<F extends Fields> = { -readonly [K in keyof F]: FieldValue<F[K]> }

/** What you may pass in: arrays can be readonly, since values are copied into columns. */
export type FieldInput<V> = V extends unknown[] ? Readonly<V> : V
/** Input for spawn/add/set: any subset of fields; missing ones take defaults or stay unchanged. */
export type InitFields<F extends Fields> = { [K in keyof F]?: FieldInput<FieldValue<F[K]>> }

// ---------------------------------------------------------------------------
// Errors

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

function mismatch(path: string, expected: string, got: unknown): ShardError {
  return new ShardError(
    'schema/type-mismatch',
    `Expected ${expected} at ${path || '/'}, got ${describeValue(got)}`,
    { path, hint: `Use ${expected}.` },
  )
}

function outOfRange(path: string, value: number, min: number, max: number): ShardError {
  return new ShardError(
    'schema/out-of-range',
    `Value ${value} at ${path || '/'} is outside [${min}, ${max}]`,
    { path, hint: `Use a value between ${min} and ${max}.` },
  )
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]!
}

function unknownField(path: string, key: string, known: readonly string[]): ShardError {
  const close = known.find((k) => editDistance(k.toLowerCase(), key.toLowerCase()) <= 2)
  const hint = close
    ? `Did you mean "${close}"?`
    : known.length > 0
      ? `Known fields: ${known.join(', ')}.`
      : 'This type has no fields; use {}.'
  return new ShardError('schema/unknown-field', `Unknown field "${key}" at ${path || '/'}`, {
    path: pointer(path, key),
    hint,
  })
}

// ---------------------------------------------------------------------------
// Shared pieces

function baseSchema(options: FieldOptions<unknown>, defaultJson: JsonValue): JsonSchema {
  const schema: JsonSchema = {}
  if (options.description) schema.description = options.description
  if (options.readonly) schema.readOnly = true
  if (options.unit) schema['x-unit'] = options.unit
  if (options.hidden) schema['x-hidden'] = true
  schema.default = defaultJson
  return schema
}

function makeField<V, S extends Storage>(
  spec: Omit<FieldType<V, S>, 'jsonSchema' | '__value'> & { schema(): JsonSchema },
): FieldType<V, S> {
  const field: FieldType<V, S> = {
    ...spec,
    jsonSchema: () => ({
      ...baseSchema(spec.options as FieldOptions<unknown>, spec.toJson(spec.defaultValue())),
      ...spec.schema(),
    }),
  }
  delete (field as { schema?: unknown }).schema
  return field
}

type Factory<V, S extends Storage> = FieldType<V, S> &
  ((options?: FieldOptions<V>) => FieldType<V, S>)

/** Makes `t.f32` usable both bare and as `t.f32({ ... })`. */
function callable<V, S extends Storage>(
  create: (options: FieldOptions<V>) => FieldType<V, S>,
): Factory<V, S> {
  return Object.assign((options: FieldOptions<V> = {}) => create(options), create({}))
}

// ---------------------------------------------------------------------------
// Numbers and booleans

const INT_RANGE: Record<string, [number, number]> = {
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
}

function numberField<S extends NumericStorage>(storage: S) {
  return callable<number, S>((options) => {
    const range = INT_RANGE[storage]
    const isInt = range !== undefined
    const min = Math.max(range?.[0] ?? -Infinity, options.min ?? -Infinity)
    const max = Math.min(range?.[1] ?? Infinity, options.max ?? Infinity)
    return makeField<number, S>({
      kind: storage,
      storage,
      stride: 1,
      options,
      defaultValue: () => options.default ?? 0,
      read: (c, r) => (c as TypedArray)[r]!,
      write: (c, r, v) => {
        ;(c as TypedArray)[r] = v
      },
      validate(json, path, errors) {
        if (typeof json !== 'number' || !Number.isFinite(json)) {
          errors.push(mismatch(path, isInt ? 'an integer' : 'a number', json))
        } else if (isInt && !Number.isInteger(json)) {
          errors.push(mismatch(path, 'an integer', json))
        } else if (json < min || json > max) {
          errors.push(outOfRange(path, json, min, max))
        }
      },
      toJson: (v) => v,
      fromJson: (json) => json as number,
      schema: () => {
        const s: JsonSchema = { type: isInt ? 'integer' : 'number' }
        if (Number.isFinite(min)) s.minimum = min
        if (Number.isFinite(max)) s.maximum = max
        return s
      },
    })
  })
}

const bool = callable<boolean, 'u8'>((options) =>
  makeField<boolean, 'u8'>({
    kind: 'bool',
    storage: 'u8',
    stride: 1,
    options,
    defaultValue: () => options.default ?? false,
    read: (c, r) => (c as Uint8Array)[r] === 1,
    write: (c, r, v) => {
      ;(c as Uint8Array)[r] = v ? 1 : 0
    },
    validate(json, path, errors) {
      if (typeof json !== 'boolean') errors.push(mismatch(path, 'a boolean', json))
    },
    toJson: (v) => v,
    fromJson: (json) => json as boolean,
    schema: () => ({ type: 'boolean' }),
  }),
)

// ---------------------------------------------------------------------------
// Vectors and colors

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type Vec4 = [number, number, number, number]
export type Quat = [number, number, number, number]
export type Color = [number, number, number, number]

function readStrided(c: Column, r: number, n: number): number[] {
  const out = new Array<number>(n)
  const base = r * n
  for (let i = 0; i < n; i++) out[i] = (c as Float32Array)[base + i]!
  return out
}

function writeStrided(c: Column, r: number, n: number, v: readonly number[]): void {
  const base = r * n
  for (let i = 0; i < n; i++) (c as Float32Array)[base + i] = v[i]!
}

function validateNumberArray(
  json: unknown,
  n: number,
  path: string,
  errors: ShardError[],
  min = -Infinity,
  max = Infinity,
): void {
  const expected = `an array of ${n} numbers`
  if (!Array.isArray(json) || json.length !== n) {
    errors.push(mismatch(path, expected, json))
    return
  }
  for (let i = 0; i < n; i++) {
    const v = json[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(mismatch(pointer(path, i), 'a number', v))
    } else if (v < min || v > max) {
      errors.push(outOfRange(pointer(path, i), v, min, max))
    }
  }
}

function numberArraySchema(n: number, options: FieldOptions<unknown>): JsonSchema {
  const items: JsonSchema = { type: 'number' }
  if (options.min !== undefined) items.minimum = options.min
  if (options.max !== undefined) items.maximum = options.max
  return { type: 'array', items, minItems: n, maxItems: n }
}

function vectorField<V extends number[]>(kind: 'vec2' | 'vec3' | 'vec4' | 'quat', zero: V) {
  const n = zero.length
  return callable<V, 'f32'>((options) =>
    makeField<V, 'f32'>({
      kind,
      storage: 'f32',
      stride: n,
      options,
      defaultValue: () => [...(options.default ?? zero)] as V,
      read: (c, r) => readStrided(c, r, n) as V,
      write: (c, r, v) => writeStrided(c, r, n, v),
      validate: (json, path, errors) =>
        validateNumberArray(json, n, path, errors, options.min, options.max),
      toJson: (v) => [...v],
      fromJson: (json) => [...(json as V)] as V,
      schema: () => numberArraySchema(n, options as FieldOptions<unknown>),
    }),
  )
}

const color = callable<Color, 'f32'>((options) =>
  makeField<Color, 'f32'>({
    kind: 'color',
    storage: 'f32',
    stride: 4,
    options,
    defaultValue: () => [...(options.default ?? [1, 1, 1, 1])] as Color,
    read: (c, r) => readStrided(c, r, 4) as Color,
    write: (c, r, v) => writeStrided(c, r, 4, v),
    validate(json, path, errors) {
      if (typeof json === 'string') {
        if (!HEX_COLOR.test(json)) {
          errors.push(
            new ShardError('schema/type-mismatch', `Invalid color "${json}" at ${path || '/'}`, {
              path,
              hint: 'Use "#rrggbb", "#rrggbbaa", or a linear [r, g, b, a] array.',
            }),
          )
        }
        return
      }
      validateNumberArray(json, 4, path, errors, 0)
    },
    toJson: (v) => linearToHex(v) ?? [...v],
    fromJson: (json) =>
      typeof json === 'string' ? hexToLinear(json) : ([...(json as Color)] as Color),
    schema: () => ({
      anyOf: [
        { type: 'string', pattern: HEX_COLOR.source },
        { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 4, maxItems: 4 },
      ],
    }),
  }),
)

// ---------------------------------------------------------------------------
// Enums and entities

function enumField<const T extends readonly string[]>(
  values: T,
  options: FieldOptions<T[number]> = {},
): FieldType<T[number], 'u8'> {
  if (values.length === 0 || values.length > 256) {
    throw new ShardError('schema/invalid-field', 'Enums need between 1 and 256 values')
  }
  const index = new Map(values.map((v, i) => [v, i]))
  return makeField<T[number], 'u8'>({
    kind: 'enum',
    storage: 'u8',
    stride: 1,
    options,
    defaultValue: () => options.default ?? values[0]!,
    read: (c, r) => values[(c as Uint8Array)[r]!]!,
    write: (c, r, v) => {
      const i = index.get(v)
      if (i === undefined) {
        throw new ShardError('schema/invalid-enum', `"${v}" is not one of ${values.join(', ')}`)
      }
      ;(c as Uint8Array)[r] = i
    },
    validate(json, path, errors) {
      if (typeof json !== 'string' || !index.has(json)) {
        errors.push(
          new ShardError(
            'schema/type-mismatch',
            `Expected one of ${values.map((v) => `"${v}"`).join(', ')} at ${path || '/'}, got ${JSON.stringify(json)}`,
            { path },
          ),
        )
      }
    },
    toJson: (v) => v,
    fromJson: (json) => json as T[number],
    schema: () => ({ type: 'string', enum: [...values] }),
  })
}

const entity = callable<Entity | null, 'f64'>((options) =>
  makeField<Entity | null, 'f64'>({
    kind: 'entity',
    storage: 'f64',
    stride: 1,
    options,
    defaultValue: () => null,
    read: (c, r) => {
      const v = (c as Float64Array)[r]!
      return v < 0 ? null : v
    },
    write: (c, r, v) => {
      ;(c as Float64Array)[r] = v ?? -1
    },
    validate(json, path, errors) {
      const ok =
        json === null ||
        (typeof json === 'number' && Number.isInteger(json) && json >= 0) ||
        (typeof json === 'string' && json.length > 0)
      if (!ok) errors.push(mismatch(path, 'an entity id, an entity path, or null', json))
    },
    toJson: (v) => v,
    fromJson(json, ctx) {
      if (typeof json !== 'string') return json as Entity | null
      const resolved = ctx?.resolveEntity?.(json)
      if (resolved === undefined) {
        throw new ShardError('schema/unresolved-entity', `Entity path "${json}" did not resolve`, {
          hint: 'Entity paths are resolved by the scene loader; check the path exists.',
        })
      }
      return resolved
    },
    schema: () => ({
      anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }, { type: 'string', minLength: 1 }],
    }),
  }),
)

// ---------------------------------------------------------------------------
// Object-column types

function objectField<V>(
  spec: Omit<FieldType<V, 'object'>, 'storage' | 'stride' | 'read' | 'write' | 'jsonSchema'> & {
    schema(): JsonSchema
  },
): FieldType<V, 'object'> {
  return makeField<V, 'object'>({
    ...spec,
    storage: 'object',
    stride: 1,
    read: (c, r) => cloneData((c as unknown[])[r] as V),
    write: (c, r, v) => {
      ;(c as unknown[])[r] = cloneData(v)
    },
  })
}

const string = callable<string, 'object'>((options) =>
  objectField<string>({
    kind: 'string',
    options,
    defaultValue: () => options.default ?? '',
    validate(json, path, errors) {
      if (typeof json !== 'string') errors.push(mismatch(path, 'a string', json))
    },
    toJson: (v) => v,
    fromJson: (json) => json as string,
    schema: () => ({ type: 'string' }),
  }),
)

function handle<const T extends string>(
  type: T,
  options: FieldOptions<AssetRef<T> | null> = {},
): FieldType<AssetRef<T> | null, 'object'> {
  return objectField<AssetRef<T> | null>({
    kind: 'handle',
    options,
    defaultValue: () => cloneData(options.default ?? null),
    validate(json, path, errors, ctx) {
      if (json === null) return
      if (!isPlainObject(json)) {
        errors.push(mismatch(path, `a ${type} reference { guid, path } or null`, json))
        return
      }
      for (const key of Object.keys(json)) {
        if (key !== 'guid' && key !== 'path') errors.push(unknownField(path, key, ['guid', 'path']))
      }
      const { guid, path: assetPath } = json
      if (guid !== undefined && (typeof guid !== 'string' || guid === '')) {
        errors.push(mismatch(pointer(path, 'guid'), 'a non-empty string', guid))
      }
      if (assetPath !== undefined && (typeof assetPath !== 'string' || assetPath === '')) {
        errors.push(mismatch(pointer(path, 'path'), 'a non-empty string', assetPath))
      }
      if (guid === undefined && assetPath === undefined) {
        errors.push(
          new ShardError('schema/missing-field', `Asset reference at ${path || '/'} is empty`, {
            path,
            hint: 'Give a "guid", a "path", or both.',
          }),
        )
        return
      }
      if (!ctx?.resolveAsset) return
      const resolved = ctx.resolveAsset(json as { guid?: string; path?: string })
      if (!resolved) {
        errors.push(
          new ShardError(
            'schema/asset-not-found',
            `No asset matches ${JSON.stringify(json)} at ${path || '/'}`,
            { path, hint: 'Check the path, or that the asset has been imported.' },
          ),
        )
      } else if (resolved.type !== type) {
        errors.push(
          new ShardError(
            'schema/asset-type-mismatch',
            `Expected a ${type} at ${path || '/'}, but ${resolved.path} is a ${resolved.type}`,
            { path },
          ),
        )
      }
    },
    toJson(v) {
      if (v === null) return null
      const out: { guid?: string; path?: string } = {}
      if (v.guid !== undefined) out.guid = v.guid
      if (v.path !== undefined) out.path = v.path
      return out
    },
    fromJson(json, ctx) {
      if (json === null) return null
      const ref = json as { guid?: string; path?: string }
      const resolved = ctx?.resolveAsset?.(ref)
      return { type, guid: resolved?.guid ?? ref.guid, path: resolved?.path ?? ref.path }
    },
    schema: () => ({
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            guid: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
          minProperties: 1,
          'x-asset-type': type,
        },
      ],
    }),
  })
}

function list<I extends AnyField>(
  inner: I,
  options: FieldOptions<FieldValue<I>[]> = {},
): FieldType<FieldValue<I>[], 'object'> {
  return objectField<FieldValue<I>[]>({
    kind: 'list',
    options,
    defaultValue: () => cloneData(options.default ?? []),
    validate(json, path, errors, ctx) {
      if (!Array.isArray(json)) {
        errors.push(mismatch(path, 'an array', json))
        return
      }
      for (let i = 0; i < json.length; i++) inner.validate(json[i], pointer(path, i), errors, ctx)
    },
    toJson: (v) => v.map((item) => inner.toJson(item)),
    fromJson: (json, ctx) =>
      (json as unknown[]).map((item) => inner.fromJson(item, ctx)) as FieldValue<I>[],
    schema: () => ({ type: 'array', items: inner.jsonSchema() }),
  })
}

function struct<F extends Fields>(
  fields: F,
  options: FieldOptions<InferFields<F>> = {},
): FieldType<InferFields<F>, 'object'> {
  return objectField<InferFields<F>>({
    kind: 'struct',
    options,
    defaultValue: () => cloneData(options.default ?? defaultsOf(fields)),
    validate: (json, path, errors, ctx) => validateObject(fields, json, path, errors, ctx),
    toJson: (v) => objectToJson(fields, v),
    fromJson: (json, ctx) => objectFromJson(fields, json as Record<string, unknown>, ctx),
    schema: () => objectSchema(fields),
  })
}

const json = callable<JsonValue, 'object'>((options) =>
  objectField<JsonValue>({
    kind: 'json',
    options,
    defaultValue: () => cloneData(options.default ?? null),
    validate() {},
    toJson: (v) => cloneData(v),
    fromJson: (json) => cloneData(json as JsonValue),
    schema: () => ({}),
  }),
)

// ---------------------------------------------------------------------------
// Objects (components and structs share these)

export function defaultsOf<F extends Fields>(fields: F): InferFields<F> {
  const out: Record<string, unknown> = {}
  for (const name in fields) out[name] = fields[name]!.defaultValue()
  return out as InferFields<F>
}

export function validateObject(
  fields: Fields,
  json: unknown,
  path: string,
  errors: ShardError[],
  ctx: SchemaContext | undefined,
): void {
  if (!isPlainObject(json)) {
    errors.push(mismatch(path, 'an object', json))
    return
  }
  const known = Object.keys(fields)
  for (const key of Object.keys(json)) {
    if (!Object.hasOwn(fields, key)) errors.push(unknownField(path, key, known))
  }
  for (const name of known) {
    const field = fields[name]!
    const value = json[name]
    if (value === undefined) {
      if (field.options.required) {
        errors.push(
          new ShardError('schema/missing-field', `Missing required field "${name}"`, {
            path: pointer(path, name),
            hint: field.options.description,
          }),
        )
      }
      continue
    }
    field.validate(value, pointer(path, name), errors, ctx)
  }
}

export function objectToJson(fields: Fields, value: Record<string, unknown>) {
  const out: { [key: string]: JsonValue } = {}
  for (const name in fields) out[name] = fields[name]!.toJson(value[name])
  return out
}

export function objectFromJson<F extends Fields>(
  fields: F,
  json: Record<string, unknown>,
  ctx: SchemaContext | undefined,
): InferFields<F> {
  const out: Record<string, unknown> = {}
  for (const name in fields) {
    const field = fields[name]!
    out[name] = json[name] === undefined ? field.defaultValue() : field.fromJson(json[name], ctx)
  }
  return out as InferFields<F>
}

export function objectSchema(fields: Fields): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const name in fields) {
    properties[name] = fields[name]!.jsonSchema()
    if (fields[name]!.options.required) required.push(name)
  }
  const schema: JsonSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

// ---------------------------------------------------------------------------

/** Field type constructors. Bare (`t.f32`) or with options (`t.f32({ default: 1 })`). */
export const t = {
  f32: numberField('f32'),
  f64: numberField('f64'),
  i8: numberField('i8'),
  i16: numberField('i16'),
  i32: numberField('i32'),
  u8: numberField('u8'),
  u16: numberField('u16'),
  u32: numberField('u32'),
  bool,
  vec2: vectorField<Vec2>('vec2', [0, 0]),
  vec3: vectorField<Vec3>('vec3', [0, 0, 0]),
  vec4: vectorField<Vec4>('vec4', [0, 0, 0, 0]),
  quat: vectorField<Quat>('quat', [0, 0, 0, 1]),
  color,
  enum: enumField,
  entity,
  string,
  handle,
  list,
  struct,
  json,
}
