import { type NodeContext, Shaders } from '@aethervtt/shard-render'
import { fragmentKernel } from '@aethervtt/shard-shader/fragment-kernel'
import { SLOT, targetSlot, type WaveGpu } from '../waves/gpu'
import { MAX_WAVE_LAYERS, WAVE_KERNELS } from '../waves/shaders'

// Baseline tier (0064), loaded only there: the sea's image kernels as fragment passes, the same
// WGSL bodies as the full tier's compute (shard-shader's fragmentKernel). A pass renders one layer
// of its target, so a stage is a pass per layer: (1 + 2 log₂N + 1) × 2 per cascade a frame.

const fragment = (root: string) => fragmentKernel(WAVE_KERNELS[root]!, 'main', root).source

export const BASELINE_WAVE_KERNELS: Record<string, string> = {
  'water::waves::evolve::fragment': fragment('water::waves::evolve'),
  'water::waves::fft::fragment': fragment('water::waves::fft'),
  'water::waves::resolve::fragment': fragment('water::waves::resolve'),
}

interface Baseline {
  generation: number
  layouts: Record<string, GPUBindGroupLayout>
  pipelines: Map<string, GPURenderPipeline>
  groups: Map<string, GPUBindGroup>
  views: WeakMap<GPUTexture, GPUTextureView[]>
}

const state: Baseline = {
  generation: -1,
  layouts: {},
  pipelines: new Map(),
  groups: new Map(),
  views: new WeakMap(),
}

function layouts(ctx: NodeContext): Record<string, GPUBindGroupLayout> {
  const gpu = ctx.gpu
  if (state.generation === gpu.generation) return state.layouts
  state.generation = gpu.generation
  state.pipelines.clear()
  state.groups.clear()
  const F = GPUShaderStage.FRAGMENT
  const uniform = (binding: number) => ({
    binding,
    visibility: F,
    buffer: { type: 'uniform' as const, hasDynamicOffset: true },
  })
  const read = (binding: number) => ({
    binding,
    visibility: F,
    texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d-array' as const },
  })
  // The storage output became the target uniform (binding 2, or 3 for resolve).
  state.layouts = {
    evolve: gpu.layouts.bindGroupLayout({
      label: 'water/waves/evolve/baseline',
      entries: [uniform(0), read(1), uniform(2)],
    }),
    fft: gpu.layouts.bindGroupLayout({
      label: 'water/waves/fft/baseline',
      entries: [uniform(0), read(1), uniform(2)],
    }),
    resolve: gpu.layouts.bindGroupLayout({
      label: 'water/waves/resolve/baseline',
      entries: [uniform(0), read(1), read(2), uniform(3)],
    }),
  }
  return state.layouts
}

function pipeline(ctx: NodeContext, name: string, format: GPUTextureFormat) {
  const cached = state.pipelines.get(name)
  if (cached) return cached
  const gpu = ctx.gpu
  const shaders = ctx.world.resource(Shaders)
  const fs = shaders.module(gpu, { root: `water::waves::${name}::fragment` })
  const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
  if (!fs || !vs) {
    gpu.pipelines.skipped++
    return undefined
  }
  const p = gpu.pipelines.render({
    label: `water/waves/${name}/baseline`,
    layout: gpu.layouts.pipelineLayout({
      label: `water/waves/${name}/baseline`,
      bindGroupLayouts: [layouts(ctx)[name]!],
    }),
    vertex: { module: vs, entryPoint: 'vs' },
    fragment: { module: fs, entryPoint: 'main', targets: [{ format }] },
  })
  if (p) state.pipelines.set(name, p)
  return p
}

function layerView(t: GPUTexture, layer: number): GPUTextureView {
  let list = state.views.get(t)
  if (!list) {
    list = []
    for (let l = 0; l < t.depthOrArrayLayers; l++)
      list.push(t.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 }))
    state.views.set(t, list)
  }
  return list[layer]!
}

const all = (t: GPUTexture) => t.createView({ dimension: '2d-array' })

function group(ctx: NodeContext, key: string, layout: string, entries: () => GPUBindGroupEntry[]) {
  let g = state.groups.get(key)
  if (!g) {
    g = ctx.gpu.device.createBindGroup({
      label: `water/waves/${key}`,
      layout: layouts(ctx)[layout]!,
      entries: entries(),
    })
    state.groups.set(key, g)
  }
  return g
}

const attachment: GPURenderPassColorAttachment = {
  view: undefined as unknown as GPUTextureView,
  loadOp: 'clear',
  clearValue: { r: 0, g: 0, b: 0, a: 0 },
  storeOp: 'store',
}
const descriptor: GPURenderPassDescriptor = { label: 'water-waves', colorAttachments: [attachment] }
const offsets = [0, 0]

/** The frame's sea as fragment passes. False while a pipeline compiles. */
export function runFragment(ctx: NodeContext, w: WaveGpu): boolean {
  const evolve = pipeline(ctx, 'evolve', 'rgba32float')
  const fft = pipeline(ctx, 'fft', 'rgba32float')
  const resolve = pipeline(ctx, 'resolve', 'rgba16float')
  if (!evolve || !fft || !resolve) return false
  const uniforms = w.uniforms!.buffer
  const wide = { buffer: uniforms, size: 16 + MAX_WAVE_LAYERS * 16 }
  const small = { buffer: uniforms, size: 16 }
  const key = `${w.generation}/${w.n}/${w.layerCount}/${w.uniforms!.version}`
  const layers = w.layers.length * 2
  const stages = Math.log2(w.n)
  let timed = true
  const draw = (
    p: GPURenderPipeline,
    target: GPUTexture,
    layer: number,
    g: GPUBindGroup,
    first: number,
  ) => {
    attachment.view = layerView(target, layer)
    descriptor.timestampWrites = timed ? ctx.timestamps('water-waves') : undefined
    timed = false
    const pass = ctx.encoder.beginRenderPass(descriptor)
    pass.setPipeline(p)
    offsets[0] = first
    offsets[1] = targetSlot(w, layer)
    pass.setBindGroup(0, g, offsets)
    pass.draw(3)
    pass.end()
  }
  const evolveGroup = group(ctx, `evolve/${key}`, 'evolve', () => [
    { binding: 0, resource: wide },
    { binding: 1, resource: all(w.spectrum!) },
    { binding: 2, resource: small },
  ])
  for (let l = 0; l < layers; l++) draw(evolve, w.fields[0]!, l, evolveGroup, 0)
  for (let i = 0; i < 2 * stages; i++) {
    const from = i % 2
    const g = group(ctx, `fft/${from}/${key}`, 'fft', () => [
      { binding: 0, resource: small },
      { binding: 1, resource: all(w.fields[from]!) },
      { binding: 2, resource: small },
    ])
    for (let l = 0; l < layers; l++) draw(fft, w.fields[1 - from]!, l, g, SLOT * (2 + i))
  }
  const next = 1 - w.current
  const resolveGroup = group(ctx, `resolve/${next}/${key}`, 'resolve', () => [
    { binding: 0, resource: wide },
    { binding: 1, resource: all(w.fields[0]!) },
    { binding: 2, resource: all(w.waves[w.current]!) },
    { binding: 3, resource: small },
  ])
  for (let l = 0; l < layers; l++) draw(resolve, w.waves[next]!, l, resolveGroup, SLOT)
  w.current = next
  return true
}
