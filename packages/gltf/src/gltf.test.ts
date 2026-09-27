import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AssetServer, assetServer } from '@aethervtt/shard-assets'
import { World } from '@aethervtt/shard-core'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { Materials, Meshes } from '@aethervtt/shard-render'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGltf } from './document'
import { AnimationClips, Skins } from './index'
import './index'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../fixtures/khronos')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A temp project with some fixture files under assets/. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shard-gltf-'))
  roots.push(root)
  for (const [to, from] of Object.entries(files)) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    cpSync(join(fixtures, from), join(root, to))
  }
  return root
}

async function server(root: string, world = new World()): Promise<AssetServer> {
  const s = assetServer(world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  const report = await s.scan()
  if (report.failed.length) throw new Error(JSON.stringify(report.failed))
  return s
}

/** An independent accessor decode for float VEC* data, for comparing against the importer. */
function referenceFloats(file: string, accessorIndex: number, bufferFile?: string): number[] {
  const bytes = new Uint8Array(readFileSync(join(fixtures, file)))
  const { json, bin } = parseGltf(bytes)
  const acc = json.accessors![accessorIndex]!
  const bv = json.bufferViews![acc.bufferView!]!
  const buffer = bufferFile ? new Uint8Array(readFileSync(join(fixtures, bufferFile))) : bin!
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type as 'VEC3']
  const stride = bv.byteStride ?? n * 4
  const view = new DataView(buffer.buffer, buffer.byteOffset + (bv.byteOffset ?? 0))
  const out: number[] = []
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++)
      out.push(view.getFloat32((acc.byteOffset ?? 0) + i * stride + c * 4, true))
  }
  return out
}

const FIXTURES: Record<string, string> = {
  'assets/Box.glb': 'Box/glTF-Binary/Box.glb',
  'assets/box/Box.gltf': 'Box/glTF/Box.gltf',
  'assets/box/Box0.bin': 'Box/glTF/Box0.bin',
  'assets/BoxInterleaved.glb': 'BoxInterleaved/glTF-Binary/BoxInterleaved.glb',
  'assets/interleaved/BoxInterleaved.gltf': 'BoxInterleaved/glTF/BoxInterleaved.gltf',
  'assets/interleaved/BoxInterleaved.bin': 'BoxInterleaved/glTF/BoxInterleaved.bin',
  'assets/tri/TriangleWithoutIndices.gltf':
    'TriangleWithoutIndices/glTF/TriangleWithoutIndices.gltf',
  'assets/tri/TriangleWithoutIndices.bin': 'TriangleWithoutIndices/glTF/TriangleWithoutIndices.bin',
  'assets/TriangleEmbedded.gltf':
    'TriangleWithoutIndices/glTF-Embedded/TriangleWithoutIndices.gltf',
  'assets/sparse/SimpleSparseAccessor.gltf': 'SimpleSparseAccessor/glTF/SimpleSparseAccessor.gltf',
  'assets/sparse/SimpleSparseAccessor.bin': 'SimpleSparseAccessor/glTF/SimpleSparseAccessor.bin',
  'assets/SparseEmbedded.gltf': 'SimpleSparseAccessor/glTF-Embedded/SimpleSparseAccessor.gltf',
  'assets/meshes/SimpleMeshes.gltf': 'SimpleMeshes/glTF/SimpleMeshes.gltf',
  'assets/meshes/SimpleMeshes.bin': 'SimpleMeshes/glTF/SimpleMeshes.bin',
  'assets/CesiumMan.glb': 'CesiumMan/glTF-Binary/CesiumMan.glb',
  'assets/LightsPunctualLamp.glb': 'LightsPunctualLamp/glTF-Binary/LightsPunctualLamp.glb',
}

describe('importing the Khronos samples', () => {
  it('imports every fixture without errors', async () => {
    const s = await server(project(FIXTURES))
    const sources = Object.keys(FIXTURES).filter((f) => !f.endsWith('.bin'))
    for (const source of sources) {
      const info = s.info(source)
      expect(info.error, source).toBeUndefined()
      expect(s.resolve(`${source}#Scene`), source).toBeDefined()
    }
    expect(s.info('assets/Box.glb').subAssets?.map((a) => a.label)).toEqual(
      expect.arrayContaining(['Mesh/Mesh', 'Material/Red', 'Scene']),
    )
  }, 60_000)

  it('decodes positions, normals, and indices the same as a reference decode', async () => {
    const s = await server(project(FIXTURES))
    const w = s.world
    const mesh = async (path: string) => {
      await s.load(path)
      return w.resource(Meshes).get(s.resolve(path))!
    }
    // Box.glb: accessor 1 is NORMAL, 2 is POSITION (per the file).
    const box = await mesh('assets/Box.glb#Mesh/Mesh')
    expect(Array.from(box.positions)).toEqual(referenceFloats('Box/glTF-Binary/Box.glb', 2))
    expect(Array.from(box.normals!)).toEqual(referenceFloats('Box/glTF-Binary/Box.glb', 1))
    expect(box.indices).toBeInstanceOf(Uint16Array)
    expect(box.indices!.length).toBe(36)
    // The same data from .gltf + .bin, and interleaved: identical meshes.
    const boxGltf = await mesh('assets/box/Box.gltf#Mesh/Mesh')
    const interleaved = await mesh('assets/BoxInterleaved.glb#Mesh/Mesh')
    expect(Array.from(boxGltf.positions)).toEqual(Array.from(box.positions))
    expect(Array.from(interleaved.positions).sort()).toEqual(Array.from(box.positions).sort())
    // No indices, no normals: flat normals generated, still three vertices.
    const tri = await mesh('assets/tri/TriangleWithoutIndices.gltf#Mesh/0')
    expect(Array.from(tri.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(tri.normals!)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
    const embedded = await mesh('assets/TriangleEmbedded.gltf#Mesh/0')
    expect(Array.from(embedded.positions)).toEqual(Array.from(tri.positions))
    // Sparse: the base positions with the sparse entries written over them (decoded by hand here).
    const sparse = await mesh('assets/sparse/SimpleSparseAccessor.gltf#Mesh/0')
    const sparseJson = JSON.parse(
      readFileSync(join(fixtures, 'SimpleSparseAccessor/glTF/SimpleSparseAccessor.gltf'), 'utf8'),
    )
    const sbin = new Uint8Array(
      readFileSync(join(fixtures, 'SimpleSparseAccessor/glTF/SimpleSparseAccessor.bin')),
    )
    const pos = sparseJson.accessors[sparseJson.meshes[0].primitives[0].attributes.POSITION]
    const expected = referenceFloats(
      'SimpleSparseAccessor/glTF/SimpleSparseAccessor.gltf',
      sparseJson.meshes[0].primitives[0].attributes.POSITION,
      'SimpleSparseAccessor/glTF/SimpleSparseAccessor.bin',
    )
    const iv = sparseJson.bufferViews[pos.sparse.indices.bufferView]
    const vv = sparseJson.bufferViews[pos.sparse.values.bufferView]
    const dv = new DataView(sbin.buffer, sbin.byteOffset)
    const indexSize =
      pos.sparse.indices.componentType === 5123
        ? 2
        : pos.sparse.indices.componentType === 5125
          ? 4
          : 1
    for (let i = 0; i < pos.sparse.count; i++) {
      const at = (iv.byteOffset ?? 0) + (pos.sparse.indices.byteOffset ?? 0) + i * indexSize
      const target =
        indexSize === 2
          ? dv.getUint16(at, true)
          : indexSize === 4
            ? dv.getUint32(at, true)
            : dv.getUint8(at)
      for (let c = 0; c < 3; c++) {
        expected[target * 3 + c] = dv.getFloat32(
          (vv.byteOffset ?? 0) + (pos.sparse.values.byteOffset ?? 0) + (i * 3 + c) * 4,
          true,
        )
      }
    }
    expect(pos.sparse.count).toBeGreaterThan(0)
    // The sample has no normals, so the importer flat-shaded it: vertices follow the index list.
    const ia = sparseJson.accessors[sparseJson.meshes[0].primitives[0].indices]
    const ibv = sparseJson.bufferViews[ia.bufferView]
    const flat: number[] = []
    for (let i = 0; i < ia.count; i++) {
      const v = dv.getUint16((ibv.byteOffset ?? 0) + (ia.byteOffset ?? 0) + i * 2, true)
      flat.push(expected[v * 3]!, expected[v * 3 + 1]!, expected[v * 3 + 2]!)
    }
    expect(Array.from(sparse.positions)).toEqual(flat)
    expect(Array.from((await mesh('assets/SparseEmbedded.gltf#Mesh/0')).positions)).toEqual(
      Array.from(sparse.positions),
    )
  }, 60_000)

  it('imports materials, including their factors', async () => {
    const s = await server(project({ 'assets/Box.glb': 'Box/glTF-Binary/Box.glb' }))
    await s.load('assets/Box.glb#Material/Red')
    const red = s.world.resource(Materials).get(s.resolve('assets/Box.glb#Material/Red'))!
    expect(Array.from(red.value.baseColor).map((v) => Math.round(v * 1000) / 1000)).toEqual([
      0.8, 0, 0, 1,
    ])
    expect(red.value.metallic).toBe(0)
  })

  it('imports KHR_lights_punctual point and spot lights in physical units', async () => {
    const root = project({})
    const gltf = {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_lights_punctual'],
      extensions: {
        KHR_lights_punctual: {
          lights: [
            { type: 'point', intensity: 100, color: [1, 0.5, 0.25], range: 12 },
            {
              type: 'spot',
              intensity: 50,
              spot: { innerConeAngle: Math.PI / 8, outerConeAngle: Math.PI / 4 },
            },
          ],
        },
      },
      scenes: [{ nodes: [0, 1] }],
      nodes: [
        { name: 'bulb', translation: [0, 2, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
        { name: 'spot', extensions: { KHR_lights_punctual: { light: 1 } } },
      ],
    }
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets/lights.gltf'), JSON.stringify(gltf))
    writeFileSync(
      join(root, 'assets/lights.gltf.meta'),
      JSON.stringify({ guid: 'c'.repeat(32), settings: { lights: true } }),
    )
    const s = await server(root)
    const scene = (await s.artifact('assets/lights.gltf#Scene')).json as {
      entities: { name: string; components: Record<string, Record<string, unknown>> }[]
    }
    const find = (name: string): Record<string, Record<string, unknown>> => {
      const walk = (
        list: typeof scene.entities,
      ): Record<string, Record<string, unknown>> | undefined => {
        for (const e of list) {
          if (e.name === name) return e.components
          const inner = walk((e as { children?: typeof scene.entities }).children ?? [])
          if (inner) return inner
        }
        return undefined
      }
      return walk(scene.entities)!
    }
    const bulb = find('bulb')['render/PointLight']!
    expect(bulb.intensity).toBeCloseTo(100 * 4 * Math.PI, 3) // candela → lumens
    expect(bulb.range).toBe(12)
    expect(bulb.color).toEqual([1, 0.5, 0.25, 1])
    const spot = find('spot')['render/SpotLight']!
    expect(spot.intensity).toBeCloseTo(50 * 4 * Math.PI, 3)
    expect(spot.outerAngle).toBeCloseTo(45, 5)
    expect(spot.innerAngle).toBeCloseTo(22.5, 5)
    // No range in the file: it ends where the light falls to 0.01 lux.
    expect(spot.range).toBeCloseTo(Math.sqrt(50 / 0.01), 3)
  })

  it('turns MSFT_lod chains and _LOD<n> siblings into Lod components', async () => {
    const root = project({})
    // One triangle, shared by three meshes (the importer doesn't care that levels look alike).
    const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const uri = `data:application/octet-stream;base64,${Buffer.from(tri.buffer).toString('base64')}`
    const prim = { attributes: { POSITION: 0 } }
    const gltf = {
      asset: { version: '2.0' },
      extensionsUsed: ['MSFT_lod'],
      buffers: [{ byteLength: 36, uri }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
      meshes: [
        { name: 'hi', primitives: [prim] },
        { name: 'mid', primitives: [prim] },
        { name: 'lo', primitives: [prim] },
      ],
      scenes: [{ nodes: [0, 3, 4, 5] }],
      nodes: [
        {
          name: 'Tree',
          mesh: 0,
          extensions: { MSFT_lod: { ids: [1, 2] } },
          extras: { MSFT_screencoverage: [0.25, 0.04, 0.0004] },
        },
        { name: 'TreeMid', mesh: 1 },
        { name: 'TreeLo', mesh: 2 },
        { name: 'Rock_LOD1', mesh: 1 },
        { name: 'Rock_LOD0', mesh: 0 },
        { name: 'Rock_LOD2', mesh: 2 },
      ],
    }
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets/lods.gltf'), JSON.stringify(gltf))
    const s = await server(root)
    type Entity = { name: string; components: Record<string, Record<string, unknown>> }
    const scene = (await s.artifact('assets/lods.gltf#Scene')).json as { entities: Entity[] }
    expect(scene.entities.map((e) => e.name)).toEqual(['Tree', 'Rock'])
    type Levels = { levels: { mesh: { path: string }; screenSize: number }[] }
    const tree = scene.entities[0]!.components['render/Lod'] as Levels
    expect(tree.levels.map((l) => l.mesh.path)).toEqual(['#Mesh/hi', '#Mesh/mid', '#Mesh/lo'])
    // Screen coverage is a fraction of the screen's area; screenSize is a diameter.
    expect(tree.levels.map((l) => l.screenSize)).toEqual([0.5, 0.2, 0.02])
    const rock = scene.entities[1]!.components['render/Lod'] as Levels
    expect(rock.levels.map((l) => l.mesh.path)).toEqual(['#Mesh/hi', '#Mesh/mid', '#Mesh/lo'])
    expect(rock.levels.map((l) => l.screenSize)).toEqual([0.25, 0.0625, 0])

    writeFileSync(
      join(root, 'assets/lods.gltf.meta'),
      JSON.stringify({ guid: 'd'.repeat(32), settings: { lods: 'none' } }),
    )
    const flat = await server(root)
    const plain = (await flat.artifact('assets/lods.gltf#Scene')).json as { entities: Entity[] }
    expect(plain.entities.map((e) => e.name)).toEqual([
      'Tree',
      'Rock_LOD1',
      'Rock_LOD0',
      'Rock_LOD2',
    ])
    expect(plain.entities.some((e) => e.components['render/Lod'])).toBe(false)
  })

  it("imports CesiumMan's skin and animation with rest poses", async () => {
    const s = await server(
      project({ 'assets/CesiumMan.glb': 'CesiumMan/glTF-Binary/CesiumMan.glb' }),
    )
    const { json } = parseGltf(
      new Uint8Array(readFileSync(join(fixtures, 'CesiumMan/glTF-Binary/CesiumMan.glb'))),
    )
    const skinPath = s.info('assets/CesiumMan.glb').subAssets!.find((a) => a.type === 'Skin')!.path
    const animPath = s
      .info('assets/CesiumMan.glb')
      .subAssets!.find((a) => a.type === 'AnimationClip')!.path
    await s.whenSettled([skinPath, animPath])
    const skin = s.world.resource(Skins).get(s.resolve(skinPath))!
    const clip = s.world.resource(AnimationClips).get(s.resolve(animPath))!
    expect(skin.joints.length).toBe(json.skins![0]!.joints.length)
    expect(skin.inverseBindMatrices.length).toBe(skin.joints.length * 16)
    expect(skin.restPose.length).toBe(skin.joints.length)
    for (const pose of skin.restPose) expect(pose.rotation.length).toBe(4)
    expect(clip.channels.length).toBe(json.animations![0]!.channels.length)
    expect(clip.duration).toBeGreaterThan(1)
    // Joint paths are entity paths under the model root.
    expect(skin.joints[0]).toMatch(/\//)
  })
})

describe('errors', () => {
  it('a file requiring Draco fails with unsupported-extension; a bad accessor points at itself', async () => {
    const root = project({ 'assets/Box.glb': 'Box/glTF-Binary/Box.glb' })
    const gltf = JSON.parse(readFileSync(join(fixtures, 'Box/glTF/Box.gltf'), 'utf8'))
    writeFileSync(
      join(root, 'assets/draco.gltf'),
      JSON.stringify({ ...gltf, buffers: [], extensionsRequired: ['KHR_draco_mesh_compression'] }),
    )
    const bad = structuredClone(gltf)
    bad.buffers[0].uri = 'Box0.bin'
    bad.accessors[1].count = 99999
    writeFileSync(join(root, 'assets/bad.gltf'), JSON.stringify(bad))
    cpSync(join(fixtures, 'Box/glTF/Box0.bin'), join(root, 'assets/Box0.bin'))
    const s = assetServer(new World()).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    const report = await s.scan()
    const byPath = Object.fromEntries(report.failed.map((f) => [f.path, f.error]))
    expect(byPath['assets/draco.gltf']).toMatchObject({
      code: 'gltf/unsupported-extension',
      path: '/extensionsRequired/0',
    })
    expect(byPath['assets/bad.gltf']).toMatchObject({
      code: 'gltf/accessor-out-of-range',
      path: '/accessors/1',
    })
    expect(report.imported).toContain('assets/Box.glb')
  })
})
