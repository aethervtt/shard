import type { GpuContext } from '@aethervtt/shard-gpu'
import type { NodeContext } from '../graph'
import { halfToFloat } from '../readback'

// Baseline tier (0064), loaded only on a baseline device: auto exposure's meter without compute.
// A fragment pass renders a small image of the view, 64×36 samples spread over it, each the EV100
// of the pixel under it and its metering weight (the full tier's formulas); it's read back, binned
// into the same 256-bin histogram on the CPU, and metered by the same `histogramEv`. So both tiers
// trim the same dark and bright tails and adapt alike; baseline meters fewer pixels.

export const METER_WIDTH = 64
export const METER_HEIGHT = 36

export const BASELINE_EXPOSURE_SHADERS: Record<string, string> = {
  'shard::post::baseline::meter': `
import shard::view::view;
import shard::color::luminance;

struct Meter {
  /** EV of bin 0, bins per EV, metering mode, 0. */
  range: vec4f,
  /** The meter image's size. */
  size: vec4f,
}

@group(0) @binding(1) var input: texture_2d<f32>;
@group(0) @binding(2) var<uniform> meter: Meter;

/** One sample: the EV100 of the input pixel under it, and its metering weight (of 16). */
@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let size = textureDimensions(input);
  let px = min(vec2u((floor(p.xy) + 0.5) / meter.size.xy * vec2f(size)), size - 1u);
  let c = textureLoad(input, vec2i(px), 0).rgb;
  let l = luminance(c) / max(view.exposure, 1e-20);
  let ev = log2(max(l, 1e-10) * 8.0);
  let q = vec2f(px) / vec2f(size) * 2.0 - 1.0;
  let r = length(q * vec2f(f32(size.x) / f32(size.y), 1.0)) / 1.4142;
  var w = 16.0;
  if (meter.range.z == 1.0) { w = round(16.0 * exp(-r * r / 0.18)); }
  if (meter.range.z == 2.0) { w = select(0.0, 16.0, r < 0.1); }
  return vec4f(ev, w, 0.0, 1.0);
}`,
}

const BYTES = METER_WIDTH * METER_HEIGHT * 4

/** A view's meter image and its readbacks in flight. */
export interface MeterView {
  target: GPUTexture
  view: GPUTextureView
  params: GPUBuffer
  readbacks: GPUBuffer[]
  busy: boolean[]
  generation: number
  group: GPUBindGroup | undefined
  groupKey: string
}

export function meterView(gpu: GpuContext, name: string, readbacks: number): MeterView {
  const target = gpu.device.createTexture({
    label: `${name}/exposure-meter`,
    size: [METER_WIDTH, METER_HEIGHT],
    format: 'rg16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  return {
    target,
    view: target.createView(),
    params: gpu.device.createBuffer({
      label: `${name}/exposure-meter`,
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    readbacks: Array.from({ length: readbacks }, (_, i) =>
      gpu.device.createBuffer({
        label: `${name}/exposure-readback-${i}`,
        size: BYTES,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
    ),
    busy: Array.from({ length: readbacks }, () => false),
    generation: gpu.generation,
    group: undefined,
    groupKey: '',
  }
}

export function meterLayout(gpu: GpuContext): GPUBindGroupLayout {
  const F = GPUShaderStage.FRAGMENT
  return gpu.layouts.bindGroupLayout({
    label: 'exposure/baseline',
    entries: [
      { binding: 0, visibility: F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: F, buffer: { type: 'uniform' } },
    ],
  })
}

const params = new Float32Array(8)

/**
 * Renders the meter image and, when a readback is free, copies it out. Returns the readback that
 * will hold it, or undefined when all are still mapping (this frame isn't metered).
 */
export function renderMeter(
  ctx: NodeContext,
  m: MeterView,
  pipeline: GPURenderPipeline,
  group: GPUBindGroup,
  range: Float32Array,
): number | undefined {
  params.set(range, 0)
  params[4] = METER_WIDTH
  params[5] = METER_HEIGHT
  ctx.gpu.device.queue.writeBuffer(m.params, 0, params)
  const pass = ctx.encoder.beginRenderPass({
    label: `${ctx.view.name}/exposure`,
    colorAttachments: [
      { view: m.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
    ],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, group)
  pass.draw(3)
  pass.end()
  const k = m.busy.indexOf(false)
  if (k < 0) return undefined
  ctx.encoder.copyTextureToBuffer(
    { texture: m.target },
    { buffer: m.readbacks[k]!, bytesPerRow: METER_WIDTH * 4 },
    [METER_WIDTH, METER_HEIGHT],
  )
  m.busy[k] = true
  return k
}

/** The meter image's samples binned into the full tier's histogram: weight into its EV bin. */
export function binMeter(
  bytes: ArrayBuffer,
  minEv: number,
  binsPerEv: number,
  bins: Uint32Array,
): Uint32Array {
  bins.fill(0)
  const h = new Uint16Array(bytes)
  for (let i = 0; i < METER_WIDTH * METER_HEIGHT; i++) {
    const w = halfToFloat(h[i * 2 + 1]!)
    if (w <= 0) continue
    const ev = halfToFloat(h[i * 2]!)
    bins[Math.min(255, Math.max(0, Math.floor((ev - minEv) * binsPerEv)))]! += w
  }
  return bins
}
