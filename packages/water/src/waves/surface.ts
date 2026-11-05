import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import type { NodeContext } from '@aethervtt/shard-render'
import type { WaterBodiesState } from '../bodies'
import type { SurfaceWaves } from '../render'
import type { WaveGpu } from './gpu'
import { MAX_WAVE_LAYERS, SURFACE_WAVES_FLOATS } from './shaders'

/**
 * The water pass's view of the sea (0098): group 2 with the resolved cascades and a uniform saying
 * what each layer is (1 / length, shore wavenumber, Hs, body slot) and each body's layers and foam.
 * Rebuilt each frame from WaveGpu's layers; nothing allocates once the two groups (one per
 * ping-pong texture) exist.
 */
export function surfaceWaves(w: WaveGpu): SurfaceWaves {
  const data = new Float32Array(4 + SURFACE_WAVES_FLOATS)
  let uniform: GpuBuffer | undefined
  let layout: GPUBindGroupLayout | undefined
  let sampler: GPUSampler | undefined
  let generation = -1
  const groups = new Map<GPUTexture, { group: GPUBindGroup; version: number }>()
  const ensure = (gpu: GpuContext) => {
    if (generation === gpu.generation && layout) return
    generation = gpu.generation
    groups.clear()
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    layout = gpu.layouts.bindGroupLayout({
      label: 'water/surface/waves',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VF, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: VF, sampler: { type: 'filtering' } },
      ],
    })
    sampler = gpu.layouts.sampler({
      label: 'water/waves',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    })
    uniform = new GpuBuffer(gpu, {
      label: 'water/surface/waves',
      usage: GPUBufferUsage.UNIFORM,
      size: data.byteLength,
    })
  }
  return {
    layout(gpu) {
      ensure(gpu)
      return layout!
    },
    group(ctx: NodeContext, bodies: WaterBodiesState) {
      const texture = w.output
      if (!texture || w.layers.length === 0 || w.frame < 0 || w.generation !== ctx.gpu.generation)
        return undefined
      ensure(ctx.gpu)
      data.fill(0)
      data[0] = w.layers.length
      data[1] = 0.5 / w.n
      for (let i = 0; i < w.layers.length; i++) {
        const l = w.layers[i]!
        const length = l.set.sea.cascades[l.cascade]!.length
        let slot = -1
        for (let b = 0; b < bodies.count; b++)
          if (bodies.sorted[b]!.entity === l.set.entity) slot = b
        const o = 4 + l.layer * 4
        data[o] = 1 / length
        data[o + 1] = (2 * Math.PI * 4) / length
        data[o + 2] = l.set.sea.hs
        data[o + 3] = slot
        if (slot >= 0 && l.cascade === 0) {
          const b = 4 + MAX_WAVE_LAYERS * 4 + slot * 8
          const optics = bodies.sorted[slot]!.optics
          data[b] = l.layer
          data[b + 1] = l.set.sea.cascades.length
          data[b + 2] = l.set.sea.hs
          data[b + 4] = optics.foamColor[0]
          data[b + 5] = optics.foamColor[1]
          data[b + 6] = optics.foamColor[2]
          data[b + 7] = optics.foam
        }
      }
      uniform!.write(data)
      let g = groups.get(texture)
      if (!g || g.version !== uniform!.version) {
        g = {
          group: ctx.gpu.device.createBindGroup({
            label: 'water/surface/waves',
            layout: layout!,
            entries: [
              { binding: 0, resource: { buffer: uniform!.buffer } },
              { binding: 1, resource: texture.createView({ dimension: '2d-array' }) },
              { binding: 2, resource: sampler! },
            ],
          }),
          version: uniform!.version,
        }
        groups.set(texture, g)
      }
      return g.group
    },
  }
}
