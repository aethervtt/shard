import type { Entity, World } from '@aethervtt/shard-core'
import { Gpu } from '@aethervtt/shard-render'
import { FogSettings, MAX_FOG_LAYERS } from './components'
import type { FogState, LayerState } from './masks'

// `fog.sample` (0058): each layer's value at a world point, and the composite there, read from the
// masks themselves, so a test checks fog without reading the screen.

export interface FogSample {
  layers: { entity: Entity; value: number }[]
  /** max over layers of value × opacity, × the viewer's opacity. */
  composite: number
}

/** Reads a layer's mask bilinearly at world (x, z), the way the composite samples it. */
async function sampleLayer(world: World, layer: LayerState, x: number, z: number): Promise<number> {
  const e = layer.extent
  const u = (x - e[0]) / (e[2] - e[0])
  const v = (z - e[1]) / (e[3] - e[1])
  if (u < 0 || v < 0 || u > 1 || v > 1 || !layer.texture) return layer.base === 'hidden' ? 1 : 0
  // Texel centers around the point, clamped to the edge like the sampler.
  const fx = u * layer.width - 0.5
  const fy = v * layer.height - 0.5
  const x0 = Math.min(layer.width - 1, Math.max(0, Math.floor(fx)))
  const y0 = Math.min(layer.height - 1, Math.max(0, Math.floor(fy)))
  const x1 = Math.min(layer.width - 1, x0 + 1)
  const y1 = Math.min(layer.height - 1, y0 + 1)
  const tx = Math.min(1, Math.max(0, fx - x0))
  const ty = Math.min(1, Math.max(0, fy - y0))
  const gpu = world.resource(Gpu)
  const buffer = gpu.device.createBuffer({
    label: 'fog/sample',
    size: 512,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = gpu.device.createCommandEncoder({ label: 'fog/sample' })
  encoder.copyTextureToBuffer(
    { texture: layer.texture, origin: [x0, y0] },
    { buffer, bytesPerRow: 256, rowsPerImage: 2 },
    [x1 - x0 + 1, y1 - y0 + 1],
  )
  gpu.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const bytes = new Uint8Array(buffer.getMappedRange()).slice()
  buffer.destroy()
  const at = (cx: number, cy: number) => bytes[(cy - y0) * 256 + (cx - x0)]! / 255
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx
  return top * (1 - ty) + bottom * ty
}

export async function sampleFog(
  world: World,
  state: FogState,
  x: number,
  z: number,
): Promise<FogSample> {
  const layers: FogSample['layers'] = []
  let strongest = 0
  for (let i = 0; i < state.active.length; i++) {
    const layer = state.active[i]!
    const value = await sampleLayer(world, layer, x, z)
    layers.push({ entity: layer.entity, value })
    if (i < MAX_FOG_LAYERS) strongest = Math.max(strongest, value * layer.opacity)
  }
  const composite = Math.min(1, strongest * world.resource(FogSettings).viewerOpacity)
  return { layers, composite }
}
