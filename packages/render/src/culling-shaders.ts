/** WGSL for GPU culling (see culling.ts; the CPU path in instances.ts mirrors every test). */
export const CULLING_SHADERS: Record<string, string> = {
  'shard::cull': `
@if(OCCLUSION) import shard::cull_occlusion::{ hides, hides_box, hides_oriented, oriented_box, receiver_box };

struct Instance {
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  batch: u32,
  flags: u32,
  range: u32,
  entity: u32,
}

struct Batch {
  /** Local bounding sphere: center (xyz), radius (w). */
  sphere: vec4f,
  count: u32,
  indexed: u32,
  /** Where the batch's instances start in a view's visible region. */
  region: u32,
  flags: u32,
  /** Its first index (meshes in an arena, 0116). */
  first_index: u32,
  /** Its local box's half extents, about the sphere's center (the occlusion test, 0116). Scalars:
      a vec3f would align to 16 bytes. */
  extent_x: f32,
  extent_y: f32,
  extent_z: f32,
}

struct LodSet {
  count: u32,
  hysteresis: f32,
  bias: f32,
  _pad: u32,
  thresholds: array<vec4f, 2>,
  batches: array<vec4u, 2>,
}

struct CullView {
  planes: array<vec4f, 6>,
  /** xyz: where distances are measured from; w: LOD scale. */
  eye: vec4f,
  flags: u32,
  lod_camera: u32,
  args_base: u32,
  visible_base: u32,
  /** Render layers the view draws (0057). */
  layers: u32,
  /** Its hidden set's first word in lod_state, past the LOD entries (0070), or NO_HIDDEN. */
  @if(HIDDEN) hidden_base: u32,
  @if(!HIDDEN) _pad0: u32,
  /** Shadow views skip casters smaller than this radius (minCasterTexels, 0116). */
  min_radius: f32,
  /** Swept spheres grow by this (the PCF footprint around a receiver). */
  margin: f32,
  /** VIEW_SWEEP: the light's travel direction, then the cascade's far side in light space.
      VIEW_SWEEP_POINT: the light's position, then its range. */
  sweep: vec4f,
  /** Occlusion (0116): the camera's layer + 1 for camera views, and for swept shadow views the
      camera whose buffer hides where shadows fall, and the floor they stop at. 0: none. */
  occlusion: u32,
  receiver: u32,
  floor: f32,
  _pad3: u32,
}


struct Params {
  slot_count: u32,
  view_offset: u32,
  view_count: u32,
  batch_count: u32,
  slot_capacity: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read> instances: array<Instance>;
@group(0) @binding(1) var<storage, read> batches: array<Batch>;
@group(0) @binding(2) var<storage, read> lod_sets: array<LodSet>;
@group(0) @binding(3) var<storage, read> views: array<CullView>;
@group(0) @binding(4) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> visible: array<u32>;
@group(0) @binding(6) var<storage, read_write> lod_state: array<u32>;
@group(0) @binding(7) var<uniform> params: Params;


/** Skinned slots' world spheres (the rest of the deform record is for the vertex stage). */
struct Deform {
  sphere: vec4f,
  rest0: vec4u,
  rest1: vec4u,
}
@group(0) @binding(8) var<storage, read> deforms: array<Deform>;

@if(HIDDEN) const NO_HIDDEN: u32 = 0xffffffffu;

const NO_BATCH: u32 = 0xffffffffu;
const LOD_BIT: u32 = 0x80000000u;
const LOD_UNSET: u32 = 0xffu;
const FLAG_VISIBLE: u32 = 1u;
const FLAG_CASTER: u32 = 2u;
const FLAG_RANGE: u32 = 8u;
const FLAG_SHADOW_ONLY: u32 = 128u;
const FLAG_SKINNED: u32 = 32u;
const VIEW_CASTERS: u32 = 1u;
const VIEW_UPDATE_LOD: u32 = 2u;
const VIEW_ORTHO: u32 = 4u;
const VIEW_NO_PLANES: u32 = 8u;
const VIEW_NO_EYE: u32 = 16u;
const VIEW_STATIC: u32 = 32u;
const VIEW_DYNAMIC: u32 = 64u;
const VIEW_SWEEP: u32 = 128u;
const VIEW_SWEEP_POINT: u32 = 256u;
const DYNAMIC_BIT: u32 = 0x20000000u;
const BATCH_TRANSPARENT: u32 = 1u;
const BATCH_NOT_READY: u32 = 2u;
const ARGS_WORDS: u32 = 5u;

/** Writes every (view, batch) indirect draw: counts from the mesh, zero instances, first instance. */
@compute @workgroup_size(64)
fn reset(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.view_count * params.batch_count) { return; }
  let v = i / params.batch_count;
  let b = i % params.batch_count;
  let batch = batches[b];
  let first = views[v].visible_base + batch.region;
  let o = i * ARGS_WORDS;
  atomicStore(&args[o], batch.count);
  atomicStore(&args[o + 1u], 0u);
  atomicStore(&args[o + 2u], select(0u, batch.first_index, batch.indexed != 0u));
  // Indexed: (count, instances, first index, base vertex, first instance).
  // Non-indexed: (count, instances, first vertex, first instance).
  atomicStore(&args[o + 3u], select(first, batch.indexed - 1u, batch.indexed != 0u));
  atomicStore(&args[o + 4u], select(0u, first, batch.indexed != 0u));
}

fn slot_sphere(inst: Instance, bounds: vec4f) -> vec4f {
  let c = vec4f(bounds.xyz, 1.0);
  let center = vec3f(dot(inst.row0, c), dot(inst.row1, c), dot(inst.row2, c));
  let sx = inst.row0.x * inst.row0.x + inst.row1.x * inst.row1.x + inst.row2.x * inst.row2.x;
  let sy = inst.row0.y * inst.row0.y + inst.row1.y * inst.row1.y + inst.row2.y * inst.row2.y;
  let sz = inst.row0.z * inst.row0.z + inst.row1.z * inst.row1.z + inst.row2.z * inst.row2.z;
  return vec4f(center, bounds.w * sqrt(max(sx, max(sy, sz))));
}

fn in_frustum(view: CullView, s: vec4f) -> bool {
  for (var p = 0; p < 6; p++) {
    let plane = view.planes[p];
    if (dot(plane.xyz, s.xyz) + plane.w < -s.w) { return false; }
  }
  return true;
}

/** A sphere of radius r swept along f for len meters, against the view's planes (capsuleInPlanes). */
fn capsule_in(view: CullView, c: vec3f, r: f32, f: vec3f, len: f32) -> bool {
  let l = max(len, 0.0);
  for (var p = 0; p < 6; p++) {
    let plane = view.planes[p];
    let d0 = dot(plane.xyz, c) + plane.w;
    let d1 = d0 + dot(plane.xyz, f) * l;
    if (max(d0, d1) < -r) { return false; }
  }
  return true;
}

/** Whether a sphere's shadow can reach the view (sphereSweepIn). */
fn in_sweep(view: CullView, s: vec4f) -> bool {
  if ((view.flags & VIEW_SWEEP) != 0u) {
    let len = view.sweep.w - dot(view.sweep.xyz, s.xyz);
    if (len < -s.w) { return false; }
    return capsule_in(view, s.xyz, s.w + view.margin, view.sweep.xyz, len);
  }
  let v = s.xyz - view.sweep.xyz;
  let d = sqrt(dot(v, v));
  if (d - s.w > view.sweep.w) { return false; }
  if (d <= s.w) { return in_frustum(view, s); }
  let k = sqrt(d * d - s.w * s.w);
  let rr = max(view.sweep.w * s.w / k + view.margin, s.w);
  return capsule_in(view, s.xyz, rr, v / d, view.sweep.w - d);
}











/** Mirrors selectLod: with hysteresis once a level is chosen; count means too small to draw. */
fn select_lod(size: f32, lod_set: LodSet, previous: u32) -> u32 {
  let count = lod_set.count;
  if (previous == LOD_UNSET || previous > count) {
    for (var k = 0u; k < count; k++) {
      if (size >= lod_set.thresholds[k / 4u][k % 4u]) { return k; }
    }
    return count;
  }
  var level = previous;
  let h = lod_set.hysteresis;
  loop {
    if (level == 0u) { break; }
    let t = lod_set.thresholds[(level - 1u) / 4u][(level - 1u) % 4u];
    if (size <= t * (1.0 + h)) { break; }
    level--;
  }
  loop {
    if (level >= count) { break; }
    let t = lod_set.thresholds[level / 4u][level % 4u];
    if (size >= t * (1.0 - h)) { break; }
    level++;
  }
  return level;
}

/** One thread per (slot, view): test, choose LOD, append to the batch's visible list. */
@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) id: vec3u) {
  let s = id.x;
  if (s >= params.slot_count) { return; }
  let v = params.view_offset + id.y;
  let view = views[v];
  let inst = instances[s];
  if (inst.batch == NO_BATCH) { return; }
  var mask = FLAG_VISIBLE;
  var flags = inst.flags;
  if ((view.flags & VIEW_CASTERS) != 0u) {
    mask |= FLAG_CASTER;
    // Hidden meshes that still cast (ShadowWhenHidden, 0067).
    if ((flags & FLAG_SHADOW_ONLY) != 0u) { flags |= FLAG_VISIBLE; }
  }
  if ((flags & mask) != mask) { return; }
  // Cached shadow layers draw one class of caster each (0116).
  if ((view.flags & (VIEW_STATIC | VIEW_DYNAMIC)) != 0u
      && ((inst.flags & DYNAMIC_BIT) != 0u) != ((view.flags & VIEW_DYNAMIC) != 0u)) { return; }
  // Render layers (0057) ride in flags bits 8–23.
  if ((((inst.flags >> 8u) & 0xffffu) & view.layers) == 0u) { return; }
  // Hidden from this view (ViewVisibility, 0070): a bit per slot.
  @if(HIDDEN) if (view.hidden_base != NO_HIDDEN && (lod_state[view.hidden_base + (s >> 5u)] & (1u << (s & 31u))) != 0u) { return; }
  var b = inst.batch;
  var lod = false;
  var lod_set: LodSet;
  if ((b & LOD_BIT) != 0u) {
    lod_set = lod_sets[b & ~LOD_BIT];
    b = lod_set.batches[0].x;
    lod = true;
  }
  var batch = batches[b];
  if ((batch.flags & (BATCH_TRANSPARENT | BATCH_NOT_READY)) != 0u) { return; }
  var sphere = slot_sphere(inst, batch.sphere);
  // A skinned pose moves the mesh away from its bounds: the slot's own sphere follows the joints.
  if ((inst.flags & FLAG_SKINNED) != 0u && deforms[s].sphere.w > 0.0) { sphere = deforms[s].sphere; }
  if ((view.flags & VIEW_NO_PLANES) == 0u) {
    if ((view.flags & (VIEW_SWEEP | VIEW_SWEEP_POINT)) != 0u) {
      if (!in_sweep(view, sphere)) { return; }
    } else if (!in_frustum(view, sphere)) { return; }
  }
  if (sphere.w < view.min_radius) { return; }
  // Occlusion (0116): hidden from the camera, or a shadow falling where it can't be seen.
  @if(OCCLUSION) if (view.occlusion != 0u) {
    let skinned = (inst.flags & FLAG_SKINNED) != 0u;
    let extent = vec3f(batch.extent_x, batch.extent_y, batch.extent_z);
    if (skinned && hides(view.occlusion - 1u, sphere.xyz, sphere.w)) { return; }
    if (!skinned && hides_oriented(view.occlusion - 1u, inst.row0, inst.row1, inst.row2, batch.sphere.xyz, extent)) { return; }
  }
  @if(OCCLUSION) if (view.receiver != 0u) {
    var lo = sphere.xyz - vec3f(sphere.w);
    var hi = sphere.xyz + vec3f(sphere.w);
    if ((inst.flags & FLAG_SKINNED) == 0u) {
      oriented_box(inst.row0, inst.row1, inst.row2, batch.sphere.xyz, vec3f(batch.extent_x, batch.extent_y, batch.extent_z), &lo, &hi);
    }
    receiver_box(view.sweep, view.floor, view.margin, &lo, &hi);
    if (hides_box(view.receiver - 1u, lo, hi)) { return; }
  }
  let has_eye = (view.flags & VIEW_NO_EYE) == 0u;
  let distance = select(0.0, length(sphere.xyz - view.eye.xyz), has_eye);
  if ((inst.flags & FLAG_RANGE) != 0u && has_eye) {
    let range = unpack2x16float(inst.range);
    if (distance < range.x || distance >= range.y) { return; }
  }
  var level = 0u;
  if (lod) {
    let idx = view.lod_camera * params.slot_capacity + s;
    if ((view.flags & VIEW_UPDATE_LOD) != 0u) {
      var size = sphere.w * view.eye.w;
      if ((view.flags & VIEW_ORTHO) == 0u) { size = size / max(distance, 1e-4); }
      size = size * exp2(lod_set.bias);
      level = select_lod(size, lod_set, lod_state[idx]);
      lod_state[idx] = level;
    } else {
      level = lod_state[idx];
    }
    if (level >= lod_set.count) { return; }
    b = lod_set.batches[level / 4u][level % 4u];
    batch = batches[b];
    if ((batch.flags & BATCH_NOT_READY) != 0u) { return; }
  }
  let n = atomicAdd(&args[(view.args_base + b) * ARGS_WORDS + 1u], 1u);
  visible[view.visible_base + batch.region + n] = s | (level << 28u);
}`,
}
