import {
  type AnyField,
  type ComponentDef,
  type FieldKind,
  type Fields,
  type InferFields,
  ShardError,
} from '@aethervtt/shard-core'

interface FieldLayout {
  name: string
  kind: FieldKind
  wgslType: string
  offset: number
  size: number
  align: number
  /** Struct fields: the nested struct's members. */
  members?: readonly FieldLayout[]
}

export interface WgslLayout<F extends Fields> {
  /** WGSL struct declaration, e.g. `struct ToonParams { bands: u32, rim: vec4f, width: f32, }`. */
  readonly wgsl: string
  readonly structName: string
  /** Size in bytes, rounded up to the struct's alignment (what a uniform/storage binding needs). */
  readonly size: number
  readonly align: number
  readonly fields: readonly FieldLayout[]
  /**
   * The nested structs it uses (struct fields with a `wgsl` option), as `module::path::Name`: a
   * module declaring this struct imports them.
   */
  readonly imports: readonly string[]
  /** Writes a value at a byte offset using WGSL's layout rules. */
  write(view: DataView, offset: number, value: InferFields<F>): void
}

/** WGSL type, size, and alignment for each supported field kind (WGSL spec §13.4 memory layout). */
const TYPES: Partial<Record<FieldKind, { type: string; size: number; align: number }>> = {
  f32: { type: 'f32', size: 4, align: 4 },
  i8: { type: 'i32', size: 4, align: 4 },
  i16: { type: 'i32', size: 4, align: 4 },
  i32: { type: 'i32', size: 4, align: 4 },
  u8: { type: 'u32', size: 4, align: 4 },
  u16: { type: 'u32', size: 4, align: 4 },
  u32: { type: 'u32', size: 4, align: 4 },
  bool: { type: 'u32', size: 4, align: 4 },
  enum: { type: 'u32', size: 4, align: 4 },
  vec2: { type: 'vec2f', size: 8, align: 8 },
  vec3: { type: 'vec3f', size: 12, align: 16 },
  vec4: { type: 'vec4f', size: 16, align: 16 },
  quat: { type: 'vec4f', size: 16, align: 16 },
  color: { type: 'vec4f', size: 16, align: 16 },
  mat3: { type: 'mat3x3f', size: 48, align: 16 },
  mat4: { type: 'mat4x4f', size: 64, align: 16 },
  affine3x4: { type: 'array<vec4f, 3>', size: 48, align: 16 },
}

const alignTo = (n: number, a: number) => Math.ceil(n / a) * a

interface Packed {
  fields: FieldLayout[]
  size: number
  align: number
  imports: Set<string>
}

/** Lays out `entries` by WGSL's rules; struct fields with a `wgsl` option nest (16-aligned). */
function pack(owner: string, entries: Iterable<[string, AnyField]>, imports: Set<string>): Packed {
  const fields: FieldLayout[] = []
  let offset = 0
  let structAlign = 4
  for (const [name, field] of entries) {
    // Host-only fields (`gpu: false`) aren't GPU data.
    if (field.options.gpu === false) continue
    let layout: FieldLayout
    if (field.kind === 'struct' && field.options.wgsl) {
      // A struct member of a uniform is 16-aligned, and so is what follows it.
      const inner = pack(`${owner}.${name}`, Object.entries(field.fields ?? {}), imports)
      const path = field.options.wgsl
      imports.add(path)
      const align = Math.max(16, inner.align)
      offset = alignTo(offset, align)
      layout = {
        name,
        kind: 'struct',
        wgslType: path.slice(path.lastIndexOf('::') + 2),
        offset,
        size: alignTo(inner.size, align),
        align,
        members: inner.fields,
      }
    } else {
      // Other object fields (asset handles, strings, lists) are bound, not packed.
      if (field.storage === 'object') continue
      const t = TYPES[field.kind]
      if (!t) {
        throw new ShardError(
          'shader/unsupported-field',
          `Field "${name}" of ${owner} (${field.kind}) can't be a GPU struct member`,
          {
            hint: 'GPU structs take numbers, bools, enums, vectors, colors, matrices, and structs with a `wgsl` option. f64 fields are not allowed; other object fields are skipped.',
          },
        )
      }
      offset = alignTo(offset, t.align)
      layout = { name, kind: field.kind, wgslType: t.type, offset, size: t.size, align: t.align }
    }
    fields.push(layout)
    offset += layout.size
    structAlign = Math.max(structAlign, layout.align)
  }
  return { fields, size: alignTo(Math.max(offset, 4), structAlign), align: structAlign, imports }
}

/** Enum value lists by field, for every enum in `entries` and the structs it nests. */
function enumsOf(entries: Iterable<[string, AnyField]>, out: Map<AnyField, readonly string[]>) {
  for (const [, field] of entries) {
    // The enum's default is its first value; recover the list from its JSON Schema.
    if (field.kind === 'enum') out.set(field, (field.jsonSchema() as { enum: string[] }).enum)
    else if (field.kind === 'struct' && field.fields) enumsOf(Object.entries(field.fields), out)
  }
  return out
}

/**
 * WGSL struct and byte packer generated from a component schema, so the CPU value, the GPU struct,
 * and the byte layout come from one definition and can't drift apart.
 */
export function wgslLayout<F extends Fields>(def: ComponentDef<F>): WgslLayout<F> {
  const structName = def.name.split('/').pop()!
  const entries = def.layout.map(({ name, field }) => [name, field] as [string, AnyField])
  const packed = pack(def.name, entries, new Set())
  const wgsl = `struct ${structName} {\n${packed.fields.map((f) => `  ${f.name}: ${f.wgslType},`).join('\n')}\n}`
  const schema: Fields = Object.fromEntries(entries)
  const enumValues = enumsOf(entries, new Map())

  const writeFields = (
    view: DataView,
    base: number,
    layouts: readonly FieldLayout[],
    record: Record<string, unknown>,
    schema: Fields,
  ): void => {
    for (const f of layouts) {
      const o = base + f.offset
      const v = record[f.name]
      switch (f.kind) {
        case 'struct': {
          writeFields(view, o, f.members!, v as Record<string, unknown>, schema[f.name]!.fields!)
          break
        }
        case 'f32':
          view.setFloat32(o, v as number, true)
          break
        case 'i8':
        case 'i16':
        case 'i32':
          view.setInt32(o, v as number, true)
          break
        case 'u8':
        case 'u16':
        case 'u32':
          view.setUint32(o, v as number, true)
          break
        case 'bool':
          view.setUint32(o, v ? 1 : 0, true)
          break
        case 'enum': {
          const values = enumValues.get(schema[f.name]!)!
          view.setUint32(o, Math.max(0, values.indexOf(v as string)), true)
          break
        }
        case 'mat3': {
          // Column-major 3x3; each column padded to 16 bytes.
          const m = v as ArrayLike<number>
          for (let c = 0; c < 3; c++) {
            for (let r = 0; r < 3; r++) view.setFloat32(o + c * 16 + r * 4, m[c * 3 + r]!, true)
          }
          break
        }
        default: {
          const arr = v as ArrayLike<number>
          for (let i = 0; i < arr.length; i++) view.setFloat32(o + i * 4, arr[i]!, true)
        }
      }
    }
  }

  return {
    wgsl,
    structName,
    size: packed.size,
    align: packed.align,
    fields: packed.fields,
    imports: [...packed.imports],
    write(view, base, value) {
      writeFields(view, base, packed.fields, value as Record<string, unknown>, schema)
    },
  }
}
