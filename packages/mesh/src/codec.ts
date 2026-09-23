import { ShardError } from '@shard/core'
import { MESH_ATTRIBUTE_WIDTH, MESH_ATTRIBUTES, Mesh, type MeshData } from './mesh'

/**
 * Binary mesh artifacts: a 32-byte header, then every present array, each starting on a 4-byte
 * boundary, little-endian.
 *
 *   0  magic "SHMS"      4  version (1)      8  vertex count     12  index count
 *  16  index type (0 none, 16, 32)          20  attribute mask (bit i = MESH_ATTRIBUTES[i])
 *  24  reserved         28  reserved
 *
 * Order: positions, then attributes in MESH_ATTRIBUTES order, then indices.
 */
const MAGIC = 0x534d4853 // "SHMS" little-endian
const VERSION = 1
const HEADER = 32

const align4 = (n: number) => (n + 3) & ~3

export function encodeMesh(data: MeshData | Mesh): Uint8Array {
  const d = data instanceof Mesh ? data.data() : data
  const vertices = d.positions.length / 3
  const arrays: ArrayBufferView[] = [d.positions]
  let mask = 0
  MESH_ATTRIBUTES.forEach((a, i) => {
    const arr = d[a]
    if (arr) {
      mask |= 1 << i
      arrays.push(arr)
    }
  })
  const indexType = !d.indices ? 0 : d.indices instanceof Uint16Array ? 16 : 32
  if (d.indices) arrays.push(d.indices)
  let size = HEADER
  for (const a of arrays) size += align4(a.byteLength)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, VERSION, true)
  view.setUint32(8, vertices, true)
  view.setUint32(12, d.indices?.length ?? 0, true)
  view.setUint32(16, indexType, true)
  view.setUint32(20, mask, true)
  let offset = HEADER
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset)
    offset += align4(a.byteLength)
  }
  return out
}

/** Decodes a mesh artifact. Arrays are views over `bytes` (copied only if misaligned). */
export function decodeMesh(bytes: Uint8Array): Mesh {
  if (bytes.byteOffset % 4 !== 0) bytes = bytes.slice()
  if (bytes.byteLength < HEADER) throw invalid('is shorter than its header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) throw invalid('has the wrong magic number')
  const version = view.getUint32(4, true)
  if (version !== VERSION) throw invalid(`has version ${version}; this engine reads ${VERSION}`)
  const vertices = view.getUint32(8, true)
  const indexCount = view.getUint32(12, true)
  const indexType = view.getUint32(16, true)
  const mask = view.getUint32(20, true)
  let offset = bytes.byteOffset + HEADER
  const end = bytes.byteOffset + bytes.byteLength
  const take = <T>(
    ctor: { new (b: ArrayBufferLike, o: number, n: number): T; BYTES_PER_ELEMENT: number },
    n: number,
  ): T => {
    const byteLength = n * ctor.BYTES_PER_ELEMENT
    if (offset + byteLength > end) throw invalid('is truncated')
    const arr = new ctor(bytes.buffer, offset, n)
    offset += align4(byteLength)
    return arr
  }
  const data: MeshData = { positions: take(Float32Array, vertices * 3) }
  MESH_ATTRIBUTES.forEach((a, i) => {
    if (!(mask & (1 << i))) return
    const n = vertices * MESH_ATTRIBUTE_WIDTH[a]
    ;(data as unknown as Record<string, unknown>)[a] =
      a === 'joints' ? take(Uint16Array, n) : take(Float32Array, n)
  })
  if (indexType === 16) data.indices = take(Uint16Array, indexCount)
  else if (indexType === 32) data.indices = take(Uint32Array, indexCount)
  // The importer validated this mesh when it wrote the artifact.
  return Mesh.trusted(data)
}

function invalid(what: string): ShardError {
  return new ShardError('mesh/invalid-artifact', `Mesh artifact ${what}`, {
    hint: 'Re-import the source (`shard import --force`).',
  })
}
