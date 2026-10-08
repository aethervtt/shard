import { ShardError } from '@aethervtt/shard-core'
import type { MeshData } from './mesh'
import { sinCos } from './trig'

/**
 * A procedural modelling toolkit (spec 0045): append shapes, deform them, and finish into
 * `MeshData`. Data lives in growable TypedArrays (no per-vertex objects), in f64 until `finish`.
 *
 * Deterministic: only +, −, ×, ÷, and sqrt (trig through `sinCos`), so the same calls give the same
 * bytes in every JavaScript engine. That's what generators (0042) need.
 */
export class MeshBuilder {
  /** xyz per vertex. */
  positions: Float64Array = new Float64Array(64 * 3)
  /** xyz per vertex (zero until normals are computed or a shape writes them). */
  normalData: Float64Array = new Float64Array(64 * 3)
  /** uv per vertex. */
  uvData: Float64Array = new Float64Array(64 * 2)
  /** rgba per vertex, or undefined until something sets a color. */
  colorData: Float64Array | undefined
  /** Second uv set per vertex, or undefined until something sets one. */
  uv1Data: Float64Array | undefined
  /** xyzw per vertex, after `tangents()`. */
  tangentData: Float64Array | undefined
  indices: Uint32Array = new Uint32Array(64 * 3)
  vertexCount = 0
  /** Index count (three per triangle). */
  indexCount = 0
  /** Whether `normals` hold real normals for every vertex. */
  private hasNormals = true

  static create(): MeshBuilder {
    return new MeshBuilder()
  }

  /** A builder holding a copy of `mesh`. */
  static from(mesh: MeshData): MeshBuilder {
    return new MeshBuilder().merge(mesh)
  }

  get triangleCount(): number {
    return this.indexCount / 3
  }

  // --- low level ---------------------------------------------------------------------------------

  private reserve(vertices: number, indices: number): void {
    const v = this.vertexCount + vertices
    if (v * 3 > this.positions.length) {
      const cap = Math.max(v, this.positions.length / 3) * 2
      this.positions = grow(this.positions, cap * 3)
      this.normalData = grow(this.normalData, cap * 3)
      this.uvData = grow(this.uvData, cap * 2)
      if (this.colorData) this.colorData = grow(this.colorData, cap * 4)
      if (this.uv1Data) this.uv1Data = grow(this.uv1Data, cap * 2)
      if (this.tangentData) this.tangentData = grow(this.tangentData, cap * 4)
    }
    const i = this.indexCount + indices
    if (i > this.indices.length) {
      const next = new Uint32Array(Math.max(i, this.indices.length * 2))
      next.set(this.indices.subarray(0, this.indexCount))
      this.indices = next
    }
  }

  /** Appends a vertex and returns its index. A zero normal means "compute it in `finish`". */
  vertex(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0, u = 0, v = 0): number {
    this.reserve(1, 0)
    const i = this.vertexCount++
    const p = this.positions
    p[i * 3] = x
    p[i * 3 + 1] = y
    p[i * 3 + 2] = z
    const n = this.normalData
    n[i * 3] = nx
    n[i * 3 + 1] = ny
    n[i * 3 + 2] = nz
    if (nx === 0 && ny === 0 && nz === 0) this.hasNormals = false
    this.uvData[i * 2] = u
    this.uvData[i * 2 + 1] = v
    if (this.colorData) this.colorData.set(WHITE, i * 4)
    if (this.uv1Data) {
      this.uv1Data[i * 2] = 0
      this.uv1Data[i * 2 + 1] = 0
    }
    return i
  }

  triangle(a: number, b: number, c: number): this {
    this.reserve(0, 3)
    const t = this.indices
    t[this.indexCount++] = a
    t[this.indexCount++] = b
    t[this.indexCount++] = c
    return this
  }

  /** Two triangles, a-b-c and a-c-d (counter-clockwise front faces). */
  quad(a: number, b: number, c: number, d: number): this {
    return this.triangle(a, b, c).triangle(a, c, d)
  }

  /** Sets one vertex's color (linear rgba). Other vertices default to white. */
  color(vertex: number, r: number, g: number, b: number, a = 1): this {
    const c = this.ensureColors()
    c[vertex * 4] = r
    c[vertex * 4 + 1] = g
    c[vertex * 4 + 2] = b
    c[vertex * 4 + 3] = a
    return this
  }

  private ensureColors(): Float64Array {
    if (!this.colorData) {
      this.colorData = new Float64Array((this.positions.length / 3) * 4)
      for (let i = 0; i < this.vertexCount; i++) this.colorData.set(WHITE, i * 4)
    }
    return this.colorData
  }

  /**
   * Sets one vertex's second uv set. Engine generators (0045) put a part code and a shade there
   * (0 bark or base, 1 leaf or tip; a per-vertex variation), which vegetation materials tint by.
   */
  uv1(vertex: number, u: number, v: number): this {
    this.uv1Data ??= new Float64Array((this.positions.length / 3) * 2)
    this.uv1Data[vertex * 2] = u
    this.uv1Data[vertex * 2 + 1] = v
    return this
  }

  /** Sets the second uv set of every vertex from `first` on. */
  uv1All(u: number, v: number, first = 0): this {
    for (let i = first; i < this.vertexCount; i++) this.uv1(i, u, v)
    return this
  }

  /** Colors every vertex from `first` on (default: all of them). */
  colorAll(r: number, g: number, b: number, a = 1, first = 0): this {
    for (let i = first; i < this.vertexCount; i++) this.color(i, r, g, b, a)
    return this
  }

  // --- shapes --------------------------------------------------------------------------------------

  /** A sphere of `radius` subdivided `detail` times from an icosahedron (10 · 4^detail + 2 vertices). */
  icosphere(detail: number, radius = 1): this {
    if (!Number.isInteger(detail) || detail < 0 || detail > 8) {
      throw new ShardError('mesh/bad-shape', `icosphere detail must be 0 to 8, got ${detail}`, {
        hint: 'Detail 6 is already 40 962 vertices.',
      })
    }
    const first = this.vertexCount
    const phi = (1 + Math.sqrt(5)) / 2
    const base = [
      -1,
      phi,
      0,
      1,
      phi,
      0,
      -1,
      -phi,
      0,
      1,
      -phi,
      0,
      0,
      -1,
      phi,
      0,
      1,
      phi,
      0,
      -1,
      -phi,
      0,
      1,
      -phi,
      phi,
      0,
      -1,
      phi,
      0,
      1,
      -phi,
      0,
      -1,
      -phi,
      0,
      1,
    ]
    let faces = [
      0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
      8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ]
    const total = 10 * 4 ** detail + 2
    const unit = new Float64Array(total * 3)
    let count = 0
    const add = (x: number, y: number, z: number) => {
      const inv = 1 / Math.sqrt(x * x + y * y + z * z)
      unit[count * 3] = x * inv
      unit[count * 3 + 1] = y * inv
      unit[count * 3 + 2] = z * inv
      return count++
    }
    for (let i = 0; i < 12; i++) add(base[i * 3]!, base[i * 3 + 1]!, base[i * 3 + 2]!)
    for (let level = 0; level < detail; level++) {
      const midpoints = new Map<number, number>()
      const mid = (a: number, b: number): number => {
        const key = a < b ? a * total + b : b * total + a
        let m = midpoints.get(key)
        if (m === undefined) {
          m = add(
            unit[a * 3]! + unit[b * 3]!,
            unit[a * 3 + 1]! + unit[b * 3 + 1]!,
            unit[a * 3 + 2]! + unit[b * 3 + 2]!,
          )
          midpoints.set(key, m)
        }
        return m
      }
      const next: number[] = []
      for (let f = 0; f < faces.length; f += 3) {
        const a = faces[f]!
        const b = faces[f + 1]!
        const c = faces[f + 2]!
        const ab = mid(a, b)
        const bc = mid(b, c)
        const ca = mid(c, a)
        next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
      }
      faces = next
    }
    this.reserve(count, faces.length)
    for (let i = 0; i < count; i++) {
      const x = unit[i * 3]!
      const y = unit[i * 3 + 1]!
      const z = unit[i * 3 + 2]!
      // Spherical-ish UVs without trig: u from the direction's xz, v from y.
      this.vertex(x * radius, y * radius, z * radius, x, y, z, 0.5 + x * 0.5, 0.5 - y * 0.5)
    }
    for (let f = 0; f < faces.length; f += 3)
      this.triangle(first + faces[f]!, first + faces[f + 1]!, first + faces[f + 2]!)
    return this
  }

  /** An axis-aligned box centered on the origin, with flat faces. */
  box(options: { x?: number; y?: number; z?: number } = {}): this {
    const h = [(options.x ?? 1) / 2, (options.y ?? 1) / 2, (options.z ?? 1) / 2]
    // Per face: normal axis and sign, then the u and v axes (u × v = normal).
    const faces = [
      [0, 1, 2, -1, 1, 1],
      [0, -1, 2, 1, 1, 1],
      [1, 1, 0, 1, 2, -1],
      [1, -1, 0, 1, 2, 1],
      [2, 1, 0, 1, 1, 1],
      [2, -1, 0, -1, 1, 1],
    ] as const
    const p = [0, 0, 0]
    const n = [0, 0, 0]
    for (const [axis, sign, ua, us, va, vs] of faces) {
      const base = this.vertexCount
      n[0] = n[1] = n[2] = 0
      n[axis] = sign
      for (let k = 0; k < 4; k++) {
        const su = k === 1 || k === 2 ? 1 : -1
        const sv = k >= 2 ? 1 : -1
        p[axis] = sign * h[axis]!
        p[ua] = su * us * h[ua]!
        p[va] = sv * vs * h[va]!
        this.vertex(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, (su + 1) / 2, (1 - sv) / 2)
      }
      this.quad(base, base + 1, base + 2, base + 3)
    }
    return this
  }

  /**
   * A surface of revolution around +Y: `profile` is [radius, y] pairs from bottom to top, swept
   * through `sides` steps. A radius of 0 closes that end to a point.
   */
  lathe(profile: ArrayLike<number>, options: { sides?: number; caps?: boolean } = {}): this {
    const sides = options.sides ?? 12
    const rows = profile.length / 2
    if (rows < 2 || sides < 3) {
      throw new ShardError('mesh/bad-shape', 'lathe needs at least 2 profile points and 3 sides', {
        hint: 'profile: [r0, y0, r1, y1, …], bottom to top.',
      })
    }
    const first = this.vertexCount
    const ring = sides + 1
    // Profile normals in the (r, y) plane: the perpendicular of the neighbors' difference.
    for (let j = 0; j < rows; j++) {
      const r = profile[j * 2]!
      const y = profile[j * 2 + 1]!
      const a = Math.max(0, j - 1)
      const b = Math.min(rows - 1, j + 1)
      const dr = profile[b * 2]! - profile[a * 2]!
      const dy = profile[b * 2 + 1]! - profile[a * 2 + 1]!
      const len = Math.sqrt(dr * dr + dy * dy) || 1
      const nr = dy / len
      const ny = -dr / len
      for (let i = 0; i <= sides; i++) {
        sinCos((i / sides) * TAU, sc)
        const s = sc[0]!
        const c = sc[1]!
        this.vertex(s * r, y, c * r, s * nr, ny, c * nr, i / sides, 1 - j / (rows - 1))
      }
    }
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < sides; i++) {
        const a = first + j * ring + i
        const b = a + ring
        this.quad(a, a + 1, b + 1, b)
      }
    }
    if (options.caps ?? true) {
      this.cap(profile[0]!, profile[1]!, sides, -1)
      this.cap(profile[(rows - 1) * 2]!, profile[(rows - 1) * 2 + 1]!, sides, 1)
    }
    return this
  }

  private cap(r: number, y: number, sides: number, dir: number): void {
    if (!(r > 0)) return
    const center = this.vertex(0, y, 0, 0, dir, 0, 0.5, 0.5)
    for (let i = 0; i <= sides; i++) {
      sinCos((i / sides) * TAU, sc)
      this.vertex(sc[0]! * r, y, sc[1]! * r, 0, dir, 0, 0.5 + sc[0]! / 2, 0.5 - sc[1]! / 2)
    }
    for (let i = 0; i < sides; i++) {
      const a = center + 1 + i
      if (dir > 0) this.triangle(center, a, a + 1)
      else this.triangle(center, a + 1, a)
    }
  }

  /** A cylinder (or a cone, with `radiusTop` 0) on +Y, centered on the origin. */
  cylinder(
    options: {
      radius?: number
      radiusTop?: number
      height?: number
      sides?: number
      caps?: boolean
    } = {},
  ): this {
    const r = options.radius ?? 0.5
    const h = (options.height ?? 1) / 2
    return this.lathe([r, -h, options.radiusTop ?? r, h], {
      sides: options.sides ?? 16,
      caps: options.caps,
    })
  }

  /**
   * A tube along a curve (xyz points): rings of `sides` vertices, oriented by parallel transport
   * so they don't twist. `radius` is one number or one per point (0 at an end makes a point).
   */
  tube(
    curve: ArrayLike<number>,
    radius: number | ArrayLike<number>,
    options: { sides?: number; caps?: boolean; v0?: number; vScale?: number } = {},
  ): this {
    const count = curve.length / 3
    if (count < 2) {
      throw new ShardError('mesh/bad-shape', 'tube needs a curve of at least 2 points', {
        hint: 'curve: [x0, y0, z0, x1, y1, z1, …].',
      })
    }
    const sides = options.sides ?? 8
    const ring = sides + 1
    const first = this.vertexCount
    const radiusAt = (i: number) => (typeof radius === 'number' ? radius : radius[i]!)
    // Tangents, then a frame transported along them.
    const t = new Float64Array(count * 3)
    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - 1)
      const b = Math.min(count - 1, i + 1)
      let x = curve[b * 3]! - curve[a * 3]!
      let y = curve[b * 3 + 1]! - curve[a * 3 + 1]!
      let z = curve[b * 3 + 2]! - curve[a * 3 + 2]!
      const len = Math.sqrt(x * x + y * y + z * z) || 1
      x /= len
      y /= len
      z /= len
      t[i * 3] = x
      t[i * 3 + 1] = y
      t[i * 3 + 2] = z
    }
    const nrm = new Float64Array(3)
    perpendicular(t[0]!, t[1]!, t[2]!, nrm)
    let length = options.v0 ?? 0
    const vScale = options.vScale ?? 1
    for (let i = 0; i < count; i++) {
      const tx = t[i * 3]!
      const ty = t[i * 3 + 1]!
      const tz = t[i * 3 + 2]!
      if (i > 0) {
        // Transport: remove the new tangent's component, renormalize.
        const d = nrm[0]! * tx + nrm[1]! * ty + nrm[2]! * tz
        let nx = nrm[0]! - tx * d
        let ny = nrm[1]! - ty * d
        let nz = nrm[2]! - tz * d
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        if (len < 1e-9) perpendicular(tx, ty, tz, nrm)
        else {
          nx /= len
          ny /= len
          nz /= len
          nrm[0] = nx
          nrm[1] = ny
          nrm[2] = nz
        }
        const dx = curve[i * 3]! - curve[i * 3 - 3]!
        const dy = curve[i * 3 + 1]! - curve[i * 3 - 2]!
        const dz = curve[i * 3 + 2]! - curve[i * 3 - 1]!
        length += Math.sqrt(dx * dx + dy * dy + dz * dz)
      }
      // binormal = t × n
      const bx = ty * nrm[2]! - tz * nrm[1]!
      const by = tz * nrm[0]! - tx * nrm[2]!
      const bz = tx * nrm[1]! - ty * nrm[0]!
      const r = radiusAt(i)
      const cx = curve[i * 3]!
      const cy = curve[i * 3 + 1]!
      const cz = curve[i * 3 + 2]!
      for (let s = 0; s <= sides; s++) {
        sinCos((s / sides) * TAU, sc)
        const ox = nrm[0]! * sc[1]! + bx * sc[0]!
        const oy = nrm[1]! * sc[1]! + by * sc[0]!
        const oz = nrm[2]! * sc[1]! + bz * sc[0]!
        this.vertex(cx + ox * r, cy + oy * r, cz + oz * r, ox, oy, oz, s / sides, length * vScale)
      }
    }
    for (let i = 0; i < count - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = first + i * ring + s
        const b = a + ring
        this.quad(a, a + 1, b + 1, b)
      }
    }
    if (options.caps) {
      for (const end of [0, count - 1]) {
        const r = radiusAt(end)
        if (!(r > 0)) continue
        const dir = end === 0 ? -1 : 1
        const nx = t[end * 3]! * dir
        const ny = t[end * 3 + 1]! * dir
        const nz = t[end * 3 + 2]! * dir
        const center = this.vertex(
          curve[end * 3]!,
          curve[end * 3 + 1]!,
          curve[end * 3 + 2]!,
          nx,
          ny,
          nz,
          0.5,
          0.5,
        )
        const row = first + end * ring
        for (let s = 0; s < sides; s++) {
          if (dir > 0) this.triangle(center, row + s, row + s + 1)
          else this.triangle(center, row + s + 1, row + s)
        }
      }
    }
    return this
  }

  // --- deformation ---------------------------------------------------------------------------------

  /**
   * Moves every vertex along its normal by `fn(position, normal, index)` metres (normals are
   * computed first where missing). Synchronous: for generator code, which runs off the main thread.
   */
  displace(
    fn: (position: Float64Array, normal: Float64Array, index: number) => number,
    first = 0,
  ): this {
    this.ensureNormals()
    const p = this.positions
    const n = this.normalData
    const pos = new Float64Array(3)
    const nrm = new Float64Array(3)
    for (let i = first; i < this.vertexCount; i++) {
      pos[0] = p[i * 3]!
      pos[1] = p[i * 3 + 1]!
      pos[2] = p[i * 3 + 2]!
      nrm[0] = n[i * 3]!
      nrm[1] = n[i * 3 + 1]!
      nrm[2] = n[i * 3 + 2]!
      const d = fn(pos, nrm, i)
      p[i * 3] = pos[0] + nrm[0] * d
      p[i * 3 + 1] = pos[1] + nrm[1] * d
      p[i * 3 + 2] = pos[2] + nrm[2] * d
    }
    return this
  }

  /**
   * Moves every vertex along its normal by `amount × noise(position)`, sampling all positions in one
   * batch: `sample(points, out)` is a batch noise call, such as a generator's
   * `(p, out) => ctx.noise.sample(graph, seed, p, out)`.
   */
  displaceNoise(
    sample: (points: Float32Array, out: Float32Array) => void,
    amount: number,
    first = 0,
  ): this {
    this.ensureNormals()
    const count = this.vertexCount - first
    const pts = new Float32Array(count * 3)
    for (let i = 0; i < count * 3; i++) pts[i] = this.positions[first * 3 + i]!
    const out = new Float32Array(count)
    sample(pts, out)
    const p = this.positions
    const n = this.normalData
    for (let k = 0; k < count; k++) {
      const i = first + k
      const d = out[k]! * amount
      p[i * 3] = p[i * 3]! + n[i * 3]! * d
      p[i * 3 + 1] = p[i * 3 + 1]! + n[i * 3 + 1]! * d
      p[i * 3 + 2] = p[i * 3 + 2]! + n[i * 3 + 2]! * d
    }
    return this
  }

  /** Scales positions per axis about the origin (normals follow the inverse transpose). */
  scale(x: number, y = x, z = x, first = 0): this {
    const p = this.positions
    const n = this.normalData
    for (let i = first; i < this.vertexCount; i++) {
      p[i * 3] = p[i * 3]! * x
      p[i * 3 + 1] = p[i * 3 + 1]! * y
      p[i * 3 + 2] = p[i * 3 + 2]! * z
      normalizeAt(n, i, n[i * 3]! / x, n[i * 3 + 1]! / y, n[i * 3 + 2]! / z)
    }
    return this
  }

  /** Moves vertices from `first` on. */
  translate(x: number, y: number, z: number, first = 0): this {
    const p = this.positions
    for (let i = first; i < this.vertexCount; i++) {
      p[i * 3] = p[i * 3]! + x
      p[i * 3 + 1] = p[i * 3 + 1]! + y
      p[i * 3 + 2] = p[i * 3 + 2]! + z
    }
    return this
  }

  /**
   * Transforms vertices from `first` on by a column-major 4×4 affine matrix (normals by its
   * inverse transpose, renormalized).
   */
  transform(m: ArrayLike<number>, first = 0): this {
    const inv = normalMatrix(m)
    const p = this.positions
    const n = this.normalData
    for (let i = first; i < this.vertexCount; i++) {
      const x = p[i * 3]!
      const y = p[i * 3 + 1]!
      const z = p[i * 3 + 2]!
      p[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      p[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      p[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
      const nx = n[i * 3]!
      const ny = n[i * 3 + 1]!
      const nz = n[i * 3 + 2]!
      if (nx === 0 && ny === 0 && nz === 0) continue
      normalizeAt(
        n,
        i,
        inv[0]! * nx + inv[3]! * ny + inv[6]! * nz,
        inv[1]! * nx + inv[4]! * ny + inv[7]! * nz,
        inv[2]! * nx + inv[5]! * ny + inv[8]! * nz,
      )
    }
    return this
  }

  /**
   * Extrudes a set of triangles (indices of triangles, i.e. index / 3) by `distance` along their
   * average normal per vertex: the set moves out, and its boundary gets side walls.
   */
  extrude(faceSet: ArrayLike<number>, distance: number): this {
    const t = this.indices
    const p = this.positions
    // Face normals of the set, accumulated per vertex.
    const acc = new Map<number, number[]>()
    const inSet = new Set<number>()
    for (let k = 0; k < faceSet.length; k++) {
      const f = faceSet[k]!
      if (!(f >= 0 && f < this.triangleCount)) {
        throw new ShardError('mesh/bad-shape', `extrude: triangle ${f} doesn't exist`, {
          hint: `Triangles are 0 to ${this.triangleCount - 1} (index / 3).`,
        })
      }
      inSet.add(f)
      const a = t[f * 3]!
      const b = t[f * 3 + 1]!
      const c = t[f * 3 + 2]!
      const ux = p[b * 3]! - p[a * 3]!
      const uy = p[b * 3 + 1]! - p[a * 3 + 1]!
      const uz = p[b * 3 + 2]! - p[a * 3 + 2]!
      const vx = p[c * 3]! - p[a * 3]!
      const vy = p[c * 3 + 1]! - p[a * 3 + 1]!
      const vz = p[c * 3 + 2]! - p[a * 3 + 2]!
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      for (const v of [a, b, c]) {
        let s = acc.get(v)
        if (!s) {
          s = [0, 0, 0]
          acc.set(v, s)
        }
        s[0]! += nx / len
        s[1]! += ny / len
        s[2]! += nz / len
      }
    }
    // Boundary edges: directed edges of the set whose reverse isn't in the set.
    const edges = new Map<string, [number, number]>()
    for (const f of inSet) {
      for (let e = 0; e < 3; e++) {
        const a = t[f * 3 + e]!
        const b = t[f * 3 + ((e + 1) % 3)]!
        const reverse = `${b}:${a}`
        if (edges.has(reverse)) edges.delete(reverse)
        else edges.set(`${a}:${b}`, [a, b])
      }
    }
    // New vertices for the set, offset along their normals.
    const moved = new Map<number, number>()
    const vertices = [...acc.keys()].sort((a, b) => a - b)
    for (const v of vertices) {
      const s = acc.get(v)!
      const len = Math.sqrt(s[0]! * s[0]! + s[1]! * s[1]! + s[2]! * s[2]!) || 1
      const nv = this.copyVertex(v)
      const q = this.positions
      q[nv * 3] = q[nv * 3]! + (s[0]! / len) * distance
      q[nv * 3 + 1] = q[nv * 3 + 1]! + (s[1]! / len) * distance
      q[nv * 3 + 2] = q[nv * 3 + 2]! + (s[2]! / len) * distance
      moved.set(v, nv)
    }
    const idx = this.indices
    for (const f of inSet) {
      for (let e = 0; e < 3; e++) idx[f * 3 + e] = moved.get(idx[f * 3 + e]!)!
    }
    // Side walls: for boundary edge a→b of a set triangle, the quad a, b, b', a' faces outward.
    const walls = [...edges.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1])
    for (const [a, b] of walls) {
      const a2 = moved.get(a)!
      const b2 = moved.get(b)!
      const w = [this.copyVertex(a), this.copyVertex(b), this.copyVertex(b2), this.copyVertex(a2)]
      for (const v of w) this.normalData.fill(0, v * 3, v * 3 + 3)
      this.hasNormals = false
      this.quad(w[0]!, w[1]!, w[2]!, w[3]!)
    }
    return this
  }

  private copyVertex(v: number): number {
    const p = this.positions
    const n = this.normalData
    const i = this.vertex(
      p[v * 3]!,
      p[v * 3 + 1]!,
      p[v * 3 + 2]!,
      n[v * 3]!,
      n[v * 3 + 1]!,
      n[v * 3 + 2]!,
      this.uvData[v * 2]!,
      this.uvData[v * 2 + 1]!,
    )
    if (this.colorData) this.colorData.copyWithin(i * 4, v * 4, v * 4 + 4)
    if (this.uv1Data) this.uv1Data.copyWithin(i * 2, v * 2, v * 2 + 2)
    return i
  }

  /**
   * Appends another mesh (a builder or MeshData), optionally transformed by a column-major 4×4
   * affine matrix.
   */
  merge(other: MeshBuilder | MeshData, transform?: ArrayLike<number>): this {
    const first = this.vertexCount
    const src = other instanceof MeshBuilder ? other : undefined
    const data = other instanceof MeshBuilder ? undefined : other
    const count = src ? src.vertexCount : data!.positions.length / 3
    const indexCount = src ? src.indexCount : (data!.indices?.length ?? count)
    this.reserve(count, indexCount)
    const pos = src ? src.positions : data!.positions
    const nrm = src ? src.normalData : data!.normals
    const uv = src ? src.uvData : data!.uvs
    const col = src ? src.colorData : data!.colors
    const uv1 = src ? src.uv1Data : data!.uvs1
    if (col) this.ensureColors()
    for (let i = 0; i < count; i++) {
      this.vertex(
        pos[i * 3]!,
        pos[i * 3 + 1]!,
        pos[i * 3 + 2]!,
        nrm ? nrm[i * 3]! : 0,
        nrm ? nrm[i * 3 + 1]! : 0,
        nrm ? nrm[i * 3 + 2]! : 0,
        uv ? uv[i * 2]! : 0,
        uv ? uv[i * 2 + 1]! : 0,
      )
      if (col) this.color(first + i, col[i * 4]!, col[i * 4 + 1]!, col[i * 4 + 2]!, col[i * 4 + 3]!)
      if (uv1) this.uv1(first + i, uv1[i * 2]!, uv1[i * 2 + 1]!)
    }
    const tri = src ? src.indices : data!.indices
    for (let k = 0; k < indexCount; k++) {
      this.indices[this.indexCount++] = first + (tri ? tri[k]! : k)
    }
    if (transform) this.transform(transform, first)
    return this
  }

  // --- cleanup and attributes -----------------------------------------------------------------------

  /**
   * Merges vertices closer than `epsilon` (positions only; the first vertex's attributes win) and
   * drops triangles that collapse.
   */
  weld(epsilon = 1e-6): this {
    const p = this.positions
    const n = this.vertexCount
    const inv = 1 / Math.max(epsilon, 1e-12)
    const cells = new Map<string, number[]>()
    const remap = new Int32Array(n)
    let next = 0
    const keep = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const x = p[i * 3]!
      const y = p[i * 3 + 1]!
      const z = p[i * 3 + 2]!
      const cx = Math.floor(x * inv)
      const cy = Math.floor(y * inv)
      const cz = Math.floor(z * inv)
      let found = -1
      for (let dz = -1; dz <= 1 && found < 0; dz++) {
        for (let dy = -1; dy <= 1 && found < 0; dy++) {
          for (let dx = -1; dx <= 1 && found < 0; dx++) {
            const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`)
            if (!list) continue
            for (const j of list) {
              const ex = p[keep[j]! * 3]! - x
              const ey = p[keep[j]! * 3 + 1]! - y
              const ez = p[keep[j]! * 3 + 2]! - z
              if (ex * ex + ey * ey + ez * ez <= epsilon * epsilon) {
                found = j
                break
              }
            }
          }
        }
      }
      if (found >= 0) {
        remap[i] = found
        continue
      }
      keep[next] = i
      remap[i] = next
      const key = `${cx},${cy},${cz}`
      const list = cells.get(key)
      if (list) list.push(next)
      else cells.set(key, [next])
      next++
    }
    this.compact(keep, next, remap)
    return this
  }

  /** Keeps vertices `keep[0..count)` (in that order) and rewrites indices through `remap`. */
  private compact(keep: Int32Array, count: number, remap: Int32Array): void {
    const pick = (src: Float64Array, width: number) => {
      const out = new Float64Array(Math.max(count, 1) * width)
      for (let i = 0; i < count; i++)
        for (let k = 0; k < width; k++) out[i * width + k] = src[keep[i]! * width + k]!
      return out
    }
    this.positions = pick(this.positions, 3)
    this.normalData = pick(this.normalData, 3)
    this.uvData = pick(this.uvData, 2)
    if (this.colorData) this.colorData = pick(this.colorData, 4)
    if (this.uv1Data) this.uv1Data = pick(this.uv1Data, 2)
    if (this.tangentData) this.tangentData = pick(this.tangentData, 4)
    this.vertexCount = count
    const t = this.indices
    let w = 0
    for (let k = 0; k < this.indexCount; k += 3) {
      const a = remap[t[k]!]!
      const b = remap[t[k + 1]!]!
      const c = remap[t[k + 2]!]!
      if (a === b || b === c || c === a) continue
      t[w++] = a
      t[w++] = b
      t[w++] = c
    }
    this.indexCount = w
  }

  /**
   * Recomputes normals from the triangles (area-weighted). Faces meeting at more than `angle`
   * degrees keep a hard edge (their shared vertices are split); `angle: 180` smooths everything.
   */
  normals(options: { angle?: number } = {}): this {
    return this.computeNormals(options.angle ?? 180)
  }

  private computeNormals(angle: number): this {
    const p = this.positions
    const t = this.indices
    const tris = this.triangleCount
    const fn = new Float64Array(tris * 3)
    for (let f = 0; f < tris; f++) {
      const a = t[f * 3]! * 3
      const b = t[f * 3 + 1]! * 3
      const c = t[f * 3 + 2]! * 3
      const ux = p[b]! - p[a]!
      const uy = p[b + 1]! - p[a + 1]!
      const uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!
      const vy = p[c + 1]! - p[a + 1]!
      const vz = p[c + 2]! - p[a + 2]!
      // Twice the area times the unit normal: an area-weighted sum.
      fn[f * 3] = uy * vz - uz * vy
      fn[f * 3 + 1] = uz * vx - ux * vz
      fn[f * 3 + 2] = ux * vy - uy * vx
    }
    if (angle >= 180) {
      const acc = new Float64Array(this.vertexCount * 3)
      for (let f = 0; f < tris; f++) {
        for (let e = 0; e < 3; e++) {
          const v = t[f * 3 + e]! * 3
          acc[v] = acc[v]! + fn[f * 3]!
          acc[v + 1] = acc[v + 1]! + fn[f * 3 + 1]!
          acc[v + 2] = acc[v + 2]! + fn[f * 3 + 2]!
        }
      }
      for (let i = 0; i < this.vertexCount; i++)
        normalizeAt(this.normalData, i, acc[i * 3]!, acc[i * 3 + 1]!, acc[i * 3 + 2]!, 1)
      this.hasNormals = true
      return this
    }
    // Faces around each vertex; a corner's normal sums the faces within `angle` of its own.
    sinCos(angle * DEG, sc)
    const cosLimit = sc[1]!
    const unit = new Float64Array(tris * 3)
    for (let f = 0; f < tris; f++) {
      const x = fn[f * 3]!
      const y = fn[f * 3 + 1]!
      const z = fn[f * 3 + 2]!
      const len = Math.sqrt(x * x + y * y + z * z) || 1
      unit[f * 3] = x / len
      unit[f * 3 + 1] = y / len
      unit[f * 3 + 2] = z / len
    }
    const start = new Int32Array(this.vertexCount + 1)
    for (let k = 0; k < this.indexCount; k++) start[t[k]! + 1]!++
    for (let v = 0; v < this.vertexCount; v++) start[v + 1]! += start[v]!
    const fill = start.slice()
    const faces = new Int32Array(this.indexCount)
    for (let k = 0; k < this.indexCount; k++) faces[fill[t[k]!]!++] = (k / 3) | 0
    const original = this.vertexCount
    const corner = new Float64Array(3)
    // Per vertex, the corner normals made so far and the vertex holding each.
    for (let v = 0; v < original; v++) {
      const made: number[] = []
      const holders: number[] = []
      for (let s = start[v]!; s < start[v + 1]!; s++) {
        const f = faces[s]!
        corner[0] = corner[1] = corner[2] = 0
        for (let s2 = start[v]!; s2 < start[v + 1]!; s2++) {
          const g = faces[s2]!
          const dot =
            unit[f * 3]! * unit[g * 3]! +
            unit[f * 3 + 1]! * unit[g * 3 + 1]! +
            unit[f * 3 + 2]! * unit[g * 3 + 2]!
          if (g !== f && dot < cosLimit) continue
          corner[0]! += fn[g * 3]!
          corner[1]! += fn[g * 3 + 1]!
          corner[2]! += fn[g * 3 + 2]!
        }
        const len = Math.sqrt(corner[0]! ** 2 + corner[1]! ** 2 + corner[2]! ** 2) || 1
        const nx = corner[0]! / len
        const ny = corner[1]! / len
        const nz = corner[2]! / len
        let holder = -1
        for (let m = 0; m < holders.length; m++) {
          const dx = made[m * 3]! - nx
          const dy = made[m * 3 + 1]! - ny
          const dz = made[m * 3 + 2]! - nz
          if (dx * dx + dy * dy + dz * dz < 1e-12) {
            holder = holders[m]!
            break
          }
        }
        if (holder < 0) {
          holder = holders.length === 0 ? v : this.copyVertex(v)
          holders.push(holder)
          made.push(nx, ny, nz)
          this.normalData[holder * 3] = nx
          this.normalData[holder * 3 + 1] = ny
          this.normalData[holder * 3 + 2] = nz
        }
        for (let e = 0; e < 3; e++)
          if (this.indices[f * 3 + e] === v) this.indices[f * 3 + e] = holder
      }
    }
    this.hasNormals = true
    return this
  }

  private ensureNormals(): void {
    if (!this.hasNormals) this.computeNormals(180)
  }

  /**
   * Per-vertex tangents (xyzw, w the handedness) from the UV gradient (Lengyel's method, averaged
   * per vertex), or any direction perpendicular to the normal where there's no gradient.
   */
  tangents(): this {
    this.ensureNormals()
    const count = this.vertexCount
    const p = this.positions
    const n = this.normalData
    const uv = this.uvData
    const tri = this.indices
    const tan = new Float64Array(count * 3)
    const bit = new Float64Array(count * 3)
    for (let k = 0; k < this.indexCount; k += 3) {
      const a = tri[k]!
      const b = tri[k + 1]!
      const c = tri[k + 2]!
      const e1x = p[b * 3]! - p[a * 3]!
      const e1y = p[b * 3 + 1]! - p[a * 3 + 1]!
      const e1z = p[b * 3 + 2]! - p[a * 3 + 2]!
      const e2x = p[c * 3]! - p[a * 3]!
      const e2y = p[c * 3 + 1]! - p[a * 3 + 1]!
      const e2z = p[c * 3 + 2]! - p[a * 3 + 2]!
      const du1 = uv[b * 2]! - uv[a * 2]!
      const dv1 = uv[b * 2 + 1]! - uv[a * 2 + 1]!
      const du2 = uv[c * 2]! - uv[a * 2]!
      const dv2 = uv[c * 2 + 1]! - uv[a * 2 + 1]!
      const det = du1 * dv2 - du2 * dv1
      if (det === 0) continue
      const r = 1 / det
      const tx = (e1x * dv2 - e2x * dv1) * r
      const ty = (e1y * dv2 - e2y * dv1) * r
      const tz = (e1z * dv2 - e2z * dv1) * r
      const bx = (e2x * du1 - e1x * du2) * r
      const by = (e2y * du1 - e1y * du2) * r
      const bz = (e2z * du1 - e1z * du2) * r
      for (const v of [a, b, c]) {
        tan[v * 3] = tan[v * 3]! + tx
        tan[v * 3 + 1] = tan[v * 3 + 1]! + ty
        tan[v * 3 + 2] = tan[v * 3 + 2]! + tz
        bit[v * 3] = bit[v * 3]! + bx
        bit[v * 3 + 1] = bit[v * 3 + 1]! + by
        bit[v * 3 + 2] = bit[v * 3 + 2]! + bz
      }
    }
    const out = new Float64Array((this.positions.length / 3) * 4)
    for (let v = 0; v < count; v++) {
      const nx = n[v * 3]!
      const ny = n[v * 3 + 1]!
      const nz = n[v * 3 + 2]!
      let tx = tan[v * 3]!
      let ty = tan[v * 3 + 1]!
      let tz = tan[v * 3 + 2]!
      if (tx === 0 && ty === 0 && tz === 0) {
        const ax = Math.abs(nx)
        const ay = Math.abs(ny)
        const az = Math.abs(nz)
        if (ax <= ay && ax <= az) tx = 1
        else if (ay <= az) ty = 1
        else tz = 1
      }
      const d = nx * tx + ny * ty + nz * tz
      tx -= nx * d
      ty -= ny * d
      tz -= nz * d
      const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
      tx /= len
      ty /= len
      tz /= len
      const cx = ny * tz - nz * ty
      const cy = nz * tx - nx * tz
      const cz = nx * ty - ny * tx
      const w = cx * bit[v * 3]! + cy * bit[v * 3 + 1]! + cz * bit[v * 3 + 2]! < 0 ? -1 : 1
      out[v * 4] = tx
      out[v * 4 + 1] = ty
      out[v * 4 + 2] = tz
      out[v * 4 + 3] = w
    }
    this.tangentData = out
    return this
  }

  /**
   * UVs projected along each vertex's dominant normal axis, `scale` metres per repeat: cheap
   * texturing for rocks and crystals, with seams where the axis changes.
   */
  uvsTriplanar(scale = 1): this {
    this.ensureNormals()
    const p = this.positions
    const n = this.normalData
    const inv = 1 / scale
    for (let i = 0; i < this.vertexCount; i++) {
      const ax = Math.abs(n[i * 3]!)
      const ay = Math.abs(n[i * 3 + 1]!)
      const az = Math.abs(n[i * 3 + 2]!)
      const x = p[i * 3]! * inv
      const y = p[i * 3 + 1]! * inv
      const z = p[i * 3 + 2]! * inv
      let u: number
      let v: number
      if (ax >= ay && ax >= az) {
        u = n[i * 3]! > 0 ? -z : z
        v = -y
      } else if (ay >= az) {
        u = x
        v = n[i * 3 + 1]! > 0 ? z : -z
      } else {
        u = n[i * 3 + 2]! > 0 ? x : -x
        v = -y
      }
      this.uvData[i * 2] = u
      this.uvData[i * 2 + 1] = v
    }
    return this
  }

  /** The mesh as `MeshData` (f32 attributes; u16 indices when they fit). Normals are filled in. */
  finish(): MeshData {
    if (this.vertexCount === 0) {
      throw new ShardError('mesh/bad-shape', 'The builder has no vertices', {
        hint: 'Append a shape (icosphere, box, lathe, tube, …) before finish().',
      })
    }
    this.ensureNormals()
    const n = this.vertexCount
    const out: MeshData = {
      positions: Float32Array.from(this.positions.subarray(0, n * 3)),
      normals: Float32Array.from(this.normalData.subarray(0, n * 3)),
      uvs: Float32Array.from(this.uvData.subarray(0, n * 2)),
      indices:
        n > 65535
          ? this.indices.slice(0, this.indexCount)
          : Uint16Array.from(this.indices.subarray(0, this.indexCount)),
    }
    if (this.colorData) out.colors = Float32Array.from(this.colorData.subarray(0, n * 4))
    if (this.uv1Data) out.uvs1 = Float32Array.from(this.uv1Data.subarray(0, n * 2))
    if (this.tangentData) out.tangents = Float32Array.from(this.tangentData.subarray(0, n * 4))
    return out
  }
}

const TAU = Math.PI * 2
const DEG = Math.PI / 180
const WHITE = [1, 1, 1, 1]
const sc = new Float64Array(2)

function grow(a: Float64Array, length: number): Float64Array<ArrayBuffer> {
  const out = new Float64Array(length)
  out.set(a)
  return out
}

function normalizeAt(
  n: Float64Array,
  i: number,
  x: number,
  y: number,
  z: number,
  fallbackY = 0,
): void {
  const len = Math.sqrt(x * x + y * y + z * z)
  if (len > 0) {
    n[i * 3] = x / len
    n[i * 3 + 1] = y / len
    n[i * 3 + 2] = z / len
  } else {
    n[i * 3] = 0
    n[i * 3 + 1] = fallbackY
    n[i * 3 + 2] = 0
  }
}

/** Any unit vector perpendicular to (x, y, z) (a unit vector), written into `out`. */
export function perpendicular(x: number, y: number, z: number, out: Float64Array): Float64Array {
  // Cross with the axis least aligned with the vector.
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const az = Math.abs(z)
  let px: number
  let py: number
  let pz: number
  if (ax <= ay && ax <= az) {
    px = 0
    py = z
    pz = -y
  } else if (ay <= az) {
    px = -z
    py = 0
    pz = x
  } else {
    px = y
    py = -x
    pz = 0
  }
  const len = Math.sqrt(px * px + py * py + pz * pz) || 1
  out[0] = px / len
  out[1] = py / len
  out[2] = pz / len
  return out
}

/** The upper-left 3×3 of the inverse transpose of a column-major 4×4 (for normals), row-major. */
function normalMatrix(m: ArrayLike<number>): Float64Array {
  const a = m[0]!
  const b = m[1]!
  const c = m[2]!
  const d = m[4]!
  const e = m[5]!
  const f = m[6]!
  const g = m[8]!
  const h = m[9]!
  const i = m[10]!
  // Cofactor matrix (inverse transpose up to scale; normals are renormalized anyway).
  const out = new Float64Array(9)
  out[0] = e * i - f * h
  out[1] = f * g - d * i
  out[2] = d * h - e * g
  out[3] = c * h - b * i
  out[4] = a * i - c * g
  out[5] = b * g - a * h
  out[6] = b * f - c * e
  out[7] = c * d - a * f
  out[8] = a * e - b * d
  return out
}
