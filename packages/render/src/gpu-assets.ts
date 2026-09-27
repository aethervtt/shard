import { assetServer } from '@aethervtt/shard-assets'
import { defineResource, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'
import { FORMAT_INFO, type Texture, Textures } from '@aethervtt/shard-texture'
import { type MaterialAsset, STANDARD_TYPE, TEXTURE_SLOTS } from './assets'
import type { MaterialType } from './materials'
import { materialLayout } from './shaders'
import type { GpuMemoryData } from './stats'

export interface GpuMesh {
  version: number
  generation: number
  positions: GPUBuffer
  normals: GPUBuffer
  uvs: GPUBuffer
  uvs1: GPUBuffer
  tangents: GPUBuffer
  indices: GPUBuffer | undefined
  indexFormat: GPUIndexFormat
  count: number
  /** The index buffer belongs to every GPU mesh sharing its array (`Mesh.gpu`): never destroyed here. */
  sharedIndices: boolean
  /** The vertex buffers belong to another mesh (`Mesh.gpu` with `share`). */
  sharedVertices: boolean
  /** Where this mesh's vertices start in its (shared) vertex buffers. */
  baseVertex: number
}

export interface GpuMaterial {
  version: number
  generation: number
  /** The material type's version the GPU copy was built for. */
  typeVersion: number
  type: MaterialType
  buffer: GPUBuffer
  textureBuffer: GPUBuffer
  /** The type's own uniform, when it has numeric fields. */
  ownBuffer: GPUBuffer | undefined
  bindGroup: GPUBindGroup | undefined
  /** What the bind group was built from, to rebuild when a texture changes. */
  bound: (GpuTexture | undefined)[]
  ownBound: (GpuTexture | undefined)[]
}

export interface GpuTexture {
  texture: GPUTexture
  linear: GPUTextureView
  srgb: GPUTextureView
  /** 2D-array views (the texture's own for arrays; one layer for plain 2D textures). */
  arrayLinear: GPUTextureView | undefined
  arraySrgb: GPUTextureView | undefined
  version: number
  generation: number
  bytes: number
}

/** Color slots read through the sRGB view; data slots through the linear one. */
const SRGB_SLOT = [true, false, false, false, true]

interface SlotValue {
  texture: { guid: string | undefined } | null
  uv: number
  offset: ArrayLike<number>
  scale: ArrayLike<number>
  rotation: number
  wrap: string
  filter: string
}

/**
 * GPU copies of meshes, textures, and materials, shared by every pass that draws them (forward,
 * shadows, G-buffer, previews). Each is uploaded on first use and again when its version changes,
 * and rebuilt after a device loss.
 */
export class GpuAssets {
  readonly meshes = new Map<Mesh, GpuMesh>()
  readonly materials = new Map<MaterialAsset, GpuMaterial>()
  readonly textures = new Map<Texture, GpuTexture>()
  private defaults: { white: GpuTexture; normal: GpuTexture } | undefined
  private readonly samplers = new Map<string, GPUSampler>()
  /** Textures scratch for the slot lookup (no per-frame allocation). */
  private readonly slotTextures: (Texture | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]
  /** Guids reloading after device loss, so each is requested once. */
  private readonly reloading = new Set<string>()
  /** Per frame: whether each material's textures are available. */
  private readonly ready = new Map<MaterialAsset, boolean>()
  private readonly materialBytes = new DataView(new ArrayBuffer(materialLayout.size))
  private ownBytes = new DataView(new ArrayBuffer(256))
  /** The type's own textures for the material being resolved. */
  private readonly ownTextures: (Texture | undefined)[] = []
  private readonly textureBytes = new Float32Array(40)
  private generation: number
  readonly gpu: GpuContext
  readonly memory: GpuMemoryData
  materialLayout: GPUBindGroupLayout

  constructor(gpu: GpuContext, memory: GpuMemoryData) {
    this.gpu = gpu
    this.memory = memory
    this.generation = gpu.generation
    this.materialLayout = createMaterialLayout(gpu)
  }

  /** Call once per frame before drawing: rebuilds after device loss and resets readiness. */
  beginFrame(): void {
    this.ready.clear()
    if (this.generation === this.gpu.generation) return
    this.generation = this.gpu.generation
    this.materialLayout = createMaterialLayout(this.gpu)
    this.textures.clear()
    this.memory.textures = 0
    this.memory.textureBytes = 0
    this.defaults = undefined
    this.samplers.clear()
  }

  mesh(mesh: Mesh): GpuMesh {
    const gpu = this.gpu
    let gm = this.meshes.get(mesh)
    if (gm && gm.version === mesh.version && gm.generation === gpu.generation) {
      if (mesh.gpu) gm.count = mesh.drawCount
      return gm
    }
    if (gm && gm.generation === gpu.generation) this.destroyMesh(gm)
    if (mesh.gpu) return this.gpuMesh(mesh)
    const device = gpu.device
    const n = mesh.vertexCount
    const upload = (
      data: ArrayBufferView & ArrayLike<number>,
      usage: GPUBufferUsageFlags,
      label: string,
    ) => {
      const buffer = device.createBuffer({
        label,
        size: Math.max(16, (data.byteLength + 3) & ~3),
        usage: usage | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(buffer, 0, data, 0, data.length)
      return buffer
    }
    // Missing attributes get neutral defaults so one pipeline fits every mesh.
    const normals = mesh.normals ?? new Float32Array(n * 3).map((_, i) => (i % 3 === 1 ? 1 : 0))
    const uvs = mesh.uvs ?? new Float32Array(n * 2)
    const uvs1 = mesh.uvs1 ?? uvs
    const tangents = mesh.tangents ?? new Float32Array(n * 4)
    let indices = mesh.indices
    if (indices instanceof Uint16Array && indices.length % 2 === 1) {
      // writeBuffer needs 4-byte multiples; pad odd-length u16 index data.
      const padded = new Uint16Array(indices.length + 1)
      padded.set(indices)
      indices = padded
    }
    gm = {
      version: mesh.version,
      generation: gpu.generation,
      positions: upload(mesh.positions, GPUBufferUsage.VERTEX, 'mesh/positions'),
      normals: upload(normals, GPUBufferUsage.VERTEX, 'mesh/normals'),
      uvs: upload(uvs, GPUBufferUsage.VERTEX, 'mesh/uvs'),
      uvs1: upload(uvs1, GPUBufferUsage.VERTEX, 'mesh/uvs1'),
      tangents: upload(tangents, GPUBufferUsage.VERTEX, 'mesh/tangents'),
      indices: indices ? upload(indices, GPUBufferUsage.INDEX, 'mesh/indices') : undefined,
      indexFormat: mesh.indices instanceof Uint32Array ? 'uint32' : 'uint16',
      count: mesh.drawCount,
      sharedIndices: false,
      sharedVertices: false,
      baseVertex: 0,
    }
    this.meshes.set(mesh, gm)
    return gm
  }

  private destroyMesh(gm: GpuMesh): void {
    if (gm.sharedVertices) return
    gm.positions.destroy()
    gm.normals.destroy()
    gm.uvs.destroy()
    gm.uvs1.destroy()
    gm.tangents.destroy()
    if (!gm.sharedIndices) gm.indices?.destroy()
  }

  /** Index buffers shared by GPU meshes, per index array. */
  private readonly sharedIndexBuffers = new WeakMap<
    object,
    { generation: number; buffer: GPUBuffer }
  >()

  /**
   * A GPU-written mesh (`Mesh.gpu`): storage + vertex buffers compute passes fill (positions,
   * normals, uvs, uvs1, tangents; f32), and the index buffer every mesh with the same array shares.
   */
  private gpuMesh(mesh: Mesh): GpuMesh {
    const gpu = this.gpu
    const desc = mesh.gpu!
    const n = desc.vertexCount
    const usage =
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.VERTEX |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC
    const make = (width: number, label: string) =>
      gpu.device.createBuffer({ label, size: Math.max(16, n * width * 4), usage })
    let shared = this.sharedIndexBuffers.get(desc.indices)
    if (!shared || shared.generation !== gpu.generation) {
      const data = desc.indices
      const bytes = (data.byteLength + 3) & ~3
      const buffer = gpu.device.createBuffer({
        label: 'mesh/shared-indices',
        size: Math.max(16, bytes),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      if (data.byteLength % 4 === 0) gpu.device.queue.writeBuffer(buffer, 0, data, 0, data.length)
      else {
        const padded = new Uint16Array(data.length + 1)
        padded.set(data)
        gpu.device.queue.writeBuffer(buffer, 0, padded, 0, padded.length)
      }
      shared = { generation: gpu.generation, buffer }
      this.sharedIndexBuffers.set(desc.indices, shared)
    }
    const source = desc.share ? this.mesh(desc.share) : undefined
    const gm: GpuMesh = {
      version: mesh.version,
      generation: gpu.generation,
      positions: source?.positions ?? make(3, 'mesh/gpu-positions'),
      normals: source?.normals ?? make(3, 'mesh/gpu-normals'),
      uvs: source?.uvs ?? make(2, 'mesh/gpu-uvs'),
      uvs1: source?.uvs1 ?? make(2, 'mesh/gpu-uvs1'),
      tangents: source?.tangents ?? make(4, 'mesh/gpu-tangents'),
      indices: shared.buffer,
      indexFormat: desc.indices instanceof Uint32Array ? 'uint32' : 'uint16',
      count: mesh.drawCount,
      sharedIndices: true,
      sharedVertices: source !== undefined,
      baseVertex: mesh.baseVertex,
    }
    this.meshes.set(mesh, gm)
    return gm
  }

  /** Frees a mesh's GPU buffers now (they're made again if it's drawn later). */
  releaseMesh(mesh: Mesh): void {
    const gm = this.meshes.get(mesh)
    if (!gm) return
    if (gm.generation === this.gpu.generation) this.destroyMesh(gm)
    this.meshes.delete(mesh)
  }

  /** Uploads a texture (all levels) on first use and when its version changes. */
  texture(texture: Texture): GpuTexture | undefined {
    const gpu = this.gpu
    const existing = this.textures.get(texture)
    if (
      existing &&
      existing.version === texture.version &&
      existing.generation === gpu.generation
    ) {
      return existing
    }
    if (!texture.levels && !texture.gpuOnly) return undefined // released after upload and the device was lost: reloading
    if (existing) {
      this.memory.textures--
      this.memory.textureBytes -= existing.bytes
    }
    existing?.texture.destroy()
    const info = FORMAT_INFO[texture.format]
    // Storage-bindable (GPU-written) textures can't also offer an sRGB view.
    const srgbView = texture.gpuOnly ? undefined : info.srgbView
    const layers = texture.faces * texture.layers
    const handle = gpu.device.createTexture({
      label: `texture/${texture.format}`,
      size: { width: texture.width, height: texture.height, depthOrArrayLayers: layers },
      format: texture.format as GPUTextureFormat,
      mipLevelCount: texture.mipCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        (texture.gpuOnly ? GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC : 0),
      viewFormats: srgbView ? [srgbView as GPUTextureFormat] : [],
    })
    // GPU-only textures start empty; a compute pass fills them.
    for (let level = 0; texture.levels && level < texture.mipCount; level++) {
      const w = Math.max(1, texture.width >> level)
      const h = Math.max(1, texture.height >> level)
      const blocksWide = Math.ceil(w / info.block)
      const blocksHigh = Math.ceil(h / info.block)
      gpu.device.queue.writeTexture(
        { texture: handle, mipLevel: level },
        texture.levels[level]! as Uint8Array<ArrayBuffer>,
        { bytesPerRow: blocksWide * info.bytes, rowsPerImage: blocksHigh },
        {
          width: blocksWide * info.block,
          height: blocksHigh * info.block,
          depthOrArrayLayers: layers,
        },
      )
    }
    const dimension: GPUTextureViewDimension =
      texture.faces === 6 ? 'cube' : texture.layers > 1 ? '2d-array' : '2d'
    const linear = handle.createView({ dimension })
    const srgb = srgbView
      ? handle.createView({ format: srgbView as GPUTextureFormat, dimension })
      : linear
    const plain = texture.faces === 1
    const out: GpuTexture = {
      texture: handle,
      linear,
      srgb,
      arrayLinear: !plain
        ? undefined
        : dimension === '2d-array'
          ? linear
          : handle.createView({ dimension: '2d-array' }),
      arraySrgb: !plain
        ? undefined
        : dimension === '2d-array'
          ? srgb
          : srgbView
            ? handle.createView({
                format: srgbView as GPUTextureFormat,
                dimension: '2d-array',
              })
            : undefined,
      version: texture.version,
      generation: gpu.generation,
      bytes: texture.byteSize,
    }
    this.textures.set(texture, out)
    this.memory.textures++
    this.memory.textureBytes += out.bytes
    // Imported textures keep no CPU copy; after device loss they reload from their artifact.
    if (!texture.keepCpu) texture.levels = undefined
    return out
  }

  /** 1x1 white and flat-normal textures for empty slots. */
  defaultTextures() {
    const gpu = this.gpu
    if (this.defaults && this.defaults.white.generation === gpu.generation) return this.defaults
    const solid = (label: string, rgba: number[]): GpuTexture => {
      const texture = gpu.device.createTexture({
        label,
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        viewFormats: ['rgba8unorm-srgb'],
      })
      gpu.device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1])
      const linear = texture.createView()
      return {
        texture,
        linear,
        srgb: texture.createView({ format: 'rgba8unorm-srgb' }),
        arrayLinear: texture.createView({ dimension: '2d-array' }),
        arraySrgb: texture.createView({ format: 'rgba8unorm-srgb', dimension: '2d-array' }),
        version: 0,
        generation: gpu.generation,
        bytes: 4,
      }
    }
    this.defaults = {
      white: solid('texture/white', [255, 255, 255, 255]),
      normal: solid('texture/flat-normal', [128, 128, 255, 255]),
    }
    this.samplers.clear()
    return this.defaults
  }

  sampler(wrap: string, filter: string): GPUSampler {
    const key = `${wrap}|${filter}`
    let s = this.samplers.get(key)
    if (!s) {
      const address: GPUAddressMode =
        wrap === 'clamp' ? 'clamp-to-edge' : wrap === 'mirror' ? 'mirror-repeat' : 'repeat'
      const linear = filter === 'linear'
      s = this.gpu.device.createSampler({
        label: `sampler/${key}`,
        addressModeU: address,
        addressModeV: address,
        magFilter: linear ? 'linear' : 'nearest',
        minFilter: linear ? 'linear' : 'nearest',
        mipmapFilter: linear ? 'linear' : 'nearest',
        maxAnisotropy: linear ? 8 : 1,
      })
      this.samplers.set(key, s)
    }
    return s
  }

  /**
   * Whether a material's textures are available (once per material per frame). False when a
   * referenced texture is loading or reloading after device loss: its draws wait.
   */
  materialReady(world: World, material: MaterialAsset): boolean {
    let ready = this.ready.get(material)
    if (ready === undefined) {
      ready = this.resolveSlots(world, material)
      this.ready.set(material, ready)
    }
    return ready
  }

  private resolveSlots(world: World, material: MaterialAsset): boolean {
    const store = world.tryResource(Textures)
    material.sync()
    const type = material.type
    const own = type.textures
    this.ownTextures.length = own.length
    for (let i = 0; i < own.length; i++) {
      const ref = (material.value as Record<string, { guid?: string } | null>)[own[i]!]
      if (!ref) {
        this.ownTextures[i] = undefined
        continue
      }
      const texture = store?.get(ref as { guid: string | undefined })
      if (!texture || !this.available(world, texture, ref)) return false
      this.ownTextures[i] = texture
    }
    if (!type.standard || !type.standardTextures) return true
    const value = material.value as unknown as Record<string, SlotValue>
    for (let i = 0; i < 5; i++) {
      const ref = value[TEXTURE_SLOTS[i]!]!.texture
      if (!ref) {
        this.slotTextures[i] = undefined
        continue
      }
      const texture = store?.get(ref)
      if (!texture || !this.available(world, texture, ref)) return false
      this.slotTextures[i] = texture
    }
    return true
  }

  /** Whether a texture can be uploaded; if its pixels are gone (device loss), reloads it. */
  private available(world: World, texture: Texture, ref: { guid?: string }): boolean {
    if (texture.levels || this.textures.has(texture)) return true
    // Released after upload and the device was lost (or never uploaded): reload the artifact.
    if (ref.guid && !this.reloading.has(ref.guid)) {
      this.reloading.add(ref.guid)
      const guid = ref.guid
      void assetServer(world)
        .reload(guid)
        .finally(() => this.reloading.delete(guid))
    }
    return false
  }

  /** The group-1 layout of a material type on this device. */
  layoutOf(type: MaterialType): GPUBindGroupLayout {
    return type.bindGroupLayout(this.gpu, standardEntries())
  }

  /** The material's uniforms and bind group, uploaded when its version or textures change. */
  material(world: World, material: MaterialAsset): GpuMaterial | undefined {
    const gpu = this.gpu
    if (!this.resolveSlots(world, material)) return undefined
    const type = material.type
    let gm = this.materials.get(material)
    if (
      !gm ||
      gm.generation !== gpu.generation ||
      gm.type !== type ||
      gm.typeVersion !== type.version
    ) {
      gm = {
        version: -1,
        generation: gpu.generation,
        typeVersion: type.version,
        type,
        buffer: gpu.device.createBuffer({
          label: 'material/standard',
          size: materialLayout.size,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        textureBuffer: gpu.device.createBuffer({
          label: 'material/textures',
          size: 160,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        ownBuffer: type.layout
          ? gpu.device.createBuffer({
              label: `material/${type.name}`,
              size: type.layout.size,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
          : undefined,
        bindGroup: undefined,
        bound: [undefined, undefined, undefined, undefined, undefined],
        ownBound: [],
      }
      this.materials.set(material, gm)
    }
    const defaults = this.defaultTextures()
    let rebuild = gm.bindGroup === undefined
    if (type.standard && type.standardTextures) {
      for (let i = 0; i < 5; i++) {
        const texture = this.slotTextures[i]
        const g = texture ? this.texture(texture) : undefined
        if (texture && !g) return undefined
        if (gm.bound[i] !== g) {
          gm.bound[i] = g
          rebuild = true
        }
      }
    }
    for (let i = 0; i < this.ownTextures.length; i++) {
      const texture = this.ownTextures[i]
      const g = texture ? this.texture(texture) : undefined
      if (texture && !g) return undefined
      if (gm.ownBound[i] !== g) {
        gm.ownBound[i] = g
        rebuild = true
      }
    }
    if (gm.version !== material.version) {
      const value = material.value as unknown as Record<string, SlotValue>
      if (type.standard) {
        materialLayout.write(this.materialBytes, 0, material.value)
        gpu.device.queue.writeBuffer(
          gm.buffer,
          0,
          this.materialBytes.buffer,
          0,
          materialLayout.size,
        )
        const t = this.textureBytes
        for (let i = 0; i < 5; i++) {
          const slot = value[TEXTURE_SLOTS[i]!]!
          t[i * 8] = slot.offset[0]!
          t[i * 8 + 1] = slot.offset[1]!
          t[i * 8 + 2] = slot.scale[0]!
          t[i * 8 + 3] = slot.scale[1]!
          t[i * 8 + 4] = slot.rotation
          t[i * 8 + 5] = slot.uv
          t[i * 8 + 6] = slot.texture ? 1 : 0
          t[i * 8 + 7] = 0
        }
        gpu.device.queue.writeBuffer(gm.textureBuffer, 0, t.buffer, 0, 160)
      }
      if (type.layout && gm.ownBuffer) {
        if (this.ownBytes.byteLength < type.layout.size)
          this.ownBytes = new DataView(new ArrayBuffer(type.layout.size))
        type.layout.write(this.ownBytes, 0, material.value as never)
        gpu.device.queue.writeBuffer(gm.ownBuffer, 0, this.ownBytes.buffer, 0, type.layout.size)
      }
      gm.version = material.version
      rebuild = true
    }
    if (rebuild) {
      const value = material.value as unknown as Record<string, SlotValue>
      const entries: GPUBindGroupEntry[] = []
      if (type.standard) {
        entries.push(
          { binding: 0, resource: { buffer: gm.buffer } },
          { binding: 1, resource: { buffer: gm.textureBuffer } },
        )
        for (let i = 0; type.standardTextures && i < 5; i++) {
          const g = gm.bound[i] ?? (i === 2 ? defaults.normal : defaults.white)
          entries.push({ binding: 2 + i, resource: SRGB_SLOT[i] ? g.srgb : g.linear })
          const slot = value[TEXTURE_SLOTS[i]!]!
          entries.push({ binding: 7 + i, resource: this.sampler(slot.wrap, slot.filter) })
        }
      }
      let binding = type.bindingBase
      if (gm.ownBuffer) entries.push({ binding, resource: { buffer: gm.ownBuffer } })
      binding++
      for (let i = 0; i < type.textures.length; i++) {
        const name = type.textures[i]!
        if (type.arrays.has(name)) {
          // Arrays of color textures (albedo layers) read through the sRGB view.
          const texture = this.ownTextures[i]
          const g =
            gm.ownBound[i] ??
            (name.toLowerCase().includes('normal') ? defaults.normal : defaults.white)
          const color = texture ? texture.usage === 'color' : false
          entries.push({
            binding: binding++,
            resource: (color ? (g.arraySrgb ?? g.arrayLinear) : g.arrayLinear) ?? g.linear,
          })
        } else {
          const g = gm.ownBound[i] ?? defaults.white
          entries.push({ binding: binding++, resource: g.linear })
        }
        entries.push({ binding: binding++, resource: this.sampler('repeat', 'linear') })
      }
      gm.bindGroup = gpu.device.createBindGroup({
        label: `material/${type.name}`,
        layout: this.layoutOf(type),
        entries,
      })
    }
    return gm
  }
}

/** The standard material's group-1 bindings. */
function standardEntries(): GPUBindGroupLayoutEntry[] {
  const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
  return [
    { binding: 0, visibility, buffer: { type: 'uniform' } },
    { binding: 1, visibility, buffer: { type: 'uniform' } },
    ...[2, 3, 4, 5, 6].map((binding) => ({
      binding,
      visibility,
      texture: { sampleType: 'float' as const },
    })),
    ...[7, 8, 9, 10, 11].map((binding) => ({
      binding,
      visibility,
      sampler: { type: 'filtering' as const },
    })),
  ]
}

export function createMaterialLayout(gpu: GpuContext): GPUBindGroupLayout {
  return STANDARD_TYPE.bindGroupLayout(gpu, standardEntries())
}

export const GpuAssetsResource = defineResource<GpuAssets>('render/GpuAssets', {
  description: 'GPU copies of meshes, textures, and materials.',
})
