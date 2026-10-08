// GPU foliage (0045): compact instances placed by compute per chunk, culled per camera, drawn
// indirectly through the material's own hooks.
//
// An instance is 16 bytes (vec4u):
//   x  position x, y (unorm16 each, over the chunk's bounds)
//   y  position z (unorm16), mesh (8 bits), flags (8 bits: 1 placed)
//   z  up (octahedral, 2 × unorm8), yaw (unorm8 of a turn), scale (unorm8 over the layer's range)
//   w  shade (unorm8), thinning rank (unorm8)
// A chunk slot owns `per_chunk` instances, one per lattice cell, so placement needs no atomics.

/** Bytes per placement dispatch's parameters (a dynamic uniform offset). */
export const PLACE_PARAMS_BYTES = 256
/** Floats per patch vertex: position (3), normal (3), density, pad. */
export const PATCH_FLOATS = 8
/** Floats per chunk record: chunk → world rows (12), bounds min (3) + active, size (3) + pad. */
export const CHUNK_FLOATS = 20
/** Floats in a view's cull parameters. */
export const CULL_PARAMS_FLOATS = 44
/** Meshes a layer may draw (weights are 8 vec4s). */
export const MAX_FOLIAGE_MESHES = 32

const COMMON = `
const PLACED: u32 = 1u;

struct FoliageChunk {
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  /** Bounds of its positions (xyz) and whether the slot holds a chunk (w > 0.5). */
  bmin: vec4f,
  bsize: vec4f,
}

struct FoliageInstance {
  position: vec3f,
  mesh: u32,
  up: vec3f,
  yaw: f32,
  scale: f32,
  shade: f32,
  rank: f32,
  placed: bool,
}

fn oct_wrap(v: vec2f) -> vec2f {
  return (1.0 - abs(v.yx)) * select(vec2f(-1.0), vec2f(1.0), v.xy >= vec2f(0.0));
}

fn oct_encode(n: vec3f) -> vec2f {
  var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { p = oct_wrap(p); }
  return p * 0.5 + 0.5;
}

fn oct_decode(e: vec2f) -> vec3f {
  let f = e * 2.0 - 1.0;
  var n = vec3f(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  let t = clamp(-n.z, 0.0, 1.0);
  n = vec3f(n.x + select(t, -t, n.x >= 0.0), n.y + select(t, -t, n.y >= 0.0), n.z);
  return normalize(n);
}

fn decode_instance(raw: vec4u, chunk: FoliageChunk, scale_min: f32, scale_max: f32) -> FoliageInstance {
  var out: FoliageInstance;
  let q = vec3f(f32(raw.x & 0xffffu), f32(raw.x >> 16u), f32(raw.y & 0xffffu)) / 65535.0;
  out.position = chunk.bmin.xyz + q * chunk.bsize.xyz;
  out.mesh = (raw.y >> 16u) & 0xffu;
  out.placed = ((raw.y >> 24u) & PLACED) != 0u;
  out.up = oct_decode(vec2f(f32(raw.z & 0xffu), f32((raw.z >> 8u) & 0xffu)) / 255.0);
  out.yaw = f32((raw.z >> 16u) & 0xffu) / 256.0 * 6.2831853;
  out.scale = mix(scale_min, scale_max, f32(raw.z >> 24u) / 255.0);
  out.shade = f32(raw.w & 0xffu) / 255.0;
  out.rank = f32((raw.w >> 8u) & 0xffu) / 255.0;
  return out;
}

/** Rotates v by unit quaternion q. */
fn quat_rotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

/** World rows of an instance: the chunk's frame times its local transform (up, yaw, scale). */
fn instance_rows(chunk: FoliageChunk, inst: FoliageInstance, scale: vec3f) -> array<vec4f, 3> {
  // Shortest arc from +Y to up, then yaw about +Y (the CPU's writeRotation).
  let q = normalize(vec4f(inst.up.z, 0.0, -inst.up.x, 1.0 + inst.up.y));
  let c = cos(inst.yaw);
  let s = sin(inst.yaw);
  let ax = quat_rotate(q, vec3f(c, 0.0, -s)) * scale.x;
  let ay = inst.up * scale.y;
  let az = quat_rotate(q, vec3f(s, 0.0, c)) * scale.z;
  let p = inst.position;
  return array<vec4f, 3>(
    compose_row(chunk.row0, ax, ay, az, p),
    compose_row(chunk.row1, ax, ay, az, p),
    compose_row(chunk.row2, ax, ay, az, p),
  );
}

/** One row of (chunk frame) × (local basis ax, ay, az and translation p). */
fn compose_row(m: vec4f, ax: vec3f, ay: vec3f, az: vec3f, p: vec3f) -> vec4f {
  return vec4f(dot(m.xyz, vec3f(ax.x, ay.x, az.x)), dot(m.xyz, vec3f(ax.y, ay.y, az.y)), dot(m.xyz, vec3f(ax.z, ay.z, az.z)), dot(m.xyz, p) + m.w);
}

/** Of the instances in range, the share kept at a distance (fraction of the range): far ones thin out. */
fn keep_share(f: f32, start: f32) -> f32 {
  if (f <= start) { return 1.0; }
  return mix(1.0, 0.3, clamp((f - start) / max(1e-4, 1.0 - start), 0.0, 1.0));
}
`

export const FOLIAGE_SHADERS: Record<string, string> = {
  'shard::foliage::common': COMMON,

  'shard::foliage::place': `
import shard::foliage::common::{ PLACED, oct_encode };

struct PlaceParams {
  cells: u32,
  grid: u32,
  slot: u32,
  per_chunk: u32,
  gi0: i32,
  gj0: i32,
  domain: u32,
  seed: u32,
  accept: f32,
  jitter: f32,
  scale_min: f32,
  scale_max: f32,
  align: f32,
  mesh_count: u32,
  avoid_count: u32,
  radial: u32,
  patch_base: u32,
  avoid_base: u32,
  _p0: u32,
  _p1: u32,
  /** The chunk's origin in its surface's frame (radial up on planets). */
  origin: vec4f,
  bmin: vec4f,
  bsize: vec4f,
  /** Cumulative pick weights per mesh, ending at 1. */
  weights: array<vec4f, 8>,
}

@group(0) @binding(0) var<uniform> params: PlaceParams;
@group(0) @binding(1) var<storage, read> ground: array<f32>;
@group(0) @binding(2) var<storage, read> avoid: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> instances: array<vec4u>;

fn mix32(x: u32) -> u32 {
  var h = x;
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  return h ^ (h >> 16u);
}

/** The CPU's cellRandom (rules.ts): hash32 of the rule seed, the global cell, its domain, a stream. */
fn cell_random(gi: i32, gj: i32, stream: u32) -> f32 {
  let h = mix32(params.seed ^ (bitcast<u32>(gi) * 501125321u) ^ (bitcast<u32>(gj) * 1136930381u) ^ (params.domain * 1720413743u) ^ (stream * 1066037191u));
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

struct PatchSample {
  position: vec3f,
  normal: vec3f,
  density: f32,
}

fn vertex_at(i: u32, j: u32) -> PatchSample {
  let o = params.patch_base + (i + j * params.grid) * 8u;
  var s: PatchSample;
  s.position = vec3f(ground[o], ground[o + 1u], ground[o + 2u]);
  s.normal = vec3f(ground[o + 3u], ground[o + 4u], ground[o + 5u]);
  s.density = ground[o + 6u];
  return s;
}

/** The patch at (s, t) in [0, 1]²: its grid's triangles, split along (i, j)–(i+1, j+1) like the ground. */
fn patch_at(s: f32, t: f32) -> PatchSample {
  let n = f32(params.grid - 1u);
  let fx = clamp(s * n, 0.0, n);
  let fy = clamp(t * n, 0.0, n);
  let i = min(u32(fx), params.grid - 2u);
  let j = min(u32(fy), params.grid - 2u);
  let a = fx - f32(i);
  let b = fy - f32(j);
  let p00 = vertex_at(i, j);
  let p11 = vertex_at(i + 1u, j + 1u);
  var out: PatchSample;
  if (a >= b) {
    let p10 = vertex_at(i + 1u, j);
    out.position = p00.position + a * (p10.position - p00.position) + b * (p11.position - p10.position);
    out.normal = p00.normal + a * (p10.normal - p00.normal) + b * (p11.normal - p10.normal);
    out.density = p00.density + a * (p10.density - p00.density) + b * (p11.density - p10.density);
  } else {
    let p01 = vertex_at(i, j + 1u);
    out.position = p00.position + b * (p01.position - p00.position) + a * (p11.position - p01.position);
    out.normal = p00.normal + b * (p01.normal - p00.normal) + a * (p11.normal - p01.normal);
    out.density = p00.density + b * (p01.density - p00.density) + a * (p11.density - p01.density);
  }
  out.normal = normalize(out.normal);
  return out;
}

fn weight(m: u32) -> f32 {
  return params.weights[m / 4u][m % 4u];
}

@compute @workgroup_size(64)
fn place(@builtin(global_invocation_id) id: vec3u) {
  let c = id.x;
  if (c >= params.cells * params.cells) { return; }
  let out = params.slot * params.per_chunk + c;
  let i = c % params.cells;
  let j = c / params.cells;
  let gi = params.gi0 + i32(i);
  let gj = params.gj0 + i32(j);
  instances[out] = vec4u(0u);
  let accept = cell_random(gi, gj, 0u);
  if (accept >= params.accept) { return; }
  let lo = (1.0 - params.jitter) * 0.5;
  let s = (f32(i) + lo + params.jitter * cell_random(gi, gj, 1u)) / f32(params.cells);
  let t = (f32(j) + lo + params.jitter * cell_random(gi, gj, 2u)) / f32(params.cells);
  let p = patch_at(s, t);
  if (accept >= params.accept * p.density) { return; }
  for (var k = 0u; k < params.avoid_count; k++) {
    let a = avoid[params.avoid_base + k];
    let d = p.position - a.xyz;
    if (dot(d, d) < a.w * a.w) { return; }
  }
  var radial = vec3f(0.0, 1.0, 0.0);
  if (params.radial == 1u) { radial = normalize(params.origin.xyz + p.position); }
  let up = normalize(mix(radial, p.normal, params.align));
  let pick = cell_random(gi, gj, 3u);
  var mesh = params.mesh_count - 1u;
  for (var m = 0u; m < params.mesh_count; m++) {
    if (pick < weight(m)) { mesh = m; break; }
  }
  let q = clamp((p.position - params.bmin.xyz) / max(params.bsize.xyz, vec3f(1e-6)), vec3f(0.0), vec3f(1.0));
  let qi = vec3u(round(q * 65535.0));
  let o = vec2u(round(oct_encode(up) * 255.0));
  let yaw = u32(cell_random(gi, gj, 5u) * 256.0) & 0xffu;
  let scale = u32(round(cell_random(gi, gj, 6u) * 255.0));
  let shade = u32(round(cell_random(gi, gj, 7u) * 255.0));
  let rank = u32(round(cell_random(gi, gj, 8u) * 255.0));
  instances[out] = vec4u(
    qi.x | (qi.y << 16u),
    qi.z | (mesh << 16u) | (PLACED << 24u),
    o.x | (o.y << 8u) | (yaw << 16u) | (scale << 24u),
    shade | (rank << 8u),
  );
}
`,

  'shard::foliage::cull': `
import shard::foliage::common::{ FoliageChunk, decode_instance, keep_share };

struct CullParams {
  planes: array<vec4f, 6>,
  /** Camera position (xyz, origin-relative world) and the layer's range (w). */
  camera: vec4f,
  /** Shadow range, where thinning starts (fraction of range), the meshes' largest radius, unused. */
  ranges: vec4f,
  /** Where each LOD level after the first begins, as fractions of the range (up to 4). */
  lods: vec4f,
  per_chunk: u32,
  chunk_count: u32,
  /** Meshes placement picks from, and the drawables (each mesh's levels) they draw as. */
  mesh_count: u32,
  drawables: u32,
  scale_min: f32,
  scale_max: f32,
  _p0: u32,
  _p1: u32,
}

/** Per drawable (a mesh's level of detail): index count, first index, base vertex. */
struct MeshInfo { count: u32, first: u32, base: u32, _p: u32 }

@group(0) @binding(0) var<uniform> params: CullParams;
@group(0) @binding(1) var<storage, read> instances: array<vec4u>;
@group(0) @binding(2) var<storage, read> chunks: array<FoliageChunk>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> meshes: array<MeshInfo>;
/** Per instance: its drawable in the camera's list and in the shadow list (+1; 0: neither). */
@group(0) @binding(6) var<storage, read_write> classes: array<u32>;
@group(0) @binding(7) var<storage, read_write> counts: array<atomic<u32>>;
/** Per mesh placement picks: its first drawable and how many levels it has. */
@group(0) @binding(8) var<storage, read> levels: array<vec2u>;

/** One args record per (list, drawable): the camera's list (0) and its shadow casters (1). */
@compute @workgroup_size(64)
fn reset(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= params.drawables * 2u) { return; }
  let mesh = meshes[k % params.drawables];
  atomicStore(&args[k * 5u], mesh.count);
  atomicStore(&args[k * 5u + 1u], 0u);
  atomicStore(&args[k * 5u + 2u], mesh.first);
  atomicStore(&args[k * 5u + 3u], mesh.base);
  atomicStore(&args[k * 5u + 4u], 0u);
  atomicStore(&counts[k], 0u);
}

/** Pass 1: which list and drawable each instance lands in, counted per drawable. */
@compute @workgroup_size(64)
fn classify(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let n = id.x + id.y * groups.x * 64u;
  if (n >= params.chunk_count * params.per_chunk) { return; }
  classes[n] = 0u;
  let chunk = chunks[n / params.per_chunk];
  if (chunk.bmin.w < 0.5) { return; }
  let inst = decode_instance(instances[n], chunk, params.scale_min, params.scale_max);
  if (!inst.placed) { return; }
  let world = vec3f(dot(chunk.row0.xyz, inst.position) + chunk.row0.w, dot(chunk.row1.xyz, inst.position) + chunk.row1.w, dot(chunk.row2.xyz, inst.position) + chunk.row2.w);
  let d = distance(world, params.camera.xyz);
  let range = params.camera.w;
  // Its level by distance, then the drawable for that level.
  let lod = levels[inst.mesh];
  let f = d / max(range, 1e-3);
  var level = 0u;
  for (var l = 0u; l + 1u < lod.y && l < 4u; l++) {
    if (f >= params.lods[l]) { level = l + 1u; }
  }
  let drawable = lod.x + level;
  var kind = 0u;
  if (d < params.ranges.x) {
    kind = (drawable + 1u) << 16u;
    atomicAdd(&counts[params.drawables + drawable], 1u);
  }
  if (d < range && inst.rank <= keep_share(f, params.ranges.y)) {
    let r = params.ranges.z * inst.scale * 2.0;
    var inside = true;
    for (var p = 0; p < 6; p++) {
      let plane = params.planes[p];
      if (dot(plane.xyz, world) + plane.w < -r) { inside = false; }
    }
    if (inside) {
      kind = kind | (drawable + 1u);
      atomicAdd(&counts[drawable], 1u);
    }
  }
  classes[n] = kind;
}

/** Pass 2: each drawable's first instance in the visible list (an exclusive prefix sum). */
@compute @workgroup_size(1)
fn scan() {
  var start = 0u;
  for (var k = 0u; k < params.drawables * 2u; k++) {
    atomicStore(&args[k * 5u + 4u], start);
    start += atomicLoad(&counts[k]);
  }
}

/** Pass 3: instances into their drawables' ranges; the instance counts end as the draws' counts. */
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let n = id.x + id.y * groups.x * 64u;
  if (n >= params.chunk_count * params.per_chunk) { return; }
  let kind = classes[n];
  if (kind == 0u) { return; }
  let own = kind & 0xffffu;
  if (own != 0u) {
    let k = own - 1u;
    let slot = atomicAdd(&args[k * 5u + 1u], 1u);
    visible[atomicLoad(&args[k * 5u + 4u]) + slot] = n;
  }
  let shadow = kind >> 16u;
  if (shadow != 0u) {
    let k = params.drawables + shadow - 1u;
    let slot = atomicAdd(&args[k * 5u + 1u], 1u);
    visible[atomicLoad(&args[k * 5u + 4u]) + slot] = n;
  }
}
`,

  'shard::foliage::vertex': `
import shard::pbr::types::VertexOutput;
import shard::mesh::{ Instance, mesh_vertex };
import shard::foliage::common::{ FoliageChunk, decode_instance, instance_rows, keep_share };

/** What a draw needs per camera: where it is (thinning and fade), the layer's range and scale. */
struct FoliageDraw {
  camera: vec4f,
  /** Where thinning starts (fraction of range), scale min, scale max, instances per chunk. */
  params: vec4f,
}

@data @group(2) @binding(0) var<storage, read> foliage_instances: array<vec4u>;
@data @group(2) @binding(1) var<storage, read> foliage_visible: array<u32>;
@data @group(2) @binding(2) var<storage, read> foliage_chunks: array<FoliageChunk>;
@group(2) @binding(3) var<uniform> foliage_draw: FoliageDraw;

/**
 * mesh_vertex for a foliage instance: decoded, thinned blades widened, the far edge of the range
 * shrunk to nothing, then the material's vertex hooks as for any mesh. InstanceData reads
 * (fade, shade).
 */
fn foliage_vertex(instance_index: u32, position: vec3f, normal: vec3f, uv: vec2f, uv1: vec2f, tangent: vec4f) -> VertexOutput {
  let n = foliage_visible[instance_index];
  let per_chunk = u32(foliage_draw.params.w);
  let chunk = foliage_chunks[n / per_chunk];
  let inst = decode_instance(foliage_instances[n], chunk, foliage_draw.params.y, foliage_draw.params.z);
  let world = vec3f(dot(chunk.row0.xyz, inst.position) + chunk.row0.w, dot(chunk.row1.xyz, inst.position) + chunk.row1.w, dot(chunk.row2.xyz, inst.position) + chunk.row2.w);
  let f = distance(world, foliage_draw.camera.xyz) / max(foliage_draw.camera.w, 1e-3);
  let keep = keep_share(f, foliage_draw.params.x);
  let fade = 1.0 - smoothstep(0.88, 1.0, f);
  let wide = inverseSqrt(keep);
  let s = inst.scale * fade;
  var rows = instance_rows(chunk, inst, vec3f(s * wide, s, s * wide));
  var record: Instance;
  record.row0 = rows[0];
  record.row1 = rows[1];
  record.row2 = rows[2];
  record.batch = 0u;
  record.flags = 7u;
  record.range = pack2x16float(vec2f(fade, inst.shade));
  record.entity = 0u;
  return mesh_vertex(record, position, normal, uv, uv1, tangent);
}
`,

  'shard::foliage::forward': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::foliage::vertex::foliage_vertex;
import shard::pbr::material::{ pbr_input, fragment_output };
import shard::pbr::standard::material;
import shard::pbr::lighting::apply_lighting;

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> VertexOutput {
  var out = foliage_vertex(instance_index, position, normal, uv, uv1, tangent);
  out.clip = view.viewProj * vec4f(out.world_position, 1.0);
  return out;
}

@fragment fn fs(in: VertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var p = pbr_input(in);
  if (material.alphaMode == 1u && p.alpha < material.alphaCutoff) { discard; }
  // Two-sided: the back of a blade faces the viewer.
  if (!front) { p.normal = -p.normal; }
  let color = (apply_lighting(p, in.world_position, in.clip, in.flags) + p.emissive) * view.exposure;
  return vec4f(fragment_output(vec4f(color, p.alpha)).rgb, 1.0);
}
`,

  'shard::foliage::gbuffer': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::foliage::vertex::foliage_vertex;
import shard::pbr::material::pbr_input;
import shard::pbr::standard::material;
import shard::pbr::gbuffer::{ GBufferOutput, pack_gbuffer };

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> VertexOutput {
  var out = foliage_vertex(instance_index, position, normal, uv, uv1, tangent);
  out.clip = view.viewProj * vec4f(out.world_position, 1.0);
  return out;
}

@fragment fn fs(in: VertexOutput, @builtin(front_facing) front: bool) -> GBufferOutput {
  var p = pbr_input(in);
  @if(MASK) if (p.alpha < material.alphaCutoff) { discard; }
  if (!front) { p.normal = -p.normal; }
  return pack_gbuffer(p, true, view.exposure);
}
`,

  'shard::foliage::shadow': `
import shard::pbr::types::VertexOutput;
import shard::foliage::vertex::foliage_vertex;
import shard::pbr::material::pbr_input;
import shard::pbr::standard::material;

struct ShadowView { view_proj: mat4x4f }
@group(0) @binding(0) var<uniform> shadow_view: ShadowView;

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> VertexOutput {
  var out = foliage_vertex(instance_index, position, normal, uv, uv1, tangent);
  out.clip = shadow_view.view_proj * vec4f(out.world_position, 1.0);
  return out;
}

@fragment fn fs_mask(in: VertexOutput) {
  let p = pbr_input(in);
  if (p.alpha < material.alphaCutoff) { discard; }
}
`,
}
