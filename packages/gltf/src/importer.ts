import { type AnimationChannel, clipInfo, encodeClip, type Interpolation } from '@shard/animation'
import { defineImporter, type ImportContext, type ImportedAsset } from '@shard/assets'
import { defineSchema, type JsonValue, ShardError, t } from '@shard/core'
import { encodeMesh, Mesh, type MeshData, type MorphTarget } from '@shard/mesh'
import { MAX_JOINTS, StandardMaterial, skinArtifact } from '@shard/render'
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
    lods: t.enum(['auto', 'none'], {
      description:
        'Level of detail: "auto" turns MSFT_lod chains and sibling nodes named <name>_LOD0, _LOD1… into one entity with a render/Lod component; "none" imports every node as is.',
    }),
    materialTypes: t.json({
      default: {},
      description:
        'Material types by glTF material name: { "Lava*": "my-game/Lava" } (* matches anything). A material\'s extras.shardMaterial names a type directly. Imported materials are StandardMaterial otherwise.',
    }),
  },
  { description: 'Import settings for .gltf and .glb files.' },
)

/** The project material type a glTF material maps to, by extras or by name pattern. */
function materialTypeFor(
  material: { name?: string; extras?: unknown },
  patterns: unknown,
): string | undefined {
  const extra = (material.extras as { shardMaterial?: unknown } | undefined)?.shardMaterial
  if (typeof extra === 'string') return extra
  if (!patterns || typeof patterns !== 'object') return undefined
  const name = material.name ?? ''
  for (const [pattern, type] of Object.entries(patterns as Record<string, unknown>)) {
    if (typeof type !== 'string') continue
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    if (re.test(name)) return type
  }
  return undefined
}

// --- helpers --------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([
  'KHR_lights_punctual',
  'KHR_materials_emissive_strength',
  'KHR_mesh_quantization',
  'KHR_texture_transform',
  'MSFT_lod',
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
  if (data.targets) out.targets = data.targets.map((t) => expandTarget(t, expand))
  return out
}

function expandTarget(
  target: MorphTarget,
  expand: (arr: Float32Array | undefined, width: number) => unknown,
): MorphTarget {
  const out: MorphTarget = { positions: expand(target.positions, 3) as Float32Array }
  if (target.normals) out.normals = expand(target.normals, 3) as Float32Array
  if (target.tangents) out.tangents = expand(target.tangents, 3) as Float32Array
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
  materialTypes: Record<string, string>
  lods: 'auto' | 'none'
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
  if (data.targets) out.targets = data.targets.map((t) => expandTarget(t, (a, w) => expand(a, w)))
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
  if (prim.targets?.length) {
    data.targets = prim.targets.map((target, k) => {
      if (target.POSITION === undefined) {
        throw new ShardError('gltf/invalid', 'Morph target has no POSITION', {
          path: `${ptr}/targets/${k}`,
        })
      }
      const out: MorphTarget = { positions: acc.floats(target.POSITION) }
      if (target.NORMAL !== undefined) out.normals = acc.floats(target.NORMAL)
      if (target.TANGENT !== undefined) out.tangents = acc.floats(target.TANGENT)
      return out
    })
    if (data.targets.length > 8)
      warn(
        `${data.targets.length} morph targets: the 8 heaviest at a time are applied.`,
        `${ptr}/targets`,
      )
  }
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
  version: 3,
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
      const materialType = materialTypeFor(m, settings.materialTypes)
      assets.push({
        label: materialLabels[i]!,
        type: 'Material',
        json: materialType ? { type: materialType, ...(json as object) } : json,
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
    const skinLabels = labels(doc.skins)
    // Every entity a node's primitives become: the node itself, then children "1", "2"…
    const primitivePaths = new Map<number, string[]>()
    const nodePaths = new Map<number, string>()
    const rootRotation: Quat = settings.forward === '-z' ? [0, 1, 0, 0] : [0, 0, 0, 1]
    const rootScale = settings.scale
    const lights =
      (
        doc.extensions?.KHR_lights_punctual as
          | {
              lights?: {
                type: string
                intensity?: number
                color?: number[]
                range?: number
                spot?: { innerConeAngle?: number; outerConeAngle?: number }
              }[]
            }
          | undefined
      )?.lights ?? []

    // LOD chains: a base node and its lower levels (MSFT_lod ids, or _LOD<n> siblings), with the
    // MSFT screen coverage when the file has one.
    type LodChain = { ids: number[]; coverage: number[] | undefined }
    const lodOn = settings.lods !== 'none'
    const msftLower = new Set<number>()
    if (lodOn) {
      for (const node of nodes) {
        const ids = (node.extensions?.MSFT_lod as { ids?: number[] } | undefined)?.ids
        for (const id of ids ?? []) msftLower.add(id)
      }
    }
    const LOD_NAME = /^(.*)_LOD(\d+)$/i
    /** The siblings to build, and the LOD chain of each base node among them. */
    const lodGroups = (indices: readonly number[]) => {
      const chains = new Map<number, LodChain>()
      if (!lodOn) return { build: indices, chains }
      const build: number[] = []
      const byName = new Map<string, { level: number; ni: number }[]>()
      for (const ni of indices) {
        if (msftLower.has(ni)) continue
        const node = nodes[ni]
        const ids = (node?.extensions?.MSFT_lod as { ids?: number[] } | undefined)?.ids
        if (ids?.length) {
          const coverage = (node?.extras as { MSFT_screencoverage?: number[] } | undefined)
            ?.MSFT_screencoverage
          chains.set(ni, { ids, coverage })
          build.push(ni)
          continue
        }
        const match = LOD_NAME.exec(node?.name ?? '')
        if (match && node?.mesh !== undefined) {
          const group = byName.get(match[1]!) ?? []
          group.push({ level: Number(match[2]), ni })
          byName.set(match[1]!, group)
          continue
        }
        build.push(ni)
      }
      for (const group of byName.values()) {
        group.sort((a, b) => a.level - b.level)
        const [base, ...lower] = group
        build.push(base!.ni)
        if (lower.length) chains.set(base!.ni, { ids: lower.map((l) => l.ni), coverage: undefined })
      }
      return { build, chains }
    }
    /**
     * Screen size (diameter / viewport height) for LOD level k of n. MSFT coverage is a fraction of
     * the screen's area, so its square root; without one, each level halves twice, and the last
     * level always draws.
     */
    const lodScreenSize = (k: number, n: number, coverage: number[] | undefined) => {
      const c = coverage?.[k]
      if (c !== undefined) return Math.sqrt(Math.max(0, c))
      return k === n - 1 ? 0 : 0.25 / 4 ** k
    }

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
        lod?: LodChain,
      ): SceneEntity => {
        const node = nodes[ni]
        if (!node) throw new ShardError('gltf/invalid', `No node ${ni}`, { path: `/nodes/${ni}` })
        if (stack.has(ni))
          throw new ShardError('gltf/invalid', `Node ${ni} is its own ancestor`, {
            path: `/nodes/${ni}`,
          })
        // A _LOD0 base names the entity without its suffix.
        const baseName =
          lod && LOD_NAME.test(node.name ?? '') ? LOD_NAME.exec(node.name!)![1]! : node.name
        let name = sanitize(baseName ?? `Node${ni}`)
        for (let k = 2; siblings.has(name); k++) name = `${sanitize(baseName ?? `Node${ni}`)}_${k}`
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
            if (node.skin !== undefined && skinLabels[node.skin] !== undefined) {
              comps['render/SkinnedMesh'] = { skin: { path: `#Skin/${skinLabels[node.skin]}` } }
              deps.add(`#Skin/${skinLabels[node.skin]}`)
            }
            const targets = mesh?.primitives[pi]?.targets?.length ?? 0
            if (targets > 0) {
              const initial = node.weights ?? mesh?.weights ?? []
              comps['render/MorphWeights'] = {
                weights: Array.from({ length: targets }, (_, k) => initial[k] ?? 0),
              }
            }
            if (lod) {
              // Level k of this primitive is the same primitive of the k-th lower node's mesh.
              const levels = [label]
              for (const id of lod.ids) {
                const lower = nodes[id]?.mesh
                const lowerLabel = lower === undefined ? undefined : primLabels[lower]?.[pi]
                if (lowerLabel) levels.push(lowerLabel)
              }
              if (levels.length > 1) {
                comps['render/Lod'] = {
                  levels: levels.map((l, k) => {
                    deps.add(`#${l}`)
                    return {
                      mesh: { path: `#${l}` },
                      screenSize: lodScreenSize(k, levels.length, lod.coverage),
                    }
                  }),
                }
              }
            }
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
            if (record) {
              const list = primitivePaths.get(ni) ?? []
              list.push(first ? path : `${path}/${pi}`)
              primitivePaths.set(ni, list)
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
          } else if (light?.type === 'point' || light?.type === 'spot') {
            // glTF point and spot intensity is candela; ours is luminous power (lm = cd · 4π).
            const candela = light.intensity ?? 1
            // No range means infinite: end where the light falls to 0.01 lux.
            const range = light.range ?? Math.min(1000, Math.max(1, Math.sqrt(candela / 0.01)))
            const value: Record<string, unknown> = {
              intensity: candela * 4 * Math.PI,
              color: [...(light.color ?? [1, 1, 1]), 1],
              range: range * (typeof rootScale === 'number' ? rootScale : 1),
            }
            if (light.type === 'spot') {
              const deg = 180 / Math.PI
              const outer = light.spot?.outerConeAngle ?? Math.PI / 4
              value.outerAngle = Math.min(89.9, Math.max(0.1, outer * deg))
              value.innerAngle = Math.min(
                value.outerAngle as number,
                (light.spot?.innerConeAngle ?? 0) * deg,
              )
              components['render/SpotLight'] = value as never
            } else {
              components['render/PointLight'] = value as never
            }
          } else if (light) {
            ctx.warn(`Unknown light type "${light.type}"; skipped.`, `/nodes/${ni}`)
          }
        }
        const next = new Set<string>()
        const childStack = new Set(stack).add(ni)
        const groups = lodGroups(node.children ?? [])
        for (const child of groups.build)
          children.push(
            build(child, next, path, world, false, childStack, groups.chains.get(child)),
          )
        return {
          name,
          components: components as Record<string, Record<string, JsonValue>>,
          ...(children.length ? { children } : {}),
        }
      }
      const top = new Set<string>()
      const rootGroups = lodGroups(roots)
      const entities = rootGroups.build.map((ni) =>
        build(
          ni,
          top,
          '',
          matrixOf([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
          true,
          new Set(),
          rootGroups.chains.get(ni),
        ),
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
    for (const [i, skin] of (doc.skins ?? []).entries()) {
      if (skin.joints.length > MAX_JOINTS) {
        throw new ShardError(
          'render/too-many-joints',
          `Skin ${i} has ${skin.joints.length} joints; skinning supports ${MAX_JOINTS}`,
          {
            path: `/skins/${i}/joints`,
            hint: 'Split the mesh, or remove helper bones before exporting.',
          },
        )
      }
      const matrices =
        skin.inverseBindMatrices === undefined
          ? new Float32Array(skin.joints.length * 16).map((_, k) => (k % 17 === 0 ? 1 : 0))
          : acc.floats(skin.inverseBindMatrices)
      const header = skinArtifact({
        name: skin.name ?? skinLabels[i]!,
        joints: skin.joints.map(pathOf),
        ...(skin.skeleton !== undefined ? { skeleton: pathOf(skin.skeleton) } : {}),
        restPose: skin.joints.map((j) => {
          const { t: tr, r, s } = trs(nodes[j] ?? {})
          return { translation: tr, rotation: r, scale: s }
        }),
      })
      assets.push({
        label: `Skin/${skinLabels[i]}`,
        type: 'Skin',
        json: header as unknown as JsonValue,
        bytes: new Uint8Array(matrices.buffer.slice(0)),
        info: { joints: skin.joints.length },
      })
    }

    // Animations: node TRS channels animate core/Transform; weights animate render/MorphWeights
    // on every entity the node's primitives became.
    const INTERPOLATION: Record<string, Interpolation> = {
      LINEAR: 'linear',
      STEP: 'step',
      CUBICSPLINE: 'cubic',
    }
    const animationLabels = labels(doc.animations)
    for (const [i, anim] of (doc.animations ?? []).entries()) {
      let duration = 0
      const channels: AnimationChannel[] = []
      for (const [ci, ch] of anim.channels.entries()) {
        const ptr = `/animations/${i}/channels/${ci}`
        const sampler = anim.samplers[ch.sampler]
        if (!sampler || ch.target.node === undefined) {
          ctx.warn('Animation channel without a node or sampler; skipped.', ptr)
          continue
        }
        const interpolation = INTERPOLATION[sampler.interpolation ?? 'LINEAR']
        if (!interpolation) {
          ctx.warn(`Unknown interpolation "${sampler.interpolation}"; skipped.`, ptr)
          continue
        }
        const times = acc.floats(sampler.input)
        const out = acc.read(sampler.output)
        const values = Float32Array.from(out.values)
        duration = Math.max(duration, times[times.length - 1] ?? 0)
        const keys = Math.max(1, times.length) * (interpolation === 'cubic' ? 3 : 1)
        const path = ch.target.path
        if (path === 'weights') {
          const width = Math.round(values.length / keys)
          const targets = primitivePaths.get(ch.target.node) ?? []
          if (targets.length === 0) ctx.warn('Weights channel on a node without a mesh.', ptr)
          for (const target of targets) {
            channels.push({
              target,
              component: 'render/MorphWeights',
              field: 'weights',
              interpolation,
              times,
              values,
              width,
            })
          }
        } else if (path === 'translation' || path === 'rotation' || path === 'scale') {
          channels.push({
            target: pathOf(ch.target.node),
            component: 'core/Transform',
            field: path,
            interpolation,
            times,
            values,
            width: out.components,
          })
        } else {
          ctx.warn(`Animation path "${path}" isn't supported; skipped.`, `${ptr}/target/path`)
        }
      }
      const clip = { name: anim.name ?? animationLabels[i]!, duration, channels, events: [] }
      assets.push({
        label: `Animation/${animationLabels[i]}`,
        type: 'AnimationClip',
        ...encodeClip(clip),
        info: clipInfo(clip),
      })
    }
    return { assets }
  },
})
