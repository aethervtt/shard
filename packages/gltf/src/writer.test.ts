import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import { ShardError, World } from '@aethervtt/shard-core'
import { cube, type MeshData } from '@aethervtt/shard-mesh'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { pngBytes } from '@aethervtt/shard-render/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGltf } from './document'
import { writeGlb } from './writer'
import './index'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const box = (size: number): MeshData => cube({ size }).data()

describe('writeGlb', () => {
  it('writes a GLB the importer reads back: meshes, materials, embedded textures, LODs', async () => {
    const png = pngBytes(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]), 2, 1)
    const glb = writeGlb({
      materials: [
        { name: 'bark', baseColorFactor: [0.5, 0.4, 0.3, 1], roughnessFactor: 1 },
        {
          name: 'leaves',
          baseColorTexture: { bytes: png, mimeType: 'image/png' },
          alphaMode: 'MASK',
          alphaCutoff: 0.4,
          doubleSided: true,
        },
      ],
      nodes: [0, 1].map((level) => ({
        name: `Tree_LOD${level}`,
        primitives: [
          { mesh: box(1 - level * 0.5), material: 0 },
          { mesh: box(2 - level), material: 1 },
        ],
      })),
    })

    const { json, bin } = parseGltf(glb)
    expect(json.asset.version).toBe('2.0')
    expect(bin?.byteLength).toBeGreaterThan(0)
    expect(json.images).toHaveLength(1)
    expect(json.materials?.[1]).toMatchObject({
      alphaMode: 'MASK',
      alphaCutoff: 0.4,
      doubleSided: true,
    })
    expect(json.materials?.[0]?.alphaMode).toBeUndefined()

    const root = mkdtempSync(join(tmpdir(), 'shard-glb-'))
    roots.push(root)
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets/tree.glb'), glb)
    const s = assetServer(new World()).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    const report = await s.scan()
    expect(report.failed).toEqual([])
    type Entity = {
      name: string
      components: Record<string, Record<string, unknown>>
      children?: Entity[]
    }
    const scene = (await s.artifact('assets/tree.glb#Scene')).json as { entities: Entity[] }
    expect(scene.entities.map((e) => e.name)).toEqual(['Tree'])
    // One LOD chain per primitive: bark and leaves each switch level with the node.
    const lods: string[][] = []
    const visit = (e: Entity) => {
      const lod = e.components['render/Lod'] as { levels: { mesh: { path: string } }[] } | undefined
      if (lod) lods.push(lod.levels.map((l) => l.mesh.path))
      for (const c of e.children ?? []) visit(c)
    }
    scene.entities.forEach(visit)
    expect(lods).toHaveLength(2)
    for (const levels of lods) expect(levels).toHaveLength(2)
  })

  it('uses 16-bit indices when they fit, and refuses attributes of the wrong length', () => {
    const mesh = box(1)
    const json = parseGltf(writeGlb({ nodes: [{ name: 'Box', primitives: [{ mesh }] }] })).json
    const indices = json.meshes![0]!.primitives[0]!.indices!
    expect(json.accessors![indices]!.componentType).toBe(5123)
    const bad = { ...mesh, uvs: new Float32Array(3) }
    expect(() => writeGlb({ nodes: [{ name: 'Box', primitives: [{ mesh: bad }] }] })).toThrow(
      ShardError,
    )
  })
})
