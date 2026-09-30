import type { Entity, World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import type { NodeContext } from '@aethervtt/shard-render'
import { Shaders } from '@aethervtt/shard-render'
import { type CoverageMesh, featheredCoverage } from '@aethervtt/shard-vector'
import { FogLayer, type FogRegion, FogRegionsStore, type FogRegionsValue } from './components'

// Fog masks (0058): one r8unorm texture per layer over its extent, 1 fog and 0 clear. Regions draw
// in order onto it: `hide` is dst + c(1 − dst), `reveal` is dst(1 − strength · c). A region's
// triangles may overlap (brush joins); a stencil lets each texel take only its first triangle per
// region, core triangles first. Appending regions draws only the new ones; any other change
// clears to the base and draws them all. Tessellation is cached by content, so a redraw is GPU
// work only.

/** The largest mask side. */
export const MAX_MASK_SIZE = 4096

/** Floats per vertex: x, z, coverage × strength. */
const STRIDE = 3

/** Stencil values a pass can hand out before it has to clear (0 means "not yet drawn"). */
const STENCIL_REFS = 255

/** A region tessellated with its feather, strength baked into the coverage. */
interface RegionMesh {
  vertices: Float32Array
  indices: Uint32Array
  hide: boolean
}

/** Where a region's triangles sit in the layer's buffers. */
interface RegionDraw {
  firstIndex: number
  indexCount: number
  hide: boolean
}

export interface LayerState {
  entity: Entity
  texture: GPUTexture | undefined
  generation: number
  width: number
  height: number
  /** min x, min z, max x, max z. */
  extent: [number, number, number, number]
  base: 'hidden' | 'revealed'
  /** Linear color and opacity, read each frame for the composite. */
  color: Float32Array
  opacity: number
  /** The region list drawn from, and how many of its regions are on the mask. */
  value: FogRegionsValue | undefined
  hashes: number[]
  drawn: number
  /** Regions to draw this frame, from `drawFrom`; `clear` first when redrawing. */
  drawFrom: number
  clear: boolean
  vertices: Float32Array
  indices: Uint32Array
  vertexCount: number
  indexCount: number
  draws: RegionDraw[]
  /** Buffers and how much of the CPU arrays they hold. */
  vertexBuffer: GpuBuffer | undefined
  indexBuffer: GpuBuffer | undefined
  uploadedVertices: number
  uploadedIndices: number
  uniform: GpuBuffer | undefined
  uniformGroup: GPUBindGroup | undefined
  /** The buffers' versions when last uploaded: a replaced buffer is uploaded whole. */
  vertexVersion: number
  indexVersion: number
  /** What the last update did, for `fog.describe`. */
  lastUpdate: 'none' | 'append' | 'redraw'
  lastDrawn: number
  seen: number
}

export interface FogState {
  layers: Map<Entity, LayerState>
  /** Layers in draw order this frame (at most MAX_FOG_LAYERS compose). */
  active: LayerState[]
  /** Tessellations by content hash. */
  meshes: Map<number, RegionMesh>
  stencil: GPUTexture | undefined
  stencilSize: [number, number]
  stencilGeneration: number
  frame: number
  /** Frame the masks were last encoded (they're view independent: once per frame). */
  encoded: number
  /** Regions drawn by the last frame's updates, all layers (counted for tests and describe). */
  regionsDrawn: number
  pipelines: { hide: GPURenderPipeline | undefined; reveal: GPURenderPipeline | undefined }
  pipelineGeneration: number
  layout: GPUBindGroupLayout | undefined
}

export function createFogState(): FogState {
  return {
    layers: new Map(),
    active: [],
    meshes: new Map(),
    stencil: undefined,
    stencilSize: [0, 0],
    stencilGeneration: -1,
    frame: 0,
    encoded: -1,
    regionsDrawn: 0,
    pipelines: { hide: undefined, reveal: undefined },
    pipelineGeneration: -1,
    layout: undefined,
  }
}

// --- hashing -----------------------------------------------------------------------------------

const hashes = new WeakMap<object, number>()

function mix(h: number, v: number): number {
  h = Math.imul(h ^ v, 0x01000193)
  return h >>> 0
}

function hashNumber(h: number, n: number): number {
  const f = Math.fround(n)
  scratch[0] = f
  return mix(h, scratchU[0]!)
}
const scratch = new Float32Array(1)
const scratchU = new Uint32Array(scratch.buffer)

function hashPoints(h: number, pts: readonly (readonly [number, number])[]): number {
  h = mix(h, pts.length)
  for (const p of pts) h = hashNumber(hashNumber(h, p[0]), p[1])
  return h
}

/** A region's content hash: cached per region object, since hosts append the same objects. */
export function regionHash(r: FogRegion): number {
  const cached = hashes.get(r)
  if (cached !== undefined) return cached
  let h = 0x811c9dc5
  h = mix(h, r.op === 'hide' ? 1 : 2)
  h = hashNumber(h, r.strength ?? 1)
  h = hashNumber(h, r.feather ?? 0)
  const s = r.shape
  switch (s.kind) {
    case 'rect':
      h = mix(h, 11)
      for (const v of [s.x, s.y, s.w, s.h]) h = hashNumber(h, v)
      break
    case 'polygon':
      h = hashPoints(mix(h, 12), s.outer)
      for (const hole of s.holes ?? []) h = hashPoints(mix(h, 13), hole)
      break
    case 'multipolygon':
      h = mix(h, 14)
      for (const p of s.polygons) {
        h = hashPoints(mix(h, 12), p.outer)
        for (const hole of p.holes ?? []) h = hashPoints(mix(h, 13), hole)
      }
      break
    case 'brush':
      h = hashNumber(hashPoints(mix(h, 15), s.points), s.radius)
      break
  }
  hashes.set(r, h)
  return h
}

/** A region's triangles, strength baked in: from the cache, or tessellated now. */
export function regionMesh(state: FogState, r: FogRegion, hash: number, error: number): RegionMesh {
  let mesh = state.meshes.get(hash)
  if (mesh) return mesh
  const cov: CoverageMesh = featheredCoverage(r.shape, { feather: r.feather ?? 0, error })
  const strength = r.strength ?? 1
  const n = cov.coverage.length
  const vertices = new Float32Array(n * STRIDE)
  for (let i = 0; i < n; i++) {
    vertices[i * STRIDE] = cov.positions[i * 2]!
    vertices[i * STRIDE + 1] = cov.positions[i * 2 + 1]!
    vertices[i * STRIDE + 2] = cov.coverage[i]! * strength
  }
  mesh = { vertices, indices: cov.indices, hide: r.op === 'hide' }
  state.meshes.set(hash, mesh)
  return mesh
}

// --- per-frame update -----------------------------------------------------------------------------

function newLayer(entity: Entity): LayerState {
  return {
    entity,
    texture: undefined,
    generation: -1,
    width: 0,
    height: 0,
    extent: [0, 0, 0, 0],
    base: 'hidden',
    color: new Float32Array(4),
    opacity: 1,
    value: undefined,
    hashes: [],
    drawn: 0,
    drawFrom: 0,
    clear: false,
    vertices: new Float32Array(1024),
    indices: new Uint32Array(1024),
    vertexCount: 0,
    indexCount: 0,
    draws: [],
    vertexBuffer: undefined,
    indexBuffer: undefined,
    uploadedVertices: 0,
    uploadedIndices: 0,
    uniform: undefined,
    uniformGroup: undefined,
    vertexVersion: -1,
    indexVersion: -1,
    lastUpdate: 'none',
    lastDrawn: 0,
    seen: 0,
  }
}

/** Appends a region's triangles to the layer's arrays. */
function appendRegion(layer: LayerState, mesh: RegionMesh): void {
  const v = mesh.vertices
  const needV = (layer.vertexCount + v.length / STRIDE) * STRIDE
  if (needV > layer.vertices.length) {
    const next = new Float32Array(Math.max(needV, layer.vertices.length * 2))
    next.set(layer.vertices.subarray(0, layer.vertexCount * STRIDE))
    layer.vertices = next
  }
  layer.vertices.set(v, layer.vertexCount * STRIDE)
  const base = layer.vertexCount
  const idx = mesh.indices
  const needI = layer.indexCount + idx.length
  if (needI > layer.indices.length) {
    const next = new Uint32Array(Math.max(needI, layer.indices.length * 2))
    next.set(layer.indices.subarray(0, layer.indexCount))
    layer.indices = next
  }
  for (let i = 0; i < idx.length; i++) layer.indices[layer.indexCount + i] = idx[i]! + base
  layer.draws.push({ firstIndex: layer.indexCount, indexCount: idx.length, hide: mesh.hide })
  layer.vertexCount += v.length / STRIDE
  layer.indexCount += idx.length
}

/**
 * Brings each FogLayer's mask state up to date: its size, and which regions this frame draws (the
 * appended ones, or all after a clear). Nothing when nothing changed.
 */
export function updateFog(world: World, state: FogState, gpu: GpuContext): void {
  state.frame++
  state.regionsDrawn = 0
  const store = world.tryResource(FogRegionsStore)
  const limit = Math.min(MAX_MASK_SIZE, gpu.device.limits.maxTextureDimension2D)
  state.active.length = 0
  const q = world.query({ with: [FogLayer] })
  for (const table of q.tables) {
    const bases = table.column(FogLayer, 'base')
    const extents = table.column(FogLayer, 'extent')
    const texels = table.column(FogLayer, 'texelSize')
    const refs = table.column(FogLayer, 'regions')
    const colors = table.column(FogLayer, 'color')
    const opacities = table.column(FogLayer, 'opacity')
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]! as Entity
      let layer = state.layers.get(entity)
      if (!layer) {
        layer = newLayer(entity)
        state.layers.set(entity, layer)
      }
      layer.seen = state.frame
      state.active.push(layer)
      for (let k = 0; k < 4; k++) layer.color[k] = colors[row * 4 + k]!
      layer.opacity = opacities[row]!
      const ext = extents[row] as { min: ArrayLike<number>; max: ArrayLike<number> }
      const minX = Math.min(ext.min[0]!, ext.max[0]!)
      const minZ = Math.min(ext.min[1]!, ext.max[1]!)
      const maxX = Math.max(ext.max[0]!, ext.min[0]!, minX + 1e-3)
      const maxZ = Math.max(ext.max[1]!, ext.min[1]!, minZ + 1e-3)
      const texel = Math.max(1e-3, texels[row]!)
      const width = Math.max(1, Math.min(limit, Math.ceil((maxX - minX) / texel)))
      const height = Math.max(1, Math.min(limit, Math.ceil((maxZ - minZ) / texel)))
      // Enum columns hold the option's index.
      const base = BASES[bases[row] as number] ?? 'hidden'
      const e = layer.extent
      const moved =
        e[0] !== minX || e[1] !== minZ || e[2] !== maxX || e[3] !== maxZ || layer.base !== base
      const resized = width !== layer.width || height !== layer.height
      if (resized || layer.generation !== gpu.generation || !layer.texture) {
        layer.texture?.destroy()
        layer.texture = gpu.device.createTexture({
          label: 'fog/mask',
          size: [width, height],
          format: 'r8unorm',
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        })
        layer.width = width
        layer.height = height
        layer.generation = gpu.generation
        layer.drawn = 0
        layer.value = undefined
      }
      if (moved) {
        e[0] = minX
        e[1] = minZ
        e[2] = maxX
        e[3] = maxZ
        layer.base = base
        layer.drawn = 0
        layer.value = undefined
      }
      const ref = refs[row] as { guid?: string } | null
      const value = (ref?.guid !== undefined && store?.byGuid(ref.guid)) || EMPTY
      // drawFrom and clear keep what an earlier frame couldn't draw yet (pipelines compiling).
      if (value === layer.value && layer.drawn === value.regions.length) {
        layer.lastUpdate = 'none'
        continue
      }
      const regions = value.regions
      // Appended: the same regions first (by content), more after them.
      let append = layer.value !== undefined && regions.length >= layer.drawn
      if (append) {
        for (let i = 0; i < layer.drawn; i++) {
          if (regionHash(regions[i]!) !== layer.hashes[i]) {
            append = false
            break
          }
        }
      }
      const error = Math.max(0.001, texel * 0.25)
      if (!append) {
        layer.vertexCount = 0
        layer.indexCount = 0
        layer.draws.length = 0
        layer.hashes.length = 0
        layer.uploadedVertices = 0
        layer.uploadedIndices = 0
        layer.drawn = 0
        layer.drawFrom = 0
        layer.clear = true
      }
      const from = layer.drawn
      for (let i = from; i < regions.length; i++) {
        const r = regions[i]!
        const hash = regionHash(r)
        layer.hashes.push(hash)
        appendRegion(layer, regionMesh(state, r, hash, error))
      }
      layer.drawn = regions.length
      layer.value = value
      layer.lastUpdate = append ? 'append' : 'redraw'
      layer.lastDrawn = regions.length - from
      state.regionsDrawn += layer.lastDrawn
    }
  }
  // Layers whose entity went away give their GPU memory back.
  for (const [entity, layer] of state.layers) {
    if (layer.seen === state.frame) continue
    layer.texture?.destroy()
    layer.vertexBuffer?.destroy()
    layer.indexBuffer?.destroy()
    layer.uniform?.destroy()
    state.layers.delete(entity)
  }
  // Tessellations no layer uses any more, once there are many.
  if (state.meshes.size > 8192) {
    const used = new Set<number>()
    for (const layer of state.layers.values()) for (const h of layer.hashes) used.add(h)
    for (const h of state.meshes.keys()) if (!used.has(h)) state.meshes.delete(h)
  }
}

const EMPTY: FogRegionsValue = { rev: 0, regions: [] }
const BASES = ['hidden', 'revealed'] as const

// --- encoding ------------------------------------------------------------------------------------

const VERTEX_LAYOUT: GPUVertexBufferLayout[] = [
  {
    arrayStride: STRIDE * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x2' },
      { shaderLocation: 1, offset: 8, format: 'float32' },
    ],
  },
]

function pipelines(ctx: NodeContext, state: FogState): FogState['pipelines'] | undefined {
  const gpu = ctx.gpu
  if (state.pipelineGeneration !== gpu.generation) {
    state.pipelineGeneration = gpu.generation
    state.pipelines = { hide: undefined, reveal: undefined }
    state.layout = gpu.layouts.bindGroupLayout({
      label: 'fog/mask',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    })
  }
  const p = state.pipelines
  if (p.hide && p.reveal) return p
  const module = ctx.world.resource(Shaders).module(gpu, { root: 'fog::mask' })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const make = (hide: boolean) =>
    gpu.pipelines.render({
      label: hide ? 'fog/mask/hide' : 'fog/mask/reveal',
      layout: gpu.layouts.pipelineLayout({ label: 'fog/mask', bindGroupLayouts: [state.layout!] }),
      vertex: { module, entryPoint: 'vs', buffers: VERTEX_LAYOUT },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format: 'r8unorm',
            // hide: dst + c (1 − dst). reveal: dst (1 − c), strength already in c.
            blend: {
              color: hide
                ? { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' }
                : { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
            writeMask: GPUColorWrite.RED,
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // Each texel takes a region's first triangle there, and only that one.
      depthStencil: {
        format: 'stencil8',
        stencilFront: { compare: 'not-equal', passOp: 'replace' },
        stencilBack: { compare: 'not-equal', passOp: 'replace' },
      },
    })
  p.hide ??= make(true)
  p.reveal ??= make(false)
  return p.hide && p.reveal ? p : undefined
}

function stencilFor(gpu: GpuContext, state: FogState, width: number, height: number): GPUTexture {
  const s = state.stencilSize
  if (
    !state.stencil ||
    state.stencilGeneration !== gpu.generation ||
    s[0] < width ||
    s[1] < height
  ) {
    state.stencil?.destroy()
    s[0] = Math.max(s[0], width)
    s[1] = Math.max(s[1], height)
    state.stencil = gpu.device.createTexture({
      label: 'fog/stencil',
      size: [s[0], s[1]],
      format: 'stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    state.stencilGeneration = gpu.generation
  }
  return state.stencil
}

/** Writes what this frame draws of a layer into its buffers and its uniform. */
function upload(gpu: GpuContext, layer: LayerState): void {
  if (!layer.vertexBuffer) {
    layer.vertexBuffer = new GpuBuffer(gpu, { label: 'fog/vertices', usage: GPUBufferUsage.VERTEX })
    layer.indexBuffer = new GpuBuffer(gpu, { label: 'fog/indices', usage: GPUBufferUsage.INDEX })
    layer.uniform = new GpuBuffer(gpu, {
      label: 'fog/mask-params',
      usage: GPUBufferUsage.UNIFORM,
      size: 16,
    })
  }
  const vb = layer.vertexBuffer
  const ib = layer.indexBuffer!
  // Growing (or a lost device) replaces a buffer and its contents: upload everything again.
  vb.ensureCapacity(layer.vertexCount * STRIDE * 4)
  ib.ensureCapacity(layer.indexCount * 4)
  if (vb.version !== layer.vertexVersion || ib.version !== layer.indexVersion) {
    layer.uploadedVertices = 0
    layer.uploadedIndices = 0
  }
  if (layer.uploadedVertices < layer.vertexCount) {
    vb.write(
      layer.vertices,
      layer.uploadedVertices * STRIDE * 4,
      layer.uploadedVertices * STRIDE,
      (layer.vertexCount - layer.uploadedVertices) * STRIDE,
    )
    layer.uploadedVertices = layer.vertexCount
  }
  if (layer.uploadedIndices < layer.indexCount) {
    ib.write(
      layer.indices,
      layer.uploadedIndices * 4,
      layer.uploadedIndices,
      layer.indexCount - layer.uploadedIndices,
    )
    layer.uploadedIndices = layer.indexCount
  }
  const e = layer.extent
  params[0] = e[0]
  params[1] = e[1]
  params[2] = 1 / (e[2] - e[0])
  params[3] = 1 / (e[3] - e[1])
  layer.uniform!.write(params)
  layer.vertexVersion = vb.version
  layer.indexVersion = ib.version
}
const params = new Float32Array(4)

/**
 * Encodes this frame's mask updates: per layer, a pass that clears to the base (a redraw) or
 * keeps the mask (an append), then each region's triangles with its own stencil value. A pass
 * holds 255 regions; the next one clears the stencil and keeps the mask.
 */
export function encodeMasks(ctx: NodeContext, state: FogState): void {
  if (state.encoded === state.frame) return
  const pending = state.active.some((l) => l.drawFrom < l.drawn || l.clear)
  if (!pending) {
    state.encoded = state.frame
    return
  }
  const p = pipelines(ctx, state)
  if (!p) return
  state.encoded = state.frame
  const gpu = ctx.gpu
  for (const layer of state.active) {
    if (layer.drawFrom >= layer.drawn && !layer.clear) continue
    upload(gpu, layer)
    const group = gpu.device.createBindGroup({
      label: 'fog/mask',
      layout: state.layout!,
      entries: [{ binding: 0, resource: { buffer: layer.uniform!.buffer } }],
    })
    const target = layer.texture!.createView()
    const stencil = stencilFor(gpu, state, layer.width, layer.height).createView()
    const base = layer.base === 'hidden' ? 1 : 0
    let r = layer.drawFrom
    let first = true
    do {
      const pass = ctx.encoder.beginRenderPass({
        label: 'fog/masks',
        colorAttachments: [
          first && layer.clear
            ? {
                view: target,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: base, g: 0, b: 0, a: 0 },
              }
            : { view: target, loadOp: 'load', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: stencil,
          stencilLoadOp: 'clear',
          stencilClearValue: 0,
          stencilStoreOp: 'discard',
        },
        timestampWrites: ctx.timestamps('fog/masks'),
      })
      first = false
      pass.setViewport(0, 0, layer.width, layer.height, 0, 1)
      pass.setScissorRect(0, 0, layer.width, layer.height)
      pass.setBindGroup(0, group)
      pass.setVertexBuffer(0, layer.vertexBuffer!.buffer)
      pass.setIndexBuffer(layer.indexBuffer!.buffer, 'uint32')
      let current: GPURenderPipeline | undefined
      const end = Math.min(layer.drawn, r + STENCIL_REFS)
      for (let ref = 1; r < end; r++, ref++) {
        const d = layer.draws[r]!
        if (d.indexCount === 0) continue
        const pipeline = d.hide ? p.hide! : p.reveal!
        if (pipeline !== current) {
          pass.setPipeline(pipeline)
          current = pipeline
        }
        pass.setStencilReference(ref)
        pass.drawIndexed(d.indexCount, 1, d.firstIndex, 0, 0)
      }
      pass.end()
    } while (r < layer.drawn)
    layer.drawFrom = layer.drawn
    layer.clear = false
  }
}

/** The mask shader: world XZ onto the layer's texture, coverage × strength out. */
export const FOG_MASK_SHADERS: Record<string, string> = {
  'fog::mask': `
struct MaskParams {
  /** min x, min z; then 1 / width and 1 / depth of the extent. */
  origin_scale: vec4f,
}
@group(0) @binding(0) var<uniform> params: MaskParams;

struct MaskOut {
  @builtin(position) clip: vec4f,
  @location(0) coverage: f32,
}

@vertex fn vs(@location(0) xz: vec2f, @location(1) coverage: f32) -> MaskOut {
  var out: MaskOut;
  let uv = (xz - params.origin_scale.xy) * params.origin_scale.zw;
  // Row 0 of the mask is the extent's least z.
  out.clip = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.coverage = coverage;
  return out;
}

@fragment fn fs(in: MaskOut) -> @location(0) vec4f {
  return vec4f(in.coverage, 0.0, 0.0, 0.0);
}`,
}
