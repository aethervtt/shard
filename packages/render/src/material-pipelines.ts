import { assetServer } from '@shard/assets'
import type { World } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import type { ShaderLibrary } from '@shard/shader'
import type { MaterialAsset } from './assets'
import { allMaterialTypes, BLEND_MODES, type BlendMode, type MaterialType } from './materials'
import { materialNoise } from './noise'
import { Shaders } from './plugin'

const ordinals = new WeakMap<MaterialType, number>()
let nextOrdinal = 0

/** A small stable number per material type, for sorting and pipeline keys. */
export function typeOrdinal(type: MaterialType): number {
  let n = ordinals.get(type)
  if (n === undefined) {
    n = nextOrdinal++
    ordinals.set(type, n)
  }
  return n
}

/** What distinguishes a pipeline within a pass: blend mode and culling. */
export function materialVariant(material: MaterialAsset): number {
  const blend = material.type.blendOf(material.value)
  const cull = material.value.doubleSided ? 1 : 0
  return BLEND_MODES.indexOf(blend) * 2 + cull
}

export function variantBlend(variant: number): BlendMode {
  return BLEND_MODES[variant >> 1]!
}

export function variantCull(variant: number): GPUCullMode {
  return variant & 1 ? 'none' : 'back'
}

/** Color blend state for a blend mode (HDR target). */
export function blendState(blend: BlendMode): GPUBlendState | undefined {
  switch (blend) {
    case 'alpha':
      return {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      }
    case 'premultiplied':
      return {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      }
    case 'additive':
      return {
        color: { srcFactor: 'src-alpha', dstFactor: 'one' },
        alpha: { srcFactor: 'zero', dstFactor: 'one' },
      }
    default:
      return undefined
  }
}

interface Registered {
  version: number
  /** The noise wrappers' key (graph hashes) it was registered with. */
  noise: string
  library: ShaderLibrary
}

const registered = new WeakMap<MaterialType, Registered[]>()

/**
 * Makes sure a type's generated module is in the library at its current version, with `noise` (its
 * noise slots' wrappers and their key) when it has any.
 */
export function registerMaterialModule(
  library: ShaderLibrary,
  type: MaterialType,
  noise?: { source: string; key: string },
): void {
  let list = registered.get(type)
  if (!list) {
    list = []
    registered.set(type, list)
  }
  const entry = list.find((r) => r.library === library)
  const key = noise?.key ?? ''
  if (entry && entry.version === type.version && entry.noise === key) return
  library.register(type.modulePath, type.moduleSource(noise?.source), `material:${type.name}`)
  if (entry) {
    entry.version = type.version
    entry.noise = key
  } else list.push({ version: type.version, noise: key, library })
}

const watching = new WeakSet<World>()

/**
 * Re-registers the modules of material types that use a noise graph as soon as it (re)loads, so
 * the relink starts right away instead of at the next draw.
 */
function watchNoiseGraphs(world: World, library: ShaderLibrary): void {
  if (watching.has(world)) return
  watching.add(world)
  assetServer(world).onEvent((event) => {
    if (event.kind !== 'modified' && event.kind !== 'loaded') return
    for (const type of allMaterialTypes()) {
      if (!type.noise.some((slot) => slot.path === event.path)) continue
      const noise = materialNoise(world, library, type)
      if (noise) registerMaterialModule(library, type, noise)
    }
  })
}

/**
 * Shader modules and pipelines per material type, looked up per draw without allocating: modules
 * resolve once per (type, root, defines) per frame, pipelines are cached under a numeric key.
 */
export class MaterialPipelines {
  private frame = -1
  private readonly modules = new Map<number, GPUShaderModule | undefined>()
  private readonly pipelines = new Map<number, GPURenderPipeline | undefined>()

  beginFrame(frame: number): void {
    if (frame === this.frame) return
    this.frame = frame
    this.modules.clear()
    this.pipelines.clear()
  }

  /**
   * The module for a type linked from `root` with its shader's overrides. `slot` distinguishes
   * roots and define sets (a small integer chosen by the caller).
   */
  module(
    world: World,
    gpu: GpuContext,
    type: MaterialType,
    slot: number,
    root: string,
    defines: Readonly<Record<string, boolean>> | undefined,
  ): GPUShaderModule | undefined {
    const key = typeOrdinal(type) * 64 + slot
    if (this.modules.has(key)) return this.modules.get(key)
    const library = world.resource(Shaders)
    let noise: { source: string; key: string } | undefined
    if (type.noise.length > 0) {
      // Draws wait until the type's noise graphs load.
      watchNoiseGraphs(world, library)
      noise = materialNoise(world, library, type)
      if (!noise) {
        this.modules.set(key, undefined)
        return undefined
      }
    }
    registerMaterialModule(library, type, noise)
    const module = library.module(gpu, {
      root,
      defines,
      overrides: type.shader ? [type.shader] : undefined,
      label: type.name === 'render/StandardMaterial' ? undefined : `material ${type.name}`,
    })
    this.modules.set(key, module)
    return module
  }

  /** A compiled pipeline under `key` (unique per pass, type, and variant), if there is one. */
  cached(key: number): GPURenderPipeline | undefined {
    return this.pipelines.get(key)
  }

  /** The last pipeline that compiled under each key, with the layout it was made for. */
  private readonly previous = new Map<
    number,
    { pipeline: GPURenderPipeline; layout: GPUPipelineLayout | 'auto'; generation: number }
  >()

  /**
   * Asks the cache for a pipeline on a miss; compiled ones are kept for the rest of the frame.
   * While a replacement compiles (an edited shader or noise graph), draws keep the previous one
   * for the key if its layout is the same object (the bind groups still fit), instead of vanishing.
   */
  create(
    gpu: GpuContext,
    key: number,
    descriptor: GPURenderPipelineDescriptor,
  ): GPURenderPipeline | undefined {
    const pipeline = gpu.pipelines.render(descriptor)
    if (pipeline) {
      this.pipelines.set(key, pipeline)
      this.previous.set(key, { pipeline, layout: descriptor.layout, generation: gpu.generation })
      return pipeline
    }
    const last = this.previous.get(key)
    if (last && last.layout === descriptor.layout && last.generation === gpu.generation) {
      return last.pipeline
    }
    return undefined
  }
}
