import { t } from '@shard/core'
import { defineMaterial } from '@shard/render'

/** Texture repeats line up every this many metres of planet space (layer scales divide it). */
export const TEXTURE_PERIOD = 1024

const frame = {
  center: t.vec4({
    hidden: true,
    description: 'Set by the terrain every frame: the planet center (origin frame) and radius.',
  }),
  rot0: t.vec4({
    hidden: true,
    description:
      'Set by the terrain: origin → planet rotation rows (xyz), planet-space texture origin (w).',
  }),
  rot1: t.vec4({ hidden: true }),
  rot2: t.vec4({ hidden: true }),
  camera: t.vec4({
    hidden: true,
    description:
      'Set by the terrain: the selecting camera (xyz) and pixels per radian / errorPixels (w).',
  }),
}

/**
 * The planet surface material (spec 0043), extending standard. Its vertex stage geomorphs each
 * chunk toward its parent level by distance (or by the edge locks toward coarser and finer
 * neighbors); its surface stage picks the four heaviest biomes per fragment from temperature,
 * moisture, height, slope, and latitude, and samples their layers from the three texture arrays,
 * triplanar in planet space (one top-down sample per biome far away). A project can replace the
 * shader with its own `pbr_input` on a type that extends this one's fields.
 */
export const PlanetMaterial = defineMaterial('terrain/PlanetSurface', {
  shader: 'terrain::planet',
  arrays: ['albedoArray', 'normalArray', 'ormArray'],
  fields: {
    albedoArray: t.handle('Texture', { description: 'The BiomeSet’s albedo array.' }),
    normalArray: t.handle('Texture', { description: 'The BiomeSet’s normal map array.' }),
    ormArray: t.handle('Texture', {
      description: 'The BiomeSet’s occlusion/roughness/metallic array.',
    }),
    biomeTable: t.handle('Texture', {
      hidden: true,
      description: 'Set by the terrain: biome ranges, tints, and layers as a small float texture.',
    }),
    ...frame,
    biomeParams: t.vec4({
      hidden: true,
      description: 'Set by the terrain: biome count, latitude bias, snow line, texture period.',
    }),
    debugParams: t.vec4({
      hidden: true,
      description:
        'Set by the terrain: debug mode (0 off, 1 dominant biome, 2 seams, 3 levels), far-texturing distance, has ORM, 0.',
    }),
  },
  description:
    'Planet terrain: biome blending and triplanar texture-array layers, with geomorphing between LOD levels.',
})

/** The sea surface material: transparent, wave normals, absorption by water depth, Fresnel. */
export const OceanMaterial = defineMaterial('terrain/Ocean', {
  shader: 'terrain::ocean',
  blend: 'alpha',
  fields: {
    ...frame,
    shallow: t.color({ default: [0.05, 0.35, 0.4, 1], description: 'Color over shallow ground.' }),
    deep: t.color({ default: [0.005, 0.03, 0.08, 1], description: 'Color over deep water.' }),
    water: t.vec4({
      default: [0.08, 0.25, 0.35, 0.04],
      description:
        'x: color depth falloff (1/m), y: opacity falloff (1/m), z: minimum opacity, w: roughness.',
    }),
  },
  description: 'Planet ocean: a lit transparent surface with scrolling wave normals.',
})

const MORPH = (u: string) => `
/**
 * How far toward its parent level a vertex has morphed: by distance within the parent's split
 * band; overridden on ring edges by the instance's lock bits (render/InstanceData.y, two bits per
 * edge: 1 this level, 2 the parent's), and on center lines where a partial draw (quadrant mask in
 * InstanceData.x) meets a child's quadrant (this level, which the child's edge matches). Never less
 * than the chunk's fade (the rest of InstanceData.x), 1 as it replaces its parent, easing to 0.
 */
fn terrain_morph(position: vec3f) -> f32 {
  let lock = vertex_uv1();
  let data = vertex_instance_data();
  let mask = u32(floor(data.x * 0.5 + 0.001));
  let fade = clamp(data.x - f32(mask) * 2.0, 0.0, 1.0);
  var t = 0.0;
  let split = lock.y * ${u}.camera.w;
  if (split > 0.0) {
    let d = distance(vertex_world(position), ${u}.camera.xyz);
    t = clamp((d - 0.5 * split) / (0.45 * split), 0.0, 1.0);
  }
  let code = i32(round(lock.x));
  if (code >= 0 && code < 4) {
    // Edges never fade: the neighbor across may not be fading.
    let bits = (u32(data.y + 0.5) >> (u32(code) * 2u)) & 3u;
    if (bits == 1u) { return 0.0; } else if (bits == 2u) { return 1.0; }
    return t;
  } else if (code >= 4 && mask != 15u) {
    // Quadrants on either side of this center-line half (all four at the center).
    var a = 0u;
    var b = 1u;
    if (code == 5) { a = 2u; b = 3u; } else if (code == 6) { a = 0u; b = 2u; } else if (code == 7) { a = 1u; b = 3u; }
    let differ = ((mask >> a) & 1u) != ((mask >> b) & 1u);
    if (differ || (code == 8 && mask != 0u)) { return 0.0; }
  }
  return max(t, fade);
}

override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  return position + vertex_tangent().xyz * terrain_morph(position);
}
`

export const TERRAIN_SHADERS: Record<string, string> = {
  'terrain::planet': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::view::view;
import shard::mesh::{ vertex_uv1, vertex_tangent, vertex_world, vertex_instance_data };
import material::planet_surface::{ PlanetSurface, PlanetSurface_albedoArray, PlanetSurface_albedoArray_sampler, PlanetSurface_normalArray, PlanetSurface_normalArray_sampler, PlanetSurface_ormArray, PlanetSurface_ormArray_sampler, PlanetSurface_biomeTable };
${MORPH('PlanetSurface')}
fn biome_window(x: f32, lo: f32, hi: f32, blend: f32) -> f32 {
  if (!(lo < hi)) { return 1.0; }
  let soft = max(1e-6, blend * (hi - lo));
  return smoothstep(lo - soft, lo + soft, x) * (1.0 - smoothstep(hi - soft, hi + soft, x));
}

fn table(texel: i32, biome: u32) -> vec4f {
  return textureLoad(PlanetSurface_biomeTable, vec2i(texel, i32(biome)), 0);
}

struct Layered {
  albedo: vec3f,
  normal: vec3f,
  orm: vec3f,
}

/** Screen derivatives of the planet-space position (taken in uniform control flow). */
struct Grads {
  dx: vec3f,
  dy: vec3f,
}

fn albedo_at(uv: vec2f, l: i32, gx: vec2f, gy: vec2f) -> vec3f {
  return textureSampleGrad(PlanetSurface_albedoArray, PlanetSurface_albedoArray_sampler, uv, l, gx, gy).rgb;
}

fn orm_at(uv: vec2f, l: i32, gx: vec2f, gy: vec2f) -> vec3f {
  return textureSampleGrad(PlanetSurface_ormArray, PlanetSurface_ormArray_sampler, uv, l, gx, gy).rgb;
}

fn normal_at(uv: vec2f, l: i32, gx: vec2f, gy: vec2f) -> vec3f {
  return textureSampleGrad(PlanetSurface_normalArray, PlanetSurface_normalArray_sampler, uv, l, gx, gy).xyz * 2.0 - 1.0;
}

/** One array layer, triplanar in planet space (or top-down only, far away). */
fn sample_layer(layer: f32, scale: f32, q: vec3f, g: Grads, n: vec3f, bw: vec3f, near: bool) -> Layered {
  var out: Layered;
  let l = i32(layer + 0.5);
  if (!near) {
    // One projection, along the dominant axis, at a coarser scale: no shimmer from orbit.
    let s = 1.0 / (scale * 8.0);
    var uv = q.xz * s;
    var gx = g.dx.xz * s;
    var gy = g.dy.xz * s;
    if (bw.x >= bw.y && bw.x >= bw.z) {
      uv = q.zy * s;
      gx = g.dx.zy * s;
      gy = g.dy.zy * s;
    } else if (bw.z >= bw.y) {
      uv = q.xy * s;
      gx = g.dx.xy * s;
      gy = g.dy.xy * s;
    }
    out.albedo = albedo_at(uv, l, gx, gy);
    out.orm = orm_at(uv, l, gx, gy);
    out.normal = n;
    return out;
  }
  let s = 1.0 / scale;
  let ux = q.zy * s;
  let uy = q.xz * s;
  let uz = q.xy * s;
  let xx = g.dx.zy * s;
  let xy = g.dy.zy * s;
  let yx = g.dx.xz * s;
  let yy = g.dy.xz * s;
  let zx = g.dx.xy * s;
  let zy = g.dy.xy * s;
  out.albedo = albedo_at(ux, l, xx, xy) * bw.x + albedo_at(uy, l, yx, yy) * bw.y + albedo_at(uz, l, zx, zy) * bw.z;
  out.orm = orm_at(ux, l, xx, xy) * bw.x + orm_at(uy, l, yx, yy) * bw.y + orm_at(uz, l, zx, zy) * bw.z;
  // Whiteout-blended tangent normals (Golus), in planet space.
  var tx = normal_at(ux, l, xx, xy);
  var ty = normal_at(uy, l, yx, yy);
  var tz = normal_at(uz, l, zx, zy);
  tx = vec3f(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3f(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3f(tz.xy + n.xy, abs(tz.z) * n.z);
  out.normal = normalize(tx.zyx * bw.x + ty.xzy * bw.y + tz.xyz * bw.z);
  return out;
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let up = normalize(in.world_position - PlanetSurface.center.xyz);
  let n = normalize(in.world_normal);
  let slope = degrees(acos(clamp(dot(n, up), -1.0, 1.0)));
  let latitude = dot(up, PlanetSurface.rot1.xyz);
  let height = in.world_tangent.w;
  let count = u32(PlanetSurface.biomeParams.x);
  let snow = select(0.0, max(height, 0.0) / PlanetSurface.biomeParams.z, PlanetSurface.biomeParams.z > 0.0);
  let temperature = in.uv.x - PlanetSurface.biomeParams.y * abs(latitude) - snow;
  var best_w = vec4f(0.0);
  var best_i = vec4u(0u);
  var sum = 0.0;
  for (var b = 0u; b < count; b++) {
    let r0 = table(0, b);
    let r1 = table(1, b);
    let blend = table(3, b).x;
    let w = biome_window(temperature, r0.x, r0.y, blend) * biome_window(in.uv.y, r0.z, r0.w, blend) *
      biome_window(height, r1.x, r1.y, blend) * biome_window(slope, r1.z, r1.w, blend);
    sum += w;
    if (w > best_w.x) {
      best_w = vec4f(w, best_w.xyz);
      best_i = vec4u(b, best_i.xyz);
    } else if (w > best_w.y) {
      best_w = vec4f(best_w.x, w, best_w.yz);
      best_i = vec4u(best_i.x, b, best_i.yz);
    } else if (w > best_w.z) {
      best_w = vec4f(best_w.xy, w, best_w.z);
      best_i = vec4u(best_i.xy, b, best_i.z);
    } else if (w > best_w.w) {
      best_w.w = w;
      best_i.w = b;
    }
  }
  if (sum < 1e-6) {
    best_w = vec4f(1.0, 0.0, 0.0, 0.0);
    best_i = vec4u(0u);
  }
  best_w /= max(1e-6, best_w.x + best_w.y + best_w.z + best_w.w);
  // Planet-space position (offset to stay small; repeats line up across the offset) and normal.
  let q = vec3f(dot(PlanetSurface.rot0.xyz, in.world_position), dot(PlanetSurface.rot1.xyz, in.world_position), dot(PlanetSurface.rot2.xyz, in.world_position)) +
    vec3f(PlanetSurface.rot0.w, PlanetSurface.rot1.w, PlanetSurface.rot2.w);
  var grads: Grads;
  grads.dx = dpdx(q);
  grads.dy = dpdy(q);
  let debug = u32(PlanetSurface.debugParams.x);
  if (debug == 1u) {
    p.base_color = table(2, best_i.x).rgb;
    p.roughness = 1.0;
    p.metallic = 0.0;
    return p;
  }
  if (debug == 2u) {
    p.base_color = vec3f(1.0);
    p.emissive = vec3f(20000.0);
    return p;
  }
  if (debug == 4u) {
    p.base_color = normalize(in.world_normal) * 0.5 + 0.5;
    p.emissive = p.base_color * 3000.0;
    return p;
  }
  if (debug == 3u) {
    // Levels of detail: a hue per depth (from the depth's morph error, which halves per level).
    let level = floor(log2(max(in.uv1.y, 1e-6)) * 1.0);
    let hue = fract(level * 0.37);
    p.base_color = 0.5 + 0.5 * cos(6.2832 * (vec3f(hue) + vec3f(0.0, 0.33, 0.67)));
    p.emissive = p.base_color * 3000.0;
    return p;
  }
  let np = vec3f(dot(PlanetSurface.rot0.xyz, n), dot(PlanetSurface.rot1.xyz, n), dot(PlanetSurface.rot2.xyz, n));
  var bw = pow(abs(np), vec3f(4.0));
  bw /= max(1e-6, bw.x + bw.y + bw.z);
  let near = distance(in.world_position, view.cameraPosition) < PlanetSurface.debugParams.y;
  var albedo = vec3f(0.0);
  var normal = vec3f(0.0);
  var orm = vec3f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let w = best_w[k];
    if (w <= 0.001) { continue; }
    let b = best_i[k];
    let tint = table(2, b).rgb;
    let info = table(3, b);
    let layers = table(4, b);
    let scales = table(5, b);
    // Layers go from flat ground (first) to cliffs (last), blended by slope.
    let last = max(1.0, info.y) - 1.0;
    let f = clamp(slope / 50.0, 0.0, 1.0) * last;
    let k0 = u32(floor(f));
    let k1 = min(k0 + 1u, u32(last));
    let s = smoothstep(0.0, 1.0, f - floor(f));
    let a = sample_layer(layers[k0], scales[k0], q, grads, np, bw, near);
    var c = a;
    if (k1 != k0 && s > 0.01) {
      let d = sample_layer(layers[k1], scales[k1], q, grads, np, bw, near);
      c.albedo = mix(a.albedo, d.albedo, s);
      c.orm = mix(a.orm, d.orm, s);
      c.normal = normalize(mix(a.normal, d.normal, s));
    }
    albedo += c.albedo * tint * w;
    normal += c.normal * w;
    orm += c.orm * w;
  }
  let pn = normalize(normal);
  p.base_color = albedo;
  p.normal = normalize(PlanetSurface.rot0.xyz * pn.x + PlanetSurface.rot1.xyz * pn.y + PlanetSurface.rot2.xyz * pn.z);
  if (PlanetSurface.debugParams.z > 0.5) {
    p.occlusion = orm.r;
    p.roughness = clamp(orm.g, 0.045, 1.0);
    p.metallic = orm.b;
  } else {
    p.occlusion = 1.0;
    p.roughness = 0.9;
    p.metallic = 0.0;
  }
  return p;
}
`,

  'terrain::ocean': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::globals::globals;
import shard::mesh::{ vertex_uv1, vertex_tangent, vertex_world, vertex_instance_data };
import material::ocean::Ocean;
${MORPH('Ocean')}
/** Slope (d/dx, d/dy) of a few scrolling sine waves at planet-space point xy. */
fn waves(xy: vec2f, t: f32) -> vec2f {
  var g = vec2f(0.0);
  let dirs = array<vec2f, 4>(vec2f(1.0, 0.2), vec2f(-0.4, 1.0), vec2f(0.7, -0.7), vec2f(-1.0, -0.3));
  let lengths = array<f32, 4>(9.0, 5.3, 3.1, 1.7);
  for (var i = 0u; i < 4u; i++) {
    let d = normalize(dirs[i]);
    let k = 6.2831853 / lengths[i];
    let speed = sqrt(9.81 / k);
    let a = 0.04 * lengths[i] / 9.0;
    g += d * (a * k * cos(k * dot(d, xy) - speed * k * t));
  }
  return g;
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let depth = max(in.world_tangent.w, 0.0);
  let up = normalize(in.world_position - Ocean.center.xyz);
  // The point and a tangent frame in planet space, so the waves stay put as the planet turns.
  let q = vec3f(dot(Ocean.rot0.xyz, in.world_position), dot(Ocean.rot1.xyz, in.world_position), dot(Ocean.rot2.xyz, in.world_position)) +
    vec3f(Ocean.rot0.w, Ocean.rot1.w, Ocean.rot2.w);
  let pu = vec3f(dot(Ocean.rot0.xyz, up), dot(Ocean.rot1.xyz, up), dot(Ocean.rot2.xyz, up));
  let helper = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(pu.y) > 0.9);
  let tx = normalize(cross(helper, pu));
  let ty = cross(pu, tx);
  let g = waves(vec2f(dot(q, tx), dot(q, ty)), globals.time);
  let pn = normalize(pu - tx * g.x - ty * g.y);
  p.normal = normalize(Ocean.rot0.xyz * pn.x + Ocean.rot1.xyz * pn.y + Ocean.rot2.xyz * pn.z);
  let shade = 1.0 - exp(-depth * Ocean.water.x);
  p.base_color = mix(Ocean.shallow.rgb, Ocean.deep.rgb, shade);
  p.alpha = clamp(1.0 - exp(-depth * Ocean.water.y), Ocean.water.z, 1.0);
  p.roughness = Ocean.water.w;
  p.metallic = 0.0;
  p.occlusion = 1.0;
  return p;
}
`,
}
