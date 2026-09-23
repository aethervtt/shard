import {
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  t,
  type World,
} from '@shard/core'
import { GpuBuffer, type GpuContext } from '@shard/gpu'
import { type Texture, Textures } from '@shard/texture'
import { GpuAssetsResource } from './gpu-assets'
import type { NodeContext } from './graph'
import { Lights } from './lights'
import { Gpu, Shaders, Views } from './plugin'
import { type CameraData, cameraOf } from './view'

/** Environment luminance presets (cd/m² a texel of 1.0 represents). */
export const EnvironmentPresets = {
  'overcast-sky': 2000,
  'clear-sky': 8000,
} as const

export const EnvironmentMap = defineComponent(
  'render/EnvironmentMap',
  {
    texture: t.handle('Texture', {
      description: 'An HDR texture: an equirectangular .hdr (usage "hdr") or a cube-map KTX2.',
    }),
    intensity: t.f32({
      default: 5000,
      min: 0,
      unit: 'cd/m²',
      presets: EnvironmentPresets,
      description:
        'Luminance a texel value of 1.0 represents. HDR files are relative; this ties them to physical units. Presets: overcast-sky 2000, clear-sky 8000.',
    }),
    rotation: t.f32({ unit: 'deg', description: 'Rotation of the environment about +Y.' }),
  },
  {
    description:
      'Image-based lighting for a camera: ambient light and reflections from an HDR environment, prefiltered on the GPU.',
  },
)

export const Skybox = defineComponent(
  'render/Skybox',
  {
    brightness: t.f32({
      default: 1,
      min: 0,
      description: "Multiplies the environment's luminance in the background (not its lighting).",
    }),
  },
  {
    description: "Draws the camera's environment map behind everything. Replaces the clear color.",
  },
)

export const ProceduralSky = defineComponent(
  'render/ProceduralSky',
  {
    turbidity: t.f32({
      default: 2,
      min: 1,
      max: 10,
      description: 'Haze: aerosol density. 1 is very clear, 10 is hazy.',
    }),
    rayleigh: t.f32({
      default: 1,
      min: 0,
      description: 'Multiplies molecular (blue) scattering.',
    }),
    mie: t.f32({ default: 1, min: 0, description: 'Multiplies aerosol (white haze) scattering.' }),
    groundAlbedo: t.color({
      default: [0.3, 0.3, 0.3, 1],
      description: 'Ground below the horizon.',
    }),
    sunDiskSize: t.f32({
      default: 1,
      min: 0,
      description: "Sun disk radius, as a multiple of the real sun's (0.27°). 0 hides the disk.",
    }),
  },
  {
    description:
      'A single-scattering atmosphere lit by the brightest DirectionalLight, in cd/m² consistent with its illuminance. Drawn as the background, and baked into the environment so image-based lighting follows the time of day.',
  },
)

export interface EnvironmentMapValue {
  texture: { guid?: string; path?: string } | null
  intensity: number
  rotation: number
}

export interface ProceduralSkyValue {
  turbidity: number
  rayleigh: number
  mie: number
  groundAlbedo: [number, number, number, number]
  sunDiskSize: number
}

export interface DefaultEnvironmentValue {
  /** An environment map for cameras without one. */
  map: EnvironmentMapValue | null
  /** A procedural sky for cameras without an environment of their own. */
  sky: Partial<ProceduralSkyValue> | null
  /** Draw the default environment as the background (like Skybox). Default true. */
  background: boolean
}

export const DefaultEnvironment = defineResource<DefaultEnvironmentValue>(
  'render/DefaultEnvironment',
  {
    description:
      'The environment (map or procedural sky) for cameras that have none. AmbientLight is the fallback when neither is set.',
    init: () => ({ map: null, sky: null, background: true }),
  },
)

const SKY_DEFAULTS: ProceduralSkyValue = {
  turbidity: 2,
  rayleigh: 1,
  mie: 1,
  groundAlbedo: [0.3, 0.3, 0.3, 1],
  sunDiskSize: 1,
}

export const SOURCE_SIZE = 512
export const SKY_SIZE = 256
export const SPECULAR_SIZE = 256
export const SPECULAR_MIPS = 6
const LUT_SIZE = 128

/** A prefiltered environment: source cube (with mips), specular cube, and SH9 irradiance. */
export class Environment {
  key = ''
  kind: 'map' | 'sky'
  size: number
  source: GPUTexture
  specular: GPUTexture
  specularView: GPUTextureView
  sourceView: GPUTextureView
  readonly sh: GpuBuffer
  /** 'pending' until the GPU has prefiltered the current key. */
  state: 'pending' | 'ready' = 'pending'
  /** How many times it's been (re)baked or prefiltered. */
  bakes = 0
  lastUsed = 0
  generation: number
  /** What to prefilter from: a texture (maps) or sky parameters. */
  input: Texture | undefined
  sky: ProceduralSkyValue | undefined
  sun = new Float32Array(4)
  /** The sun luminance (cd/m²) of the disk as last baked, for describe. */
  sunLuminance = 0

  constructor(gpu: GpuContext, kind: 'map' | 'sky') {
    this.kind = kind
    this.size = kind === 'sky' ? SKY_SIZE : SOURCE_SIZE
    this.generation = gpu.generation
    const mips = Math.log2(this.size) + 1
    this.source = gpu.device.createTexture({
      label: `environment/${kind}/source`,
      size: [this.size, this.size, 6],
      format: 'rgba16float',
      mipLevelCount: mips,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
    })
    this.specular = gpu.device.createTexture({
      label: `environment/${kind}/specular`,
      size: [SPECULAR_SIZE, SPECULAR_SIZE, 6],
      format: 'rgba16float',
      mipLevelCount: SPECULAR_MIPS,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
    })
    this.sourceView = this.source.createView({ dimension: 'cube' })
    this.specularView = this.specular.createView({ dimension: 'cube' })
    this.sh = new GpuBuffer(gpu, {
      label: `environment/${kind}/sh`,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
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
  sky: boolean
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
  emptySh: GpuBuffer | undefined
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
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
    this.lutReady = false
    this.emptyCube = gpu.device.createTexture({
      label: 'environment/empty',
      size: [1, 1, 6],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    })
    this.emptyView = this.emptyCube.createView({ dimension: 'cube' })
    this.emptySh = new GpuBuffer(gpu, {
      label: 'environment/empty-sh',
      usage: GPUBufferUsage.STORAGE,
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

/** The brightest directional light: direction toward it (xyz) and illuminance (w). */
function sunOf(world: World, out: Float32Array): boolean {
  const lights = world.tryResource(Lights)
  out[0] = 0
  out[1] = 1
  out[2] = 0
  out[3] = 0
  if (!lights) return false
  const d = lights.directionalData
  let best = -1
  for (let i = 0; i < lights.directionalCount; i++) {
    const o = 4 + i * 8
    const lum = 0.2126 * d[o + 4]! + 0.7152 * d[o + 5]! + 0.0722 * d[o + 6]!
    if (lum > best) {
      best = lum
      out[0] = d[o]!
      out[1] = d[o + 1]!
      out[2] = d[o + 2]!
      out[3] = lum
    }
  }
  return best >= 0
}

const scratchSun = new Float32Array(4)

function skyKey(sky: ProceduralSkyValue, sun: Float32Array): string {
  // Rebake when the sun moves by more than ~0.25° or its illuminance changes by more than 1%.
  const q = (v: number) => Math.round(v * 229)
  const lux = sun[3]! > 0 ? Math.round(Math.log(sun[3]!) / Math.log(1.01)) : -1
  const g = sky.groundAlbedo
  return `sky:${q(sun[0]!)},${q(sun[1]!)},${q(sun[2]!)},${lux}|${sky.turbidity}|${sky.rayleigh}|${sky.mie}|${g[0]},${g[1]},${g[2]}`
}

/**
 * Resolves each camera's environment (its own map or sky, else the default environment) and
 * queues prefiltering for environments whose source changed.
 */
export const prepareEnvironments = defineSystem({
  name: 'render/prepare-environments',
  description: 'Picks each camera environment and queues GPU prefiltering when sources change.',
  run: (_, world) => {
    const store = world.resource(Environments)
    const gpu = world.resource(Gpu)
    store.ensure(gpu)
    store.frame++
    store.cameras.clear()
    const defaults = world.resource(DefaultEnvironment)
    const textures = world.tryResource(Textures)
    const assets = world.resource(GpuAssetsResource)
    sunOf(world, scratchSun)
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      const e = cam.entity
      const own = world.isAlive(e)
      const map = own && world.has(e, EnvironmentMap) ? world.get(e, EnvironmentMap) : undefined
      const sky = own && world.has(e, ProceduralSky) ? world.get(e, ProceduralSky) : undefined
      const skybox = own && world.has(e, Skybox) ? world.get(e, Skybox).brightness : -1
      let entry: CameraEnvironment = {
        environment: undefined,
        intensity: 0,
        rotation: 0,
        background: -1,
        sky: false,
      }
      const useMap = (value: EnvironmentMapValue, background: number) => {
        const texture = textures?.get(value.texture as never)
        if (!texture) return
        const key = `map:${idOf(texture)}:${texture.version}`
        let env = store.environments.get(key)
        if (!env) {
          // A new texture version replaces the old environment of the same texture.
          for (const [k, old] of store.environments) {
            if (old.input === texture) {
              old.destroy()
              store.environments.delete(k)
            }
          }
          env = new Environment(gpu, 'map')
          env.key = key
          env.input = texture
          store.environments.set(key, env)
          store.pending.push(env)
        }
        env.lastUsed = store.frame
        // Make sure the texture is on the GPU (it's the prefilter input).
        assets.texture(texture)
        entry = {
          environment: env,
          intensity: value.intensity,
          rotation: (value.rotation * Math.PI) / 180,
          background,
          sky: false,
        }
      }
      const useSky = (value: Partial<ProceduralSkyValue>, background: number) => {
        const full = { ...SKY_DEFAULTS, ...value } as ProceduralSkyValue
        const key = skyKey(full, scratchSun)
        // One sky environment per camera config; rebake in place when the key changes.
        const id = `sky@${own && sky ? e : 'default'}`
        let env = store.environments.get(id)
        if (!env) {
          env = new Environment(gpu, 'sky')
          store.environments.set(id, env)
        }
        env.sky = full
        env.sun.set(scratchSun)
        if (env.key !== key) {
          env.key = key
          env.state = 'pending'
          if (!store.pending.includes(env)) store.pending.push(env)
        }
        env.lastUsed = store.frame
        entry = { environment: env, intensity: 1, rotation: 0, background, sky: true }
      }
      if (map?.texture) useMap(map as EnvironmentMapValue, skybox)
      else if (sky) useSky(sky, 1)
      else if (defaults.map?.texture)
        useMap(defaults.map, defaults.background ? Math.max(skybox, 1) : skybox)
      else if (defaults.sky) useSky(defaults.sky, defaults.background ? 1 : -1)
      store.cameras.set(e, entry)
      view.data.environment = entry
    }
    // Environments nobody used for a while are released.
    for (const [key, env] of store.environments) {
      if (store.frame - env.lastUsed > 120) {
        env.destroy()
        store.environments.delete(key)
      }
    }
  },
})

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (id === undefined) {
    id = nextId++
    ids.set(o, id)
  }
  return id
}

/** Per-view environment parameters for the view uniform: intensity, cos/sin rotation, mode. */
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

// --- GPU prefiltering ------------------------------------------------------------

interface Pipelines {
  layouts: Record<string, GPUBindGroupLayout>
  pipelines: Record<string, GPUComputePipeline>
}

function storage2dArray(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' },
  }
}

/** Compiles (or returns undefined while compiling) the prefilter compute pipelines. */
function environmentPipelines(gpu: GpuContext, world: World): Pipelines | undefined {
  const shaders = world.resource(Shaders)
  const C = GPUShaderStage.COMPUTE
  const layouts: Record<string, GPUBindGroupLayout> = {
    equirect: gpu.layouts.bindGroupLayout({
      label: 'env/equirect',
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float' } },
        { binding: 1, visibility: C, sampler: { type: 'filtering' } },
        storage2dArray(2),
      ],
    }),
    cube: gpu.layouts.bindGroupLayout({
      label: 'env/cube',
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 1, visibility: C, sampler: { type: 'filtering' } },
        storage2dArray(2),
      ],
    }),
    sky: gpu.layouts.bindGroupLayout({
      label: 'env/sky',
      entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } }, storage2dArray(1)],
    }),
    downsample: gpu.layouts.bindGroupLayout({
      label: 'env/downsample',
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        storage2dArray(1),
      ],
    }),
    sh: gpu.layouts.bindGroupLayout({
      label: 'env/sh',
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
      ],
    }),
    specular: gpu.layouts.bindGroupLayout({
      label: 'env/specular',
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 1, visibility: C, sampler: { type: 'filtering' } },
        storage2dArray(2),
        { binding: 3, visibility: C, buffer: { type: 'uniform' } },
      ],
    }),
    lut: gpu.layouts.bindGroupLayout({
      label: 'env/lut',
      entries: [
        {
          binding: 0,
          visibility: C,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
      ],
    }),
  }
  const pipelines: Record<string, GPUComputePipeline> = {}
  const modules: Record<string, string> = {
    equirect: 'shard::env::from_equirect',
    cube: 'shard::env::from_cube',
    sky: 'shard::env::sky',
    downsample: 'shard::env::downsample',
    sh: 'shard::env::sh',
    specular: 'shard::env::specular',
    lut: 'shard::env::brdf_lut',
  }
  let missing = false
  for (const [name, root] of Object.entries(modules)) {
    const module = shaders.module(gpu, { root })
    if (!module) {
      missing = true
      continue
    }
    const p = gpu.pipelines.compute({
      label: `env/${name}`,
      layout: gpu.layouts.pipelineLayout({
        label: `env/${name}`,
        bindGroupLayouts: [layouts[name]!],
      }),
      compute: { module, entryPoint: 'main' },
    })
    if (!p) missing = true
    else pipelines[name] = p
  }
  return missing ? undefined : { layouts, pipelines }
}

/** Sky uniform: sun (xyz toward the sun, illuminance w), params, ground albedo. */
const skyData = new Float32Array(16)
const specData = new Float32Array(4)

function packSky(env: Environment, out: Float32Array): Float32Array {
  const s = env.sky ?? SKY_DEFAULTS
  out[0] = env.sun[0]!
  out[1] = env.sun[1]!
  out[2] = env.sun[2]!
  out[3] = env.sun[3]!
  out[4] = s.turbidity
  out[5] = s.rayleigh
  out[6] = s.mie
  out[7] = s.sunDiskSize
  out[8] = s.groundAlbedo[0]
  out[9] = s.groundAlbedo[1]
  out[10] = s.groundAlbedo[2]
  out[11] = 0
  return out
}

/**
 * Prefilters every pending environment (and the BRDF LUT, once): source cube, mips, SH9, and
 * GGX specular mips. Runs once per frame, before any view draws.
 */
export function runEnvironmentWork(ctx: NodeContext): void {
  const world = ctx.world
  const gpu = ctx.gpu
  const store = world.resource(Environments)
  if (store.ranFrame === store.frame) return
  if (store.pending.length === 0 && store.lutReady) {
    store.ranFrame = store.frame
    return
  }
  const p = environmentPipelines(gpu, world)
  if (!p) {
    gpu.pipelines.skipped++
    return
  }
  store.ranFrame = store.frame
  const device = gpu.device
  const pass = ctx.encoder.beginComputePass({
    label: 'environment/prefilter',
    timestampWrites: ctx.timestamps('environment/prefilter'),
  })
  if (!store.lutReady) {
    pass.setPipeline(p.pipelines.lut!)
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: p.layouts.lut!,
        entries: [{ binding: 0, resource: store.lut!.createView() }],
      }),
    )
    pass.dispatchWorkgroups(LUT_SIZE / 8, LUT_SIZE / 8)
    store.lutReady = true
  }
  const assets = world.resource(GpuAssetsResource)
  const sampler = store.sampler!
  // Equirect images wrap horizontally.
  const wrapU = gpu.layouts.sampler({
    label: 'environment/equirect',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
  })
  const done: Environment[] = []
  for (const env of store.pending) {
    const size = env.size
    const level0 = env.source.createView({
      dimension: '2d-array',
      baseMipLevel: 0,
      mipLevelCount: 1,
    })
    if (env.kind === 'map') {
      const input = env.input && assets.texture(env.input)
      if (!input) continue // the texture isn't uploaded yet (loading, or reloading)
      const cube = env.input!.faces === 6
      pass.setPipeline(cube ? p.pipelines.cube! : p.pipelines.equirect!)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: cube ? p.layouts.cube! : p.layouts.equirect!,
          entries: [
            { binding: 0, resource: input.linear },
            { binding: 1, resource: cube ? sampler : wrapU },
            { binding: 2, resource: level0 },
          ],
        }),
      )
    } else {
      const buffer = new GpuBuffer(gpu, {
        label: 'env/sky-params',
        usage: GPUBufferUsage.UNIFORM,
        size: 64,
      })
      buffer.write(packSky(env, skyData))
      ctx.afterSubmit(() => buffer.destroy())
      pass.setPipeline(p.pipelines.sky!)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: p.layouts.sky!,
          entries: [
            { binding: 0, resource: { buffer: buffer.buffer } },
            { binding: 1, resource: level0 },
          ],
        }),
      )
      env.sunLuminance = sunDiskLuminance(env)
    }
    pass.dispatchWorkgroups(size / 8, size / 8, 6)
    // Mips: box downsample, level by level.
    const mips = Math.log2(size) + 1
    pass.setPipeline(p.pipelines.downsample!)
    for (let m = 1; m < mips; m++) {
      const dim = Math.max(1, size >> m)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: p.layouts.downsample!,
          entries: [
            {
              binding: 0,
              resource: env.source.createView({
                dimension: '2d-array',
                baseMipLevel: m - 1,
                mipLevelCount: 1,
              }),
            },
            {
              binding: 1,
              resource: env.source.createView({
                dimension: '2d-array',
                baseMipLevel: m,
                mipLevelCount: 1,
              }),
            },
          ],
        }),
      )
      pass.dispatchWorkgroups(Math.ceil(dim / 8), Math.ceil(dim / 8), 6)
    }
    // SH9 irradiance from the 32² level.
    const shLevel = Math.max(0, Math.log2(size) - 5)
    pass.setPipeline(p.pipelines.sh!)
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: p.layouts.sh!,
        entries: [
          {
            binding: 0,
            resource: env.source.createView({
              dimension: '2d-array',
              baseMipLevel: shLevel,
              mipLevelCount: 1,
            }),
          },
          { binding: 1, resource: { buffer: env.sh.buffer } },
        ],
      }),
    )
    pass.dispatchWorkgroups(1)
    // Specular: one roughness per mip.
    pass.setPipeline(p.pipelines.specular!)
    for (let m = 0; m < SPECULAR_MIPS; m++) {
      const dim = SPECULAR_SIZE >> m
      const params = new GpuBuffer(gpu, {
        label: 'env/specular-params',
        usage: GPUBufferUsage.UNIFORM,
        size: 16,
      })
      specData[0] = m / (SPECULAR_MIPS - 1)
      specData[1] = size
      specData[2] = dim
      specData[3] = 0
      params.write(specData)
      ctx.afterSubmit(() => params.destroy())
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: p.layouts.specular!,
          entries: [
            { binding: 0, resource: env.sourceView },
            { binding: 1, resource: sampler },
            {
              binding: 2,
              resource: env.specular.createView({
                dimension: '2d-array',
                baseMipLevel: m,
                mipLevelCount: 1,
              }),
            },
            { binding: 3, resource: { buffer: params.buffer } },
          ],
        }),
      )
      pass.dispatchWorkgroups(Math.ceil(dim / 8), Math.ceil(dim / 8), 6)
    }
    env.state = 'ready'
    env.bakes++
    done.push(env)
  }
  pass.end()
  for (const env of done) store.pending.splice(store.pending.indexOf(env), 1)
}

/** The sun disk's luminance (cd/m²) before atmospheric extinction: E / solid angle. */
export function sunDiskLuminance(env: Environment): number {
  const size = env.sky?.sunDiskSize ?? 1
  const radius = ((0.2667 * Math.PI) / 180) * Math.max(size, 1e-3)
  return env.sun[3]! / (Math.PI * radius * radius)
}

/** The environment section of `render.describe`. */
export function describeEnvironment(world: World) {
  const store = world.tryResource(Environments)
  if (!store) return undefined
  const views: Record<string, unknown> = {}
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    if (!cam) continue
    const entry = store.cameras.get(cam.entity)
    const env = entry?.environment
    views[view.name] = {
      tonemapping: ['aces', 'agx', 'pbr-neutral', 'reinhard', 'none'][cam.curve],
      environment: env
        ? {
            source: env.kind === 'sky' ? 'procedural-sky' : 'environment-map',
            intensity: entry!.intensity,
            rotation: (entry!.rotation * 180) / Math.PI,
            prefilter: env.state,
            bakes: env.bakes,
            background: entry!.background >= 0,
            ...(env.kind === 'sky'
              ? {
                  sky: env.sky,
                  sunDirection: [env.sun[0], env.sun[1], env.sun[2]],
                  sunIlluminance: env.sun[3],
                  sunDiskLuminance: env.sunLuminance,
                }
              : {}),
          }
        : { source: 'ambient-light' },
    }
  }
  return { views, prefilteredEnvironments: store.environments.size }
}
