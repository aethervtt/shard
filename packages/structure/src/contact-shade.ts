import { t } from '@aethervtt/shard-core'
import { defineMaterial } from '@aethervtt/shard-render'
import { CONTACT_CORE, CONTACT_CORE_BOOST } from './contact'

// The contact shade's material (0068): blended, unlit, its alpha a falloff from the contact line
// with a darker core, its edge wobbled by one octave of world-space value noise. `contactAlpha`
// (contact.ts) is the CPU mirror of `shade`.

/** The material key of the built-in contact shade. */
export const CONTACT_KEY = 'structure:contact'

export const ContactShade = defineMaterial('structure/ContactShade', {
  extends: 'none',
  blend: 'alpha',
  pickable: false,
  fields: {
    opacity: t.f32({ default: 0.2, min: 0, max: 1, description: 'Alpha scale of the falloff.' }),
    maxAlpha: t.f32({ default: 0.42, min: 0, max: 1, description: 'Alpha never goes above this.' }),
    color: t.vec3({
      default: [0.0033, 0.0052, 0.008],
      min: 0,
      description: 'What it darkens toward: linear, display-referred (exposure is undone).',
    }),
    wobble: t.f32({
      default: 0.2,
      min: 0,
      max: 1,
      description: "How far the noise moves the strip's edge, as a share of its reach.",
    }),
  },
  shader: 'structure::contact',
  description:
    "Structure's contact shade (0068): dark strips where walls meet floors and each other. Built in; StructureSettings.contact sets its fields.",
})

export const CONTACT_SHADERS: Record<string, string> = {
  'structure::contact': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import material::contact_shade::ContactShade;

fn contact_hash(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}

fn contact_cell(c: vec2i) -> f32 {
  let h = contact_hash(bitcast<u32>(c.x) ^ contact_hash(bitcast<u32>(c.y)));
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

/** One octave of value noise in [0, 1]. */
fn contact_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let c = vec2i(i);
  return mix(
    mix(contact_cell(c), contact_cell(c + vec2i(1, 0)), u.x),
    mix(contact_cell(c + vec2i(0, 1)), contact_cell(c + vec2i(1, 1)), u.x),
    u.y,
  );
}

/** u is fade: 0 at the contact line, 1 at the reach. */
override fn shade(in: VertexOutput) -> vec4f {
  let p = in.world_position;
  // World space, so strips meet across chunks and walls; y folds in for the corner strips.
  let n = contact_noise(vec2f(p.x + p.y * 0.61, p.z - p.y * 0.83) / 0.6);
  let wobble = clamp(ContactShade.wobble, 0.0, 1.0);
  let fade = in.uv.x;
  let f = clamp(fade * (1.0 + wobble * (2.0 * n - 1.0)), 0.0, 1.0);
  let falloff = 1.0 - smoothstep(0.0, 1.0, f);
  let core = 1.0 - smoothstep(0.0, ${CONTACT_CORE.toFixed(2)}, f);
  let edge = 1.0 - smoothstep(0.8, 1.0, fade);
  let alpha = ContactShade.opacity * (falloff * (0.8 + 0.2 * falloff) + core * ${CONTACT_CORE_BOOST.toFixed(2)}) * (0.94 + 0.12 * n);
  return vec4f(ContactShade.color / max(view.exposure, 1e-12), min(ContactShade.maxAlpha, alpha) * edge);
}`,
}
