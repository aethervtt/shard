/** WGSL for UI quads: rounded bordered boxes (SDF), images, and MSDF glyphs (see render.ts). */
export const UI_SHADERS: Record<string, string> = {
  'shard::ui': `
import shard::color::linear_to_srgb;

struct UiView {
  /** Target width and height in pixels, then their inverses. */
  size: vec4f,
}

struct Quad {
  /** x, y (top left), width, height, in target pixels. */
  rect: vec4f,
  /** u0, v0, u1, v1. */
  uv: vec4f,
  /** Fill, tint, or glyph color: premultiplied. */
  color: vec4f,
  border_color: vec4f,
  /** Corner radii: top left, top right, bottom right, bottom left. */
  radius: vec4f,
  /** x0, y0, x1, y1 in target pixels: fragments outside are cut. */
  clip: vec4f,
  border: f32,
  /** 0 box, 1 image (straight alpha), 2 image (premultiplied), 3 MSDF glyph. */
  kind: u32,
  /** Glyphs: distance range in atlas pixels. */
  range: f32,
  /** Rotation around the rect's center (arrows). */
  angle: f32,
}

@group(0) @binding(0) var<uniform> ui_view: UiView;
@group(0) @binding(1) var<storage, read> quads: array<Quad>;
@group(1) @binding(0) var ui_texture: texture_2d<f32>;
@group(1) @binding(1) var ui_sampler: sampler;

struct UiOutput {
  @builtin(position) clip: vec4f,
  /** Offset from the rect's center in pixels (unrotated), for the box distance. */
  @location(0) local: vec2f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) quad: u32,
}

fn corner(k: u32) -> vec2f {
  let c = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  return c[k];
}

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> UiOutput {
  let q = quads[i];
  let c = corner(v);
  let half = q.rect.zw * 0.5;
  // One pixel of margin so the antialiased edge isn't cut.
  let grow = select(vec2f(1.0), vec2f(0.0), q.kind == 3u);
  let local = (c * 2.0 - 1.0) * (half + grow);
  let cs = cos(q.angle);
  let sn = sin(q.angle);
  let p = q.rect.xy + half + vec2f(local.x * cs - local.y * sn, local.x * sn + local.y * cs);
  var out: UiOutput;
  out.clip = vec4f(p.x * ui_view.size.z * 2.0 - 1.0, 1.0 - p.y * ui_view.size.w * 2.0, 0.5, 1.0);
  out.local = local;
  let f = clamp((local + half) / max(q.rect.zw, vec2f(1e-6)), vec2f(0.0), vec2f(1.0));
  out.uv = mix(q.uv.xy, q.uv.zw, f);
  out.quad = i;
  return out;
}

/** Signed distance to a box of half size b with per-corner radii (tl, tr, br, bl), y down. */
fn rounded_box(p: vec2f, b: vec2f, r: vec4f) -> f32 {
  let radius = select(r.xw, r.yz, p.x > 0.0);
  let k = select(radius.x, radius.y, p.y > 0.0);
  let q = abs(p) - b + vec2f(k);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - k;
}

fn median(c: vec3f) -> f32 {
  return max(min(c.r, c.g), min(max(c.r, c.g), c.b));
}

@fragment fn fs(in: UiOutput) -> @location(0) vec4f {
  // Sampled up front: derivatives need uniform control flow.
  let texel = textureSample(ui_texture, ui_sampler, in.uv);
  let uv_width = fwidth(in.uv);
  let q = quads[in.quad];
  // In the fragment stage, position is the pixel's center in target pixels.
  let frag = in.clip;
  if (frag.x < q.clip.x || frag.y < q.clip.y || frag.x >= q.clip.z || frag.y >= q.clip.w) {
    discard;
  }
  let half = q.rect.zw * 0.5;
  var c: vec4f;
  if (q.kind == 3u) {
    let unit_range = vec2f(q.range) / vec2f(textureDimensions(ui_texture));
    let screen_px = max(0.5 * dot(unit_range, 1.0 / uv_width), 1.0);
    let fill = clamp(screen_px * (median(texel.rgb) - 0.5) + 0.5, 0.0, 1.0);
    c = q.color * fill;
  } else {
    let r = min(q.radius, vec4f(min(half.x, half.y)));
    let d = rounded_box(in.local, half, r);
    let edge = clamp(0.5 - d, 0.0, 1.0);
    if (q.kind == 0u) {
      var inside = edge;
      if (q.border > 0.0) {
        let inner = rounded_box(in.local, max(half - vec2f(q.border), vec2f(0.0)), max(r - vec4f(q.border), vec4f(0.0)));
        inside = clamp(0.5 - inner, 0.0, 1.0);
      }
      c = q.color * inside + q.border_color * max(edge - inside, 0.0);
    } else {
      var t = texel;
      if (q.kind == 1u) { t = vec4f(t.rgb * t.a, t.a); }
      c = t * q.color * edge;
    }
  }
  if (c.a <= 0.0) { discard; }
  @if(!SRGB_TARGET) {
    let rgb = c.rgb / c.a;
    c = vec4f(linear_to_srgb(rgb) * c.a, c.a);
  }
  return c;
}`,
}
