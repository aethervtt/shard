import { t } from '@aethervtt/shard-core'
import { defineDiceFamily } from './material'

// The four families the package ships (0054). Each shades the body; marks, the chamfer, the
// dropped look and the fade are the shared library's. A host adds more with defineDiceFamily.

/** Opaque, one color, a few flecks in the pour. */
export const SOLID = defineDiceFamily('dice/SolidDice', {
  fields: {
    fleck: t.f32({
      default: 0.25,
      min: 0,
      max: 1,
      description: 'How many flecks show in the body.',
    }),
    fleckColor: t.color({ default: [1, 1, 1, 1], description: 'Fleck color (linear).' }),
    fleckScale: t.f32({
      default: 16,
      min: 1,
      description: 'Fleck density, per unit of die radius.',
    }),
  },
  surface: `
  let speck = smoothstep(0.8, 0.88, dice_noise(local * F.fleckScale));
  p.base_color = mix(p.base_color, F.fleckColor.rgb, speck * F.fleck * m.face);`,
  description: 'Solid dice: an opaque body, optional flecks.',
})

/**
 * Translucent-looking resin without transparency: a tonal depth fake. Looking straight into a
 * face sees deep color, swirled through the body; grazing angles and the chamfer catch light like
 * thin resin does. The face on top glows a little once landed.
 */
export const RESIN = defineDiceFamily('dice/ResinDice', {
  fields: {
    resinDeep: t.color({
      default: [0.02, 0.18, 0.2, 1],
      description: 'The deep tone, looking into the body.',
    }),
    resinGlow: t.color({
      default: [0.3, 0.9, 0.82, 1],
      description: 'The light tone, at thin edges.',
    }),
    resinDepth: t.f32({
      default: 0.85,
      min: 0,
      max: 1,
      description: 'How much of the tones replace baseColor.',
    }),
    resinSwirl: t.f32({ default: 0.55, min: 0, max: 1, description: 'Swirl through the pour.' }),
    resinScale: t.f32({
      default: 2.4,
      min: 0.1,
      description: 'Swirl size, per unit of die radius.',
    }),
    resinLight: t.f32({
      default: 2600,
      min: 0,
      unit: 'cd/m²',
      description: 'Light at thin edges.',
    }),
    resinResultGlow: t.f32({
      default: 3000,
      min: 0,
      unit: 'cd/m²',
      description: 'Glow of the marks on top once landed.',
    }),
    resinOpacity: t.f32({
      default: 1,
      min: 0.2,
      max: 1,
      description:
        'Below 1, the resin is see-through: its material blends (no shadow; a contact blob instead).',
    }),
  },
  surface: `
  let nv = clamp(dot(p.normal, v), 0.0, 1.0);
  let swirl = dice_fbm(local * F.resinScale + vec3f(value * 1.7));
  let depth = clamp(pow(nv, 0.6) * (1.0 - 0.5 * F.resinSwirl) + swirl * F.resinSwirl * 0.6, 0.0, 1.0);
  let tone = mix(F.resinGlow.rgb, F.resinDeep.rgb, depth);
  p.base_color = mix(p.base_color, tone, F.resinDepth);
  let thin = pow(1.0 - nv, 3.0) + (1.0 - m.face) * 0.45;
  p.emissive += F.resinGlow.rgb * F.resinLight * thin;
  p.emissive += look.mark_color.rgb * F.resinResultGlow * look.result * m.top * m.coverage;
  p.roughness = min(p.roughness, 0.22);
  p.alpha = F.resinOpacity;`,
  translucent: (params) => typeof params.resinOpacity === 'number' && params.resinOpacity < 1,
  description: 'Resin dice: a tonal depth fake, swirl, glowing thin edges, a lit result face.',
})

/** Metal: tinted by baseColor, brushed, with polished worn edges and enamel marks. */
export const METAL = defineDiceFamily('dice/MetalDice', {
  fields: {
    metalWear: t.f32({ default: 0.6, min: 0, max: 1, description: 'Polished, brighter edges.' }),
    metalGrain: t.f32({
      default: 0.4,
      min: 0,
      max: 1,
      description: 'Brushed streaks in the roughness.',
    }),
  },
  surface: `
  p.metallic = 1.0;
  let grain = dice_noise(local * vec3f(70.0, 2.5, 70.0));
  p.roughness = clamp(p.roughness * (1.0 + (grain - 0.5) * F.metalGrain), 0.05, 1.0);
  let edge = 1.0 - m.face;
  p.roughness = mix(p.roughness, p.roughness * 0.35, edge * F.metalWear);
  p.base_color = mix(p.base_color, min(p.base_color * 1.3 + vec3f(0.04), vec3f(1.0)), edge * F.metalWear);`,
  description: 'Metal dice: brushed, worn bright at the edges, enamel marks.',
})

/**
 * Glass: blended, clear through the middle of a face and bright at grazing angles, with opaque
 * marks. Blended dice cast no shadow, so they get a contact blob on the tray. Always see-through,
 * but not a fixed blend: the large-pool tier draws it opaque, so its dice batch.
 */
export const GLASS = defineDiceFamily('dice/GlassDice', {
  fields: {
    glassClarity: t.f32({
      default: 0.8,
      min: 0,
      max: 1,
      description: 'How clear the body is face-on.',
    }),
    glassSparkle: t.f32({
      default: 0.5,
      min: 0,
      max: 1,
      description: 'Inner glints as the die turns.',
    }),
  },
  translucent: () => true,
  surface: `
  let nv = clamp(dot(p.normal, v), 0.0, 1.0);
  let fresnel = pow(1.0 - nv, 2.5);
  p.alpha = mix(1.0 - F.glassClarity, 0.9, fresnel) * m.face + (1.0 - m.face) * 0.55;
  p.roughness = min(p.roughness, 0.08);
  p.metallic = 0.0;
  let glint = pow(dice_noise(local * 5.0 + v * 2.5), 10.0) * F.glassSparkle;
  p.emissive += p.base_color * glint * 9000.0;
  p.alpha = max(p.alpha, min(1.0, glint * 2.0));`,
  description: 'Glass dice: clear bodies, bright rims, opaque marks.',
})

export const BUILTIN_FAMILIES = [SOLID, RESIN, METAL, GLASS] as const
