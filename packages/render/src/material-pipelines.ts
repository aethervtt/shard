import type { World } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import type { ShaderLibrary } from '@shard/shader'
import type { MaterialAsset } from './assets'
import { BLEND_MODES, type BlendMode, type MaterialType } from './materials'
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
  library: ShaderLibrary
}

const registered = new WeakMap<MaterialType, Registered[]>()

/** Makes sure a type's generated module is in the library at its current version. */
export function registerMaterialModule(library: ShaderLibrary, type: MaterialType): void {
  let list = registered.get(type)
  if (!list) {
    list = []
    registered.set(type, list)
  }
  const entry = list.find((r) => r.library === library)
  if (entry && entry.version === type.version) return
  library.register(type.modulePath, type.moduleSource(), `material:${type.name}`)
  if (entry) entry.version = type.version
  else list.push({ version: type.version, library })
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
    registerMaterialModule(library, type)
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

  /** Asks the cache for a pipeline on a miss; compiled ones are kept for the rest of the frame. */
  create(
    gpu: GpuContext,
    key: number,
    descriptor: GPURenderPipelineDescriptor,
  ): GPURenderPipeline | undefined {
    const pipeline = gpu.pipelines.render(descriptor)
    if (pipeline) this.pipelines.set(key, pipeline)
    return pipeline
  }
}
