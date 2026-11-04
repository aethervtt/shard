import type { Entity, World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import {
  bindingDimension,
  type NodeContext,
  type NodeDescriptor,
  Shaders,
} from '@aethervtt/shard-render'
import { LogResource, Time } from '@aethervtt/shard-runtime'
import { fadeWeight, type WaveSet, type WaveSetsState, waveTick, waveTime } from './sea'
import { KERNEL_FLOATS, MAX_WAVE_LAYERS } from './shaders'
import type { Cascade, Sea } from './spectrum'

/** Bytes between dynamic uniform slots. */
export const SLOT = 256

/** One cascade on the GPU: its set, its index in the set, and its layer. */
export interface WaveLayer {
  set: WaveSet
  cascade: number
  layer: number
}

/**
 * The sea's GPU side (0098): the spectrum (h0 new and old, ω and k), the inverse FFT's ping-pong
 * fields, and the resolved waves (ping-pong, so foam carries over), all 2D arrays with a layer (or
 * two, or three) per cascade, at the largest resolution any sea asks for.
 */
export class WaveGpu {
  generation = -1
  /** Resolution and cascade layers the textures are for. */
  n = 0
  layerCount = 0
  spectrum: GPUTexture | undefined
  fields: GPUTexture[] = []
  waves: GPUTexture[] = []
  /** Which of `waves` the last frame wrote. */
  current = 0
  readonly layers: WaveLayer[] = []
  /** WaveSets' version the layers and spectrum are for. */
  uploaded = -1
  /** The frame (Time.frame) the waves were last computed for, and its tick and sea time. */
  frame = -1
  tick = 0
  time = 0
  readonly kernel = new Float32Array(KERNEL_FLOATS)
  uniforms: GpuBuffer | undefined
  /** The resolution the FFT stage uniforms were written for. */
  stagesFor = 0
  readonly pipelines = new Map<string, GPUComputePipeline>()
  readonly groups = new Map<string, GPUBindGroup>()
  layouts: Record<string, GPUBindGroupLayout> = {}
  /** Bodies beyond the layers there are room for, reported once each. */
  readonly skipped = new Set<Entity>()
  /** The baseline tier's fragment passes (0064), when this device is baseline. */
  baseline: typeof import('../baseline/waves') | undefined

  /** The resolved waves the water pass reads this frame. */
  get output(): GPUTexture | undefined {
    return this.waves[this.current]
  }
}

/** Assigns cascade layers to sets (by entity, up to MAX_WAVE_LAYERS); returns the largest resolution. */
function assignLayers(world: World, gpu: WaveGpu, sets: WaveSetsState): number {
  gpu.layers.length = 0
  let n = 0
  const ordered = [...sets.sets.values()]
    .filter((s) => !s.problem)
    .sort((a, b) => a.entity - b.entity)
  for (const set of ordered) {
    const count = set.sea.cascades.length
    if (gpu.layers.length + count > MAX_WAVE_LAYERS) {
      set.layer = -1
      if (!gpu.skipped.has(set.entity)) {
        gpu.skipped.add(set.entity)
        world
          .tryResource(LogResource)
          ?.log(
            'warn',
            `OceanWaves on ${set.entity} doesn't fit: ${MAX_WAVE_LAYERS} cascade layers are drawn at most`,
            {
              code: 'water/too-many-cascades',
              hint: 'Give seas fewer cascades, or fewer bodies their own waves.',
            },
          )
      }
      continue
    }
    set.layer = gpu.layers.length
    for (let c = 0; c < count; c++) gpu.layers.push({ set, cascade: c, layer: set.layer + c })
    n = Math.max(n, set.sea.params.resolution)
  }
  return n
}

const array = (
  gpu: GpuContext,
  label: string,
  n: number,
  layers: number,
  format: GPUTextureFormat,
  usage: number,
) =>
  gpu.device.createTexture({
    label,
    size: [n, n, Math.max(1, layers)],
    format,
    usage,
    ...bindingDimension(gpu, '2d-array'),
  })

/** (Re)creates the textures for `n` and the layers in use. */
function ensureTextures(gpu: GpuContext, w: WaveGpu, n: number): void {
  const count = w.layers.length
  if (w.generation === gpu.generation && w.n === n && w.layerCount === count && w.spectrum) return
  for (const t of [w.spectrum, ...w.fields, ...w.waves]) t?.destroy()
  w.generation = gpu.generation
  w.n = n
  w.layerCount = count
  w.groups.clear()
  const baseline = gpu.tier === 'baseline'
  const T = GPUTextureUsage
  // Baseline renders into them (fragment kernels); the full tier stores into them.
  const target = baseline ? T.RENDER_ATTACHMENT : T.STORAGE_BINDING
  w.spectrum = array(
    gpu,
    'water/waves/spectrum',
    n,
    count * 3,
    'rgba32float',
    T.TEXTURE_BINDING | T.COPY_DST,
  )
  w.fields = [0, 1].map((i) =>
    array(gpu, `water/waves/fields-${i}`, n, count * 2, 'rgba32float', T.TEXTURE_BINDING | target),
  )
  w.waves = [0, 1].map((i) =>
    array(
      gpu,
      `water/waves/waves-${i}`,
      n,
      count * 2,
      'rgba16float',
      T.TEXTURE_BINDING | T.COPY_SRC | target,
    ),
  )
  w.current = 0
  w.uploaded = -1
}

/**
 * A cascade's spectrum into its three layers, centred in an `n`-wide texture (a sea with a smaller
 * resolution is zero-padded: the same waves, sampled finer).
 */
function writeCascade(
  gpu: GpuContext,
  w: WaveGpu,
  layer: number,
  cascade: Cascade,
  old: Cascade | undefined,
  own: number,
) {
  const n = w.n
  const pad = (n - own) / 2
  const h0 = new Float32Array(n * n * 4)
  const prior = new Float32Array(n * n * 4)
  const meta = new Float32Array(n * n * 4)
  const dk = (2 * Math.PI) / cascade.length
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4
      meta[o + 2] = (i - n / 2) * dk
      meta[o + 3] = (j - n / 2) * dk
      const si = i - pad
      const sj = j - pad
      if (si < 0 || sj < 0 || si >= own || sj >= own) continue
      const s = (sj * own + si) * 4
      for (let k = 0; k < 4; k++) h0[o + k] = cascade.h0[s + k]!
      meta[o] = cascade.omega[s]!
      if (old) {
        for (let k = 0; k < 4; k++) prior[o + k] = old.h0[s + k]!
        meta[o + 1] = old.omega[s]!
      } else meta[o + 1] = cascade.omega[s]!
    }
  }
  const write = (data: Float32Array, z: number) =>
    gpu.device.queue.writeTexture(
      { texture: w.spectrum!, origin: [0, 0, z] },
      data,
      { bytesPerRow: n * 16, rowsPerImage: n },
      [n, n, 1],
    )
  write(h0, layer * 3)
  write(prior, layer * 3 + 1)
  write(meta, layer * 3 + 2)
}

/** Uploads every cascade's spectrum after a change (layers, a new sea, a finished crossfade). */
export function uploadSeas(
  world: World,
  gpu: GpuContext,
  w: WaveGpu,
  sets: WaveSetsState,
): boolean {
  let version = sets.version
  for (const s of sets.sets.values()) version += s.version * 7919
  if (w.uploaded === version && w.generation === gpu.generation && w.spectrum)
    return w.layers.length > 0
  const n = assignLayers(world, w, sets)
  if (w.layers.length === 0) {
    w.uploaded = version
    return false
  }
  ensureTextures(gpu, w, n)
  for (const l of w.layers) {
    const sea: Sea = l.set.sea
    writeCascade(
      gpu,
      w,
      l.layer,
      sea.cascades[l.cascade]!,
      l.set.old?.cascades[l.cascade],
      sea.params.resolution,
    )
  }
  w.uploaded = version
  return true
}

/** The evolve and resolve uniforms for this frame (slots 0 and 1; the FFT stages follow). */
function writeKernelUniforms(world: World, w: WaveGpu): void {
  const tick = waveTick(world, true)
  const k = w.kernel
  k.fill(0)
  k[0] = waveTime(world, tick)
  w.tick = tick
  w.time = k[0]
  k[1] = w.layers.length
  for (const l of w.layers) k[4 + l.layer * 4] = fadeWeight(l.set, tick)
  w.uniforms!.write(k, 0)
  k.fill(0)
  k[0] = Math.min(world.tryResource(Time)?.delta ?? 1 / 60, 0.1)
  k[1] = w.layers.length
  for (const l of w.layers) {
    const o = 4 + l.layer * 4
    k[o] = l.set.sea.params.choppiness
    k[o + 1] = l.set.foam[0]
    k[o + 2] = l.set.foam[1]
    k[o + 3] = l.set.foam[2]
  }
  w.uniforms!.write(k, SLOT)
}

/** The target uniform slot of cascade layer `l` (baseline's fragment kernels read it). */
export const targetSlot = (w: WaveGpu, l: number) => SLOT * (2 + 2 * Math.log2(w.n) + l)

/** FFT stage uniforms (stage, along z, N), from slot 2: written when N changes. */
function writeStageUniforms(w: WaveGpu): void {
  const stages = Math.log2(w.n)
  const data = new Uint32Array(4)
  for (let axis = 0; axis < 2; axis++) {
    for (let s = 0; s < stages; s++) {
      data[0] = s
      data[1] = axis
      data[2] = w.n
      w.uniforms!.write(data, SLOT * (2 + axis * stages + s))
    }
  }
  // Baseline's fragment kernels: each output layer's target (size, layer).
  for (let l = 0; l < MAX_WAVE_LAYERS * 2 && targetSlot(w, l) + 16 <= w.uniforms!.byteLength; l++) {
    data[0] = w.n
    data[1] = w.n
    data[2] = 1
    data[3] = l
    w.uniforms!.write(data, targetSlot(w, l))
  }
}

export function ensureUniforms(gpu: GpuContext, w: WaveGpu): void {
  const stages = Math.log2(Math.max(w.n, 2))
  const bytes = SLOT * (2 + 2 * stages + MAX_WAVE_LAYERS * 2)
  if (!w.uniforms || w.uniforms.byteLength < bytes) {
    w.uniforms?.destroy()
    w.uniforms = new GpuBuffer(gpu, {
      label: 'water/waves',
      usage: GPUBufferUsage.UNIFORM,
      size: bytes,
    })
    w.groups.clear()
    w.stagesFor = 0
  }
}

// --- the full tier: compute -----------------------------------------------------------------

function computeLayouts(gpu: GpuContext): Record<string, GPUBindGroupLayout> {
  const C = GPUShaderStage.COMPUTE
  const uniform = {
    binding: 0,
    visibility: C,
    buffer: { type: 'uniform' as const, hasDynamicOffset: true },
  }
  const read = (binding: number) => ({
    binding,
    visibility: C,
    texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d-array' as const },
  })
  const store = (binding: number, format: GPUTextureFormat) => ({
    binding,
    visibility: C,
    storageTexture: { access: 'write-only' as const, format, viewDimension: '2d-array' as const },
  })
  return {
    evolve: gpu.layouts.bindGroupLayout({
      label: 'water/waves/evolve',
      entries: [uniform, read(1), store(2, 'rgba32float')],
    }),
    fft_line: gpu.layouts.bindGroupLayout({
      label: 'water/waves/fft_line',
      entries: [uniform, read(1), store(2, 'rgba32float')],
    }),
    resolve: gpu.layouts.bindGroupLayout({
      label: 'water/waves/resolve',
      entries: [uniform, read(1), read(2), store(3, 'rgba16float')],
    }),
  }
}

function computePipeline(
  ctx: NodeContext,
  w: WaveGpu,
  name: string,
): GPUComputePipeline | undefined {
  const cached = w.pipelines.get(name)
  if (cached) return cached
  const gpu = ctx.gpu
  const module = ctx.world.resource(Shaders).module(gpu, { root: `water::waves::${name}` })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const p = gpu.pipelines.compute({
    label: `water/waves/${name}`,
    layout: gpu.layouts.pipelineLayout({
      label: `water/waves/${name}`,
      bindGroupLayouts: [w.layouts[name]!],
    }),
    compute: { module, entryPoint: 'main' },
  })
  if (p) w.pipelines.set(name, p)
  return p
}

const all = (t: GPUTexture) => t.createView({ dimension: '2d-array' })

function computeGroup(
  gpu: GpuContext,
  w: WaveGpu,
  key: string,
  layout: string,
  entries: () => GPUBindGroupEntry[],
) {
  let g = w.groups.get(key)
  if (!g) {
    g = gpu.device.createBindGroup({
      label: `water/waves/${key}`,
      layout: w.layouts[layout]!,
      entries: entries(),
    })
    w.groups.set(key, g)
  }
  return g
}

const offset = [0]

/**
 * The frame's sea on the full tier: evolve, the inverse FFT along rows then columns (water::waves::
 * fft_line, every stage in workgroup memory), resolve; all layers a dispatch.
 */
function runCompute(ctx: NodeContext, w: WaveGpu): void {
  const gpu = ctx.gpu
  const evolve = computePipeline(ctx, w, 'evolve')
  const fft = computePipeline(ctx, w, 'fft_line')
  const resolve = computePipeline(ctx, w, 'resolve')
  if (!evolve || !fft || !resolve) return
  const n = w.n
  const groups = Math.ceil(n / 8)
  const layers = w.layers.length * 2
  const stages = Math.log2(n)
  const lines = w.layers.length * 2
  const buffer = { buffer: w.uniforms!.buffer, size: 16 + MAX_WAVE_LAYERS * 16 }
  const pass = ctx.encoder.beginComputePass({
    label: 'water-waves',
    timestampWrites: ctx.timestamps('water-waves'),
  })
  pass.setPipeline(evolve)
  offset[0] = 0
  pass.setBindGroup(
    0,
    computeGroup(gpu, w, 'evolve', 'evolve', () => [
      { binding: 0, resource: buffer },
      { binding: 1, resource: all(w.spectrum!) },
      { binding: 2, resource: all(w.fields[0]!) },
    ]),
    offset,
  )
  pass.dispatchWorkgroups(groups, groups, layers)
  // Rows, then columns: each a workgroup per line and layer, every stage in workgroup memory.
  // The stage uniforms of the per-stage kernel carry the axis; the first of each axis will do.
  pass.setPipeline(fft)
  for (let axis = 0; axis < 2; axis++) {
    offset[0] = SLOT * (2 + axis * stages)
    pass.setBindGroup(
      0,
      computeGroup(gpu, w, `fft/${axis}`, 'fft_line', () => [
        { binding: 0, resource: { buffer: w.uniforms!.buffer, size: 16 } },
        { binding: 1, resource: all(w.fields[axis]!) },
        { binding: 2, resource: all(w.fields[1 - axis]!) },
      ]),
      offset,
    )
    pass.dispatchWorkgroups(n, lines, 1)
  }
  // Two passes: the result is back in fields[0].
  const next = 1 - w.current
  pass.setPipeline(resolve)
  offset[0] = SLOT
  pass.setBindGroup(
    0,
    computeGroup(gpu, w, `resolve/${next}`, 'resolve', () => [
      { binding: 0, resource: buffer },
      { binding: 1, resource: all(w.fields[0]!) },
      { binding: 2, resource: all(w.waves[w.current]!) },
      { binding: 3, resource: all(w.waves[next]!) },
    ]),
    offset,
  )
  pass.dispatchWorkgroups(groups, groups, layers)
  pass.end()
  w.current = next
}

/**
 * The sea's node (0098): once a frame, uploads changed spectra and computes every cascade's waves
 * for the water pass (`water-waves`). Its GPU time is `gpu:water-waves`.
 */
export function wavesNode(
  w: WaveGpu,
  sets: () => WaveSetsState,
  active: (view: import('@aethervtt/shard-render').RenderView) => boolean,
): NodeDescriptor {
  return {
    kind: 'raw',
    phase: 0,
    enabled: (view) => active(view) && sets().sets.size > 0,
    writes: ['water-waves'],
    run: (ctx) => {
      // Once a frame for every view; again if the tick moved without a new frame (a capture).
      const frame = ctx.world.tryResource(Time)?.frame ?? 0
      const tick = waveTick(ctx.world, true)
      if (w.frame === frame && w.tick === tick && w.generation === ctx.gpu.generation) return
      const gpu = ctx.gpu
      if (w.generation !== gpu.generation) {
        w.pipelines.clear()
        w.groups.clear()
        w.layouts = gpu.tier === 'baseline' ? {} : computeLayouts(gpu)
        w.spectrum = undefined
        w.uniforms = undefined
        w.stagesFor = 0
      }
      if (!uploadSeas(ctx.world, gpu, w, sets())) return
      ensureUniforms(gpu, w)
      if (w.stagesFor !== w.n) {
        writeStageUniforms(w)
        w.stagesFor = w.n
      }
      writeKernelUniforms(ctx.world, w)
      if (gpu.tier === 'baseline') {
        if (!w.baseline) return
        if (!w.baseline.runFragment(ctx, w)) return
      } else runCompute(ctx, w)
      w.frame = frame
    },
  }
}
