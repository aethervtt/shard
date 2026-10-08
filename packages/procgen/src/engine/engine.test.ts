import { timeout } from '@aethervtt/shard-core/test-env'
import { decodeMesh, loadMeshSimplifier, Mesh, type MeshData } from '@aethervtt/shard-mesh'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import { beforeAll, describe, expect, it } from 'vitest'
import { requestOf } from '../generator'
import { executeJob } from '../job'
import { ENGINE_GENERATORS } from './generators'

beforeAll(async () => {
  await loadNoiseKernel()
  await loadMeshSimplifier()
})

const tris = (m: MeshData) => (m.indices?.length ?? 0) / 3

/** Triangles whose winding disagrees with their vertex normals (front faces must face out). */
function facesAgree(m: MeshData): number {
  const p = m.positions
  const n = m.normals!
  const t = m.indices!
  let bad = 0
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k]!, t[k + 1]!, t[k + 2]!]
    const e1 = [0, 1, 2].map((i) => p[b * 3 + i]! - p[a * 3 + i]!)
    const e2 = [0, 1, 2].map((i) => p[c * 3 + i]! - p[a * 3 + i]!)
    const f = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ]
    const area = Math.hypot(f[0]!, f[1]!, f[2]!)
    if (area < 1e-10) continue
    const avg = [0, 1, 2].map((i) => n[a * 3 + i]! + n[b * 3 + i]! + n[c * 3 + i]!)
    if (f[0]! * avg[0]! + f[1]! * avg[1]! + f[2]! * avg[2]! <= 0) bad++
  }
  return bad
}

describe('engine generators', () => {
  it.each(ENGINE_GENERATORS.map((g) => [g.name, g] as const))(
    '%s makes valid, deterministic meshes at nine seeds, with LODs at the requested fractions',
    async (_, gen) => {
      for (let seed = 1; seed <= 9; seed++) {
        const run = () => executeJob({ ...requestOf(gen, {}, seed), deps: [], chain: [] })
        const a = await run()
        // Deterministic: the same bytes again (once per generator is enough).
        if (seed === 1) {
          const b = await run()
          expect(a.assets.map((x) => x.bytes)).toEqual(b.assets.map((x) => x.bytes))
        }
        const main = decodeMesh(a.assets.find((x) => x.label === '')!.bytes!)
        Mesh.create(main)
        // Stands on its origin: nothing far below the ground, most of it above.
        const box = Mesh.create(main).bounds
        expect(box[4]!).toBeGreaterThan(0)
        expect(box[1]!).toBeGreaterThan(-0.5 * (box[4]! - box[1]!))
        expect(main.uvs1, 'part codes in uv1').toBeDefined()
        expect(facesAgree(main), `${gen.name} seed ${seed}: faces against their normals`).toBe(0)
        const lods = a.assets
          .filter((x) => x.label.startsWith('LOD'))
          .map((x) => decodeMesh(x.bytes!))
        const fractions =
          gen.name === 'shard/GrassClump'
            ? [0.3125, 0.039]
            : gen.name === 'shard/Tree' || gen.name === 'shard/Bush'
              ? [0.4, 0.12]
              : [0.5, 0.2]
        expect(lods).toHaveLength(fractions.length)
        for (const [i, f] of fractions.entries()) {
          const got = tris(lods[i]!) / tris(main)
          expect(got, `${gen.name} seed ${seed} LOD${i + 1}`).toBeLessThanOrEqual(f * 1.1)
          expect(got).toBeGreaterThanOrEqual(f * 0.9)
          Mesh.create(lods[i]!)
        }
      }
    },
    timeout(60_000),
  )
})
