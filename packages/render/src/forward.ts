import { assetServer } from '@shard/assets'
import {
  aabb,
  affine,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  frustum,
  Last,
  mat4,
  PostUpdate,
  t,
  vec3,
} from '@shard/core'
import { GpuBuffer, type GpuContext } from '@shard/gpu'
import type { Mesh } from '@shard/mesh'
import { definePlugin, type Plugin } from '@shard/runtime'
import { FORMAT_INFO, setTextureCapabilities, type Texture, Textures } from '@shard/texture'
import { GlobalTransform, Transform, TransformSystems } from '@shard/transform'
import { MaterialAsset, Materials, Meshes, RenderTargets, TEXTURE_SLOTS } from './assets'
import { applyPhysicalCameras, Camera3d, Exposure, exposureScale } from './camera'
import { type RenderView, VIEW_TARGET } from './graph'
import { AmbientLight, DirectionalLight } from './lights'
import { Gpu, Graph, RenderSet, Shaders, Views, Window } from './plugin'
import { materialLayout, viewLayout } from './shaders'
import { GpuMemory, RenderStats } from './stats'
import { ComputedVisibility, computeVisibility, Visibility } from './visibility'

export const Mesh3d = defineComponent(
  'render/Mesh3d',
  { mesh: t.handle('Mesh', { description: 'The mesh to draw.' }) },
  { description: "Draws a mesh at this entity's transform.", requires: [Transform, Visibility] },
)

export const MeshMaterial = defineComponent(
  'render/MeshMaterial',
  {
    material: t.handle('Material', {
      description: 'Standard material; a neutral gray when absent.',
    }),
  },
  { description: 'The material a Mesh3d is drawn with.' },
)

/** Camera data a view carries for the forward pass. */
interface CameraData {
  entity: Entity
  viewProj: Float32Array
  position: Float32Array
  frustum: Float32Array
  exposure: number
  clear: GPUColor
}

interface GpuMesh {
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
}

interface GpuMaterial {
  version: number
  generation: number
  buffer: GPUBuffer
  textureBuffer: GPUBuffer
  bindGroup: GPUBindGroup | undefined
  /** What the bind group was built from, to rebuild when a texture changes. */
  bound: (GpuTexture | undefined)[]
}

interface GpuTexture {
  texture: GPUTexture
  linear: GPUTextureView
  srgb: GPUTextureView
  version: number
  generation: number
  bytes: number
}

/** Color slots read through the sRGB view; data slots through the linear one. */
const SRGB_SLOT = [true, false, false, false, true]

interface DrawGroup {
  mesh: Mesh
  material: MaterialAsset
  count: number
  instances: Float32Array
  firstInstance: number
}

interface PerView {
  uniform: GpuBuffer
  instances: GpuBuffer
  bindGroup: GPUBindGroup | undefined
  bound: string
  groups: DrawGroup[]
  index: Map<Mesh, Map<MaterialAsset, DrawGroup>>
}

interface ForwardState {
  msaa: number
  meshes: Map<Mesh, GpuMesh>
  materials: Map<MaterialAsset, GpuMaterial>
  views: Map<string, PerView>
  cameras: Map<Entity, CameraData>
  defaultMaterial: MaterialAsset
  light: { direction: Float32Array; color: Float32Array }
  ambient: Float32Array
  viewBytes: DataView
  materialBytes: DataView
  textureBytes: Float32Array
  packed: Float32Array
  layouts: { view: GPUBindGroupLayout; material: GPUBindGroupLayout; pipeline: GPUPipelineLayout }
  layoutGeneration: number
  textures: Map<Texture, GpuTexture>
  defaults: { white: GpuTexture; normal: GpuTexture } | undefined
  samplers: Map<string, GPUSampler>
  /** Textures scratch for the slot lookup (no per-frame allocation). */
  slotTextures: (Texture | undefined)[]
  /** Guids reloading after device loss, so each is requested once. */
  reloading: Set<string>
  /** Per frame: whether each material's textures are available. */
  materialReady: Map<MaterialAsset, boolean>
  memory: import('./stats').GpuMemoryData
}

const State = defineResource<ForwardState>('render/ForwardState')

const scratchBox = aabb.create()
const scratchMatrix = mat4.create()
const scratchAffine = affine.create()
const scratchProj = mat4.create()

function srgbChannel(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

// --- extract -------------------------------------------------------------------

const extractCameras = defineSystem({
  name: 'render/extract-cameras',
  description: 'Turns Camera3d entities into render views with matrices, frustums, and exposure.',
  setup: (world) => ({ q: world.query({ with: [Camera3d, GlobalTransform, Exposure] }) }),
  run: ({ q }, world) => {
    const state = world.resource(State)
    const views = world.resource(Views).list
    const window = world.tryResource(Window)
    const targets = world.resource(RenderTargets)
    for (const table of q.tables) {
      const projection = table.column(Camera3d, 'projection')
      const fovY = table.column(Camera3d, 'fovY')
      const near = table.column(Camera3d, 'near')
      const far = table.column(Camera3d, 'far')
      const orthoHeight = table.column(Camera3d, 'orthoHeight')
      const order = table.column(Camera3d, 'order')
      const clear = table.column(Camera3d, 'clearColor')
      const target = table.column(Camera3d, 'target')
      const g = table.column(GlobalTransform, 'matrix')
      const ev = table.column(Exposure, 'ev100')
      for (let i = 0; i < table.count; i++) {
        const rt = target[i] ? targets.get(target[i]) : window
        if (!rt) continue // e.g. headless with no target
        const entity = table.entities[i]!
        let cam = state.cameras.get(entity)
        if (!cam) {
          cam = {
            entity,
            viewProj: mat4.create(),
            position: vec3.create(),
            frustum: frustum.create(),
            exposure: 1,
            clear: { r: 0, g: 0, b: 0, a: 1 },
          }
          state.cameras.set(entity, cam)
        }
        const aspect = rt.width / Math.max(1, rt.height)
        if (projection[i] === 0) {
          mat4.perspectiveReversedZ(scratchProj, (fovY[i]! * Math.PI) / 180, aspect, near[i]!)
        } else {
          const h = orthoHeight[i]! / 2
          mat4.orthographicReversedZ(scratchProj, -h * aspect, h * aspect, -h, h, near[i]!, far[i]!)
        }
        affine.invert(scratchAffine, g.subarray(i * 12, i * 12 + 12))
        affine.toMat4(scratchMatrix, scratchAffine)
        mat4.multiply(cam.viewProj, scratchProj, scratchMatrix)
        frustum.fromViewProjection(cam.frustum, cam.viewProj)
        affine.getTranslationAt(cam.position, g, i * 12)
        cam.exposure = exposureScale(ev[i]!)
        // Output is display-encoded, so the clear color is too (unless the target does it).
        const srgbTarget = rt.format.endsWith('-srgb')
        const c = i * 4
        cam.clear = srgbTarget
          ? { r: clear[c]!, g: clear[c + 1]!, b: clear[c + 2]!, a: clear[c + 3]! }
          : {
              r: srgbChannel(clear[c]!),
              g: srgbChannel(clear[c + 1]!),
              b: srgbChannel(clear[c + 2]!),
              a: clear[c + 3]!,
            }
        views.push({
          name: `camera:${entity}`,
          target: rt,
          order: order[i]!,
          data: { camera: cam },
        })
      }
    }
  },
})

const extractLights = defineSystem({
  name: 'render/extract-lights',
  description: 'Reads the directional light and ambient light for this frame.',
  setup: (world) => ({ q: world.query({ with: [DirectionalLight, GlobalTransform] }) }),
  run: ({ q }, world) => {
    const state = world.resource(State)
    const { direction, color } = state.light
    color.fill(0)
    direction[0] = 0
    direction[1] = 1
    direction[2] = 0
    for (const table of q.tables) {
      if (table.count === 0) continue
      const g = table.column(GlobalTransform, 'matrix')
      const c = table.column(DirectionalLight, 'color')
      const lux = table.column(DirectionalLight, 'illuminance')[0]!
      // The light shines along its -Z; lighting wants the direction toward the light (+Z column).
      vec3.normalize(direction, [g[2]!, g[6]!, g[10]!])
      color[0] = c[0]! * lux
      color[1] = c[1]! * lux
      color[2] = c[2]! * lux
      break
    }
    const ambient = world.resource(AmbientLight)
    state.ambient[0] = ambient.color[0] * ambient.brightness
    state.ambient[1] = ambient.color[1] * ambient.brightness
    state.ambient[2] = ambient.color[2] * ambient.brightness
  },
})

// --- queue: cull, group, upload ------------------------------------------------

function gpuMesh(gpu: GpuContext, state: ForwardState, mesh: Mesh): GpuMesh {
  let gm = state.meshes.get(mesh)
  if (gm && gm.version === mesh.version && gm.generation === gpu.generation) return gm
  if (gm && gm.generation === gpu.generation) {
    gm.positions.destroy()
    gm.normals.destroy()
    gm.uvs.destroy()
    gm.uvs1.destroy()
    gm.tangents.destroy()
    gm.indices?.destroy()
  }
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
  }
  state.meshes.set(mesh, gm)
  return gm
}

/** Uploads a texture (all levels) on first use and when its version changes. */
function gpuTexture(
  gpu: GpuContext,
  state: ForwardState,
  texture: Texture,
): GpuTexture | undefined {
  const existing = state.textures.get(texture)
  if (existing && existing.version === texture.version && existing.generation === gpu.generation) {
    return existing
  }
  if (!texture.levels) return undefined // released after upload and the device was lost: reloading
  if (existing) {
    state.memory.textures--
    state.memory.textureBytes -= existing.bytes
  }
  existing?.texture.destroy()
  const info = FORMAT_INFO[texture.format]
  const handle = gpu.device.createTexture({
    label: `texture/${texture.format}`,
    size: { width: texture.width, height: texture.height },
    format: texture.format as GPUTextureFormat,
    mipLevelCount: texture.mipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    viewFormats: info.srgbView ? [info.srgbView as GPUTextureFormat] : [],
  })
  for (let level = 0; level < texture.mipCount; level++) {
    const w = Math.max(1, texture.width >> level)
    const h = Math.max(1, texture.height >> level)
    const blocksWide = Math.ceil(w / info.block)
    const blocksHigh = Math.ceil(h / info.block)
    gpu.device.queue.writeTexture(
      { texture: handle, mipLevel: level },
      texture.levels[level]! as Uint8Array<ArrayBuffer>,
      { bytesPerRow: blocksWide * info.bytes, rowsPerImage: blocksHigh },
      { width: blocksWide * info.block, height: blocksHigh * info.block },
    )
  }
  const linear = handle.createView()
  const out: GpuTexture = {
    texture: handle,
    linear,
    srgb: info.srgbView ? handle.createView({ format: info.srgbView as GPUTextureFormat }) : linear,
    version: texture.version,
    generation: gpu.generation,
    bytes: texture.byteSize,
  }
  state.textures.set(texture, out)
  state.memory.textures++
  state.memory.textureBytes += out.bytes
  // Imported textures keep no CPU copy; after device loss they reload from their artifact.
  if (!texture.keepCpu) texture.levels = undefined
  return out
}

function defaultTextures(gpu: GpuContext, state: ForwardState) {
  if (state.defaults && state.defaults.white.generation === gpu.generation) return state.defaults
  const solid = (label: string, rgba: number[]): GpuTexture => {
    const texture = gpu.device.createTexture({
      label,
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      viewFormats: ['rgba8unorm-srgb'],
    })
    gpu.device.queue.writeTexture(
      { texture },
      new Uint8Array(rgba),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    )
    const linear = texture.createView()
    return {
      texture,
      linear,
      srgb: texture.createView({ format: 'rgba8unorm-srgb' }),
      version: 0,
      generation: gpu.generation,
      bytes: 4,
    }
  }
  state.defaults = {
    white: solid('texture/white', [255, 255, 255, 255]),
    normal: solid('texture/flat-normal', [128, 128, 255, 255]),
  }
  state.samplers.clear()
  return state.defaults
}

function sampler(gpu: GpuContext, state: ForwardState, wrap: string, filter: string): GPUSampler {
  const key = `${wrap}|${filter}`
  let s = state.samplers.get(key)
  if (!s) {
    const address: GPUAddressMode =
      wrap === 'clamp' ? 'clamp-to-edge' : wrap === 'mirror' ? 'mirror-repeat' : 'repeat'
    const linear = filter === 'linear'
    s = gpu.device.createSampler({
      label: `sampler/${key}`,
      addressModeU: address,
      addressModeV: address,
      magFilter: linear ? 'linear' : 'nearest',
      minFilter: linear ? 'linear' : 'nearest',
      mipmapFilter: linear ? 'linear' : 'nearest',
      maxAnisotropy: linear ? 8 : 1,
    })
    state.samplers.set(key, s)
  }
  return s
}

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
 * Resolves a material's slot textures into `state.slotTextures`. Returns false when a referenced
 * texture isn't available yet (loading, or reloading after device loss): the draw waits.
 */
function resolveSlots(
  world: import('@shard/core').World,
  state: ForwardState,
  material: MaterialAsset,
): boolean {
  const store = world.tryResource(Textures)
  const value = material.value as unknown as Record<string, SlotValue>
  for (let i = 0; i < 5; i++) {
    const ref = value[TEXTURE_SLOTS[i]!]!.texture
    if (!ref) {
      state.slotTextures[i] = undefined
      continue
    }
    const texture = store?.get(ref)
    if (!texture) return false
    if (!texture.levels && !state.textures.has(texture)) {
      // Released after upload and the device was lost (or never uploaded): reload the artifact.
      if (ref.guid && !state.reloading.has(ref.guid)) {
        state.reloading.add(ref.guid)
        const guid = ref.guid
        void assetServer(world)
          .reload(guid)
          .finally(() => state.reloading.delete(guid))
      }
      return false
    }
    state.slotTextures[i] = texture
  }
  return true
}

function gpuMaterial(
  gpu: GpuContext,
  state: ForwardState,
  material: MaterialAsset,
): GpuMaterial | undefined {
  let gm = state.materials.get(material)
  if (!gm || gm.generation !== gpu.generation) {
    gm = {
      version: -1,
      generation: gpu.generation,
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
      bindGroup: undefined,
      bound: [undefined, undefined, undefined, undefined, undefined],
    }
    state.materials.set(material, gm)
  }
  const defaults = defaultTextures(gpu, state)
  let rebuild = gm.bindGroup === undefined
  for (let i = 0; i < 5; i++) {
    const texture = state.slotTextures[i]
    const g = texture ? gpuTexture(gpu, state, texture) : undefined
    if (texture && !g) return undefined
    if (gm.bound[i] !== g) {
      gm.bound[i] = g
      rebuild = true
    }
  }
  if (gm.version !== material.version) {
    materialLayout.write(state.materialBytes, 0, material.value)
    gpu.device.queue.writeBuffer(gm.buffer, 0, state.materialBytes.buffer, 0, materialLayout.size)
    const value = material.value as unknown as Record<string, SlotValue>
    const t = state.textureBytes
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
    gm.version = material.version
    rebuild = true
  }
  if (rebuild) {
    const value = material.value as unknown as Record<string, SlotValue>
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: gm.buffer } },
      { binding: 1, resource: { buffer: gm.textureBuffer } },
    ]
    for (let i = 0; i < 5; i++) {
      const g = gm.bound[i] ?? (i === 2 ? defaults.normal : defaults.white)
      entries.push({ binding: 2 + i, resource: SRGB_SLOT[i] ? g.srgb : g.linear })
      const slot = value[TEXTURE_SLOTS[i]!]!
      entries.push({ binding: 7 + i, resource: sampler(gpu, state, slot.wrap, slot.filter) })
    }
    gm.bindGroup = gpu.device.createBindGroup({
      label: 'material/standard',
      layout: state.layouts.material,
      entries,
    })
  }
  return gm
}

const queue = defineSystem({
  name: 'render/forward-queue',
  description:
    'Culls meshes per camera, groups them into instanced draws, and uploads instance data.',
  setup: (world) => ({ q: world.query({ with: [Mesh3d, GlobalTransform, ComputedVisibility] }) }),
  run: ({ q }, world) => {
    const state = world.resource(State)
    const gpu = world.resource(Gpu)
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const stats = world.resource(RenderStats)
    stats.clear()
    state.materialReady.clear()
    ensureLayouts(gpu, state)

    for (const view of world.resource(Views).list) {
      const cam = view.data.camera as CameraData | undefined
      if (!cam) continue
      let pv = state.views.get(view.name)
      if (!pv) {
        pv = {
          uniform: new GpuBuffer(gpu, {
            label: `${view.name}/view`,
            usage: GPUBufferUsage.UNIFORM,
            size: viewLayout.size,
          }),
          instances: new GpuBuffer(gpu, {
            label: `${view.name}/instances`,
            usage: GPUBufferUsage.VERTEX,
            size: 48 * 256,
          }),
          bindGroup: undefined,
          bound: '',
          groups: [],
          index: new Map(),
        }
        state.views.set(view.name, pv)
      }
      for (const group of pv.groups) group.count = 0

      let visible = 0
      let culled = 0
      let hidden = 0
      let pending = 0
      for (const table of q.tables) {
        const n = table.count
        if (n === 0) continue
        const meshRefs = table.column(Mesh3d, 'mesh')
        const materialRefs = table.has(MeshMaterial)
          ? table.column(MeshMaterial, 'material')
          : undefined
        const g = table.column(GlobalTransform, 'matrix')
        const vis = table.column(ComputedVisibility, 'visible')
        for (let i = 0; i < n; i++) {
          if (vis[i] === 0) {
            hidden++
            continue
          }
          const mesh = meshes.get(meshRefs[i])
          if (!mesh) {
            if (meshRefs[i]) pending++
            continue
          }
          aabb.transformAffineAt(scratchBox, mesh.bounds, g, i * 12)
          if (!frustum.intersectsAabbAt(cam.frustum, scratchBox, 0)) {
            culled++
            continue
          }
          const materialRef = materialRefs ? materialRefs[i] : null
          let material = state.defaultMaterial
          if (materialRef) {
            const loaded = materials.get(materialRef)
            if (!loaded) {
              // Referenced but not loaded yet (or failed): skip rather than draw it wrong.
              pending++
              continue
            }
            material = loaded
          }
          // Textures load separately; check once per material per frame, not per entity.
          let ready = state.materialReady.get(material)
          if (ready === undefined) {
            ready = resolveSlots(world, state, material)
            state.materialReady.set(material, ready)
          }
          if (!ready) {
            pending++
            continue
          }
          let byMaterial = pv.index.get(mesh)
          if (!byMaterial) {
            byMaterial = new Map()
            pv.index.set(mesh, byMaterial)
          }
          let group = byMaterial.get(material)
          if (!group) {
            group = {
              mesh,
              material,
              count: 0,
              instances: new Float32Array(12 * 64),
              firstInstance: 0,
            }
            byMaterial.set(material, group)
            pv.groups.push(group)
          }
          if ((group.count + 1) * 12 > group.instances.length) {
            const grown = new Float32Array(group.instances.length * 2)
            grown.set(group.instances)
            group.instances = grown
          }
          group.instances.set(g.subarray(i * 12, i * 12 + 12), group.count * 12)
          group.count++
          visible++
        }
      }

      // Pack every group's instances into one buffer; each draw uses firstInstance as its offset.
      let total = 0
      let drawCalls = 0
      for (const group of pv.groups) {
        group.firstInstance = total
        total += group.count
        if (group.count > 0) drawCalls++
      }
      if (state.packed.length < total * 12)
        state.packed = new Float32Array(Math.max(total * 12, state.packed.length * 2))
      for (const group of pv.groups) {
        if (group.count === 0) continue
        state.packed.set(group.instances.subarray(0, group.count * 12), group.firstInstance * 12)
        gpuMesh(gpu, state, group.mesh)
        resolveSlots(world, state, group.material)
        gpuMaterial(gpu, state, group.material)
      }
      if (total > 0) pv.instances.write(state.packed, 0, 0, total * 12)

      viewLayout.write(state.viewBytes, 0, {
        viewProj: cam.viewProj as never,
        cameraPosition: cam.position as never,
        exposure: cam.exposure,
        lightDirection: state.light.direction as never,
        lightColor: state.light.color as never,
        ambient: state.ambient as never,
      })
      pv.uniform.write(new Float32Array(state.viewBytes.buffer, 0, viewLayout.size / 4))
      stats.set(view.name, { visible, culled, hidden, pending, drawCalls })
    }
  },
})

// --- the graph node ------------------------------------------------------------

function pipelineDescriptor(
  state: ForwardState,
  module: GPUShaderModule,
  format: GPUTextureFormat,
  cullMode: GPUCullMode,
): GPURenderPipelineDescriptor {
  return {
    label: `forward/standard/${format}/x${state.msaa}/${cullMode}`,
    layout: state.layouts.pipeline,
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        {
          arrayStride: 48,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 3, offset: 0, format: 'float32x4' },
            { shaderLocation: 4, offset: 16, format: 'float32x4' },
            { shaderLocation: 5, offset: 32, format: 'float32x4' },
          ],
        },
        { arrayStride: 8, attributes: [{ shaderLocation: 6, offset: 0, format: 'float32x2' }] },
        { arrayStride: 16, attributes: [{ shaderLocation: 7, offset: 0, format: 'float32x4' }] },
      ],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: state.msaa },
  }
}

function forwardNode(state: ForwardState) {
  const msaa = state.msaa > 1
  const clear = (view: RenderView) =>
    (view.data.camera as CameraData | undefined)?.clear ?? { r: 0, g: 0, b: 0, a: 1 }
  return {
    kind: 'render' as const,
    writes: [
      VIEW_TARGET,
      { name: 'forward-depth', format: 'depth32float' as const, sampleCount: state.msaa },
      ...(msaa ? [{ name: 'forward-msaa', format: 'view' as const, sampleCount: state.msaa }] : []),
    ],
    color: msaa
      ? [{ resource: 'forward-msaa', resolve: VIEW_TARGET, clear }]
      : [{ resource: VIEW_TARGET, clear }],
    depth: { resource: 'forward-depth', clear: 0 },
    run: (ctx: import('./graph').NodeContext) => {
      const pv = state.views.get(ctx.view.name)
      if (!pv || !ctx.view.data.camera) return
      const format = ctx.view.target.format
      const module = ctx.world.resource(Shaders).module(ctx.gpu, {
        root: 'shard::pbr::forward',
        defines: { SRGB_TARGET: format.endsWith('-srgb') },
      })
      if (!module) {
        ctx.gpu.pipelines.skipped++ // a draw waiting on its shader is a skipped draw too
        return
      }
      const pipeline = ctx.gpu.pipelines.render(pipelineDescriptor(state, module, format, 'back'))
      const twoSided = ctx.gpu.pipelines.render(pipelineDescriptor(state, module, format, 'none'))
      if (!pipeline || !twoSided) return
      const bound = `${pv.uniform.version}/${ctx.gpu.generation}`
      if (!pv.bindGroup || pv.bound !== bound) {
        pv.bindGroup = ctx.gpu.device.createBindGroup({
          label: `${ctx.view.name}/view`,
          layout: state.layouts.view,
          entries: [{ binding: 0, resource: { buffer: pv.uniform.buffer } }],
        })
        pv.bound = bound
      }
      const pass = ctx.renderPass!
      let current = pipeline
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, pv.bindGroup)
      pass.setVertexBuffer(3, pv.instances.buffer)
      for (const group of pv.groups) {
        if (group.count === 0) continue
        const gm = state.meshes.get(group.mesh)
        const mat = state.materials.get(group.material)
        if (!gm || !mat?.bindGroup) continue
        const wanted = group.material.value.doubleSided ? twoSided : pipeline
        if (wanted !== current) {
          pass.setPipeline(wanted)
          pass.setBindGroup(0, pv.bindGroup)
          current = wanted
        }
        pass.setBindGroup(1, mat.bindGroup)
        pass.setVertexBuffer(0, gm.positions)
        pass.setVertexBuffer(1, gm.normals)
        pass.setVertexBuffer(2, gm.uvs)
        pass.setVertexBuffer(4, gm.uvs1)
        pass.setVertexBuffer(5, gm.tangents)
        if (gm.indices) {
          pass.setIndexBuffer(gm.indices, gm.indexFormat)
          pass.drawIndexed(gm.count, group.count, 0, 0, group.firstInstance)
        } else {
          pass.draw(gm.count, group.count, 0, group.firstInstance)
        }
      }
    },
  }
}

export interface ForwardPluginOptions {
  /** MSAA sample count: 1 or 4. Default 4. */
  msaa?: 1 | 4
}

/**
 * Cameras, meshes, the standard material, a directional light, and ambient light, drawn with
 * instancing and frustum culling. Needs the render and transform plugins.
 */
/** Bind group and pipeline layouts, created per device (after a device loss they're rebuilt). */
function createLayouts(gpu: GpuContext): ForwardState['layouts'] {
  const view = gpu.layouts.bindGroupLayout({
    label: 'forward/view',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  })
  const material = gpu.layouts.bindGroupLayout({
    label: 'forward/material',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ...[2, 3, 4, 5, 6].map((binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' as const },
      })),
      ...[7, 8, 9, 10, 11].map((binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' as const },
      })),
    ],
  })
  return {
    view,
    material,
    pipeline: gpu.layouts.pipelineLayout({ label: 'forward', bindGroupLayouts: [view, material] }),
  }
}

function ensureLayouts(gpu: GpuContext, state: ForwardState): void {
  if (state.layoutGeneration === gpu.generation) return
  state.layouts = createLayouts(gpu)
  state.layoutGeneration = gpu.generation
  state.textures.clear()
  state.memory.textures = 0
  state.memory.textureBytes = 0
  state.defaults = undefined
  state.samplers.clear()
  for (const pv of state.views.values()) pv.bindGroup = undefined
}

export function forwardPlugin(options: ForwardPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'render/forward',
    dependencies: ['render', 'core/transform'],
    build(app) {
      const w = app.world
      w.initResource(Meshes)
      w.initResource(Materials)
      w.initResource(Textures)
      w.initResource(RenderTargets)
      w.initResource(AmbientLight)
      w.initResource(RenderStats)
      app
        .addSystems(PostUpdate, computeVisibility.after(TransformSystems), applyPhysicalCameras)
        .addSystems(
          Last,
          extractCameras.inSet(RenderSet.Extract),
          extractLights.inSet(RenderSet.Extract),
        )
        .addSystems(Last, queue.inSet(RenderSet.Queue))
    },
    ready(app) {
      const gpu = app.world.resource(Gpu)
      const layouts = createLayouts(gpu)
      // Basis textures transcode to what this device can sample.
      setTextureCapabilities({
        bc: gpu.features.has('texture-compression-bc'),
        astc: gpu.features.has('texture-compression-astc'),
        etc2: gpu.features.has('texture-compression-etc2'),
      })
      const state: ForwardState = {
        msaa: options.msaa ?? 4,
        meshes: new Map(),
        materials: new Map(),
        views: new Map(),
        cameras: new Map(),
        defaultMaterial: new MaterialAsset(),
        light: { direction: vec3.create(0, 1, 0), color: vec3.create() },
        ambient: vec3.create(),
        viewBytes: new DataView(new ArrayBuffer(viewLayout.size)),
        materialBytes: new DataView(new ArrayBuffer(materialLayout.size)),
        textureBytes: new Float32Array(40),
        packed: new Float32Array(12 * 1024),
        textures: new Map(),
        defaults: undefined,
        samplers: new Map(),
        slotTextures: [undefined, undefined, undefined, undefined, undefined],
        reloading: new Set(),
        materialReady: new Map(),
        memory: app.world.initResource(GpuMemory),
        layouts,
        layoutGeneration: gpu.generation,
      }
      app.insertResource(State, state)
      app.world.resource(Graph).addNode('forward-opaque', forwardNode(state))
    },
  })
}
