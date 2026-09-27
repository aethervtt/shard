import {
  AssetStore,
  defineAssetSchema,
  defineAssetType,
  defineImporter,
  type LoadContext,
} from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  defineSchema,
  type JsonValue,
  ShardError,
} from '@aethervtt/shard-core'
import { MODULES, moduleJsonSchema, validateModule } from './modules'
import { color, invalid, type Rgba, scalar } from './values'

export const SHAPES = ['point', 'sphere', 'cone', 'box'] as const
export const RENDER_MODES = ['billboard', 'stretched', 'axis', 'mesh'] as const
export const PARTICLE_BLENDS = ['additive', 'alpha', 'premultiplied'] as const
export const OFFSCREEN = ['simulate', 'pause', 'reduced'] as const

/** One emitter of an effect, validated and with defaults filled in. */
export interface EmitterDef {
  name: string
  capacity: number
  spawn: {
    rate: number
    bursts: { time: number; count: number; interval: number; cycles: number }[]
  }
  shape: {
    type: (typeof SHAPES)[number]
    radius: number
    angle: number
    size: [number, number, number]
  }
  init: {
    lifetime: [number, number]
    speed: [number, number]
    size: [number, number]
    rotation: [number, number]
    color: [Rgba, Rgba]
  }
  update: Record<string, unknown>[]
  render: {
    mode: (typeof RENDER_MODES)[number]
    blend: (typeof PARTICLE_BLENDS)[number]
    texture: { path?: string; guid?: string } | null
    mesh: { path?: string; guid?: string } | null
    /** Luminance of color 1 (cd/m²). */
    emissive: number
    /** Soft particles: fade over this depth distance (m) at intersections (0: off). */
    softness: number
    /** Stretched mode: length per m/s of speed. */
    stretch: number
    flipbook: { columns: number; rows: number; fps: number }
  }
  offscreen: (typeof OFFSCREEN)[number]
  /** Authored bounds radius (m) for culling; 0 estimates it from speed and lifetime. */
  bounds: number
}

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

function oneOf<T extends readonly string[]>(
  values: T,
  v: unknown,
  path: string,
  errors: ShardError[],
  fallback: T[number],
): T[number] {
  if (v === undefined) return fallback
  if (values.includes(v as string)) return v as T[number]
  errors.push(invalid(path, `Expected one of: ${values.join(', ')}`))
  return fallback
}

function object(v: unknown, path: string, errors: ShardError[]): Record<string, unknown> {
  if (v === undefined) return {}
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  errors.push(invalid(path, 'Expected an object'))
  return {}
}

function ref(
  v: unknown,
  path: string,
  errors: ShardError[],
): { path?: string; guid?: string } | null {
  if (v === undefined || v === null) return null
  if (
    v &&
    typeof v === 'object' &&
    (typeof (v as { path?: unknown }).path === 'string' ||
      typeof (v as { guid?: unknown }).guid === 'string')
  ) {
    return v as { path?: string; guid?: string }
  }
  errors.push(invalid(path, 'Expected an asset reference: { "path": "assets/…" }'))
  return null
}

function emitter(json: unknown, path: string, errors: ShardError[], index: number): EmitterDef {
  const e = object(json, path, errors)
  const spawn = object(e.spawn, `${path}/spawn`, errors)
  const shape = object(e.shape, `${path}/shape`, errors)
  const init = object(e.init, `${path}/init`, errors)
  const render = object(e.render, `${path}/render`, errors)
  const flip = object(render.flipbook, `${path}/render/flipbook`, errors)
  const capacity = num(e.capacity, 1000)
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4_194_304) {
    errors.push(invalid(`${path}/capacity`, 'Capacity must be a whole number from 1 to 4194304'))
  }
  const bursts = Array.isArray(spawn.bursts) ? spawn.bursts : []
  const update = Array.isArray(e.update) ? e.update : []
  if (e.update !== undefined && !Array.isArray(e.update))
    errors.push(invalid(`${path}/update`, 'Expected a list of modules'))
  return {
    name: typeof e.name === 'string' ? e.name : `emitter${index}`,
    capacity: Math.max(1, Math.floor(capacity)),
    spawn: {
      rate: num(spawn.rate, 0),
      bursts: bursts.map((b, i) => {
        const o = object(b, `${path}/spawn/bursts/${i}`, errors)
        return {
          time: num(o.time, 0),
          count: num(o.count, 10),
          interval: num(o.interval, 0),
          cycles: num(o.cycles, 1),
        }
      }),
    },
    shape: {
      type: oneOf(SHAPES, shape.type, `${path}/shape/type`, errors, 'point'),
      radius: num(shape.radius, 0),
      angle: num(shape.angle, 25),
      size: (Array.isArray(shape.size) ? shape.size : [1, 1, 1]) as [number, number, number],
    },
    init: {
      lifetime: scalar(init.lifetime, `${path}/init/lifetime`, errors, 1),
      speed: scalar(init.speed, `${path}/init/speed`, errors, 1),
      size: scalar(init.size, `${path}/init/size`, errors, 0.1),
      rotation: scalar(init.rotation, `${path}/init/rotation`, errors, 0),
      color: color(init.color, `${path}/init/color`, errors),
    },
    update: update
      .map((m, i) => validateModule(m, `${path}/update/${i}`, errors))
      .filter((m) => m !== undefined),
    render: {
      mode: oneOf(RENDER_MODES, render.mode, `${path}/render/mode`, errors, 'billboard'),
      blend: oneOf(PARTICLE_BLENDS, render.blend, `${path}/render/blend`, errors, 'additive'),
      texture: ref(render.texture, `${path}/render/texture`, errors),
      mesh: ref(render.mesh, `${path}/render/mesh`, errors),
      emissive: num(render.emissive, 1000),
      softness: num(render.softness, 0),
      stretch: num(render.stretch, 0.05),
      flipbook: { columns: num(flip.columns, 1), rows: num(flip.rows, 1), fps: num(flip.fps, 0) },
    },
    offscreen: oneOf(OFFSCREEN, e.offscreen, `${path}/offscreen`, errors, 'simulate'),
    bounds: num(e.bounds, 0),
  }
}

/** Validates an effect file; every problem comes back with its JSON pointer. */
export function parseEffect(json: unknown): { emitters: EmitterDef[]; errors: ShardError[] } {
  const errors: ShardError[] = []
  const root = object(json, '', errors)
  const list = root.emitters
  if (!Array.isArray(list) || list.length === 0) {
    errors.push(
      invalid(
        '/emitters',
        'An effect needs at least one emitter',
        'Add "emitters": [{ "name": "sparks", … }].',
      ),
    )
    return { emitters: [], errors }
  }
  return { emitters: list.map((e, i) => emitter(e, `/emitters/${i}`, errors, i)), errors }
}

/** A loaded effect: its emitters, and texture and mesh refs resolved. */
export class ParticleEffect {
  emitters: EmitterDef[]
  /** Bumps on hot reload: running systems keep their particles and pick up the new rules. */
  version = 0

  constructor(emitters: EmitterDef[]) {
    this.emitters = emitters
  }

  static fromJson(json: unknown, resolve?: (path: string) => AssetRef | undefined): ParticleEffect {
    const { emitters, errors } = parseEffect(json)
    if (errors.length > 0) {
      const first = errors[0]!
      throw new ShardError('particles/invalid-effect', first.message, {
        path: first.path,
        hint: first.hint,
        details: errors,
      })
    }
    for (const e of emitters) {
      if (e.render.texture?.path && resolve)
        e.render.texture = resolve(e.render.texture.path) ?? e.render.texture
      if (e.render.mesh?.path && resolve)
        e.render.mesh = resolve(e.render.mesh.path) ?? e.render.mesh
    }
    return new ParticleEffect(emitters)
  }

  copyFrom(next: ParticleEffect): void {
    this.emitters = next.emitters
    this.version++
  }
}

export class ParticleEffectStore extends AssetStore<ParticleEffect, 'ParticleEffect'> {
  constructor() {
    super('ParticleEffect')
  }
}

export const ParticleEffects = defineResource<ParticleEffectStore>('particles/ParticleEffects', {
  description: 'Loaded particle effects by guid.',
  init: () => new ParticleEffectStore(),
})

export const ParticleEffectAssetType = defineAssetType<ParticleEffect>('ParticleEffect', {
  store: ParticleEffects,
  load: (artifact, ctx: LoadContext) =>
    ParticleEffect.fromJson(artifact.json, (p) => ctx.resolve(p)),
  update: (existing, next) => existing.copyFrom(next),
})

const NoSettings = defineSchema(
  'particles/NoSettings',
  {},
  { description: 'None: the effect is the file.' },
)

/** `*.particles.json`: an effect, validated with pointers into the file. */
export const ParticleEffectImporter = defineImporter({
  name: 'particles',
  version: 1,
  extensions: ['.particles.json'],
  settings: NoSettings,
  async import(source) {
    let json: unknown
    try {
      json = JSON.parse(source.text())
    } catch (cause) {
      throw new ShardError('assets/import-failed', `${source.path} isn't valid JSON`, {
        path: source.path,
        cause,
      })
    }
    if (json && typeof json === 'object' && '$schema' in json) {
      const { $schema: _, ...rest } = json as Record<string, unknown>
      json = rest
    }
    const { emitters, errors } = parseEffect(json)
    if (errors.length > 0) {
      const first = errors[0]!
      throw new ShardError(
        'assets/import-failed',
        `${source.path}: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
        { path: first.path, hint: first.hint, details: errors },
      )
    }
    const dependencies = new Set<string>()
    for (const e of emitters) {
      if (e.render.texture?.path) dependencies.add(e.render.texture.path)
      if (e.render.mesh?.path && !e.render.mesh.path.startsWith('procedural:'))
        dependencies.add(e.render.mesh.path)
    }
    return {
      assets: [
        {
          label: '',
          type: 'ParticleEffect',
          json: json as JsonValue,
          ...(dependencies.size ? { dependencies: [...dependencies] } : {}),
          info: {
            emitters: emitters.length,
            capacity: emitters.reduce((n, e) => n + e.capacity, 0),
          },
        },
      ],
    }
  },
})

/** The effect file's JSON Schema, from the module registry. */
export function particleEffectJsonSchema(): Record<string, unknown> {
  const scalar = {
    anyOf: [
      { type: 'number' },
      { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    ],
    description: 'A number, or a [min, max] range picked per particle.',
  }
  const colorForm = {
    anyOf: [
      { type: 'string', pattern: '^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' },
      { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 4 },
      { type: 'array', minItems: 2, maxItems: 2 },
    ],
    description: '"#rrggbb" (sRGB), [r, g, b, a] (linear), or a range of two colors.',
  }
  const ref = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Particle effect (*.particles.json)',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      emitters: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            capacity: { type: 'integer', minimum: 1, description: 'Most particles alive at once.' },
            spawn: {
              type: 'object',
              properties: {
                rate: { type: 'number', description: 'Particles per second.' },
                bursts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      time: { type: 'number' },
                      count: { type: 'number' },
                      interval: { type: 'number', description: 'Seconds between repeats.' },
                      cycles: { type: 'number', description: 'Repeats (0: forever).' },
                    },
                  },
                },
              },
            },
            shape: {
              type: 'object',
              properties: {
                type: { enum: SHAPES },
                radius: { type: 'number' },
                angle: { type: 'number', description: 'Cone half-angle, degrees.' },
                size: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
              },
            },
            init: {
              type: 'object',
              properties: {
                lifetime: scalar,
                speed: scalar,
                size: scalar,
                rotation: scalar,
                color: colorForm,
              },
            },
            update: {
              type: 'array',
              items: { oneOf: Object.values(MODULES).map(moduleJsonSchema) },
            },
            render: {
              type: 'object',
              properties: {
                mode: { enum: RENDER_MODES },
                blend: { enum: PARTICLE_BLENDS },
                texture: ref,
                mesh: ref,
                emissive: { type: 'number', description: 'cd/m² of color 1.' },
                softness: {
                  type: 'number',
                  description: 'Depth fade distance (m) at intersections.',
                },
                stretch: { type: 'number' },
                flipbook: {
                  type: 'object',
                  properties: {
                    columns: { type: 'number' },
                    rows: { type: 'number' },
                    fps: { type: 'number' },
                  },
                },
              },
            },
            offscreen: { enum: OFFSCREEN },
            bounds: { type: 'number' },
          },
        },
      },
    },
    required: ['emitters'],
  }
}

export const particleEffectSchema = defineAssetSchema(
  'particle-effect.schema.json',
  particleEffectJsonSchema,
)
