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
  /** xyzw per vertex: tangent direction plus handedness in w (glTF / MikkTSpace). */
  tangents?: Float32Array
  /** Second uv set, per vertex. */
  uvs1?: Float32Array
  /** Four joint indices per vertex (skinning). */
  joints?: Uint16Array
  /** Four joint weights per vertex, summing to 1 (skinning). */
  weights?: Float32Array
  indices?: Uint16Array | Uint32Array
}

export const MESH_ATTRIBUTES = [
  'normals',
  'uvs',
  'colors',
  'tangents',
  'uvs1',
  'joints',
  'weights',
] as const
export type MeshAttribute = (typeof MESH_ATTRIBUTES)[number]
export const MESH_ATTRIBUTE_WIDTH: Record<MeshAttribute, number> = {
  normals: 3,
  uvs: 2,
  colors: 4,
  tangents: 4,
  uvs1: 2,
  joints: 4,
  weights: 4,
}

/**
 * Geometry on the CPU: separate attribute arrays plus optional indices. The renderer uploads it
 * once per version; replace a mesh's data with `update` and the version bumps.
 */
export class Mesh {
  positions!: Float32Array
  normals: Float32Array | undefined
  uvs: Float32Array | undefined
  colors: Float32Array | undefined
  tangents: Float32Array | undefined
  uvs1: Float32Array | undefined
  joints: Uint16Array | undefined
  weights: Float32Array | undefined
  indices: Uint16Array | Uint32Array | undefined
  /** Local-space bounds: `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly bounds = aabb.create()
  /** Increments on `update`, so GPU copies know to re-upload. */
  version = 0

  private constructor(data: MeshData) {
    this.assign(data)
  }

  static create(data: MeshData): Mesh {
    return new Mesh(data)
  }

  /**
   * A mesh from data already validated (artifacts the importer checked): attribute lengths are
   * still checked, but the per-index range scan is skipped, which dominates load time for big meshes.
   */
  static trusted(data: MeshData): Mesh {
    Mesh.skipIndexCheck = true
    try {
      return new Mesh(data)
    } finally {
      Mesh.skipIndexCheck = false
    }
  }

  private static skipIndexCheck = false

  get vertexCount(): number {
    return this.positions.length / 3
  }

  /** Vertices drawn: the index count, or the vertex count for non-indexed meshes. */
  get drawCount(): number {
    return this.indices ? this.indices.length : this.vertexCount
  }

  update(data: MeshData): void {
    this.assign(data)
    this.version++
  }

  private assign(data: MeshData): void {
    this.positions = data.positions
    this.normals = data.normals
    this.uvs = data.uvs
    this.colors = data.colors
    this.tangents = data.tangents
    this.uvs1 = data.uvs1
    this.joints = data.joints
    this.weights = data.weights
    this.indices = data.indices
    this.validate()
  }

  /** The mesh's data as plain arrays (shared, not copied). */
  data(): MeshData {
    const out: MeshData = { positions: this.positions }
    for (const a of MESH_ATTRIBUTES)
      if (this[a]) (out as unknown as Record<string, unknown>)[a] = this[a]
    if (this.indices) out.indices = this.indices
    return out
  }

  private validate(): void {
    const n = this.positions.length / 3
    const bad = (what: string) =>
      new ShardError('mesh/invalid', `Mesh ${what}`, {
        hint: 'positions/normals: 3 per vertex, uvs/uvs1: 2, colors/tangents/joints/weights: 4; indices must be < vertex count.',
      })
    if (!Number.isInteger(n) || n === 0)
      throw bad(`has ${this.positions.length} position floats (need a multiple of 3, > 0)`)
    for (const a of MESH_ATTRIBUTES) {
      const arr = this[a]
      if (arr && arr.length !== n * MESH_ATTRIBUTE_WIDTH[a])
        throw bad(`has ${arr.length / MESH_ATTRIBUTE_WIDTH[a]} ${a} for ${n} vertices`)
    }
    if (this.indices) {
      if (this.indices.length % 3 !== 0)
        throw bad(`has ${this.indices.length} indices (need triangles)`)
      for (let i = 0; !Mesh.skipIndexCheck && i < this.indices.length; i++) {
        if (this.indices[i]! >= n)
          throw bad(`index ${this.indices[i]} is out of range (${n} vertices)`)
      }
    }
    aabb.fromPoints(this.bounds, this.positions)
  }
}
