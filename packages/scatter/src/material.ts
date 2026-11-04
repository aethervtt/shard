import { t } from '@aethervtt/shard-core'
import { defineMaterial } from '@aethervtt/shard-render'
import { REMOVED_WIND_FIELDS } from '@aethervtt/shard-wind'

/**
 * Vegetation and stone for scatter items (0045): the standard material, tinted by the part code
 * the engine generators write in the second uv set (x: 0 bark/base to 1 leaf/tip, y: a per-vertex
 * shade), and swayed by the wind (wind/Wind through shard::wind; scaled by the part code, so
 * trunks and roots stay put).
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
      description:
        'Wind response: metres a tip moves in a 6 m/s breeze (wind/Wind; 0: still). Scaled by the part code squared.',
    }),
  },
  removed: REMOVED_WIND_FIELDS,
  shader: 'scatter::vegetation',
  plugin: 'scatterPlugin',
  description:
    'Scatter items’ material: the standard material tinted from base to tip by the generators’ part codes (uv1), with wind sway on the tips. Engine generator items get one by default.',
})

export const SCATTER_SHADERS: Record<string, string> = {
  'scatter::vegetation': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::wind::sway::wind_sway;
import material::vegetation::Vegetation;

override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  return wind_sway(position, Vegetation.sway);
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
