import { MAX_FOG_VOLUMES } from './volumetric-fog'

// Volumetric fog (0132): froxels lit with the forward pass's own lights and shadows (group 0 is the
// forward view group, visible to compute on the full tier), reprojected, integrated front to back,
// and applied over the scene with the camera's Fog continuing analytically past the volume.

export const VOLUMETRIC_FOG_SHADERS: Record<string, string> = {
  'shard::volumetric_fog::common': `
import shard::view::view;

struct FogFrame {
  /** froxels across, down, slices; distance (m) */
  grid: vec4f,
  /** depth curve, anisotropy, temporal weight, history valid */
  params: vec4f,
  /** global medium: density at y = 0, height falloff, start (m), on */
  medium: vec4f,
  /** global albedo rgb; ambient scale */
  albedo: vec4f,
  /** volumes, lights on, slice jitter, near plane (m) */
  misc: vec4f,
  /** time (s); the projection's depth terms A, B: ndc depth = B / view depth − A (any far plane) */
  misc2: vec4f,
}

/** View depth (m) at a continuous slice coordinate (0 at the camera, slices at the far end). */
fn slice_depth(f: FogFrame, s: f32) -> f32 {
  return f.grid.w * pow(clamp(s / f.grid.z, 0.0, 1.0), f.params.x);
}

/** The continuous slice coordinate of a view depth. */
fn depth_slice(f: FogFrame, vd: f32) -> f32 {
  return pow(clamp(vd / f.grid.w, 0.0, 1.0), 1.0 / f.params.x) * f.grid.z;
}

/** World position at a screen uv (0,0 top-left) and view depth, reversed-Z infinite projection. */
fn froxel_world(f: FogFrame, uv: vec2f, vd: f32) -> vec3f {
  let ndc = vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, f.misc2.z / max(vd, f.misc.w) - f.misc2.y);
  let p = view.invViewProj * vec4f(ndc, 1.0);
  return p.xyz / p.w;
}

fn fog_hg(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}`,

  'shard::volumetric_fog::light': `
import shard::view::view;
import shard::pbr::lights::{ lights, clusters, directional, light_falloff, LIGHT_SPOT, NO_SHADOW, CLUSTER_X, CLUSTER_Y, CLUSTER_Z, CLUSTER_COUNT, MAX_PER_CLUSTER };
import shard::pbr::shadows::{ directional_shadow, spot_shadow, point_shadow };
import shard::pbr::environment::env_irradiance;
@if(SKY_OCCLUSION) import shard::sky_occlusion::sky_occlusion;
import shard::volumetric_fog::common::{ FogFrame, slice_depth, depth_slice, froxel_world, fog_hg };

struct FogVolumeGpu {
  /** World → local rows (the shape is the unit cube or sphere at the origin). */
  inv0: vec4f,
  inv1: vec4f,
  inv2: vec4f,
  /** density, edge, height falloff, shape (0 box, 1 sphere) */
  p0: vec4f,
  /** albedo, anisotropy (−1: the camera's) */
  p1: vec4f,
  /** emission, noise */
  p2: vec4f,
  /** noise scale, noise speed */
  p3: vec4f,
  /** bottom y (m), blend (0 add, 1 max), sky light reaching inside */
  p4: vec4f,
}

@group(1) @binding(0) var<uniform> fp: FogFrame;
@group(1) @binding(1) var<storage, read> volumes: array<FogVolumeGpu, ${MAX_FOG_VOLUMES}>;
@group(1) @binding(2) var history: texture_3d<f32>;
@group(1) @binding(3) var lin: sampler;
@group(1) @binding(4) var out_lit: texture_storage_3d<rgba16float, write>;

fn fog_hash(c: vec3i) -> f32 {
  var h = (bitcast<u32>(c.x) * 747796405u) ^ (bitcast<u32>(c.y) * 2891336453u) ^ (bitcast<u32>(c.z) * 2246822519u);
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32((h >> 22u) ^ h) * (1.0 / 4294967296.0);
}

fn fog_value(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = mix(fog_hash(i), fog_hash(i + vec3i(1, 0, 0)), s.x);
  let b = mix(fog_hash(i + vec3i(0, 1, 0)), fog_hash(i + vec3i(1, 1, 0)), s.x);
  let c = mix(fog_hash(i + vec3i(0, 0, 1)), fog_hash(i + vec3i(1, 0, 1)), s.x);
  let d = mix(fog_hash(i + vec3i(0, 1, 1)), fog_hash(i + vec3i(1, 1, 1)), s.x);
  return mix(mix(a, b, s.y), mix(c, d, s.y), s.z);
}

fn fog_noise(p: vec3f) -> f32 {
  return fog_value(p) * 0.55 + fog_value(p * 2.07 + 13.1) * 0.3 + fog_value(p * 4.3 + 7.7) * 0.15;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec3f(id) >= fp.grid.xyz)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / fp.grid.xy;
  let vd = max(slice_depth(fp, f32(id.z) + fp.misc.z), fp.misc.w * 1.01);
  let world = froxel_world(fp, uv, vd);
  let to = world - view.cameraPosition;
  let dist = length(to);
  let dir = to / max(dist, 1e-5);

  // The medium: the camera's Fog, then each FogVolume.
  var sigma = 0.0;
  // Sky light reaching each part of the medium, weighted by its density.
  var sky_weight = 0.0;
  var albedo = vec3f(0.0);
  var emission = vec3f(0.0);
  var g = fp.params.y;
  if (fp.medium.w > 0.5 && dist >= fp.medium.z) {
    let s = fp.medium.x * exp(-fp.medium.y * world.y);
    sigma += s;
    sky_weight += s;
    albedo += fp.albedo.rgb * s;
  }
  let count = u32(fp.misc.x);
  for (var i = 0u; i < count; i++) {
    let v = volumes[i];
    let w4 = vec4f(world, 1.0);
    let local = vec3f(dot(v.inv0, w4), dot(v.inv1, w4), dot(v.inv2, w4));
    let m = select(max(max(abs(local.x), abs(local.y)), abs(local.z)), length(local), v.p0.w > 0.5) * 2.0;
    if (m >= 1.0) { continue; }
    var d = v.p0.x * (1.0 - smoothstep(1.0 - v.p0.y, 1.0, m));
    if (v.p0.z > 0.0) { d *= exp(-v.p0.z * max(world.y - v.p4.x, 0.0)); }
    if (v.p2.w > 0.0) {
      let n = fog_noise(world * v.p3.x - v.p3.yzw * v.p3.x * fp.misc2.x);
      d *= clamp(1.0 - v.p2.w + v.p2.w * n * 2.0, 0.0, 2.0);
    }
    if (v.p4.y > 0.5) {
      // max: the denser of this volume and what's there wins.
      if (d > sigma) {
        albedo = v.p1.rgb * d;
        sky_weight = v.p4.z * d;
        sigma = d;
      }
    } else {
      sigma += d;
      sky_weight += v.p4.z * d;
      albedo += v.p1.rgb * d;
    }
    emission += v.p2.rgb * d;
    if (v.p1.w >= 0.0) { g = mix(g, v.p1.w, clamp(d / max(sigma, 1e-6), 0.0, 1.0)); }
  }

  var lit = vec4f(emission * view.exposure, sigma);
  if (sigma > 1e-7) {
    albedo = albedo / sigma;
    var L = vec3f(0.0);
    // Sun and moon, through their cascades and the clouds.
    for (var i = 0u; i < directional.count; i++) {
      let light = directional.lights[i];
      let l = normalize(light.direction);
      var vis = 1.0;
      if (light.shadowed != 0u) { vis = directional_shadow(world, l, vd, vec2f(id.xy) + f32(id.z) * 7.0); }
      @if(SKY_OCCLUSION) vis *= sky_occlusion(world, l);
      L += light.color * view.sunTransmittance[i].rgb * vis * fog_hg(dot(l, dir), g);
    }
    // The sky, scattered evenly.
    var sky = view.ambient;
    if (view.envParams.w > 0.5) { sky = env_irradiance(vec3f(0.0, 1.0, 0.0)) * view.envParams.x; }
    L += sky * fp.albedo.w * (sky_weight / sigma);
    // Point and spot lights from the froxel's cluster, with their shadow maps.
    let near = view.clusterParams.x;
    if (fp.misc.y > 0.5 && vd >= near && vd <= view.clusterParams.y) {
      let tx = min(u32(uv.x * f32(CLUSTER_X)), CLUSTER_X - 1u);
      let ty = min(u32(uv.y * f32(CLUSTER_Y)), CLUSTER_Y - 1u);
      let tz = min(u32(max(log(vd / near) * view.clusterParams.z, 0.0)), CLUSTER_Z - 1u);
      let cluster = tx + ty * CLUSTER_X + tz * CLUSTER_X * CLUSTER_Y;
      let n = clusters[cluster];
      let base = CLUSTER_COUNT + cluster * MAX_PER_CLUSTER;
      for (var k = 0u; k < n; k++) {
        let light = lights[clusters[base + k]];
        let to_light = light.position - world;
        let d2 = max(dot(to_light, to_light), 1e-4);
        let d = sqrt(d2);
        let l = to_light / d;
        var att = light_falloff(light, d, d2);
        if (light.kind == LIGHT_SPOT) {
          let cd = dot(-l, light.direction);
          let spot = clamp(cd * light.spot_scale + light.spot_offset, 0.0, 1.0);
          att *= spot * spot;
        }
        if (att <= 0.0) { continue; }
        if (light.shadow != NO_SHADOW) {
          if (light.kind == LIGHT_SPOT) {
            att *= spot_shadow(light.shadow, world, l, light.position, light.shadow_bias, light.shadow_normal_bias, 0.0, vec2f(id.xy));
          } else {
            att *= point_shadow(light.shadow, world, l, light.shadow_bias, light.shadow_normal_bias, 0.0, vec2f(id.xy));
          }
        }
        L += light.color * att * fog_hg(dot(l, dir), g);
      }
    }
    lit = vec4f((albedo * sigma * L + emission) * view.exposure, sigma);
  }

  // Last frame's volume at this froxel's center, where it was then.
  var result = lit;
  if (fp.params.w > 0.5) {
    let center = froxel_world(fp, uv, slice_depth(fp, f32(id.z) + 0.5));
    let clip = view.prevViewProj * vec4f(center, 1.0);
    if (clip.w > 1e-4) {
      let ndc = clip.xy / clip.w;
      let puv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
      let ps = depth_slice(fp, clip.w) / fp.grid.z;
      if (all(puv >= vec2f(0.0)) && all(puv <= vec2f(1.0)) && ps <= 1.0) {
        let h = textureSampleLevel(history, lin, vec3f(puv, ps), 0.0);
        result = mix(lit, h, fp.params.z);
      }
    }
  }
  textureStore(out_lit, id, result);
}`,

  // Front to back along each froxel column: in-scattering so far and transmittance, per slice.
  'shard::volumetric_fog::integrate': `
import shard::volumetric_fog::common::{ FogFrame, slice_depth, froxel_world };

@group(1) @binding(0) var<uniform> fp: FogFrame;
@group(1) @binding(1) var lit: texture_3d<f32>;
@group(1) @binding(2) var out_volume: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(vec2f(id.xy) >= fp.grid.xy)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / fp.grid.xy;
  // Metres along the ray per metre of view depth, for this column.
  let stretch = length(froxel_world(fp, uv, 2.0) - froxel_world(fp, uv, 1.0));
  var acc = vec3f(0.0);
  var T = 1.0;
  var prev = 0.0;
  let slices = u32(fp.grid.z);
  for (var z = 0u; z < slices; z++) {
    let next = slice_depth(fp, f32(z + 1u));
    let ds = (next - prev) * stretch;
    let s = textureLoad(lit, vec3i(vec2i(id.xy), i32(z)), 0);
    let sigma = max(s.a, 1e-7);
    let e = exp(-sigma * ds);
    acc += T * s.rgb * (1.0 - e) / sigma;
    T *= e;
    textureStore(out_volume, vec3u(id.xy, z), vec4f(acc, T));
    prev = next;
  }
}`,

  // Over the scene: the volume to the pixel's depth, and past the volume the camera's analytic Fog.
  'shard::volumetric_fog::apply': `
import shard::view::view;
import shard::volumetric_fog::common::{ FogFrame, depth_slice };
import shard::post::fog::common::{ FogParams, fog_apply };

@group(1) @binding(0) var<uniform> fp: FogFrame;
@group(1) @binding(1) var volume: texture_3d<f32>;
@group(1) @binding(2) var lin: sampler;
@if(MSAA) @group(1) @binding(3) var scene_depth: texture_depth_multisampled_2d;
@if(!MSAA) @group(1) @binding(3) var scene_depth: texture_depth_2d;
@group(1) @binding(4) var<uniform> far: FogParams;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Out;
  out.clip = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let depth = textureLoad(scene_depth, vec2i(in.clip.xy), 0);
  let vd = select(1e9, fp.misc2.z / max(depth + fp.misc2.y, 1e-9), depth > 0.0);
  let slices = fp.grid.z;
  let s = depth_slice(fp, min(vd, fp.grid.w));
  var v = textureSampleLevel(volume, lin, vec3f(in.uv, max(s - 0.5, 0.5) / slices), 0.0);
  // In front of the first slice's far edge, fade in from the camera.
  if (s < 1.0) { v = mix(vec4f(0.0, 0.0, 0.0, 1.0), v, s); }
  // Past the volume, the camera's Fog from its far end on (fog_apply over black: its in-scattering and opacity).
  var far_s = vec3f(0.0);
  var far_t = 1.0;
  if (fp.medium.w > 0.5 && vd > fp.grid.w) {
    let a = fog_apply(vec4f(0.0), in.uv, depth, far);
    far_s = a.rgb;
    far_t = 1.0 - a.a;
  }
  // Premultiplied over the scene: color × (T_volume × T_far) + in-scattering.
  return vec4f(v.rgb + far_s * v.a, v.a * far_t);
}`,
}
