import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import { type AssetRef, ShardError, type World } from '@aethervtt/shard-core'
import { type GlbImage, type GlbMaterial, type GlbScene, writeGlb } from '@aethervtt/shard-gltf'
import { decodeMesh, type MeshData } from '@aethervtt/shard-mesh'
import { natureStarterFiles, treeGlbScene } from '@aethervtt/shard-nature'
import { procgen } from '@aethervtt/shard-procgen'
import { type MaterialAsset, Materials } from '@aethervtt/shard-render'
import type { CommandContext } from './commands'
import { EXIT } from './output'

const USAGE = 'Usage: shard nature init [--dir assets/nature] [--force]'

/** The installed nature package's `assets/` (next to its src/ in the repo, dist/ when published). */
function natureAssets(): string {
  const entry = createRequire(import.meta.url).resolve('@aethervtt/shard-nature')
  return join(dirname(entry), '..', 'assets')
}

/**
 * `shard nature init`: copies the preset species, `nature/Tree` materials and their textures into
 * the project (`assets/nature/` by default), skipping files that exist unless `--force` (0095).
 */
export async function nature(ctx: CommandContext): Promise<number> {
  if (ctx.args[0] !== 'init') throw new ShardError('cli/usage', USAGE)
  const dir =
    typeof ctx.flags.dir === 'string' ? ctx.flags.dir.replace(/\/+$/, '') : 'assets/nature'
  const force = ctx.flags.force === true
  const source = natureAssets()
  const written: string[] = []
  const skipped: string[] = []
  for (const file of natureStarterFiles(dir)) {
    const to = resolve(ctx.project, file.path)
    if (!force && existsSync(to)) {
      skipped.push(file.path)
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    if ('text' in file) await writeFile(to, file.text)
    else await copyFile(join(source, file.copy), to)
    written.push(file.path)
  }
  const lines = [
    `Wrote ${written.length} files under ${dir}${skipped.length ? `, skipped ${skipped.length} that exist (--force overwrites)` : ''}.`,
    'Add "nature" to shard.json plugins, then: shard gen nature/Tree --param species=' +
      `${dir}/species/oak_medium.tree.json --seeds 1-9 --out oaks.png`,
  ]
  ctx.out.result({ dir, written, skipped }, lines.join('\n'))
  return EXIT.ok
}

// --- GLB export ------------------------------------------------------------------------------

async function image(
  root: string,
  ref: AssetRef | null | undefined,
): Promise<GlbImage | undefined> {
  if (!ref?.path) return undefined
  const ext = extname(ref.path).toLowerCase()
  const mimeType =
    ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : undefined
  if (!mimeType) {
    throw new ShardError('gltf/write-unsupported', `Can't embed ${ref.path} in a GLB`, {
      path: ref.path,
      hint: 'GLB export embeds PNG and JPEG source files.',
    })
  }
  return { bytes: new Uint8Array(await readFile(resolve(root, ref.path))), mimeType }
}

type Slot = { texture?: AssetRef | null } | undefined

/** A standard material's fields as a glTF material (factors are linear in both). */
async function standardGlb(root: string, v: Record<string, unknown>): Promise<GlbMaterial> {
  const out: GlbMaterial = {
    baseColorFactor: v.baseColor as number[],
    metallicFactor: v.metallic as number,
    roughnessFactor: v.roughness as number,
  }
  const base = await image(root, (v.baseColorTexture as Slot)?.texture)
  if (base) out.baseColorTexture = base
  const mr = await image(root, (v.metallicRoughnessTexture as Slot)?.texture)
  if (mr) out.metallicRoughnessTexture = mr
  const normal = await image(root, (v.normalTexture as Slot)?.texture)
  if (normal) out.normalTexture = normal
  const mode = v.alphaMode
  if (mode === 'mask') {
    out.alphaMode = 'MASK'
    out.alphaCutoff = v.alphaCutoff as number
  } else if (mode === 'alpha' || mode === 'premultiplied') out.alphaMode = 'BLEND'
  if (v.doubleSided) out.doubleSided = true
  return out
}

const times = (a: readonly number[], b: readonly number[]) => a.map((x, i) => x * (b[i] ?? 1))

/**
 * A generated mesh and its LODs as a GLB: a `nature/Tree` material splits each level into bark and
 * leaf primitives; any other material (or none) exports its standard fields on one primitive.
 */
export async function generatedGlb(
  world: World,
  root: string,
  guid: string,
  name: string,
  materialPath: string | undefined,
): Promise<{ bytes: Uint8Array; levels: number[] }> {
  const record = procgen(world).recordOf(guid)
  const meshes = (record?.assets ?? []).filter((a) => a.type === 'Mesh' && a.bytes)
  if (meshes.length === 0) {
    throw new ShardError('cli/usage', `${name}'s output isn't a mesh, so it can't be a GLB`, {
      hint: '--out *.glb exports mesh generators; use --out *.png for a preview of anything.',
    })
  }
  const levels: MeshData[] = meshes.map((a) => decodeMesh(a.bytes!).data())
  let material: MaterialAsset | undefined
  if (materialPath) {
    const server = assetServer(world)
    const ref = server.resolve<'Material'>(materialPath)
    if (!ref) {
      throw new ShardError('asset/not-found', `No material at ${materialPath}`, {
        path: materialPath,
        hint: 'Pass a *.material.json path inside the project.',
      })
    }
    await server.load(ref)
    material = world.resource(Materials).get(ref) as MaterialAsset | undefined
  }
  const value = (material?.value ?? {}) as Record<string, unknown>
  let scene: GlbScene
  if (material?.type.name === 'nature/Tree') {
    const bark = await standardGlb(root, value)
    bark.baseColorFactor = times(bark.baseColorFactor ?? [1, 1, 1, 1], value.barkTint as number[])
    delete bark.alphaMode
    delete bark.alphaCutoff
    delete bark.doubleSided
    const leafTexture = await image(root, value.leafTexture as AssetRef | null)
    const leaves: GlbMaterial = {
      baseColorFactor: value.leafTint as number[],
      metallicFactor: 0,
      roughnessFactor: value.leafRoughness as number,
      alphaMode: 'MASK',
      alphaCutoff: value.alphaCutoff as number,
      doubleSided: true,
    }
    if (leafTexture) leaves.baseColorTexture = leafTexture
    scene = treeGlbScene(name, levels, { bark, leaves })
  } else {
    const glb = material ? await standardGlb(root, value) : undefined
    scene = {
      ...(glb ? { materials: [{ name, ...glb }] } : {}),
      nodes: levels.map((mesh, i) => ({
        name: levels.length > 1 ? `${name}_LOD${i}` : name,
        primitives: [{ mesh, ...(glb ? { material: 0 } : {}) }],
      })),
    }
  }
  return {
    bytes: writeGlb(scene),
    levels: levels.map((m) => (m.indices ? m.indices.length / 3 : m.positions.length / 9)),
  }
}
