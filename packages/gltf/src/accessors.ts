import { ShardError } from '@shard/core'
import type { GltfAccessor, GltfDocument } from './document'

const COMPONENTS: Record<GltfAccessor['type'], number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

/** Reads a component of `type` at `offset`; normalized integers become floats in [-1, 1] or [0, 1]. */
function reader(view: DataView, type: number, normalized: boolean): (offset: number) => number {
  switch (type) {
    case 5120:
      return normalized ? (o) => Math.max(view.getInt8(o) / 127, -1) : (o) => view.getInt8(o)
    case 5121:
      return normalized ? (o) => view.getUint8(o) / 255 : (o) => view.getUint8(o)
    case 5122:
      return normalized
        ? (o) => Math.max(view.getInt16(o, true) / 32767, -1)
        : (o) => view.getInt16(o, true)
    case 5123:
      return normalized ? (o) => view.getUint16(o, true) / 65535 : (o) => view.getUint16(o, true)
    case 5125:
      return (o) => view.getUint32(o, true)
    case 5126:
      return (o) => view.getFloat32(o, true)
    default:
      throw new ShardError('gltf/invalid', `Unknown component type ${type}`)
  }
}

export interface AccessorData {
  values: Float64Array
  count: number
  components: number
}

/**
 * Decodes accessors into flat arrays, handling strides, normalization, and sparse storage. `buffer`
 * returns a buffer's bytes (resolved by the importer: GLB chunk, data URI, or external file).
 */
export class Accessors {
  private readonly doc: GltfDocument
  private readonly buffers: Uint8Array[]
  private readonly cache = new Map<number, AccessorData>()

  constructor(doc: GltfDocument, buffers: Uint8Array[]) {
    this.doc = doc
    this.buffers = buffers
  }

  /** Accessor `index` as doubles (exact for every glTF component type). */
  read(index: number): AccessorData {
    const cached = this.cache.get(index)
    if (cached) return cached
    const acc = this.doc.accessors?.[index]
    const ptr = `/accessors/${index}`
    if (!acc) throw new ShardError('gltf/invalid', `No accessor ${index}`, { path: ptr })
    const components = COMPONENTS[acc.type]
    const size = SIZES[acc.componentType]
    if (!components || !size) {
      throw new ShardError('gltf/invalid', `Accessor ${index} has an unknown type`, { path: ptr })
    }
    const values = new Float64Array(acc.count * components)
    if (acc.bufferView !== undefined) {
      const { view, stride, base } = this.viewOf(
        acc.bufferView,
        acc.byteOffset ?? 0,
        components * size,
        ptr,
      )
      const needed = base + (acc.count - 1) * stride + components * size
      if (acc.count > 0 && needed > view.byteLength) {
        throw new ShardError(
          'gltf/accessor-out-of-range',
          `Accessor ${index} reads past the end of buffer view ${acc.bufferView}`,
          { path: ptr, hint: 'The file is truncated or its byteOffset/count are wrong.' },
        )
      }
      const read = reader(view, acc.componentType, acc.normalized ?? false)
      for (let i = 0; i < acc.count; i++) {
        const o = base + i * stride
        for (let c = 0; c < components; c++) values[i * components + c] = read(o + c * size)
      }
    }
    if (acc.sparse) {
      const s = acc.sparse
      const idx = this.viewOf(
        s.indices.bufferView,
        s.indices.byteOffset ?? 0,
        SIZES[s.indices.componentType]!,
        `${ptr}/sparse/indices`,
      )
      const val = this.viewOf(
        s.values.bufferView,
        s.values.byteOffset ?? 0,
        components * size,
        `${ptr}/sparse/values`,
      )
      const readIndex = reader(idx.view, s.indices.componentType, false)
      const readValue = reader(val.view, acc.componentType, acc.normalized ?? false)
      const indexSize = SIZES[s.indices.componentType]!
      for (let i = 0; i < s.count; i++) {
        const target = readIndex(idx.base + i * indexSize)
        if (target >= acc.count) {
          throw new ShardError(
            'gltf/accessor-out-of-range',
            `Sparse index ${target} is past accessor ${index}'s count`,
            {
              path: `${ptr}/sparse`,
            },
          )
        }
        for (let c = 0; c < components; c++) {
          values[target * components + c] = readValue(val.base + (i * components + c) * size)
        }
      }
    }
    const data = { values, count: acc.count, components }
    this.cache.set(index, data)
    return data
  }

  floats(index: number): Float32Array {
    return Float32Array.from(this.read(index).values)
  }

  private viewOf(viewIndex: number, byteOffset: number, elementSize: number, ptr: string) {
    const bv = this.doc.bufferViews?.[viewIndex]
    if (!bv) {
      throw new ShardError('gltf/invalid', `No buffer view ${viewIndex}`, { path: ptr })
    }
    const buffer = this.buffers[bv.buffer]
    if (!buffer) {
      throw new ShardError('gltf/buffer-missing', `Buffer ${bv.buffer} couldn't be loaded`, {
        path: `/buffers/${bv.buffer}`,
      })
    }
    const start = bv.byteOffset ?? 0
    if (start + bv.byteLength > buffer.byteLength) {
      throw new ShardError(
        'gltf/accessor-out-of-range',
        `Buffer view ${viewIndex} is past the end of buffer ${bv.buffer}`,
        { path: `/bufferViews/${viewIndex}` },
      )
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset + start, bv.byteLength)
    return { view, stride: bv.byteStride ?? elementSize, base: byteOffset }
  }
}
