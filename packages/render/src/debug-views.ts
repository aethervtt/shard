import {
  type Entity,
  type Profiler,
  ProfilerResource,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { Culler } from './culling'
import { ForwardStateResource } from './forward'
import type { CapturedBuffer } from './graph'
import { Instances } from './instances'
import { DirectionalLight, LightingSettings, Lights, PointLight, SpotLight } from './lights'
import { Gpu, Views } from './plugin'
import { BYTES_PER_TEXEL, toFloats } from './readback'
import { ShadowsResource } from './shadows'
import { Cameras, cameraOf } from './view'

/** Debug views a camera can render instead of its normal image. */
export const DEBUG_VIEWS = { none: 0, clusters: 1, cascades: 2, lod: 3, culling: 0 } as const
/** G-buffer channels, shown through the `gbuffer-debug` buffer (deferred or forward views). */
export const GBUFFER_VIEWS = ['albedo', 'normal', 'roughness', 'metallic', 'emissive'] as const
export type DebugView = keyof typeof DEBUG_VIEWS | (typeof GBUFFER_VIEWS)[number]

/**
 * Switches a camera's debug view; it stays until switched back to 'none'. Lighting views replace
 * the image; G-buffer channels render into the `gbuffer-debug` buffer (see `captureBuffer`).
 */
export function setDebugView(world: World, camera: Entity, view: DebugView): void {
  const cam = world.resource(Cameras).get(camera)
  if (!cam) {
    throw new ShardError('render/unknown-camera', `Entity ${camera} is not a rendered camera`, {
      hint: 'Pass a Camera3d entity that has rendered at least one frame.',
    })
  }
  const channel = (GBUFFER_VIEWS as readonly string[]).indexOf(view)
  cam.gbufferDebug = channel
  cam.debug = channel >= 0 ? 0 : DEBUG_VIEWS[view as keyof typeof DEBUG_VIEWS]
  // 'culling' freezes what the camera culls with; anything else lets it follow the camera again.
  if (view === 'culling') {
    cam.frozenFrustum = Float32Array.from(cam.frustum)
    cam.frozenPosition = Float32Array.from(cam.position)
  } else {
    cam.frozenFrustum = undefined
    cam.frozenPosition = undefined
  }
}

const PREP_SYSTEMS = ['render/prepare-instances', 'render/forward-queue', 'render/upload-visible']

/** Mean CPU time of render preparation (slots, culling, uploads), in total and per system. */
function prepMs(profiler: Profiler | undefined) {
  if (!profiler) return undefined
  const systems: Record<string, number> = {}
  let total = 0
  for (const name of PREP_SYSTEMS) {
    const ms = profiler.timing(name)?.avg ?? 0
    systems[name] = ms
    total += ms
  }
  return { total, systems }
}

/** The culling section of `render.describe`: per view, what was culled and what it cost. */
export function describeCulling(world: World) {
  const store = world.tryResource(Instances)
  const culler = world.tryResource(Culler)
  const state = world.tryResource(ForwardStateResource)
  if (!store || !culler || !state) return undefined
  const profiler = world.tryResource(ProfilerResource)
  const views: Record<string, unknown> = {}
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    if (!cam) continue
    const lods = culler.lodCounts.get(cam.draws)
    views[view.name] = {
      mode: cam.draws.cullView >= 0 ? 'gpu' : 'cpu',
      batches: cam.draws.length,
      visible: cam.draws.visible + cam.forwardOnly.visible + cam.transparent.visible,
      perLod: lods ? [...lods].map((n) => n ?? 0) : undefined,
      frozen: cam.frozenFrustum !== undefined,
      shadowViews: state.views.get(view.name)?.cascades.count ?? 0,
    }
  }
  return {
    mode: culler.active ? 'gpu' : 'cpu',
    instances: store.live,
    batches: store.batches.filter((b) => b.count > 0).length,
    lodSets: store.lodSets.length,
    uploadedBytes: store.uploadedBytes,
    cpuMs: prepMs(profiler),
    gpuMs: profiler?.timing('gpu:instance-cull')?.avg,
    views,
  }
}

/** Copies one layer of a texture to the CPU as floats (depth in R). */
export async function readTextureLayer(
  gpu: GpuContext,
  texture: GPUTexture,
  layer: number,
): Promise<CapturedBuffer> {
  const { width, height, format } = texture
  const bpp = BYTES_PER_TEXEL[format] ?? 4
  const bytesPerRow = Math.ceil((width * bpp) / 256) * 256
  const buffer = gpu.device.createBuffer({
    label: 'capture/layer',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = gpu.device.createCommandEncoder({ label: 'capture/layer' })
  encoder.copyTextureToBuffer(
    {
      texture,
      origin: { x: 0, y: 0, z: layer },
      aspect: format.startsWith('depth') ? 'depth-only' : 'all',
    },
    { buffer, bytesPerRow },
    [width, height, 1],
  )
  gpu.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const src = buffer.getMappedRange().slice(0)
  buffer.unmap()
  buffer.destroy()
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    toFloats(src.slice(y * bytesPerRow, (y + 1) * bytesPerRow), format, width, data, y * width * 4)
  }
  return { width, height, format, data }
}

/** Reads a GPU buffer back to the CPU (tests and debugging). */
export async function readBuffer(
  gpu: GpuContext,
  source: GPUBuffer,
  size: number,
): Promise<ArrayBuffer> {
  const buffer = gpu.device.createBuffer({
    label: 'readback',
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = gpu.device.createCommandEncoder({ label: 'readback' })
  encoder.copyBufferToBuffer(source, 0, buffer, 0, size)
  gpu.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const out = buffer.getMappedRange().slice(0)
  buffer.unmap()
  buffer.destroy()
  return out
}

/**
 * A light's shadow map as floats (reversed-Z depth in R). Directional lights: the cascades of
 * `camera` (default: the first camera view), `layer` = cascade. Spots: its map. Points: `layer` =
 * face (+X, -X, +Y, -Y, +Z, -Z).
 */
export async function captureShadowMap(
  world: World,
  light: Entity,
  layer = 0,
  camera?: Entity,
): Promise<CapturedBuffer> {
  const gpu = world.resource(Gpu)
  const lights = world.resource(Lights)
  const local = world.resource(ShadowsResource).local
  const noShadow = (why: string) =>
    new ShardError('render/no-shadow-map', `Light ${light} has no shadow map: ${why}`, {
      hint: 'Set shadows: true on the light, and check render.describe for the shadow budget.',
    })
  if (world.isAlive(light) && world.has(light, DirectionalLight)) {
    if (lights.shadowSun?.entity !== light) throw noShadow('not the shadowed directional light')
    const state = world.resource(ForwardStateResource)
    const viewName =
      camera !== undefined
        ? `camera:${camera}`
        : world.resource(Views).list.find((v) => cameraOf(v))?.name
    const pv = viewName ? state.views.get(viewName) : undefined
    if (!pv?.cascades.texture || layer >= pv.cascades.count) throw noShadow('no cascades rendered')
    return readTextureLayer(gpu, pv.cascades.texture, layer)
  }
  const r = lights.byEntity.get(light)
  if (!r) throw noShadow('not a light')
  if (r.shadowIndex < 0) throw noShadow('no shadow map this frame (budget or shadows off)')
  if (r.kind === 1) return readTextureLayer(gpu, local.spotTexture!, r.shadowIndex)
  return readTextureLayer(gpu, local.pointTexture!, r.shadowIndex * 6 + Math.min(5, layer))
}

/** The lighting section of `render.describe`: per view lights, clusters, shadows, uploads. */
export function describeLighting(world: World) {
  const lights = world.tryResource(Lights)
  const state = world.tryResource(ForwardStateResource)
  const shadows = world.tryResource(ShadowsResource)
  if (!lights || !state || !shadows) return undefined
  const settings = world.resource(LightingSettings)
  const local = shadows.local
  const views: Record<string, unknown> = {}
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    const pv = state.views.get(view.name)
    if (!cam || !pv) continue
    views[view.name] = {
      lights: pv.lightList.records.map((r) => ({
        entity: r.entity,
        type: r.kind === 1 ? 'spot' : 'point',
        intensity: r.intensity,
        range: r.range,
        castsShadows: r.shadowIndex >= 0,
      })),
      clusters: {
        grid: [16, 9, 24],
        // GPU clustering's stats; baseline bins on the CPU and drops lights past its budget.
        maxLightsPerCluster: pv.clusters?.latest.maxLightsPerCluster ?? null,
        overflows: pv.clusters?.latest.overflows ?? 0,
        baselineLights: pv.baseline
          ? { packed: pv.baseline.count, dropped: pv.baseline.dropped }
          : null,
      },
      cascades: pv.cascades.count,
      cascadeSplits: [...pv.cascades.splits.subarray(0, pv.cascades.count)],
    }
  }
  return {
    directional: lights.directionalCount,
    shadowedDirectional: lights.shadowSun?.entity ?? null,
    pointAndSpot: lights.byEntity.size,
    uploadedLights: lights.uploadedLights,
    uploadedBytes: lights.uploadedBytes,
    shadowBudget: {
      spots: `${local.spots.length}/${settings.maxShadowedSpots}`,
      points: `${local.points.length}/${settings.maxShadowedPoints}`,
      overBudget: local.overBudget.map((r) => ({
        entity: r.entity,
        type: world.has(r.entity, SpotLight)
          ? 'spot'
          : world.has(r.entity, PointLight)
            ? 'point'
            : 'unknown',
      })),
    },
    views,
  }
}
