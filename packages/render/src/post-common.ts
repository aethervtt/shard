import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { ForwardStateResource, type ViewGpu } from './forward'
import type { NodeContext, RenderView } from './graph'
import { Shaders } from './plugin'
import { depthReadEntry } from './tier'
import { type CameraData, cameraOf } from './view'

// Plumbing shared by the display stage (tonemap, upscale) and the post effects.

const textureIds = new WeakMap<object, number>()
let nextId = 1
export function idOf(o: object): number {
  let id = textureIds.get(o)
  if (id === undefined) {
    id = nextId++
    textureIds.set(o, id)
  }
  return id
}

export const F = () => GPUShaderStage.FRAGMENT
export const tex = (binding: number, sampleType: GPUTextureSampleType = 'float') => ({
  binding,
  visibility: F(),
  texture: { sampleType },
})
/** Depth read without comparison, in the fragment stage (a float texture on baseline, 0064). */
export const depthTex = (gpu: GpuContext, binding: number) => depthReadEntry(gpu, binding, F())
export const uniform = (binding: number, visibility = F()) => ({
  binding,
  visibility,
  buffer: { type: 'uniform' as const },
})
export const sampler = (binding: number) => ({
  binding,
  visibility: F(),
  sampler: { type: 'filtering' as const },
})

/** Per-node caches: pipelines by key, bind groups by slot, uniform buffers by view. */
export class PostCache {
  private generation = -1
  private readonly pipelines = new Map<string, GPURenderPipeline | GPUComputePipeline>()
  private readonly groups = new Map<string, { key: string; group: GPUBindGroup }>()
  private readonly buffers = new Map<string, GpuBuffer>()
  private linear: GPUSampler | undefined

  check(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.generation = gpu.generation
    this.pipelines.clear()
    this.groups.clear()
    this.buffers.clear()
    this.linear = undefined
  }

  /** A fullscreen render pipeline: `shard::fullscreen` vertex stage and `root`'s `entry`. */
  render(
    ctx: NodeContext,
    key: string,
    root: string,
    entry: string,
    layouts: GPUBindGroupLayout[],
    targets: GPUColorTargetState[],
    defines?: Record<string, boolean>,
  ): GPURenderPipeline | undefined {
    const gpu = ctx.gpu
    this.check(gpu)
    const cached = this.pipelines.get(key) as GPURenderPipeline | undefined
    if (cached) return cached
    const shaders = ctx.world.resource(Shaders)
    const fs = shaders.module(gpu, { root, defines })
    const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
    if (!fs || !vs) {
      gpu.pipelines.skipped++
      return undefined
    }
    const pipeline = gpu.pipelines.render({
      label: key,
      layout: gpu.layouts.pipelineLayout({ label: key, bindGroupLayouts: layouts }),
      vertex: { module: vs, entryPoint: 'vs' },
      fragment: { module: fs, entryPoint: entry, targets },
    })
    if (pipeline) this.pipelines.set(key, pipeline)
    return pipeline
  }

  compute(
    ctx: NodeContext,
    key: string,
    root: string,
    entry: string,
    layouts: GPUBindGroupLayout[],
    defines?: Record<string, boolean>,
  ): GPUComputePipeline | undefined {
    const gpu = ctx.gpu
    this.check(gpu)
    const cached = this.pipelines.get(key) as GPUComputePipeline | undefined
    if (cached) return cached
    const module = ctx.world.resource(Shaders).module(gpu, defines ? { root, defines } : { root })
    if (!module) {
      gpu.pipelines.skipped++
      return undefined
    }
    const pipeline = gpu.pipelines.compute({
      label: key,
      layout: gpu.layouts.pipelineLayout({ label: key, bindGroupLayouts: layouts }),
      compute: { module, entryPoint: entry },
    })
    if (pipeline) this.pipelines.set(key, pipeline)
    return pipeline
  }

  /** A bind group, rebuilt when `key` (the ids of what it binds) changes. */
  group(
    gpu: GpuContext,
    slot: string,
    key: string,
    layout: GPUBindGroupLayout,
    entries: () => GPUBindGroupEntry[],
  ): GPUBindGroup {
    this.check(gpu)
    let g = this.groups.get(slot)
    if (!g || g.key !== key) {
      g = { key, group: gpu.device.createBindGroup({ label: slot, layout, entries: entries() }) }
      this.groups.set(slot, g)
    }
    return g.group
  }

  buffer(gpu: GpuContext, name: string, size: number): GpuBuffer {
    this.check(gpu)
    let b = this.buffers.get(name)
    if (!b) {
      b = new GpuBuffer(gpu, { label: name, usage: GPUBufferUsage.UNIFORM, size })
      this.buffers.set(name, b)
    }
    return b
  }

  sampler(gpu: GpuContext): GPUSampler {
    this.check(gpu)
    this.linear ??= gpu.device.createSampler({
      label: 'post/linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    return this.linear
  }
}

export function forwardView(ctx: NodeContext): { cam: CameraData; pv: ViewGpu } | undefined {
  const cam = cameraOf(ctx.view)
  const pv = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)
  return cam && pv ? { cam, pv } : undefined
}

/** A fullscreen pass the node begins itself (raw nodes with several passes). */
export function beginPass(
  ctx: NodeContext,
  name: string,
  view: GPUTextureView,
  load = false,
): GPURenderPassEncoder {
  return ctx.encoder.beginRenderPass({
    label: `${ctx.view.name}/${name}`,
    colorAttachments: [
      {
        view,
        loadOp: load ? 'load' : 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      },
    ],
    timestampWrites: ctx.timestamps(name),
  })
}

export const HDR: GPUColorTargetState[] = [{ format: 'rgba16float' }]
const RG11: GPUColorTargetState[] = [{ format: 'rg11b10ufloat' }]

/** Color targets for a post pass that writes `texture`: the chain's format, per view. */
export function targetsFor(texture: GPUTexture): GPUColorTargetState[] {
  return texture.format === 'rg11b10ufloat' ? RG11 : HDR
}

/**
 * The format of the post chain's full-resolution ping-pong (post-a, post-b) for a view:
 * rg11b10ufloat, half the bytes of rgba16float, where the device renders it, the view has no alpha
 * to carry (0052's transparent views), and the device's rounding is known (`rg11Truncates`);
 * rgba16float otherwise, and until then.
 */
export function postFormat(gpu: GpuContext, view: RenderView): GPUTextureFormat {
  const cam = cameraOf(view)
  if (!gpu.features.has('rg11b10ufloat-renderable') || cam === undefined || cam.alphaOutput)
    return 'rgba16float'
  return rg11Truncates(gpu) === undefined ? 'rgba16float' : 'rg11b10ufloat'
}

/** Whether a pass writing `texture` rounds its output in the shader (the RG11_ROUND define). */
export function roundsRg11(gpu: GpuContext, texture: GPUTexture): boolean {
  return texture.format === 'rg11b10ufloat' && rg11Truncates(gpu) === true
}

const truncates = new WeakMap<GPUDevice, boolean | 'probing'>()

/**
 * Whether the device truncates when it stores rg11b10ufloat (Metal does; the format leaves the
 * rounding to the device). Post passes writing it then round in the shader (`rg11_round`, the
 * RG11_ROUND define). Probed once per device, rendering 1 + 0.75 of a step and reading it back;
 * undefined until the answer lands.
 */
export function rg11Truncates(gpu: GpuContext): boolean | undefined {
  const device = gpu.device
  const known = truncates.get(device)
  if (known === 'probing') return undefined
  if (known !== undefined) return known
  truncates.set(device, 'probing')
  probeRg11(device).then(
    (v) => truncates.set(device, v),
    // A lost device or a failed map: assume truncation, the safe side (rounding then is exact).
    () => truncates.set(device, true),
  )
  return undefined
}

async function probeRg11(device: GPUDevice): Promise<boolean> {
  const texture = device.createTexture({
    label: 'post/rg11-probe',
    size: [1, 1],
    format: 'rg11b10ufloat',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  const buffer = device.createBuffer({
    label: 'post/rg11-probe',
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  // A shader store, as the post passes do (a clear may convert elsewhere): 1 + 0.75 of red's
  // step (1/64). A rounding store keeps 1 + 1/64, a truncating one stores 1.
  const module = device.createShaderModule({
    label: 'post/rg11-probe',
    code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0 + 0.75 / 64.0, 0.0, 0.0, 1.0); }`,
  })
  const pipeline = await device.createRenderPipelineAsync({
    label: 'post/rg11-probe',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rg11b10ufloat' }] },
  })
  const encoder = device.createCommandEncoder({ label: 'post/rg11-probe' })
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }],
  })
  pass.setPipeline(pipeline)
  pass.draw(3)
  pass.end()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1])
  device.queue.submit([encoder.finish()])
  try {
    await buffer.mapAsync(GPUMapMode.READ)
    const red = new Uint32Array(buffer.getMappedRange())[0]! & 0x7ff
    buffer.unmap()
    // 1.0 is exponent 15, mantissa 0: 15 << 6.
    return red === 15 << 6
  } finally {
    texture.destroy()
    buffer.destroy()
  }
}
export const scratch = new Float32Array(64)
