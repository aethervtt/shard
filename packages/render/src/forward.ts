import { defineResource, defineSystem, First, Last, PostUpdate, type World } from '@shard/core'
import { GpuBuffer, type GpuContext } from '@shard/gpu'
import { definePlugin, LogResource, type Plugin, Time } from '@shard/runtime'
import { setTextureCapabilities, Textures } from '@shard/texture'
import { TransformSystems } from '@shard/transform'
import { Materials, Meshes, RenderTargets } from './assets'
import { applyPhysicalCameras } from './camera'
import {
  CLUSTER_COUNT,
  CLUSTER_Z,
  ClusterBuffers,
  clusterRange,
  MAX_LIGHTS_PER_CLUSTER,
  ViewLightList,
} from './clusters'
import { Culler, cullTransparent, GpuCuller } from './culling'
import { describeCulling, describeLighting } from './debug-views'
import { addDeferredNodes } from './deferred'
import {
  DefaultEnvironment,
  describeEnvironment,
  Environments,
  environmentParams,
  prepareEnvironments,
  runEnvironmentWork,
  sunDiskLuminance,
} from './environment'
import { beginGizmos, Gizmos, gizmoNode, uploadGizmos } from './gizmos'
import { GpuAssets, GpuAssetsResource } from './gpu-assets'
import { type ColorAttachment, type NodeContext, RenderPhase, type RenderView } from './graph'
import {
  type CullParams,
  type DrawList,
  InstanceFlags,
  InstanceStore,
  Instances,
  LOD_UNSET,
  Mesh3d,
  MeshMaterial,
  observeInstanceRemovals,
  prepareInstances,
} from './instances'
import { observeOriginShifts } from './large-world'
import {
  AmbientLight,
  extractLights,
  LightingSettings,
  LightStore,
  Lights,
  observeLightRemovals,
} from './lights'
import {
  blendState,
  MaterialPipelines,
  materialVariant,
  typeOrdinal,
  variantBlend,
  variantCull,
} from './material-pipelines'
import { isTransparent, type MaterialType } from './materials'
import { DebugOverlays, drawOverlays } from './overlays'
import { addPickNodes, Picking } from './picking'
import { pixelUpscaleNode } from './pixel-perfect'
import { Gpu, Graph, RenderDescribers, RenderSet, Shaders, Views } from './plugin'
import { adaptExposure, addPostNodes, describePost } from './post-nodes'
import { viewLayout } from './shaders'
import {
  assignLocalShadows,
  Cascades,
  drawShadowCasters,
  fitCascades,
  fitLocalShadows,
  LocalShadows,
  packShadowData,
  SHADOW_DATA_FLOATS,
  ShadowPassUniforms,
  ShadowsResource,
  shadowViewLayout,
} from './shadows'
import { prepareDeforms, Skins } from './skinning'
import { GpuMemory, RenderStats } from './stats'
import { type CameraData, Cameras, cameraOf, extractCameras, ViewSettings } from './view'
import { computeVisibility } from './visibility'

export { Mesh3d, MeshMaterial }

/** Per camera view: uniforms, clusters, lights, and shadows, and the bind groups over them. */
export interface ViewGpu {
  uniform: GpuBuffer
  /** This frame's SSAO texture, when the camera has Ssao. */
  ao: GPUTexture | undefined
  lightList: ViewLightList
  clusters: ClusterBuffers
  shadowData: GpuBuffer
  cascades: Cascades
  bindGroup: GPUBindGroup | undefined
  bound: string
  clusterBindGroup: GPUBindGroup | undefined
  clusterBound: string
}

interface Layouts {
  view: GPUBindGroupLayout
  pipeline: GPUPipelineLayout
  cluster: GPUBindGroupLayout
  clusterPipeline: GPUPipelineLayout
  shadowView: GPUBindGroupLayout
  shadowPipeline: GPUPipelineLayout
}

export interface ForwardState {
  views: Map<string, ViewGpu>
  viewBytes: DataView
  shadowFloats: Float32Array
  layouts: Layouts
  layoutGeneration: number
  /** A 1x1x1 depth array bound where no shadow map exists (and its generation). */
  emptyShadow: { texture: GPUTexture; generation: number } | undefined
  white: { texture: GPUTexture; generation: number } | undefined
  shadowSampler: GPUSampler | undefined
  /** Frame counter, so shared passes (local shadows) run once per frame. */
  frame: number
  /** Last warnings, so each is logged once per change. */
  warned: { budget: string; overflow: string }
  /** Time, delta time, and frame for shaders (`shard::globals`). */
  globals: GpuBuffer
  globalsData: Float32Array
  pipelines: MaterialPipelines
  /** G-buffer color targets (the emissive format depends on the device). */
  gbufferTargets: GPUColorTargetState[]
  /** Whether GPU culling ran this frame (the cull node reads it). */
  cullerActive: boolean
}

export const ForwardStateResource = defineResource<ForwardState>('render/ForwardState')
const State = ForwardStateResource

// --- prepare -------------------------------------------------------------------

/** Ranks shadowed spot and point lights for the main camera and uploads changed lights. */
const prepareLights = defineSystem({
  name: 'render/prepare-lights',
  description: 'Assigns shadow maps within the budgets and uploads changed lights.',
  run: (_, world) => {
    const lights = world.resource(Lights)
    const shadows = world.resource(ShadowsResource)
    const settings = world.resource(LightingSettings)
    let main: CameraData | undefined
    let order = Number.POSITIVE_INFINITY
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (cam && view.order < order) {
        main = cam
        order = view.order
      }
    }
    assignLocalShadows(
      shadows.local,
      lights,
      main,
      settings.maxShadowedSpots,
      settings.maxShadowedPoints,
    )
    lights.upload()
    const state = world.resource(State)
    const over = shadows.local.overBudget.map((r) => r.entity).join(',')
    if (over !== state.warned.budget) {
      state.warned.budget = over
      if (over) {
        world
          .tryResource(LogResource)
          ?.log(
            'warn',
            `${shadows.local.overBudget.length} shadowed light(s) over the shadow budget render without shadows`,
            {
              code: 'render/shadow-budget',
              hint: 'Raise LightingSettings.maxShadowedSpots/maxShadowedPoints, or turn off shadows on minor lights.',
              data: { lights: shadows.local.overBudget.map((r) => r.entity) },
            },
          )
      }
    }
  },
})

// --- queue ---------------------------------------------------------------------

/** Reused cull parameters (no per-frame allocation). */
const cameraCull: CullParams = {
  planes: null,
  require: 0,
  eye: undefined,
  lodScale: 1,
  orthographic: false,
  lodState: undefined,
  updateLod: true,
}
const shadowCull: CullParams = {
  planes: null,
  require: InstanceFlags.Caster,
  eye: undefined,
  lodScale: 1,
  orthographic: false,
  lodState: undefined,
  updateLod: false,
}

/** Culling parameters of a camera: its (possibly frozen) frustum, eye, and LOD scale. */
function cameraParams(cam: CameraData, out: CullParams): CullParams {
  out.planes = cam.frozenFrustum ?? cam.frustum
  out.eye = cam.frozenPosition ?? cam.position
  out.orthographic = cam.orthographic
  // Screen size = diameter / viewport height: 2r / (2 d tan(fov/2)), or 2r / orthoHeight.
  out.lodScale = cam.orthographic ? 2 / cam.orthoHeight : 1 / Math.tan(cam.fovY / 2)
  if (cam.lodState.length < cam.lodCapacity)
    cam.lodState = new Uint8Array(cam.lodCapacity).fill(LOD_UNSET)
  out.lodState = cam.lodState
  return out
}

const queue = defineSystem({
  name: 'render/forward-queue',
  description:
    'Culls instances per camera and shadow view (on the GPU when it can), clusters lights, and writes view uniforms.',
  run: (_, world) => {
    const state = world.resource(State)
    const gpu = world.resource(Gpu)
    const store = world.resource(Instances)
    const culler = world.resource(Culler)
    const lights = world.resource(Lights)
    const shadows = world.resource(ShadowsResource)
    const settings = world.resource(LightingSettings)
    const stats = world.resource(RenderStats)
    stats.clear()
    state.frame++
    ensureLayouts(gpu, state, world.resource(GpuAssetsResource), store)
    state.pipelines.beginFrame(state.frame)
    shadows.uniforms.reset()
    culler.beginFrame()
    const gpuCull = culler.active
    state.cullerActive = gpuCull
    const time = world.resource(Time)
    const g = state.globalsData
    g[0] = time.elapsed
    g[1] = time.delta
    new Uint32Array(g.buffer)[2] = time.frame
    state.globals.write(g)

    // Camera views first: they choose LOD levels, which their shadow views reuse.
    let main: CameraData | undefined
    let mainOrder = Number.POSITIVE_INFINITY
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      cam.lodCapacity = store.capacity
      const params = cameraParams(cam, cameraCull)
      const forwardOnly = cam.deferred ? cam.forwardOnly : undefined
      if (gpuCull) {
        culler.add(store, cam.draws, params, culler.lodCamera(cam.entity), forwardOnly)
        cullTransparent(store, cam.transparent, params, cam.forward)
      } else {
        store.cullCpu(cam.draws, params, undefined, cam.transparent, cam.forward, forwardOnly)
      }
      if (view.order < mainOrder) {
        main = cam
        mainOrder = view.order
      }
    }

    // Shadow views: culled with their own frustums, measured from (and at the LOD of) the camera.
    const shadowParams = (cam: CameraData, planes: Float32Array) => {
      cameraParams(cam, shadowCull)
      shadowCull.planes = planes
      shadowCull.updateLod = false
      return shadowCull
    }
    const cullShadow = (
      cam: CameraData,
      draws: DrawList,
      planes: Float32Array,
      box?: Float32Array,
    ) => {
      const params = shadowParams(cam, planes)
      if (gpuCull) {
        culler.add(store, draws, params, culler.lodCamera(cam.entity))
        // No CPU cull to take a union from: fit to every caster instead.
        if (box) store.casterBounds(box)
        return true
      }
      store.cullCpu(draws, params, box)
      return draws.visible > 0
    }
    const local = shadows.local
    fitLocalShadows(local, settings.shadowMapSize)
    if (main) {
      for (let i = 0; i < local.spots.length; i++) {
        const view = local.spotViews[i]!
        cullShadow(main, view.draws, view.frustum)
        view.offset = shadows.uniforms.push(view.viewProj)
      }
      for (let i = 0; i < local.points.length * 6; i++) {
        const view = local.pointViews[i]!
        cullShadow(main, view.draws, view.frustum)
        view.offset = shadows.uniforms.push(view.viewProj)
      }
    }

    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      const pv = viewGpu(gpu, state, view.name)
      pv.ao = undefined // the SSAO node sets it when it runs
      pv.lightList.build(cam, lights.records, lights.high)
      pv.clusters.upload(pv.lightList, cam, settings.clusterFar)
      const sun = lights.shadowSun
      if (sun) {
        fitCascades(pv.cascades, cam, sun, settings.cascadeMapSize, (v, planes, box) =>
          cullShadow(cam, v.draws, planes, box),
        )
        for (let i = 0; i < pv.cascades.count; i++) {
          const v = pv.cascades.views[i]!
          v.offset = shadows.uniforms.push(v.viewProj)
        }
      } else {
        pv.cascades.count = 0
      }
      packShadowData(
        state.shadowFloats,
        sun ? pv.cascades : undefined,
        sun,
        local,
        settings.cascadeMapSize,
        settings.shadowMapSize,
      )
      pv.shadowData.write(state.shadowFloats)
      writeViewUniform(world, state, pv, cam, world.resource(AmbientLight), settings.clusterFar)
      const st = drawStats(cam.draws)
      if (cam.draws.cullView >= 0) {
        // GPU culled: counts come back a frame or two late; draws that had nothing don't count.
        st.drawCalls = culler.drawCounts.get(cam.draws) ?? 0
        st.hidden = store.hiddenCount
        const others = cam.deferred ? (culler.counts.get(cam.forwardOnly) ?? 0) : 0
        st.culled = Math.max(0, store.drawableCount - store.hiddenCount - st.visible - others)
      }
      if (cam.deferred) {
        st.visible += cam.forwardOnly.visible
        st.drawCalls +=
          cam.forwardOnly.cullView >= 0
            ? (culler.drawCounts.get(cam.forwardOnly) ?? 0)
            : cam.forwardOnly.length
      }
      st.visible += cam.transparent.visible
      st.drawCalls += cam.transparent.length
      stats.set(view.name, st)
    }
  },
})

function viewGpu(gpu: GpuContext, state: ForwardState, name: string): ViewGpu {
  let pv = state.views.get(name)
  if (!pv) {
    pv = {
      uniform: new GpuBuffer(gpu, {
        label: `${name}/view`,
        usage: GPUBufferUsage.UNIFORM,
        size: viewLayout.size,
      }),
      lightList: new ViewLightList(),
      clusters: new ClusterBuffers(gpu, name),
      shadowData: new GpuBuffer(gpu, {
        label: `${name}/shadows`,
        usage: GPUBufferUsage.STORAGE,
        size: SHADOW_DATA_FLOATS * 4,
      }),
      cascades: new Cascades(),
      ao: undefined,
      bindGroup: undefined,
      bound: '',
      clusterBindGroup: undefined,
      clusterBound: '',
    }
    state.views.set(name, pv)
  }
  return pv
}

function drawStats(list: DrawList) {
  return {
    visible: list.visible,
    culled: list.culled,
    hidden: list.hidden,
    pending: list.pending,
    drawCalls: list.length,
    pipelineSwitches: 0,
  }
}

const viewport = new Float32Array(4)
const clusterParams = new Float32Array(4)
const ambientScratch = new Float32Array(3)
const envScratch = new Float32Array(4)

const jitterScratch = new Float32Array(4)

function writeViewUniform(
  world: World,
  state: ForwardState,
  pv: ViewGpu,
  cam: CameraData,
  ambient: { color: [number, number, number]; brightness: number },
  clusterFar: number,
) {
  environmentParams(world.resource(Environments), cam, envScratch)
  const [near, far] = clusterRange(cam, clusterFar)
  viewport[0] = cam.width
  viewport[1] = cam.height
  viewport[2] = 1 / cam.width
  viewport[3] = 1 / cam.height
  clusterParams[0] = near
  clusterParams[1] = far
  clusterParams[2] = CLUSTER_Z / Math.log(far / near)
  clusterParams[3] = cam.debug
  jitterScratch[0] = cam.post.jitter[0]!
  jitterScratch[1] = cam.post.jitter[1]!
  jitterScratch[2] = cam.frames
  ambientScratch[0] = ambient.color[0] * ambient.brightness
  ambientScratch[1] = ambient.color[1] * ambient.brightness
  ambientScratch[2] = ambient.color[2] * ambient.brightness
  viewLayout.write(state.viewBytes, 0, {
    viewProj: cam.viewProj as never,
    view: cam.view as never,
    invViewProj: cam.invViewProj as never,
    cameraPosition: cam.position as never,
    exposure: cam.exposure,
    viewport: viewport as never,
    clusterParams: clusterParams as never,
    ambient: ambientScratch as never,
    envParams: envScratch as never,
    viewProjNoJitter: cam.viewProjNoJitter as never,
    prevViewProj: cam.prevViewProj as never,
    jitter: jitterScratch as never,
  })
  pv.uniform.write(new Float32Array(state.viewBytes.buffer, 0, viewLayout.size / 4))
}

const upload = defineSystem({
  name: 'render/upload-visible',
  description: "Uploads every view's visible instance lists and shadow view matrices.",
  run: (_, world) => {
    const store = world.resource(Instances)
    const culler = world.resource(Culler)
    if (culler.active) {
      culler.prepare(store)
      store.gpuVisible = culler.visible
    }
    store.finishFrame()
    const state = world.resource(State)
    world.resource(ShadowsResource).uniforms.upload(state.layouts.shadowView, state.globals)
  },
})

// --- graph nodes ---------------------------------------------------------------

const VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] },
]

const FORWARD_DEFINES = [
  { PREMULTIPLY: false, MASK: false },
  { PREMULTIPLY: true, MASK: false },
  { PREMULTIPLY: false, MASK: true },
  { PREMULTIPLY: true, MASK: true },
] as const

/** The pipeline layout of a pass drawing a material type: view, material, instances. */
function materialLayout(
  gpu: GpuContext,
  state: ForwardState,
  assets: GpuAssets,
  type: MaterialType,
  store: InstanceStore,
) {
  return gpu.layouts.pipelineLayout({
    label: `forward/${type.name}`,
    bindGroupLayouts: [state.layouts.view, assets.layoutOf(type), store.layout],
  })
}

export const PASS_OPAQUE = 0
export const PASS_TRANSPARENT = 1
export const PASS_GBUFFER = 3
/** Depth, normals, and velocity for post-processing (TAA, motion blur, forward SSAO). */
export const PASS_PREPASS = 5
/** Entity ids, normals, and depth for GPU picking (picking.ts). */
export const PASS_PICK = 7

/**
 * The picking pass's color targets: entity id, and the world normal with the depth in w (0 where
 * nothing drew). Depth rides in a color target because depth formats only copy out whole.
 */
export const PICK_TARGETS: GPUColorTargetState[] = [
  { format: 'r32uint' },
  { format: 'rgba32float' },
]

const PREPASS_TARGETS: GPUColorTargetState[] = [{ format: 'rgba16float' }, { format: 'rg16float' }]

/**
 * Draws a list of batches with their material types' pipelines. Returns the pipeline switches, so
 * `render.describe` can show that sorting keeps them rare.
 */
export function drawMaterials(
  ctx: NodeContext,
  state: ForwardState,
  pv: ViewGpu,
  cam: CameraData,
  draws: DrawList,
  pass: number,
): number {
  const store = ctx.world.resource(Instances)
  const assets = ctx.world.resource(GpuAssetsResource)
  const gpu = ctx.gpu
  const renderPass = ctx.renderPass!
  const instances = draws.cullView >= 0 ? store.gpuBindGroup : store.bindGroup
  if (!instances) return 0
  const args = ctx.world.resource(Culler).args.buffer
  renderPass.setBindGroup(0, viewBindGroup(gpu, ctx.world, pv, cam))
  renderPass.setBindGroup(2, instances)
  let current: GPURenderPipeline | undefined
  let boundMaterial: GPUBindGroup | undefined
  let boundPositions: GPUBuffer | undefined
  let boundTangents: GPUBuffer | undefined
  let boundIndices: GPUBuffer | undefined
  let switches = 0
  for (let d = 0; d < draws.length; d++) {
    const item = draws.items[d]!
    const material = item.batch.material
    const type = material.type
    const variant = materialVariant(material)
    const blend = variantBlend(variant)
    const gbuffer = pass === PASS_GBUFFER
    const prepass = pass === PASS_PREPASS
    const pick = pass === PASS_PICK
    // The G-buffer only takes standard lighting; anything else draws forward.
    if (gbuffer && !type.standard) continue
    // The G-buffer, the prepass, and picking are always single-sampled.
    const msaa = gbuffer || prepass || pick ? 1 : cam.msaa
    const key = ((pass * 1024 + typeOrdinal(type)) * 16 + variant) * 8 + msaa
    let pipeline = state.pipelines.cached(key)
    if (!pipeline) {
      const premultiply = blend === 'premultiplied'
      const mask = blend === 'mask'
      const slot = pick
        ? 40
        : prepass
          ? 32 + (type.standard ? 0 : 4) + (mask ? 2 : 0)
          : (gbuffer ? 16 : type.standard ? 0 : 4) + (premultiply ? 1 : 0) + (mask ? 2 : 0)
      const module = state.pipelines.module(
        ctx.world,
        gpu,
        type,
        slot,
        pick
          ? 'shard::pick'
          : prepass
            ? type.standard
              ? 'shard::prepass'
              : 'shard::prepass::plain'
            : gbuffer
              ? 'shard::pbr::gbuffer_pass'
              : type.standard
                ? 'shard::pbr::forward'
                : 'shard::unlit::forward',
        FORWARD_DEFINES[slot & 3],
      )
      if (!module) {
        gpu.pipelines.skipped++ // a draw waiting on its shader is a skipped draw too
        continue
      }
      const transparent = isTransparent(blend) && !pick
      pipeline = state.pipelines.create(gpu, key, {
        label: `${pick ? 'pick' : prepass ? 'prepass' : gbuffer ? 'gbuffer' : 'forward'}/${type.name}/${blend}/x${msaa}/${variantCull(variant)}`,
        layout: materialLayout(gpu, state, assets, type, store),
        vertex: { module, entryPoint: 'vs', buffers: VERTEX_BUFFERS },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: pick
            ? PICK_TARGETS
            : prepass
              ? PREPASS_TARGETS
              : gbuffer
                ? state.gbufferTargets
                : [{ format: 'rgba16float', blend: blendState(blend) }],
        },
        primitive: { topology: 'triangle-list', cullMode: variantCull(variant), frontFace: 'ccw' },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: !transparent,
          depthCompare: transparent ? 'greater-equal' : 'greater',
        },
        multisample: { count: msaa },
      })
      if (!pipeline) continue
    }
    const mat = assets.material(ctx.world, material)
    if (!mat?.bindGroup) continue
    const gm = assets.mesh(item.batch.mesh)
    if (pipeline !== current) {
      renderPass.setPipeline(pipeline)
      current = pipeline
      boundMaterial = undefined
      switches++
    }
    // Consecutive draws often share these (terrain chunks share one set of buffers).
    if (mat.bindGroup !== boundMaterial) {
      renderPass.setBindGroup(1, mat.bindGroup)
      boundMaterial = mat.bindGroup
    }
    if (gm.positions !== boundPositions || gm.tangents !== boundTangents) {
      renderPass.setVertexBuffer(0, gm.positions)
      renderPass.setVertexBuffer(1, gm.normals)
      renderPass.setVertexBuffer(2, gm.uvs)
      renderPass.setVertexBuffer(3, gm.uvs1)
      renderPass.setVertexBuffer(4, gm.tangents)
      boundPositions = gm.positions
      boundTangents = gm.tangents
    }
    if (gm.indices) {
      if (gm.indices !== boundIndices) {
        renderPass.setIndexBuffer(gm.indices, gm.indexFormat)
        boundIndices = gm.indices
      }
      if (item.indirect >= 0) renderPass.drawIndexedIndirect(args, item.indirect)
      else renderPass.drawIndexed(gm.count, item.count, 0, gm.baseVertex, item.first)
    } else if (item.indirect >= 0) {
      renderPass.drawIndirect(args, item.indirect)
    } else {
      renderPass.draw(gm.count, item.count, 0, item.first)
    }
  }
  return switches
}

function recordSwitches(ctx: NodeContext, switches: number): void {
  const stats = ctx.world.resource(RenderStats).get(ctx.view.name)
  if (stats) stats.pipelineSwitches = Math.max(stats.pipelineSwitches ?? 0, switches)
}

const isCamera = (view: RenderView) => cameraOf(view) !== undefined
const msaaOf = (view: RenderView) => cameraOf(view)?.msaa ?? 1

/** A 1×1 white texture: "no occlusion" where a pass samples SSAO. */
function whiteTexture(gpu: GpuContext, state: ForwardState): GPUTexture {
  if (!state.white || state.white.generation !== gpu.generation) {
    const texture = gpu.device.createTexture({
      label: 'white',
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    gpu.device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1])
    state.white = { texture, generation: gpu.generation }
  }
  return state.white.texture
}

function emptyShadow(gpu: GpuContext, state: ForwardState): GPUTexture {
  if (!state.emptyShadow || state.emptyShadow.generation !== gpu.generation) {
    state.emptyShadow = {
      texture: gpu.device.createTexture({
        label: 'shadows/empty',
        size: [1, 1, 1],
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }),
      generation: gpu.generation,
    }
    state.shadowSampler = undefined
  }
  return state.emptyShadow.texture
}

const textureIds = new WeakMap<GPUTexture, number>()
let nextTextureId = 1
function idOf(t: GPUTexture): number {
  let id = textureIds.get(t)
  if (id === undefined) {
    id = nextTextureId++
    textureIds.set(t, id)
  }
  return id
}

/** The view bind group (group 0): uniforms, lights, clusters, shadows. Rebuilt when inputs change. */
export function viewBindGroup(
  gpu: GpuContext,
  world: World,
  pv: ViewGpu,
  cam: CameraData,
): GPUBindGroup {
  const state = world.resource(State)
  const lights = world.resource(Lights)
  const local = world.resource(ShadowsResource).local
  const settings = world.resource(LightingSettings)
  const empty = emptyShadow(gpu, state)
  state.shadowSampler ??= gpu.device.createSampler({
    label: 'shadows/compare',
    compare: 'greater-equal',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })
  const cascades =
    pv.cascades.count > 0
      ? pv.cascades.ensureTexture(gpu, settings.cascadeMapSize, 'view')
      : pv.cascades.texture && pv.cascades.generation === gpu.generation
        ? pv.cascades.texture
        : empty
  if (local.spots.length > 0 || local.points.length > 0) {
    local.ensureTextures(gpu, settings.shadowMapSize)
  }
  const live = (t: GPUTexture | undefined) => (t && local.generation === gpu.generation ? t : empty)
  const spots = live(local.spotTexture)
  const points = live(local.pointTexture)
  const envs = world.resource(Environments)
  envs.ensure(gpu)
  const env = envs.cameras.get(cam.entity)?.environment
  const baked = env && env.bakes > 0 ? env : undefined
  const specular = baked?.specularView ?? envs.emptyView!
  const source = baked?.sourceView ?? envs.emptyView!
  const sh = baked?.sh ?? envs.emptySh!
  const ao = pv.ao ?? whiteTexture(gpu, state)
  const key = `${idOf(ao)}/${gpu.generation}/${pv.uniform.version}/${lights.buffer.version}/${pv.clusters.clusters.version}/${lights.directional.version}/${pv.shadowData.version}/${idOf(cascades)}/${idOf(spots)}/${idOf(points)}/${baked ? idOf(baked.source) : 0}/${sh.version}/${state.globals.version}`
  if (!pv.bindGroup || pv.bound !== key) {
    pv.bindGroup = gpu.device.createBindGroup({
      label: 'forward/view',
      layout: state.layouts.view,
      entries: [
        { binding: 0, resource: { buffer: pv.uniform.buffer } },
        { binding: 1, resource: { buffer: lights.buffer.buffer } },
        { binding: 2, resource: { buffer: pv.clusters.clusters.buffer } },
        { binding: 3, resource: { buffer: lights.directional.buffer } },
        { binding: 4, resource: { buffer: pv.shadowData.buffer } },
        { binding: 5, resource: cascades.createView({ dimension: '2d-array' }) },
        { binding: 6, resource: spots.createView({ dimension: '2d-array' }) },
        { binding: 7, resource: points.createView({ dimension: '2d-array' }) },
        { binding: 8, resource: state.shadowSampler },
        { binding: 9, resource: specular },
        { binding: 10, resource: envs.lut!.createView() },
        { binding: 11, resource: envs.sampler! },
        { binding: 12, resource: { buffer: sh.buffer } },
        { binding: 13, resource: source },
        { binding: 14, resource: { buffer: state.globals.buffer } },
        { binding: 15, resource: ao.createView() },
      ],
    })
    pv.bound = key
  }
  return pv.bindGroup
}

function forwardNode(state: ForwardState) {
  return {
    kind: 'render' as const,
    phase: RenderPhase.Opaque,
    enabled: (view: RenderView) => isCamera(view) && !cameraOf(view)!.deferred,
    reads: ['clusters', 'shadow-cascades', 'shadow-local', 'environment', 'culled', 'ssao'],
    writes: ['scene-color', 'scene-depth', 'hdr'],
    color: (view: RenderView) => sceneColor(view, cameraOf(view)?.clear),
    depth: { resource: 'scene-depth', clear: 0 },
    run: (ctx: NodeContext) => {
      const cam = cameraOf(ctx.view)!
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      recordSwitches(ctx, drawMaterials(ctx, state, pv, cam, cam.draws, PASS_OPAQUE))
    },
  }
}

/** Blended materials, after opaque geometry and the sky: back to front, depth-tested, no writes. */
function transparentNode(state: ForwardState) {
  return {
    kind: 'render' as const,
    phase: RenderPhase.Transparent,
    enabled: (view: RenderView) => (cameraOf(view)?.transparent.length ?? 0) > 0,
    reads: ['clusters', 'shadow-cascades', 'shadow-local', 'environment', 'culled', 'ssao'],
    writes: ['scene-color', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    run: (ctx: NodeContext) => {
      const cam = cameraOf(ctx.view)!
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      drawMaterials(ctx, state, pv, cam, cam.transparent, PASS_TRANSPARENT)
    },
  }
}

/** Bins each view's visible lights into clusters on the GPU, and reads back overflow stats. */
function clusterNode(state: ForwardState) {
  return {
    kind: 'raw' as const,
    phase: RenderPhase.Setup,
    enabled: isCamera,
    writes: ['clusters'],
    run: (ctx: NodeContext) => {
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      const gpu = ctx.gpu
      const module = ctx.world.resource(Shaders).module(gpu, { root: 'shard::lighting::cluster' })
      if (!module) {
        gpu.pipelines.skipped++
        return
      }
      const pipeline = gpu.pipelines.compute({
        label: 'light-clusters',
        layout: state.layouts.clusterPipeline,
        compute: { module, entryPoint: 'main' },
      })
      if (!pipeline) return
      const c = pv.clusters
      const ao = pv.ao ?? whiteTexture(gpu, state)
      const key = `${idOf(ao)}/${gpu.generation}/${pv.uniform.version}/${c.lightList.version}/${c.aabbs.version}/${c.clusters.version}/${c.stats.version}`
      if (!pv.clusterBindGroup || pv.clusterBound !== key) {
        pv.clusterBindGroup = gpu.device.createBindGroup({
          label: 'light-clusters',
          layout: state.layouts.cluster,
          entries: [
            { binding: 0, resource: { buffer: pv.uniform.buffer } },
            { binding: 1, resource: { buffer: c.lightList.buffer } },
            { binding: 2, resource: { buffer: c.aabbs.buffer } },
            { binding: 3, resource: { buffer: c.clusters.buffer } },
            { binding: 4, resource: { buffer: c.stats.buffer } },
          ],
        })
        pv.clusterBound = key
      }
      const pass = ctx.encoder.beginComputePass({
        label: `${ctx.view.name}/light-clusters`,
        timestampWrites: ctx.timestamps('light-clusters'),
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, pv.clusterBindGroup)
      pass.dispatchWorkgroups(Math.ceil(CLUSTER_COUNT / 64))
      pass.end()
      const map = c.readback(ctx.encoder)
      if (map) ctx.afterSubmit(map)
      const overflows = c.latest.overflows
      const warnKey = overflows > 0 ? `${ctx.view.name}:${overflows}` : ''
      if (warnKey !== state.warned.overflow) {
        state.warned.overflow = warnKey
        if (overflows > 0) {
          ctx.world
            .tryResource(LogResource)
            ?.log(
              'warn',
              `${overflows} light cluster(s) in ${ctx.view.name} hit ${MAX_LIGHTS_PER_CLUSTER} lights; extra lights are dropped`,
              {
                code: 'render/cluster-overflow',
                hint: 'Give point and spot lights smaller ranges so fewer overlap.',
              },
            )
        }
      }
    },
  }
}

/** Renders the camera's cascades: one depth layer per cascade. */
function cascadeNode(state: ForwardState) {
  return {
    kind: 'raw' as const,
    phase: RenderPhase.Shadows,
    enabled: (view: RenderView) =>
      isCamera(view) && (state.views.get(view.name)?.cascades.count ?? 0) > 0,
    reads: ['culled'],
    writes: ['shadow-cascades'],
    run: (ctx: NodeContext) => {
      const pv = state.views.get(ctx.view.name)!
      const shadows = ctx.world.resource(ShadowsResource)
      const size = ctx.world.resource(LightingSettings).cascadeMapSize
      const texture = pv.cascades.ensureTexture(ctx.gpu, size, ctx.view.name)
      for (let i = 0; i < pv.cascades.count; i++) {
        drawShadowCasters(
          ctx,
          texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }),
          pv.cascades.views[i]!,
          pv.cascades.views[i]!.offset,
          shadows.uniforms,
          state.pipelines,
          state.layouts.shadowView,
          `shadows/cascade${i}`,
        )
      }
    },
  }
}

/** Renders spot and point shadow maps, once per frame (the first camera view that runs it). */
function localShadowNode(state: ForwardState) {
  return {
    kind: 'raw' as const,
    phase: RenderPhase.Shadows,
    enabled: isCamera,
    reads: ['culled'],
    writes: ['shadow-local'],
    run: (ctx: NodeContext) => {
      const shadows = ctx.world.resource(ShadowsResource)
      const local = shadows.local
      if (local.renderedFrame === state.frame) return
      local.renderedFrame = state.frame
      if (local.spots.length === 0 && local.points.length === 0) return
      local.ensureTextures(ctx.gpu, ctx.world.resource(LightingSettings).shadowMapSize)
      const layer = (texture: GPUTexture, i: number) =>
        texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 })
      for (let i = 0; i < local.spots.length; i++) {
        const view = local.spotViews[i]!
        drawShadowCasters(
          ctx,
          layer(local.spotTexture!, i),
          view,
          view.offset,
          shadows.uniforms,
          state.pipelines,
          state.layouts.shadowView,
          `shadows/spot${i}`,
        )
      }
      for (let i = 0; i < local.points.length * 6; i++) {
        const view = local.pointViews[i]!
        drawShadowCasters(
          ctx,
          layer(local.pointTexture!, i),
          view,
          view.offset,
          shadows.uniforms,
          state.pipelines,
          state.layouts.shadowView,
          `shadows/point${i}`,
        )
      }
    },
  }
}

/** GPU culling for every camera and shadow view, once per frame, before anything draws. */
function cullNode(state: ForwardState) {
  let frame = -1
  return {
    kind: 'raw' as const,
    phase: RenderPhase.Setup,
    enabled: (view: RenderView) => isCamera(view) && state.cullerActive,
    writes: ['culled'],
    run: (ctx: NodeContext) => {
      if (frame === state.frame) return
      frame = state.frame
      ctx.world.resource(Culler).encode(ctx, ctx.world.resource(Instances))
    },
  }
}

/** Prefilters environments whose source changed (once per frame, before any view draws). */
const environmentNode = {
  kind: 'raw' as const,
  phase: RenderPhase.Setup,
  enabled: isCamera,
  writes: ['environment'],
  run: runEnvironmentWork,
}

/** Draws the environment (skybox or procedural sky) wherever no geometry was drawn. */
function skyNode(state: ForwardState) {
  const data = new Float32Array(20)
  const buffers = new Map<
    string,
    { buffer: GpuBuffer; bindGroup: GPUBindGroup | undefined; bound: string }
  >()
  return {
    kind: 'render' as const,
    phase: RenderPhase.Sky,
    enabled: (view: RenderView) => {
      const cam = cameraOf(view)
      if (!cam) return false
      const entry = view.data.environment as { background: number } | undefined
      return (entry?.background ?? -1) >= 0
    },
    reads: ['environment'],
    writes: ['scene-color', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    run: (ctx: NodeContext) => {
      const cam = cameraOf(ctx.view)!
      const pv = state.views.get(ctx.view.name)
      const envs = ctx.world.resource(Environments)
      const entry = envs.cameras.get(cam.entity)
      const env = entry?.environment
      if (!pv || !entry || !env || env.bakes === 0) return
      const gpu = ctx.gpu
      const module = ctx.world.resource(Shaders).module(gpu, { root: 'shard::sky::background' })
      if (!module) {
        gpu.pipelines.skipped++
        return
      }
      const bgLayout = gpu.layouts.bindGroupLayout({
        label: 'sky/background',
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
          },
        ],
      })
      const pipeline = gpu.pipelines.render({
        label: `sky/x${cam.msaa}`,
        layout: gpu.layouts.pipelineLayout({
          label: 'sky',
          bindGroupLayouts: [state.layouts.view, bgLayout],
        }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
        multisample: { count: cam.msaa },
      })
      if (!pipeline) return
      let b = buffers.get(ctx.view.name)
      if (!b) {
        b = {
          buffer: new GpuBuffer(gpu, {
            label: `${ctx.view.name}/sky`,
            usage: GPUBufferUsage.UNIFORM,
            size: data.byteLength,
          }),
          bindGroup: undefined,
          bound: '',
        }
        buffers.set(ctx.view.name, b)
      }
      const sky = env.kind === 'sky' ? env.sky : undefined
      data[0] = entry.background
      data[1] = sky && sky.sunDiskSize > 0 ? 1 : 0
      data[2] = ((0.2667 * Math.PI) / 180) * (sky?.sunDiskSize ?? 1)
      data[3] = sky ? sunDiskLuminance(env) : 0
      data.set(env.sun, 4)
      data[8] = sky?.turbidity ?? 2
      data[9] = sky?.rayleigh ?? 1
      data[10] = sky?.mie ?? 1
      data[11] = sky?.sunDiskSize ?? 1
      b.buffer.write(data)
      const key = `${gpu.generation}/${b.buffer.version}`
      if (!b.bindGroup || b.bound !== key) {
        b.bindGroup = gpu.device.createBindGroup({
          label: 'sky/background',
          layout: bgLayout,
          entries: [{ binding: 0, resource: { buffer: b.buffer.buffer } }],
        })
        b.bound = key
      }
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewBindGroup(gpu, ctx.world, pv, cam))
      pass.setBindGroup(1, b.bindGroup)
      pass.draw(3)
    },
  }
}

const MSAA_LOAD = [{ resource: 'scene-color', resolve: 'hdr' }]
const PLAIN_LOAD = [{ resource: 'scene-color' }]

/**
 * The scene color attachment for a pass that draws into the 3D scene. With MSAA it resolves into
 * `hdr` at the end of every such pass; the graph stores the multisampled buffer only when a later
 * pass loads it, so the last scene pass resolves for free.
 */
export function sceneColor(view: RenderView, clear?: GPUColor): readonly ColorAttachment[] {
  const msaa = msaaOf(view) > 1
  if (clear === undefined) return msaa ? MSAA_LOAD : PLAIN_LOAD
  return [{ resource: 'scene-color', clear, resolve: msaa ? 'hdr' : undefined }]
}

/** Single-sample depth from MSAA depth (sample 0), for passes that read depth. */
function depthResolveNode() {
  let bindGroups = new WeakMap<GPUTexture, GPUBindGroup>()
  let generation = -1
  return {
    kind: 'render' as const,
    phase: RenderPhase.Resolve,
    enabled: (view: RenderView) => msaaOf(view) > 1,
    reads: ['scene-depth'],
    writes: ['depth'],
    depth: { resource: 'depth', clear: 0 },
    run: (ctx: NodeContext) => {
      const gpu = ctx.gpu
      if (generation !== gpu.generation) {
        bindGroups = new WeakMap()
        generation = gpu.generation
      }
      const module = ctx.world.resource(Shaders).module(gpu, { root: 'shard::post::depth_resolve' })
      const vs = ctx.world.resource(Shaders).module(gpu, { root: 'shard::fullscreen' })
      if (!module || !vs) return
      const layout = gpu.layouts.bindGroupLayout({
        label: 'depth-resolve',
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'depth', multisampled: true },
          },
        ],
      })
      const pipeline = gpu.pipelines.render({
        label: 'depth-resolve',
        layout: gpu.layouts.pipelineLayout({ label: 'depth-resolve', bindGroupLayouts: [layout] }),
        vertex: { module: vs, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      })
      if (!pipeline) return
      const source = ctx.texture('scene-depth')
      let bg = bindGroups.get(source)
      if (!bg) {
        bg = gpu.device.createBindGroup({
          label: 'depth-resolve',
          layout,
          entries: [{ binding: 0, resource: source.createView() }],
        })
        bindGroups.set(source, bg)
      }
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bg)
      pass.draw(3)
    },
  }
}

export interface ForwardPluginOptions {
  /** MSAA sample count: 1 or 4. Default 4. */
  msaa?: 1 | 4
}

/** Bind group and pipeline layouts, created per device (after a device loss they're rebuilt). */
function createLayouts(gpu: GpuContext, assets: GpuAssets, store: InstanceStore): Layouts {
  const F = GPUShaderStage.FRAGMENT
  const storage = (binding: number) => ({
    binding,
    visibility: F,
    buffer: { type: 'read-only-storage' as const },
  })
  const depthArray = (binding: number) => ({
    binding,
    visibility: F,
    texture: { sampleType: 'depth' as const, viewDimension: '2d-array' as const },
  })
  const view = gpu.layouts.bindGroupLayout({
    label: 'forward/view',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | F, buffer: { type: 'uniform' } },
      storage(1),
      storage(2),
      storage(3),
      storage(4),
      depthArray(5),
      depthArray(6),
      depthArray(7),
      { binding: 8, visibility: F, sampler: { type: 'comparison' } },
      { binding: 9, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 10, visibility: F, texture: { sampleType: 'float' } },
      { binding: 11, visibility: F, sampler: { type: 'filtering' } },
      storage(12),
      { binding: 13, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 14, visibility: GPUShaderStage.VERTEX | F, buffer: { type: 'uniform' } },
      { binding: 15, visibility: F, texture: { sampleType: 'float' } },
    ],
  })
  const C = GPUShaderStage.COMPUTE
  const cluster = gpu.layouts.bindGroupLayout({
    label: 'light-clusters',
    entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: C, buffer: { type: 'storage' } },
      { binding: 4, visibility: C, buffer: { type: 'storage' } },
    ],
  })
  const shadowView = shadowViewLayout(gpu)
  return {
    view,
    pipeline: gpu.layouts.pipelineLayout({
      label: 'forward',
      bindGroupLayouts: [view, assets.materialLayout, store.layout],
    }),
    cluster,
    clusterPipeline: gpu.layouts.pipelineLayout({
      label: 'light-clusters',
      bindGroupLayouts: [cluster],
    }),
    shadowView,
    shadowPipeline: gpu.layouts.pipelineLayout({
      label: 'shadows',
      bindGroupLayouts: [shadowView, assets.materialLayout, store.layout],
    }),
  }
}

function ensureLayouts(
  gpu: GpuContext,
  state: ForwardState,
  assets: GpuAssets,
  store: InstanceStore,
): void {
  if (state.layoutGeneration === gpu.generation) return
  state.layoutGeneration = gpu.generation
  state.layouts = createLayouts(gpu, assets, store)
  for (const pv of state.views.values()) {
    pv.bindGroup = undefined
    pv.clusterBindGroup = undefined
  }
}

/**
 * Cameras, meshes, the standard material, lights, shadows, and ambient light, drawn into HDR with
 * instancing, frustum culling, and clustered light culling, then tonemapped. Needs the render and
 * transform plugins.
 */
export function forwardPlugin(options: ForwardPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'render/forward',
    dependencies: ['render', 'core/transform'],
    build(app) {
      const w = app.world
      w.initResource(Meshes)
      w.initResource(Skins)
      w.initResource(Materials)
      w.initResource(Textures)
      w.initResource(RenderTargets)
      w.initResource(AmbientLight)
      w.initResource(RenderStats)
      w.initResource(Cameras)
      w.initResource(LightingSettings)
      w.initResource(DefaultEnvironment)
      w.initResource(Environments)
      w.initResource(ViewSettings).msaa = options.msaa ?? 4
      w.initResource(Gizmos)
      w.initResource(DebugOverlays)
      w.initResource(Picking)
      observeInstanceRemovals(w)
      observeLightRemovals(w)
      observeOriginShifts(w)
      app
        .addSystems(
          PostUpdate,
          computeVisibility.after(TransformSystems),
          applyPhysicalCameras,
          adaptExposure.after(applyPhysicalCameras),
        )
        .addSystems(
          Last,
          extractCameras.inSet(RenderSet.Extract),
          extractLights.inSet(RenderSet.Extract),
          prepareInstances.inSet(RenderSet.Prepare),
          prepareDeforms.inSet(RenderSet.Prepare).after(prepareInstances),
          prepareLights.inSet(RenderSet.Prepare),
          prepareEnvironments.inSet(RenderSet.Prepare),
          queue.inSet(RenderSet.Queue),
          upload.inSet(RenderSet.Upload),
          drawOverlays.inSet(RenderSet.Upload).after(upload),
          uploadGizmos.inSet(RenderSet.Upload).after(drawOverlays),
        )
        .addSystems(First, beginGizmos)
    },
    ready(app) {
      const gpu = app.world.resource(Gpu)
      // Basis textures transcode to what this device can sample.
      setTextureCapabilities({
        bc: gpu.features.has('texture-compression-bc'),
        astc: gpu.features.has('texture-compression-astc'),
        etc2: gpu.features.has('texture-compression-etc2'),
      })
      const assets = new GpuAssets(gpu, app.world.initResource(GpuMemory))
      const store = new InstanceStore(gpu)
      app.insertResource(GpuAssetsResource, assets)
      app.insertResource(Instances, store)
      app.insertResource(Culler, new GpuCuller(gpu))
      app.insertResource(
        Lights,
        new LightStore(gpu, app.world.resource(LightingSettings).maxLights),
      )
      app.insertResource(ShadowsResource, {
        local: new LocalShadows(),
        uniforms: new ShadowPassUniforms(gpu),
      })
      const state: ForwardState = {
        views: new Map(),
        viewBytes: new DataView(new ArrayBuffer(viewLayout.size)),
        shadowFloats: new Float32Array(SHADOW_DATA_FLOATS),
        layouts: createLayouts(gpu, assets, store),
        layoutGeneration: gpu.generation,
        emptyShadow: undefined,
        white: undefined,
        shadowSampler: undefined,
        frame: 0,
        warned: { budget: '', overflow: '' },
        globals: new GpuBuffer(gpu, { label: 'globals', usage: GPUBufferUsage.UNIFORM, size: 16 }),
        globalsData: new Float32Array(4),
        pipelines: new MaterialPipelines(),
        cullerActive: false,
        gbufferTargets: [
          { format: 'rgba8unorm-srgb' },
          { format: 'rgba16float' },
          { format: gbufferEmissiveFormat(gpu) },
        ],
      }
      // Batches draw grouped by material type and variant, so pipeline switches stay rare.
      store.batchKey = (b) => typeOrdinal(b.material.type) * 16 + materialVariant(b.material)
      app.insertResource(State, state)
      const graph = app.world.resource(Graph)
      graph.declare({ name: 'scene-color', format: 'rgba16float', sampleCount: msaaOf })
      graph.declare({ name: 'scene-depth', format: 'depth32float', sampleCount: msaaOf })
      graph.declare({ name: 'hdr', format: 'rgba16float' })
      graph.declare({ name: 'depth', format: 'depth32float' })
      graph.declare({ name: 'ldr', format: 'view' })
      const describers = app.world.initResource(RenderDescribers)
      describers.set('lighting', (world) => describeLighting(world))
      describers.set('environment', (world) => describeEnvironment(world))
      describers.set('culling', (world) => describeCulling(world))
      describers.set('post', (world) => describePost(world))
      graph.addNode('environment', environmentNode)
      graph.addNode('instance-cull', cullNode(state))
      graph.addNode('light-clusters', clusterNode(state))
      graph.addNode('shadows/cascades', cascadeNode(state))
      graph.addNode('shadows/local', localShadowNode(state))
      graph.addNode('forward-opaque', forwardNode(state))
      graph.addNode('sky', skyNode(state))
      graph.addNode('forward-transparent', transparentNode(state))
      addDeferredNodes(app)
      graph.addNode('depth-resolve', depthResolveNode())
      addPostNodes(app.world)
      graph.addNode('pixel-upscale', pixelUpscaleNode())
      graph.addNode('gizmos', gizmoNode(app.world))
      addPickNodes(app.world)
    },
  })
}

/** rg11b10ufloat when the device can render to it, else rgba16float. */
export function gbufferEmissiveFormat(gpu: GpuContext): GPUTextureFormat {
  return gpu.features.has('rg11b10ufloat-renderable') ? 'rg11b10ufloat' : 'rgba16float'
}
