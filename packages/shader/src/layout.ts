import {
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
}

export interface WgslLayout<F extends Fields> {
  /** WGSL struct declaration, e.g. `struct ToonParams { bands: u32, rim: vec4f, width: f32, }`. */
  readonly wgsl: string
  readonly structName: string
  /** Size in bytes, rounded up to the struct's alignment (what a uniform/storage binding needs). */
  readonly size: number
  readonly align: number
  readonly fields: readonly FieldLayout[]
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

/**
 * WGSL struct and byte packer generated from a component schema, so the CPU value, the GPU struct,
 * and the byte layout come from one definition and can't drift apart.
 */
export function wgslLayout<F extends Fields>(def: ComponentDef<F>): WgslLayout<F> {
  const structName = def.name.split('/').pop()!
  const fields: FieldLayout[] = []
  let offset = 0
  let structAlign = 4
  for (const { name, field, storage } of def.layout) {
    // Object fields (asset handles, structs, strings) aren't GPU data: they're bound, not packed.
    // Nor are host-only fields (`gpu: false`).
    if (storage === 'object' || field.options.gpu === false) continue
    const t = TYPES[field.kind]
    if (!t) {
      throw new ShardError(
        'shader/unsupported-field',
        `Field "${name}" of ${def.name} (${field.kind}) can't be a GPU struct member`,
        {
          hint: 'GPU structs take numbers, bools, enums, vectors, colors, and matrices. f64 fields are not allowed; object fields are skipped.',
        },
      )
    }
    offset = alignTo(offset, t.align)
    fields.push({ name, kind: field.kind, wgslType: t.type, offset, size: t.size, align: t.align })
    offset += t.size
    structAlign = Math.max(structAlign, t.align)
  }
  const size = alignTo(Math.max(offset, 4), structAlign)
  const wgsl = `struct ${structName} {\n${fields.map((f) => `  ${f.name}: ${f.wgslType},`).join('\n')}\n}`
  const enumValues = new Map<string, readonly string[]>()
  for (const { name, field } of def.layout) {
    if (field.kind === 'enum') {
      // The enum's default is its first value; recover the list from its JSON Schema.
      enumValues.set(name, (field.jsonSchema() as { enum: string[] }).enum)
    }
  }

  return {
    wgsl,
    structName,
    size,
    align: structAlign,
    fields,
    write(view, base, value) {
      const record = value as Record<string, unknown>
      for (const f of fields) {
        const o = base + f.offset
        const v = record[f.name]
        switch (f.kind) {
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
          case 'enum':
            view.setUint32(o, Math.max(0, enumValues.get(f.name)!.indexOf(v as string)), true)
            break
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
    },
  }
}
