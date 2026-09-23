/**
 * WGSL for post-processing (see post.ts and post-nodes.ts): the velocity and normal prepass, the
 * HDR effects in chain order, auto-exposure metering, SSAO, the tonemap with grading, and FXAA.
 * Fragment modules here pair with the vertex stage in `shard::fullscreen`.
 */
export const POST_SHADERS: Record<string, string> = {
  'shard::prepass::common': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::mesh::{ instance_at, mesh_vertex, previous_world, vertex_position };
import shard::pbr::gbuffer::oct_encode;

struct PrepassVertex {
  @builtin(position) clip: vec4f,
  @location(0) world_position: vec3f,
  @location(1) world_normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) world_tangent: vec4f,
  @location(5) @interpolate(flat) flags: u32,
  @location(6) current: vec4f,
  @location(7) previous: vec4f,
}

struct PrepassOutput {
  /** Octahedral world normal (xy), like gbuffer1. */
  @location(0) normal: vec4f,
  /** Screen motion since last frame, in uv units (+x right, +y down). */
  @location(1) velocity: vec2f,
}

fn prepass_vertex(instance_index: u32, position: vec3f, normal: vec3f, uv: vec2f, uv1: vec2f, tangent: vec4f) -> PrepassVertex {
  let m = mesh_vertex(instance_at(instance_index), position, normal, uv, uv1, tangent);
  var out: PrepassVertex;
  out.clip = view.viewProj * vec4f(m.world_position, 1.0);
  out.world_position = m.world_position;
  out.world_normal = m.world_normal;
  out.uv = m.uv;
  out.uv1 = m.uv1;
  out.world_tangent = m.world_tangent;
  out.flags = m.flags;
  out.current = view.viewProjNoJitter * vec4f(m.world_position, 1.0);
  let before = previous_world(instance_index, vertex_position(position, normal, uv));
  out.previous = view.prevViewProj * vec4f(before, 1.0);
  return out;
}

fn surface_of(in: PrepassVertex) -> VertexOutput {
  var v: VertexOutput;
  v.clip = in.clip;
  v.world_position = in.world_position;
  v.world_normal = in.world_normal;
  v.uv = in.uv;
  v.uv1 = in.uv1;
  v.world_tangent = in.world_tangent;
  v.flags = in.flags;
  return v;
}

fn prepass_output(in: PrepassVertex, n: vec3f) -> PrepassOutput {
  var out: PrepassOutput;
  out.normal = vec4f(oct_encode(n), 0.0, 0.0);
  let a = in.current.xy / in.current.w;
  let b = in.previous.xy / in.previous.w;
  out.velocity = (a - b) * vec2f(0.5, -0.5);
  return out;
}`,

  'shard::prepass': `
import shard::prepass::common::{ PrepassVertex, PrepassOutput, prepass_vertex, prepass_output, surface_of };
import shard::pbr::material::pbr_input;
import shard::pbr::standard::material;

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> PrepassVertex {
  return prepass_vertex(instance_index, position, normal, uv, uv1, tangent);
}

/** Depth, the shaded normal (normal maps included), and velocity. */
@fragment fn fs(in: PrepassVertex) -> PrepassOutput {
  let p = pbr_input(surface_of(in));
  @if(MASK) if (p.alpha < material.alphaCutoff) { discard; }
  return prepass_output(in, p.normal);
}`,

  'shard::prepass::plain': `
import shard::prepass::common::{ PrepassVertex, PrepassOutput, prepass_vertex, prepass_output };

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> PrepassVertex {
  return prepass_vertex(instance_index, position, normal, uv, uv1, tangent);
}

/** Materials with their own shading: the geometric normal. */
@fragment fn fs(in: PrepassVertex) -> PrepassOutput {
  return prepass_output(in, normalize(in.world_normal));
}`,

  'shard::post::common': `
import shard::view::view;

/** A pixel's uv from its fragment coordinate. */
fn uv_of(frag: vec2f) -> vec2f {
  return frag * view.viewport.zw;
}

/** World position of a uv at a (reversed-Z) depth. Depth 0 is infinitely far: pass a floor. */
fn world_at(uv: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let w = view.invViewProj * vec4f(ndc, depth, 1.0);
  return w.xyz / w.w;
}

/** Distance along the view axis, in meters. */
fn view_depth(world: vec3f) -> f32 {
  return -(view.view * vec4f(world, 1.0)).z;
}

/**
 * Screen motion of a pixel in uv units: the prepass's value for geometry, the camera's own
 * rotation for the background (depth 0), which the prepass leaves empty.
 */
fn motion(uv: vec2f, depth: f32, stored: vec2f) -> vec2f {
  if (depth > 0.0) { return stored; }
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let dir = (view.invViewProj * vec4f(ndc, 0.0, 1.0)).xyz;
  let now = view.viewProjNoJitter * vec4f(dir, 0.0);
  let before = view.prevViewProj * vec4f(dir, 0.0);
  return (now.xy / now.w - before.xy / before.w) * vec2f(0.5, -0.5);
}`,

  'shard::post::fog': `
import shard::view::view;
import shard::pbr::lights::directional;
import shard::pbr::environment::env_irradiance;
import shard::post::common::{ uv_of, world_at };

struct FogParams {
  color: vec4f,
  density: f32,
  falloff: f32,
  start: f32,
  sun: f32,
}

@group(1) @binding(0) var input: texture_2d<f32>;
@group(1) @binding(1) var depth_texture: texture_depth_2d;
@group(1) @binding(2) var<uniform> fog: FogParams;

const PI: f32 = 3.14159265;

/** Optical depth of exponential height fog along the ray from t0 to t1 (meters). */
fn optical_depth(y0: f32, dir_y: f32, t0: f32, t1: f32) -> f32 {
  let base = fog.density * exp(-fog.falloff * y0);
  let k = fog.falloff * dir_y;
  if (abs(k) < 1e-5) { return base * (t1 - t0); }
  return base * (exp(-k * t0) - exp(-k * t1)) / k;
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let c = textureLoad(input, px, 0);
  let depth = textureLoad(depth_texture, px, 0);
  let uv = uv_of(frag.xy);
  // The background is far away, not infinitely: a floor keeps the ray finite.
  let world = world_at(uv, max(depth, 1e-7));
  let to = world - view.cameraPosition;
  let dist = length(to);
  let dir = to / max(dist, 1e-6);
  let tau = optical_depth(view.cameraPosition.y, dir.y, fog.start, max(dist, fog.start));
  let transmittance = exp(-tau);
  // In-scattering: the sky (environment or ambient), plus the sun through a forward-peaked phase.
  var sky = view.ambient;
  if (view.envParams.w > 0.5) { sky = env_irradiance(vec3f(0.0, 1.0, 0.0)) * view.envParams.x; }
  var sun = vec3f(0.0);
  if (directional.count > 0u) {
    let light = directional.lights[0];
    let mu = dot(dir, normalize(light.direction));
    let g = 0.76;
    let hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    sun = light.color * mix(1.0 / (4.0 * PI), hg, fog.sun);
  }
  let inscatter = fog.color.rgb * (sky + sun) * view.exposure;
  return vec4f(c.rgb * transmittance + inscatter * (1.0 - transmittance), c.a);
}`,

  'shard::post::bloom': `
import shard::color::luminance;

struct BloomParams {
  /** Threshold (pre-exposed), knee (pre-exposed), texel size of the source (zw). */
  threshold: vec4f,
  /** intensity, level count, energy-conserving mix (1) or additive (0), 0. */
  mix: vec4f,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomParams;
@group(0) @binding(3) var scene: texture_2d<f32>;

fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f {
  return textureSampleLevel(source, source_sampler, uv + vec2f(dx, dy) * params.threshold.zw, 0.0).rgb;
}

/** Jimenez's 13-tap downsample: four overlapping 2×2 boxes and a center one. */
fn downsample13(uv: vec2f) -> array<vec3f, 5> {
  let a = tap(uv, -2.0, -2.0); let b = tap(uv, 0.0, -2.0); let c = tap(uv, 2.0, -2.0);
  let d = tap(uv, -1.0, -1.0); let e = tap(uv, 1.0, -1.0);
  let f = tap(uv, -2.0, 0.0); let g = tap(uv, 0.0, 0.0); let h = tap(uv, 2.0, 0.0);
  let i = tap(uv, -1.0, 1.0); let j = tap(uv, 1.0, 1.0);
  let k = tap(uv, -2.0, 2.0); let l = tap(uv, 0.0, 2.0); let m = tap(uv, 2.0, 2.0);
  return array<vec3f, 5>((d + e + i + j) * 0.25, (a + b + f + g) * 0.25, (b + c + g + h) * 0.25, (f + g + k + l) * 0.25, (g + h + l + m) * 0.25);
}

fn karis(c: vec3f) -> f32 { return 1.0 / (1.0 + luminance(c)); }

/** Soft threshold: a quadratic knee below the threshold, linear above. */
fn threshold(c: vec3f) -> vec3f {
  let t = params.threshold.x;
  if (t <= 0.0) { return c; }
  let knee = max(params.threshold.y, 1e-5);
  let b = max(max(c.r, c.g), c.b);
  let soft = clamp(b - t + knee, 0.0, 2.0 * knee);
  let w = max(soft * soft / (4.0 * knee), b - t) / max(b, 1e-5);
  return c * w;
}

struct FullscreenInput { @builtin(position) clip: vec4f, @location(0) uv: vec2f }

/** First level: threshold, and Karis-weighted boxes so single bright pixels don't flicker. */
@fragment fn prefilter(in: FullscreenInput) -> @location(0) vec4f {
  let s = downsample13(in.uv);
  let w0 = karis(s[0]); let w1 = karis(s[1]); let w2 = karis(s[2]); let w3 = karis(s[3]); let w4 = karis(s[4]);
  let c = (s[0] * w0 * 0.5 + (s[1] * w1 + s[2] * w2 + s[3] * w3 + s[4] * w4) * 0.125)
    / (w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125);
  return vec4f(threshold(c), 1.0);
}

@fragment fn downsample(in: FullscreenInput) -> @location(0) vec4f {
  let s = downsample13(in.uv);
  return vec4f(s[0] * 0.5 + (s[1] + s[2] + s[3] + s[4]) * 0.125, 1.0);
}

/** 3×3 tent upsample, added onto the level below. */
@fragment fn upsample(in: FullscreenInput) -> @location(0) vec4f {
  let c = tap(in.uv, 0.0, 0.0) * 4.0
    + (tap(in.uv, -1.0, 0.0) + tap(in.uv, 1.0, 0.0) + tap(in.uv, 0.0, -1.0) + tap(in.uv, 0.0, 1.0)) * 2.0
    + tap(in.uv, -1.0, -1.0) + tap(in.uv, 1.0, -1.0) + tap(in.uv, -1.0, 1.0) + tap(in.uv, 1.0, 1.0);
  return vec4f(c / 16.0, 1.0);
}

/** The scene plus the glow: mixed (energy-conserving) without a threshold, added with one. */
@fragment fn composite(in: FullscreenInput) -> @location(0) vec4f {
  let s = textureLoad(scene, vec2i(in.clip.xy), 0);
  let glow = textureSampleLevel(source, source_sampler, in.uv, 0.0).rgb / params.mix.y;
  let c = select(s.rgb + glow * params.mix.x, mix(s.rgb, glow, params.mix.x), params.mix.z > 0.5);
  return vec4f(c, s.a);
}`,

  'shard::post::exposure': `
import shard::view::view;
import shard::color::luminance;

struct MeterParams {
  /** EV of bin 0, bins per EV, metering mode, 0. */
  range: vec4f,
}

@group(0) @binding(1) var input: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<atomic<u32>, 256>;
@group(0) @binding(3) var<uniform> params: MeterParams;

var<workgroup> local: array<atomic<u32>, 256>;

/**
 * A 256-bin histogram of EV100 (log2 of scene luminance × 100 / 12.5, the reflected-light meter),
 * weighted by the metering mode.
 */
@compute @workgroup_size(16, 16)
fn meter(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) li: u32) {
  atomicStore(&local[li], 0u);
  workgroupBarrier();
  // One pixel per 4×4 block: plenty for a meter, and 16× less work.
  let size = textureDimensions(input);
  let px = id.xy * 4u + 2u;
  if (px.x < size.x && px.y < size.y) {
    let c = textureLoad(input, vec2i(px), 0).rgb;
    let l = luminance(c) / max(view.exposure, 1e-20);
    let ev = log2(max(l, 1e-10) * 8.0);
    let bin = u32(clamp((ev - params.range.x) * params.range.y, 0.0, 255.0));
    let p = vec2f(px) / vec2f(size) * 2.0 - 1.0;
    let r = length(p * vec2f(f32(size.x) / f32(size.y), 1.0)) / 1.4142;
    var w = 16u;
    if (params.range.z == 1.0) { w = u32(round(16.0 * exp(-r * r / 0.18))); }
    if (params.range.z == 2.0) { w = select(0u, 16u, r < 0.1); }
    if (w > 0u) { atomicAdd(&local[bin], w); }
  }
  workgroupBarrier();
  let n = atomicLoad(&local[li]);
  if (n > 0u) { atomicAdd(&histogram[li], n); }
}`,

  'shard::post::dof': `
import shard::view::view;
import shard::post::common::{ uv_of, world_at, view_depth };
import shard::color::luminance;

struct DofParams {
  /** Signed CoC radius in pixels = x / depth + y, capped at z; w: mode (0 gaussian, 1 bokeh). */
  coc: vec4f,
}

@group(0) @binding(1) var input: texture_2d<f32>;
@group(0) @binding(2) var depth_texture: texture_depth_2d;
@group(0) @binding(3) var<uniform> params: DofParams;
@group(0) @binding(4) var half_texture: texture_2d<f32>;
@group(0) @binding(5) var linear_sampler: sampler;

/** Signed circle of confusion radius in full-resolution pixels: negative in front of focus. */
fn coc_at(px: vec2i) -> f32 {
  let depth = textureLoad(depth_texture, px, 0);
  if (depth <= 0.0) { return params.coc.z; }
  let uv = (vec2f(px) + 0.5) * view.viewport.zw;
  let d = view_depth(world_at(uv, depth));
  let c = params.coc.x / d + params.coc.y;
  return clamp(c, -params.coc.z, params.coc.z);
}

/** Half resolution: color and signed CoC, taking the largest CoC of the 2×2 block. */
@fragment fn prepare(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let base = vec2i(frag.xy) * 2;
  var color = vec3f(0.0);
  var coc = 0.0;
  for (var k = 0; k < 4; k++) {
    let px = base + vec2i(k & 1, k >> 1);
    color += textureLoad(input, px, 0).rgb * 0.25;
    let c = coc_at(px);
    if (abs(c) > abs(coc)) { coc = c; }
  }
  return vec4f(color, coc);
}

const GOLDEN: f32 = 2.39996323;
const TAPS: i32 = 48;

/**
 * Gather over a disc the size of this pixel's CoC. A tap counts if its own blur reaches this
 * pixel, so sharp foreground doesn't smear over blurred background.
 */
@fragment fn gather(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(half_texture));
  let uv = frag.xy / size;
  let center = textureSampleLevel(half_texture, linear_sampler, uv, 0.0);
  // Half-resolution pixels.
  let radius = abs(center.a) * 0.5;
  if (radius < 0.5) { return center; }
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0; i < TAPS; i++) {
    let r = sqrt((f32(i) + 0.5) / f32(TAPS));
    let a = f32(i) * GOLDEN;
    let o = vec2f(cos(a), sin(a)) * r * radius;
    let s = textureSampleLevel(half_texture, linear_sampler, uv + o / size, 0.0);
    let d = r * radius;
    var w = clamp(abs(s.a) * 0.5 - d + 1.0, 0.0, 1.0);
    if (s.a < 0.0) { w = 1.0; } // foreground always bleeds over what's behind it
    // Gaussian falls off toward the rim; bokeh is a flat disc, with highlights weighted up so
    // bright points spread into visible discs.
    if (params.coc.w < 0.5) {
      w *= exp(-2.0 * r * r);
    } else {
      w *= 1.0 + clamp(luminance(s.rgb) - 1.0, 0.0, 8.0);
    }
    sum += s.rgb * w;
    weight += w;
  }
  return vec4f(sum / max(weight, 1e-5), center.a);
}

/** Full resolution: the sharp image, or the blur where the CoC is large. */
@fragment fn composite(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let sharp = textureLoad(input, px, 0);
  let blurred = textureSampleLevel(half_texture, linear_sampler, uv_of(frag.xy), 0.0);
  let t = smoothstep(0.5, 1.5, abs(coc_at(px)));
  return vec4f(mix(sharp.rgb, blurred.rgb, t), sharp.a);
}`,

  'shard::post::motion_blur': `
import shard::view::view;
import shard::post::common::{ uv_of, motion };

struct MotionParams {
  /** Shutter fraction of a frame, max blur in pixels, samples, 0. */
  params: vec4f,
}

@group(0) @binding(1) var input: texture_2d<f32>;
@group(0) @binding(2) var depth_texture: texture_depth_2d;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var<uniform> motion_params: MotionParams;
@group(0) @binding(5) var linear_sampler: sampler;

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let uv = uv_of(frag.xy);
  let depth = textureLoad(depth_texture, px, 0);
  var v = motion(uv, depth, textureLoad(velocity, px, 0).xy) * motion_params.params.x;
  let pixels = length(v * view.viewport.xy);
  let cap = motion_params.params.y;
  if (pixels > cap) { v *= cap / pixels; }
  let center = textureLoad(input, px, 0);
  if (pixels < 0.5) { return center; }
  let n = i32(motion_params.params.z);
  var sum = vec3f(0.0);
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + 0.5) / f32(n) - 0.5;
    sum += textureSampleLevel(input, linear_sampler, uv + v * t, 0.0).rgb;
  }
  return vec4f(sum / f32(n), center.a);
}`,

  'shard::post::taa': `
import shard::view::view;
import shard::post::common::{ uv_of, motion };
import shard::color::luminance;

struct TaaParams {
  /** Current frame weight, reset (1: no history), 0, 0. */
  params: vec4f,
}

@group(0) @binding(1) var input: texture_2d<f32>;
@group(0) @binding(2) var depth_texture: texture_depth_2d;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var history: texture_2d<f32>;
@group(0) @binding(5) var linear_sampler: sampler;
@group(0) @binding(6) var<uniform> taa: TaaParams;

struct TaaOutput {
  @location(0) color: vec4f,
  @location(1) history: vec4f,
}

fn rgb_to_ycocg(c: vec3f) -> vec3f {
  return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

fn ycocg_to_rgb(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

/** Tonemapped for blending, so one bright sample doesn't dominate (Karis). */
fn compress(c: vec3f) -> vec3f { return c / (1.0 + luminance(c)); }
fn expand(c: vec3f) -> vec3f { return c / max(1.0 - luminance(c), 1e-4); }

/** Catmull-Rom history sample in 5 bilinear taps (Jimenez). */
fn sample_history(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(history));
  let p = uv * size;
  let t1 = floor(p - 0.5) + 0.5;
  let f = p - t1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let tc12 = (t1 + w2 / w12) / size;
  let tc0 = (t1 - 1.0) / size;
  let tc3 = (t1 + 2.0) / size;
  var c = textureSampleLevel(history, linear_sampler, vec2f(tc12.x, tc0.y), 0.0).rgb * (w12.x * w0.y);
  c += textureSampleLevel(history, linear_sampler, vec2f(tc0.x, tc12.y), 0.0).rgb * (w0.x * w12.y);
  c += textureSampleLevel(history, linear_sampler, vec2f(tc12.x, tc12.y), 0.0).rgb * (w12.x * w12.y);
  c += textureSampleLevel(history, linear_sampler, vec2f(tc3.x, tc12.y), 0.0).rgb * (w3.x * w12.y);
  c += textureSampleLevel(history, linear_sampler, vec2f(tc12.x, tc3.y), 0.0).rgb * (w12.x * w3.y);
  let w = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(c / w, vec3f(0.0));
}

@fragment fn fs(@builtin(position) frag: vec4f) -> TaaOutput {
  let px = vec2i(frag.xy);
  let size = vec2i(textureDimensions(input));
  let uv = uv_of(frag.xy);
  // Neighborhood: its YCoCg box clamps the history, and its nearest depth picks the velocity, so
  // edges move with the foreground.
  var lo = vec3f(1e20);
  var hi = vec3f(-1e20);
  var nearest = 0.0;
  var nearest_px = px;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(px + vec2i(x, y), vec2i(0), size - 1);
      let c = rgb_to_ycocg(compress(textureLoad(input, q, 0).rgb));
      lo = min(lo, c);
      hi = max(hi, c);
      let d = textureLoad(depth_texture, q, 0);
      if (d > nearest) { nearest = d; nearest_px = q; }
    }
  }
  let current = compress(textureLoad(input, px, 0).rgb);
  let v = motion(uv, nearest, textureLoad(velocity, nearest_px, 0).xy);
  let prev_uv = uv - v;
  var alpha = taa.params.x;
  if (taa.params.y > 0.5 || any(prev_uv < vec2f(0.0)) || any(prev_uv > vec2f(1.0))) { alpha = 1.0; }
  var h = rgb_to_ycocg(compress(sample_history(prev_uv)));
  // Clip toward the box center rather than clamping per channel: keeps hue.
  let center = (lo + hi) * 0.5;
  let extent = max((hi - lo) * 0.5, vec3f(1e-5));
  let offset = h - center;
  let units = abs(offset / extent);
  let m = max(units.x, max(units.y, units.z));
  if (m > 1.0) { h = center + offset / m; }
  let blended = mix(ycocg_to_rgb(h), current, alpha);
  let color = expand(max(blended, vec3f(0.0)));
  var out: TaaOutput;
  out.color = vec4f(color, 1.0);
  out.history = vec4f(color, 1.0);
  return out;
}`,

  'shard::post::ssao': `
import shard::view::view;
import shard::pbr::gbuffer::oct_decode;
import shard::color::ign;

struct SsaoParams {
  /** Radius (m), intensity, directions, steps. */
  params: vec4f,
  /** Pixels per meter at 1 m (projection scale), 0, 0, 0. */
  scale: vec4f,
  /** Clip to view space: one multiply per sample, not two. */
  inv_proj: mat4x4f,
}

@group(0) @binding(1) var depth_texture: texture_depth_2d;
@group(0) @binding(2) var normal_texture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> ssao: SsaoParams;
@group(0) @binding(4) var half_ao: texture_2d<f32>;

const PI: f32 = 3.14159265;

fn view_position(px: vec2i) -> vec3f {
  let d = max(textureLoad(depth_texture, px, 0), 1e-7);
  let uv = (vec2f(px) + 0.5) * view.viewport.zw;
  let p = ssao.inv_proj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return p.xyz / p.w;
}

/**
 * Ground-truth AO (Jimenez 2016), at half resolution: per slice direction, the horizon angles on
 * both sides, integrated against the normal projected into the slice.
 */
@fragment fn gtao(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let full = vec2i(textureDimensions(depth_texture));
  let px = min(vec2i(frag.xy) * 2, full - 1);
  let depth = textureLoad(depth_texture, px, 0);
  if (depth <= 0.0) { return vec4f(1.0); }
  let p = view_position(px);
  let v = normalize(-p);
  let n = normalize((view.view * vec4f(oct_decode(textureLoad(normal_texture, px, 0).xy), 0.0)).xyz);
  let radius = ssao.params.x;
  let dirs = i32(ssao.params.z);
  let steps = i32(ssao.params.w);
  // The radius on screen, in full-resolution pixels.
  let screen_radius = radius * ssao.scale.x / max(-p.z, 1e-3);
  if (screen_radius < 1.0) { return vec4f(1.0); }
  let noise = ign(frag.xy);
  let jitter = ign(frag.xy + vec2f(17.0, 29.0));
  var visibility = 0.0;
  for (var s = 0; s < dirs; s++) {
    let phi = (f32(s) + noise) / f32(dirs) * PI;
    let dir = vec2f(cos(phi), sin(phi));
    // Slice plane: view direction and the screen direction (y flips from screen to view).
    let dir3 = vec3f(dir.x, -dir.y, 0.0);
    let ortho = dir3 - v * dot(dir3, v);
    let axis = normalize(cross(ortho, v));
    let np = n - axis * dot(n, axis);
    let np_len = max(length(np), 1e-4);
    let cos_n = clamp(dot(np, v) / np_len, -1.0, 1.0);
    let angle_n = sign(dot(np, cross(v, axis))) * acos(cos_n);
    var h = array<f32, 2>(-1.0, -1.0);
    for (var side = 0; side < 2; side++) {
      let sd = select(-dir, dir, side == 0);
      for (var k = 0; k < steps; k++) {
        let t = (f32(k) + jitter) / f32(steps);
        let o = vec2i(round(sd * t * t * screen_radius));
        if (o.x == 0 && o.y == 0) { continue; }
        let q = clamp(px + o, vec2i(0), full - 1);
        let delta = view_position(q) - p;
        let len = length(delta);
        let falloff = clamp(1.0 - len * len / (radius * radius), 0.0, 1.0);
        let c = mix(-1.0, dot(delta / max(len, 1e-5), v), falloff);
        h[side] = max(h[side], c);
      }
    }
    let h0 = angle_n + max(-acos(h[1]) - angle_n, -PI * 0.5);
    let h1 = angle_n + min(acos(h[0]) - angle_n, PI * 0.5);
    let sin_n = sin(angle_n);
    let arc0 = (cos_n + 2.0 * h0 * sin_n - cos(2.0 * h0 - angle_n)) * 0.25;
    let arc1 = (cos_n + 2.0 * h1 * sin_n - cos(2.0 * h1 - angle_n)) * 0.25;
    visibility += np_len * (arc0 + arc1);
  }
  let ao = clamp(visibility / f32(dirs), 0.0, 1.0);
  return vec4f(pow(ao, ssao.params.y), -p.z, 0.0, 1.0);
}

/** Back to full resolution: the four nearest half-resolution texels, weighted by depth match. */
@fragment fn upsample(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let depth = textureLoad(depth_texture, px, 0);
  if (depth <= 0.0) { return vec4f(1.0); }
  let z = -view_position(px).z;
  let half_size = vec2i(textureDimensions(half_ao));
  let base = vec2i(floor((frag.xy - 1.0) * 0.5));
  var sum = 0.0;
  var weight = 0.0;
  for (var k = 0; k < 4; k++) {
    let q = clamp(base + vec2i(k & 1, k >> 1), vec2i(0), half_size - 1);
    let s = textureLoad(half_ao, q, 0);
    let w = 1.0 / (1e-3 + abs(s.y - z) / max(z, 1e-3));
    sum += s.x * w;
    weight += w;
  }
  return vec4f(sum / max(weight, 1e-6), 0.0, 0.0, 1.0);
}`,

  'shard::post::tonemap': `
import shard::color::{ linear_to_srgb, srgb_to_linear, ign, luminance };
import shard::tonemap::tonemap;

struct TonemapParams {
  /** curve, dither, flags (1 grading, 2 vignette, 4 LUT, 8 sRGB LUT), 0. */
  mode: vec4u,
  /** White balance as LMS scale (xyz), 0. */
  balance: vec4f,
  /** saturation, contrast, 0, 0. */
  grade: vec4f,
  lift: vec4f,
  gamma: vec4f,
  gain: vec4f,
  /** Vignette intensity, smoothness, aspect, 0. */
  vignette: vec4f,
  /** 1 / width, 1 / height of the view. */
  texel: vec4f,
}

@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: TonemapParams;
@group(0) @binding(2) var lut: texture_2d<f32>;
@group(0) @binding(3) var lut_sampler: sampler;

const LIN_TO_LMS = mat3x3f(
  vec3f(3.90405e-1, 7.08416e-2, 2.31082e-2),
  vec3f(5.49941e-1, 9.63172e-1, 1.28021e-1),
  vec3f(8.92632e-3, 1.35775e-3, 9.36245e-1),
);
const LMS_TO_LIN = mat3x3f(
  vec3f(2.85847, -2.10182e-1, -4.18120e-2),
  vec3f(-1.62879, 1.15820, -1.18169e-1),
  vec3f(-2.48910e-2, 3.24281e-4, 1.06867),
);

/** White balance, contrast around mid gray, saturation, then lift/gamma/gain, in scene-linear HDR. */
fn grade(c0: vec3f) -> vec3f {
  var c = LMS_TO_LIN * ((LIN_TO_LMS * c0) * params.balance.xyz);
  c = 0.18 * pow(max(c, vec3f(0.0)) / 0.18, vec3f(params.grade.y));
  let l = luminance(c);
  c = max(mix(vec3f(l), c, params.grade.x), vec3f(0.0));
  c = pow(max(c * params.gain.xyz + params.lift.xyz, vec3f(0.0)), 1.0 / params.gamma.xyz);
  return c;
}

/** A 32³ LUT stored as a 1024×32 strip: slices of red (x) by green (y), one per blue step. */
fn apply_lut(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0)) * 31.0;
  let slice = floor(x.b);
  let f = x.b - slice;
  let uv0 = vec2f((slice * 32.0 + x.r + 0.5) / 1024.0, (x.g + 0.5) / 32.0);
  let uv1 = uv0 + vec2f(select(32.0, 0.0, slice >= 31.0) / 1024.0, 0.0);
  var a = textureSampleLevel(lut, lut_sampler, uv0, 0.0).rgb;
  var b = textureSampleLevel(lut, lut_sampler, uv1, 0.0).rgb;
  // An sRGB-format texture decoded the stored values: encode them back.
  if ((params.mode.z & 8u) != 0u) { a = linear_to_srgb(a); b = linear_to_srgb(b); }
  return mix(a, b, f);
}

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let texel = textureLoad(hdr, vec2i(p.xy), 0);
  var hdr_color = max(texel.rgb, vec3f(0.0));
  let flags = params.mode.z;
  if ((flags & 1u) != 0u) { hdr_color = grade(hdr_color); }
  if ((flags & 2u) != 0u) {
    let uv = p.xy * params.texel.xy - 0.5;
    let d = length(uv * vec2f(params.vignette.z, 1.0)) / length(vec2f(params.vignette.z, 1.0) * 0.5);
    let fall = smoothstep(1.0 - params.vignette.y, 1.0 + params.vignette.y * 0.5, d);
    hdr_color *= 1.0 - params.vignette.x * fall;
  }
  var c = linear_to_srgb(tonemap(hdr_color, params.mode.x));
  if ((flags & 4u) != 0u) { c = apply_lut(c); }
  if (params.mode.y != 0u) {
    // Triangular noise of ±1 LSB, in display space: breaks up banding in gradients.
    let n = ign(p.xy) + ign(p.xy + vec2f(71.0, 13.0)) - 1.0;
    c = c + vec3f(n / 255.0);
  }
  // sRGB targets encode in hardware: hand them linear values.
  @if(SRGB_TARGET) c = srgb_to_linear(clamp(c, vec3f(0.0), vec3f(1.0)));
  return vec4f(c, 1.0);
}`,

  'shard::post::fxaa': `
import shard::color::{ linear_to_srgb, srgb_to_linear };

@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;

fn luma(c: vec3f) -> f32 {
  // sRGB-format inputs sample as linear; luma is measured in display space either way.
  @if(SRGB_TARGET) return dot(linear_to_srgb(c), vec3f(0.299, 0.587, 0.114));
  @if(!SRGB_TARGET) return dot(c, vec3f(0.299, 0.587, 0.114));
}

fn at(uv: vec2f, o: vec2f, texel: vec2f) -> vec3f {
  return textureSampleLevel(input, input_sampler, uv + o * texel, 0.0).rgb;
}

/** FXAA 3.11 (Lottes), quality preset 12: local contrast, edge direction, end search, blend. */
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(input));
  let texel = 1.0 / size;
  let uv = frag.xy * texel;
  let center = at(uv, vec2f(0.0), texel);
  let m = luma(center);
  let n = luma(at(uv, vec2f(0.0, -1.0), texel));
  let s = luma(at(uv, vec2f(0.0, 1.0), texel));
  let e = luma(at(uv, vec2f(1.0, 0.0), texel));
  let w = luma(at(uv, vec2f(-1.0, 0.0), texel));
  let lo = min(m, min(min(n, s), min(e, w)));
  let hi = max(m, max(max(n, s), max(e, w)));
  let range = hi - lo;
  if (range < max(0.0312, hi * 0.125)) { return vec4f(center, 1.0); }
  let nw = luma(at(uv, vec2f(-1.0, -1.0), texel));
  let ne = luma(at(uv, vec2f(1.0, -1.0), texel));
  let sw = luma(at(uv, vec2f(-1.0, 1.0), texel));
  let se = luma(at(uv, vec2f(1.0, 1.0), texel));
  // Sub-pixel aliasing amount.
  let average = (2.0 * (n + s + e + w) + nw + ne + sw + se) / 12.0;
  let sub = clamp(abs(average - m) / range, 0.0, 1.0);
  let sub_blend = smoothstep(0.0, 1.0, sub) * smoothstep(0.0, 1.0, sub) * 0.75;
  let horizontal = abs(nw + ne - 2.0 * n) + 2.0 * abs(w + e - 2.0 * m) + abs(sw + se - 2.0 * s)
    >= abs(nw + sw - 2.0 * w) + 2.0 * abs(n + s - 2.0 * m) + abs(ne + se - 2.0 * e);
  let p_luma = select(e, s, horizontal);
  let n_luma = select(w, n, horizontal);
  let p_grad = abs(p_luma - m);
  let n_grad = abs(n_luma - m);
  var step_len = select(texel.x, texel.y, horizontal);
  var edge_luma = 0.0;
  var gradient = 0.0;
  if (p_grad < n_grad) {
    step_len = -step_len;
    edge_luma = (n_luma + m) * 0.5;
    gradient = n_grad;
  } else {
    edge_luma = (p_luma + m) * 0.5;
    gradient = p_grad;
  }
  var edge_uv = uv;
  var along = vec2f(texel.x, 0.0);
  if (horizontal) { edge_uv.y += step_len * 0.5; } else { edge_uv.x += step_len * 0.5; along = vec2f(0.0, texel.y); }
  let threshold = gradient * 0.25;
  // Walk both ways along the edge until the luma leaves the edge.
  let steps = array<f32, 12>(1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0);
  var up = edge_uv + along;
  var down = edge_uv - along;
  var lu = luma(textureSampleLevel(input, input_sampler, up, 0.0).rgb) - edge_luma;
  var ld = luma(textureSampleLevel(input, input_sampler, down, 0.0).rgb) - edge_luma;
  var done_u = abs(lu) >= threshold;
  var done_d = abs(ld) >= threshold;
  for (var i = 1; i < 12; i++) {
    if (done_u && done_d) { break; }
    if (!done_u) {
      up += along * steps[i];
      lu = luma(textureSampleLevel(input, input_sampler, up, 0.0).rgb) - edge_luma;
      done_u = abs(lu) >= threshold;
    }
    if (!done_d) {
      down -= along * steps[i];
      ld = luma(textureSampleLevel(input, input_sampler, down, 0.0).rgb) - edge_luma;
      done_d = abs(ld) >= threshold;
    }
  }
  let du = select(up.y - uv.y, up.x - uv.x, horizontal);
  let dd = select(uv.y - down.y, uv.x - down.x, horizontal);
  let closer_up = du < dd;
  let dist = min(du, dd);
  let span = du + dd;
  let ends_right = (select(ld, lu, closer_up) < 0.0) != ((m - edge_luma) < 0.0);
  let edge_blend = select(0.0, 0.5 - dist / span, ends_right);
  let blend = max(edge_blend, sub_blend);
  var final_uv = uv;
  if (horizontal) { final_uv.y += blend * step_len; } else { final_uv.x += blend * step_len; }
  return vec4f(textureSampleLevel(input, input_sampler, final_uv, 0.0).rgb, 1.0);
}`,
}
