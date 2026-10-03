import { wgslLayout } from '@aethervtt/shard-shader'
import { VariationUniform } from './surface-model'

// The WGSL of surface variation (0068). `surface::variation` mirrors `surfaceVariation`
// (surface-model.ts) step for step; change one and change the other. Pattern, seed and every range
// are uniforms and the pattern's switch is uniform control flow, so every variation shares one
// pipeline.

const VARIATION = `
import shard::pbr::types::VertexOutput;

${wgslLayout(VariationUniform).wgsl}

/** What a variation does at a point: a base colour multiplier and a roughness offset. */
struct SurfaceVariation {
  tint: vec3f,
  roughness: f32,
}

fn surface_hash(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}

/** A cell's value in [0, 1): 24 bits of its hash, exact in f32. */
fn surface_cell(c: vec2i, seed: u32) -> f32 {
  let h = surface_hash(bitcast<u32>(c.x) ^ surface_hash(bitcast<u32>(c.y) ^ surface_hash(seed)));
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

/** smoothstep that tolerates equal edges (a step). */
fn surface_step(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / max(b - a, 1e-5), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/** Value noise in [0, 1], smooth between integer lattice points. */
fn surface_noise(p: vec2f, seed: u32) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let c = vec2i(i);
  let a = surface_cell(c, seed);
  let b = surface_cell(c + vec2i(1, 0), seed);
  let d = surface_cell(c + vec2i(0, 1), seed);
  let e = surface_cell(c + vec2i(1, 1), seed);
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}

/** Three soft steps: posterized paint bands. */
fn surface_bands(v: f32) -> f32 {
  return (surface_step(0.18, 0.28, v) + surface_step(0.43, 0.53, v) + surface_step(0.68, 0.78, v)) / 3.0;
}

/** A slanted brush mark in each cell of p. */
fn surface_brush(p: vec2f, seed: u32) -> f32 {
  let cell = floor(p);
  let l0 = p - cell - 0.5;
  let c = vec2i(cell);
  let slant = (surface_cell(c, seed) - 0.5) * 1.35;
  let lx = l0.x + l0.y * slant;
  let ly = l0.y - l0.x * slant * 0.35;
  let len = 1.0 - surface_step(0.3, 0.49, abs(lx));
  let width = 1.0 - surface_step(0.11, 0.25, abs(ly));
  return len * width * mix(0.45, 1.0, surface_cell(c + vec2i(17, -9), seed));
}

/**
 * The surface point a variation is evaluated at, in metres. projection 0 ('uv'): the mesh's UV
 * (structure's are metres along its faces); 1 ('world'): the world plane the normal is closest to.
 */
fn surface_point(in: VertexOutput, projection: u32) -> vec2f {
  if (projection == 0u) {
    return in.uv;
  }
  let n = abs(in.world_normal);
  let p = in.world_position;
  if (n.y >= n.x && n.y >= n.z) {
    return p.xz;
  }
  if (n.x >= n.z) {
    return vec2f(p.z, -p.y);
  }
  return vec2f(p.x, -p.y);
}

/** The variation at surface point p (metres). */
fn surface_variation(p: vec2f, v: VariationUniform) -> SurfaceVariation {
  let seed = v.seed;
  var q = p / max(v.scale, vec2f(1e-3));
  if (v.warp > 0.0) {
    let w = vec2f(
      surface_noise(q * 0.7 + vec2f(-6.2, 8.1), seed + 7u),
      surface_noise(q * 0.7 + vec2f(3.7, -2.9), seed + 5u),
    );
    q = q + (w - 0.5) * v.warp;
  }
  let d = surface_noise(q * 3.1 + vec2f(9.7, -4.3), seed + 11u);
  var base: f32;
  switch v.pattern {
    case 1u: {
      base = surface_noise(vec2f(q.x * 1.25, q.y * 0.42), seed + 19u);
    }
    case 2u: {
      base = surface_noise(vec2f(q.x * 0.36, q.y * 4.2), seed + 23u);
    }
    case 3u: {
      base = surface_cell(vec2i(floor(q)), seed + 3u);
    }
    case 4u: {
      let row = floor(q.y);
      let col = floor(q.x + 0.5 * (row - 2.0 * floor(row / 2.0)));
      let group = surface_cell(vec2i(floor(vec2f(col, row) / 2.0)), seed + 13u);
      base = mix(group, surface_cell(vec2i(i32(col), i32(row)), seed + 17u), 0.28);
    }
    case 5u: {
      let marks = max(
        surface_brush(q * 1.45, seed + 37u),
        surface_brush(q * 1.45 + vec2f(0.47, 0.63), seed + 41u),
      );
      base = clamp(surface_noise(q, seed + 31u) + (marks - 0.24) * 0.26, 0.0, 1.0);
    }
    default: {
      base = surface_noise(q, seed);
    }
  }
  let value = clamp(mix(mix(base, surface_bands(base), v.bands), d, v.detail), 0.0, 1.0);
  let s = v.strength;
  let weather = surface_step(v.weatherThreshold.x, v.weatherThreshold.y, d) * v.weathering;
  let tone = (value - 0.5) * 2.0 * v.toneRange;
  let k = clamp(1.0 + (tone - weather) * s, 0.62, 1.3);
  var out: SurfaceVariation;
  out.tint = mix(vec3f(1.0), mix(v.coolTint, v.warmTint, value), s) * k;
  out.roughness = ((d - 0.5) * v.roughnessRange + weather * 0.45) * s;
  return out;
}
`

/** SurfaceMaterial's hooks with variation on: the standard surface, tinted and roughened. */
const MATERIAL_ON = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import surface::variation::{ surface_point, surface_variation };
import material::surface_material::SurfaceMaterial;

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let v = surface_variation(surface_point(in, SurfaceMaterial.projection), SurfaceMaterial.variation);
  p.base_color = p.base_color * v.tint;
  p.roughness = clamp(p.roughness + v.roughness, 0.045, 1.0);
  return p;
}`

/**
 * With variation off (SurfaceSettings.variation false): the standard surface and nothing else, so
 * it shades exactly as StandardMaterial, at its cost.
 */
const MATERIAL_OFF = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;

override fn pbr_input(in: VertexOutput) -> PbrInput {
  return standard_input(in);
}`

export const SURFACE_VARIATION_WGSL = VARIATION

/** `surface::material` for variation on or off. */
export function surfaceMaterialWgsl(variation: boolean): string {
  return variation ? MATERIAL_ON : MATERIAL_OFF
}
