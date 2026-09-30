import {
  type AnyField,
  type ComponentDef,
  defineComponent,
  defineSchema,
  type Fields,
  isRedefinable,
  ShardError,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { type WgslLayout, wgslLayout } from '@aethervtt/shard-shader'
import { STANDARD_FIELDS } from './standard-fields'

export const BLEND_MODES = ['opaque', 'mask', 'alpha', 'additive', 'premultiplied'] as const
export type BlendMode = (typeof BLEND_MODES)[number]

/** Blend modes drawn after opaque geometry, sorted back to front, without depth writes. */
export const isTransparent = (blend: BlendMode) =>
  blend === 'alpha' || blend === 'additive' || blend === 'premultiplied'

export interface MaterialTypeOptions<F extends Fields> {
  /**
   * 'standard' keeps every StandardMaterial field and its lighting; hooks change the surface.
   * 'none' starts from nothing: a `shade` hook computes the final color, and it renders forward.
   */
  extends?: 'standard' | 'none'
  /** The type's own parameters. Texture handles (`t.handle('Texture')`) become bindings. */
  fields?: F
  /** Fixed blend mode. Omitted, standard extensions follow the material's `alphaMode`. */
  blend?: BlendMode
  /** The shader module with the hook overrides, e.g. `project::lava` (`shaders/lava.wesl`). */
  shader?: string
  /**
   * Noise graphs the shader calls, by name: `{ detail: 'assets/noise/rock.noise.json' }` makes
   * `noise_detail(p: vec3f, seed: u32) -> f32` available in `material::<name>`. The graph is
   * code, so it's chosen per type; editing the file relinks the material.
   */
  noise?: Readonly<Record<string, string>>
  /**
   * Texture fields bound as `texture_2d_array<f32>` (a `*.texarray.json`, or any texture as one
   * layer). Arrays of color textures sample through the sRGB view.
   */
  arrays?: readonly string[]
  /**
   * Texture fields that hold color (albedo, an atlas): sampled through the sRGB view, as
   * `baseColorTexture` is. Other texture fields sample the stored values (the linear view).
   */
  colors?: readonly string[]
  /**
   * Standard extensions only: false leaves the standard material's five texture slots (and their
   * samplers) out of the layout, for types that build their own surface and need the room (a stage
   * holds 16 sampled textures). Its shader must then not call `standard_input`.
   */
  standardTextures?: boolean
  /**
   * false: draws of this type aren't pick targets. A pick (GPU or raycast) goes through them to
   * what's under: a grid's lines over the tiles they're drawn on (0059). Default true.
   */
  pickable?: boolean
  description?: string
}

/** A material type's noise slot: `noise_<name>` calls the graph at `path`. */
export interface MaterialNoiseSlot {
  readonly name: string
  readonly path: string
}

/** Bindings of the standard material in group 1; a type's own bindings follow. */
const STANDARD_BINDINGS = 12

function isTextureHandle(field: AnyField): boolean {
  if (field.kind !== 'handle') return false
  const schema = field.jsonSchema() as { anyOf?: { 'x-asset-type'?: string }[] }
  return schema.anyOf?.some((s) => s['x-asset-type'] === 'Texture') ?? false
}

/** A PascalName's shader module path: `my-game/Lava` → `material::lava`. */
export function materialModulePath(name: string): string {
  const pascal = name.slice(name.indexOf('/') + 1)
  return `material::${pascal.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`
}

/**
 * A material type: a schema (validation, JSON Schema, inspector data) and, from it, a generated
 * WGSL module with the uniform struct and texture bindings. Its shader overrides hooks.
 */
export class MaterialType {
  readonly name: string
  extends: 'standard' | 'none'
  /** Binds the standard texture slots (standard extensions; see MaterialTypeOptions). */
  standardTextures = true
  /** Every field of the material asset (standard fields too, for standard extensions). */
  schema: ComponentDef
  /** The type's own numeric fields, packed into its uniform. Undefined if it has none. */
  layout: WgslLayout<Fields> | undefined
  /** The type's own texture fields, in binding order. */
  textures: string[]
  /** Texture fields bound as 2D arrays. */
  arrays: Set<string>
  /** Texture fields sampled through the sRGB view. */
  colors: Set<string>
  /** Whether picks can hit draws of this type (MaterialTypeOptions.pickable). */
  pickable = true
  blend: BlendMode | undefined
  shader: string | undefined
  /** Noise graphs the module wraps as `noise_<name>`. */
  noise: MaterialNoiseSlot[]
  description: string
  /** Increments on every redefinition, so GPU state and pipelines rebuild. */
  version = 0
  /** Its definition as a string: defining the name again with an equal one is a no-op (0052). */
  signature = ''
  readonly modulePath: string
  /** WGSL identifier of the uniform (the PascalName). */
  readonly varName: string
  private layouts = new WeakMap<GpuContext, { generation: number; layout: GPUBindGroupLayout }>()

  constructor(name: string, options: MaterialTypeOptions<Fields>, schema: ComponentDef) {
    this.name = name
    this.modulePath = materialModulePath(name)
    this.varName = name.slice(name.indexOf('/') + 1)
    this.extends = options.extends ?? 'standard'
    this.schema = schema
    this.layout = undefined
    this.textures = []
    this.arrays = new Set()
    this.colors = new Set()
    this.blend = options.blend
    this.shader = options.shader
    this.noise = []
    this.description = options.description ?? ''
    this.assign(options, schema)
  }

  /** (Re)applies a definition: redefinitions keep the object, so assets keep pointing at it. */
  assign(options: MaterialTypeOptions<Fields>, schema: ComponentDef): void {
    const fields = options.fields ?? {}
    const numeric: Fields = {}
    const textures: string[] = []
    for (const [key, field] of Object.entries(fields)) {
      if (isTextureHandle(field)) textures.push(key)
      else if (field.storage !== 'object') numeric[key] = field
    }
    this.extends = options.extends ?? 'standard'
    this.standardTextures = options.standardTextures ?? true
    this.pickable = options.pickable ?? true
    this.schema = schema
    this.textures = textures
    this.arrays = new Set(options.arrays ?? [])
    this.colors = new Set(options.colors ?? [])
    this.blend = options.blend
    this.shader = options.shader
    this.noise = Object.entries(options.noise ?? {}).map(([name, path]) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
        throw new ShardError(
          'render/material-noise-name',
          `Noise slot "${name}" of ${this.name} isn't a WGSL name`,
          {
            hint: 'Use lowercase letters, digits, and underscores: { detail: "assets/noise/rock.noise.json" }.',
          },
        )
      }
      return { name, path }
    })
    this.description = options.description ?? ''
    this.layout =
      Object.keys(numeric).length > 0
        ? (wgslLayout(defineSchema(`${this.name}Params`, numeric)) as WgslLayout<Fields>)
        : undefined
    this.version++
    this.layouts = new WeakMap()
  }

  get standard(): boolean {
    return this.extends === 'standard'
  }

  /** First group-1 binding of the type's own data. */
  get bindingBase(): number {
    return this.standard ? STANDARD_BINDINGS : 0
  }

  /** The blend mode for a material of this type. */
  blendOf(value: { alphaMode?: string }): BlendMode {
    if (this.blend) return this.blend
    const mode = value.alphaMode
    return mode === 'mask' || mode === 'alpha' || mode === 'premultiplied' || mode === 'additive'
      ? mode
      : 'opaque'
  }

  /** Deferred shading only takes standard lighting, and never transparency. */
  deferrable(value: { alphaMode?: string }): boolean {
    return this.standard && !isTransparent(this.blendOf(value))
  }

  /**
   * The generated `material::<name>` module: uniform struct and bindings, then `noise` (the noise
   * slots' wrappers, once their graphs load).
   */
  moduleSource(noise = ''): string {
    const lines: string[] = []
    let binding = this.bindingBase
    if (this.layout) {
      lines.push(this.layout.wgsl)
      lines.push(
        `@group(1) @binding(${binding++}) var<uniform> ${this.varName}: ${this.layout.structName};`,
      )
    } else {
      binding++ // the uniform binding is reserved either way
    }
    for (const tex of this.textures) {
      const kind = this.arrays.has(tex) ? 'texture_2d_array<f32>' : 'texture_2d<f32>'
      lines.push(`@group(1) @binding(${binding++}) var ${this.varName}_${tex}: ${kind};`)
      lines.push(`@group(1) @binding(${binding++}) var ${this.varName}_${tex}_sampler: sampler;`)
    }
    if (!this.layout && this.textures.length === 0) {
      // WESL needs something to import; a constant keeps the module non-empty.
      lines.push(`const ${this.varName}_fields: u32 = 0u;`)
    }
    if (noise) lines.push(noise)
    return `// Generated from the ${this.name} schema. Don't edit: change the material definition.\n${lines.join('\n')}\n`
  }

  /** The group-1 bind group layout: standard bindings (if extended), own uniform, own textures. */
  bindGroupLayout(gpu: GpuContext, standard: GPUBindGroupLayoutEntry[]): GPUBindGroupLayout {
    const cached = this.layouts.get(gpu)
    if (cached && cached.generation === gpu.generation) return cached.layout
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    const entries: GPUBindGroupLayoutEntry[] = !this.standard
      ? []
      : this.standardTextures
        ? [...standard]
        : standard.filter((e) => e.binding < 2)
    let binding = this.bindingBase
    if (this.layout) entries.push({ binding, visibility, buffer: { type: 'uniform' } })
    binding++
    for (const tex of this.textures) {
      entries.push({
        binding: binding++,
        visibility,
        texture: {
          sampleType: 'float',
          viewDimension: this.arrays.has(tex) ? '2d-array' : '2d',
        },
      })
      entries.push({ binding: binding++, visibility, sampler: { type: 'filtering' } })
    }
    const layout = gpu.layouts.bindGroupLayout({ label: `material/${this.name}`, entries })
    this.layouts.set(gpu, { generation: gpu.generation, layout })
    return layout
  }
}

const types = new Map<string, MaterialType>()
const listeners = new Set<(type: MaterialType) => void>()

/**
 * Declares a material type. Engine types use their package namespace; project code uses
 * `project.material(name, ...)`, which namespaces it. Defining an existing name again (hot reload)
 * updates the type in place: existing assets revalidate and gain new fields' defaults.
 */
export function defineMaterial<const F extends Fields>(
  name: string,
  options: MaterialTypeOptions<F>,
  standardFields?: Fields,
): MaterialType {
  const ext = options.extends ?? 'standard'
  const standard: Fields = standardFields ?? STANDARD_FIELDS
  for (const key of Object.keys(options.fields ?? {})) {
    if (ext === 'standard' && standard[key]) {
      throw new ShardError(
        'render/material-field-clash',
        `Material ${name} redefines the standard field "${key}"`,
        { hint: 'Give the field another name, or use extends: "none".' },
      )
    }
  }
  const fields: Fields = {
    ...(ext === 'standard' ? standard : {}),
    ...(options.fields ?? {}),
  }
  const existing = types.get(name)
  const signature = signatureOf(ext, options as MaterialTypeOptions<Fields>, fields)
  if (existing && !isRedefinable(name)) {
    // Registries are global and apps share the page (0052): the same definition twice is one type.
    if (existing.signature === signature) return existing
    throw new ShardError(
      'render/registry-conflict',
      `Material type ${name} is already defined, differently`,
      {
        hint: 'Two definitions (two apps or bundles) share the name. Rename one, or share the definition.',
      },
    )
  }
  const schema = defineComponent(name, fields, {
    description:
      options.description ??
      `Material type ${name}${ext === 'standard' ? ' (extends the standard material)' : ''}.`,
    serialize: true,
  })
  if (existing) {
    existing.assign(options as MaterialTypeOptions<Fields>, schema)
    existing.signature = signature
    for (const listener of listeners) listener(existing)
    return existing
  }
  const type = new MaterialType(name, options as MaterialTypeOptions<Fields>, schema)
  type.signature = signature
  types.set(name, type)
  return type
}

/** Everything a definition says, as a string: equal strings are the same material type. */
function signatureOf(ext: string, options: MaterialTypeOptions<Fields>, fields: Fields): string {
  return JSON.stringify({
    ext,
    blend: options.blend ?? null,
    shader: options.shader ?? null,
    noise: options.noise ?? {},
    arrays: options.arrays ?? [],
    colors: options.colors ?? [],
    standardTextures: options.standardTextures ?? true,
    pickable: options.pickable ?? true,
    description: options.description ?? null,
    fields: Object.entries(fields).map(([key, field]) => [key, field.jsonSchema()]),
  })
}

export function findMaterialType(name: string): MaterialType | undefined {
  return types.get(name)
}

export function allMaterialTypes(): MaterialType[] {
  return [...types.values()]
}

/** Called with a type whenever it's redefined. Returns an unsubscribe function. */
export function onMaterialTypeChange(fn: (type: MaterialType) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Registers a type as the standard one (it keeps `render/StandardMaterial`'s schema). */
export function registerStandardType(schema: ComponentDef): MaterialType {
  const type = new MaterialType('render/StandardMaterial', { extends: 'standard' }, schema)
  types.set(type.name, type)
  return type
}

export type { AnyField }
