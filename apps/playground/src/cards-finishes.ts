import { defineCardFinish } from '@aethervtt/shard-cards'
import { t } from '@aethervtt/shard-core'

// These finishes live in the host, not the package. They use the public extension contract.
export const amberEtching = defineCardFinish('atelier/AmberEtching', {
  response: 'return vec2f(0.5, mix(0.42, 0.2, ctx.params.z));',
  description: 'Engraved amber lines and a warm metallic light sweep.',
  fields: {
    warmth: t.f32({ default: 0.8 }),
    detail: t.f32({ default: 75 }),
    shine: t.f32({ default: 0.85 }),
  },
  surface: `
    let wave = sin(ctx.uv.y * 13.0 + ctx.uv.x * 8.0) * 0.13;
    let lines = pow(0.5 + 0.5 * sin((ctx.uv.x + wave) * ctx.params.y + ctx.shift.x * 4.0), 8.0);
    let sheen = pow(max(0.0, sin((ctx.uv.x * 0.65 + ctx.uv.y) * 3.0 + ctx.shift.x * 2.5 + ctx.shift.y)), 5.0);
    let gold = mix(vec3f(0.62, 0.30, 0.06), vec3f(1.0, 0.87, 0.49), sheen);
    let rainbow = card_spectrum(ctx.uv.y * 2.0 + ctx.shift.x + ctx.shift.y * 0.3);
    return base * (0.86 + gold * 0.2) + (gold * sheen * 0.65 + rainbow * lines * 0.12 + gold * ctx.glare * 0.45) * ctx.params.z;`,
})
export const celestialPrism = defineCardFinish('atelier/CelestialPrism', {
  response: 'return vec2f(0.38, 0.28);',
  description: 'A moving prism spectrum with curved aurora bands and celestial glints.',
  fields: { scale: t.f32({ default: 2.6 }), depth: t.f32({ default: 0.8 }), phase: t.f32() },
  surface: `
    let curve = sin(ctx.uv.x * 7.0 + ctx.shift.x * 2.0) * 0.16;
    let t = (ctx.uv.y + curve) * ctx.params.x + ctx.shift.y * 0.8 + ctx.shift.x * 0.6 + ctx.params.z;
    let rainbow = card_spectrum(t);
    let ribbons = pow(0.5 + 0.5 * sin(t * 6.2831853), 7.0);
    let blue = mix(vec3f(0.14, 0.35, 1.0), vec3f(0.48, 1.0, 0.8), ribbons);
    return base * (0.7 + rainbow * 0.5) + (rainbow * (0.18 + ribbons * 0.4) + blue * ctx.glare * 0.55) * ctx.params.y;`,
})
export const meadowOpal = defineCardFinish('atelier/MeadowOpal', {
  response: 'return vec2f(0.18, 0.34);',
  description: 'Soft peach, mint and lilac pearl over flowers, with filtered pollen glints.',
  fields: { scale: t.f32({ default: 2 }), pearl: t.f32({ default: 0.7 }), phase: t.f32() },
  surface: `
    let t = ctx.uv.y * ctx.params.x + sin(ctx.uv.x * 9.0) * 0.12 + dot(ctx.shift, vec2f(0.5, 0.7)) + ctx.params.z;
    let pearl = mix(card_spectrum(t), vec3f(1.0, 0.94, 0.86), 0.55);
    let beam = pow(0.5 + 0.5 * cos((ctx.uv.x + ctx.uv.y * 0.7 + ctx.shift.x) * 6.0), 9.0);
    return base * (0.91 + pearl * 0.18) + pearl * (beam * 0.3 + ctx.glare * 0.4 + ctx.grazing * 0.16) * ctx.params.y;`,
})
export const ATELIER_FINISHES = [amberEtching, celestialPrism, meadowOpal]
