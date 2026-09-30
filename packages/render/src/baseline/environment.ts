import type { World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { fragmentKernel } from '@aethervtt/shard-shader'
import { ENVIRONMENT_SHADERS } from '../environment-shaders'
import type { Environment, EnvironmentStore } from '../environment-state'
import { LUT_SIZE, SPECULAR_MIPS, SPECULAR_SIZE } from '../environment-state'
import { GpuAssetsResource } from '../gpu-assets'
import type { NodeContext } from '../graph'
import { Shaders } from '../plugin'

// Baseline tier (0064), loaded only on a baseline device: image-based lighting prefiltered by
// fragment passes into the same textures, one face of one mip a pass. The full tier's image
// kernels (source faces, specular, BRDF LUT) run as they are, in fragment form (shader's
// fragmentKernel). Two read the cube as a 2D array, which baseline can't bind; these read it as
// the cube it is:
//
// - mips: one bilinear sample at the centre of each 2×2 block of the level above (their average);
// - SH9: a 9×1 target, one coefficient a fragment, summed over the 32² level, then copied into the
//   environment's `@data(uniform)` SH buffer.

/** Bytes a draw's target slot takes: the dynamic-offset alignment. */
const SLOT = 256

const fragment = (root: string) => fragmentKernel(ENVIRONMENT_SHADERS[root]!, 'main', root).source

export const BASELINE_ENVIRONMENT_SHADERS: Record<string, string> = {
  'shard::env::from_equirect::fragment': fragment('shard::env::from_equirect'),
  'shard::env::from_cube::fragment': fragment('shard::env::from_cube'),
  'shard::env::specular::fragment': fragment('shard::env::specular'),
  'shard::env::brdf_lut::fragment': fragment('shard::env::brdf_lut'),

  'shard::env::baseline::downsample': `
import shard::env::common::cube_dir;

/** The face's size and the face (as fragment kernels read their target). */
@group(0) @binding(0) var<uniform> shard_target: vec4u;
/** The level above, alone. */
@group(0) @binding(1) var src: texture_cube<f32>;
@group(0) @binding(2) var src_sampler: sampler;

@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  // The centre of this texel is the corner its 2×2 block shares: bilinear weighs them equally.
  let uv = (floor(p.xy) + 0.5) / f32(shard_target.x);
  let c = textureSampleLevel(src, src_sampler, cube_dir(shard_target.w, uv), 0.0);
  return vec4f(c.rgb, 1.0);
}`,

  'shard::env::baseline::sh': `
import shard::env::common::{ PI, cube_dir, sh_basis };

/** The level's size. */
@group(0) @binding(0) var<uniform> shard_target: vec4u;
/** The 32² level (or the smallest there is), alone. */
@group(0) @binding(1) var src: texture_cube<f32>;
@group(0) @binding(2) var src_sampler: sampler;

/** Coefficient k (the fragment's x) of the SH9 irradiance, as the compute kernel writes it. */
@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let k = u32(p.x);
  let n = shard_target.x;
  var c = vec3f(0.0);
  var total = 0.0;
  for (var face = 0u; face < 6u; face++) {
    for (var y = 0u; y < n; y++) {
      for (var x = 0u; x < n; x++) {
        let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(n);
        let st = uv * 2.0 - 1.0;
        // Solid angle of the texel.
        let w = 4.0 / (f32(n * n) * pow(1.0 + dot(st, st), 1.5));
        let d = cube_dir(face, uv);
        let radiance = textureSampleLevel(src, src_sampler, d, 0.0).rgb;
        c += radiance * sh_basis(d)[k] * w;
        total += w;
      }
    }
  }
  // Normalize the solid angles to exactly 4π, then apply the cosine lobe (Â_l / π).
  let band = array<f32, 9>(1.0, 2.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0, 0.25, 0.25, 0.25, 0.25, 0.25);
  return vec4f(c * (4.0 * PI / total) * band[k], 0.0);
}`,
}

/**
 * A pass that fills one face of an atmosphere environment's source (level 0) on baseline, or false
 * when its inputs aren't ready. The atmosphere plugin registers `atmosphere`.
 */
export type BaselineEnvironmentBaker = (
  ctx: NodeContext,
  env: Environment,
  face: number,
  target: GPUTextureView,
) => boolean

export const baselineBakers = new Map<Environment['kind'], BaselineEnvironmentBaker>()

type Kernel = 'equirect' | 'cube' | 'downsample' | 'sh' | 'specular' | 'lut'

const ROOTS: Record<Kernel, string> = {
  equirect: 'shard::env::from_equirect::fragment',
  cube: 'shard::env::from_cube::fragment',
  downsample: 'shard::env::baseline::downsample',
  sh: 'shard::env::baseline::sh',
  specular: 'shard::env::specular::fragment',
  lut: 'shard::env::brdf_lut::fragment',
}

interface Kernels {
  generation: number
  layouts: Record<Kernel, GPUBindGroupLayout>
  pipelines: Partial<Record<Kernel, GPURenderPipeline>>
  shTarget: GPUTexture
}

const kernels = new WeakMap<GpuContext, Kernels>()

/** The full tier's layouts with each kernel's storage output as its target uniform. */
function kernelsOf(gpu: GpuContext): Kernels {
  let k = kernels.get(gpu)
  if (k && k.generation === gpu.generation) return k
  const F = GPUShaderStage.FRAGMENT
  const target = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: F,
    buffer: { type: 'uniform', hasDynamicOffset: true },
  })
  const cube = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: F,
    texture: { sampleType: 'float', viewDimension: 'cube' },
  })
  const sampler = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: F,
    sampler: { type: 'filtering' },
  })
  const layout = (label: string, entries: GPUBindGroupLayoutEntry[]) =>
    gpu.layouts.bindGroupLayout({ label: `env/baseline/${label}`, entries })
  k = {
    generation: gpu.generation,
    layouts: {
      equirect: layout('equirect', [
        { binding: 0, visibility: F, texture: { sampleType: 'float' } },
        sampler(1),
        target(2),
      ]),
      cube: layout('cube', [cube(0), sampler(1), target(2)]),
      downsample: layout('downsample', [target(0), cube(1), sampler(2)]),
      sh: layout('sh', [target(0), cube(1), sampler(2)]),
      specular: layout('specular', [
        cube(0),
        sampler(1),
        target(2),
        { binding: 3, visibility: F, buffer: { type: 'uniform' } },
      ]),
      lut: layout('lut', [target(0)]),
    },
    pipelines: {},
    shTarget: gpu.withOwner('gpu', () =>
      gpu.device.createTexture({
        label: 'environment/sh-target',
        size: [9, 1],
        format: 'rgba32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      }),
    ),
  }
  kernels.set(gpu, k)
  return k
}

function pipeline(
  world: World,
  gpu: GpuContext,
  k: Kernels,
  name: Kernel,
): GPURenderPipeline | undefined {
  const cached = k.pipelines[name]
  if (cached) return cached
  const shaders = world.resource(Shaders)
  const fs = shaders.module(gpu, { root: ROOTS[name] })
  const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
  if (!fs || !vs) return undefined
  const made = gpu.pipelines.render({
    label: `env/baseline/${name}`,
    layout: gpu.layouts.pipelineLayout({
      label: `env/baseline/${name}`,
      bindGroupLayouts: [k.layouts[name]],
    }),
    vertex: { module: vs, entryPoint: 'vs' },
    fragment: {
      module: fs,
      entryPoint: 'main',
      targets: [{ format: name === 'sh' ? 'rgba32float' : 'rgba16float' }],
    },
  })
  if (made) k.pipelines[name] = made
  return made
}

/** One face of one mip as a render target. */
function faceView(texture: GPUTexture, face: number, mip: number): GPUTextureView {
  return texture.createView({
    dimension: '2d',
    baseArrayLayer: face,
    arrayLayerCount: 1,
    baseMipLevel: mip,
    mipLevelCount: 1,
  })
}

/** A bake's target slots (width, height, depth, layer), 256 bytes apart for dynamic offsets. */
class Targets {
  readonly data: Uint32Array
  count = 0
  constructor(slots: number) {
    this.data = new Uint32Array((slots * SLOT) / 4)
  }
  /** Adds a slot for a `size`² face (or a width × 1 row); returns its byte offset. */
  add(width: number, layer: number, height = width): number {
    const o = (this.count * SLOT) / 4
    this.data[o] = width
    this.data[o + 1] = height
    this.data[o + 2] = 1
    this.data[o + 3] = layer
    return this.count++ * SLOT
  }
}

interface Draw {
  label: string
  view: GPUTextureView
  kernel: Kernel
  group: GPUBindGroup
  offset: number
}

function encode(ctx: NodeContext, k: Kernels, draws: Draw[]): void {
  for (const d of draws) {
    const pass = ctx.encoder.beginRenderPass({
      label: d.label,
      colorAttachments: [
        { view: d.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    })
    pass.setPipeline(pipeline(ctx.world, ctx.gpu, k, d.kernel)!)
    pass.setBindGroup(0, d.group, [d.offset])
    pass.draw(3)
    pass.end()
  }
  draws.length = 0
}

/**
 * Prefilters every pending environment (and the BRDF LUT, once) with fragment passes. Runs once
 * per frame, before any view draws; an environment whose input isn't ready stays pending.
 */
export function runBaselineEnvironment(ctx: NodeContext, store: EnvironmentStore): void {
  const world = ctx.world
  const gpu = ctx.gpu
  if (store.pending.length === 0 && store.lutReady) {
    store.ranFrame = store.frame
    return
  }
  const k = kernelsOf(gpu)
  let missing = false
  for (const name of Object.keys(ROOTS) as Kernel[])
    if (!pipeline(world, gpu, k, name)) missing = true
  if (missing) {
    gpu.pipelines.skipped++
    return
  }
  store.ranFrame = store.frame
  const device = gpu.device
  const assets = world.resource(GpuAssetsResource)
  const sampler = store.sampler!
  const wrapU = gpu.layouts.sampler({
    label: 'environment/equirect',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
  })
  // Slots: the LUT, and per environment 6 source faces, 6 a mip, the SH, 6 a specular mip.
  const targets = new Targets(1 + store.pending.length * (6 + 6 * 10 + 1 + 6 * SPECULAR_MIPS))
  const params = new GpuBuffer(gpu, {
    label: 'env/baseline/targets',
    usage: GPUBufferUsage.UNIFORM,
    size: targets.data.byteLength,
  })
  // Specular roughness per mip, 256 bytes apart: roughness, source size, size.
  const specularData = new Float32Array((SPECULAR_MIPS * SLOT) / 4)
  const specularParams = new GpuBuffer(gpu, {
    label: 'env/baseline/specular',
    usage: GPUBufferUsage.UNIFORM,
    size: specularData.byteLength,
  })
  ctx.afterSubmit(() => {
    params.destroy()
    specularParams.destroy()
  })
  const target = { buffer: params.buffer, size: 16 }
  const draws: Draw[] = []
  if (!store.lutReady) {
    draws.push({
      label: 'environment/brdf-lut',
      view: store.lut!.createView(),
      kernel: 'lut',
      group: device.createBindGroup({
        layout: k.layouts.lut,
        entries: [{ binding: 0, resource: target }],
      }),
      offset: targets.add(LUT_SIZE, 0),
    })
    store.lutReady = true
  }
  const done: Environment[] = []
  for (const env of store.pending) {
    const size = env.size
    if (env.kind === 'map') {
      const input = env.input && assets.texture(env.input)
      if (!input) continue // the texture isn't uploaded yet (loading, or reloading)
      const cube = env.input!.faces === 6
      const group = device.createBindGroup({
        layout: cube ? k.layouts.cube : k.layouts.equirect,
        entries: [
          { binding: 0, resource: input.linear },
          { binding: 1, resource: cube ? sampler : wrapU },
          { binding: 2, resource: target },
        ],
      })
      for (let face = 0; face < 6; face++) {
        draws.push({
          label: 'environment/source',
          view: faceView(env.source, face, 0),
          kernel: cube ? 'cube' : 'equirect',
          group,
          offset: targets.add(size, face),
        })
      }
    } else {
      const bake = baselineBakers.get(env.kind)
      if (!bake) continue
      // The baker encodes its own passes: ours so far go first.
      encode(ctx, k, draws)
      let ready = true
      for (let face = 0; face < 6 && ready; face++) {
        ready = bake(ctx, env, face, faceView(env.source, face, 0))
      }
      if (!ready) continue
    }
    // Mips: each level from the one above, read as a one-level cube.
    const mips = Math.log2(size) + 1
    for (let m = 1; m < mips; m++) {
      const group = device.createBindGroup({
        layout: k.layouts.downsample,
        entries: [
          { binding: 0, resource: target },
          {
            binding: 1,
            resource: env.source.createView({
              dimension: 'cube',
              baseMipLevel: m - 1,
              mipLevelCount: 1,
            }),
          },
          { binding: 2, resource: sampler },
        ],
      })
      for (let face = 0; face < 6; face++) {
        draws.push({
          label: 'environment/mip',
          view: faceView(env.source, face, m),
          kernel: 'downsample',
          group,
          offset: targets.add(Math.max(1, size >> m), face),
        })
      }
    }
    // SH9 irradiance from the 32² level, into the environment's SH uniform buffer.
    const shLevel = Math.max(0, Math.log2(size) - 5)
    draws.push({
      label: 'environment/sh',
      view: k.shTarget.createView(),
      kernel: 'sh',
      group: device.createBindGroup({
        layout: k.layouts.sh,
        entries: [
          { binding: 0, resource: target },
          {
            binding: 1,
            resource: env.source.createView({
              dimension: 'cube',
              baseMipLevel: shLevel,
              mipLevelCount: 1,
            }),
          },
          { binding: 2, resource: sampler },
        ],
      }),
      offset: targets.add(Math.max(1, size >> shLevel), 0),
    })
    // Specular: one roughness per mip.
    for (let m = 0; m < SPECULAR_MIPS; m++) {
      const o = (m * SLOT) / 4
      specularData[o] = m / (SPECULAR_MIPS - 1)
      specularData[o + 1] = size
      specularData[o + 2] = SPECULAR_SIZE >> m
      const group = device.createBindGroup({
        layout: k.layouts.specular,
        entries: [
          { binding: 0, resource: env.sourceView },
          { binding: 1, resource: sampler },
          { binding: 2, resource: target },
          { binding: 3, resource: { buffer: specularParams.buffer, offset: m * SLOT, size: 16 } },
        ],
      })
      for (let face = 0; face < 6; face++) {
        draws.push({
          label: 'environment/specular',
          view: faceView(env.specular, face, m),
          kernel: 'specular',
          group,
          offset: targets.add(SPECULAR_SIZE >> m, face),
        })
      }
    }
    // The SH copy follows its pass; the next environment reuses the SH target.
    encode(ctx, k, draws)
    ctx.encoder.copyTextureToBuffer({ texture: k.shTarget }, { buffer: env.sh.gpuBuffer }, [9, 1])
    env.state = 'ready'
    env.bakes++
    done.push(env)
  }
  encode(ctx, k, draws)
  params.write(targets.data, 0, 0, (targets.count * SLOT) / 4)
  specularParams.write(specularData)
  for (const env of done) store.pending.splice(store.pending.indexOf(env), 1)
}
