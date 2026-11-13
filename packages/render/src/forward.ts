import { assetServer } from '@aethervtt/shard-assets'
import {
  defineResource,
  defineSystem,
  Last,
  PostUpdate,
  PreUpdate,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { definePlugin, LogResource, type Plugin, Time } from '@aethervtt/shard-runtime'
import { setTextureCapabilities, Textures } from '@aethervtt/shard-texture'
import { TransformSystems } from '@aethervtt/shard-transform'
import {
  type MaterialAsset,
  MaterialAssetType,
  MaterialImporter,
  Materials,
  MeshAsset,
  Meshes,
  RenderTargets,
  STANDARD_TYPE,
  StandardMaterial,
} from './assets'
import { Atmospheres } from './atmosphere-state'
import type { BaselineViewLights } from './baseline/lights'
import { applyPhysicalCameras, Camera3d, DrivesView, Exposure, PhysicalCamera } from './camera'
import {
  CLUSTER_COUNT,
  CLUSTER_Z,
  ClusterBuffers,
  clusterRange,
  MAX_LIGHTS_PER_CLUSTER,
  ViewLightList,
} from './clusters'
import { Culler, cullGround, cullTransparent, GpuCuller } from './culling'
import { Cutaway, CutawayPath, type CutawaySupport, CutawayView } from './cutaway'
import { DataStore, dataEntry } from './data-store'
import { addDisplayNodes } from './display-nodes'
import { Environments, environmentParams } from './environment-state'
import { addRenderFeatures, warnFeatureMissing } from './features'
import { FoliagePath, type FoliageSupport } from './foliage-path'
import { ShaderGlobals, ShaderGlobalsData } from './globals'
import { GpuAssets, GpuAssetsResource } from './gpu-assets'
import { type ColorAttachment, type NodeContext, RenderPhase, type RenderView } from './graph'
import { clearHealthIssue, MaterialFallbacks, raiseHealthIssue } from './health'
import {
  CasterClass,
  type CullParams,
  DeformPath,
  type DrawList,
  DynamicCaster,
  InstanceData,
  InstanceFlags,
  InstanceSlot,
  InstanceStore,
  Instances,
  LOD_UNSET,
  Lod,
  Mesh3d,
  MeshMaterial,
  MorphWeights,
  NotShadowCaster,
  NotShadowReceiver,
  observeInstanceRemovals,
  prepareInstances,
  ShadowWhenHidden,
  SkinnedMesh,
  VisibilityRange,
} from './instances'
import { INTERIOR_BINDINGS, InteriorPath } from './interior'
import { observeOriginShifts } from './large-world'
import { GroundLayer, RenderLayers } from './layers'
import { expireLensFields, Lens, LensFields, LensPath } from './lens'
import {
  AmbientLight,
  DirectionalLight,
  extractLights,
  LightingSettings,
  type LightRecord,
  LightStore,
  Lights,
  observeLightRemovals,
  PointLight,
  SpotLight,
} from './lights'
import { MaterialNoise } from './material-noise'
import {
  blendState,
  MaterialPipelines,
  materialVariant,
  typeOrdinal,
  variantBlend,
  variantCull,
} from './material-pipelines'
import { isTransparent, type MaterialType } from './materials'
import { Occluder, OcclusionCulling, OcclusionPath } from './occlusion'
import { Outline, OutlinePath, observeOutlinesWithoutPass } from './outline'
import { PixelPerfect, PixelPerfectPath, PixelTargets } from './pixel-perfect'
import { Gpu, Graph, RenderDescribers, RenderSet, Shaders, Views } from './plugin'
import {
  Antialiasing,
  AutoExposure,
  Bloom,
  ColorGrading,
  DepthOfField,
  Fog,
  MotionBlur,
  PostFeatures,
  Ssao,
  Vignette,
} from './post'
import { RenderScale, type RenderScaleValue } from './render-scale'
import {
  describeScreenEffects,
  expireScreenEffects,
  runScreenEffects,
  ScreenEffectHandlers,
  ScreenEffects,
} from './screen-effects'
import { ViewUniform, viewLayout } from './shaders'
import { sliceFrustum } from './shadow-volume'
import {
  assignLocalShadows,
  Cascades,
  drawShadowCasters,
  fitCascades,
  fitLocalShadows,
  LocalShadows,
  markShadowDrawn,
  packShadowData,
  pointTanHalf,
  SHADOW_DATA_FLOATS,
  ShadowPassUniforms,
  ShadowsResource,
  type ShadowViewDraw,
  shadowRedraw,
  shadowViewLayout,
} from './shadows'
import { SkinAssetType, Skins } from './skin-asset'
import { GpuMemory, RenderCounters, RenderStats } from './stats'
import { bindingDimension } from './tier'
import { Ink, observeToonWithoutPlugin, Toon, ToonPath } from './toon'
import { addShaderVariantSource, materialVariants, ShaderVariantSources } from './variants'
import {
  Beam,
  Decal,
  DecalReceiver,
  DecalsPath,
  observeVfxWithoutPlugin,
  RibbonsPath,
  Trail,
} from './vfx'
import {
  type CameraData,
  CameraMoved,
  Cameras,
  cameraOf,
  DeferredPath,
  drivingView,
  extractCameras,
  RenderPath,
  Tonemapping,
  ViewSettings,
} from './view'
import {
  HiddenSetsResource,
  NO_HIDDEN,
  observeViewVisibilityWithoutPlugin,
  ViewVisibility,
} from './view-visibility'
import { ComputedVisibility, computeVisibility, Visibility } from './visibility'

export { Mesh3d, MeshMaterial }

/** Per camera view: uniforms, clusters, lights, and shadows, and the bind groups over them. */
export interface ViewGpu {
  uniform: GpuBuffer
  /** Swaying foliage casts into this camera's nearest cascade this frame (0045, 0116). */
  foliageAnimated: boolean
  /** This frame's SSAO texture, when the camera has Ssao. */
  ao: GPUTexture | undefined
  lightList: ViewLightList
  /** GPU clustering's buffers (full tier). */
  clusters: ClusterBuffers | undefined
  /** Packed lights and cluster bits, binned on the CPU (baseline, 0064). */
  baseline: BaselineViewLights | undefined
  /** Shadow cascades, spot and point matrices: `@data(uniform)`. */
  shadowData: DataStore
  cascades: Cascades
  bindGroup: GPUBindGroup | undefined
  bound: string
  clusterBindGroup: GPUBindGroup | undefined
  clusterBound: string
}

interface Layouts {
  /** Group 0 as this frame binds it: `viewBase`, or with the interior bindings (0069) while on. */
  view: GPUBindGroupLayout
  viewBase: GPUBindGroupLayout
  /** Made on first use: few apps turn interior lighting on. */
  viewInterior: GPUBindGroupLayout | undefined
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
  /** The driving camera's view frustum, which local lights' shadow volumes must reach (0116). */
  localPlanes: Float32Array
  /** Clears a rectangle of a cached shadow layer (0116), and the GPU generation it's for. */
  clearRect: { pipeline: GPURenderPipeline | undefined; generation: number }
  /** Last warnings, so each is logged once per change. */
  warned: { budget: string; overflow: string }
  /** Time, delta time, frame and plugin slots for shaders (`shard::globals`, ShaderGlobals). */
  globals: GpuBuffer
  pipelines: MaterialPipelines
  /** The baseline tier's strategies (0064), loaded only on a baseline device. */
  baseline: typeof import('./baseline/lights') | undefined
  /** G-buffer color targets (the emissive format depends on the device). */
  gbufferTargets: GPUColorTargetState[]
  /** Whether GPU culling ran this frame (the cull node reads it). */
  cullerActive: boolean
  /** Interior lighting's mode this frame (0069): INTERIOR_SKY | INTERIOR_BLOCKED, or 0. */
  interiorMode: number
}

export const ForwardStateResource = defineResource<ForwardState>('render/ForwardState')
const State = ForwardStateResource

// --- prepare -------------------------------------------------------------------

/** Ranks shadowed spot and point lights for the driving camera and uploads changed lights. */
const prepareLights = defineSystem({
  name: 'render/prepare-lights',
  description: 'Assigns shadow maps within the budgets and uploads changed lights.',
  setup: (world) => ({ cameras: world.query({ with: [Camera3d] }) }),
  run: ({ cameras }, world) => {
    const lights = world.resource(Lights)
    const shadows = world.resource(ShadowsResource)
    const settings = world.resource(LightingSettings)
    // Lights reach every layer, so any camera may rank them.
    const main = drivingView(world, cameras, 0xffff)
    assignLocalShadows(
      shadows.local,
      lights,
      main && cameraOf(main),
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
  layers: 0xffffffff,
}
const shadowCull: CullParams = {
  planes: null,
  require: InstanceFlags.Caster,
  eye: undefined,
  lodScale: 1,
  orthographic: false,
  lodState: undefined,
  updateLod: false,
  layers: 0xffffffff,
}

/** Occluders and occlusion cameras without occlusionPlugin cull nothing: says so once (0116). */
const warnOcclusionMissing = defineSystem({
  name: 'render/occlusion-missing',
  description: 'Warns once when OcclusionCulling or Occluder is used without occlusionPlugin.',
  setup: (world) => ({
    cameras: world.query({ with: [OcclusionCulling] }),
    occluders: world.query({ with: [Occluder] }),
  }),
  run: ({ cameras, occluders }, world) => {
    if (world.hasResource(OcclusionPath)) return
    const any = (q: typeof cameras) => q.tables.some((t) => t.count > 0)
    if (any(cameras) || any(occluders))
      warnFeatureMissing(
        world,
        'An entity has OcclusionCulling or Occluder',
        'occlusionPlugin',
        'nothing is occlusion culled',
      )
  },
})

/** A local light's shadow volumes: swept away from it, to its range (0116). */
function setLocalSweep(view: ShadowViewDraw, r: LightRecord, margin: number): void {
  view.sweepMode = 2
  view.sweep[0] = r.x
  view.sweep[1] = r.y
  view.sweep[2] = r.z
  view.sweep[3] = r.range
  view.margin = margin
  view.minRadius = 0
}

/** Culling parameters of a camera: its (possibly frozen) frustum, eye, and LOD scale. */
function cameraParams(cam: CameraData, out: CullParams): CullParams {
  out.planes = cam.frozenFrustum ?? cam.frustum
  out.eye = cam.frozenPosition ?? cam.position
  out.orthographic = cam.orthographic
  out.layers = cam.layers
  out.hidden = cam.hidden?.bits
  out.hiddenBase = cam.hidden ? cam.hidden.base : NO_HIDDEN
  // Screen size = diameter / viewport height: 2r / (2 d tan(fov/2)), or 2r / orthoHeight.
  out.lodScale = cam.orthographic ? 2 / cam.orthoHeight : 1 / Math.tan(cam.fovY / 2)
  if (cam.lodState.length < cam.lodCapacity)
    cam.lodState = new Uint8Array(cam.lodCapacity).fill(LOD_UNSET)
  out.lodState = cam.lodState
  return out
}

export const forwardQueue = defineSystem({
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
    const foliage = world.tryResource(FoliagePath)
    stats.clear()
    state.frame++
    ensureLayouts(gpu, state, world.resource(GpuAssetsResource), store)
    chooseInterior(gpu, world, state)
    state.pipelines.beginFrame(state.frame, world.resource(Shaders).revision)
    shadows.uniforms.reset()
    culler.beginFrame()
    const gpuCull = culler.active
    state.cullerActive = gpuCull
    const time = world.resource(Time)
    const g = world.resource(ShaderGlobals)
    g.values[0] = time.elapsed
    g.values[1] = time.delta
    g.bits[2] = time.frame
    state.globals.write(g.values, 0, 0, g.length)

    // Camera views first: they choose LOD levels, which their shadow views reuse.
    let main: CameraData | undefined
    let mainOrder = Number.POSITIVE_INFINITY
    const occlusion = world.tryResource(OcclusionPath)
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      cam.lodCapacity = store.capacity
      const params = cameraParams(cam, cameraCull)
      // What its occluders hide this frame (0116).
      params.occlusion = occlusion?.bufferOf(cam.entity)
      const forwardOnly = cam.deferred ? cam.forwardOnly : undefined
      if (gpuCull) {
        culler.add(store, cam.draws, params, culler.lodCamera(cam.entity), forwardOnly)
        cullTransparent(store, cam.transparent, params, cam.forward)
        cullGround(store, cam.ground, params, cam.overlay)
      } else {
        store.cullCpu(
          cam.draws,
          params,
          undefined,
          cam.transparent,
          cam.forward,
          forwardOnly,
          false,
          cam.ground,
          cam.overlay,
        )
      }
      // Nearest first within each pipeline and material: the depth test culls overdraw.
      store.orderNearFirst(cam.draws, cam.position)
      if (view.order < mainOrder) {
        main = cam
        mainOrder = view.order
      }
    }

    // Shadow views: culled with their own frustums, measured from (and at the LOD of) the camera.
    // A camera's own cascades leave its hidden slots out with ViewVisibility.shadows 'hide';
    // spot and point maps are shared by every camera and keep them (0070).
    const shadowParams = (cam: CameraData, planes: Float32Array, own: boolean) => {
      cameraParams(cam, shadowCull)
      shadowCull.planes = planes
      shadowCull.updateLod = false
      if (!own || !cam.hidden?.shadows) {
        shadowCull.hidden = undefined
        shadowCull.hiddenBase = NO_HIDDEN
      }
      return shadowCull
    }
    const cullShadow = (
      cam: CameraData,
      view: ShadowViewDraw,
      planes: Float32Array,
      box?: Float32Array,
      own = false,
    ) => {
      const params = shadowParams(cam, planes, own)
      // A camera's dynamic casters whose shadows fall where its occluders hide them (0116).
      const buffer = own && view.sweepMode === 1 ? occlusion?.bufferOf(cam.entity) : undefined
      params.receiver = buffer?.shadows ? buffer : undefined
      if (params.receiver) params.receiverFloor = store.casterFloor()
      params.classes = view.classes
      params.sweepMode = view.sweepMode
      params.sweep = view.sweep
      params.margin = view.margin
      params.minRadius = view.minRadius
      if (gpuCull) {
        culler.add(store, view.draws, params, culler.lodCamera(cam.entity))
        // No CPU cull to take a union from: fit to every caster instead.
        if (box) store.casterBounds(box)
        return true
      }
      store.cullCpu(view.draws, params, box)
      return view.draws.visible > 0
    }
    // A local light's views (0116): its static view when cached, redrawn where static casters
    // changed, and a dynamic one over it. Returns whether the dynamic one has casters.
    const queueLocalView = (
      view: ShadowViewDraw,
      dyn: ShadowViewDraw,
      r: LightRecord,
      tanHalf: number,
    ): boolean => {
      view.offset = shadows.uniforms.push(view.viewProj)
      dyn.offset = view.offset
      dyn.viewProj.set(view.viewProj)
      const texel = (2 * r.range * tanHalf) / settings.shadowMapSize
      const margin = texel * (2 + r.shadowSoftness + r.shadowNormalBias)
      dyn.redraw = false
      if (!r.cachedShadow) {
        view.classes = CasterClass.all
        setLocalSweep(view, r, margin)
        cullShadow(main!, view, state.localPlanes)
        view.redraw = true
        return false
      }
      view.classes = CasterClass.static
      view.sweepMode = 0
      view.margin = 0
      view.redraw = shadowRedraw(view, true, store)
      if (view.redraw) cullShadow(main!, view, view.frustum)
      if (store.dynamicCasters === 0) return false
      dyn.classes = CasterClass.dynamic
      setLocalSweep(dyn, r, margin)
      if (!store.anyDynamicIn(state.localPlanes, 2, dyn.sweep, margin, 0)) return false
      dyn.redraw = true
      return cullShadow(main!, dyn, state.localPlanes)
    }
    const local = shadows.local
    fitLocalShadows(local, settings.shadowMapSize)
    store.staticAfterFrames = settings.staticAfterFrames
    // Cached shadow maps (0055) redraw only where something they show changed (0116).
    store.checkMeshVersions()
    local.spotDynamicOn = 0
    local.pointDynamicOn = 0
    if (main) {
      // Shadows whose volume misses the driving camera's view can't be seen (0116).
      sliceFrustum(state.localPlanes, 0, main, main.near, main.far > 0 ? main.far : 1e7)
      for (let i = 0; i < local.spots.length; i++) {
        const r = local.spots[i]!
        const tanHalf = local.spotParams[i * 4]!
        if (queueLocalView(local.spotViews[i]!, local.spotDynamic[i]!, r, tanHalf))
          local.spotDynamicOn |= 1 << i
      }
      const pointTan = pointTanHalf(settings.shadowMapSize)
      for (let i = 0; i < local.points.length * 6; i++) {
        const r = local.points[(i / 6) | 0]!
        if (queueLocalView(local.pointViews[i]!, local.pointDynamic[i]!, r, pointTan))
          local.pointDynamicOn |= 1 << ((i / 6) | 0)
      }
    }

    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      const pv = viewGpu(gpu, state, view.name)
      pv.ao = undefined // the SSAO node sets it when it runs
      pv.lightList.build(cam, lights.records, lights.high)
      if (pv.clusters) pv.clusters.upload(pv.lightList, cam, settings.clusterFar)
      else {
        const b = pv.baseline!
        state.baseline!.binBaselineLights(
          b,
          pv.lightList,
          lights.data,
          cam,
          settings.clusterFar,
          settings.baselineMaxLights,
        )
        if (b.dropped !== b.reported)
          reportLightBudget(world, view.name, b, settings.baselineMaxLights)
      }
      const sun = lights.shadowSun
      if (sun) {
        // Swaying foliage (0045) draws into the nearest cascade's dynamic layer each frame.
        pv.foliageAnimated = foliage?.animatedShadows(cam) ?? false
        fitCascades(
          pv.cascades,
          cam,
          sun,
          settings.cascadeMapSize,
          store,
          state.frame,
          pv.foliageAnimated,
          (v, planes, box) => cullShadow(cam, v, planes, box, true),
        )
        for (let i = 0; i < pv.cascades.count; i++) {
          const v = pv.cascades.views[i]!
          v.offset = shadows.uniforms.push(v.viewProj)
          pv.cascades.dynamic[i]!.offset = v.offset
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
      st.visible += cam.transparent.visible + cam.ground.visible
      st.drawCalls += cam.transparent.length + cam.ground.length
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
      clusters: state.baseline ? undefined : new ClusterBuffers(gpu, name),
      baseline: state.baseline?.baselineViewLights(gpu, name),
      shadowData: new DataStore(gpu, {
        label: `${name}/shadows`,
        kind: 'uniform',
        size: SHADOW_DATA_FLOATS * 4,
      }),
      cascades: new Cascades(),
      foliageAnimated: false,
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
const noTransmittance = new Float32Array(16).fill(1)

const pixelScaleScratch = new Float32Array(4)
const toonScratch = new Float32Array(4)

/**
 * `ViewUniform.pixelScale` for a camera: see the field. On a PixelPerfect camera a pixel of a scene
 * measure (a line's width) is a texel, the art's pixel, whatever the scale up.
 */
export function viewPixelScale(cam: CameraData, out: Float32Array): Float32Array {
  out[0] = cam.pixelPerfect ? 1 : (cam.pixelRatio * cam.width) / Math.max(1, cam.displayWidth)
  out[1] = cam.orthographic
    ? cam.orthoHeight / Math.max(1, cam.height)
    : (2 * Math.tan(cam.fovY / 2)) / Math.max(1, cam.height)
  out[2] = cam.orthographic ? 1 : 0
  out[3] = 0
  return out
}

/** `ViewUniform.toon` for a camera (0108): tones (0 without Toon) and edge softness. */
function toonParams(cam: CameraData, out: Float32Array): Float32Array {
  out[0] = cam.toon.tones
  out[1] = cam.toon.softness
  return out
}

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
    sunTransmittance: (world.tryResource(Atmospheres)?.cameras.get(cam.entity)?.sunTransmittance ??
      noTransmittance) as never,
    pixelScale: viewPixelScale(cam, pixelScaleScratch) as never,
    toon: toonParams(cam, toonScratch) as never,
    toonRamp: cam.toon.rampLow as never,
    toonRampHigh: cam.toon.rampHigh as never,
  })
  pv.uniform.write(new Float32Array(state.viewBytes.buffer, 0, viewLayout.size / 4))
}

export const upload = defineSystem({
  name: 'render/upload-visible',
  description: "Uploads every view's visible instance lists and shadow view matrices.",
  run: (_, world) => {
    const store = world.resource(Instances)
    const culler = world.resource(Culler)
    if (culler.active) {
      // Hidden sets (0070) upload for the GPU cull; CPU culls read their bits.
      culler.prepare(
        store,
        world.tryResource(HiddenSetsResource),
        world.resource(GpuAssetsResource),
      )
      store.gpuVisible = culler.visible
    }
    store.finishFrame()
    const state = world.resource(State)
    world.resource(ShadowsResource).uniforms.upload(state.layouts.shadowView, state.globals)
  },
})

// --- graph nodes ---------------------------------------------------------------

export const VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x2' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] },
]

/**
 * Material module defines, indexed 1 premultiply | 2 mask | 4 opaque. Opaque and masked materials
 * write alpha 1 in the forward pass, so views clearing to alpha 0 see them (0052).
 */
const FORWARD_DEFINES = [
  { PREMULTIPLY: false, MASK: false, OPAQUE: false },
  { PREMULTIPLY: true, MASK: false, OPAQUE: false },
  { PREMULTIPLY: false, MASK: true, OPAQUE: false },
  { PREMULTIPLY: true, MASK: true, OPAQUE: false },
  { PREMULTIPLY: false, MASK: false, OPAQUE: true },
  { PREMULTIPLY: true, MASK: false, OPAQUE: true },
  { PREMULTIPLY: false, MASK: true, OPAQUE: true },
  { PREMULTIPLY: true, MASK: true, OPAQUE: true },
] as const

/** Added to a pipeline key for its cutaway variant (0070). */
const CUT_KEY = 2 ** 40
/** Times the interior mode (0069), added to pipeline keys: each mode keeps its own pipelines. */
const INTERIOR_KEY = 2 ** 41
/** Added to a pipeline key for a toon view's lit variant (0108). */
const TOON_KEY = 2 ** 43

/** FORWARD_DEFINES with the cutaway test linked in (0070). */
const CUTAWAY_DEFINES = FORWARD_DEFINES.map((d) => ({ ...d, CUTAWAY: true }))
/** Toon shading's (0108), with and without the cutaway test. */
const TOON_DEFINES = FORWARD_DEFINES.map((d) => ({ ...d, TOON: true }))
const CUTAWAY_TOON_DEFINES = CUTAWAY_DEFINES.map((d) => ({ ...d, TOON: true }))

/** Interior lighting's defines (0069) by mode: sky visibility (1), wall-blocked lights (2). */
export const INTERIOR_DEFINES = [
  undefined,
  { SKY_VISIBILITY: true },
  { BLOCKED_LIGHTS: true },
  { SKY_VISIBILITY: true, BLOCKED_LIGHTS: true },
] as const

/**
 * Lit slots' defines by interior mode, then cutaway (1) plus toon (2); mode 0 is the plain sets.
 */
const LIT_DEFINES = INTERIOR_DEFINES.map((extra) =>
  [FORWARD_DEFINES, CUTAWAY_DEFINES, TOON_DEFINES, CUTAWAY_TOON_DEFINES].map((set) =>
    extra ? set.map((d) => ({ ...d, ...extra })) : set,
  ),
)

/** Deferred lighting's defines (0021) by interior mode, then toon (0108). */
export const DEFERRED_LIGHTING_DEFINES = INTERIOR_DEFINES.map((extra) => [
  extra,
  { ...extra, TOON: true },
])

/**
 * The pipeline layout of a pass drawing a material type: view, material, instances, and for the
 * cutaway variant (0070) the camera's reveal points.
 */
function materialLayout(
  gpu: GpuContext,
  state: ForwardState,
  assets: GpuAssets,
  type: MaterialType,
  store: InstanceStore,
  cut: GPUBindGroupLayout | undefined,
) {
  return gpu.layouts.pipelineLayout({
    label: cut ? `forward/${type.name}/cutaway` : `forward/${type.name}`,
    bindGroupLayouts: cut
      ? [state.layouts.view, assets.layoutOf(type), store.layout, cut]
      : [state.layouts.view, assets.layoutOf(type), store.layout],
  })
}

export const PASS_OPAQUE = 0
export const PASS_TRANSPARENT = 1
export const PASS_GBUFFER = 3
/** Depth, normals, and velocity for post-processing (TAA, motion blur, forward SSAO). */
export const PASS_PREPASS = 5
/** Entity ids, normals, and depth for GPU picking (picking.ts). */
export const PASS_PICK = 7
/** Ground bands (0057): forward shading, depth tested but not written. */
export const PASS_GROUND = 9
/** Picking ground bands: they share their floor's depth, so equal depth passes. */
export const PASS_PICK_GROUND = 11
/**
 * Baseline (0064): opaque depth alone, single-sampled, drawn with the prepass's vertex stage. It
 * stands in for resolving multisampled depth, which GLSL ES 3.00 can't read.
 */
export const PASS_DEPTH = 13
/** Depth bias of ground draws against the floor under them (float depth ULPs, and slope). */
const GROUND_DEPTH_BIAS = 8
const GROUND_SLOPE_BIAS = 2

/**
 * The picking pass's color targets: entity id, and the world normal with the depth in w (0 where
 * nothing drew). Depth rides in a color target because depth formats only copy out whole.
 */
export const PICK_TARGETS: GPUColorTargetState[] = [
  { format: 'r32uint' },
  { format: 'rgba32float' },
]

// Octahedral normal (xy) and screen velocity: two channels each.
const PREPASS_TARGETS: GPUColorTargetState[] = [{ format: 'rg16float' }, { format: 'rg16float' }]

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
  // A camera with reveal points draws the batches its points can cut with the cutaway variant
  // (0070); the others, and every shadow pass, never link it.
  const cutaway = ctx.world.tryResource(CutawayPath)
  const cutGroup = cutaway?.bindGroup(gpu, cam.entity)
  if (cutGroup) renderPass.setBindGroup(3, cutGroup)
  let current: GPURenderPipeline | undefined
  let boundMaterial: GPUBindGroup | undefined
  let boundPositions: GPUBuffer | undefined
  let boundTangents: GPUBuffer | undefined
  let boundIndices: GPUBuffer | undefined
  let switches = 0
  for (let d = 0; d < draws.length; d++) {
    const item = draws.items[d]!
    const own = item.batch.material
    if (!inPass(own.type, pass)) continue
    const cut =
      cutGroup !== undefined &&
      item.batch.cutaway > 0 &&
      cutaway!.cuts(cam.entity, item.batch.index)
        ? cutaway
        : undefined
    // A type whose shader or pipeline failed draws with the standard pipeline instead (0061).
    const fallback = state.pipelines.failing(own.type)
    const material = fallback ? state.pipelines.proxy(own) : own
    const pipeline = materialPipeline(ctx, state, cam, store, assets, material, pass, true, cut)
    if (!pipeline) {
      // It just failed: draw this item again, through the fallback.
      if (!fallback && state.pipelines.failing(own.type)) d--
      continue
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
      else renderPass.drawIndexed(gm.count, item.count, gm.firstIndex, gm.baseVertex, item.first)
    } else if (item.indirect >= 0) {
      renderPass.drawIndirect(args, item.indirect)
    } else {
      renderPass.draw(gm.count, item.count, 0, item.first)
    }
  }
  if (draws.cullView < 0) warmPipelines(ctx, state, cam, store, assets, pass, cutGroup && cutaway)
  return switches
}

/** Whether a material type draws in `pass`: the G-buffer takes standard lighting, picks pickable types. */
function inPass(type: MaterialType, pass: number): boolean {
  if (pass === PASS_GBUFFER) return type.standard
  if (pass === PASS_PICK || pass === PASS_PICK_GROUND) return type.pickable
  return true
}

/**
 * The pipeline that draws `material` in `pass` for this camera, asked for on a miss: undefined
 * while its shader or pipeline compiles, or when either failed (the caller draws the fallback).
 * `draw`: a skipped draw counts in `gpu.pipelines.skipped`.
 */
function materialPipeline(
  ctx: NodeContext,
  state: ForwardState,
  cam: CameraData,
  store: InstanceStore,
  assets: GpuAssets,
  material: MaterialAsset,
  pass: number,
  draw: boolean,
  cut?: CutawaySupport,
): GPURenderPipeline | undefined {
  const gpu = ctx.gpu
  const type = material.type
  const variant = materialVariant(material)
  const blend = variantBlend(variant)
  const gbuffer = pass === PASS_GBUFFER
  const depthOnly = pass === PASS_DEPTH
  const prepass = pass === PASS_PREPASS || depthOnly
  const pick = pass === PASS_PICK || pass === PASS_PICK_GROUND
  const ground = pass === PASS_GROUND || pass === PASS_PICK_GROUND
  // The G-buffer, the prepass, and picking are always single-sampled.
  const msaa = gbuffer || prepass || pick ? 1 : cam.msaa
  // Only lit slots link interior lighting (0069): the G-buffer, prepass and picking don't light.
  const mode = gbuffer || prepass || pick ? 0 : state.interiorMode
  // Nor toon shading (0108), which a view's camera turns on.
  const toon = !gbuffer && !prepass && !pick && cam.toon.tones > 0
  // Cutaway variants (0070) key above every other pass's pipelines (shadows' included).
  const key =
    ((pass * 1024 + typeOrdinal(type)) * 16 + variant) * 8 +
    msaa +
    (cut ? CUT_KEY : 0) +
    mode * INTERIOR_KEY +
    (toon ? TOON_KEY : 0)
  let pipeline = state.pipelines.cached(key)
  if (!pipeline) {
    const premultiply = blend === 'premultiplied'
    const mask = blend === 'mask'
    // Module slots: forward 0–7 (opaque 48–55), shadows 8, G-buffer 16–23, prepass 32–38, pick 40;
    // the cutaway variant of each is 64 more (0070), the toon variant 128 more (0108).
    const opaque = !gbuffer && !prepass && !pick && !isTransparent(blend)
    const slot =
      (cut ? 64 : 0) +
      (toon ? 128 : 0) +
      (pick
        ? 40
        : prepass
          ? 32 + (type.standard ? 0 : 4) + (mask ? 2 : 0)
          : (gbuffer ? 16 : opaque ? 48 : 0) +
            (type.standard ? 0 : 4) +
            (premultiply ? 1 : 0) +
            (mask ? 2 : 0))
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
      // Only what the slot tells apart: the prepass and picking don't premultiply.
      LIT_DEFINES[mode]![(cut ? 1 : 0) + (toon ? 2 : 0)]![
        pick
          ? 0
          : prepass
            ? mask
              ? 2
              : 0
            : (premultiply ? 1 : 0) | (mask ? 2 : 0) | (opaque ? 4 : 0)
      ],
    )
    if (!module) {
      // A draw waiting on its shader is a skipped draw too (one that just failed draws again,
      // through the fallback).
      if (draw && !state.pipelines.failing(type)) gpu.pipelines.skipped++
      return undefined
    }
    const transparent = isTransparent(blend) && !pick
    pipeline = state.pipelines.create(
      gpu,
      key,
      {
        label: `${pick ? 'pick' : prepass ? 'prepass' : gbuffer ? 'gbuffer' : ground ? 'ground' : 'forward'}/${type.name}/${blend}/x${msaa}/${variantCull(variant)}${cut ? '/cutaway' : ''}`,
        layout: materialLayout(gpu, state, assets, type, store, cut?.layout(gpu)),
        vertex: { module, entryPoint: 'vs', buffers: VERTEX_BUFFERS },
        fragment: {
          module,
          entryPoint: depthOnly ? 'fs_depth' : 'fs',
          targets: pick
            ? PICK_TARGETS
            : depthOnly
              ? []
              : prepass
                ? PREPASS_TARGETS
                : gbuffer
                  ? state.gbufferTargets
                  : [{ format: 'rgba16float', blend: blendState(blend) }],
        },
        primitive: {
          topology: 'triangle-list',
          cullMode: variantCull(variant),
          frontFace: 'ccw',
        },
        depthStencil: {
          format: 'depth32float',
          // Ground bands never write depth (so they never fight); picking them writes it, so the
          // nearest band wins at equal depth.
          depthWriteEnabled: pick || (!transparent && !ground),
          depthCompare: transparent || ground ? 'greater-equal' : 'greater',
          // Ground bands lie on their floor: a few ULPs and a slope term keep them in front of it
          // at any angle (reversed Z: toward the camera). Bands don't write depth, so they never
          // fight each other; the order does that.
          depthBias: ground ? GROUND_DEPTH_BIAS : 0,
          depthBiasSlopeScale: ground ? GROUND_SLOPE_BIAS : 0,
        },
        multisample: { count: msaa },
      },
      type,
    )
    if (!pipeline) return undefined
  }
  return pipeline
}

/**
 * Culled on the CPU, a list holds only what's in view, so a batch's pipeline would first be asked
 * for as it comes into view, and it would be missing while that compiles (GPU culling draws every
 * batch). Asks for the pipelines and material of every batch the list could hold instead, once per
 * change to the batches: a steady frame does one lookup.
 */
function warmPipelines(
  ctx: NodeContext,
  state: ForwardState,
  cam: CameraData,
  store: InstanceStore,
  assets: GpuAssets,
  pass: number,
  cut: CutawaySupport | undefined,
): void {
  const slot =
    pass * 8 +
    cam.msaa +
    (cut ? CUT_KEY : 0) +
    state.interiorMode * INTERIOR_KEY +
    (cam.toon.tones > 0 ? TOON_KEY : 0)
  if (state.pipelines.warmed(slot, store.structureVersion, ctx.gpu.generation)) return
  const ground = pass === PASS_GROUND || pass === PASS_PICK_GROUND
  const batches = store.batches
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!
    if (batch.count === 0 || batch.ground !== ground) continue
    if (pass === PASS_TRANSPARENT ? !batch.transparent : batch.transparent && pass !== PASS_PICK) {
      continue
    }
    // Deferred views draw forward only what the G-buffer can't take.
    if (pass === PASS_OPAQUE && cam.deferred && batch.deferrable) continue
    const own = batch.material
    if (!inPass(own.type, pass)) continue
    const material = state.pipelines.failing(own.type) ? state.pipelines.proxy(own) : own
    materialPipeline(ctx, state, cam, store, assets, material, pass, false)
    // Either variant may draw it as reveal points move: both are asked for.
    if (cut && batch.cutaway > 0)
      materialPipeline(ctx, state, cam, store, assets, material, pass, false, cut)
    assets.material(ctx.world, material)
  }
  // Done once nothing asked for is still compiling; until then, every frame asks again.
  if (ctx.gpu.pipelines.pending === 0) {
    state.pipelines.markWarmed(slot, store.structureVersion, ctx.gpu.generation)
  }
}

function recordSwitches(ctx: NodeContext, switches: number): void {
  const stats = ctx.world.resource(RenderStats).get(ctx.view.name)
  if (stats) stats.pipelineSwitches = Math.max(stats.pipelineSwitches ?? 0, switches)
}

export const isCamera = (view: RenderView) => cameraOf(view) !== undefined
const msaaOf = (view: RenderView) => cameraOf(view)?.msaa ?? 1

/** Baseline (0064): raises `render/light-budget` while a view has more lights than it shades. */
function reportLightBudget(world: World, view: string, b: BaselineViewLights, max: number): void {
  b.reported = b.dropped
  if (b.dropped === 0) {
    clearHealthIssue(world, 'render/light-budget', view)
    return
  }
  raiseHealthIssue(world, {
    code: 'render/light-budget',
    severity: 'degraded',
    ref: view,
    message: `${b.inView} point and spot lights are in view, over the baseline tier's ${Math.min(max, 128)}: the ${b.dropped} farthest aren't shaded`,
  })
}

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
        ...bindingDimension(gpu, '2d-array'),
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
  // Lights and clusters: the store's buffer and GPU clusters, or (baseline) the view's packed ones.
  const b = pv.baseline
  const lightsVersion = b ? b.lights.version : lights.buffer.version
  const clustersVersion = b ? b.bits.version : pv.clusters!.clusters.version
  // Interior lighting (0069): its bindings exist only while a mode is on.
  const interior = state.interiorMode !== 0 ? world.tryResource(InteriorPath) : undefined
  const key = `${idOf(ao)}/${gpu.generation}/${pv.uniform.version}/${lightsVersion}/${clustersVersion}/${lights.directional.version}/${pv.shadowData.version}/${idOf(cascades)}/${idOf(spots)}/${idOf(points)}/${baked ? idOf(baked.source) : 0}/${sh.version}/${state.globals.version}${interior ? `/${state.interiorMode}/${interior.version}` : ''}`
  if (!pv.bindGroup || pv.bound !== key) {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: pv.uniform.buffer } },
      { binding: 1, resource: b ? b.lights.resource() : { buffer: lights.buffer.buffer } },
      { binding: 2, resource: b ? b.bits.resource() : { buffer: pv.clusters!.clusters.buffer } },
      { binding: 3, resource: lights.directional.resource() },
      { binding: 4, resource: pv.shadowData.resource() },
      { binding: 5, resource: cascades.createView({ dimension: '2d-array' }) },
      { binding: 6, resource: spots.createView({ dimension: '2d-array' }) },
      { binding: 7, resource: points.createView({ dimension: '2d-array' }) },
      { binding: 8, resource: state.shadowSampler },
      { binding: 9, resource: specular },
      { binding: 10, resource: envs.lut!.createView() },
      { binding: 11, resource: envs.sampler! },
      { binding: 12, resource: sh.resource() },
      { binding: 13, resource: source },
      { binding: 14, resource: { buffer: state.globals.buffer } },
      { binding: 15, resource: ao.createView() },
    ]
    if (interior) entries.push(...interior.entries(gpu))
    pv.bindGroup = gpu.device.createBindGroup({
      label: 'forward/view',
      layout: state.layouts.view,
      entries,
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
      // GPU foliage (0045) draws in its own pass after this one (`foliage/draw`, 0075).
    },
  }
}

/**
 * Ground bands (0057): coplanar layers in (band, order) order after opaque geometry and the sky,
 * depth-tested so walls and props in front hide them, never writing depth so no band fights another.
 */
function groundNode(state: ForwardState) {
  return {
    kind: 'render' as const,
    phase: RenderPhase.Ground,
    enabled: (view: RenderView) => (cameraOf(view)?.ground.length ?? 0) > 0,
    reads: ['clusters', 'shadow-cascades', 'shadow-local', 'environment', 'culled', 'ssao'],
    writes: ['scene-color', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    run: (ctx: NodeContext) => {
      const cam = cameraOf(ctx.view)!
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      drawMaterials(ctx, state, pv, cam, cam.ground, PASS_GROUND)
    },
  }
}

/**
 * Ground bands from the overlay band up (0058): after transparent objects and projected fog, so fog
 * never covers selection rings, pings or templates. Only in views that have some.
 */
function overlayNode(state: ForwardState) {
  return {
    kind: 'render' as const,
    phase: RenderPhase.Overlay3d,
    enabled: (view: RenderView) => (cameraOf(view)?.overlay.length ?? 0) > 0,
    reads: ['clusters', 'shadow-cascades', 'shadow-local', 'environment', 'culled', 'ssao'],
    writes: ['scene-color', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth', readOnly: true },
    run: (ctx: NodeContext) => {
      const cam = cameraOf(ctx.view)!
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      drawMaterials(ctx, state, pv, cam, cam.overlay, PASS_GROUND)
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
    // Baseline bins on the CPU (baseline/lights.ts): no compute.
    enabled: (view: RenderView) => isCamera(view) && !state.baseline,
    writes: ['clusters'],
    run: (ctx: NodeContext) => {
      const pv = state.views.get(ctx.view.name)
      if (!pv?.clusters) return
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

/** Draws skipped before a shadow view started (a skip during it leaves its layer incomplete). */
let skippedBefore = 0

/** Whether a shadow view draws this frame; counts it when it does. */
function beginShadowView(ctx: NodeContext, view: ShadowViewDraw): boolean {
  if (!view.redraw && view.drawn) return false
  skippedBefore = ctx.gpu.pipelines.skipped
  ctx.world.resource(RenderStats).current.shadowMapsRendered++
  return true
}

/** A cached layer is kept only if every caster drew. */
function endShadowView(ctx: NodeContext, view: ShadowViewDraw): void {
  if (ctx.gpu.pipelines.skipped === skippedBefore)
    markShadowDrawn(view, ctx.world.resource(Instances))
  else view.drawn = false
}

/** The pipeline that clears a rectangle of a cached shadow layer (0116), once ready. */
function clearRectPipeline(ctx: NodeContext, state: ForwardState): GPURenderPipeline | undefined {
  const c = state.clearRect
  const gpu = ctx.gpu
  if (c.generation === gpu.generation && c.pipeline) return c.pipeline
  // shard::fullscreen's triangle sits at depth 0: the far plane, a cleared layer's value.
  const module = ctx.world.resource(Shaders).module(gpu, { root: 'shard::fullscreen' })
  if (!module) return undefined
  c.pipeline = gpu.pipelines.render({
    label: 'shadows/clear-rect',
    layout: gpu.layouts.pipelineLayout({ label: 'shadows/clear-rect', bindGroupLayouts: [] }),
    vertex: { module, entryPoint: 'vs' },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  })
  c.generation = gpu.generation
  return c.pipeline
}

function layerView(texture: GPUTexture, layer: number): GPUTextureView {
  return texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 })
}

/**
 * Draws a cached light's static view, whole or only its rect (0116). A rect redraw that can't
 * clear yet (its pipeline compiling) leaves the layer incomplete: it redraws whole next frame.
 */
function drawStaticView(
  ctx: NodeContext,
  state: ForwardState,
  texture: GPUTexture,
  view: ShadowViewDraw,
  label: string,
  foliage?: FoliageSupport,
  cam?: CameraData,
  cascade = 0,
): void {
  if (!beginShadowView(ctx, view)) return
  const clear = view.rect ? clearRectPipeline(ctx, state) : undefined
  if (view.rect && !clear) {
    view.drawn = false
    return
  }
  const shadows = ctx.world.resource(ShadowsResource)
  drawShadowCasters(
    ctx,
    layerView(texture, view.layer),
    view,
    view.offset,
    shadows.uniforms,
    state.pipelines,
    state.layouts.shadowView,
    label,
    foliage,
    cam,
    cascade,
    clear,
  )
  endShadowView(ctx, view)
}

/** Draws a cached light's dynamic view over its static one, when the queue asked for it (0116). */
function drawDynamicView(
  ctx: NodeContext,
  state: ForwardState,
  texture: GPUTexture,
  view: ShadowViewDraw,
  label: string,
  foliage?: FoliageSupport,
  cam?: CameraData,
  cascade = 0,
): void {
  if (!view.redraw) return
  ctx.world.resource(RenderStats).current.shadowMapsRendered++
  const shadows = ctx.world.resource(ShadowsResource)
  drawShadowCasters(
    ctx,
    layerView(texture, view.layer),
    view,
    view.offset,
    shadows.uniforms,
    state.pipelines,
    state.layouts.shadowView,
    label,
    foliage,
    cam,
    cascade,
  )
  view.drawn = true
}

/**
 * Renders the camera's cascades: one depth layer per cascade, or for a cached sun (0116) a static
 * layer redrawn where it changed and a dynamic layer over it.
 */
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
      const cascades = pv.cascades
      const size = ctx.world.resource(LightingSettings).cascadeMapSize
      const texture = cascades.ensureTexture(ctx.gpu, size, ctx.view.name)
      const foliage = ctx.world.tryResource(FoliagePath)
      const cam = cameraOf(ctx.view)!
      // Swaying foliage (0045) casts each frame: into the dynamic layer when cached, else it keeps
      // the nearest cascade redrawing.
      const animated = pv.foliageAnimated
      // Compiled ahead, so the first rect redraw doesn't fall back to a full one.
      if (cascades.cached) clearRectPipeline(ctx, state)
      for (let i = 0; i < cascades.count; i++) {
        const view = cascades.views[i]!
        const label = `shadows/cascade${i}`
        if (!cascades.cached) {
          if (animated && i === 0) view.redraw = true
          drawStaticView(ctx, state, texture, view, label, foliage, cam, i)
          continue
        }
        drawStaticView(ctx, state, texture, view, label, animated ? undefined : foliage, cam, i)
        const dynamic = cascades.dynamic[i]!
        drawDynamicView(
          ctx,
          state,
          texture,
          dynamic,
          `${label}/dynamic`,
          animated ? foliage : undefined,
          cam,
          i,
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
      if (local.anyCached) clearRectPipeline(ctx, state)
      for (let i = 0; i < local.spots.length; i++) {
        drawStaticView(ctx, state, local.spotTexture!, local.spotViews[i]!, `shadows/spot${i}`)
        drawDynamicView(
          ctx,
          state,
          local.spotTexture!,
          local.spotDynamic[i]!,
          `shadows/spot${i}/dynamic`,
        )
      }
      for (let i = 0; i < local.points.length * 6; i++) {
        drawStaticView(ctx, state, local.pointTexture!, local.pointViews[i]!, `shadows/point${i}`)
        drawDynamicView(
          ctx,
          state,
          local.pointTexture!,
          local.pointDynamic[i]!,
          `shadows/point${i}/dynamic`,
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
/** Draws the environment map (Skybox) wherever no geometry was drawn. Atmospheres draw their own. */
export function skyNode(state: ForwardState) {
  const data = new Float32Array(4)
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
      const entry = view.data.environment as { background: number; sky: boolean } | undefined
      return (entry?.background ?? -1) >= 0 && !entry?.sky
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
      data[0] = entry.background
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

/**
 * Baseline (0064): single-sample depth for passes that read `depth` when the scene is
 * multisampled, since GLSL ES 3.00 can't read multisampled textures. Opaque geometry is drawn a
 * second time, depth only, before the scene; nothing draws it unless a pass reads `depth`.
 */
function depthPrepassNode(state: ForwardState) {
  return {
    kind: 'render' as const,
    phase: RenderPhase.Prepass,
    enabled: (view: RenderView) => state.baseline !== undefined && msaaOf(view) > 1,
    reads: ['culled'],
    writes: ['depth'],
    depth: { resource: 'depth', clear: 0 },
    run: (ctx: NodeContext) => {
      const pv = state.views.get(ctx.view.name)
      const cam = cameraOf(ctx.view)
      if (!pv || !cam) return
      drawMaterials(ctx, state, pv, cam, cam.draws, PASS_DEPTH)
      if (cam.deferred) drawMaterials(ctx, state, pv, cam, cam.forwardOnly, PASS_DEPTH)
    },
  }
}

/** Single-sample depth from MSAA depth (sample 0), for passes that read depth. */
function depthResolveNode(state: ForwardState) {
  let bindGroups = new WeakMap<GPUTexture, GPUBindGroup>()
  let generation = -1
  return {
    kind: 'render' as const,
    phase: RenderPhase.Resolve,
    // Baseline draws `depth` in its own prepass instead (depthPrepassNode).
    enabled: (view: RenderView) => state.baseline === undefined && msaaOf(view) > 1,
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
  /** Render scale of window cameras (0051). Default: auto, 0.5–1. */
  renderScale?: Partial<
    Pick<RenderScaleValue, 'mode' | 'scale' | 'min' | 'max' | 'targetMs' | 'maxHz' | 'sharpen'>
  >
}

/** Group 0's entries: view, lights, clusters, shadows, environment, globals, SSAO. */
function viewEntries(gpu: GpuContext): GPUBindGroupLayoutEntry[] {
  const F = GPUShaderStage.FRAGMENT
  const depthArray = (binding: number) => ({
    binding,
    visibility: F,
    texture: { sampleType: 'depth' as const, viewDimension: '2d-array' as const },
  })
  return [
    { binding: 0, visibility: GPUShaderStage.VERTEX | F, buffer: { type: 'uniform' } },
    // Storage on the full tier; on baseline (0064) lights, directional lights, shadow data and SH
    // are uniform blocks and the cluster bits a data texture.
    dataEntry(gpu, 1, F, 'uniform'),
    dataEntry(gpu, 2, F, 'texture'),
    dataEntry(gpu, 3, F, 'uniform'),
    dataEntry(gpu, 4, F, 'uniform'),
    depthArray(5),
    depthArray(6),
    depthArray(7),
    { binding: 8, visibility: F, sampler: { type: 'comparison' } },
    { binding: 9, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
    { binding: 10, visibility: F, texture: { sampleType: 'float' } },
    { binding: 11, visibility: F, sampler: { type: 'filtering' } },
    dataEntry(gpu, 12, F, 'uniform'),
    { binding: 13, visibility: F, texture: { sampleType: 'float', viewDimension: 'cube' } },
    { binding: 14, visibility: GPUShaderStage.VERTEX | F, buffer: { type: 'uniform' } },
    { binding: 15, visibility: F, texture: { sampleType: 'float' } },
  ]
}

/** Bind group and pipeline layouts, created per device (after a device loss they're rebuilt). */
function createLayouts(gpu: GpuContext, assets: GpuAssets, store: InstanceStore): Layouts {
  const view = gpu.layouts.bindGroupLayout({ label: 'forward/view', entries: viewEntries(gpu) })
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
    viewBase: view,
    viewInterior: undefined,
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

/**
 * Group 0 with interior lighting's bindings (0069): its data (the sky field and the light rows,
 * one r32uint array) and its table. Only while a mode is on, so materials keep their sampled-texture room otherwise.
 */
function interiorViewLayout(gpu: GpuContext, state: ForwardState): GPUBindGroupLayout {
  const layouts = state.layouts
  if (layouts.viewInterior) return layouts.viewInterior
  const F = GPUShaderStage.FRAGMENT
  layouts.viewInterior = gpu.layouts.bindGroupLayout({
    label: 'forward/view/interior',
    entries: [
      ...viewEntries(gpu),
      {
        binding: INTERIOR_BINDINGS.data,
        visibility: F,
        texture: { sampleType: 'uint', viewDimension: '2d-array' },
      },
      { binding: INTERIOR_BINDINGS.table, visibility: F, buffer: { type: 'uniform' } },
    ],
  })
  return layouts.viewInterior
}

/** Picks this frame's interior mode (0069) and the view layout that goes with it. */
function chooseInterior(gpu: GpuContext, world: World, state: ForwardState): void {
  const mode = world.tryResource(InteriorPath)?.mode ?? 0
  state.interiorMode = mode
  state.layouts.view = mode !== 0 ? interiorViewLayout(gpu, state) : state.layouts.viewBase
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
 * The core of the 3D renderer: cameras, meshes, the standard material, lights, shadows, and ambient
 * light, drawn into HDR with instancing, frustum culling, and clustered light culling, then
 * tonemapped. Needs the render and transform plugins. Features (atmosphere, post, ...) are plugins
 * of their own; `forwardPlugin` adds all of them.
 */
export function forwardCorePlugin(options: ForwardPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'render/forward',
    provides: [
      // core
      Environments,
      MaterialFallbacks,
      DeferredPath,
      DeformPath,
      PostFeatures,
      MaterialNoise,
      MaterialAssetType,
      MaterialImporter,
      Materials,
      MeshAsset,
      Meshes,
      RenderTargets,
      STANDARD_TYPE,
      StandardMaterial,
      Camera3d,
      Exposure,
      PhysicalCamera,
      DrivesView,
      ForwardStateResource,
      Mesh3d,
      MeshMaterial,
      GpuAssetsResource,
      InstanceData,
      InstanceSlot,
      Instances,
      Lod,
      MorphWeights,
      NotShadowCaster,
      NotShadowReceiver,
      ShadowWhenHidden,
      DynamicCaster,
      OcclusionCulling,
      Occluder,
      SkinnedMesh,
      VisibilityRange,
      AmbientLight,
      DirectionalLight,
      LightingSettings,
      Lights,
      PointLight,
      SpotLight,
      ComputedVisibility,
      Visibility,
      // per-view visibility and cutaways (0070)
      ViewVisibility,
      HiddenSetsResource,
      Cutaway,
      CutawayView,
      CutawayPath,
      OcclusionPath,
      // interior lighting (0069)
      InteriorPath,
      Cameras,
      RenderPath,
      Tonemapping,
      ViewSettings,
      Culler,
      ViewUniform,
      GpuMemory,
      RenderCounters,
      RenderStats,
      SkinAssetType,
      Skins,
      RenderScale,
      // tabletop (0057)
      GroundLayer,
      RenderLayers,
      Outline,
      OutlinePath,
      // toon shading and ink (0108)
      Toon,
      Ink,
      ToonPath,
      Trail,
      Beam,
      Decal,
      DecalReceiver,
      RibbonsPath,
      DecalsPath,
      CameraMoved,
      // shadows
      ShadowsResource,
      // post
      Antialiasing,
      AutoExposure,
      Bloom,
      ColorGrading,
      DepthOfField,
      Fog,
      MotionBlur,
      Ssao,
      Vignette,
      // pixel-perfect
      PixelPerfect,
      PixelPerfectPath,
      PixelTargets,
      // lens fields
      Lens,
      LensFields,
      LensPath,
      // screen effects
      ScreenEffects,
      ScreenEffectHandlers,
      // shard shaders bake (0064)
      ShaderVariantSources,
    ],
    dependencies: ['render', 'core/transform'],
    build(app) {
      const w = app.world
      // shaders.variants.json's { "material": … } entries (0064's bake).
      addShaderVariantSource(w, materialVariants)
      w.initResource(Meshes)
      w.initResource(Skins)
      w.initResource(Materials)
      w.initResource(Textures)
      w.initResource(RenderTargets)
      w.initResource(AmbientLight)
      w.initResource(RenderStats)
      w.initResource(Cameras)
      w.initResource(LightingSettings)
      w.initResource(Environments)
      w.initResource(ViewSettings).msaa = options.msaa ?? 4
      Object.assign(w.initResource(RenderScale), options.renderScale)
      w.initResource(LensFields)
      w.initResource(ScreenEffects)
      w.initResource(ScreenEffectHandlers)
      w.initResource(RenderDescribers).set('screenEffects', describeScreenEffects)
      observeInstanceRemovals(w)
      observeOutlinesWithoutPass(w)
      observeToonWithoutPlugin(w)
      observeVfxWithoutPlugin(w)
      observeViewVisibilityWithoutPlugin(w)
      observeLightRemovals(w)
      observeOriginShifts(w)
      app
        .addSystems(PreUpdate, runScreenEffects)
        .addSystems(PostUpdate, computeVisibility.after(TransformSystems), applyPhysicalCameras)
        .addSystems(
          Last,
          expireLensFields.inSet(RenderSet.Begin),
          expireScreenEffects.inSet(RenderSet.Begin),
          extractCameras.inSet(RenderSet.Extract),
          extractLights.inSet(RenderSet.Extract),
          prepareInstances.inSet(RenderSet.Prepare),
          prepareLights.inSet(RenderSet.Prepare),
          forwardQueue.inSet(RenderSet.Queue),
          warnOcclusionMissing.inSet(RenderSet.Queue),
          upload.inSet(RenderSet.Upload),
        )
    },
    async ready(app) {
      const gpu = app.world.resource(Gpu)
      // The baseline tier's strategies (0064): loaded only on a baseline device.
      const [baseline, baselineTextures] =
        gpu.tier === 'baseline'
          ? await Promise.all([import('./baseline/lights'), import('./baseline/textures')])
          : [undefined, undefined]
      // Past that await the app's scopes are left: re-enter them, so what's made counts against it.
      app.scoped(() => {
        // Basis textures transcode to what this device can sample.
        setTextureCapabilities({
          bc: gpu.features.has('texture-compression-bc'),
          astc: gpu.features.has('texture-compression-astc'),
          etc2: gpu.features.has('texture-compression-etc2'),
        })
        const assets = new GpuAssets(gpu, app.world.initResource(GpuMemory))
        if (baselineTextures) {
          assets.baseline = baselineTextures
          app.world.initResource(RenderDescribers).set('twins', () => assets.describeTwins())
        }
        assets.counts = app.world.initResource(RenderStats).current
        const store = new InstanceStore(gpu)
        app.insertResource(GpuAssetsResource, assets)
        unwatch.set(app, assets.watch(assetServer(app.world)))
        // owners.describe(owner).gpu: the GPU objects behind the assets it leases (0061).
        app.world.owners.addDescriber('gpu', (owner) => {
          const server = assetServer(app.world)
          const total = { buffers: 0, textures: 0, bytes: 0 }
          for (const path of server.leasesOf(owner)) {
            const item = server.item(path)
            const o = assets.objectsOf(item)
            total.buffers += o.buffers
            total.textures += o.textures
            total.bytes += o.bytes
          }
          return total
        })
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
          localPlanes: new Float32Array(24),
          clearRect: { pipeline: undefined, generation: -1 },
          warned: { budget: '', overflow: '' },
          globals: new GpuBuffer(gpu, {
            label: 'globals',
            usage: GPUBufferUsage.UNIFORM,
            size: new ShaderGlobalsData().values.byteLength,
          }),
          pipelines: new MaterialPipelines(),
          baseline,
          cullerActive: false,
          interiorMode: 0,
          gbufferTargets: [
            { format: 'rgba8unorm-srgb' },
            { format: 'rgba16float' },
            { format: gbufferEmissiveFormat(gpu) },
          ],
        }
        app.insertResource(MaterialFallbacks, {
          count: () => state.pipelines.failureCount,
          list: () => state.pipelines.failures(),
        })
        // Batches draw grouped by material type and variant, so pipeline switches stay rare.
        store.batchKey = (b) => typeOrdinal(b.material.type) * 16 + materialVariant(b.material)
        app.insertResource(State, state)
        const graph = app.world.resource(Graph)
        graph.declare({ name: 'scene-color', format: 'rgba16float', sampleCount: msaaOf })
        graph.declare({ name: 'scene-depth', format: 'depth32float', sampleCount: msaaOf })
        graph.declare({ name: 'hdr', format: 'rgba16float' })
        graph.declare({ name: 'depth', format: 'depth32float' })
        graph.declare({ name: 'ldr', format: 'view' })
        addRenderFeatures(app.world, {
          name: 'render/forward',
          description: 'Opaque, ground and transparent mesh passes, and the MSAA depth resolve.',
          nodes: [
            'forward-opaque',
            'forward-ground',
            'forward-transparent',
            'forward-overlay',
            'depth-resolve',
            'depth-prepass',
          ],
          baseline: {
            strategy:
              'Instances, visibility and deform data in data textures; MSAA depth from a single-sample depth prepass',
          },
        })
        addRenderFeatures(app.world, {
          name: 'render/culling',
          description: 'GPU frustum, range and LOD culling with indirect draws.',
          nodes: ['instance-cull'],
          baseline: { strategy: 'CPU culling and direct draws' },
        })
        addRenderFeatures(app.world, {
          name: 'render/light-clusters',
          description: 'Clustered light binning (Forward+).',
          nodes: ['light-clusters'],
          baseline: { strategy: 'CPU binning into a 128-light bitmask texture' },
        })
        addRenderFeatures(app.world, {
          name: 'render/shadows',
          description: 'Cascaded directional shadows, and spot and point shadow layers.',
          nodes: ['shadows/cascades', 'shadows/local'],
          baseline: { strategy: 'The same render passes' },
        })
        graph.addNode('instance-cull', cullNode(state))
        graph.addNode('light-clusters', clusterNode(state))
        graph.addNode('shadows/cascades', cascadeNode(state))
        graph.addNode('shadows/local', localShadowNode(state))
        graph.addNode('forward-opaque', forwardNode(state))
        graph.addNode('forward-ground', groundNode(state))
        graph.addNode('forward-overlay', overlayNode(state))
        graph.addNode('forward-transparent', transparentNode(state))
        graph.addNode('depth-resolve', depthResolveNode(state))
        graph.addNode('depth-prepass', depthPrepassNode(state))
        addDisplayNodes(app.world)
      })
    },
    dispose(app) {
      unwatch.get(app)?.()
      unwatch.delete(app)
    },
  })
}

/** Per app: stops freeing GPU copies on asset unloads (the forward plugin's dispose). */
const unwatch = new WeakMap<object, () => void>()

/** rg11b10ufloat when the device can render to it, else rgba16float. */
export function gbufferEmissiveFormat(gpu: GpuContext): GPUTextureFormat {
  return gpu.features.has('rg11b10ufloat-renderable') ? 'rg11b10ufloat' : 'rgba16float'
}
