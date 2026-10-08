import { t } from '@aethervtt/shard-core'
import { defineMaterial } from '@aethervtt/shard-render'

/**
 * Vegetation and stone for scatter items (0045): the standard material, tinted by the part code
 * the engine generators write in the second uv set (x: 0 bark/base to 1 leaf/tip, y: a per-vertex
 * shade), and swayed by the wind (scaled by the part code, so trunks and roots stay put).
 */
export const Vegetation = defineMaterial('scatter/Vegetation', {
  fields: {
    baseTint: t.color({
      default: [0.36, 0.27, 0.19, 1],
      description: 'Color at part 0 (bark, stone, a blade’s root), times baseColor.',
    }),
    tipTint: t.color({
      default: [0.32, 0.55, 0.18, 1],
      description: 'Color at part 1 (leaves, a blade’s tip), times baseColor.',
    }),
    shade: t.f32({
      default: 0.25,
      min: 0,
      max: 1,
      description: 'How much the per-vertex shade varies brightness (±).',
    }),
    sway: t.f32({
      default: 0,
      min: 0,
      description: 'Wind response: metres a tip moves at wind strength 1 (0: still).',
    }),
    windDirection: t.vec3({
      default: [1, 0, 0],
      description: 'World-space wind direction (the Wind resource writes it each frame).',
    }),
    windStrength: t.f32({ default: 1, min: 0, description: 'Written from the Wind resource.' }),
    gustScale: t.f32({
      default: 0.05,
      min: 0,
      unit: '1/m',
      description: 'Gust waves per metre (written from the Wind resource).',
    }),
  },
  shader: 'scatter::vegetation',
  plugin: 'scatterPlugin',
  description:
    'Scatter items’ material: the standard material tinted from base to tip by the generators’ part codes (uv1), with wind sway on the tips. Engine generator items get one by default.',
})

/**
 * The sway every scatter material shares: a world-space wind vector, made tangent to the item's
 * up axis, moved into object space, scaled by the vertex's part code squared (roots don't move).
 */
export const SWAY_WGSL = (u: string) => `
/** An integer hash to [0, 1) (no trig: this runs for every vertex of every blade). */
fn scatter_hash(c: vec2i) -> f32 {
  var h = bitcast<u32>(c.x) * 747796405u + bitcast<u32>(c.y) * 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32((h >> 22u) ^ h) * (1.0 / 4294967296.0);
}

/** Smooth gusts in [0, 1]: value noise moving downwind. */
fn scatter_gust(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let s = f * f * (3.0 - 2.0 * f);
  let c = vec2i(i);
  let a = mix(scatter_hash(c), scatter_hash(c + vec2i(1, 0)), s.x);
  let b = mix(scatter_hash(c + vec2i(0, 1)), scatter_hash(c + vec2i(1, 1)), s.x);
  return mix(a, b, s.y);
}

fn scatter_sway(position: vec3f) -> vec3f {
  let amount = ${u}.sway * ${u}.windStrength;
  if (amount <= 0.0) { return position; }
  let part = vertex_uv1().x;
  // The instance's axes and origin, straight from its transform's rows.
  let inst = mesh_current_instance;
  let ex = vec3f(inst.row0.x, inst.row1.x, inst.row2.x);
  let ey = vec3f(inst.row0.y, inst.row1.y, inst.row2.y);
  let ez = vec3f(inst.row0.z, inst.row1.z, inst.row2.z);
  let origin = vec3f(inst.row0.w, inst.row1.w, inst.row2.w);
  let up = normalize(ey);
  var wind = ${u}.windDirection;
  wind = wind - up * dot(wind, up);
  let len = length(wind);
  if (len < 1e-5) { return position; }
  wind = wind / len;
  // Gusts sweep downwind; a fast flutter rides on them.
  let side = cross(up, wind);
  let along = vec2f(dot(origin, wind), dot(origin, side)) * ${u}.gustScale;
  let gust = scatter_gust(along - vec2f(globals.time * 0.6, 0.0));
  let flutter = sin(globals.time * 3.1 + dot(origin, vec3f(0.37, 0.21, 0.43)) * 2.0) * 0.25;
  let push = amount * part * part * (0.35 + 0.65 * gust + flutter * 0.3);
  let w = wind * push;
  // World direction to object space (rows of a rotation times uniform scale).
  let local = vec3f(dot(ex, w) / dot(ex, ex), dot(ey, w) / dot(ey, ey), dot(ez, w) / dot(ez, ez));
  // Bending down as it leans keeps the blade's length.
  return position + local - vec3f(0.0, 0.5 * dot(local, local) * part, 0.0);
}
`

export const SCATTER_SHADERS: Record<string, string> = {
  'scatter::vegetation': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::globals::globals;
import shard::mesh::{ vertex_uv1, mesh_current_instance };
import material::vegetation::Vegetation;
${SWAY_WGSL('Vegetation')}
override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  return scatter_sway(position);
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let tint = mix(Vegetation.baseTint.rgb, Vegetation.tipTint.rgb, clamp(in.uv1.x, 0.0, 1.0));
  let shade = 1.0 + Vegetation.shade * (in.uv1.y * 2.0 - 1.0);
  p.base_color = p.base_color * tint * shade;
  return p;
}
`,
}

/** Default looks per engine generator: tints, roughness, sway. */
export const GENERATOR_LOOKS: Record<
  string,
  { baseTint: number[]; tipTint: number[]; roughness: number; sway: number; doubleSided?: boolean }
> = {
  'shard/Rock': {
    baseTint: [0.42, 0.4, 0.37, 1],
    tipTint: [0.42, 0.4, 0.37, 1],
    roughness: 0.9,
    sway: 0,
  },
  'shard/Tree': {
    baseTint: [0.3, 0.22, 0.15, 1],
    tipTint: [0.22, 0.42, 0.12, 1],
    roughness: 0.8,
    sway: 0.06,
    doubleSided: true,
  },
  'shard/Bush': {
    baseTint: [0.28, 0.21, 0.14, 1],
    tipTint: [0.2, 0.38, 0.13, 1],
    roughness: 0.85,
    sway: 0.05,
    doubleSided: true,
  },
  'shard/GrassClump': {
    baseTint: [0.12, 0.22, 0.06, 1],
    tipTint: [0.42, 0.58, 0.2, 1],
    roughness: 0.75,
    sway: 0.12,
    doubleSided: true,
  },
  'shard/Crystal': {
    baseTint: [0.35, 0.55, 0.75, 1],
    tipTint: [0.7, 0.9, 1, 1],
    roughness: 0.15,
    sway: 0,
  },
}
