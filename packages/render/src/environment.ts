import {
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  t,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { Textures } from '@aethervtt/shard-texture'
import { Atmospheres, type CameraAtmosphere } from './atmosphere-state'
import {
  type CameraEnvironment,
  Environment,
  EnvironmentStore,
  Environments,
  environmentParams,
  LUT_SIZE,
  REBAKE_FRAMES,
  SKY_SIZE,
  SOURCE_SIZE,
  SPECULAR_MIPS,
  SPECULAR_SIZE,
} from './environment-state'
import { GpuAssetsResource } from './gpu-assets'
import type { NodeContext } from './graph'
import { Gpu, Shaders, Views } from './plugin'
import { cameraOf } from './view'

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
      description:
        "Sun disk size, as a multiple of the DirectionalLight's angularDiameter (the Sun's 0.53°). 0 hides the disk.",
    }),
  },
  {
    description:
      'An Earth sky seen from 10 m above the ground wherever the camera is: an Atmosphere (spec 0044) lit by the two brightest DirectionalLights, in cd/m² consistent with their illuminance. Drawn as the background, and baked into the environment so image-based lighting follows the time of day. For skies you can fly out of, put an Atmosphere on the planet instead.',
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
    hostWritable: true,
    description:
      'The environment (map or procedural sky) for cameras that have none. AmbientLight is the fallback when neither is set.',
    init: () => ({ map: null, sky: null, background: true }),
  },
)

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
    const atmospheres = world.tryResource(Atmospheres)
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      const e = cam.entity
      const own = world.isAlive(e)
      const map = own && world.has(e, EnvironmentMap) ? world.get(e, EnvironmentMap) : undefined
      const skybox = own && world.has(e, Skybox) ? world.get(e, Skybox).brightness : -1
      let entry: CameraEnvironment = {
        environment: undefined,
        intensity: 0,
        rotation: 0,
        background: -1,
        sky: false,
        backdrop: undefined,
      }
      const mapEnvironment = (value: EnvironmentMapValue): Environment | undefined => {
        const texture = textures?.get(value.texture as never)
        if (!texture) return undefined
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
        return env
      }
      const useMap = (value: EnvironmentMapValue, background: number) => {
        const env = mapEnvironment(value)
        if (!env) return
        entry = {
          environment: env,
          intensity: value.intensity,
          rotation: (value.rotation * Math.PI) / 180,
          background,
          sky: false,
          backdrop: undefined,
        }
      }
      const ca = atmospheres?.cameras.get(e)
      if (ca?.primary) {
        // Lit by the atmosphere it's in (or looking at): baked from the camera, rebaked as it moves.
        const id = `atmosphere@${e}`
        let env = store.environments.get(id)
        if (!env) {
          env = new Environment(gpu, 'atmosphere')
          store.environments.set(id, env)
        }
        env.atmosphere = ca
        // Flying rebakes as altitude and the local up change, at most every REBAKE_FRAMES (a bake
        // is ~1.5 ms of GPU); a new atmosphere or new settings rebake at once.
        const same =
          env.key.slice(0, env.key.indexOf('|')) === ca.bakeKey.slice(0, ca.bakeKey.indexOf('|'))
        if (env.key !== ca.bakeKey && (!same || store.frame - env.queuedFrame >= REBAKE_FRAMES)) {
          env.key = ca.bakeKey
          env.queuedFrame = store.frame
          env.state = 'pending'
          if (!store.pending.includes(env)) store.pending.push(env)
        }
        env.lastUsed = store.frame
        // Behind the sky: the camera's environment map with a Skybox, or the default map.
        let backdrop: CameraEnvironment['backdrop']
        const behind =
          map?.texture && skybox >= 0
            ? (map as EnvironmentMapValue)
            : !map?.texture && defaults.map?.texture && defaults.background
              ? defaults.map
              : undefined
        const backdropEnv = behind ? mapEnvironment(behind) : undefined
        if (behind && backdropEnv) {
          backdrop = {
            environment: backdropEnv,
            intensity: behind.intensity * (skybox >= 0 ? skybox : 1),
            rotation: (behind.rotation * Math.PI) / 180,
          }
        }
        entry = {
          environment: env,
          intensity: 1,
          rotation: 0,
          background: ca.background,
          sky: true,
          backdrop,
        }
      } else if (map?.texture) useMap(map as EnvironmentMapValue, skybox)
      else if (defaults.map?.texture)
        useMap(defaults.map, defaults.background ? Math.max(skybox, 1) : skybox)
      // A view clearing to alpha shows the page behind it: no sky or skybox, but still IBL (0052).
      if (cam.alphaOutput) entry.background = -1
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

const specData = new Float32Array(4)

/**
 * Fills level 0 of an environment's source cube (all six faces, `SKY_SIZE`²) for kinds other than
 * maps, in the prefilter pass. Returns false when it can't yet (its inputs aren't ready): the
 * environment stays pending. The atmosphere plugin registers `atmosphere`.
 */
export type EnvironmentBaker = (
  ctx: NodeContext,
  pass: GPUComputePassEncoder,
  env: Environment,
  level0: GPUTextureView,
) => boolean

export const environmentBakers = new Map<Environment['kind'], EnvironmentBaker>()

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
      pass.dispatchWorkgroups(size / 8, size / 8, 6)
    } else {
      const bake = environmentBakers.get(env.kind)
      if (!bake?.(ctx, pass, env, level0)) continue
    }
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

/** The sky a camera's atmosphere environment was baked from, and its sun disk, for describe. */
function atmosphereDescription(world: World, camera: Entity, ca: CameraAtmosphere) {
  const s = ca.suns
  if (s.count === 0) return { sunIlluminance: 0 }
  const lux = 0.2126 * s.data[4]! + 0.7152 * s.data[5]! + 0.0722 * s.data[6]!
  const radius = s.data[3]!
  const sky = world.isAlive(camera) ? world.tryGet(camera, ProceduralSky) : undefined
  return {
    ...(sky ? { sky } : {}),
    sunDirection: [s.data[0], s.data[1], s.data[2]],
    sunIlluminance: lux,
    // E / solid angle, before the atmosphere dims it.
    sunDiskLuminance: radius > 0 ? lux / (Math.PI * radius * radius) : 0,
  }
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
            source:
              env.kind === 'map'
                ? 'environment-map'
                : env.atmosphere?.primary?.wrapper
                  ? 'procedural-sky'
                  : 'atmosphere',
            intensity: entry!.intensity,
            rotation: (entry!.rotation * 180) / Math.PI,
            prefilter: env.state,
            bakes: env.bakes,
            background: entry!.background >= 0,
            ...(env.kind === 'atmosphere' && env.atmosphere
              ? atmosphereDescription(world, cam.entity, env.atmosphere)
              : {}),
          }
        : { source: 'ambient-light' },
    }
  }
  return { views, prefilteredEnvironments: store.environments.size }
}

export {
  type CameraEnvironment,
  Environment,
  EnvironmentStore,
  Environments,
  environmentParams,
  REBAKE_FRAMES,
  SKY_SIZE,
  SOURCE_SIZE,
  SPECULAR_MIPS,
  SPECULAR_SIZE,
}
