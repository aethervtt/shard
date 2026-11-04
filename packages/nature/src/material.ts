import { t } from '@aethervtt/shard-core'
import { defineMaterial } from '@aethervtt/shard-render'
import { SWAY_WGSL } from '@aethervtt/shard-scatter'

/**
 * A `nature/Tree` mesh's material (spec 0095): the standard material for bark (its texture slots
 * hold the bark maps), and `leafTexture` for leaves, chosen by the part code in uv1.x. Leaves cut
 * out by alpha, in shadows and the depth prepass too, with `alphaMode: 'mask'`.
 */
export const TreeMaterial = defineMaterial('nature/Tree', {
  fields: {
    leafTexture: t.handle('Texture', {
      description: 'Leaf card color and alpha (sRGB), cut out below alphaCutoff.',
    }),
    barkTint: t.color({
      default: [1, 1, 1, 1],
      description: 'Times the bark color (baseColor × baseColorTexture).',
    }),
    leafTint: t.color({ default: [1, 1, 1, 1], description: 'Times the leaf texture.' }),
    leafRoughness: t.f32({ default: 0.75, min: 0, max: 1 }),
    shade: t.f32({
      default: 0.2,
      min: 0,
      max: 1,
      description: 'How much each leaf’s random shade varies its brightness (±).',
    }),
    sway: t.f32({
      default: 0.12,
      min: 0,
      description:
        'Wind response: metres a leaf moves at wind strength 1. Branches move less, the trunk not at all.',
    }),
    windDirection: t.vec3({
      default: [1, 0, 0.35],
      description:
        'World-space wind direction (scatter’s Wind resource writes it for scattered trees).',
    }),
    windStrength: t.f32({ default: 1, min: 0, description: '0 calm, 1 a breeze, 2+ a gale.' }),
    gustScale: t.f32({ default: 0.05, min: 0, unit: '1/m', description: 'Gust waves per metre.' }),
  },
  colors: ['leafTexture'],
  shader: 'nature::tree',
  plugin: 'naturePlugin from @aethervtt/shard-nature',
  description:
    'Trees grown by nature/Tree (experimental): bark from the standard texture slots (baseColor, normal, metallicRoughness), leaves from leafTexture, swaying in the wind. Use alphaMode "mask" and doubleSided true.',
})

export const NATURE_SHADERS: Record<string, string> = {
  'nature::tree': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::globals::globals;
import shard::mesh::{ vertex_uv1, mesh_current_instance };
import material::tree::{ Tree, Tree_leafTexture, Tree_leafTexture_sampler };
${SWAY_WGSL('Tree')}
override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  return scatter_sway(position);
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  // Sampled outside the branch: textureSample needs uniform control flow.
  let leaf = textureSample(Tree_leafTexture, Tree_leafTexture_sampler, in.uv);
  if (in.uv1.x > 0.5) {
    let shade = 1.0 + Tree.shade * (in.uv1.y * 2.0 - 1.0);
    p.base_color = Tree.leafTint.rgb * leaf.rgb * shade;
    p.alpha = Tree.leafTint.a * leaf.a;
    p.normal = normalize(in.world_normal);
    p.metallic = 0.0;
    p.roughness = Tree.leafRoughness;
    p.occlusion = 1.0;
  } else {
    p.base_color = p.base_color * Tree.barkTint.rgb;
    p.alpha = 1.0;
  }
  return p;
}
`,
}
