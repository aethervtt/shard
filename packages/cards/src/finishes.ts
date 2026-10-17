import { defineSchema, type Fields, ShardError, t } from '@aethervtt/shard-core'

export interface CardFinishOptions {
  /** Up to four scalar parameters, packed from this schema in declaration order. */
  fields?: Fields
  /** WESL function body. Inputs: ctx (CardFinishContext), base (linear RGB). Return linear RGB reflectance (clamped to [0, 1] in PBR). */
  surface: string
  /** Optional WESL body: ctx and current (metallic, roughness); return vec2f.
   * Coverage blends this response alongside surface color. Never emits light.
   * Default foil response is metallic 0.35, roughness 0.28. Unlit ignores it.
   */
  response?: string
  baseline?: 'same' | 'unsupported'
  animated?: false | { fps: number }
  description?: string
}
export interface CardFinish {
  readonly name: string
  readonly options: CardFinishOptions
  readonly schema: ReturnType<typeof defineSchema>
  readonly keys: readonly string[]
}
/** No global registration: each cardsPlugin owns its finish library. */
export function defineCardFinish(name: string, options: CardFinishOptions): CardFinish {
  if (!/^[\w-]+\/[\w-]+$/.test(name) || !options.surface.trim()) {
    throw new ShardError(
      'cards/invalid-finish',
      'A finish needs a namespaced name and a WESL surface body',
    )
  }
  const fields = options.fields ?? {}
  if (
    options.animated &&
    (!Number.isFinite(options.animated.fps) ||
      options.animated.fps <= 0 ||
      options.animated.fps > 60)
  ) {
    throw new ShardError(
      'cards/finish-animation',
      'Animated finishes must request a frame rate between 0 and 60 FPS, exclusive of zero',
    )
  }
  const keys = Object.keys(fields)
  if (keys.length > 4 || keys.some((key) => fields[key]!.kind !== 'f32')) {
    throw new ShardError('cards/finish-fields', 'A finish accepts up to four f32 parameters')
  }
  const [namespace, local] = name.split('/')
  const schemaName = `${namespace}/${local![0]!.toUpperCase()}${local!.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}Params`
  return { name, options, keys, schema: defineSchema(schemaName, fields) }
}

/** Constructed when the plugin is installed; importing cards registers no shader/material. */
export function builtinCardFinishes(): CardFinish[] {
  return [
    defineCardFinish('cards/metallic', {
      fields: {
        roughness: t.f32({ default: 0.3, min: 0.05, max: 1 }),
        warmth: t.f32({ default: 0.6 }),
      },
      response: 'return vec2f(0.75, ctx.params.x);',
      surface: `
        let shine = pow(max(0.0, dot(ctx.normal, normalize(ctx.view + ctx.light))), mix(110.0, 9.0, ctx.params.x));
        let tint = mix(vec3f(0.7, 0.85, 1.0), vec3f(1.0, 0.65, 0.18), ctx.params.y);
        return base * (0.65 + 0.35 * ctx.facing) + tint * (shine * 1.2 + ctx.grazing * 0.25);`,
    }),
    defineCardFinish('cards/rainbow', {
      fields: {
        scale: t.f32({ default: 2.5 }),
        phase: t.f32(),
        roughness: t.f32({ default: 0.25 }),
      },
      response: 'return vec2f(0.35, ctx.params.z);',
      surface: `
        let p = ctx.uv.x * 0.65 + ctx.uv.y + ctx.shift.x * 0.7 + ctx.shift.y * 0.4;
        let rainbow = card_spectrum(p * ctx.params.x + ctx.params.y);
        return base * (0.82 + rainbow * 0.32) + rainbow * (0.08 + ctx.glare * 0.7 + ctx.grazing * 0.2);`,
    }),
    defineCardFinish('cards/hologram', {
      fields: { roughness: t.f32({ default: 0.25 }), scale: t.f32({ default: 3 }), phase: t.f32() },
      response: 'return vec2f(0.4, ctx.params.x);',
      surface: `
        let wave = sin((ctx.uv.x * 1.3 + ctx.uv.y * 0.7) * 30.0 + ctx.shift.x * 8.0);
        let hue = dot(ctx.uv, vec2f(0.4, 1.0)) * ctx.params.y + ctx.shift.x * 0.8 - ctx.shift.y * 0.5;
        let foil = card_spectrum(hue + ctx.params.z + wave * 0.09);
        return base * (0.72 + foil * 0.45) + foil * (0.14 + ctx.glare * 0.9);`,
    }),
    defineCardFinish('cards/sparkle', {
      fields: {
        density: t.f32({ default: 120, min: 1, max: 300 }),
        phase: t.f32(),
        intensity: t.f32({ default: 1 }),
      },
      surface: `
        let cell = floor(ctx.uv * ctx.params.x);
        let rnd = card_hash(cell + vec2f(ctx.seed));
        let pos = fract(ctx.uv * ctx.params.x) - vec2f(0.5);
        let pulse = pow(max(0.0, sin(rnd * 120.0 + dot(ctx.shift, vec2f(12.0, 9.0)) + ctx.params.y)), 18.0);
        let star = exp(-length(pos) * 18.0) + exp(-abs(pos.x) * 65.0 - abs(pos.y) * 9.0) * 0.4;
        let filtered = 1.0 - smoothstep(0.5, 1.5, max(ctx.footprint.x, ctx.footprint.y) * ctx.params.x);
        let glitter = star * pulse * filtered * ctx.params.z * 2.5;
        return base + mix(vec3f(1.0), card_spectrum(rnd + ctx.shift.x), 0.55) * glitter;`,
    }),
  ]
}
