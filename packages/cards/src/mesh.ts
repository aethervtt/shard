import { Mesh } from '@aethervtt/shard-mesh'
import type { CardDefinitionValue } from './definition'

/** True rounded geometry: picks, shadows and color share the same silhouette. */
export function cardMesh(def: CardDefinitionValue, segments = 12): Mesh {
  const w = def.size[0] / 2,
    h = def.size[1] / 2,
    r = def.cornerRadius
  const n = 4 * (segments + 1)
  const ring: number[] = []
  for (let corner = 0; corner < 4; corner++) {
    const cx = (corner === 0 || corner === 3 ? 1 : -1) * (w - r)
    const cy = (corner < 2 ? 1 : -1) * (h - r)
    for (let j = 0; j <= segments; j++) {
      const a = ((corner + j / segments) * Math.PI) / 2
      ring.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    }
  }
  const p: number[] = [],
    normals: number[] = [],
    uv: number[] = [],
    uv1: number[] = []
  const indices: number[] = []
  const vertex = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    side: number,
  ) => {
    const id = p.length / 3
    p.push(x, y, z)
    normals.push(nx, ny, nz)
    uv.push(side === 1 ? 0.5 - x / (2 * w) : x / (2 * w) + 0.5, 0.5 - y / (2 * h))
    uv1.push(side, 0)
    return id
  }
  for (let side = 0; side < 2; side++) {
    const z = ((side === 0 ? 1 : -1) * def.thickness) / 2
    const c = vertex(0, 0, z, 0, 0, side === 0 ? 1 : -1, side)
    for (let i = 0; i < n; i++)
      vertex(ring[i * 2]!, ring[i * 2 + 1]!, z, 0, 0, side === 0 ? 1 : -1, side)
    for (let i = 0; i < n; i++) {
      const a = c + 1 + i,
        b = c + 1 + ((i + 1) % n)
      indices.push(c, side === 0 ? a : b, side === 0 ? b : a)
    }
  }
  if (def.thickness > 0)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = ring[i * 2]!,
        ay = ring[i * 2 + 1]!,
        bx = ring[j * 2]!,
        by = ring[j * 2 + 1]!
      const dx = bx - ax,
        dy = by - ay,
        len = Math.sqrt(dx * dx + dy * dy) || 1
      const a = vertex(ax, ay, -def.thickness / 2, dy / len, -dx / len, 0, 2)
      vertex(bx, by, -def.thickness / 2, dy / len, -dx / len, 0, 2)
      vertex(bx, by, def.thickness / 2, dy / len, -dx / len, 0, 2)
      vertex(ax, ay, def.thickness / 2, dy / len, -dx / len, 0, 2)
      indices.push(a, a + 1, a + 2, a, a + 2, a + 3)
    }
  return Mesh.create({
    positions: new Float32Array(p),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uv),
    uvs1: new Float32Array(uv1),
    indices: new Uint16Array(indices),
  })
}
