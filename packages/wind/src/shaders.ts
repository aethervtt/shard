import { MAX_UPLOADED_ZONES } from './zones'

/** vec4 slots `shard::wind` reserves in `shard::globals`: three for the wind, six per zone. */
export const WIND_SLOTS = 3 + MAX_UPLOADED_ZONES * 6

/**
 * `shard::wind` (0096) and `shard::wind::sway`, reading the wind block at `slot` of
 * `shard::globals`' data (ShaderGlobals). The math matches `windAt` and `applyZones`.
 *
 * Block: [0] direction (unit), speed; [1] side (unit), gustScale; [2] gustiness, wind time, zone
 * count; then per zone: world→zone rows ×3, half size (a sphere's radius in x) + falloff, override
 * velocity + speedScale, flags (sphere, override).
 */
export function windShaders(slot: number): Record<string, string> {
  return {
    'shard::wind': `
import shard::globals::globals;

const WIND_BLOCK: u32 = ${slot}u;

/** Seconds on the wind clock: fixed ticks times the step (the server's ticks on a client). */
fn wind_time() -> f32 {
  return globals.data[WIND_BLOCK + 2u].y;
}

/** An integer hash to [0, 1) (no trig: this runs for every vertex of every blade). */
fn wind_hash(c: vec2i) -> f32 {
  var h = bitcast<u32>(c.x) * 747796405u + bitcast<u32>(c.y) * 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32((h >> 22u) ^ h) * (1.0 / 4294967296.0);
}

/** Smooth gust noise in [0, 1]: value noise. */
fn wind_gust_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let s = f * f * (3.0 - 2.0 * f);
  let c = vec2i(i);
  let a = mix(wind_hash(c), wind_hash(c + vec2i(1, 0)), s.x);
  let b = mix(wind_hash(c + vec2i(0, 1)), wind_hash(c + vec2i(1, 1)), s.x);
  return mix(a, b, s.y);
}

/**
 * The wind at a world-space point at a wind-clock time (wind_time()): xyz its velocity
 * (direction × speed, m/s, after WindZones), w the gust (m/s, within ±speed × gustiness).
 */
fn wind_at(p: vec3f, time: f32) -> vec4f {
  let h0 = globals.data[WIND_BLOCK];
  let h1 = globals.data[WIND_BLOCK + 1u];
  let h2 = globals.data[WIND_BLOCK + 2u];
  var v = h0.xyz * h0.w;
  let count = u32(h2.z);
  for (var i = 0u; i < count; i++) {
    let o = WIND_BLOCK + 3u + i * 6u;
    let r0 = globals.data[o];
    let r1 = globals.data[o + 1u];
    let r2 = globals.data[o + 2u];
    let size = globals.data[o + 3u];
    let own = globals.data[o + 4u];
    let flags = globals.data[o + 5u];
    let local = vec3f(dot(r0.xyz, p) + r0.w, dot(r1.xyz, p) + r1.w, dot(r2.xyz, p) + r2.w);
    var outside: f32;
    if (flags.x > 0.5) {
      outside = max(length(local) - size.x, 0.0);
    } else {
      outside = length(max(abs(local) - size.xyz, vec3f(0.0)));
    }
    var w = select(0.0, 1.0, outside <= 0.0);
    if (size.w > 0.0) {
      w = clamp(1.0 - outside / size.w, 0.0, 1.0);
    }
    let goal = select(v, own.xyz, flags.y > 0.5) * own.w;
    v = mix(v, goal, w);
  }
  let along = vec2f(dot(p, h0.xyz), dot(p, h1.xyz)) * h1.w;
  let g = wind_gust_noise(along - vec2f(time * 0.6, 0.0));
  return vec4f(v, length(v) * h2.x * (2.0 * g - 1.0));
}
`,
    'shard::wind::sway': `
import shard::wind::{ wind_at, wind_time };
import shard::mesh::{ vertex_uv1, mesh_current_instance };

/**
 * Sways a vertex with the wind at its instance's origin (0045's sway): \`sway\` is metres a tip
 * moves in a 6 m/s breeze, weighted by the part code (uv1.x) squared, so roots and trunks stay put.
 * The push is tangent to the instance's up axis and bends down to keep the length.
 */
fn wind_sway(position: vec3f, sway: f32) -> vec3f {
  if (sway <= 0.0) { return position; }
  let part = vertex_uv1().x;
  // The instance's axes and origin, straight from its transform's rows.
  let inst = mesh_current_instance;
  let ex = vec3f(inst.row0.x, inst.row1.x, inst.row2.x);
  let ey = vec3f(inst.row0.y, inst.row1.y, inst.row2.y);
  let ez = vec3f(inst.row0.z, inst.row1.z, inst.row2.z);
  let origin = vec3f(inst.row0.w, inst.row1.w, inst.row2.w);
  let up = normalize(ey);
  let time = wind_time();
  let w4 = wind_at(origin, time);
  let speed = length(w4.xyz);
  var wind = w4.xyz - up * dot(w4.xyz, up);
  let len = length(wind);
  if (len < 1e-5) { return position; }
  wind = wind / len;
  // A fast flutter rides on the gusts. At the default gustiness (0.3) this is 0045's tuning:
  // strength (speed / 6) × (0.35 + 0.65 × gust in [0, 1] + 0.3 × flutter).
  let flutter = sin(time * 3.1 + dot(origin, vec3f(0.37, 0.21, 0.43)) * 2.0) * 0.25;
  let push = max(sway / 6.0 * part * part * (speed * (0.675 + flutter * 0.3) + w4.w * (0.65 / 0.6)), 0.0);
  let w = wind * push;
  // World direction to object space (rows of a rotation times uniform scale).
  let local = vec3f(dot(ex, w) / dot(ex, ex), dot(ey, w) / dot(ey, ey), dot(ez, w) / dot(ez, ez));
  // Bending down as it leans keeps the blade's length.
  return position + local - vec3f(0.0, 0.5 * dot(local, local) * part, 0.0);
}
`,
  }
}
