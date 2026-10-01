/** WGSL for MSDF text (see render.ts). */
export const TEXT_SHADERS: Record<string, string> = {
  'shard::text': `
import shard::color::linear_to_srgb;

struct TextView {
  view_proj: mat4x4f,
  /** The camera's right and up in world space (billboards). */
  right: vec4f,
  up: vec4f,
  /** width, height, 1 / width, 1 / height. */
  viewport: vec4f,
}

struct Glyph {
  /** x, y (bottom left), width, height, in em. */
  rect: vec4f,
  /** u0, v0 (top left), u1, v1. */
  uv: vec4f,
  text: u32,
  /** Atlas pixels per em ÷ distance range: em → distance units. */
  em_to_sd: f32,
  /** Distance range in atlas pixels. */
  range: f32,
  _pad: f32,
}

struct TextRecord {
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  color: vec4f,
  outline_color: vec4f,
  shadow_color: vec4f,
  /** size, outline width (em), shadow softness, weight. */
  style: vec4f,
  shadow_offset: vec2f,
  billboard: u32,
  screen: u32,
  /** Screen text: corner factor (xy), offset in pixels (zw). */
  placement: vec4f,
}

@group(0) @binding(0) var<uniform> text_view: TextView;
@data @group(1) @binding(0) var<storage, read> glyphs: array<Glyph>;
@data @group(1) @binding(1) var<storage, read> texts: array<TextRecord>;
@group(2) @binding(0) var atlas: texture_2d<f32>;
@group(2) @binding(1) var atlas_sampler: sampler;

struct TextOutput {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  /** The glyph's uv rect: samples clamp to it, so neighbors in the atlas never show. */
  @location(1) @interpolate(flat) bounds: vec4f,
  /** uv per em (x, y), for the shadow offset. */
  @location(2) @interpolate(flat) uv_per_em: vec2f,
  @location(3) @interpolate(flat) glyph: u32,
}

fn corner(k: u32) -> vec2f {
  let c = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  return c[k];
}

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> TextOutput {
  let g = glyphs[i];
  let t = texts[g.text];
  let c = corner(v);
  // Grow the quad so a shadow offset fits; uvs extrapolate and samples clamp to the glyph.
  let pad = abs(t.shadow_offset) + vec2f(t.style.z * 0.1 + t.style.y);
  let x = g.rect.x - pad.x + c.x * (g.rect.z + 2.0 * pad.x);
  let y = g.rect.y + g.rect.w + pad.y - c.y * (g.rect.w + 2.0 * pad.y);
  let fx = (x - g.rect.x) / max(g.rect.z, 1e-6);
  let fy = (g.rect.y + g.rect.w - y) / max(g.rect.w, 1e-6);
  var out: TextOutput;
  out.uv = vec2f(mix(g.uv.x, g.uv.z, fx), mix(g.uv.y, g.uv.w, fy));
  out.bounds = vec4f(min(g.uv.xy, g.uv.zw), max(g.uv.xy, g.uv.zw));
  out.uv_per_em = vec2f((g.uv.z - g.uv.x) / max(g.rect.z, 1e-6), (g.uv.w - g.uv.y) / max(g.rect.w, 1e-6));
  out.glyph = i;
  let p = vec2f(x, y) * t.style.x;
  @if(SCREEN) {
    let origin = t.placement.xy * text_view.viewport.xy + t.placement.zw;
    let px = origin + vec2f(p.x, -p.y);
    out.clip = vec4f(px.x * text_view.viewport.z * 2.0 - 1.0, 1.0 - px.y * text_view.viewport.w * 2.0, 0.5, 1.0);
  }
  @if(!SCREEN) {
    var world: vec3f;
    if (t.billboard != 0u) {
      let origin = vec3f(t.row0.w, t.row1.w, t.row2.w);
      let scale = length(vec3f(t.row0.x, t.row1.x, t.row2.x));
      world = origin + (text_view.right.xyz * p.x + text_view.up.xyz * p.y) * scale;
    } else {
      let l = vec4f(p, 0.0, 1.0);
      world = vec3f(dot(t.row0, l), dot(t.row1, l), dot(t.row2, l));
    }
    out.clip = text_view.view_proj * vec4f(world, 1.0);
  }
  return out;
}

fn median(c: vec3f) -> f32 {
  return max(min(c.r, c.g), min(max(c.r, c.g), c.b));
}

/** The distance at a uv; outside the glyph's rect (the padded quad), fully outside. */
fn distance_at(uv: vec2f, bounds: vec4f) -> f32 {
  let d = median(textureSampleLevel(atlas, atlas_sampler, clamp(uv, bounds.xy, bounds.zw), 0.0).rgb);
  let inside = all(uv >= bounds.xy) && all(uv <= bounds.zw);
  return select(0.0, d, inside);
}

/** Straight color × coverage, premultiplied. */
fn layer(c: vec4f, coverage: f32) -> vec4f {
  let a = c.a * coverage;
  return vec4f(c.rgb * a, a);
}

@fragment fn fs(in: TextOutput) -> @location(0) vec4f {
  let g = glyphs[in.glyph];
  let t = texts[g.text];
  // Distance range in screen pixels: how many screen pixels one unit of distance spans.
  let unit_range = vec2f(g.range) / vec2f(textureDimensions(atlas));
  let screen_px = max(0.5 * dot(unit_range, 1.0 / fwidth(in.uv)), 1.0);
  let sd = distance_at(in.uv, in.bounds);
  let bias = t.style.w * g.em_to_sd;
  let fill = clamp(screen_px * (sd - 0.5 + bias) + 0.5, 0.0, 1.0);
  var outline = 0.0;
  if (t.style.y > 0.0) {
    // The field reaches half the range past the edge, and at small sizes one pixel spans much
    // of it: the outline grows only as far as keeps zero distance at zero coverage.
    let grow = min(t.style.y * g.em_to_sd, max(0.5 - 0.5 / screen_px - bias, 0.0));
    outline = clamp(screen_px * (sd - 0.5 + bias + grow) + 0.5, 0.0, 1.0);
  }
  // Shadow (or glow, with no offset): the field shifted, and softened by widening its ramp.
  let shift = vec2f(t.shadow_offset.x, -t.shadow_offset.y) * in.uv_per_em;
  let sd_shadow = distance_at(in.uv - shift, in.bounds);
  let ramp = max(t.style.z * 0.5, 0.5 / screen_px);
  var shadow = 0.0;
  if (t.shadow_color.a > 0.0 && (t.style.z > 0.0 || any(t.shadow_offset != vec2f(0.0)))) {
    shadow = clamp((sd_shadow - 0.5 + bias) / (2.0 * ramp) + 0.5, 0.0, 1.0);
  }
  var c = layer(t.shadow_color, shadow);
  let o = layer(t.outline_color, outline);
  c = o + c * (1.0 - o.a);
  let f = layer(t.color, fill);
  c = f + c * (1.0 - f.a);
  if (c.a <= 0.0) { discard; }
  @if(SCREEN) {
    @if(!SRGB_TARGET) {
      let rgb = c.rgb / c.a;
      c = vec4f(linear_to_srgb(rgb) * c.a, c.a);
    }
  }
  return c;
}`,
}
