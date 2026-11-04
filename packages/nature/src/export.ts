import type { GlbMaterial, GlbScene } from '@aethervtt/shard-gltf'
import type { MeshData } from '@aethervtt/shard-mesh'

/**
 * A `nature/Tree` mesh split by part code (uv1.x: bark below 0.5, leaves above), each half with
 * only the vertices it uses. Either can be empty (a leafless species).
 */
export function splitTreeMesh(mesh: MeshData): { bark: MeshData; leaves: MeshData } {
  const parts = mesh.uvs1
  const indices = mesh.indices
  if (!parts || !indices) return { bark: mesh, leaves: { positions: new Float32Array(0) } }
  const pick = (leaf: boolean): MeshData => {
    const remap = new Int32Array(mesh.positions.length / 3).fill(-1)
    const kept: number[] = []
    const tris: number[] = []
    for (let t = 0; t < indices.length; t += 3) {
      if (parts[indices[t]! * 2]! > 0.5 !== leaf) continue
      for (let k = 0; k < 3; k++) {
        const v = indices[t + k]!
        if (remap[v] === -1) {
          remap[v] = kept.length
          kept.push(v)
        }
        tris.push(remap[v]!)
      }
    }
    const gather = <T extends Float32Array>(src: T | undefined, width: number): T | undefined => {
      if (!src) return undefined
      const out = new (src.constructor as new (n: number) => T)(kept.length * width)
      for (let i = 0; i < kept.length; i++)
        for (let c = 0; c < width; c++) out[i * width + c] = src[kept[i]! * width + c]!
      return out
    }
    const out: MeshData = {
      positions: gather(mesh.positions, 3)!,
      indices: kept.length > 0xffff ? Uint32Array.from(tris) : Uint16Array.from(tris),
    }
    const normals = gather(mesh.normals, 3)
    if (normals) out.normals = normals
    const uvs = gather(mesh.uvs, 2)
    if (uvs) out.uvs = uvs
    const uvs1 = gather(mesh.uvs1, 2)
    if (uvs1) out.uvs1 = uvs1
    const tangents = gather(mesh.tangents, 4)
    if (tangents) out.tangents = tangents
    return out
  }
  return { bark: pick(false), leaves: pick(true) }
}

/**
 * A tree's levels of detail (full detail first) as a glTF scene: one node per level, named
 * `<name>_LOD<n>`, each with a bark primitive and (when the tree has leaves) a leaf primitive, so
 * other engines and DCC tools get standard materials. uv1 (the part code) is kept as TEXCOORD_1.
 */
export function treeGlbScene(
  name: string,
  levels: readonly MeshData[],
  materials: { bark: GlbMaterial; leaves: GlbMaterial },
): GlbScene {
  const split = levels.map(splitTreeMesh)
  const leafy = split.every((s) => s.leaves.positions.length > 0)
  return {
    materials: [
      { name: `${name}_bark`, ...materials.bark },
      { name: `${name}_leaves`, ...materials.leaves },
    ],
    nodes: split.map((s, i) => ({
      name: `${name}_LOD${i}`,
      primitives: [
        { mesh: s.bark, material: 0 },
        ...(leafy ? [{ mesh: s.leaves, material: 1 }] : []),
      ],
    })),
  }
}
