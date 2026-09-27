import { ShardError, type World } from '@aethervtt/shard-core'
import { GpuBuffer } from '@aethervtt/shard-gpu'
import { Culler } from './culling'
import {
  drawMaterials,
  ForwardStateResource,
  gbufferEmissiveFormat,
  PASS_GBUFFER,
  PASS_OPAQUE,
  sceneColor,
  viewBindGroup,
} from './forward'
import type { CapturedImage, NodeContext, RenderView } from './graph'
import { RenderPhase } from './graph'
import { Gpu, Graph, RenderDescribers, Shaders, Views } from './plugin'
import { type CameraData, Cameras, cameraOf } from './view'

/** G-buffer channels a capture can show. */
export const GBUFFER_CHANNELS = ['albedo', 'normal', 'roughness', 'metallic', 'emissive'] as const
export type GBufferChannel = (typeof GBUFFER_CHANNELS)[number]

const deferredView = (view: RenderView) => cameraOf(view)?.deferred === true
/** Views that fill a G-buffer: deferred ones, and forward ones asked to show a channel. */
const needsGBuffer = (view: RenderView) => {
  const cam = cameraOf(view)
  return cam !== undefined && (cam.deferred || cam.gbufferDebug >= 0)
}

const GBUFFER_CLEAR = [
  { resource: 'gbuffer0', clear: { r: 0, g: 0, b: 0, a: 1 } },
  { resource: 'gbuffer1', clear: { r: 0, g: 0, b: 0, a: 0 } },
  { resource: 'gbuffer2', clear: { r: 0, g: 0, b: 0, a: 0 } },
]

function fillGBuffer(ctx: NodeContext) {
  const state = ctx.world.resource(ForwardStateResource)
  const cam = cameraOf(ctx.view)!
  const pv = state.views.get(ctx.view.name)
  if (pv) drawMaterials(ctx, state, pv, cam, cam.draws, PASS_GBUFFER)
}

/** Opaque, deferrable meshes: vertex stage and surface stage, packed. No lighting. */
const gbufferNode = {
  kind: 'render' as const,
  phase: RenderPhase.Opaque,
  enabled: deferredView,
  writes: ['gbuffer0', 'gbuffer1', 'gbuffer2', 'scene-depth'],
  color: GBUFFER_CLEAR,
  depth: { resource: 'scene-depth', clear: 0 },
  run: fillGBuffer,
}

/** A forward view asked to show a G-buffer channel fills one, with its own single-sample depth. */
const gbufferFillNode = {
  kind: 'render' as const,
  phase: RenderPhase.Opaque,
  enabled: (view: RenderView) => needsGBuffer(view) && !deferredView(view),
  writes: [
    'gbuffer0',
    'gbuffer1',
    'gbuffer2',
    { name: 'gbuffer-depth', format: 'depth32float' as const },
  ],
  color: GBUFFER_CLEAR,
  depth: { resource: 'gbuffer-depth', clear: 0 },
  run: fillGBuffer,
}

/** One lighting evaluation per pixel from the G-buffer: directional, clustered, IBL, emissive. */
function lightingNode() {
  let layout: GPUBindGroupLayout | undefined
  let layoutGeneration = -1
  const bindGroups = new Map<string, { key: string; group: GPUBindGroup }>()
  return {
    kind: 'render' as const,
    phase: RenderPhase.Lighting,
    enabled: deferredView,
    reads: [
      'gbuffer0',
      'gbuffer1',
      'gbuffer2',
      'scene-depth',
      'clusters',
      'environment',
      'shadow-cascades',
      'shadow-local',
      'ssao',
    ],
    writes: ['scene-color', 'hdr'],
    color: (view: RenderView) => sceneColor(view, cameraOf(view)?.clear),
    run: (ctx: NodeContext) => {
      const gpu = ctx.gpu
      const state = ctx.world.resource(ForwardStateResource)
      const cam = cameraOf(ctx.view)!
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      const module = ctx.world
        .resource(Shaders)
        .module(gpu, { root: 'shard::pbr::deferred_lighting' })
      if (!module) {
        gpu.pipelines.skipped++
        return
      }
      if (!layout || layoutGeneration !== gpu.generation) {
        const F = GPUShaderStage.FRAGMENT
        layout = gpu.layouts.bindGroupLayout({
          label: 'deferred/gbuffer',
          entries: [
            { binding: 0, visibility: F, texture: { sampleType: 'float' } },
            { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
            { binding: 2, visibility: F, texture: { sampleType: 'float' } },
            { binding: 3, visibility: F, texture: { sampleType: 'depth' } },
          ],
        })
        layoutGeneration = gpu.generation
        bindGroups.clear()
      }
      const pipeline = gpu.pipelines.render({
        label: 'deferred/lighting',
        layout: gpu.layouts.pipelineLayout({
          label: 'deferred/lighting',
          bindGroupLayouts: [state.layouts.view, layout],
        }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      })
      if (!pipeline) return
      const g0 = ctx.texture('gbuffer0')
      const g1 = ctx.texture('gbuffer1')
      const g2 = ctx.texture('gbuffer2')
      const depth = ctx.texture('scene-depth')
      const key = `${idOf(g0)}/${idOf(g1)}/${idOf(g2)}/${idOf(depth)}`
      let bg = bindGroups.get(ctx.view.name)
      if (!bg || bg.key !== key) {
        bg = {
          key,
          group: gpu.device.createBindGroup({
            label: 'deferred/gbuffer',
            layout,
            entries: [
              { binding: 0, resource: g0.createView() },
              { binding: 1, resource: g1.createView() },
              { binding: 2, resource: g2.createView() },
              { binding: 3, resource: depth.createView() },
            ],
          }),
        }
        bindGroups.set(ctx.view.name, bg)
      }
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, viewBindGroup(gpu, ctx.world, pv, cam))
      pass.setBindGroup(1, bg.group)
      pass.draw(3)
    },
  }
}

/** Opaque materials with their own lighting, in a deferred view: forward, over the lit G-buffer. */
const forwardOnlyNode = {
  kind: 'render' as const,
  phase: RenderPhase.Lighting + 10,
  enabled: (view: RenderView) => deferredView(view) && cameraOf(view)!.forwardOnly.length > 0,
  reads: ['clusters', 'shadow-cascades', 'shadow-local', 'environment', 'ssao'],
  writes: ['scene-color', 'scene-depth', 'hdr'],
  color: (view: RenderView) => sceneColor(view),
  depth: { resource: 'scene-depth' },
  run: (ctx: NodeContext) => {
    const state = ctx.world.resource(ForwardStateResource)
    const cam = cameraOf(ctx.view)!
    const pv = state.views.get(ctx.view.name)
    if (pv) drawMaterials(ctx, state, pv, cam, cam.forwardOnly, PASS_OPAQUE)
  },
}

/** Renders the requested G-buffer channel into an 8-bit image for captures. */
function gbufferDebugNode() {
  const buffers = new Map<string, GpuBuffer>()
  const channel = new Uint32Array(4)
  return {
    kind: 'render' as const,
    phase: RenderPhase.Debug,
    enabled: (view: RenderView) => (cameraOf(view)?.gbufferDebug ?? -1) >= 0,
    reads: ['gbuffer0', 'gbuffer1', 'gbuffer2'],
    writes: [{ name: 'gbuffer-debug', format: 'rgba8unorm' as const }],
    sideEffects: true,
    color: [{ resource: 'gbuffer-debug', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx: NodeContext) => {
      const gpu = ctx.gpu
      const cam = cameraOf(ctx.view)!
      const module = ctx.world.resource(Shaders).module(gpu, { root: 'shard::debug::gbuffer' })
      if (!module) {
        gpu.pipelines.skipped++
        return
      }
      const F = GPUShaderStage.FRAGMENT
      const layout = gpu.layouts.bindGroupLayout({
        label: 'debug/gbuffer',
        entries: [
          { binding: 0, visibility: F, texture: { sampleType: 'float' } },
          { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: F, texture: { sampleType: 'float' } },
          { binding: 3, visibility: F, buffer: { type: 'uniform' } },
        ],
      })
      const pipeline = gpu.pipelines.render({
        label: 'debug/gbuffer',
        layout: gpu.layouts.pipelineLayout({ label: 'debug/gbuffer', bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      })
      if (!pipeline) return
      let buffer = buffers.get(ctx.view.name)
      if (!buffer) {
        buffer = new GpuBuffer(gpu, {
          label: 'debug/gbuffer',
          usage: GPUBufferUsage.UNIFORM,
          size: 16,
        })
        buffers.set(ctx.view.name, buffer)
      }
      channel[0] = cam.gbufferDebug
      buffer.write(channel)
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(
        0,
        gpu.device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: ctx.texture('gbuffer0').createView() },
            { binding: 1, resource: ctx.texture('gbuffer1').createView() },
            { binding: 2, resource: ctx.texture('gbuffer2').createView() },
            { binding: 3, resource: { buffer: buffer.buffer } },
          ],
        }),
      )
      pass.draw(3)
    },
  }
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

/**
 * A G-buffer channel of a camera, as an image, after the next frame renders it. Deferred views show
 * their own G-buffer; forward views fill one. The first time, set the channel with `setDebugView`
 * and render until shaders compile (as `render.capture` does), or the capture may be blank.
 */
export async function captureGBuffer(
  world: World,
  camera: number,
  channel: GBufferChannel,
): Promise<CapturedImage> {
  const cam = world.resource(Cameras).get(camera)
  if (!cam) {
    throw new ShardError('render/unknown-camera', `Entity ${camera} is not a rendered camera`)
  }
  const index = GBUFFER_CHANNELS.indexOf(channel)
  if (index < 0) {
    throw new ShardError('render/unknown-buffer', `Unknown G-buffer channel "${channel}"`, {
      hint: `Channels: ${GBUFFER_CHANNELS.join(', ')}, or depth.`,
    })
  }
  cam.gbufferDebug = index
  return (await world.resource(Graph).capture(`camera:${camera}`, 'gbuffer-debug')) as CapturedImage
}

function forwardReason(cam: CameraData, world: World): Record<string, number> {
  const reasons: Record<string, number> = {}
  const gpuCounts =
    cam.forwardOnly.cullView >= 0
      ? world.resource(Culler).batchCounts.get(cam.forwardOnly)
      : undefined
  for (let d = 0; d < cam.forwardOnly.length; d++) {
    const item = cam.forwardOnly.items[d]!
    const type = item.batch.material.type
    const why = type.standard ? 'not deferrable' : `custom lighting (${type.name})`
    const n = gpuCounts ? (gpuCounts[item.batch.index] ?? 0) : item.count
    if (n > 0) reasons[why] = (reasons[why] ?? 0) + n
  }
  if (cam.transparent.visible > 0) reasons.transparent = cam.transparent.visible
  return reasons
}

/** The deferred section of `render.describe`: path, G-buffer memory, and what drew forward. */
export function describeDeferred(world: World) {
  const gpu = world.tryResource(Gpu)
  if (!gpu) return undefined
  const views: Record<string, unknown> = {}
  const emissive = gbufferEmissiveFormat(gpu) === 'rg11b10ufloat' ? 4 : 8
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    if (!cam) continue
    const pixels = cam.width * cam.height
    views[view.name] = cam.deferred
      ? {
          path: 'deferred',
          gbufferBytes: pixels * (4 + 8 + emissive + 4),
          deferredMeshes: cam.draws.visible,
          forwardMeshes: cam.forwardOnly.visible + cam.transparent.visible,
          forwardReasons: forwardReason(cam, world),
        }
      : { path: 'forward', msaa: cam.msaa }
  }
  return { views }
}

/**
 * The deferred rendering path's graph nodes, installed by the forward renderer: a camera chooses
 * it with `RenderPath`, sharing lights, shadows, environments, and materials.
 */
export function addDeferredNodes(app: { world: World }): void {
  const gpu = app.world.resource(Gpu)
  const graph = app.world.resource(Graph)
  graph.declare({ name: 'gbuffer0', format: 'rgba8unorm-srgb' })
  graph.declare({ name: 'gbuffer1', format: 'rgba16float' })
  graph.declare({ name: 'gbuffer2', format: gbufferEmissiveFormat(gpu) })
  graph.addNode('deferred-gbuffer', gbufferNode)
  graph.addNode('gbuffer-fill', gbufferFillNode)
  graph.addNode('deferred-lighting', lightingNode())
  graph.addNode('deferred-forward', forwardOnlyNode)
  graph.addNode('gbuffer-debug', gbufferDebugNode())
  app.world.initResource(RenderDescribers).set('deferred', (world) => describeDeferred(world))
}
