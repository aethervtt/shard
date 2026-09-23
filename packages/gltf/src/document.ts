import { ShardError } from '@shard/core'

/** The parts of the glTF 2.0 JSON the importer reads. */
export interface GltfDocument {
  asset: { version: string }
  scene?: number
  scenes?: { name?: string; nodes?: number[] }[]
  nodes?: GltfNode[]
  meshes?: { name?: string; primitives: GltfPrimitive[] }[]
  materials?: GltfMaterial[]
  accessors?: GltfAccessor[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[]
  buffers?: { uri?: string; byteLength: number }[]
  cameras?: {
    type: 'perspective' | 'orthographic'
    perspective?: { yfov: number; znear: number; zfar?: number }
    orthographic?: { xmag: number; ymag: number; znear: number; zfar: number }
  }[]
  skins?: { name?: string; joints: number[]; inverseBindMatrices?: number; skeleton?: number }[]
  animations?: {
    name?: string
    channels: { sampler: number; target: { node?: number; path: string } }[]
    samplers: { input: number; output: number; interpolation?: string }[]
  }[]
  textures?: { source?: number; sampler?: number; extensions?: Record<string, unknown> }[]
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[]
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[]
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  extensions?: Record<string, unknown>
}

export interface GltfNode {
  name?: string
  children?: number[]
  mesh?: number
  camera?: number
  skin?: number
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  extensions?: Record<string, unknown>
  extras?: unknown
}

export interface GltfPrimitive {
  attributes: Record<string, number>
  indices?: number
  material?: number
  mode?: number
  targets?: unknown[]
}

export interface TextureInfo {
  index: number
  texCoord?: number
  scale?: number
  strength?: number
  extensions?: Record<string, unknown>
}

export interface GltfMaterial {
  name?: string
  pbrMetallicRoughness?: {
    baseColorFactor?: number[]
    metallicFactor?: number
    roughnessFactor?: number
    baseColorTexture?: TextureInfo
    metallicRoughnessTexture?: TextureInfo
  }
  normalTexture?: TextureInfo
  occlusionTexture?: TextureInfo
  emissiveTexture?: TextureInfo
  emissiveFactor?: number[]
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
  alphaCutoff?: number
  doubleSided?: boolean
  extensions?: Record<string, unknown>
}

export interface GltfAccessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  normalized?: boolean
  count: number
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4'
  sparse?: {
    count: number
    indices: { bufferView: number; byteOffset?: number; componentType: number }
    values: { bufferView: number; byteOffset?: number }
  }
}

export interface ParsedGltf {
  json: GltfDocument
  /** The GLB binary chunk, if the file is a .glb. */
  bin: Uint8Array | undefined
}

const GLB_MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** Reads a .glb container or .gltf JSON. */
export function parseGltf(bytes: Uint8Array): ParsedGltf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let json: unknown
  let bin: Uint8Array | undefined
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    const version = view.getUint32(4, true)
    if (version !== 2) {
      throw new ShardError('gltf/invalid', `GLB version ${version} isn't supported (need 2)`, {
        path: '',
      })
    }
    const length = Math.min(view.getUint32(8, true), bytes.byteLength)
    let offset = 12
    while (offset + 8 <= length) {
      const chunkLength = view.getUint32(offset, true)
      const type = view.getUint32(offset + 4, true)
      const data = bytes.subarray(offset + 8, offset + 8 + chunkLength)
      if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data))
      else if (type === CHUNK_BIN && !bin) bin = data
      offset += 8 + chunkLength
    }
    if (json === undefined)
      throw new ShardError('gltf/invalid', 'GLB has no JSON chunk', { path: '' })
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes))
    } catch (cause) {
      throw new ShardError('gltf/invalid', 'Not a .glb and not valid glTF JSON', {
        path: '',
        cause,
      })
    }
  }
  const doc = json as GltfDocument
  if (!doc?.asset || typeof doc.asset.version !== 'string' || !doc.asset.version.startsWith('2')) {
    throw new ShardError('gltf/invalid', 'Missing asset.version "2.x"', {
      path: '/asset/version',
      hint: 'Only glTF 2.0 files are supported.',
    })
  }
  return { json: doc, bin }
}
