import {
  AssetStore,
  defineAssetType,
  defineImporter,
  type ImportContext,
  type ImportedAsset,
} from '@shard/assets'
import { defineResource, defineSchema, type JsonValue, ShardError, t } from '@shard/core'
import { encodeMesh, Mesh, type MeshData } from '@shard/mesh'
import { StandardMaterial } from '@shard/render'
import type { SceneEntity, SceneFile } from '@shard/scene'
import { importImageBytes, type TextureUsage } from '@shard/texture'
import { Accessors } from './accessors'
import {
  type GltfDocument,
  type GltfMaterial,
  type GltfNode,
  type GltfPrimitive,
  parseGltf,
} from './document'

// --- settings ---------------------------------------------------------------------

export const GltfImportSettings = defineSchema(
  'gltf/ImportSettings',
  {
    scale: t.f32({
      default: 1,
      min: 0,
      description: 'Uniform scale applied to the model root (0.01 for centimeter files).',
    }),
    forward: t.enum(['+z', '-z'], {
      description:
        'Which way the model faces after import. "+z" keeps the file as authored (glTF models face +Z); "-z" turns it around to face Shard\'s forward, the way ships fly.',
    }),
    emissiveLuminance: t.f32({
      default: 1000,
      min: 0,
      unit: 'cd/m²',
      description: 'Luminance of emissiveFactor 1 at strength 1 (glTF emission has no unit).',
    }),
    cameras: t.bool({ description: "Spawn the file's cameras." }),
    lights: t.bool({ description: "Spawn the file's lights (KHR_lights_punctual)." }),
    generateNormals: t.enum(['missing', 'always', 'never'], {
      description: 'Flat normals for primitives without them ("missing"), for all, or never.',
    }),
  },
  { description: 'Import settings for .gltf and .glb files.' },
)

// --- skins and animations (played by M6) --------------------------------------------

export interface SkinAsset {
  name: string
  /** Joint entity paths, relative to the model root (e.g. "Armature/Hips/Spine"). */
  joints: string[]
  skeleton?: string
  /** Each joint's rest pose (local TRS), for retargeting. */
  restPose: { translation: number[]; rotation: number[]; scale: number[] }[]
  /** 16 floats per joint, column-major. */
  inverseBindMatrices: Float32Array
}

export interface AnimationChannel {
  target: string
  property: 'translation' | 'rotation' | 'scale' | 'weights'
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE'
  times: Float32Array
  values: Float32Array
  components: number
}

export interface AnimationClipAsset {
  name: string
  duration: number
  channels: AnimationChannel[]
}

export const Skins = defineResource<AssetStore<SkinAsset, 'Skin'>>('gltf/Skins', {
  description: 'Skins (joints, inverse bind matrices, rest pose) by guid.',
  init: () => new AssetStore('Skin'),
})

export const AnimationClips = defineResource<AssetStore<AnimationClipAsset, 'AnimationClip'>>(
  'gltf/AnimationClips',
  { description: 'Animation clips by guid.', init: () => new AssetStore('AnimationClip') },
)

interface SkinHeader extends Omit<SkinAsset, 'inverseBindMatrices'> {
  matrices: number
}

interface ClipHeader {
  name: string
  duration: number
  channels: (Omit<AnimationChannel, 'times' | 'values'> & {
    times: [number, number]
    values: [number, number]
  })[]
}

export const SkinAssetType = defineAssetType<SkinAsset>('Skin', {
  store: Skins,
  load: (artifact) => {
    const header = artifact.json as unknown as SkinHeader
    const bytes = artifact.bytes!.slice()
    return {
      ...header,
      inverseBindMatrices: new Float32Array(bytes.buffer, 0, header.matrices * 16),
    }
  },
})

export const AnimationClipAssetType = defineAssetType<AnimationClipAsset>('AnimationClip', {
  store: AnimationClips,
  load: (artifact) => {
    const header = artifact.json as unknown as ClipHeader
    const data = new Float32Array(artifact.bytes!.slice().buffer)
    return {
      name: header.name,
      duration: header.duration,
      channels: header.channels.map((c) => ({
        ...c,
        times: data.subarray(c.times[0], c.times[0] + c.times[1]),
        values: data.subarray(c.values[0], c.values[0] + c.values[1]),
      })),
    }
  },
})

// --- helpers --------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([
  'KHR_lights_punctual',
  'KHR_materials_emissive_strength',
  'KHR_mesh_quantization',
  'KHR_texture_transform',
])

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_') || '_'
}

/** Labels for a list: the sanitized name when it's present and unique, otherwise the index. */
function labels(items: readonly { name?: string }[] | undefined): string[] {
  const list = items ?? []
  const counts = new Map<string, number>()
  for (const item of list) {
    if (item.name) counts.set(sanitize(item.name), (counts.get(sanitize(item.name)) ?? 0) + 1)
  }
  return list.map((item, i) => {
    const name = item.name ? sanitize(item.name) : undefined
    return name && counts.get(name) === 1 && !/^\d+$/.test(name) ? name : String(i)
  })
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',')
  const meta = uri.slice(5, comma)
  const data = uri.slice(comma + 1)
  if (meta.endsWith(';base64')) return Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  return new TextEncoder().encode(decodeURIComponent(data))
}

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q
  const ix = w * v[0] + y * v[2] - z * v[1]
  const iy = w * v[1] + z * v[0] - x * v[2]
  const iz = w * v[2] + x * v[1] - y * v[0]
  const iw = -x * v[0] - y * v[1] - z * v[2]
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ]
}

/** A node's local translation, rotation, and scale (decomposing `matrix` if given). */
function trs(node: GltfNode): { t: Vec3; r: Quat; s: Vec3 } {
  if (!node.matrix) {
    return {
      t: (node.translation as Vec3) ?? [0, 0, 0],
      r: (node.rotation as Quat) ?? [0, 0, 0, 1],
      s: (node.scale as Vec3) ?? [1, 1, 1],
    }
  }
  const m = node.matrix
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!)
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!)
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!)
  const det =
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) +
    m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!)
  if (det < 0) sx = -sx
  const r00 = m[0]! / sx
  const r10 = m[1]! / sx
  const r20 = m[2]! / sx
  const r01 = m[4]! / sy
  const r11 = m[5]! / sy
  const r21 = m[6]! / sy
  const r02 = m[8]! / sz
  const r12 = m[9]! / sz
  const r22 = m[10]! / sz
  const trace = r00 + r11 + r22
  let q: Quat
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4]
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    q = [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s]
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    q = [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s]
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2
    q = [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s]
  }
  return { t: [m[12]!, m[13]!, m[14]!], r: q, s: [sx, sy, sz] }
}

/** Column-major 4x4 from TRS. */
function matrixOf(t: Vec3, r: Quat, s: Vec3): number[] {
  const [x, y, z, w] = r
  const xx = x * x
  const yy = y * y
  const zz = z * z
  const xy = x * y
  const xz = x * z
  const yz = y * z
  const wx = w * x
  const wy = w * y
  const wz = w * z
  return [
    (1 - 2 * (yy + zz)) * s[0],
    2 * (xy + wz) * s[0],
    2 * (xz - wy) * s[0],
    0,
    2 * (xy - wz) * s[1],
    (1 - 2 * (xx + zz)) * s[1],
    2 * (yz + wx) * s[1],
    0,
    2 * (xz + wy) * s[2],
    2 * (yz - wx) * s[2],
    (1 - 2 * (xx + yy)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ]
}

function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b[c * 4]! +
        a[4 + r]! * b[c * 4 + 1]! +
        a[8 + r]! * b[c * 4 + 2]! +
        a[12 + r]! * b[c * 4 + 3]!
    }
  }
  return out
}

/** Flat normals: every triangle gets its own three vertices. */
function flatShade(data: MeshData): MeshData {
  const tri = data.indices ?? Uint32Array.from({ length: data.positions.length / 3 }, (_, i) => i)
  const n = tri.length
  const expand = (arr: Float32Array | Uint16Array | undefined, width: number) => {
    if (!arr) return undefined
    const out = new (arr.constructor as new (n: number) => Float32Array | Uint16Array)(n * width)
    for (let i = 0; i < n; i++)
      for (let c = 0; c < width; c++) out[i * width + c] = arr[tri[i]! * width + c]!
    return out
  }
  const positions = expand(data.positions, 3) as Float32Array
  const normals = new Float32Array(n * 3)
  for (let i = 0; i < n; i += 3) {
    const a = i * 3
    const ux = positions[a + 3]! - positions[a]!
    const uy = positions[a + 4]! - positions[a + 1]!
    const uz = positions[a + 5]! - positions[a + 2]!
    const vx = positions[a + 6]! - positions[a]!
    const vy = positions[a + 7]! - positions[a + 1]!
    const vz = positions[a + 8]! - positions[a + 2]!
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= len
    ny /= len
    nz /= len
    for (let k = 0; k < 3; k++) {
      normals[a + k * 3] = nx
      normals[a + k * 3 + 1] = ny
      normals[a + k * 3 + 2] = nz
    }
  }
  const out: MeshData = { positions, normals }
  const uvs = expand(data.uvs, 2)
  if (uvs) out.uvs = uvs as Float32Array
  const uvs1 = expand(data.uvs1, 2)
  if (uvs1) out.uvs1 = uvs1 as Float32Array
  const colors = expand(data.colors, 4)
  if (colors) out.colors = colors as Float32Array
  const joints = expand(data.joints, 4)
  if (joints) out.joints = joints as Uint16Array
  const weights = expand(data.weights, 4)
  if (weights) out.weights = weights as Float32Array
  return out
}

/** Triangle-list indices for strips (mode 5) and fans (mode 6). */
function toTriangleList(mode: number, source: ArrayLike<number>): Uint32Array {
  const out: number[] = []
  if (mode === 5) {
    for (let i = 0; i + 2 < source.length; i++) {
      if (i % 2 === 0) out.push(source[i]!, source[i + 1]!, source[i + 2]!)
      else out.push(source[i + 1]!, source[i]!, source[i + 2]!)
    }
  } else {
    for (let i = 1; i + 1 < source.length; i++) out.push(source[0]!, source[i]!, source[i + 1]!)
  }
  return Uint32Array.from(out)
}

// --- the importer --------------------------------------------------------------------------

interface Settings {
  scale: number
  forward: '+z' | '-z'
  emissiveLuminance: number
  cameras: boolean
  lights: boolean
  generateNormals: 'missing' | 'always' | 'never'
}

async function loadBuffers(doc: GltfDocument, bin: Uint8Array | undefined, ctx: ImportContext) {
  const buffers: Uint8Array[] = []
  for (const [i, buffer] of (doc.buffers ?? []).entries()) {
    const ptr = `/buffers/${i}`
    if (buffer.uri === undefined) {
      if (i === 0 && bin) buffers.push(bin)
      else throw new ShardError('gltf/buffer-missing', `Buffer ${i} has no data`, { path: ptr })
    } else if (buffer.uri.startsWith('data:')) {
      buffers.push(decodeDataUri(buffer.uri))
    } else {
      try {
        buffers.push(await ctx.read(decodeURIComponent(buffer.uri)))
      } catch (cause) {
        throw new ShardError('gltf/buffer-missing', `Can't read buffer file "${buffer.uri}"`, {
          path: ptr,
          hint: 'Keep .bin files next to the .gltf, under the same name the file references.',
          cause,
        })
      }
    }
  }
  return buffers
}

const WRAP: Record<number, string> = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' }

interface TextureRefs {
  /** The path a material slot uses for glTF texture `index`, or undefined if it has no image. */
  pathOf(index: number): string | undefined
  samplerOf(index: number): { wrap: string; filter: string }
}

function convertMaterial(
  m: GltfMaterial,
  settings: Settings,
  textures: TextureRefs,
  warn: (msg: string, path?: string) => void,
  ptr: string,
) {
  const pbr = m.pbrMetallicRoughness ?? {}
  const factor = m.emissiveFactor ?? [0, 0, 0]
  const strength =
    (m.extensions?.KHR_materials_emissive_strength as { emissiveStrength?: number } | undefined)
      ?.emissiveStrength ?? 1
  const peak = Math.max(factor[0]!, factor[1]!, factor[2]!)
  if (m.alphaMode === 'BLEND') {
    warn(
      'Blended transparency arrives in M5; this material imports as an alpha mask.',
      `${ptr}/alphaMode`,
    )
  }
  const dependencies: string[] = []
  const slot = (
    info: { index: number; texCoord?: number; extensions?: Record<string, unknown> } | undefined,
  ) => {
    if (!info) return undefined
    const path = textures.pathOf(info.index)
    if (!path) return undefined
    dependencies.push(path)
    const tt = info.extensions?.KHR_texture_transform as
      | { offset?: number[]; scale?: number[]; rotation?: number; texCoord?: number }
      | undefined
    return {
      texture: { path },
      uv: tt?.texCoord ?? info.texCoord ?? 0,
      offset: tt?.offset ?? [0, 0],
      scale: tt?.scale ?? [1, 1],
      rotation: tt?.rotation ?? 0,
      ...textures.samplerOf(info.index),
    }
  }
  const value: Record<string, unknown> = {
    baseColor: pbr.baseColorFactor ?? [1, 1, 1, 1],
    metallic: pbr.metallicFactor ?? 1,
    roughness: pbr.roughnessFactor ?? 1,
    emissive:
      peak > 0 ? [factor[0]! / peak, factor[1]! / peak, factor[2]! / peak, 1] : [1, 1, 1, 1],
    // An emissive texture with no factor still means "emissive": glTF's factor defaults to 0 though.
    emissiveLuminance: peak * strength * settings.emissiveLuminance,
    doubleSided: m.doubleSided ?? false,
    alphaMode: m.alphaMode === 'MASK' || m.alphaMode === 'BLEND' ? 'mask' : 'opaque',
    alphaCutoff: m.alphaMode === 'BLEND' ? 0.5 : (m.alphaCutoff ?? 0.5),
    normalScale: m.normalTexture?.scale ?? 1,
    occlusionStrength: m.occlusionTexture?.strength ?? 1,
  }
  const slots = {
    baseColorTexture: slot(pbr.baseColorTexture),
    metallicRoughnessTexture: slot(pbr.metallicRoughnessTexture),
    normalTexture: slot(m.normalTexture),
    occlusionTexture: slot(m.occlusionTexture),
    emissiveTexture: slot(m.emissiveTexture),
  }
  for (const [k, v] of Object.entries(slots)) if (v) value[k] = v
  return { json: StandardMaterial.serialize(StandardMaterial.deserialize(value)), dependencies }
}

/** MikkTSpace tangents (the convention baked normal maps use). Needs unindexed triangles. */
async function generateTangents(data: MeshData): Promise<MeshData> {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new ShardError(
      'gltf/tangents-unavailable',
      'Generating tangents needs a Node host (the CLI or shard dev)',
    )
  }
  const { createRequire } = await import('node:module')
  const mikk = createRequire(import.meta.url)('mikktspace') as {
    generateTangents(p: Float32Array, n: Float32Array, uv: Float32Array): Float32Array
  }
  const tri = data.indices ?? Uint32Array.from({ length: data.positions.length / 3 }, (_, i) => i)
  const expand = <T extends Float32Array | Uint16Array>(
    arr: T | undefined,
    width: number,
  ): T | undefined => {
    if (!arr) return undefined
    const out = new (arr.constructor as new (n: number) => T)(tri.length * width)
    for (let i = 0; i < tri.length; i++)
      for (let c = 0; c < width; c++) out[i * width + c] = arr[tri[i]! * width + c]!
    return out
  }
  const out: MeshData = { positions: expand(data.positions, 3)! }
  out.normals = expand(data.normals, 3)
  out.uvs = expand(data.uvs, 2)
  if (data.uvs1) out.uvs1 = expand(data.uvs1, 2)
  if (data.colors) out.colors = expand(data.colors, 4)
  if (data.joints) out.joints = expand(data.joints, 4)
  if (data.weights) out.weights = expand(data.weights, 4)
  const tangents = mikk.generateTangents(out.positions, out.normals!, out.uvs!)
  // MikkTSpace's bitangent sign is the opposite of glTF's UV convention.
  for (let i = 3; i < tangents.length; i += 4) tangents[i] = -tangents[i]!
  out.tangents = tangents
  return out
}

function buildPrimitive(
  prim: GltfPrimitive,
  acc: Accessors,
  settings: Settings,
  warn: (msg: string, path?: string) => void,
  ptr: string,
): MeshData | undefined {
  const mode = prim.mode ?? 4
  if (mode < 4) {
    warn(`Primitive mode ${mode} (points/lines) isn't supported; skipped.`, `${ptr}/mode`)
    return undefined
  }
  if (prim.attributes.POSITION === undefined) {
    throw new ShardError('gltf/invalid', 'Primitive has no POSITION attribute', {
      path: `${ptr}/attributes`,
    })
  }
  if (prim.targets?.length)
    warn('Morph targets arrive with animation (M6); ignored.', `${ptr}/targets`)
  const a = prim.attributes
  const data: MeshData = { positions: acc.floats(a.POSITION!) }
  if (a.NORMAL !== undefined) data.normals = acc.floats(a.NORMAL)
  if (a.TEXCOORD_0 !== undefined) data.uvs = acc.floats(a.TEXCOORD_0)
  if (a.TEXCOORD_1 !== undefined) data.uvs1 = acc.floats(a.TEXCOORD_1)
  if (a.TANGENT !== undefined) data.tangents = acc.floats(a.TANGENT)
  if (a.WEIGHTS_0 !== undefined) data.weights = acc.floats(a.WEIGHTS_0)
  if (a.JOINTS_0 !== undefined) data.joints = Uint16Array.from(acc.read(a.JOINTS_0).values)
  if (a.COLOR_0 !== undefined) {
    const c = acc.read(a.COLOR_0)
    if (c.components === 4) data.colors = Float32Array.from(c.values)
    else {
      const colors = new Float32Array(c.count * 4)
      for (let i = 0; i < c.count; i++) {
        colors[i * 4] = c.values[i * 3]!
        colors[i * 4 + 1] = c.values[i * 3 + 1]!
        colors[i * 4 + 2] = c.values[i * 3 + 2]!
        colors[i * 4 + 3] = 1
      }
      data.colors = colors
    }
  }
  const vertexCount = data.positions.length / 3
  let indices: Uint32Array | undefined =
    prim.indices === undefined ? undefined : Uint32Array.from(acc.read(prim.indices).values)
  if (mode === 5 || mode === 6) {
    indices = toTriangleList(
      mode,
      indices ?? Uint32Array.from({ length: vertexCount }, (_, i) => i),
    )
  }
  if (indices) data.indices = indices
  let out = data
  if (
    settings.generateNormals === 'always' ||
    (settings.generateNormals === 'missing' && !data.normals)
  ) {
    out = flatShade(data)
    if (data.tangents) warn('Tangents were dropped when generating flat normals.', ptr)
  }
  if (out.indices && out.positions.length / 3 <= 65536) out.indices = Uint16Array.from(out.indices)
  return out
}

export const GltfImporter = defineImporter({
  name: 'gltf',
  version: 2,
  extensions: ['.gltf', '.glb'],
  settings: GltfImportSettings,
  async import(source, ctx) {
    const settings = ctx.settings as unknown as Settings
    const { json: doc, bin } = parseGltf(source.bytes)
    for (const [i, ext] of (doc.extensionsRequired ?? []).entries()) {
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        throw new ShardError(
          'gltf/unsupported-extension',
          `This file requires ${ext}, which isn't supported`,
          {
            path: `/extensionsRequired/${i}`,
            hint:
              ext.includes('draco') || ext.includes('meshopt')
                ? 'Re-export without mesh compression.'
                : 'Re-export without this extension.',
          },
        )
      }
    }
    for (const ext of doc.extensionsUsed ?? []) {
      if (!SUPPORTED_EXTENSIONS.has(ext) && !(doc.extensionsRequired ?? []).includes(ext)) {
        ctx.warn(`Optional extension ${ext} is ignored.`)
      }
    }
    const buffers = await loadBuffers(doc, bin, ctx)
    const acc = new Accessors(doc, buffers)
    const assets: ImportedAsset[] = []

    // Images: how each is used decides its import settings (sRGB color vs linear data vs normal).
    const imageUsage = new Map<number, TextureUsage>()
    const imageOf = (textureIndex: number): number | undefined => {
      const tex = doc.textures?.[textureIndex]
      const basisu = (tex?.extensions?.KHR_texture_basisu as { source?: number } | undefined)
        ?.source
      return basisu ?? tex?.source
    }
    const use = (info: { index: number } | undefined, usage: TextureUsage, ptr: string) => {
      if (!info) return
      const image = imageOf(info.index)
      if (image === undefined) return
      const previous = imageUsage.get(image)
      if (previous && previous !== usage) {
        ctx.warn(
          `Image ${image} is used as both ${previous} and ${usage}; importing it as ${previous}.`,
          ptr,
        )
        return
      }
      imageUsage.set(image, usage)
    }
    for (const [i, m] of (doc.materials ?? []).entries()) {
      const ptr = `/materials/${i}`
      use(
        m.pbrMetallicRoughness?.baseColorTexture,
        'color',
        `${ptr}/pbrMetallicRoughness/baseColorTexture`,
      )
      use(m.emissiveTexture, 'color', `${ptr}/emissiveTexture`)
      use(
        m.pbrMetallicRoughness?.metallicRoughnessTexture,
        'data',
        `${ptr}/pbrMetallicRoughness/metallicRoughnessTexture`,
      )
      use(m.occlusionTexture, 'data', `${ptr}/occlusionTexture`)
      use(m.normalTexture, 'normal', `${ptr}/normalTexture`)
    }
    const imageLabels = labels(doc.images).map((l) => `Texture/${l}`)
    const imagePaths = new Map<number, string>()
    for (const [i, image] of (doc.images ?? []).entries()) {
      const ptr = `/images/${i}`
      const usage = imageUsage.get(i) ?? 'color'
      let bytes: Uint8Array | undefined
      if (image.bufferView !== undefined) {
        const bv = doc.bufferViews?.[image.bufferView]
        const buffer = bv ? buffers[bv.buffer] : undefined
        if (!bv || !buffer)
          throw new ShardError('gltf/invalid', `Image ${i} has an invalid bufferView`, {
            path: ptr,
          })
        bytes = buffer.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
      } else if (image.uri?.startsWith('data:')) {
        bytes = decodeDataUri(image.uri)
      } else if (image.uri) {
        // An external image is its own asset (with its own .meta); materials reference it by path.
        const path = ctx.resolve(decodeURIComponent(image.uri))
        imagePaths.set(i, path)
        try {
          const meta = JSON.parse(
            new TextDecoder().decode(await ctx.read(`${decodeURIComponent(image.uri)}.meta`)),
          )
          const declared = meta?.settings?.usage
          if (declared && declared !== usage) {
            ctx.warn(
              `gltf/texture-usage-mismatch: ${path} is imported as "${declared}" but this model uses it as "${usage}"`,
              ptr,
            )
          }
        } catch {
          // No .meta yet: the texture importer will pick a usage from the file name.
        }
        continue
      }
      if (!bytes) continue
      const { bytes: artifact, info } = await importImageBytes(
        bytes,
        {
          usage,
          mipmaps: true,
          compression: 'none',
          maxSize: 4096,
          flipY: false,
          premultiplyAlpha: false,
        },
        (m) => ctx.warn(m, ptr),
      )
      imagePaths.set(i, `#${imageLabels[i]}`)
      assets.push({ label: imageLabels[i]!, type: 'Texture', bytes: artifact, info })
    }
    const textureRefs: TextureRefs = {
      pathOf: (index) => {
        const image = imageOf(index)
        return image === undefined ? undefined : imagePaths.get(image)
      },
      samplerOf: (index) => {
        const sampler = doc.samplers?.[doc.textures?.[index]?.sampler ?? -1]
        return {
          wrap: WRAP[sampler?.wrapS ?? 10497] ?? 'repeat',
          filter: sampler?.magFilter === 9728 ? 'nearest' : 'linear',
        }
      },
    }

    // Materials.
    const materialLabels = labels(doc.materials).map((l) => `Material/${l}`)
    for (const [i, m] of (doc.materials ?? []).entries()) {
      const { json, dependencies } = convertMaterial(
        m,
        settings,
        textureRefs,
        ctx.warn,
        `/materials/${i}`,
      )
      assets.push({
        label: materialLabels[i]!,
        type: 'Material',
        json,
        ...(dependencies.length ? { dependencies } : {}),
      })
    }

    // Meshes: one Mesh per primitive.
    const meshLabels = labels(doc.meshes)
    const primLabels: (string | undefined)[][] = []
    for (const [mi, mesh] of (doc.meshes ?? []).entries()) {
      const out: (string | undefined)[] = []
      for (const [pi, prim] of mesh.primitives.entries()) {
        const ptr = `/meshes/${mi}/primitives/${pi}`
        let data = buildPrimitive(prim, acc, settings, ctx.warn, ptr)
        if (!data) {
          out.push(undefined)
          continue
        }
        const material = prim.material === undefined ? undefined : doc.materials?.[prim.material]
        if (material?.normalTexture && !data.tangents && data.normals && data.uvs) {
          data = await generateTangents(data)
        }
        let built: Mesh
        try {
          built = Mesh.create(data)
        } catch (err) {
          throw new ShardError('gltf/invalid', `${ptr}: ${(err as Error).message}`, {
            path: ptr,
            cause: err,
          })
        }
        const label =
          mesh.primitives.length === 1 ? `Mesh/${meshLabels[mi]}` : `Mesh/${meshLabels[mi]}/${pi}`
        out.push(label)
        const b = built.bounds
        assets.push({
          label,
          type: 'Mesh',
          bytes: encodeMesh(built),
          info: {
            vertices: built.vertexCount,
            triangles: Math.floor(built.drawCount / 3),
            bounds: { min: [b[0]!, b[1]!, b[2]!], max: [b[3]!, b[4]!, b[5]!] },
          },
        })
      }
      primLabels.push(out)
    }

    // Scenes: node trees. Paths are computed from the default scene (for skins and animations).
    const nodes = doc.nodes ?? []
    const nodePaths = new Map<number, string>()
    const rootRotation: Quat = settings.forward === '-z' ? [0, 1, 0, 0] : [0, 0, 0, 1]
    const rootScale = settings.scale
    const lights =
      (
        doc.extensions?.KHR_lights_punctual as
          | { lights?: { type: string; intensity?: number; color?: number[] }[] }
          | undefined
      )?.lights ?? []

    const buildScene = (roots: number[], record: boolean) => {
      const deps = new Set<string>()
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      const paths: string[] = []
      const build = (
        ni: number,
        siblings: Set<string>,
        parentPath: string,
        parentMatrix: number[],
        top: boolean,
        stack: Set<number>,
      ): SceneEntity => {
        const node = nodes[ni]
        if (!node) throw new ShardError('gltf/invalid', `No node ${ni}`, { path: `/nodes/${ni}` })
        if (stack.has(ni))
          throw new ShardError('gltf/invalid', `Node ${ni} is its own ancestor`, {
            path: `/nodes/${ni}`,
          })
        let name = sanitize(node.name ?? `Node${ni}`)
        for (let k = 2; siblings.has(name); k++) name = `${sanitize(node.name ?? `Node${ni}`)}_${k}`
        siblings.add(name)
        const path = parentPath ? `${parentPath}/${name}` : name
        if (record && !nodePaths.has(ni)) nodePaths.set(ni, path)
        paths.push(path)
        let { t: tr, r, s: sc } = trs(node)
        if (top && (rootScale !== 1 || settings.forward === '-z')) {
          tr = rotate(rootRotation, [tr[0] * rootScale, tr[1] * rootScale, tr[2] * rootScale])
          r = quatMul(rootRotation, r)
          sc = [sc[0] * rootScale, sc[1] * rootScale, sc[2] * rootScale]
        }
        const world = mul4(parentMatrix, matrixOf(tr, r, sc))
        const components: Record<string, JsonValue> = {
          'core/Transform': { translation: [...tr], rotation: [...r], scale: [...sc] },
        }
        const children: SceneEntity[] = []
        if (node.mesh !== undefined) {
          const mesh = doc.meshes?.[node.mesh]
          const prims = primLabels[node.mesh] ?? []
          let first = true
          for (const [pi, label] of prims.entries()) {
            if (!label) continue
            const materialIndex = mesh?.primitives[pi]?.material
            const comps: Record<string, JsonValue> = {
              'render/Mesh3d': { mesh: { path: `#${label}` } },
            }
            deps.add(`#${label}`)
            if (materialIndex !== undefined && materialLabels[materialIndex]) {
              comps['render/MeshMaterial'] = {
                material: { path: `#${materialLabels[materialIndex]}` },
              }
              deps.add(`#${materialLabels[materialIndex]}`)
            }
            // Bounds: transform the mesh's box corners by the node's world matrix.
            const info = assets.find((x) => x.label === label)?.info as {
              bounds: { min: number[]; max: number[] }
            }
            for (let c = 0; c < 8; c++) {
              const p = [
                c & 1 ? info.bounds.max[0]! : info.bounds.min[0]!,
                c & 2 ? info.bounds.max[1]! : info.bounds.min[1]!,
                c & 4 ? info.bounds.max[2]! : info.bounds.min[2]!,
              ]
              for (let k = 0; k < 3; k++) {
                const v =
                  world[k]! * p[0]! + world[4 + k]! * p[1]! + world[8 + k]! * p[2]! + world[12 + k]!
                min[k] = Math.min(min[k]!, v)
                max[k] = Math.max(max[k]!, v)
              }
            }
            if (first) {
              Object.assign(components, comps)
              first = false
            } else {
              children.push({ name: String(pi), components: { 'core/Transform': {}, ...comps } })
            }
          }
        }
        if (node.camera !== undefined && settings.cameras) {
          const cam = doc.cameras?.[node.camera]
          if (cam?.type === 'perspective' && cam.perspective) {
            components['render/Camera3d'] = {
              fovY: (cam.perspective.yfov * 180) / Math.PI,
              near: cam.perspective.znear,
            }
          } else if (cam?.orthographic) {
            components['render/Camera3d'] = {
              projection: 'orthographic',
              orthoHeight: cam.orthographic.ymag * 2,
              near: cam.orthographic.znear,
              far: cam.orthographic.zfar,
            }
          }
        }
        const lightIndex = (node.extensions?.KHR_lights_punctual as { light?: number } | undefined)
          ?.light
        if (lightIndex !== undefined && settings.lights) {
          const light = lights[lightIndex]
          if (light?.type === 'directional') {
            components['render/DirectionalLight'] = {
              illuminance: light.intensity ?? 1,
              color: [...(light.color ?? [1, 1, 1]), 1],
            }
          } else if (light) {
            ctx.warn(`${light.type} lights arrive with renderer v1 (M5); skipped.`, `/nodes/${ni}`)
          }
        }
        const next = new Set<string>()
        const childStack = new Set(stack).add(ni)
        for (const child of node.children ?? [])
          children.push(build(child, next, path, world, false, childStack))
        return {
          name,
          components: components as Record<string, Record<string, JsonValue>>,
          ...(children.length ? { children } : {}),
        }
      }
      const top = new Set<string>()
      const entities = roots.map((ni) =>
        build(ni, top, '', matrixOf([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), true, new Set()),
      )
      const file: SceneFile = { version: 1, entities }
      const bounds = Number.isFinite(min[0]!) ? { min, max } : null
      return {
        file,
        deps: [...deps],
        info: { nodes: paths.length, bounds, paths: paths.slice(0, 200) },
      }
    }

    const scenes = doc.scenes?.length
      ? doc.scenes
      : [
          {
            nodes: nodes
              .map((_, i) => i)
              .filter((i) => !nodes.some((n) => n.children?.includes(i))),
          },
        ]
    const defaultScene = doc.scene ?? 0
    const sceneLabels = labels(scenes)
    // The default scene first, so node paths come from it.
    const order = [defaultScene, ...scenes.map((_, i) => i).filter((i) => i !== defaultScene)]
    for (const si of order) {
      const scene = scenes[si]
      if (!scene) continue
      const built = buildScene(scene.nodes ?? [], si === defaultScene)
      const payload = {
        json: built.file as unknown as JsonValue,
        dependencies: built.deps,
        info: built.info,
      }
      if (si === defaultScene) assets.push({ label: 'Scene', type: 'Scene', ...payload })
      if (scenes.length > 1)
        assets.push({ label: `Scene/${sceneLabels[si]}`, type: 'Scene', ...payload })
    }
    const pathOf = (ni: number) => nodePaths.get(ni) ?? sanitize(nodes[ni]?.name ?? `Node${ni}`)

    // Skins.
    const skinLabels = labels(doc.skins)
    for (const [i, skin] of (doc.skins ?? []).entries()) {
      const matrices =
        skin.inverseBindMatrices === undefined
          ? new Float32Array(skin.joints.length * 16).map((_, k) => (k % 17 === 0 ? 1 : 0))
          : acc.floats(skin.inverseBindMatrices)
      const header: SkinHeader = {
        name: skin.name ?? skinLabels[i]!,
        joints: skin.joints.map(pathOf),
        ...(skin.skeleton !== undefined ? { skeleton: pathOf(skin.skeleton) } : {}),
        restPose: skin.joints.map((j) => {
          const { t: tr, r, s } = trs(nodes[j] ?? {})
          return { translation: tr, rotation: r, scale: s }
        }),
        matrices: skin.joints.length,
      }
      assets.push({
        label: `Skin/${skinLabels[i]}`,
        type: 'Skin',
        json: header as unknown as JsonValue,
        bytes: new Uint8Array(matrices.buffer.slice(0)),
        info: { joints: skin.joints.length },
      })
    }

    // Animations.
    const animationLabels = labels(doc.animations)
    for (const [i, anim] of (doc.animations ?? []).entries()) {
      const chunks: Float32Array[] = []
      let offset = 0
      const push = (data: Float32Array): [number, number] => {
        chunks.push(data)
        const at: [number, number] = [offset, data.length]
        offset += data.length
        return at
      }
      let duration = 0
      const channels: ClipHeader['channels'] = []
      for (const [ci, ch] of anim.channels.entries()) {
        const sampler = anim.samplers[ch.sampler]
        if (!sampler || ch.target.node === undefined) {
          ctx.warn(
            'Animation channel without a node or sampler; skipped.',
            `/animations/${i}/channels/${ci}`,
          )
          continue
        }
        const times = acc.floats(sampler.input)
        const out = acc.read(sampler.output)
        duration = Math.max(duration, times[times.length - 1] ?? 0)
        channels.push({
          target: pathOf(ch.target.node),
          property: ch.target.path as AnimationChannel['property'],
          interpolation: (sampler.interpolation ?? 'LINEAR') as AnimationChannel['interpolation'],
          components: out.components,
          times: push(times),
          values: push(Float32Array.from(out.values)),
        })
      }
      const data = new Float32Array(offset)
      let at = 0
      for (const c of chunks) {
        data.set(c, at)
        at += c.length
      }
      assets.push({
        label: `Animation/${animationLabels[i]}`,
        type: 'AnimationClip',
        json: {
          name: anim.name ?? animationLabels[i]!,
          duration,
          channels,
        } as unknown as JsonValue,
        bytes: new Uint8Array(data.buffer),
        info: { channels: channels.length, duration },
      })
    }
    return { assets }
  },
})
