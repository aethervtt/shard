import type { Entity } from '../ecs/entity'
import type { Table } from '../ecs/table'
import { ShardError } from '../error'
import type { ComponentDef } from './component'
import type { AnyField, Column, Fields, InferFields, TypedArray } from './field'

// A compact binary form of schema data (0087): what networking sends and what saves may use. It is
// byte-aligned and little-endian. Numeric fields read and write their columns directly, so encoding
// a row allocates nothing; object fields (strings, lists, structs, json, handles) go as UTF-8 JSON.

/** A growable little-endian byte buffer. Reuse one: `reset()` keeps its memory. */
export class ByteWriter {
  private buffer: Uint8Array
  private view: DataView
  /** Bytes written. */
  length = 0

  constructor(initial = 1024) {
    this.buffer = new Uint8Array(initial)
    this.view = new DataView(this.buffer.buffer)
  }

  reset(): void {
    this.length = 0
  }

  private reserve(bytes: number): void {
    const need = this.length + bytes
    if (need <= this.buffer.length) return
    let size = this.buffer.length * 2
    while (size < need) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number): void {
    this.reserve(1)
    this.buffer[this.length++] = v
  }

  u16(v: number): void {
    this.reserve(2)
    this.view.setUint16(this.length, v, true)
    this.length += 2
  }

  u32(v: number): void {
    this.reserve(4)
    this.view.setUint32(this.length, v, true)
    this.length += 4
  }

  i8(v: number): void {
    this.reserve(1)
    this.view.setInt8(this.length++, v)
  }

  i16(v: number): void {
    this.reserve(2)
    this.view.setInt16(this.length, v, true)
    this.length += 2
  }

  f32(v: number): void {
    this.reserve(4)
    this.view.setFloat32(this.length, v, true)
    this.length += 4
  }

  f64(v: number): void {
    this.reserve(8)
    this.view.setFloat64(this.length, v, true)
    this.length += 8
  }

  /** An unsigned integer up to 2^53 in 7-bit groups: small values take one byte. */
  varuint(v: number): void {
    this.reserve(8)
    while (v >= 0x80) {
      this.buffer[this.length++] = (v % 0x80) | 0x80
      v = Math.floor(v / 0x80)
    }
    this.buffer[this.length++] = v
  }

  /** A signed integer, zigzag-encoded so small magnitudes stay small. */
  varint(v: number): void {
    this.varuint(v < 0 ? -2 * v - 1 : 2 * v)
  }

  bytes(data: Uint8Array): void {
    this.reserve(data.length)
    this.buffer.set(data, this.length)
    this.length += data.length
  }

  /** A varuint byte length, then UTF-8. */
  string(s: string): void {
    this.reserve(s.length * 3 + 8)
    const lengthAt = this.length
    // Reserve the length prefix at its largest size for this string, then write the bytes.
    const prefix = varuintSize(s.length * 3)
    this.length += prefix
    const start = this.length
    this.length = writeUtf8(s, this.buffer, start)
    const bytes = this.length - start
    let at = lengthAt
    let v = bytes
    for (let i = 0; i < prefix - 1; i++) {
      this.buffer[at++] = (v % 0x80) | 0x80
      v = Math.floor(v / 0x80)
    }
    this.buffer[at] = v
  }

  /** Overwrites a u32 written earlier (a count only known after the items). */
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v, true)
  }

  /** The written bytes: a view into this writer's memory, valid until the next write or reset. */
  finish(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }
}

/** Reads what a `ByteWriter` wrote. Reading past the end throws `schema/binary-truncated`. */
export class ByteReader {
  private data: Uint8Array = new Uint8Array(0)
  private view = new DataView(this.data.buffer)
  offset = 0

  constructor(bytes?: Uint8Array) {
    if (bytes) this.reset(bytes)
  }

  reset(bytes: Uint8Array): void {
    this.data = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = 0
  }

  get remaining(): number {
    return this.data.length - this.offset
  }

  private need(n: number): void {
    if (this.offset + n > this.data.length) {
      throw new ShardError('schema/binary-truncated', 'Binary data ended early', {
        hint: 'The data was cut short, or written by a different schema.',
      })
    }
  }

  u8(): number {
    this.need(1)
    return this.data[this.offset++]!
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  i8(): number {
    this.need(1)
    return this.view.getInt8(this.offset++)
  }

  i16(): number {
    this.need(2)
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  f32(): number {
    this.need(4)
    const v = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return v
  }

  f64(): number {
    this.need(8)
    const v = this.view.getFloat64(this.offset, true)
    this.offset += 8
    return v
  }

  varuint(): number {
    let v = 0
    let scale = 1
    for (;;) {
      const b = this.u8()
      v += (b & 0x7f) * scale
      if (b < 0x80) return v
      scale *= 0x80
    }
  }

  varint(): number {
    const v = this.varuint()
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2
  }

  /** A view of the next `n` bytes (not a copy). */
  bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.data.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  string(): string {
    const n = this.varuint()
    this.need(n)
    const s = readUtf8(this.data, this.offset, this.offset + n)
    this.offset += n
    return s
  }
}

function varuintSize(v: number): number {
  let n = 1
  while (v >= 0x80) {
    v = Math.floor(v / 0x80)
    n++
  }
  return n
}

// core has no DOM or Node types, so no TextEncoder: UTF-8 by hand.
function writeUtf8(s: string, out: Uint8Array, at: number): number {
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out[at++] = c
    else if (c < 0x800) {
      out[at++] = 0xc0 | (c >> 6)
      out[at++] = 0x80 | (c & 0x3f)
    } else if (c < 0x10000) {
      out[at++] = 0xe0 | (c >> 12)
      out[at++] = 0x80 | ((c >> 6) & 0x3f)
      out[at++] = 0x80 | (c & 0x3f)
    } else {
      out[at++] = 0xf0 | (c >> 18)
      out[at++] = 0x80 | ((c >> 12) & 0x3f)
      out[at++] = 0x80 | ((c >> 6) & 0x3f)
      out[at++] = 0x80 | (c & 0x3f)
    }
  }
  return at
}

function readUtf8(bytes: Uint8Array, start: number, end: number): string {
  let s = ''
  let i = start
  while (i < end) {
    const b = bytes[i++]!
    let c: number
    if (b < 0x80) c = b
    else if (b < 0xe0) c = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f)
    else if (b < 0xf0) c = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
    else {
      c =
        ((b & 0x07) << 18) |
        ((bytes[i++]! & 0x3f) << 12) |
        ((bytes[i++]! & 0x3f) << 6) |
        (bytes[i++]! & 0x3f)
    }
    s += String.fromCodePoint(c)
  }
  return s
}

// ---------------------------------------------------------------------------
// Rows

/** Per-field quantization. `step`: floats travel as integer multiples of it (zigzag varints). */
export interface Quantize {
  readonly step?: number
}

/** How entity fields cross the wire: a wire id (0 for null) out, an entity back. */
export interface EntityMapping {
  toWire(entity: Entity): number
  /** `null` for wire id 0; `undefined` when the id isn't known (yet). */
  fromWire(id: number): Entity | null | undefined
}

export interface RowCodecOptions {
  /** By field name. Applies to float fields (and every float of a vector). */
  readonly quantize?: Readonly<Record<string, Quantize>>
  readonly entities?: EntityMapping
}

/** Reads and writes one component's fields as bytes, from table rows or from plain values. */
export interface RowCodec<F extends Fields = Fields> {
  readonly def: ComponentDef<F>
  /** Writes the row's fields. Numeric fields allocate nothing. */
  encodeRow(table: Table, row: number, w: ByteWriter): void
  /**
   * Reads fields into the row (which must have the component) and marks it changed. Returns
   * false if an entity field named an unknown id: it is written as null.
   */
  decodeRow(r: ByteReader, table: Table, row: number): boolean
  encode(value: Readonly<Record<string, unknown>>, w: ByteWriter): void
  /** Returns the value, or undefined if an entity field named an unknown id. */
  decode(r: ByteReader): InferFields<F> | undefined
}

const QUAT_SCALE = 32767 / Math.SQRT1_2

interface Plan {
  readonly name: string
  readonly field: AnyField
  readonly storage: string
  readonly stride: number
  readonly kind: string
  readonly step: number
}

/** A codec for a component or schema (`defineSchema`). Create once and reuse. */
export function createRowCodec<F extends Fields>(
  def: ComponentDef<F>,
  options: RowCodecOptions = {},
): RowCodec<F> {
  const plans: Plan[] = def.layout.map((c) => {
    const step = options.quantize?.[c.name]?.step ?? 0
    if (step < 0 || !Number.isFinite(step)) {
      throw new ShardError('schema/invalid-quantize', `Quantize step for ${def.name}.${c.name}`, {
        hint: 'Use a positive step, such as 0.01.',
      })
    }
    return {
      name: c.name,
      field: c.field,
      storage: c.storage,
      stride: c.stride,
      kind: c.field.kind,
      step,
    }
  })
  const entities = options.entities
  // Scratch for decoding a value: one row per field, reused across calls.
  const scratch: Column[] = plans.map((p) =>
    p.storage === 'object' ? [undefined] : makeScratch(p.storage, p.stride),
  )
  let unresolved = false

  function writeColumn(p: Plan, column: Column, row: number, w: ByteWriter): void {
    if (p.storage === 'object') {
      const value = (column as unknown[])[row]
      w.string(value === undefined ? '' : JSON.stringify(p.field.toJson(value)))
      return
    }
    const c = column as TypedArray
    const base = row * p.stride
    if (p.kind === 'entity') {
      const e = c[base]!
      // Without a mapping the wire id is the entity plus one, so 0 stays null.
      if (e < 0) w.varuint(0)
      else w.varuint(entities ? entities.toWire(e) : e + 1)
      return
    }
    if (p.kind === 'quat') {
      writeQuat(c, base, w)
      return
    }
    for (let i = 0; i < p.stride; i++) writeNumber(p, c[base + i]!, w)
  }

  function readColumn(p: Plan, column: Column, row: number, r: ByteReader): void {
    if (p.storage === 'object') {
      const text = r.string()
      const value = text === '' ? p.field.defaultValue() : p.field.fromJson(JSON.parse(text), {})
      p.field.write(column, row, value)
      return
    }
    const c = column as TypedArray
    const base = row * p.stride
    if (p.kind === 'entity') {
      const id = r.varuint()
      let e: Entity | null | undefined
      if (entities) e = entities.fromWire(id)
      else e = id === 0 ? null : id - 1
      if (e === undefined) {
        unresolved = true
        e = null
      }
      c[base] = e ?? -1
      return
    }
    if (p.kind === 'quat') {
      readQuat(c, base, r)
      return
    }
    for (let i = 0; i < p.stride; i++) c[base + i] = readNumber(p, r)
  }

  return {
    def,
    encodeRow(table, row, w) {
      const storage = table.storage(def as ComponentDef)
      if (!storage) throw missing(def.name)
      for (let i = 0; i < plans.length; i++) writeColumn(plans[i]!, storage.columns[i]!, row, w)
    },
    decodeRow(r, table, row) {
      const storage = table.storage(def as ComponentDef)
      if (!storage) throw missing(def.name)
      unresolved = false
      for (let i = 0; i < plans.length; i++) readColumn(plans[i]!, storage.columns[i]!, row, r)
      table.markChanged(def as ComponentDef, row)
      return !unresolved
    },
    encode(value, w) {
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i]!
        const v = value[p.name]
        p.field.write(scratch[i]!, 0, v === undefined ? p.field.defaultValue() : v)
        writeColumn(p, scratch[i]!, 0, w)
      }
    },
    decode(r) {
      unresolved = false
      const out: Record<string, unknown> = {}
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i]!
        readColumn(p, scratch[i]!, 0, r)
        out[p.name] = p.field.read(scratch[i]!, 0)
      }
      return unresolved ? undefined : (out as InferFields<F>)
    },
  }
}

function makeScratch(storage: string, stride: number): TypedArray {
  switch (storage) {
    case 'f32':
      return new Float32Array(stride)
    case 'f64':
      return new Float64Array(stride)
    case 'i8':
      return new Int8Array(stride)
    case 'i16':
      return new Int16Array(stride)
    case 'i32':
      return new Int32Array(stride)
    case 'u8':
      return new Uint8Array(stride)
    case 'u16':
      return new Uint16Array(stride)
    default:
      return new Uint32Array(stride)
  }
}

function writeNumber(p: Plan, v: number, w: ByteWriter): void {
  switch (p.storage) {
    case 'f32':
    case 'f64':
      if (p.step > 0) w.varint(Math.round(v / p.step))
      else if (p.storage === 'f32') w.f32(v)
      else w.f64(v)
      return
    case 'u8':
      w.u8(v)
      return
    case 'i8':
      w.i8(v)
      return
    case 'u16':
    case 'u32':
      w.varuint(v)
      return
    default:
      w.varint(v)
  }
}

function readNumber(p: Plan, r: ByteReader): number {
  switch (p.storage) {
    case 'f32':
    case 'f64':
      if (p.step > 0) return r.varint() * p.step
      return p.storage === 'f32' ? r.f32() : r.f64()
    case 'u8':
      return r.u8()
    case 'i8':
      return r.i8()
    case 'u16':
    case 'u32':
      return r.varuint()
    default:
      return r.varint()
  }
}

/** Smallest three: the largest component's index, then the other three as i16. 7 bytes. */
function writeQuat(c: TypedArray, base: number, w: ByteWriter): void {
  let largest = 0
  let max = -1
  for (let i = 0; i < 4; i++) {
    const a = Math.abs(c[base + i]!)
    if (a > max) {
      max = a
      largest = i
    }
  }
  const sign = c[base + largest]! < 0 ? -1 : 1
  w.u8(largest)
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue
    // The other three are within ±1/√2 of a unit quaternion.
    w.i16(Math.round(Math.max(-32767, Math.min(32767, c[base + i]! * sign * QUAT_SCALE))))
  }
}

function readQuat(c: TypedArray, base: number, r: ByteReader): void {
  const largest = r.u8() & 3
  let sum = 0
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue
    const v = r.i16() / QUAT_SCALE
    c[base + i] = v
    sum += v * v
  }
  c[base + largest] = Math.sqrt(Math.max(0, 1 - sum))
}

function missing(name: string): ShardError {
  return new ShardError('schema/binary-missing-component', `The row has no ${name}`, {
    hint: 'Add the component before decoding into the row.',
  })
}
