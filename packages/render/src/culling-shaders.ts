/** WGSL for GPU culling (see culling.ts; the CPU path in instances.ts mirrors every test). */
export const CULLING_SHADERS: Record<string, string> = {
  'shard::cull': `
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

const NO_BATCH: u32 = 0xffffffffu;
const LOD_BIT: u32 = 0x80000000u;
const LOD_UNSET: u32 = 0xffu;
const FLAG_VISIBLE: u32 = 1u;
const FLAG_CASTER: u32 = 2u;
const FLAG_RANGE: u32 = 8u;
const FLAG_SKINNED: u32 = 32u;
const VIEW_CASTERS: u32 = 1u;
const VIEW_UPDATE_LOD: u32 = 2u;
const VIEW_ORTHO: u32 = 4u;
const VIEW_NO_PLANES: u32 = 8u;
const VIEW_NO_EYE: u32 = 16u;
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
  atomicStore(&args[o + 2u], 0u);
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
  if ((view.flags & VIEW_CASTERS) != 0u) { mask |= FLAG_CASTER; }
  if ((inst.flags & mask) != mask) { return; }
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
  if ((view.flags & VIEW_NO_PLANES) == 0u && !in_frustum(view, sphere)) { return; }
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
