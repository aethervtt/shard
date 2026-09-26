import type { MeshData } from '@shard/mesh'
import type { NoiseGraph } from '@shard/noise'
import type { NoiseApi } from '@shard/procgen'

/**
 * Pushes each vertex of a unit sphere in or out along its direction: radius × (1 + roughness ×
 * noise). Plain arithmetic, so the bytes match on every host.
 */
export function displaceAlongNormals(
  mesh: MeshData,
  noise: NoiseApi,
  shape: NoiseGraph,
  seed: number,
  radius: number,
  roughness: number,
): void {
  const p = mesh.positions
  const n = new Float32Array(p.length / 3)
  noise.sample(shape, seed, p, n)
  for (let i = 0; i < n.length; i++) {
    const s = radius * (1 + roughness * n[i]!)
    p[i * 3] = p[i * 3]! * s
    p[i * 3 + 1] = p[i * 3 + 1]! * s
    p[i * 3 + 2] = p[i * 3 + 2]! * s
  }
}
