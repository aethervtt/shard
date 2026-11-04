import { ShardError } from '@aethervtt/shard-core'
import type { MeshData } from '@aethervtt/shard-mesh'
import type { GltfAccessor, GltfDocument, GltfMaterial, GltfNode, TextureInfo } from './document'

/** An image embedded as is: the bytes of a PNG or JPEG file. */
export interface GlbImage {
  bytes: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
}

/** A glTF metallic-roughness material. Factors are linear; textures are embedded. */
export interface GlbMaterial {
  name?: string
  baseColorFactor?: readonly number[]
  metallicFactor?: number
  roughnessFactor?: number
  baseColorTexture?: GlbImage
  metallicRoughnessTexture?: GlbImage
  normalTexture?: GlbImage
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
  alphaCutoff?: number
  doubleSided?: boolean
}

export interface GlbPrimitive {
  mesh: MeshData
  /** An index into `GlbScene.materials`. */
  material?: number
}

/** A root node holding one mesh of one or more primitives. */
export interface GlbNode {
  name: string
  primitives: GlbPrimitive[]
}

export interface GlbScene {
  nodes: GlbNode[]
  materials?: GlbMaterial[]
}

const FLOAT = 5126
const UNSIGNED_SHORT = 5123
const UNSIGNED_INT = 5125
const ARRAY_BUFFER = 34962
const ELEMENT_ARRAY_BUFFER = 34963
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const GLB_MAGIC = 0x46546c67

/**
 * A scene as a binary glTF 2.0 file (spec 0095): one buffer, every attribute in its own
 * buffer view, textures embedded with a repeating, mipmapped sampler. To export levels of detail,
 * name nodes `<name>_LOD0`, `<name>_LOD1`, …: the importer's `lods: 'auto'` (and most engines)
 * read that as one LOD chain.
 */
export function writeGlb(scene: GlbScene): Uint8Array {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const doc: GltfDocument & Required<Pick<GltfDocument, 'accessors' | 'bufferViews' | 'meshes'>> = {
    asset: { version: '2.0', generator: 'Shard' } as GltfDocument['asset'],
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
  }

  const view = (bytes: Uint8Array, target?: number): number => {
    const pad = (4 - (byteLength % 4)) % 4
    if (pad) {
      chunks.push(new Uint8Array(pad))
      byteLength += pad
    }
    const entry: { buffer: number; byteOffset: number; byteLength: number; target?: number } = {
      buffer: 0,
      byteOffset: byteLength,
      byteLength: bytes.byteLength,
    }
    if (target !== undefined) entry.target = target
    chunks.push(bytes)
    byteLength += bytes.byteLength
    doc.bufferViews.push(entry)
    return doc.bufferViews.length - 1
  }
  const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  const accessor = (
    data: Float32Array | Uint16Array | Uint32Array,
    type: GltfAccessor['type'],
    width: number,
    target: number,
    bounds = false,
  ): number => {
    const acc: GltfAccessor & { min?: number[]; max?: number[] } = {
      bufferView: view(bytesOf(data), target),
      componentType:
        data instanceof Float32Array
          ? FLOAT
          : data instanceof Uint16Array
            ? UNSIGNED_SHORT
            : UNSIGNED_INT,
      count: data.length / width,
      type,
    }
    if (bounds) {
      const min = new Array<number>(width).fill(Number.POSITIVE_INFINITY)
      const max = new Array<number>(width).fill(Number.NEGATIVE_INFINITY)
      for (let i = 0; i < data.length; i++) {
        const c = i % width
        if (data[i]! < min[c]!) min[c] = data[i]!
        if (data[i]! > max[c]!) max[c] = data[i]!
      }
      acc.min = min
      acc.max = max
    }
    doc.accessors.push(acc)
    return doc.accessors.length - 1
  }

  // Textures: one per distinct image, sharing one sampler.
  const images = new Map<Uint8Array, number>()
  const texture = (image: GlbImage | undefined): TextureInfo | undefined => {
    if (!image) return undefined
    let index = images.get(image.bytes)
    if (index === undefined) {
      doc.images ??= []
      doc.textures ??= []
      doc.samplers ??= [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
      doc.images.push({ bufferView: view(image.bytes), mimeType: image.mimeType })
      doc.textures.push({ source: doc.images.length - 1, sampler: 0 })
      index = doc.textures.length - 1
      images.set(image.bytes, index)
    }
    return { index }
  }
  if (scene.materials?.length) {
    doc.materials = scene.materials.map((m) => {
      const out: GltfMaterial = { pbrMetallicRoughness: {} }
      const pbr = out.pbrMetallicRoughness!
      if (m.name) out.name = m.name
      if (m.baseColorFactor) pbr.baseColorFactor = [...m.baseColorFactor]
      if (m.metallicFactor !== undefined) pbr.metallicFactor = m.metallicFactor
      if (m.roughnessFactor !== undefined) pbr.roughnessFactor = m.roughnessFactor
      const base = texture(m.baseColorTexture)
      if (base) pbr.baseColorTexture = base
      const mr = texture(m.metallicRoughnessTexture)
      if (mr) pbr.metallicRoughnessTexture = mr
      const normal = texture(m.normalTexture)
      if (normal) out.normalTexture = normal
      if (m.alphaMode && m.alphaMode !== 'OPAQUE') out.alphaMode = m.alphaMode
      if (m.alphaMode === 'MASK' && m.alphaCutoff !== undefined) out.alphaCutoff = m.alphaCutoff
      if (m.doubleSided) out.doubleSided = true
      return out
    })
  }

  for (const node of scene.nodes) {
    const primitives = node.primitives.map((p, i) => {
      const m = p.mesh
      const vertices = m.positions.length / 3
      const where = `${node.name}, primitive ${i}`
      const check = (name: string, array: ArrayLike<number> | undefined, width: number) => {
        if (array && array.length !== vertices * width) {
          throw new ShardError('gltf/write-invalid', `${where}: ${name} has the wrong length`, {
            hint: `${name} needs ${width} values per vertex (${vertices} vertices).`,
          })
        }
      }
      check('normals', m.normals, 3)
      check('uvs', m.uvs, 2)
      check('uvs1', m.uvs1, 2)
      check('tangents', m.tangents, 4)
      check('colors', m.colors, 4)
      const attributes: Record<string, number> = {
        POSITION: accessor(m.positions, 'VEC3', 3, ARRAY_BUFFER, true),
      }
      if (m.normals) attributes.NORMAL = accessor(m.normals, 'VEC3', 3, ARRAY_BUFFER)
      if (m.tangents) attributes.TANGENT = accessor(m.tangents, 'VEC4', 4, ARRAY_BUFFER)
      if (m.uvs) attributes.TEXCOORD_0 = accessor(m.uvs, 'VEC2', 2, ARRAY_BUFFER)
      if (m.uvs1) attributes.TEXCOORD_1 = accessor(m.uvs1, 'VEC2', 2, ARRAY_BUFFER)
      if (m.colors) attributes.COLOR_0 = accessor(m.colors, 'VEC4', 4, ARRAY_BUFFER)
      const out: { attributes: Record<string, number>; indices?: number; material?: number } = {
        attributes,
      }
      if (m.indices) {
        // 16-bit indices when every vertex fits.
        const indices =
          m.indices instanceof Uint32Array && vertices <= 0xffff
            ? Uint16Array.from(m.indices)
            : m.indices
        out.indices = accessor(indices, 'SCALAR', 1, ELEMENT_ARRAY_BUFFER)
      }
      if (p.material !== undefined) out.material = p.material
      return out
    })
    doc.meshes.push({ name: node.name, primitives })
    const n: GltfNode = { name: node.name, mesh: doc.meshes.length - 1 }
    doc.nodes!.push(n)
    doc.scenes![0]!.nodes!.push(doc.nodes!.length - 1)
  }

  if (byteLength > 0) doc.buffers = [{ byteLength }]
  const json = new TextEncoder().encode(JSON.stringify(doc))
  const jsonPadded = (json.byteLength + 3) & ~3
  const binPadded = (byteLength + 3) & ~3
  const total = 12 + 8 + jsonPadded + (byteLength > 0 ? 8 + binPadded : 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, GLB_MAGIC, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonPadded, true)
  dv.setUint32(16, JSON_CHUNK, true)
  out.set(json, 20)
  out.fill(0x20, 20 + json.byteLength, 20 + jsonPadded)
  if (byteLength > 0) {
    let at = 20 + jsonPadded
    dv.setUint32(at, binPadded, true)
    dv.setUint32(at + 4, BIN_CHUNK, true)
    at += 8
    for (const c of chunks) {
      out.set(c, at)
      at += c.byteLength
    }
  }
  return out
}
