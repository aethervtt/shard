import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { fragmentKernel } from '@aethervtt/shard-shader'
import { MULTISCATTER_SIZE, TRANSMITTANCE_H, TRANSMITTANCE_W } from '../atmosphere-model'
import {
  type AtmosphereGpu,
  AtmosphereGpuResource,
  LUT_LAYERS,
  packParams,
} from '../atmosphere-nodes'
import { ATMOSPHERE_SHADERS } from '../atmosphere-shaders'
import type { CameraAtmosphere } from '../atmosphere-state'
import type { Environment } from '../environment-state'
import type { NodeContext } from '../graph'
import { Shaders } from '../plugin'
import { baselineBakers } from './environment'

// Baseline tier (0064), loaded only on a baseline device: atmosphere scattering's compute passes as
// fragment passes into the same textures. The transmittance and multiple-scattering LUTs, the
// sky-view LUT and the environment bake are image kernels, run in fragment form (fragmentKernel)
// one LUT layer or cube face a pass. Aerial perspective accumulates along each froxel column; its
// fragment form renders one slice a pass (both 3D textures at once) and marches the column from the
// camera to that slice: the compute kernel's steps, in its order.

/** Bytes between target slots: the dynamic-offset alignment. */
const SLOT = 256

const fragment = (root: string) => fragmentKernel(ATMOSPHERE_SHADERS[root]!, 'main', root).source

export const BASELINE_ATMOSPHERE_SHADERS: Record<string, string> = {
  'shard::atmosphere::transmittance_lut::fragment': fragment(
    'shard::atmosphere::transmittance_lut',
  ),
  'shard::atmosphere::multiscatter_lut::fragment': fragment('shard::atmosphere::multiscatter_lut'),
  'shard::atmosphere::sky_view::fragment': fragment('shard::atmosphere::sky_view'),
  'shard::atmosphere::bake::fragment': fragment('shard::atmosphere::bake'),
  'shard::atmosphere::baseline::aerial': `
import shard::atmosphere::{ AtmosphereView, KCD, integrate, froxel_distance, ray_at };

@group(0) @binding(0) var<uniform> atmo: AtmosphereView;
@group(0) @binding(1) var tlut: texture_2d_array<f32>;
@group(0) @binding(2) var mlut: texture_2d_array<f32>;
@group(0) @binding(3) var lut_sampler: sampler;
/** The froxel grid's size, and the slice this pass renders. */
@group(0) @binding(4) var<uniform> shard_target: vec4u;

struct Froxel {
  @location(0) scatter: vec4f,
  @location(1) transmittance: vec4f,
}

/**
 * One slice of the aerial-perspective froxels: in-scattering (kcd/m²) and transmittance from the
 * camera to the slice's far end, along the froxel column's ray.
 */
@fragment fn main(@builtin(position) p: vec4f) -> Froxel {
  let size = shard_target.xyz;
  let a = atmo.atmospheres[u32(atmo.info.y)];
  let uv = (floor(p.xy) + 0.5) / vec2f(size.xy);
  let d = ray_at(atmo, uv);
  let o = a.origin.xyz;
  var L = vec3f(0.0);
  var T = vec3f(1.0);
  var t_prev = 0.0;
  for (var k = 0u; k <= shard_target.w; k++) {
    let t = froxel_distance(atmo.froxels, (f32(k) + 1.0) / f32(size.z));
    // Two steps per slice, from where the last one ended.
    let seg = integrate(tlut, mlut, lut_sampler, a, atmo.suns[0], atmo.suns[1], u32(atmo.info.z), o + d * t_prev, d, t - t_prev, 2u, false);
    L += T * seg.luminance;
    T *= seg.transmittance;
    t_prev = t;
  }
  var out: Froxel;
  out.scatter = vec4f(L / KCD, 1.0);
  out.transmittance = vec4f(T, 1.0);
  return out;
}`,
}

type Kernel = 'transmittance' | 'multiscatter' | 'skyView' | 'aerial' | 'bake'

const ROOTS: Record<Kernel, string> = {
  transmittance: 'shard::atmosphere::transmittance_lut::fragment',
  multiscatter: 'shard::atmosphere::multiscatter_lut::fragment',
  skyView: 'shard::atmosphere::sky_view::fragment',
  aerial: 'shard::atmosphere::baseline::aerial',
  bake: 'shard::atmosphere::bake::fragment',
}

interface Kernels {
  generation: number
  layouts: Record<Kernel, GPUBindGroupLayout>
  pipelines: Partial<Record<Kernel, GPURenderPipeline>>
}

const kernels = new WeakMap<GpuContext, Kernels>()

function kernelsOf(gpu: GpuContext): Kernels {
  let k = kernels.get(gpu)
  if (k && k.generation === gpu.generation) return k
  const F = GPUShaderStage.FRAGMENT
  const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: F,
    buffer: { type: 'uniform' },
  })
  const target = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: F,
    buffer: { type: 'uniform', hasDynamicOffset: true },
  })
  const array = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: F,
    texture: { sampleType: 'float', viewDimension: '2d-array' },
  })
  const sampler = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: F,
    sampler: { type: 'filtering' },
  })
  const layout = (label: string, entries: GPUBindGroupLayoutEntry[]) =>
    gpu.layouts.bindGroupLayout({ label: `atmosphere/baseline/${label}`, entries })
  const view = [uniform(0), array(1), array(2), sampler(3), target(4)]
  k = {
    generation: gpu.generation,
    layouts: {
      transmittance: layout('transmittance', [uniform(0), target(1)]),
      multiscatter: layout('multiscatter', [uniform(0), array(1), sampler(2), target(3)]),
      skyView: layout('sky-view', view),
      aerial: layout('aerial', view),
      bake: layout('bake', view),
    },
    pipelines: {},
  }
  kernels.set(gpu, k)
  return k
}

function pipeline(ctx: NodeContext, k: Kernels, name: Kernel): GPURenderPipeline | undefined {
  const cached = k.pipelines[name]
  if (cached) return cached
  const gpu = ctx.gpu
  const shaders = ctx.world.resource(Shaders)
  const fs = shaders.module(gpu, { root: ROOTS[name] })
  const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
  if (!fs || !vs) {
    gpu.pipelines.skipped++
    return undefined
  }
  const made = gpu.pipelines.render({
    label: `atmosphere/baseline/${name}`,
    layout: gpu.layouts.pipelineLayout({
      label: `atmosphere/baseline/${name}`,
      bindGroupLayouts: [k.layouts[name]],
    }),
    vertex: { module: vs, entryPoint: 'vs' },
    fragment: {
      module: fs,
      entryPoint: 'main',
      targets:
        name === 'aerial'
          ? [{ format: 'rgba16float' }, { format: 'rgba16float' }]
          : [{ format: 'rgba16float' }],
    },
  })
  if (made) k.pipelines[name] = made
  return made
}

/**
 * Target slots (width, height, depth, layer), SLOT bytes apart for dynamic offsets, uploaded once:
 * what a pass renders into doesn't change between frames, so views and environments keep theirs,
 * and all of a frame's passes read the values they were encoded with.
 */
function targetBuffer(
  gpu: GpuContext,
  label: string,
  slots: readonly (readonly number[])[],
): GpuBuffer {
  const data = new Uint32Array((Math.max(1, slots.length) * SLOT) / 4)
  for (let i = 0; i < slots.length; i++) data.set(slots[i]!, (i * SLOT) / 4)
  const buffer = new GpuBuffer(gpu, { label, usage: GPUBufferUsage.UNIFORM, size: data.byteLength })
  buffer.write(data)
  return buffer
}

function draw(
  ctx: NodeContext,
  label: string,
  p: GPURenderPipeline,
  group: GPUBindGroup,
  offset: number,
  attachments: GPURenderPassColorAttachment[],
): void {
  const pass = ctx.encoder.beginRenderPass({ label, colorAttachments: attachments })
  pass.setPipeline(p)
  pass.setBindGroup(0, group, [offset])
  pass.draw(3)
  pass.end()
}

function color(view: GPUTextureView, depthSlice?: number): GPURenderPassColorAttachment {
  return { view, depthSlice, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }
}

const paramScratch = new Float32Array(32)

/** The transmittance and multiple-scattering LUTs of every layer whose atmosphere changed. */
export function runLuts(ctx: NodeContext, s: AtmosphereGpu): boolean {
  const k = kernelsOf(ctx.gpu)
  const t = pipeline(ctx, k, 'transmittance')
  const m = pipeline(ctx, k, 'multiscatter')
  if (!t || !m) return false
  const gpu = ctx.gpu
  // Rare (an atmosphere changed): a buffer for this frame's passes.
  const targets = targetBuffer(gpu, 'atmosphere/baseline/luts', [
    [TRANSMITTANCE_W, TRANSMITTANCE_H, 1, 0],
    [MULTISCATTER_SIZE, MULTISCATTER_SIZE, 1, 0],
  ])
  ctx.afterSubmit(() => targets.destroy())
  const target = { buffer: targets.buffer, size: 16 }
  for (let i = 0; i < LUT_LAYERS; i++) {
    const rec = s.owners[i]
    if (!rec || rec.layerVersion === rec.version) continue
    packParams(rec, paramScratch, 0, undefined, 0)
    s.params[i]!.write(paramScratch)
    const layer = (texture: GPUTexture) =>
      texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 })
    const params = { buffer: s.params[i]!.buffer }
    draw(
      ctx,
      'atmosphere/transmittance',
      t,
      gpu.device.createBindGroup({
        layout: k.layouts.transmittance,
        entries: [
          { binding: 0, resource: params },
          { binding: 1, resource: target },
        ],
      }),
      0,
      [color(layer(s.transmittance))],
    )
    draw(
      ctx,
      'atmosphere/multiscatter',
      m,
      gpu.device.createBindGroup({
        layout: k.layouts.multiscatter,
        entries: [
          { binding: 0, resource: params },
          { binding: 1, resource: s.transmittanceArray },
          { binding: 2, resource: s.clamp },
          { binding: 3, resource: target },
        ],
      }),
      SLOT,
      [color(layer(s.multiscatter))],
    )
    rec.layerVersion = rec.version
    s.lutComputes++
  }
  return true
}

function viewGroup(
  gpu: GpuContext,
  layout: GPUBindGroupLayout,
  s: AtmosphereGpu,
  uniform: GPUBuffer,
  targets: GPUBuffer,
): GPUBindGroup {
  return gpu.device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: s.transmittanceArray },
      { binding: 2, resource: s.multiscatterArray },
      { binding: 3, resource: s.clamp },
      { binding: 4, resource: { buffer: targets, size: 16 } },
    ],
  })
}

/** What a camera's view passes bind: made again when its textures, uniform or device change. */
interface ViewPasses {
  uniform: number
  skyView: GPUTexture
  scatter: GPUTexture
  transmittance: GPUTexture
  luts: GPUTexture
  generation: number
  targets: GpuBuffer
  sky: GPUBindGroup
  aerial: GPUBindGroup
  skyViewView: GPUTextureView
  scatterView: GPUTextureView
  transmittanceView: GPUTextureView
}

const viewPasses = new WeakMap<object, ViewPasses>()

/** A camera's sky-view LUT and (with aerial perspective) its froxels, slice by slice. */
export function runView(
  ctx: NodeContext,
  s: AtmosphereGpu,
  ca: CameraAtmosphere,
  c: { uniform: GpuBuffer; skyView: GPUTexture; scatter: GPUTexture; transmittance: GPUTexture },
): boolean {
  const k = kernelsOf(ctx.gpu)
  const sky = pipeline(ctx, k, 'skyView')
  const aerial = pipeline(ctx, k, 'aerial')
  if (!sky || !aerial) return false
  const gpu = ctx.gpu
  const depth = c.scatter.depthOrArrayLayers
  let v = viewPasses.get(c)
  if (
    !v ||
    v.uniform !== c.uniform.version ||
    v.skyView !== c.skyView ||
    v.scatter !== c.scatter ||
    v.transmittance !== c.transmittance ||
    v.luts !== s.transmittance ||
    v.generation !== gpu.generation
  ) {
    v?.targets.destroy()
    const slots: number[][] = [[c.skyView.width, c.skyView.height, 1, 0]]
    for (let slice = 0; slice < depth; slice++) {
      slots.push([c.scatter.width, c.scatter.height, depth, slice])
    }
    const targets = targetBuffer(gpu, 'atmosphere/baseline/view', slots)
    v = {
      uniform: c.uniform.version,
      skyView: c.skyView,
      scatter: c.scatter,
      transmittance: c.transmittance,
      luts: s.transmittance,
      generation: gpu.generation,
      targets,
      sky: viewGroup(gpu, k.layouts.skyView, s, c.uniform.buffer, targets.buffer),
      aerial: viewGroup(gpu, k.layouts.aerial, s, c.uniform.buffer, targets.buffer),
      skyViewView: c.skyView.createView(),
      scatterView: c.scatter.createView(),
      transmittanceView: c.transmittance.createView(),
    }
    viewPasses.set(c, v)
  }
  draw(ctx, 'atmosphere/sky-view', sky, v.sky, 0, [color(v.skyViewView)])
  if (ca.aerialPerspective) {
    for (let slice = 0; slice < depth; slice++) {
      draw(ctx, 'atmosphere/aerial', aerial, v.aerial, (1 + slice) * SLOT, [
        color(v.scatterView, slice),
        color(v.transmittanceView, slice),
      ])
    }
  }
  return true
}

/** Six faces' targets per environment size, kept per device. */
const bakeTargets = new WeakMap<
  GpuContext,
  Map<number, { generation: number; buffer: GpuBuffer }>
>()

/** The primary's sky from the camera into one face of the environment's source (level 0). */
function bake(ctx: NodeContext, env: Environment, face: number, view: GPUTextureView): boolean {
  const ca = env.atmosphere
  const s = ctx.world.resource(AtmosphereGpuResource)
  const primary = ca?.primary
  if (!ca || !primary || primary.layerVersion !== primary.version) return false
  const c = s.cameras.get(ca.camera)
  if (!c?.packed) return false
  const k = kernelsOf(ctx.gpu)
  const p = pipeline(ctx, k, 'bake')
  if (!p) return false
  const gpu = ctx.gpu
  let sizes = bakeTargets.get(gpu)
  if (!sizes) {
    sizes = new Map()
    bakeTargets.set(gpu, sizes)
  }
  let targets = sizes.get(env.size)
  if (!targets || targets.generation !== gpu.generation) {
    const faces = [0, 1, 2, 3, 4, 5].map((f) => [env.size, env.size, 1, f])
    // Shared by every app on the device, as the pipelines are.
    const buffer = gpu.withOwner('gpu', () => targetBuffer(gpu, 'atmosphere/baseline/bake', faces))
    targets = { generation: gpu.generation, buffer }
    sizes.set(env.size, targets)
  }
  const group = viewGroup(gpu, k.layouts.bake, s, c.uniform.buffer, targets.buffer.buffer)
  draw(ctx, 'atmosphere/bake', p, group, face * SLOT, [color(view)])
  return true
}

/** Registers the environment baker: atmosphere environments bake by fragment passes too. */
export function installAtmosphereBaseline(): void {
  baselineBakers.set('atmosphere', bake)
}
