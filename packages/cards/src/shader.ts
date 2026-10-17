import type { CardFinish } from './finishes'
import { CARD_MOTION_WGSL } from './motion'

export function cardShader(
  finishes: readonly CardFinish[],
  module: string,
  uniform: string,
  lighting: 'pbr' | 'unlit',
): string {
  const bodies = finishes
    .map(
      (f, i) =>
        `fn finish_${i + 1}(ctx: CardFinishContext, base: vec3f) -> vec3f { ${f.options.surface} }`,
    )
    .join('\n')
  const cases = finishes
    .map((_, i) => `case ${i + 1}u: { return finish_${i + 1}(ctx, base); }`)
    .join('\n')
  const responses = finishes
    .map(
      (f, i) =>
        `fn response_${i + 1}(ctx: CardFinishContext, current: vec2f) -> vec2f { ${f.options.response ?? 'return vec2f(0.35, 0.28);'} }`,
    )
    .join('\n')
  const responseCases = finishes
    .map((_, i) => `case ${i + 1}u: { return response_${i + 1}(ctx, current); }`)
    .join('\n')
  return `
import shard::pbr::types::{ VertexOutput, PbrInput };
${lighting === 'pbr' ? 'import shard::pbr::standard::material;' : ''}
import shard::view::view;
import shard::mesh::vertex_instance_data;
import ${module}::{ ${uniform}, ${uniform}_art, ${uniform}_art_sampler, ${uniform}_masks, ${uniform}_masks_sampler, ${uniform}_records };

struct CardFinishContext {
  uv: vec2f, art_uv: vec2f, footprint: vec2f,
  normal: vec3f, view: vec3f, light: vec3f,
  shift: vec2f, pointer: vec2f, params: vec4f,
  facing: f32, grazing: f32, glare: f32, seed: f32, time: f32,
}
fn card_spectrum(t: f32) -> vec3f {
  return 0.5 + 0.5 * cos(6.2831853 * (vec3f(t) + vec3f(0.0, 0.33, 0.67)));
}
fn card_hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
${CARD_MOTION_WGSL}
${bodies}
${responses}
struct CardSurface { color: vec3f, response: vec2f }
fn card_response(kind: u32, ctx: CardFinishContext, current: vec2f) -> vec2f {
  switch kind { ${responseCases} default: { return current; } }
}
fn card_finish(kind: u32, ctx: CardFinishContext, base: vec3f) -> vec3f {
  switch kind { ${cases} default: { return base; } }
}
fn record(slot: i32, field: i32) -> vec4f {
  return textureLoad(${uniform}_records, vec2i(field, slot), 0);
}
override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  return vec4f(vertex_instance_data(), 0.0, 0.0);
}
fn card_surface(in: VertexOutput) -> CardSurface {
  let uvDx = dpdx(in.uv);
  let uvDy = dpdy(in.uv);
  let slot = i32(round(in.extra.x));
  let side = i32(round(in.uv1.x));
  let cardData = record(slot, 0);
  let edge = record(slot, 1);
  if (side == 2) { return CardSurface(edge.rgb, vec2f(0.0, 0.85)); }
  let start = 4 + side * 20;
  let face = record(slot, start);
  let crop = record(slot, start + 1);
  let background = record(slot, start + 2);
  let controls = record(slot, 2);
  let motion = record(slot, 3);
  var pointer = controls.xy * controls.z;
  if (motion.x > 0.5) {
    pointer = card_motion(${uniform}.automaticClock, motion.y, motion.z, motion.w);
  }
  var uv = in.uv;
  var fitDx = uvDx;
  var fitDy = uvDy;
  let turns = u32(face.w);
  if (turns == 1u) { uv = vec2f(uv.y, 1.0 - uv.x); fitDx = vec2f(uvDx.y, -uvDx.x); fitDy = vec2f(uvDy.y, -uvDy.x); }
  if (turns == 2u) { uv = vec2f(1.0) - uv; fitDx = -uvDx; fitDy = -uvDy; }
  if (turns == 3u) { uv = vec2f(1.0 - uv.y, uv.x); fitDx = vec2f(-uvDx.y, uvDx.x); fitDy = vec2f(-uvDy.y, uvDy.x); }
  var fitted = uv;
  var faceAspect = cardData.z;
  if (turns == 1u || turns == 3u) { faceAspect = 1.0 / faceAspect; }
  let ratio = face.z * crop.z / max(crop.w, 0.001) / faceAspect;
  if (face.y < 1.5) {
    let cover = face.y > 0.5;
    if ((ratio > 1.0) != cover) { fitted.y = (uv.y - 0.5) * ratio + 0.5; fitDx.y *= ratio; fitDy.y *= ratio; }
    else { fitted.x = (uv.x - 0.5) / max(ratio, 0.001) + 0.5; fitDx.x /= max(ratio, 0.001); fitDy.x /= max(ratio, 0.001); }
  }
  let inside = all(fitted >= vec2f(0.0)) && all(fitted <= vec2f(1.0));
  let artUV = crop.xy + clamp(fitted, vec2f(0.0), vec2f(1.0)) * crop.zw;
  let art = textureSampleGrad(${uniform}_art, ${uniform}_art_sampler, artUV, i32(face.x), fitDx * crop.zw, fitDy * crop.zw);
  var base = background.rgb;
  if (inside && face.x > 0.0) { base = mix(base, art.rgb, art.a); }
  let n = normalize(in.world_normal);
  let v = normalize(view.cameraPosition - in.world_position);
  var light = normalize(${uniform}.light.xyz);
  if (motion.x > 0.5) {
    light = normalize(light + vec3f(pointer.x, -pointer.y, 0.0) * 0.85);
  }
  let facing = max(0.0, dot(n, v));
  let grazing = pow(1.0 - facing, 2.0);
  let shift = n.xy * 2.7 + v.xy * 0.8 + pointer * select(0.3, 0.8, motion.x > 0.5) + light.xy * 0.6;
  let glare = pow(max(0.0, dot(n, normalize(v + light))), 24.0);
  var ctx = CardFinishContext(in.uv, artUV, abs(uvDx) + abs(uvDy), n, v, light, shift,
    pointer, vec4f(0.0), facing, grazing, glare, cardData.w, ${uniform}.clock);
  var response = vec2f(0.0, mix(0.85, 0.18, ${uniform}.gloss));
  for (var i = 0; i < 4; i++) {
    let layer = record(slot, start + 3 + i * 4);
    let params = record(slot, start + 4 + i * 4);
    let transform = record(slot, start + 5 + i * 4);
    let flags = record(slot, start + 6 + i * 4);
    var maskUV = in.uv;
    var maskDx = uvDx;
    var maskDy = uvDy;
    if (flags.z > 0.5) { maskUV = artUV; maskDx = fitDx * crop.zw; maskDy = fitDy * crop.zw; }
    maskUV = maskUV * transform.xy + transform.zw;
    let rgba = textureSampleGrad(${uniform}_masks, ${uniform}_masks_sampler, maskUV, i32(layer.z), maskDx * transform.xy, maskDy * transform.xy);
    var maskValue = rgba[u32(flags.x)];
    if (flags.y > 0.5) { maskValue = 1.0 - maskValue; }
    if (flags.z > 0.5 && !inside) { maskValue = 0.0; }
    let coverage = clamp(maskValue * layer.y * cardData.x, 0.0, 1.0);
    if (${uniform}.maskView > 0.5 && i == i32(${uniform}.maskView) - 1) {
      return CardSurface(vec3f(maskValue), vec2f(0.0, 1.0));
    }
    ctx.params = params;
    let result = card_finish(u32(layer.x), ctx, base);
    base = mix(base, result, coverage);
    let nextResponse = card_response(u32(layer.x), ctx, response);
    response = mix(response, clamp(nextResponse, vec2f(0.0, 0.045), vec2f(1.0)), coverage);
  }
  ${lighting === 'unlit' ? `base += vec3f(glare * ${uniform}.gloss * 0.12);` : ''}
  return CardSurface(base, response);
}
${
  lighting === 'pbr'
    ? `
override fn pbr_input(in: VertexOutput) -> PbrInput {
  let surface = card_surface(in);
  var p: PbrInput;
  p.base_color = clamp(surface.color * material.baseColor.rgb, vec3f(0.0), vec3f(1.0));
  p.alpha = 1.0;
  p.normal = normalize(in.world_normal);
  p.metallic = surface.response.x;
  p.roughness = surface.response.y;
  p.emissive = vec3f(0.0);
  p.occlusion = 1.0;
  return p;
}`
    : `
override fn shade(in: VertexOutput) -> vec4f {
  return vec4f(max(card_surface(in).color, vec3f(0.0)) * ${uniform}.luminance, 1.0);
}`
}
`
}
