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
  /** Fill, tint, glyph, or shadow color: premultiplied. */
  color: vec4f,
  /** Border color; a glyph's shadow color. Premultiplied. */
  border_color: vec4f,
  /** Corner radii: top left, top right, bottom right, bottom left. */
  radius: vec4f,
  /** x0, y0, x1, y1 in target pixels: fragments outside are cut. */
  clip: vec4f,
  border: f32,
  /**
   * 0 box, 1 image (straight alpha), 2 image (premultiplied), 3 MSDF glyph, 4 box with a linear
   * gradient, 5 box with a radial gradient, 6 shadow, 7 glow.
   */
  kind: u32,
  /** Glyphs: distance range in atlas pixels. */
  range: f32,
  /** Rotation around the rect's center (arrows). */
  angle: f32,
  /** Corner cuts (same order as radius): horizontal and vertical sizes. */
  cut_x: vec4f,
  cut_y: vec4f,
  /** A gradient's end color; a glyph's outline color. Premultiplied. */
  color2: vec4f,
  /**
   * Linear gradients: direction (x, y), ramp start, ramp end (radial: 0, 0, start, end).
   * Shadows and glows: offset from the box (x, y), spread, blur.
   * Glyphs: shadow offset (x, y, in pixels), outline width in pixels, shadow softness.
   */
  params: vec4f,
}

@group(0) @binding(0) var<uniform> ui_view: UiView;
@data @group(0) @binding(1) var<storage, read> quads: array<Quad>;
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
  // One pixel of margin so the antialiased edge isn't cut; shadows and glows grow by their
  // spread and blur, glyphs by their shadow's offset.
  var grow = vec2f(1.0);
  if (q.kind == 3u) {
    grow = abs(q.params.xy);
  } else if (q.kind >= 6u) {
    grow = vec2f(1.0 + max(q.params.z, 0.0) + 1.5 * q.params.w);
  }
  let local = (c * 2.0 - 1.0) * (half + grow);
  let cs = cos(q.angle);
  let sn = sin(q.angle);
  let p = q.rect.xy + half + vec2f(local.x * cs - local.y * sn, local.x * sn + local.y * cs);
  var out: UiOutput;
  out.clip = vec4f(p.x * ui_view.size.z * 2.0 - 1.0, 1.0 - p.y * ui_view.size.w * 2.0, 0.5, 1.0);
  out.local = local;
  var f = (local + half) / max(q.rect.zw, vec2f(1e-6));
  // Glyph uvs extrapolate into the grown quad; their samples clamp to the glyph instead.
  if (q.kind != 3u) { f = clamp(f, vec2f(0.0), vec2f(1.0)); }
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

/** Distance past one corner's cut: the line through (cx, 0) and (0, cy) in from corner s * b. */
fn cut_plane(p: vec2f, b: vec2f, s: vec2f, cx: f32, cy: f32) -> f32 {
  if (cx <= 0.0 || cy <= 0.0) { return -1e9; }
  let a = vec2f(s.x * (b.x - cx), s.y * b.y);
  return dot(p - a, normalize(vec2f(s.x * cy, s.y * cx)));
}

/**
 * Signed distance to a node's shape: the rounded box cut at its corners. Exact inside (the shape
 * is convex), mitered outside the cuts.
 */
fn shape(p: vec2f, b: vec2f, q: Quad) -> f32 {
  let r = min(q.radius, vec4f(min(b.x, b.y)));
  var d = rounded_box(p, b, r);
  d = max(d, cut_plane(p, b, vec2f(-1.0, -1.0), q.cut_x.x, q.cut_y.x));
  d = max(d, cut_plane(p, b, vec2f(1.0, -1.0), q.cut_x.y, q.cut_y.y));
  d = max(d, cut_plane(p, b, vec2f(1.0, 1.0), q.cut_x.z, q.cut_y.z));
  d = max(d, cut_plane(p, b, vec2f(-1.0, 1.0), q.cut_x.w, q.cut_y.w));
  return d;
}

/** erf, within 5e-4 (Abramowitz and Stegun 7.1.27). */
fn erf(x: f32) -> f32 {
  let a = abs(x);
  let t = 1.0 + (0.278393 + (0.230389 + (0.000972 + 0.078108 * a) * a) * a) * a;
  let t2 = t * t;
  return sign(x) * (1.0 - 1.0 / (t2 * t2));
}

/** The fill of a box: its color, or a gradient from it to color2. */
fn fill(q: Quad, p: vec2f, b: vec2f) -> vec4f {
  if (q.kind == 0u) { return q.color; }
  var t: f32;
  var px: f32;
  if (q.kind == 4u) {
    let span = abs(2.0 * b.x * q.params.x) + abs(2.0 * b.y * q.params.y);
    t = dot(p, q.params.xy) / max(span, 1e-6) + 0.5;
    px = 1.0 / max(span, 1.0);
  } else {
    t = length(p / max(b, vec2f(1e-6)));
    px = 1.0 / max(min(b.x, b.y), 1.0);
  }
  // A ramp narrower than a pixel is a hard edge, antialiased over one.
  let width = max(q.params.w - q.params.z, px);
  let center = (q.params.z + q.params.w) * 0.5;
  let f = clamp((t - center) / width + 0.5, 0.0, 1.0);
  return mix(q.color, q.color2, f);
}

fn median(c: vec3f) -> f32 {
  return max(min(c.r, c.g), min(max(c.r, c.g), c.b));
}

/** The distance at a uv; outside the glyph's rect (the padded quad), fully outside. */
fn distance_at(uv: vec2f, bounds: vec4f) -> f32 {
  let d = median(textureSampleLevel(ui_texture, ui_sampler, clamp(uv, bounds.xy, bounds.zw), 0.0).rgb);
  let inside = all(uv >= bounds.xy) && all(uv <= bounds.zw);
  return select(0.0, d, inside);
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
    let bounds = vec4f(min(q.uv.xy, q.uv.zw), max(q.uv.xy, q.uv.zw));
    // A quad grown for a shadow reaches past the glyph: nothing of its own fill shows there.
    let grown = any(q.params.xy != vec2f(0.0));
    let inside = all(in.uv >= bounds.xy) && all(in.uv <= bounds.zw);
    let sd = select(median(texel.rgb), 0.0, grown && !inside);
    c = q.color * clamp(screen_px * (sd - 0.5) + 0.5, 0.0, 1.0);
    if (q.params.z > 0.0 && q.color2.a > 0.0) {
      // The field reaches half the range past the edge: the outline grows at most that far.
      let grow = min(q.params.z / screen_px, max(0.5 - 0.5 / screen_px, 0.0));
      let o = q.color2 * clamp(screen_px * (sd - 0.5 + grow) + 0.5, 0.0, 1.0);
      c = c + o * (1.0 - c.a);
    }
    if (q.border_color.a > 0.0 && (q.params.w > 0.0 || any(q.params.xy != vec2f(0.0)))) {
      // Shadow (or glow, with no offset): the field shifted, and softened by widening its ramp.
      let uv_per_px = (q.uv.zw - q.uv.xy) / max(q.rect.zw, vec2f(1e-6));
      let shifted = distance_at(in.uv - q.params.xy * uv_per_px, bounds);
      let ramp = max(q.params.w * 0.5, 0.5 / screen_px);
      let s = q.border_color * clamp((shifted - 0.5) / (2.0 * ramp) + 0.5, 0.0, 1.0);
      c = c + s * (1.0 - c.a);
    }
  } else if (q.kind >= 6u) {
    // Shadows and glows: the box's shape, grown by the spread and blurred (σ = blur / 2), and
    // cut out where the box itself is.
    let d = shape(in.local, half, q) - q.params.z;
    var cover = clamp(0.5 - d, 0.0, 1.0);
    if (q.params.w > 0.0) { cover = 0.5 - 0.5 * erf(d / (q.params.w * 0.70710678)); }
    let box = shape(in.local + q.params.xy, half, q);
    cover = cover * (1.0 - clamp(0.5 - box, 0.0, 1.0));
    if (cover <= 0.0) { discard; }
    if (q.kind == 7u) {
      // A glow adds its light: premultiplied with no alpha.
      var rgb = q.color.rgb;
      @if(!SRGB_TARGET) {
        rgb = linear_to_srgb(q.color.rgb / max(q.color.a, 1e-6)) * q.color.a;
      }
      return vec4f(rgb * cover, 0.0);
    }
    c = q.color * cover;
  } else {
    let d = shape(in.local, half, q);
    let edge = clamp(0.5 - d, 0.0, 1.0);
    if (q.kind == 1u || q.kind == 2u) {
      var t = texel;
      if (q.kind == 1u) { t = vec4f(t.rgb * t.a, t.a); }
      c = t * q.color * edge;
    } else {
      var inside = edge;
      if (q.border > 0.0) { inside = clamp(0.5 - (d + q.border), 0.0, 1.0); }
      c = fill(q, in.local, half) * inside + q.border_color * max(edge - inside, 0.0);
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
