import type { GpuContext } from '@aethervtt/shard-gpu'

// Small differences in what the engine asks of a device on the baseline tier (0064), kept out of
// the full tier's descriptors: on a full-tier device these add nothing.

/**
 * A texture's binding dimension, fixed at creation on baseline (compatibility mode and WebGL2):
 * spread into the texture descriptor. Nothing on the full tier.
 */
export function bindingDimension(
  gpu: GpuContext,
  dimension: GPUTextureViewDimension,
): { textureBindingViewDimension?: GPUTextureViewDimension } {
  return gpu.tier === 'baseline' ? { textureBindingViewDimension: dimension } : {}
}

/**
 * The layout entry for a depth texture read without comparison. On baseline the shader rewrite
 * reads it as a float texture (naga can't load from depth), so it binds as unfilterable float.
 */
export function depthReadEntry(
  gpu: GpuContext,
  binding: number,
  visibility: GPUShaderStageFlags,
  viewDimension: GPUTextureViewDimension = '2d',
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    texture:
      gpu.tier === 'baseline'
        ? { sampleType: 'unfilterable-float', viewDimension }
        : viewDimension === '2d'
          ? { sampleType: 'depth' }
          : { sampleType: 'depth', viewDimension },
  }
}
