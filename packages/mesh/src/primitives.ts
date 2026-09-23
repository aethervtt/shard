import { Mesh } from './mesh'

/**
 * Procedural primitives. Every one has normals and UVs, is centered on the origin, and uses
 * counter-clockwise front faces (right-handed, Y up). Parameters are the knobs an agent turns.
 */

class Builder {
  positions: number[] = []
  normals: number[] = []
  uvs: number[] = []
  indices: number[] = []

  vertex(p: readonly number[], n: readonly number[], uv: readonly number[]): number {
    this.positions.push(p[0]!, p[1]!, p[2]!)
    this.normals.push(n[0]!, n[1]!, n[2]!)
    this.uvs.push(uv[0]!, uv[1]!)
    return this.positions.length / 3 - 1
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c)
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d)
  }

  build(): Mesh {
    const count = this.positions.length / 3
    return Mesh.create({
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: count > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices),
    })
  }
}

/** Axis-aligned box with the given full extents. */
export function box(options: { x?: number; y?: number; z?: number } = {}): Mesh {
  const hx = (options.x ?? 1) / 2
  const hy = (options.y ?? 1) / 2
  const hz = (options.z ?? 1) / 2
  const b = new Builder()
  // Each face: normal, then two axes (u, v) spanning it so that u × v = normal.
  const faces: [number[], number[], number[]][] = [
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  ]
  const h = [hx, hy, hz]
  for (const [n, u, v] of faces) {
    const corner = (su: number, sv: number) =>
      [0, 1, 2].map((k) => (n[k]! + u[k]! * su + v[k]! * sv) * h[k]!)
    const a = b.vertex(corner(-1, -1), n, [0, 1])
    const c = b.vertex(corner(1, -1), n, [1, 1])
    const d = b.vertex(corner(1, 1), n, [1, 0])
    const e = b.vertex(corner(-1, 1), n, [0, 0])
    b.quad(a, c, d, e)
  }
  return b.build()
}

export function cube(options: { size?: number } = {}): Mesh {
  const s = options.size ?? 1
  return box({ x: s, y: s, z: s })
}

/** UV sphere. The seam column is duplicated so UVs wrap cleanly; normals match across it. */
export function sphere(options: { radius?: number; segments?: number; rings?: number } = {}): Mesh {
  const radius = options.radius ?? 0.5
  const segments = Math.max(3, options.segments ?? 32)
  const rings = Math.max(2, options.rings ?? Math.ceil(segments / 2))
  const b = new Builder()
  for (let r = 0; r <= rings; r++) {
    const v = r / rings
    const phi = v * Math.PI
    for (let s = 0; s <= segments; s++) {
      const u = s / segments
      const theta = u * Math.PI * 2
      const n = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)]
      b.vertex([n[0]! * radius, n[1]! * radius, n[2]! * radius], n, [u, v])
    }
  }
  const row = segments + 1
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s
      const c = a + row
      if (r !== 0) b.triangle(a, c, a + 1)
      if (r !== rings - 1) b.triangle(a + 1, c, c + 1)
    }
  }
  return b.build()
}

/** Flat square in the XZ plane, facing +Y, optionally subdivided (terrain, water, floors). */
export function plane(options: { size?: number; subdivisions?: number } = {}): Mesh {
  const size = options.size ?? 1
  const n = Math.max(1, options.subdivisions ?? 1)
  const b = new Builder()
  for (let z = 0; z <= n; z++) {
    for (let x = 0; x <= n; x++) {
      b.vertex([(x / n - 0.5) * size, 0, (z / n - 0.5) * size], [0, 1, 0], [x / n, z / n])
    }
  }
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x
      b.quad(a, a + n + 1, a + n + 2, a + 1)
    }
  }
  return b.build()
}

/** Cylinder (or cone, with `radiusTop: 0`) along Y, with caps. */
export function cylinder(
  options: {
    radius?: number
    radiusTop?: number
    height?: number
    segments?: number
    caps?: boolean
  } = {},
): Mesh {
  const r0 = options.radius ?? 0.5
  const r1 = options.radiusTop ?? r0
  const h = options.height ?? 1
  const segments = Math.max(3, options.segments ?? 32)
  const b = new Builder()
  // Side normals tilt when the radii differ.
  const slope = (r0 - r1) / h
  const ny = slope / Math.sqrt(1 + slope * slope)
  const nr = 1 / Math.sqrt(1 + slope * slope)
  for (let s = 0; s <= segments; s++) {
    const u = s / segments
    const t = u * Math.PI * 2
    const sin = Math.sin(t)
    const cos = Math.cos(t)
    const n = [sin * nr, ny, cos * nr]
    b.vertex([sin * r0, -h / 2, cos * r0], n, [u, 1])
    b.vertex([sin * r1, h / 2, cos * r1], n, [u, 0])
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2
    // A cone's top ring collapses to the apex: one triangle per segment, not a degenerate quad.
    if (r1 === 0) b.triangle(a, a + 2, a + 1)
    else b.quad(a, a + 2, a + 3, a + 1)
  }
  if (options.caps ?? true) {
    for (const [y, sign, radius] of [
      [h / 2, 1, r1],
      [-h / 2, -1, r0],
    ] as const) {
      if (radius === 0) continue
      const center = b.vertex([0, y, 0], [0, sign, 0], [0.5, 0.5])
      const first = b.positions.length / 3
      for (let s = 0; s <= segments; s++) {
        const t = (s / segments) * Math.PI * 2
        b.vertex(
          [Math.sin(t) * radius, y, Math.cos(t) * radius],
          [0, sign, 0],
          [0.5 + Math.sin(t) / 2, 0.5 - Math.cos(t) / 2],
        )
      }
      for (let s = 0; s < segments; s++) {
        if (sign > 0) b.triangle(center, first + s, first + s + 1)
        else b.triangle(center, first + s + 1, first + s)
      }
    }
  }
  return b.build()
}

export function cone(options: { radius?: number; height?: number; segments?: number } = {}): Mesh {
  return cylinder({ ...options, radiusTop: 0 })
}

/** Capsule along Y: `height` is the full height including the hemispherical ends. */
export function capsule(
  options: { radius?: number; height?: number; segments?: number; rings?: number } = {},
): Mesh {
  const radius = options.radius ?? 0.5
  const height = Math.max(options.height ?? 2, radius * 2)
  const segments = Math.max(3, options.segments ?? 32)
  const ringsPerCap = Math.max(2, options.rings ?? 8)
  const half = height / 2 - radius
  const b = new Builder()
  const rows: [number, number][] = [] // [phi, yOffset]
  for (let r = 0; r <= ringsPerCap; r++) rows.push([(r / ringsPerCap) * (Math.PI / 2), half])
  for (let r = 0; r <= ringsPerCap; r++)
    rows.push([Math.PI / 2 + (r / ringsPerCap) * (Math.PI / 2), -half])
  rows.forEach(([phi, offset], r) => {
    for (let s = 0; s <= segments; s++) {
      const u = s / segments
      const theta = u * Math.PI * 2
      const n = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)]
      b.vertex([n[0]! * radius, n[1]! * radius + offset, n[2]! * radius], n, [
        u,
        r / (rows.length - 1),
      ])
    }
  })
  const row = segments + 1
  for (let r = 0; r < rows.length - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s
      const c = a + row
      // The first and last rows sit on the poles, where one triangle of each quad collapses.
      if (r !== rows.length - 2) b.triangle(a, c, c + 1)
      if (r !== 0) b.triangle(a, c + 1, a + 1)
    }
  }
  return b.build()
}

/** Torus in the XZ plane. */
export function torus(
  options: {
    radius?: number
    tube?: number
    radialSegments?: number
    tubularSegments?: number
  } = {},
): Mesh {
  const R = options.radius ?? 0.5
  const r = options.tube ?? 0.2
  const radial = Math.max(3, options.radialSegments ?? 16)
  const tubular = Math.max(3, options.tubularSegments ?? 48)
  const b = new Builder()
  for (let j = 0; j <= radial; j++) {
    const v = (j / radial) * Math.PI * 2
    for (let i = 0; i <= tubular; i++) {
      const u = (i / tubular) * Math.PI * 2
      const cx = Math.sin(u) * R
      const cz = Math.cos(u) * R
      const n = [Math.sin(u) * Math.cos(v), Math.sin(v), Math.cos(u) * Math.cos(v)]
      b.vertex([cx + n[0]! * r, n[1]! * r, cz + n[2]! * r], n, [i / tubular, j / radial])
    }
  }
  const row = tubular + 1
  for (let j = 0; j < radial; j++) {
    for (let i = 0; i < tubular; i++) {
      const a = j * row + i
      b.quad(a, a + 1, a + row + 1, a + row)
    }
  }
  return b.build()
}
