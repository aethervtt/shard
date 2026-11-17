// WGSL for weather (0133) and surface weather (0134).

/** Mask brushes the shaders test (the nearest first past this many are dropped). */
export const MAX_BRUSHES = 16
/** shard::shader_data slots: four for the state, four per brush. */
export const WEATHER_SLOTS = 4 + MAX_BRUSHES * 4

/**
 * The weather block in shard::shader_data:
 * [0] wetness, snow cover, dust cover, rain
 * [1] time (s), snow, wind, brush count
 * [2] dust color rgb, puddles
 * [3] free
 * [4 + 4i] brush i: world → local rows ×3, then edge
 */
export function weatherShaders(slot: number): Record<string, string> {
  return {
    'shard::weather::common': `
import shard::shader_data::shader_data;

const WEATHER_BLOCK: u32 = ${slot}u;

/** How open a point is to the sky: 0 inside a WeatherMaskBrush, 1 outside them all. */
fn weather_open(p: vec3f) -> f32 {
  let n = u32(shader_data[WEATHER_BLOCK + 1u].w);
  var open = 1.0;
  let w = vec4f(p, 1.0);
  for (var i = 0u; i < n; i++) {
    let o = WEATHER_BLOCK + 4u + i * 4u;
    let local = vec3f(dot(shader_data[o], w), dot(shader_data[o + 1u], w), dot(shader_data[o + 2u], w));
    let m = max(max(abs(local.x), abs(local.y)), abs(local.z)) * 2.0;
    let e = max(shader_data[o + 3u].x, 0.001);
    open = min(open, smoothstep(1.0 - e, 1.0, m));
  }
  return open;
}

fn weather_hash(c: vec2i) -> f32 {
  var h = (bitcast<u32>(c.x) * 747796405u) ^ (bitcast<u32>(c.y) * 2891336453u);
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32((h >> 22u) ^ h) * (1.0 / 4294967296.0);
}

fn weather_value(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = mix(weather_hash(i), weather_hash(i + vec2i(1, 0)), s.x);
  let b = mix(weather_hash(i + vec2i(0, 1)), weather_hash(i + vec2i(1, 1)), s.x);
  return mix(a, b, s.y);
}

fn weather_noise(p: vec2f) -> f32 {
  return weather_value(p) * 0.55 + weather_value(p * 2.13 + 7.1) * 0.3 + weather_value(p * 4.7 + 3.3) * 0.15;
}`,

    // Surface weather (0134): the standard surface, wet, puddled, snowed on or dusty.
    'shard::surface_weather': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::shader_data::shader_data;
import shard::weather::common::{ WEATHER_BLOCK, weather_open, weather_hash, weather_noise };

/** Rain rings in puddles: a ring per cell, each starting at its own time. Returns a normal tilt. */
fn weather_ripples(xz: vec2f, time: f32, strength: f32) -> vec2f {
  var g = vec2f(0.0);
  for (var layer = 0; layer < 2; layer++) {
    let q = xz * 3.2 + vec2f(f32(layer) * 0.37, f32(layer) * 0.71);
    let cell = vec2i(floor(q));
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let c = cell + vec2i(x, y);
        let h = weather_hash(c + vec2i(layer * 131, 0));
        let center = vec2f(c) + vec2f(0.2 + 0.6 * weather_hash(c + 17), 0.2 + 0.6 * weather_hash(c + 41));
        let phase = fract(time * (0.8 + 0.4 * h) + h * 7.0);
        let d = q - center;
        let r = length(d);
        let radius = phase * 0.55;
        let x0 = r - radius;
        let ring = sin(x0 * 38.0) * exp(-x0 * x0 * 260.0) * (1.0 - phase) * (1.0 - phase) * step(0.45, weather_hash(c + vec2i(layer * 57, 3)));
        g += d / max(r, 1e-3) * ring;
      }
    }
  }
  return g * strength * 0.35;
}

fn surface_weather(p0: PbrInput, in: VertexOutput) -> PbrInput {
  let s0 = shader_data[WEATHER_BLOCK];
  // Dry and clean: the surface as it was, exactly.
  if (s0.x + s0.y + s0.z <= 0.0) { return p0; }
  let world = in.world_position;
  let open = weather_open(world);
  if (open <= 0.0) { return p0; }
  let s1 = shader_data[WEATHER_BLOCK + 1u];
  let s2 = shader_data[WEATHER_BLOCK + 2u];
  var p = p0;
  let n = p0.normal;
  let up = clamp(n.y, 0.0, 1.0);
  let snow_cover = s0.y * open;

  // Dust settles on what faces up.
  let dust = s0.z * open * smoothstep(0.2, 0.8, up);
  p.base_color = mix(p.base_color, s2.rgb, dust * 0.75);
  p.roughness = mix(p.roughness, 0.95, dust);

  // Wet: darker (more so for porous, rough surfaces) and glossier; walls dry before the ground.
  let porosity = clamp(p0.roughness * 1.3 - 0.2, 0.0, 1.0);
  let w = s0.x * open * mix(0.5, 1.0, up) * (1.0 - snow_cover);
  p.base_color *= mix(1.0, mix(0.85, 0.4, porosity), w);
  p.roughness = mix(p.roughness, mix(0.08, 0.3, porosity * porosity), w);

  // Puddles fill flat ground where the noise is low, more as it gets wetter; rain rings them.
  if (up > 0.9 && p0.metallic < 0.5) {
    let nz = weather_noise(world.xz * 0.22);
    let level = 1.0 - s0.x * s2.w * 0.32;
    let mask = smoothstep(level, level + 0.04, 1.0 - nz) * smoothstep(0.9, 0.97, up) * open * (1.0 - snow_cover);
    if (mask > 0.0) {
      p.base_color = mix(p.base_color, p.base_color * 0.3, mask);
      p.roughness = mix(p.roughness, 0.015, mask);
      let r = weather_ripples(world.xz, s1.x, s0.w);
      p.normal = normalize(mix(p.normal, normalize(vec3f(r.x, 1.0, r.y)), mask));
    }
  }

  // Snow: on what faces up first, spreading as it settles.
  if (snow_cover > 0.0) {
    let ns = weather_noise(world.xz * 1.9 + vec2f(world.y * 0.7));
    let reach = 1.15 - snow_cover * 1.25;
    // Never on walls or overhangs: snow needs something to lie on.
    let s = smoothstep(reach, reach + 0.18, n.y * 0.75 + ns * 0.35) * smoothstep(0.2, 0.45, n.y) * open;
    p.base_color = mix(p.base_color, vec3f(0.86, 0.88, 0.92), s);
    p.roughness = mix(p.roughness, 0.7, s);
    p.metallic = mix(p.metallic, 0.0, s);
    p.normal = normalize(mix(p.normal, vec3f(0.0, 1.0, 0.0), s * 0.5));
  }
  return p;
}`,

    // Rain, snow and splashes (0133): instanced streaks and flakes in a box that follows the
    // camera, anchored to the world, and splashes on what the camera sees. Lit like any surface,
    // plus the sky they refract; gone under cover.
    'shard::weather::precip': `
import shard::view::view;
import shard::pbr::types::PbrInput;
import shard::pbr::lighting::apply_lighting;
import shard::pbr::environment::env_irradiance;
import shard::weather::common::weather_open;

struct PrecipParams {
  /** camera xyz, time (s) */
  a: vec4f,
  /** box size xyz, particle count */
  box: vec4f,
  /** fall velocity xyz (m/s), streak seconds */
  vel: vec4f,
  /** width (m), kind (0 rain, 1 snow, 2 splash), opacity, sway (m) */
  look: vec4f,
}

@group(1) @binding(0) var<uniform> pp: PrecipParams;
@if(SPLASH && MSAA) @group(1) @binding(1) var scene_depth: texture_depth_multisampled_2d;
@if(SPLASH && !MSAA) @group(1) @binding(1) var scene_depth: texture_depth_2d;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) alpha: f32,
  /** 0 a streak, 1 a flake or droplet, 2 a ring */
  @location(3) @interpolate(flat) shape: f32,
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn h3(i: u32) -> vec3f {
  let a = pcg(i * 3u + 1u);
  let b = pcg(a);
  let c = pcg(b);
  return vec3f(f32(a >> 8u), f32(b >> 8u), f32(c >> 8u)) * (1.0 / 16777216.0);
}

const CORNERS = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
);

fn hidden(out: ptr<function, Out>) {
  (*out).clip = vec4f(2.0, 2.0, 2.0, 1.0);
  (*out).alpha = 0.0;
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  let r = h3(ii);
  let r2 = h3(ii + 0x9e3779b9u);
  let t = pp.a.w;
  let snow = pp.look.y > 0.5;
  let speed = 1.0 + (r.y - 0.5) * 0.35;
  let box = pp.box.xyz;
  var p = r * box + pp.vel.xyz * (t * speed);
  if (snow) {
    p.x += sin(t * 1.1 + r.x * 40.0) * pp.look.w;
    p.z += cos(t * 0.9 + r.z * 40.0) * pp.look.w;
  }
  // Wrapped into a box around the camera, so drops stay put in the world as it moves.
  let rel = p - pp.a.xyz + box * 0.5;
  let wrapped = rel - floor(rel / box) * box - box * 0.5;
  let center = pp.a.xyz + wrapped;
  let edge = 1.0 - smoothstep(0.3, 0.5, max(abs(wrapped.x) / box.x, abs(wrapped.z) / box.z));
  let fade = edge * (1.0 - smoothstep(0.35, 0.5, abs(wrapped.y) / box.y));
  let open = weather_open(center);
  let c = CORNERS[vi];
  let to_cam = normalize(view.cameraPosition - center);
  var world: vec3f;
  if (snow) {
    let size = pp.look.x * (0.6 + 0.8 * r.z);
    let side = normalize(cross(vec3f(0.0, 1.0, 0.0), to_cam)) * size;
    let up = normalize(cross(to_cam, side)) * size;
    world = center + side * (c.x * 2.0 - 1.0) + up * (c.y * 2.0 - 1.0);
    out.shape = 1.0;
  } else {
    // Mostly fine drops, a few heavy ones: thickness and streak length vary per drop.
    let v = pp.vel.xyz * speed;
    let axis = normalize(v);
    let heavy = pow(r2.x, 3.0);
    let len = length(v) * pp.vel.w * (0.6 + 0.9 * r2.y);
    let side = normalize(cross(axis, to_cam)) * pp.look.x * (0.45 + 1.4 * heavy);
    world = center + axis * (c.y - 0.5) * len + side * (c.x * 2.0 - 1.0);
    out.shape = 0.0;
  }
  out.clip = view.viewProj * vec4f(world, 1.0);
  out.world = world;
  out.uv = c * 2.0 - 1.0;
  out.alpha = pp.look.z * fade * open * select(0.55 + 0.45 * r2.z, 1.0, snow);
  if (out.alpha <= 0.002) { hidden(&out); }
  return out;
}

/** World position at a pixel of the scene depth. */
@if(SPLASH) fn depth_world(px: vec2i, size: vec2f) -> vec4f {
  let d = textureLoad(scene_depth, px, 0);
  let uv = (vec2f(px) + 0.5) / size;
  let h = view.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return vec4f(h.xyz / h.w, d);
}

/**
 * Splashes: each picks a random pixel of what the camera sees every cycle, and if that is open,
 * near, and faces up, a ring spreads on it (part 0) while droplets jump out of it (parts 1, 2).
 */
@if(SPLASH) @vertex fn vs_splash(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  let splash = ii / 3u;
  let part = ii % 3u;
  let cycle_len = 0.42;
  let t = pp.a.w / cycle_len + h3(splash).x;
  let cycle = u32(floor(t));
  let age = fract(t);
  let r = h3(splash * 7919u + cycle * 104729u);
  let size = vec2f(textureDimensions(scene_depth));
  let px = vec2i(r.xy * (size - 3.0));
  let w0 = depth_world(px, size);
  if (w0.w <= 0.0) { hidden(&out); return out; }
  let wx = depth_world(px + vec2i(2, 0), size).xyz;
  let wy = depth_world(px + vec2i(0, 2), size).xyz;
  var n = normalize(cross(wx - w0.xyz, wy - w0.xyz));
  if (n.y < 0.0) { n = -n; }
  let dist = length(w0.xyz - view.cameraPosition);
  if (n.y < 0.75 || dist > 30.0 || weather_open(w0.xyz) < 0.5) { hidden(&out); return out; }
  let c = CORNERS[vi];
  let fade = (1.0 - smoothstep(18.0, 30.0, dist));
  if (part == 0u) {
    // A ring on the surface, spreading.
    let tangent = normalize(cross(n, vec3f(0.0, 0.0, 1.0)));
    let bitangent = cross(n, tangent);
    let radius = mix(0.01, 0.06, sqrt(age)) * (0.6 + 0.6 * r.z);
    let o = (c * 2.0 - 1.0) * radius;
    out.world = w0.xyz + n * 0.004 + tangent * o.x + bitangent * o.y;
    out.alpha = pp.look.z * 0.35 * (1.0 - age) * (1.0 - age) * fade;
    out.shape = 2.0;
  } else {
    // Droplets bouncing up and out, under gravity, over the first half of the cycle.
    let s = age * 0.5 * cycle_len;
    let angle = r.z * 6.2831853 + f32(part) * 3.14159;
    let out_dir = vec3f(cos(angle), 0.0, sin(angle));
    let pos = w0.xyz + out_dir * (0.55 * s) + n * (1.3 * s - 4.9 * s * s);
    let to_cam = normalize(view.cameraPosition - pos);
    let side = normalize(cross(vec3f(0.0, 1.0, 0.0), to_cam)) * 0.0045;
    let up = normalize(cross(to_cam, side)) * 0.0045;
    out.world = pos + side * (c.x * 2.0 - 1.0) + up * (c.y * 2.0 - 1.0);
    out.alpha = pp.look.z * select(0.0, (1.0 - age * 2.0), age < 0.5) * fade;
    out.shape = 1.0;
  }
  out.clip = view.viewProj * vec4f(out.world, 1.0);
  out.uv = c * 2.0 - 1.0;
  if (out.alpha <= 0.002) { hidden(&out); }
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  var a = 0.0;
  if (in.shape < 0.5) {
    // A streak: thin across, soft at both ends.
    a = (1.0 - abs(in.uv.x)) * (1.0 - in.uv.y * in.uv.y);
  } else if (in.shape < 1.5) {
    a = 1.0 - smoothstep(0.35, 1.0, length(in.uv));
  } else {
    let l = length(in.uv);
    a = exp(-((l - 0.8) * (l - 0.8)) / 0.02) * (1.0 - smoothstep(0.95, 1.0, l));
  }
  a *= in.alpha;
  if (a <= 0.002) { discard; }
  let snow = pp.look.y > 0.5 && pp.look.y < 1.5;
  var p: PbrInput;
  p.base_color = select(vec3f(0.6), vec3f(0.95), snow);
  p.alpha = 1.0;
  p.normal = normalize(view.cameraPosition - in.world);
  p.metallic = 0.0;
  p.roughness = 0.5;
  p.emissive = vec3f(0.0);
  p.occlusion = 1.0;
  var lit = apply_lighting(p, in.world, in.clip, 4u);
  // Water refracts the sky behind it: drops are glints of sky light more than lit surfaces.
  if (!snow && view.envParams.w > 0.5) {
    lit = lit * 0.9 + env_irradiance(vec3f(0.0, 1.0, 0.0)) * view.envParams.x * 0.45;
  }
  let c = lit * view.exposure;
  return vec4f(c * a, a);
}`,

    // Lightning bolts: camera-facing ribbons along the bolt's segments, glowing.
    'shard::weather::bolt': `
import shard::view::view;

struct Segment {
  /** start xyz, width (m) */
  a: vec4f,
  /** end xyz, brightness */
  b: vec4f,
}

@group(1) @binding(0) var<uniform> bolt: vec4f;
@group(1) @binding(1) var<storage, read> segments: array<Segment>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) across: f32,
  @location(1) @interpolate(flat) brightness: f32,
}

const CORNERS = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
);

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let s = segments[ii];
  let c = CORNERS[vi];
  let p = mix(s.a.xyz, s.b.xyz, c.y);
  let to_cam = normalize(view.cameraPosition - p);
  let side = normalize(cross(s.b.xyz - s.a.xyz, to_cam)) * s.a.w;
  var out: Out;
  out.clip = view.viewProj * vec4f(p + side * (c.x * 2.0 - 1.0), 1.0);
  out.across = c.x * 2.0 - 1.0;
  out.brightness = s.b.w;
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let core = 1.0 - abs(in.across);
  let glow = core * core * (0.4 + 0.6 * core * core);
  let c = vec3f(0.82, 0.86, 1.0) * bolt.x * in.brightness * glow * view.exposure;
  return vec4f(min(c, vec3f(60000.0)), 0.0);
}`,
  }
}
