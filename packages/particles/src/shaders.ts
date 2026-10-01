import type { EmitterDef } from './effect'
import { MODULES } from './modules'
import { wgslFloat as f, WGSL_RANDOM } from './values'

/** Floats per particle: pos + age, vel + life, size, rot, rot speed, seed, color. */
export const PARTICLE_FLOATS = 16
/** Bytes of the simulation uniform (see `Sim` below). */
export const SIM_BYTES = 336
/** Bytes of the draw uniform (see `Draw` below). */
export const DRAW_BYTES = 112

const PARTICLE = `
struct Particle {
  /** position, age */
  p0: vec4f,
  /** velocity, lifetime (0: never spawned) */
  p1: vec4f,
  /** size, rotation, rotation speed, seed bits */
  p2: vec4f,
  /** initial color (linear, alpha) */
  p3: vec4f,
}`

const SIM = `
struct Sim {
  /** The entity's transform. */
  model: mat4x4f,
  /** Where spawns go: the transform (world space) or identity (local). */
  spawn: mat4x4f,
  view_proj: mat4x4f,
  inv_view_proj: mat4x4f,
  camera: vec4f,
  viewport: vec4f,
  dt: f32,
  time: f32,
  capacity: u32,
  spawn_base: u32,
  spawn_count: u32,
  seed: u32,
  local: u32,
  has_depth: u32,
  /** A floating-origin shift to add to particles alive before this frame (spec 0040); else 0. */
  origin_offset: vec4f,
}`

/** Module code of an emitter, with an id per module (so helper names don't clash). */
function modules(def: EmitterDef) {
  return def.update.map((p, i) => ({ def: MODULES[p.module as string]!, p, id: `m${i}` }))
}

/** A stable key for an emitter's shaders: its modules and render settings. */
export function emitterKey(def: EmitterDef): string {
  return JSON.stringify([def.shape, def.init, def.update, def.render.mode, def.render.flipbook])
}

/** The compute module of an emitter: spawn (ring allocation), update (modules inlined), count. */
export function simulationShader(def: EmitterDef): string {
  const ms = modules(def)
  const s = def.shape
  const i = def.init
  const lo = (r: [number, number]) => f(r[0])
  const hi = (r: [number, number]) => f(r[1])
  const c0 = `vec4f(${i.color[0].map(f).join(', ')})`
  const c1 = `vec4f(${i.color[1].map(f).join(', ')})`
  const shape = {
    point: 'dir = random_dir(seed, 6u);',
    sphere: `dir = random_dir(seed, 6u); p = dir * ${f(s.radius)} * pow(rand(seed, 9u), 0.3333333);`,
    cone: `{
      let a = radians(${f(s.angle)}) * sqrt(rand(seed, 6u));
      let phi = 6.2831853 * rand(seed, 7u);
      dir = vec3f(sin(a) * cos(phi), cos(a), sin(a) * sin(phi));
      let r = ${f(s.radius)} * sqrt(rand(seed, 8u));
      p = vec3f(cos(phi) * r, 0.0, sin(phi) * r);
    }`,
    box: `p = (vec3f(rand(seed, 6u), rand(seed, 7u), rand(seed, 8u)) - 0.5) * vec3f(${s.size.map(f).join(', ')}); dir = vec3f(0.0, 1.0, 0.0);`,
  }[s.type]
  return `${WGSL_RANDOM}
${PARTICLE}
${SIM}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> sim: Sim;
@group(0) @binding(2) var depth_texture: texture_depth_2d;
@group(0) @binding(3) var<storage, read_write> counter: array<atomic<u32>, 4>;

fn random_dir(seed: u32, k: u32) -> vec3f {
  let z = rand(seed, k) * 2.0 - 1.0;
  let phi = 6.2831853 * rand(seed, k + 1u);
  let r = sqrt(max(1.0 - z * z, 0.0));
  return vec3f(r * cos(phi), z, r * sin(phi));
}

fn surface_at(px: vec2i) -> vec3f {
  let d = textureLoad(depth_texture, px, 0);
  let uv = (vec2f(px) + 0.5) / sim.viewport.xy;
  let w = sim.inv_view_proj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return w.xyz / w.w;
}

/** Collision with what the camera sees: the surface normal (xyz) and 1 when the next step hits. */
fn depth_collision(pos: vec3f, vel: vec3f, thickness: f32) -> vec4f {
  if (sim.has_depth == 0u) { return vec4f(0.0); }
  var world = pos + vel * sim.dt;
  if (sim.local != 0u) { world = (sim.model * vec4f(world, 1.0)).xyz; }
  let clip = sim.view_proj * vec4f(world, 1.0);
  if (clip.w <= 0.0) { return vec4f(0.0); }
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return vec4f(0.0); }
  let size = vec2i(sim.viewport.xy);
  let px = min(vec2i(uv * sim.viewport.xy), size - 2);
  let d = textureLoad(depth_texture, px, 0);
  // Reversed-Z: the surface is in front of the particle's next position, and close to it.
  if (d <= 0.0 || d <= ndc.z) { return vec4f(0.0); }
  let surface = surface_at(px);
  if (distance(surface, world) > thickness) { return vec4f(0.0); }
  var n = normalize(cross(surface_at(px + vec2i(0, 1)) - surface, surface_at(px + vec2i(1, 0)) - surface));
  if (dot(n, sim.camera.xyz - surface) < 0.0) { n = -n; }
  if (sim.local != 0u) { n = normalize((transpose(sim.model) * vec4f(n, 0.0)).xyz); }
  return vec4f(n, 1.0);
}

${ms.map((m) => m.def.functions?.(m.p, m.id) ?? '').join('\n')}

/** One thread per new particle: slot k mod capacity, so allocation is deterministic. */
@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sim.spawn_count) { return; }
  let k = sim.spawn_base + gid.x;
  let slot = k % sim.capacity;
  let seed = pcg(sim.seed ^ pcg(k));
  var p = vec3f(0.0);
  var dir = vec3f(0.0, 1.0, 0.0);
  ${shape}
  var pos = p;
  var vel = dir * mix(${lo(i.speed)}, ${hi(i.speed)}, rand(seed, 1u));
  let life = max(mix(${lo(i.lifetime)}, ${hi(i.lifetime)}, rand(seed, 2u)), 1e-3);
  let size = mix(${lo(i.size)}, ${hi(i.size)}, rand(seed, 3u));
  let rot = radians(mix(${lo(i.rotation)}, ${hi(i.rotation)}, rand(seed, 4u)));
  let color = mix(${c0}, ${c1}, rand(seed, 5u));
  var rot_speed = 0.0;
  ${ms.map((m) => m.def.init?.(m.p) ?? '').join('\n  ')}
  if (sim.local == 0u) {
    pos = (sim.spawn * vec4f(pos, 1.0)).xyz;
    vel = (sim.spawn * vec4f(vel, 0.0)).xyz;
  }
  particles[slot] = Particle(vec4f(pos, 0.0), vec4f(vel, life), vec4f(size, rot, rot_speed, bitcast<f32>(seed)), color);
}

var<workgroup> alive: atomic<u32>;

/** One thread per slot: age, the modules, integrate; counts the living. */
@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&alive, 0u); }
  workgroupBarrier();
  if (gid.x < sim.capacity) {
    var q = particles[gid.x];
    let life = q.p1.w;
    var age = q.p0.w;
    if (life > 0.0 && age < life) {
      let dt = sim.dt;
      let time = sim.time;
      let seed = bitcast<u32>(q.p2.w);
      let rot_speed = q.p2.z;
      var pos = q.p0.xyz;
      // Slots spawned this frame are already in the new origin frame; older ones catch up.
      let origin_fresh = (gid.x + sim.capacity - sim.spawn_base % sim.capacity) % sim.capacity < sim.spawn_count;
      if (!origin_fresh) { pos += sim.origin_offset.xyz; }
      var vel = q.p1.xyz;
      var rot = q.p2.y;
      age += dt;
      ${ms.map((m) => m.def.update?.(m.p, m.id) ?? '').join('\n      ')}
      pos += vel * dt;
      q.p0 = vec4f(pos, age);
      q.p1 = vec4f(vel, life);
      q.p2.y = rot;
      particles[gid.x] = q;
      if (age < life) { atomicAdd(&alive, 1u); }
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    let n = atomicLoad(&alive);
    if (n > 0u) { atomicAdd(&counter[0], n); }
  }
}`
}

/** The draw module of an emitter: billboards (or meshes) from the particle buffer. */
export function renderShader(def: EmitterDef): string {
  const ms = modules(def)
  const mode = def.render.mode
  const orient = {
    billboard: `let right = cam_right; let up = cam_up;`,
    stretched: `let axis = select(cam_up, normalize(vel_w), length(vel_w) > 1e-4);
    let right = normalize(cross(axis, normalize(view.cameraPosition - center)));
    let up = axis * (1.0 + length(vel_w) * draw.params.z / max(size, 1e-4));`,
    axis: `let up = vec3f(0.0, 1.0, 0.0);
    let right = normalize(cross(up, normalize(view.cameraPosition - center)));`,
    mesh: '',
  }[mode]
  const corner =
    mode === 'mesh'
      ? `let r = mat2x2f(cos(rot), sin(rot), -sin(rot), cos(rot));
    let local = position * size;
    let xz = r * local.xz;
    let world = center + vec3f(xz.x, local.y, xz.y);
    out.uv = vec2f(0.5);`
      : `let c = corner(v);
    let off = (c * 2.0 - 1.0) * size * 0.5;
    let rr = vec2f(off.x * cos(rot) - off.y * sin(rot), off.x * sin(rot) + off.y * cos(rot));
    ${orient}
    let world = center + right * rr.x + up * rr.y;
    out.uv = vec2f(c.x, 1.0 - c.y);`
  return `import shard::view::view;
${PARTICLE}

struct Draw {
  model: mat4x4f,
  /** emissive (cd/m²), softness (m), stretch, local */
  params: vec4f,
  /** flipbook columns, rows, fps (0: over life), 0 */
  flipbook: vec4f,
  /** blend (0 additive, 1 alpha, 2 premultiplied), sorted, 0, 0 */
  mode: vec4u,
}

@data @group(1) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(1) var<uniform> draw: Draw;
@data @group(1) @binding(2) var<storage, read> order: array<u32>;
@group(2) @binding(0) var sprite: texture_2d<f32>;
@group(2) @binding(1) var sprite_sampler: sampler;
@group(2) @binding(2) var scene_depth: texture_depth_2d;

struct ParticleOutput {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) view_depth: f32,
}

fn corner(k: u32) -> vec2f {
  let c = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  return c[k];
}

${ms.map((m) => m.def.functions?.(m.p, m.id) ?? '').join('\n')}

@vertex fn vs(
  @builtin(vertex_index) v: u32,
  @builtin(instance_index) instance: u32,
  ${mode === 'mesh' ? '@location(0) position: vec3f,' : ''}
) -> ParticleOutput {
  var out: ParticleOutput;
  let index = select(instance, order[instance], draw.mode.y != 0u);
  let q = particles[index];
  let life = q.p1.w;
  let age = q.p0.w;
  if (life <= 0.0 || age >= life) {
    out.clip = vec4f(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  let t = age / life;
  var color = q.p3;
  var size = q.p2.x;
  let rot = q.p2.y;
  ${ms.map((m) => m.def.render?.(m.p, m.id) ?? '').join('\n  ')}
  var center = q.p0.xyz;
  var vel_w = q.p1.xyz;
  if (draw.params.w != 0.0) {
    center = (draw.model * vec4f(center, 1.0)).xyz;
    vel_w = (draw.model * vec4f(vel_w, 0.0)).xyz;
  }
  let cam_right = vec3f(view.view[0][0], view.view[1][0], view.view[2][0]);
  let cam_up = vec3f(view.view[0][1], view.view[1][1], view.view[2][1]);
  {
    ${corner}
    out.clip = view.viewProj * vec4f(world, 1.0);
    out.view_depth = -(view.view * vec4f(world, 1.0)).z;
  }
  // Flipbook: frames across columns, then rows, by time or over life.
  let frames = max(draw.flipbook.x * draw.flipbook.y, 1.0);
  var frame = floor(t * frames);
  if (draw.flipbook.z > 0.0) { frame = floor(age * draw.flipbook.z) % frames; }
  let cell = vec2f(frame % draw.flipbook.x, floor(frame / draw.flipbook.x));
  out.uv = (cell + out.uv) / max(draw.flipbook.xy, vec2f(1.0));
  out.color = color;
  return out;
}

@fragment fn fs(in: ParticleOutput) -> @location(0) vec4f {
  var t = textureSample(sprite, sprite_sampler, in.uv);
  var fade = 1.0;
  if (draw.params.y > 0.0) {
    // Soft particles: fade where the particle meets the scene behind it.
    let d = textureLoad(scene_depth, vec2i(in.clip.xy), 0);
    if (d > 0.0) {
      let ndc = vec2f(in.clip.x * view.viewport.z * 2.0 - 1.0, 1.0 - in.clip.y * view.viewport.w * 2.0);
      let w = view.invViewProj * vec4f(ndc, d, 1.0);
      let scene = -(view.view * vec4f(w.xyz / w.w, 1.0)).z;
      fade = clamp((scene - in.view_depth) / draw.params.y, 0.0, 1.0);
    }
  }
  let blend = draw.mode.x;
  let a = select(t.a * in.color.a, in.color.a, blend == 2u) * fade;
  // Premultiplied textures already carry alpha in color.
  let rgb = select(t.rgb * t.a, t.rgb, blend == 2u) * in.color.rgb * in.color.a * fade * draw.params.x * view.exposure;
  if (blend == 0u) { return vec4f(rgb, 0.0); }
  return vec4f(rgb, a);
}`
}

/** Bitonic sort steps (alpha emitters): keys by view depth, far first; dead slots last. */
export const SORT_SHADER = `
import shard::view::view;
${PARTICLE}

struct Step { j: u32, k: u32, n: u32, capacity: u32 }

@group(0) @binding(10) var<storage, read> particles: array<Particle>;
@group(0) @binding(11) var<storage, read_write> keys: array<f32>;
@group(0) @binding(12) var<storage, read_write> order: array<u32>;
@group(0) @binding(13) var<uniform> step: Step;
@group(0) @binding(14) var<uniform> model: mat4x4f;

@compute @workgroup_size(64)
fn keys_pass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= step.n) { return; }
  order[i] = i;
  var key = 3.0e38;
  if (i < step.capacity) {
    let q = particles[i];
    if (q.p1.w > 0.0 && q.p0.w < q.p1.w) {
      let world = (model * vec4f(q.p0.xyz, 1.0)).xyz;
      key = (view.view * vec4f(world, 1.0)).z;
    }
  }
  keys[i] = key;
}

@compute @workgroup_size(64)
fn sort_pass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let l = i ^ step.j;
  if (i >= step.n || l <= i) { return; }
  let ascending = (i & step.k) == 0u;
  let a = keys[i];
  let b = keys[l];
  if ((a > b) == ascending) {
    keys[i] = b;
    keys[l] = a;
    let t = order[i];
    order[i] = order[l];
    order[l] = t;
  }
}`
