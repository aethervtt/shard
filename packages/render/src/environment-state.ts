import { defineResource, type Entity } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import type { Texture } from '@aethervtt/shard-texture'
import type { CameraAtmosphere } from './atmosphere-state'
import { DataStore } from './data-store'
import { bindingDimension } from './tier'
import type { CameraData } from './view'

// What the forward pass binds for image-based lighting: each camera's prefiltered environment, or
// placeholders. environmentPlugin fills it (spec 0019); without it, cameras get flat ambient.

/** Frames between rebakes of a moving camera's atmosphere environment. */
export const REBAKE_FRAMES = 8
export const SOURCE_SIZE = 512
export const SKY_SIZE = 256
export const SPECULAR_SIZE = 256
export const SPECULAR_MIPS = 6
export const LUT_SIZE = 128

/** A prefiltered environment: source cube (with mips), specular cube, and SH9 irradiance. */
export class Environment {
  key = ''
  /** map: from a texture; atmosphere: baked from a camera's atmosphere (and ProceduralSky). */
  kind: 'map' | 'atmosphere'
  size: number
  source: GPUTexture
  specular: GPUTexture
  specularView: GPUTextureView
  sourceView: GPUTextureView
  /** SH9 of the diffuse irradiance: `@data(uniform)` in the forward shader. */
  readonly sh: DataStore
  /** 'pending' until the GPU has prefiltered the current key. */
  state: 'pending' | 'ready' = 'pending'
  /** How many times it's been (re)baked or prefiltered. */
  bakes = 0
  lastUsed = 0
  generation: number
  /** What to prefilter from: a texture (maps) or a camera's atmospheres. */
  input: Texture | undefined
  atmosphere: CameraAtmosphere | undefined
  /** The frame a rebake was last queued (atmospheres rebake at most every REBAKE_FRAMES). */
  queuedFrame = -1_000_000

  constructor(gpu: GpuContext, kind: 'map' | 'atmosphere') {
    this.kind = kind
    this.size = kind === 'atmosphere' ? SKY_SIZE : SOURCE_SIZE
    this.generation = gpu.generation
    const mips = Math.log2(this.size) + 1
    this.source = gpu.device.createTexture({
      label: `environment/${kind}/source`,
      size: [this.size, this.size, 6],
      format: 'rgba16float',
      mipLevelCount: mips,
      // Written by compute on the full tier; rendered face by face on baseline (0064).
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        (gpu.tier === 'full'
          ? GPUTextureUsage.STORAGE_BINDING
          : GPUTextureUsage.RENDER_ATTACHMENT) |
        GPUTextureUsage.COPY_SRC,
      ...bindingDimension(gpu, 'cube'),
    })
    this.specular = gpu.device.createTexture({
      label: `environment/${kind}/specular`,
      size: [SPECULAR_SIZE, SPECULAR_SIZE, 6],
      format: 'rgba16float',
      mipLevelCount: SPECULAR_MIPS,
      // Written by compute on the full tier; rendered face by face on baseline (0064).
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        (gpu.tier === 'full'
          ? GPUTextureUsage.STORAGE_BINDING
          : GPUTextureUsage.RENDER_ATTACHMENT) |
        GPUTextureUsage.COPY_SRC,
      ...bindingDimension(gpu, 'cube'),
    })
    this.sourceView = this.source.createView({ dimension: 'cube' })
    this.specularView = this.specular.createView({ dimension: 'cube' })
    this.sh = new DataStore(gpu, {
      label: `environment/${kind}/sh`,
      kind: 'uniform',
      usage: GPUBufferUsage.COPY_SRC,
      size: 9 * 16,
    })
  }

  destroy(): void {
    this.source.destroy()
    this.specular.destroy()
    this.sh.destroy()
  }
}

/** What a camera is lit and backed by this frame. */
export interface CameraEnvironment {
  environment: Environment | undefined
  intensity: number
  rotation: number
  /** Background: -1 none, otherwise the skybox brightness. */
  background: number
  /** Lit by an atmosphere (a planet's, or ProceduralSky's): its sky pass draws the background. */
  sky: boolean
  /** Atmosphere cameras: the environment map behind the sky (a star field), with its settings. */
  backdrop: { environment: Environment; intensity: number; rotation: number } | undefined
}

/** Environments by key, the BRDF lookup table, and the prefilter work for this frame. */
export class EnvironmentStore {
  readonly environments = new Map<string, Environment>()
  readonly cameras = new Map<Entity, CameraEnvironment>()
  readonly pending: Environment[] = []
  lut: GPUTexture | undefined
  lutReady = false
  emptyCube: GPUTexture | undefined
  emptyView: GPUTextureView | undefined
  emptySh: DataStore | undefined
  sampler: GPUSampler | undefined
  generation = -1
  frame = 0
  /** The frame the prefilter work last ran (it runs once per frame, for all views). */
  ranFrame = -1

  ensure(gpu: GpuContext): void {
    if (this.generation === gpu.generation && this.lut) return
    this.generation = gpu.generation
    for (const env of this.environments.values()) env.destroy()
    this.environments.clear()
    this.pending.length = 0
    this.lut = gpu.device.createTexture({
      label: 'environment/brdf-lut',
      size: [LUT_SIZE, LUT_SIZE],
      format: 'rgba16float',
      // Computed on the full tier; drawn by a fragment pass on baseline (0064).
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        (gpu.tier === 'full' ? GPUTextureUsage.STORAGE_BINDING : GPUTextureUsage.RENDER_ATTACHMENT),
    })
    this.lutReady = false
    this.emptyCube = gpu.device.createTexture({
      label: 'environment/empty',
      size: [1, 1, 6],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
      ...bindingDimension(gpu, 'cube'),
    })
    this.emptyView = this.emptyCube.createView({ dimension: 'cube' })
    this.emptySh = new DataStore(gpu, {
      label: 'environment/empty-sh',
      kind: 'uniform',
      size: 9 * 16,
    })
    this.sampler = gpu.device.createSampler({
      label: 'environment/sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    })
  }
}

export const Environments = defineResource<EnvironmentStore>('render/Environments', {
  description: 'Prefiltered environment maps and procedural skies, shared by cameras.',
  init: () => new EnvironmentStore(),
})

export function environmentParams(
  store: EnvironmentStore,
  cam: CameraData,
  out: Float32Array,
): Environment | undefined {
  const entry = store.cameras.get(cam.entity)
  const env = entry?.environment
  if (!entry || !env || env.bakes === 0) {
    out[0] = 0
    out[1] = 1
    out[2] = 0
    out[3] = 0
    return undefined
  }
  out[0] = entry.intensity
  out[1] = Math.cos(entry.rotation)
  out[2] = Math.sin(entry.rotation)
  out[3] = 1
  return env
}
