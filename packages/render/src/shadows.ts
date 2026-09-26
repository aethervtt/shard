import { defineResource, frustum, mat4, type World } from '@shard/core'
import { GpuBuffer, type GpuContext } from '@shard/gpu'
import { Culler } from './culling'
import { GpuAssetsResource } from './gpu-assets'
import type { NodeContext } from './graph'
import { createDrawList, type DrawList, InstanceFlags, Instances } from './instances'
import { type LightRecord, type LightStore, setShadowIndex } from './lights'
import {
  type MaterialPipelines,
  materialVariant,
  typeOrdinal,
  variantBlend,
  variantCull,
} from './material-pipelines'
import type { CameraData } from './view'

export const MAX_CASCADES = 4
export const MAX_SHADOWED_SPOTS = 8
export const MAX_SHADOWED_POINTS = 4

/** Floats in a view's ShadowData buffer (see `shard::pbr::shadows`). */
export const SHADOW_DATA_FLOATS = 644
const OFF = {
  cascadeViewProj: 0,
  cascadeSplits: 64,
  cascadeTexel: 68,
  cascadeParams: 72,
  cascadeLight: 76,
  spotViewProj: 80,
  pointPosition: 208,
  pointViewProj: 224,
  sizes: 608,
  spotParams: 612,
} as const

/** Point shadow faces cover a little more than 90° so PCF taps near an edge stay on the face. */
export function pointTanHalf(size: number): number {
  return 1 + 3 / size
}

/** Uniform stride for a shadow view's matrix (dynamic offsets need 256-byte alignment). */
const VIEW_STRIDE = 256

export interface ShadowViewDraw {
  viewProj: Float32Array
  frustum: Float32Array
  draws: DrawList
  /** Dynamic offset of this view's matrix in the frame's shadow uniforms. */
  offset: number
}

function shadowView(): ShadowViewDraw {
  return { viewProj: mat4.create(), frustum: frustum.create(), draws: createDrawList(), offset: 0 }
}

/** A camera's cascades: fitted each frame, one depth layer each. */
export class Cascades {
  count = 0
  readonly views: ShadowViewDraw[] = [shadowView(), shadowView(), shadowView(), shadowView()]
  readonly splits = new Float32Array(4)
  readonly texel = new Float32Array(4)
  /** Light-space centers after snapping (for tests: sub-texel moves don't change them). */
  readonly centers = new Float32Array(12)
  texture: GPUTexture | undefined
  size = 0
  generation = -1

  ensureTexture(gpu: GpuContext, size: number, label: string): GPUTexture {
    if (!this.texture || this.size !== size || this.generation !== gpu.generation) {
      this.texture?.destroy()
      this.texture = gpu.device.createTexture({
        label: `${label}/cascades`,
        size: [size, size, MAX_CASCADES],
        format: 'depth32float',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      })
      this.size = size
      this.generation = gpu.generation
    }
    return this.texture
  }
}

const scratchPlanes = new Float32Array(24)
const scratchBox = new Float32Array(6)

/** Unit basis for a light shining along `f` (world): right, up, forward, rows. */
function lightBasis(out: Float32Array, fx: number, fy: number, fz: number): Float32Array {
  // up = world Y unless the light is (almost) vertical.
  let ux = 0
  let uy = 1
  let uz = 0
  if (Math.abs(fy) > 0.99) {
    ux = 1
    uy = 0
  }
  // right = normalize(f × up)
  let rx = fy * uz - fz * uy
  let ry = fz * ux - fx * uz
  let rz = fx * uy - fy * ux
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz)
  rx /= rl
  ry /= rl
  rz /= rl
  // up = right × f
  ux = ry * fz - rz * fy
  uy = rz * fx - rx * fz
  uz = rx * fy - ry * fx
  out[0] = rx
  out[1] = ry
  out[2] = rz
  out[3] = ux
  out[4] = uy
  out[5] = uz
  out[6] = fx
  out[7] = fy
  out[8] = fz
  return out
}

const basis = new Float32Array(9)
const scratchLightView = mat4.create()
const scratchLightProj = mat4.create()

/**
 * Practical split scheme: a blend of logarithmic and uniform splits. Returns the far view depth of
 * each cascade.
 */
export function cascadeSplits(
  out: Float32Array,
  count: number,
  near: number,
  far: number,
  lambda: number,
): Float32Array {
  for (let i = 1; i <= count; i++) {
    const log = near * (far / near) ** (i / count)
    const uniform = near + ((far - near) * i) / count
    out[i - 1] = lambda * log + (1 - lambda) * uniform
  }
  return out
}

/**
 * The bounding sphere of a view-frustum slice [a, b] (view depths): its center's view depth and its
 * radius. Depends only on the projection, so the sphere doesn't change size as the camera turns.
 */
export function sliceSphere(cam: CameraData, a: number, b: number): [number, number] {
  let ha: number
  let hb: number
  if (cam.orthographic) {
    const hy = cam.orthoHeight / 2
    const hx = hy * cam.aspect
    ha = hb = hx * hx + hy * hy
  } else {
    const t = Math.tan(cam.fovY / 2)
    const k = 1 + cam.aspect * cam.aspect
    ha = a * a * t * t * k
    hb = b * b * t * t * k
  }
  let c = (a + b) / 2 + (hb - ha) / (2 * (b - a))
  if (c > b) c = b
  if (c < a) c = a
  const r = Math.sqrt(Math.max(hb + (b - c) * (b - c), ha + (c - a) * (c - a)))
  return [c, r]
}

/**
 * Fits and culls a camera's cascades for a sun direction (toward the light). Each cascade is the
 * slice's bounding sphere, snapped to texels in light space, with its depth range reaching back to
 * the casters that can shade it.
 */
export function fitCascades(
  cascades: Cascades,
  cam: CameraData,
  sun: { direction: Float32Array; count: number; maxDistance: number; splitLambda: number },
  size: number,
  cull: (view: ShadowViewDraw, planes: Float32Array, box: Float32Array) => boolean,
): void {
  const count = Math.min(MAX_CASCADES, Math.max(1, sun.count))
  cascades.count = count
  const near = Math.max(cam.near, 1e-3)
  const far = Math.max(near * 1.01, sun.maxDistance)
  cascadeSplits(cascades.splits, count, near, far, sun.splitLambda)
  for (let i = count; i < 4; i++) cascades.splits[i] = 0
  // The light travels along -direction.
  const fx = -sun.direction[0]!
  const fy = -sun.direction[1]!
  const fz = -sun.direction[2]!
  lightBasis(basis, fx, fy, fz)
  let start = near
  for (let i = 0; i < count; i++) {
    const end = cascades.splits[i]!
    const [depth, radius] = sliceSphere(cam, start, end)
    start = end
    const cxw = cam.position[0]! + cam.forward[0]! * depth
    const cyw = cam.position[1]! + cam.forward[1]! * depth
    const czw = cam.position[2]! + cam.forward[2]! * depth
    const texel = (2 * radius) / size
    // Light-space center, snapped to whole texels so edges don't swim as the camera moves.
    const lx = Math.floor((basis[0]! * cxw + basis[1]! * cyw + basis[2]! * czw) / texel) * texel
    const ly = Math.floor((basis[3]! * cxw + basis[4]! * cyw + basis[5]! * czw) / texel) * texel
    const lz = Math.floor((basis[6]! * cxw + basis[7]! * cyw + basis[8]! * czw) / texel) * texel
    cascades.centers[i * 3] = lx
    cascades.centers[i * 3 + 1] = ly
    cascades.centers[i * 3 + 2] = lz
    cascades.texel[i] = texel
    // Cull planes: four sides and the far side; nothing between the light and the cascade is culled.
    const p = scratchPlanes
    const set = (k: number, nx: number, ny: number, nz: number, d: number) => {
      p[k * 4] = nx
      p[k * 4 + 1] = ny
      p[k * 4 + 2] = nz
      p[k * 4 + 3] = d
    }
    set(0, basis[0]!, basis[1]!, basis[2]!, -(lx - radius))
    set(1, -basis[0]!, -basis[1]!, -basis[2]!, lx + radius)
    set(2, basis[3]!, basis[4]!, basis[5]!, -(ly - radius))
    set(3, -basis[3]!, -basis[4]!, -basis[5]!, ly + radius)
    set(4, -basis[6]!, -basis[7]!, -basis[8]!, lz + radius)
    set(5, 0, 0, 0, 1)
    const view = cascades.views[i]!
    const any = cull(view, p, scratchBox)
    // Depth range: from the nearest culled caster to the far side of the sphere, quantized.
    let zNear = lz - radius
    if (any) {
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? scratchBox[3]! : scratchBox[0]!
        const y = c & 2 ? scratchBox[4]! : scratchBox[1]!
        const z = c & 4 ? scratchBox[5]! : scratchBox[2]!
        const d = basis[6]! * x + basis[7]! * y + basis[8]! * z
        if (d < zNear) zNear = d
      }
    }
    const q = radius * 0.25
    zNear = Math.floor((zNear - q * 0.5) / q) * q
    const zFar = lz + radius
    // View: rotation into light space (camera looks down -Z, so z row = -forward).
    const v = mat4.identity(scratchLightView)
    v[0] = basis[0]!
    v[4] = basis[1]!
    v[8] = basis[2]!
    v[1] = basis[3]!
    v[5] = basis[4]!
    v[9] = basis[5]!
    v[2] = -basis[6]!
    v[6] = -basis[7]!
    v[10] = -basis[8]!
    const proj = mat4.orthographicReversedZ(
      scratchLightProj,
      lx - radius,
      lx + radius,
      ly - radius,
      ly + radius,
      zNear,
      zFar,
    )
    mat4.multiply(view.viewProj, proj, v)
    frustum.fromViewProjection(view.frustum, view.viewProj)
  }
}

/** Spot and point shadows: shared by every camera, rendered once per frame. */
export class LocalShadows {
  readonly spots: (LightRecord | undefined)[] = []
  readonly points: (LightRecord | undefined)[] = []
  readonly spotViews: ShadowViewDraw[] = []
  readonly pointViews: ShadowViewDraw[] = []
  /** Near plane and tan(half angle) per spot. */
  readonly spotParams = new Float32Array(MAX_SHADOWED_SPOTS * 4)
  /** Position and near plane per point light. */
  readonly pointPositions = new Float32Array(MAX_SHADOWED_POINTS * 4)
  /** Shadow-casting lights that didn't fit the budget this frame. */
  overBudget: LightRecord[] = []
  spotTexture: GPUTexture | undefined
  pointTexture: GPUTexture | undefined
  spotLayers = 0
  pointLayers = 0
  size = 0
  generation = -1
  /** The frame these were last rendered (they render once per frame, not per view). */
  renderedFrame = -1

  constructor() {
    for (let i = 0; i < MAX_SHADOWED_SPOTS; i++) this.spotViews.push(shadowView())
    for (let i = 0; i < MAX_SHADOWED_POINTS * 6; i++) this.pointViews.push(shadowView())
  }

  ensureTextures(gpu: GpuContext, size: number): void {
    const spotLayers = Math.max(1, this.spots.length)
    const pointLayers = Math.max(1, this.points.length) * 6
    const fresh = this.generation !== gpu.generation || this.size !== size
    const make = (label: string, layers: number) =>
      gpu.device.createTexture({
        label,
        size: [size, size, layers],
        format: 'depth32float',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      })
    if (fresh || !this.spotTexture || spotLayers > this.spotLayers) {
      this.spotTexture?.destroy()
      this.spotLayers = Math.max(spotLayers, fresh ? 1 : this.spotLayers)
      this.spotTexture = make('shadows/spots', this.spotLayers)
    }
    if (fresh || !this.pointTexture || pointLayers > this.pointLayers) {
      this.pointTexture?.destroy()
      this.pointLayers = Math.max(pointLayers, fresh ? 6 : this.pointLayers)
      this.pointTexture = make('shadows/points', this.pointLayers)
    }
    this.size = size
    this.generation = gpu.generation
  }
}

/** Point shadow faces: +X, -X, +Y, -Y, +Z, -Z, each with an up vector. Mirrors the WGSL lookup. */
const FACES = [
  [1, 0, 0, 0, -1, 0],
  [-1, 0, 0, 0, -1, 0],
  [0, 1, 0, 0, 0, 1],
  [0, -1, 0, 0, 0, -1],
  [0, 0, 1, 0, -1, 0],
  [0, 0, -1, 0, -1, 0],
] as const

function lookDir(
  out: Float32Array,
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
  upx: number,
  upy: number,
  upz: number,
): Float32Array {
  return mat4.lookAt(out, [px, py, pz], [px + dx, py + dy, pz + dz], [upx, upy, upz])
}

const scratchView = mat4.create()
const scratchProj = mat4.create()

/**
 * Ranks shadow-casting spot and point lights by screen-space influence from `cam` and assigns
 * shadow maps within the budgets. Lights over budget render without shadows this frame.
 */
export function assignLocalShadows(
  shadows: LocalShadows,
  store: LightStore,
  cam: CameraData | undefined,
  maxSpots: number,
  maxPoints: number,
): void {
  const spots: { r: LightRecord; score: number }[] = []
  const points: { r: LightRecord; score: number }[] = []
  for (let s = 0; s < store.high; s++) {
    const r = store.records[s]
    if (!r?.alive) continue
    if (!r.shadows || !cam) {
      setShadowIndex(store, r, -1)
      continue
    }
    const dx = r.x - cam.position[0]!
    const dy = r.y - cam.position[1]!
    const dz = r.z - cam.position[2]!
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    // Angular size of the light's sphere of influence; inside it, it's everything.
    let score = r.range / Math.max(d - r.range, 1e-3)
    // Off-screen lights still cast shadows on-screen, but rank below visible ones.
    let visible = true
    for (let p = 0; p < 24; p += 4) {
      const f = cam.frustum
      if (f[p]! * r.x + f[p + 1]! * r.y + f[p + 2]! * r.z + f[p + 3]! < -r.range) visible = false
    }
    if (!visible) score *= 1e-6
    ;(r.kind === 1 ? spots : points).push({ r, score })
  }
  const byScore = (a: { r: LightRecord; score: number }, b: { r: LightRecord; score: number }) =>
    b.score - a.score || b.r.intensity - a.r.intensity || a.r.slot - b.r.slot
  spots.sort(byScore)
  points.sort(byScore)
  const over: LightRecord[] = []
  shadows.spots.length = 0
  shadows.points.length = 0
  spots.forEach(({ r }, i) => {
    if (i < Math.min(maxSpots, MAX_SHADOWED_SPOTS)) {
      setShadowIndex(store, r, i)
      shadows.spots.push(r)
    } else {
      setShadowIndex(store, r, -1)
      over.push(r)
    }
  })
  points.forEach(({ r }, i) => {
    if (i < Math.min(maxPoints, MAX_SHADOWED_POINTS)) {
      setShadowIndex(store, r, i)
      shadows.points.push(r)
    } else {
      setShadowIndex(store, r, -1)
      over.push(r)
    }
  })
  shadows.overBudget = over
}

/** Builds the spot and point shadow view matrices for the assigned lights. */
export function fitLocalShadows(shadows: LocalShadows, size: number): void {
  for (let i = 0; i < shadows.spots.length; i++) {
    const r = shadows.spots[i]!
    const near = Math.max(0.05, r.radius)
    const tanHalf = Math.tan((Math.min(r.outerAngle, 89) * Math.PI) / 180) * (1 + 3 / size)
    const up = Math.abs(r.dy) > 0.99 ? [1, 0, 0] : [0, 1, 0]
    lookDir(scratchView, r.x, r.y, r.z, r.dx, r.dy, r.dz, up[0]!, up[1]!, up[2]!)
    mat4.perspectiveReversedZ(scratchProj, 2 * Math.atan(tanHalf), 1, near)
    const view = shadows.spotViews[i]!
    mat4.multiply(view.viewProj, scratchProj, scratchView)
    frustum.fromViewProjection(view.frustum, view.viewProj)
    shadows.spotParams[i * 4] = tanHalf
    shadows.spotParams[i * 4 + 1] = near
  }
  const tanHalf = pointTanHalf(size)
  for (let i = 0; i < shadows.points.length; i++) {
    const r = shadows.points[i]!
    const near = Math.max(0.05, r.radius)
    shadows.pointPositions[i * 4] = r.x
    shadows.pointPositions[i * 4 + 1] = r.y
    shadows.pointPositions[i * 4 + 2] = r.z
    shadows.pointPositions[i * 4 + 3] = near
    mat4.perspectiveReversedZ(scratchProj, 2 * Math.atan(tanHalf), 1, near)
    for (let f = 0; f < 6; f++) {
      const face = FACES[f]!
      lookDir(scratchView, r.x, r.y, r.z, face[0], face[1], face[2], face[3], face[4], face[5])
      const view = shadows.pointViews[i * 6 + f]!
      mat4.multiply(view.viewProj, scratchProj, scratchView)
      frustum.fromViewProjection(view.frustum, view.viewProj)
    }
  }
}

/** Packs a view's ShadowData: its cascades plus the shared spot and point shadows. */
export function packShadowData(
  out: Float32Array,
  cascades: Cascades | undefined,
  sun: { direction: Float32Array; bias: number; normalBias: number; softness: number } | null,
  local: LocalShadows,
  cascadeSize: number,
  size: number,
): void {
  out.fill(0)
  if (cascades && sun && cascades.count > 0) {
    for (let i = 0; i < cascades.count; i++) {
      out.set(cascades.views[i]!.viewProj, OFF.cascadeViewProj + i * 16)
      out[OFF.cascadeSplits + i] = cascades.splits[i]!
      out[OFF.cascadeTexel + i] = cascades.texel[i]!
    }
    out[OFF.cascadeParams] = cascades.count
    out[OFF.cascadeParams + 1] = sun.bias
    out[OFF.cascadeParams + 2] = sun.normalBias
    out[OFF.cascadeParams + 3] = sun.softness
    out[OFF.cascadeLight] = sun.direction[0]!
    out[OFF.cascadeLight + 1] = sun.direction[1]!
    out[OFF.cascadeLight + 2] = sun.direction[2]!
    out[OFF.cascadeLight + 3] = 1
  }
  for (let i = 0; i < local.spots.length; i++) {
    out.set(local.spotViews[i]!.viewProj, OFF.spotViewProj + i * 16)
    out[OFF.spotParams + i * 4] = local.spotParams[i * 4]!
    out[OFF.spotParams + i * 4 + 1] = local.spotParams[i * 4 + 1]!
  }
  for (let i = 0; i < local.points.length; i++) {
    for (let k = 0; k < 4; k++)
      out[OFF.pointPosition + i * 4 + k] = local.pointPositions[i * 4 + k]!
    for (let f = 0; f < 6; f++)
      out.set(local.pointViews[i * 6 + f]!.viewProj, OFF.pointViewProj + (i * 6 + f) * 16)
  }
  out[OFF.sizes] = cascadeSize
  out[OFF.sizes + 1] = size
  out[OFF.sizes + 2] = pointTanHalf(size)
}

// --- GPU passes ----------------------------------------------------------------

/** Shadow view matrices for every shadow pass in the frame, at 256-byte offsets. */
export class ShadowPassUniforms {
  data = new Float32Array((VIEW_STRIDE / 4) * 64)
  count = 0
  readonly buffer: GpuBuffer
  bindGroup: GPUBindGroup | undefined
  private bound = ''
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.buffer = new GpuBuffer(gpu, {
      label: 'shadows/views',
      usage: GPUBufferUsage.UNIFORM,
      size: VIEW_STRIDE * 64,
    })
  }

  reset(): void {
    this.count = 0
  }

  /** Adds a view matrix; returns its dynamic offset. */
  push(viewProj: Float32Array): number {
    const floats = VIEW_STRIDE / 4
    if ((this.count + 1) * floats > this.data.length) {
      const grown = new Float32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    this.data.set(viewProj, this.count * floats)
    return this.count++ * VIEW_STRIDE
  }

  upload(layout: GPUBindGroupLayout, globals: GpuBuffer): void {
    if (this.count > 0) this.buffer.write(this.data, 0, 0, (this.count * VIEW_STRIDE) / 4)
    const key = `${this.buffer.version}/${globals.version}/${this.gpu.generation}`
    if (!this.bindGroup || this.bound !== key) {
      this.bindGroup = this.gpu.device.createBindGroup({
        label: 'shadows/views',
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer.buffer, size: 64 } },
          { binding: 14, resource: { buffer: globals.buffer } },
        ],
      })
      this.bound = key
    }
  }
}

export function shadowViewLayout(gpu: GpuContext): GPUBindGroupLayout {
  return gpu.layouts.bindGroupLayout({
    label: 'shadows/view',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      },
      {
        binding: 14,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  })
}

const SHADOW_BUFFERS: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] },
]

/**
 * Draws a shadow view's casters into a depth layer, with each material type's vertex stage (so
 * `vertex_position` displacement moves shadows too). Opaque materials are vertex-only; masked
 * standard materials run the surface stage to discard.
 */
export function drawShadowCasters(
  ctx: NodeContext,
  target: GPUTextureView,
  view: ShadowViewDraw,
  offset: number,
  uniforms: ShadowPassUniforms,
  pipelines: MaterialPipelines,
  shadowView: GPUBindGroupLayout,
  label: string,
): void {
  const world = ctx.world
  const gpu = ctx.gpu
  const store = world.resource(Instances)
  const assets = world.resource(GpuAssetsResource)
  const pass = ctx.encoder.beginRenderPass({
    label,
    colorAttachments: [],
    depthStencilAttachment: {
      view: target,
      depthLoadOp: 'clear',
      depthClearValue: 0,
      depthStoreOp: 'store',
    },
    timestampWrites: ctx.timestamps(label),
  })
  const draws0 = view.draws
  const instances = draws0.cullView >= 0 ? store.gpuBindGroup : store.bindGroup
  if (!instances || !uniforms.bindGroup) {
    pass.end()
    return
  }
  const args = world.resource(Culler).args.buffer
  pass.setBindGroup(0, uniforms.bindGroup, [offset])
  pass.setBindGroup(2, instances)
  let current: GPURenderPipeline | undefined
  let boundMaterial: GPUBindGroup | undefined
  let boundPositions: GPUBuffer | undefined
  let boundTangents: GPUBuffer | undefined
  let boundIndices: GPUBuffer | undefined
  const draws = view.draws
  for (let d = 0; d < draws.length; d++) {
    const item = draws.items[d]!
    const material = item.batch.material
    const type = material.type
    const variant = materialVariant(material)
    const masked = type.standard && variantBlend(variant) === 'mask'
    const key = ((PASS_SHADOW * 1024 + typeOrdinal(type)) * 16 + variant) * 8
    let pipeline = pipelines.cached(key)
    if (!pipeline) {
      const module = pipelines.module(world, gpu, type, 8, 'shard::pbr::shadow', undefined)
      if (!module) {
        gpu.pipelines.skipped++
        continue
      }
      pipeline = pipelines.create(gpu, key, {
        label: `shadow/${type.name}/${masked ? 'mask' : 'opaque'}/${variantCull(variant)}`,
        layout: gpu.layouts.pipelineLayout({
          label: `shadow/${type.name}`,
          bindGroupLayouts: [shadowView, assets.layoutOf(type), store.layout],
        }),
        vertex: { module, entryPoint: 'vs', buffers: SHADOW_BUFFERS },
        fragment: masked ? { module, entryPoint: 'fs_mask', targets: [] } : undefined,
        primitive: { topology: 'triangle-list', cullMode: variantCull(variant), frontFace: 'ccw' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      })
      if (!pipeline) continue
    }
    const mat = assets.material(world, material)
    if (!mat?.bindGroup) continue
    const gm = assets.mesh(item.batch.mesh)
    if (pipeline !== current) {
      pass.setPipeline(pipeline)
      current = pipeline
      boundMaterial = undefined
    }
    // Consecutive draws often share these (terrain chunks share one set of buffers).
    if (mat.bindGroup !== boundMaterial) {
      pass.setBindGroup(1, mat.bindGroup)
      boundMaterial = mat.bindGroup
    }
    if (gm.positions !== boundPositions || gm.tangents !== boundTangents) {
      pass.setVertexBuffer(0, gm.positions)
      pass.setVertexBuffer(1, gm.normals)
      pass.setVertexBuffer(2, gm.uvs)
      pass.setVertexBuffer(3, gm.uvs1)
      pass.setVertexBuffer(4, gm.tangents)
      boundPositions = gm.positions
      boundTangents = gm.tangents
    }
    if (gm.indices) {
      if (gm.indices !== boundIndices) {
        pass.setIndexBuffer(gm.indices, gm.indexFormat)
        boundIndices = gm.indices
      }
      if (item.indirect >= 0) pass.drawIndexedIndirect(args, item.indirect)
      else pass.drawIndexed(gm.count, item.count, 0, gm.baseVertex, item.first)
    } else if (item.indirect >= 0) {
      pass.drawIndirect(args, item.indirect)
    } else {
      pass.draw(gm.count, item.count, 0, item.first)
    }
  }
  pass.end()
}

const PASS_SHADOW = 2

/** Culls instances that cast shadows into a shadow view, and unions their world bounds. */
export function cullCasters(
  world: World,
  view: ShadowViewDraw,
  planes: Float32Array,
  box?: Float32Array,
): boolean {
  const store = world.resource(Instances)
  store.cull(view.draws, planes, InstanceFlags.Caster, box)
  return view.draws.visible > 0
}

export const ShadowsResource = defineResource<{
  local: LocalShadows
  uniforms: ShadowPassUniforms
}>('render/Shadows', { description: 'Spot and point shadow maps, shared by all cameras.' })
