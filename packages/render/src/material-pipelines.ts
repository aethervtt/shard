import { assetServer } from '@aethervtt/shard-assets'
import { ShardError, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { LogResource } from '@aethervtt/shard-runtime'
import type { ShaderLibrary } from '@aethervtt/shard-shader'
import { MaterialAsset } from './assets'
import { MaterialNoise } from './material-noise'
import { allMaterialTypes, BLEND_MODES, type BlendMode, type MaterialType } from './materials'
import { Shaders } from './plugin'
import { STANDARD_FIELDS } from './standard-fields'

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
    const support = world.tryResource(MaterialNoise)
    if (!support) return
    for (const type of allMaterialTypes()) {
      if (!type.noise.some((slot) => slot.path === event.path)) continue
      const noise = support.wrappers(world, library, type)
      if (noise) registerMaterialModule(library, type, noise)
    }
  })
}

/** Material types reported once for noise slots without materialNoisePlugin. */
const missingNoise = new WeakSet<MaterialType>()

/**
 * Shader modules and pipelines per material type, looked up per draw without allocating: modules
 * resolve once per (type, root, defines) per frame, pipelines are cached under a numeric key.
 */
export class MaterialPipelines {
  private frame = -1
  private revision = -1
  private readonly modules = new Map<number, GPUShaderModule | undefined>()
  private readonly pipelines = new Map<number, GPURenderPipeline | undefined>()
  /**
   * Types whose shader or pipeline failed (0061), with the type version that failed: their draws
   * use the standard pipeline through a proxy material until the type is defined again.
   */
  private readonly failedTypes = new Map<MaterialType, { version: number; error: ShardError }>()
  private readonly proxies = new WeakMap<MaterialAsset, { version: number; proxy: MaterialAsset }>()

  /** `revision`: the shader library's; any edit gives failed types another try (0061). */
  beginFrame(frame: number, revision = this.revision): void {
    if (revision !== this.revision) {
      this.revision = revision
      this.failedTypes.clear()
    }
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
      const support = world.tryResource(MaterialNoise)
      if (!support) {
        if (!missingNoise.has(type)) {
          missingNoise.add(type)
          world
            .tryResource(LogResource)
            ?.error(
              new ShardError(
                'render/feature-missing',
                `Material ${type.name} has noise slots, but materialNoisePlugin isn't installed`,
                { hint: "Add materialNoisePlugin from '@aethervtt/shard-render/noise'." },
              ),
            )
        }
        this.modules.set(key, undefined)
        return undefined
      }
      // Draws wait until the type's noise graphs load.
      watchNoiseGraphs(world, library)
      noise = support.wrappers(world, library, type)
      if (!noise) {
        this.modules.set(key, undefined)
        return undefined
      }
    }
    registerMaterialModule(library, type, noise)
    const request = {
      root,
      defines,
      overrides: type.shader ? [type.shader] : undefined,
      label: type.name === 'render/StandardMaterial' ? undefined : `material ${type.name}`,
    }
    const module = library.module(gpu, request)
    if (!module && type.name !== 'render/StandardMaterial') {
      const error = library.failure(request, gpu)
      if (error) this.failedTypes.set(type, { version: type.version, error })
    }
    this.modules.set(key, module)
    return module
  }

  /**
   * Whether the type's shader or pipeline failed (0061). Callers then draw its batches with
   * `proxy(material)` and the standard pipeline, so nothing using it disappears.
   */
  failing(type: MaterialType): boolean {
    if (this.failedTypes.size === 0) return false
    const f = this.failedTypes.get(type)
    return f !== undefined && f.version === type.version
  }

  /** How many types draw through the standard fallback now. */
  get failureCount(): number {
    let n = 0
    for (const [type, f] of this.failedTypes) if (f.version === type.version) n++
    return n
  }

  /** Types drawing through the standard fallback now, with why (for RenderHealth). */
  failures(): { type: string; error: ShardError }[] {
    const out: { type: string; error: ShardError }[] = []
    for (const [type, f] of this.failedTypes) {
      if (f.version === type.version) out.push({ type: type.name, error: f.error })
    }
    return out
  }

  /**
   * A standard material standing in for one whose type failed: its standard fields when the type
   * extends standard, else its `baseColor` or `color` if it has one. Kept per material and
   * refreshed when the material changes.
   */
  proxy(material: MaterialAsset): MaterialAsset {
    const hit = this.proxies.get(material)
    if (hit && hit.version === material.version) return hit.proxy
    const value = material.value as Record<string, unknown>
    const init: Record<string, unknown> = {}
    if (material.type.standard) {
      for (const k of Object.keys(STANDARD_FIELDS)) if (k in value) init[k] = value[k]
    } else {
      const color = value.baseColor ?? value.color
      if (isColor(color)) init.baseColor = color
    }
    const proxy = hit?.proxy ?? new MaterialAsset(init)
    if (hit) proxy.set(init)
    this.proxies.set(material, { version: material.version, proxy })
    return proxy
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
    type?: MaterialType,
  ): GPURenderPipeline | undefined {
    const pipeline = gpu.pipelines.render(descriptor)
    if (!pipeline && type && type.name !== 'render/StandardMaterial') {
      const error = gpu.pipelines.failure(descriptor)
      if (error) this.failedTypes.set(type, { version: type.version, error })
    }
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

function isColor(value: unknown): value is ArrayLike<number> {
  return (
    (Array.isArray(value) || value instanceof Float32Array) &&
    (value.length === 3 || value.length === 4) &&
    Array.prototype.every.call(value, (c: unknown) => typeof c === 'number')
  )
}
