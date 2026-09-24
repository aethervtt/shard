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
  /** Morph targets (blend shapes): per-vertex deltas added by `render/MorphWeights`. */
  targets?: MorphTarget[]
}

/** One morph target: deltas from the base mesh, xyz per vertex. */
export interface MorphTarget {
  positions: Float32Array
  normals?: Float32Array
  tangents?: Float32Array
}

/** Morph targets a mesh can blend at once (the vertex stage adds the heaviest ones). */
export const MAX_MORPH_TARGETS = 8

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
  targets: MorphTarget[] | undefined
  /**
   * Local-space bounds: `[minX, minY, minZ, maxX, maxY, maxZ]`. With morph targets, they cover
   * every blend of weights in [0, 1].
   */
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
    this.targets = data.targets?.length ? data.targets : undefined
    this.validate()
  }

  /** The mesh's data as plain arrays (shared, not copied). */
  data(): MeshData {
    const out: MeshData = { positions: this.positions }
    for (const a of MESH_ATTRIBUTES)
      if (this[a]) (out as unknown as Record<string, unknown>)[a] = this[a]
    if (this.indices) out.indices = this.indices
    if (this.targets) out.targets = this.targets
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
    for (const [k, target] of (this.targets ?? []).entries()) {
      for (const a of ['positions', 'normals', 'tangents'] as const) {
        const arr = target[a]
        if (arr && arr.length !== n * 3)
          throw bad(`morph target ${k} has ${arr.length / 3} ${a} for ${n} vertices`)
      }
      if (!target.positions) throw bad(`morph target ${k} has no positions`)
    }
    aabb.fromPoints(this.bounds, this.positions)
    if (this.targets) {
      // Any blend of weights in [0, 1]: each target can push a vertex by at most its own reach.
      const b = this.bounds
      for (const target of this.targets) {
        const d = target.positions
        let lx = 0
        let ly = 0
        let lz = 0
        let hx = 0
        let hy = 0
        let hz = 0
        for (let i = 0; i < d.length; i += 3) {
          lx = Math.min(lx, d[i]!)
          ly = Math.min(ly, d[i + 1]!)
          lz = Math.min(lz, d[i + 2]!)
          hx = Math.max(hx, d[i]!)
          hy = Math.max(hy, d[i + 1]!)
          hz = Math.max(hz, d[i + 2]!)
        }
        b[0] = b[0]! + lx
        b[1] = b[1]! + ly
        b[2] = b[2]! + lz
        b[3] = b[3]! + hx
        b[4] = b[4]! + hy
        b[5] = b[5]! + hz
      }
    }
  }
}
