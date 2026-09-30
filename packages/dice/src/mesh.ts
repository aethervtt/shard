import { Mesh } from '@aethervtt/shard-mesh'
import { cellLayout, cellUv } from './cells'
import type { DieGeometry } from './definition'
import { add, cross, dot, normalize, scale, stableTangent, sub, type V3 } from './math'

// The mesh of a die (0054): flat faces inset toward their centers, joined by chamfer strips along
// the edges and caps at the corners. Faces map into their atlas cells; `uv1.x` is 1 on faces and 0
// on the chamfer, so one draw covers both; `uv1.y` is the face index (−1 on the chamfer).

interface Builder {
  positions: number[]
  normals: number[]
  uvs: number[]
  uvs1: number[]
  tangents: number[]
  indices: number[]
}

function vertex(b: Builder, p: V3, n: V3, t: V3, u: number, v: number, face: number): number {
  const i = b.positions.length / 3
  b.positions.push(p[0], p[1], p[2])
  b.normals.push(n[0], n[1], n[2])
  b.tangents.push(t[0], t[1], t[2], 1)
  b.uvs.push(u, v)
  b.uvs1.push(face >= 0 ? 1 : 0, face)
  return i
}

/** Adds a convex polygon (counter-clockwise seen from outside) as a fan. */
function fan(b: Builder, ids: number[]): void {
  for (let k = 1; k + 1 < ids.length; k++) b.indices.push(ids[0]!, ids[k]!, ids[k + 1]!)
}

/**
 * A chamfered, flat-shaded die: `bevel` (default the definition's) moves each face corner toward
 * its face's center. Unit radius; the entity's scale sizes it.
 */
export function dieMesh(g: DieGeometry, bevel = g.definition.bevel): Mesh {
  const { points, faces } = g.polytope
  const layout = cellLayout(g)
  const b: Builder = { positions: [], normals: [], uvs: [], uvs1: [], tangents: [], indices: [] }
  const inset = faces.map((face) => {
    const map = new Map<number, V3>()
    for (const v of face.vertices) {
      map.set(v, add(points[v]!, scale(sub(face.center, points[v]!), bevel)))
    }
    return map
  })

  // Faces: planar, in their cells.
  const uv = [0, 0]
  faces.forEach((face, f) => {
    const cell = layout.faces[f]!
    const ids = face.vertices.map((v) => {
      const p = inset[f]!.get(v)!
      cellUv(layout, cell, p, uv, 0)
      return vertex(b, p, face.normal, cell.tangent, uv[0]!, uv[1]!, f)
    })
    fan(b, ids)
  })
  if (bevel <= 0) return build(b)

  // The chamfer shares radial normals, so its triangulation doesn't flash as the die turns.
  const radial = (p: V3) => normalize(p)
  const chamferVertex = (p: V3) => {
    const n = radial(p)
    return vertex(b, p, n, stableTangent(n), 0, 0, -1)
  }

  // Edge strips between the two faces that share each edge.
  const edges = new Map<string, { face: number; a: number; b: number }[]>()
  faces.forEach((face, f) => {
    const vs = face.vertices
    for (let k = 0; k < vs.length; k++) {
      const a = vs[k]!
      const c = vs[(k + 1) % vs.length]!
      const key = a < c ? `${a}:${c}` : `${c}:${a}`
      const list = edges.get(key) ?? []
      list.push({ face: f, a, b: c })
      edges.set(key, list)
    }
  })
  for (const pair of edges.values()) {
    if (pair.length !== 2) continue
    const [first, second] = pair as [(typeof pair)[0], (typeof pair)[0]]
    const quad: V3[] = [
      inset[first.face]!.get(first.a)!,
      inset[first.face]!.get(first.b)!,
      inset[second.face]!.get(first.b)!,
      inset[second.face]!.get(first.a)!,
    ]
    const center = scale(add(add(quad[0]!, quad[1]!), add(quad[2]!, quad[3]!)), 0.25)
    const n = cross(sub(quad[1]!, quad[0]!), sub(quad[2]!, quad[0]!))
    if (dot(n, center) < 0) quad.reverse()
    fan(b, quad.map(chamferVertex))
  }

  // Corner caps: the inset corners of every face around a vertex.
  points.forEach((p, v) => {
    const around: V3[] = []
    faces.forEach((face, f) => {
      if (face.vertices.includes(v)) around.push(inset[f]!.get(v)!)
    })
    if (around.length < 3) return
    const out = normalize(p)
    const t = stableTangent(out)
    const bt = cross(out, t)
    around.sort((l, r) => Math.atan2(dot(l, bt), dot(l, t)) - Math.atan2(dot(r, bt), dot(r, t)))
    fan(b, around.map(chamferVertex))
  })
  return build(b)
}

function build(b: Builder): Mesh {
  const n = b.positions.length / 3
  return Mesh.create({
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    uvs: Float32Array.from(b.uvs),
    uvs1: Float32Array.from(b.uvs1),
    tangents: Float32Array.from(b.tangents),
    indices: n < 65536 ? Uint16Array.from(b.indices) : Uint32Array.from(b.indices),
  })
}

/** A unit quad on the floor (y up), for the tray and its contact blobs. */
export function floorQuad(): Mesh {
  return Mesh.create({
    positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
    normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint16Array.from([0, 2, 1, 0, 3, 2]),
  })
}
