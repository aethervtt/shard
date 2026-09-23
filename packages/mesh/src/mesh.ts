import { aabb, ShardError } from '@shard/core'

export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array
  /** xyz per vertex, unit length. */
  normals?: Float32Array
  /** uv per vertex. */
  uvs?: Float32Array
  /** rgba per vertex, linear. */
  colors?: Float32Array
  indices?: Uint16Array | Uint32Array
}

/**
 * Geometry on the CPU: separate attribute arrays plus optional indices. The renderer uploads it
 * once per version; replace a mesh's data with `update` and the version bumps.
 */
export class Mesh {
  positions: Float32Array
  normals: Float32Array | undefined
  uvs: Float32Array | undefined
  colors: Float32Array | undefined
  indices: Uint16Array | Uint32Array | undefined
  /** Local-space bounds: `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly bounds = aabb.create()
  /** Increments on `update`, so GPU copies know to re-upload. */
  version = 0

  private constructor(data: MeshData) {
    this.positions = data.positions
    this.normals = data.normals
    this.uvs = data.uvs
    this.colors = data.colors
    this.indices = data.indices
    this.validate()
  }

  static create(data: MeshData): Mesh {
    return new Mesh(data)
  }

  get vertexCount(): number {
    return this.positions.length / 3
  }

  /** Vertices drawn: the index count, or the vertex count for non-indexed meshes. */
  get drawCount(): number {
    return this.indices ? this.indices.length : this.vertexCount
  }

  update(data: MeshData): void {
    this.positions = data.positions
    this.normals = data.normals
    this.uvs = data.uvs
    this.colors = data.colors
    this.indices = data.indices
    this.validate()
    this.version++
  }

  private validate(): void {
    const n = this.positions.length / 3
    const bad = (what: string) =>
      new ShardError('mesh/invalid', `Mesh ${what}`, {
        hint: 'positions/normals: 3 floats per vertex, uvs: 2, colors: 4; indices must be < vertex count.',
      })
    if (!Number.isInteger(n) || n === 0)
      throw bad(`has ${this.positions.length} position floats (need a multiple of 3, > 0)`)
    if (this.normals && this.normals.length !== n * 3)
      throw bad(`has ${this.normals.length / 3} normals for ${n} vertices`)
    if (this.uvs && this.uvs.length !== n * 2)
      throw bad(`has ${this.uvs.length / 2} uvs for ${n} vertices`)
    if (this.colors && this.colors.length !== n * 4)
      throw bad(`has ${this.colors.length / 4} colors for ${n} vertices`)
    if (this.indices) {
      if (this.indices.length % 3 !== 0)
        throw bad(`has ${this.indices.length} indices (need triangles)`)
      for (let i = 0; i < this.indices.length; i++) {
        if (this.indices[i]! >= n)
          throw bad(`index ${this.indices[i]} is out of range (${n} vertices)`)
      }
    }
    aabb.fromPoints(this.bounds, this.positions)
  }
}
