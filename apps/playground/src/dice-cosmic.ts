// Animated dice (0054), ported from Aether's: a black hole whose glass holds a turning vortex and a
// star field bent around its horizon, and pulsar and quasar dice. On a natural 20 the black hole
// opens an accretion disk (a ray-traced lens, as Aether's) and pulls the table in with a lens field
// (0063); on a natural 1 it collapses. All of it is host code: families, a material, an attachment.
// Nothing here is in @aethervtt/shard-dice, which is the point.

import { type AssetRef, type Entity, quat, t, type World } from '@aethervtt/shard-core'
import {
  type DiceAttachmentContext,
  DiceTable,
  defineDiceAttachment,
  defineDiceFamily,
} from '@aethervtt/shard-dice'
import { plane } from '@aethervtt/shard-mesh'
import {
  defineMaterial,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  NotShadowReceiver,
} from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'

/** An sRGB hex color as linear RGBA, for field defaults. */
function hex(s: string): [number, number, number, number] {
  const c = (i: number) => {
    const v = Number.parseInt(s.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return [c(0), c(1), c(2), 1]
}

// --- the black hole -----------------------------------------------------------------------------------

/**
 * Seen through the die's glass: a vortex marched in eight steps along the view ray inside the die
 * (the ray comes from dice_local_ray), a black horizon at its center, and 28 stars bent around it.
 * A natural 20 strengthens the bending; a natural 1 collapses it all over 0.9 s (from resultTime).
 */
export const BlackHoleDice = defineDiceFamily('playground/BlackHoleDice', {
  // A slow vortex: 30 frames a second while it rests is plenty.
  animated: { fps: 30 },
  fields: {
    bhDeep: t.color({ default: hex('#020b1c'), description: 'The void.' }),
    bhBlue: t.color({ default: hex('#0e789b'), description: 'The vortex.' }),
    bhIce: t.color({ default: hex('#d3efff'), description: 'Its bright wisps.' }),
    bhEmber: t.color({ default: hex('#ff914e'), description: 'The hot side.' }),
    bhSpeed: t.f32({ default: 0.22, description: 'Turns of the vortex, radians per second.' }),
    bhGlow: t.f32({ default: 11_000, unit: 'cd/m²', description: 'Light of the vortex.' }),
    bhScale: t.f32({ default: 1, min: 0.2, description: 'Hole size: under 1 for small dice.' }),
    bhTriumph: t.f32({ description: 'The value that bends the stars harder (0: none).' }),
    bhFumble: t.f32({ description: 'The value that collapses the hole (0: none).' }),
  },
  surface: `
  let bh_ray = dice_local_ray(in, local);
  let bh_p = local / F.bhScale;
  let bh_clock = globals.time;
  let bh_since = max(0.0, globals.time - look.result_time);
  let bh_landed = step(0.5, look.result);
  let bh_fumble = bh_landed * step(0.5, F.bhFumble) * (1.0 - step(0.5, abs(value - F.bhFumble)));
  let bh_triumph = bh_landed * step(0.5, F.bhTriumph) * (1.0 - step(0.5, abs(value - F.bhTriumph)));
  let bh_collapse = bh_fumble * smoothstep(0.0, 1.0, bh_since / 0.9);
  let bh_gravity = bh_triumph * smoothstep(0.0, 1.0, bh_since / 1.2) * (0.8 + 0.035 * sin(bh_since * 0.8));
  let bh_closest = bh_p - bh_ray * dot(bh_p, bh_ray);
  let bh_r = length(bh_closest);
  let bh_hr = mix(0.29, 0.025, bh_collapse);
  let bh_horizon = 1.0 - smoothstep(bh_hr, bh_hr + 0.075, bh_r);
  let bh_t = normalize(cross(bh_ray, vec3f(0.3, 1.0, 0.1)) + vec3f(0.0001));
  let bh_b = normalize(cross(bh_t, bh_ray));
  let bh_seed = vec3f(5.3, 3.7, 7.1) * fract(value * 0.618 + 0.37);
  var bh_vortex = vec3f(0.0);
  var bh_cover = 0.0;
  for (var k = 0; k < 8; k++) {
    let q = bh_p + bh_ray * (f32(k) + 0.25) * 0.21;
    let depth = dot(q, bh_ray);
    let radial = q - bh_ray * depth;
    let radius = length(radial);
    let angle = atan2(dot(radial, bh_b), dot(radial, bh_t));
    let winding = angle + depth * 1.6 + radius * 5.5 - bh_clock * F.bhSpeed * (1.0 - 2.0 * bh_collapse);
    let wound = vec3f(cos(winding) * 2.0, sin(winding) * 2.0, radius * 11.0 + depth * 0.7);
    let broad = dice_noise(wound + bh_seed + vec3f(0.0, 0.0, bh_clock * 0.045));
    let detail = dice_noise(wound * vec3f(2.0, 2.0, 3.7) + bh_seed.yzx + broad * 0.8);
    let wisps = smoothstep(0.36, 0.78, broad * 0.72 + detail * 0.28);
    let tunnel = 0.315 + 0.12 * smoothstep(-0.5, 0.65, -depth);
    let wall = smoothstep(tunnel - 0.035, tunnel + 0.1, radius);
    let inside = 1.0 - smoothstep(0.8, 1.15, length(q));
    let envelope = mix(1.0, 1.0 - smoothstep(0.04, 0.3, bh_r), bh_collapse);
    let opacity = wall * inside * (0.055 + wisps * 0.35) * envelope;
    var pigment = mix(F.bhDeep.rgb, F.bhBlue.rgb, smoothstep(0.25, 0.75, broad));
    let ice = pow(smoothstep(0.48, 0.84, detail) * wisps, 2.2);
    pigment = mix(pigment, F.bhIce.rgb, ice * 0.66);
    let ember = pow(max(0.0, cos(angle + 2.4 + depth * 0.65)), 6.0) * smoothstep(0.38, 0.68, broad);
    pigment = mix(pigment, F.bhEmber.rgb, ember * 0.88) * mix(0.55, 1.5, wisps);
    bh_vortex += pigment * opacity * (1.0 - bh_cover);
    bh_cover += opacity * (1.0 - bh_cover);
  }
  bh_vortex /= max(0.0001, bh_cover);
  var bh_stars = vec3f(0.0);
  let bh_lens = 1.0 - smoothstep(0.55, 1.1, bh_r);
  let bh_bend = -bh_closest * min(1.45, 0.105 / (bh_r * bh_r + 0.025)) * bh_lens * (1.0 - bh_collapse * 0.94) * (1.0 + bh_gravity * 0.12);
  for (var s = 0; s < 28; s++) {
    let fs = f32(s);
    let hz = dice_hash(vec3f(fs * 7.0 + 1.0, value, 3.1)) * 2.0 - 1.0;
    let ha = dice_hash(vec3f(fs * 7.0 + 2.0, value, 5.3)) * 6.2831853;
    let hr = sqrt(max(0.0, 1.0 - hz * hz));
    let star = vec3f(cos(ha) * hr, hz, sin(ha) * hr) * (0.42 + dice_hash(vec3f(fs * 7.0 + 3.0, value, 7.7)) * 0.33);
    let size = 0.007 + dice_hash(vec3f(fs * 7.0 + 4.0, value, 9.9)) * 0.005;
    // Stars behind the hole bend more than those in front of it.
    let behind = smoothstep(-0.18, 0.22, dot(star, bh_ray));
    let off = star - (bh_p + bh_bend * behind);
    let along = dot(off, bh_ray);
    let dd = length(off - bh_ray * along);
    let w = max(size, fwidth(dd) * 0.55);
    let sharp = exp(-dd * dd / (w * w));
    let halo = exp(-dd * dd / (w * w * 12.0)) * 0.09;
    let glimmer = 0.88 + 0.12 * sin(bh_clock * 0.35 + fs * 2.7);
    let tint = mix(vec3f(0.48, 0.69, 1.0), vec3f(1.0, 0.83, 0.52), dice_hash(vec3f(fs, value, 1.0)));
    bh_stars += tint * (sharp * 1.8 + halo) * glimmer * step(0.0, along);
  }
  bh_stars *= pow(1.0 - bh_collapse, 1.35) * (1.0 - bh_horizon) * (1.0 - bh_cover * 0.8) * 0.24;
  var bh_body = mix(F.bhDeep.rgb, bh_vortex, clamp(0.25 + bh_cover * 1.5, 0.0, 1.0)) + bh_stars;
  bh_body = mix(bh_body, vec3f(0.00002), bh_horizon);
  bh_body = mix(bh_body, F.bhDeep.rgb * 0.055, bh_collapse * 0.92);
  // A glass shell: the light is inside it; the surface only reflects.
  p.base_color = vec3f(0.004, 0.006, 0.01);
  p.metallic = 0.0;
  p.roughness = mix(0.07, 0.3, bh_collapse);
  p.emissive += bh_body * F.bhGlow * (1.0 - m.coverage);`,
  description: 'Playground: a black hole in glass, after Aether’s. Animated.',
})

// --- pulsars and quasars ------------------------------------------------------------------------------

/**
 * One family, two phenomena (cosmicKind): a pulsar's magnetic loops and sweeping lighthouse beams,
 * or a quasar's turning disk and jets. A natural 20 flares and glows after; a natural 1 fractures.
 */
export const CosmicDice = defineDiceFamily('playground/CosmicDice', {
  // Beams sweep fast: 60, not a 165 Hz display's every frame.
  animated: { fps: 60 },
  fields: {
    cosmicKind: t.f32({ description: '0: pulsar, 1: quasar.' }),
    cosmicShadow: t.color({ default: hex('#02031a'), description: 'The dark between.' }),
    cosmicCore: t.color({ default: hex('#273fc8'), description: 'The body.' }),
    cosmicBeam: t.color({ default: hex('#2389ff'), description: 'Beams and jets.' }),
    cosmicAccent: t.color({ default: hex('#e7fbff'), description: 'Poles and the inner disk.' }),
    cosmicWin: t.color({ default: hex('#176bff'), description: 'Afterglow of a triumph.' }),
    cosmicWinLight: t.color({ default: hex('#e7fbff'), description: 'Its highlight.' }),
    cosmicLose: t.color({ default: hex('#7c174b'), description: 'A fumble’s fractures.' }),
    cosmicLoseLight: t.color({ default: hex('#ff6f82'), description: 'Their light.' }),
    cosmicSpeed: t.f32({ default: 1, description: 'How fast it all turns.' }),
    cosmicGlow: t.f32({ default: 7000, unit: 'cd/m²', description: 'Light of the body.' }),
    cosmicTriumph: t.f32({ description: 'The value that flares (0: none).' }),
    cosmicFumble: t.f32({ description: 'The value that fractures (0: none).' }),
  },
  surface: `
  let c_clock = globals.time;
  let c_seed = 0.37 + fract(value * 0.618);
  let c_point = local * 2.45 + vec3f(c_seed * 3.7, c_seed * 6.1, c_seed * 9.2);
  let c_broad = dice_noise(c_point * 0.74);
  let c_fine = dice_noise(c_point * 2.9 + vec3f(2.3, 5.1, 8.7));
  let c_landed = step(0.5, look.result);
  let c_since = max(0.0, globals.time - look.result_time) * c_landed;
  let c_win = c_landed * step(0.5, F.cosmicTriumph) * (1.0 - step(0.5, abs(value - F.cosmicTriumph)));
  let c_lose = c_landed * step(0.5, F.cosmicFumble) * (1.0 - step(0.5, abs(value - F.cosmicFumble)));
  let c_wave = sin(c_since * F.cosmicSpeed * 7.5 + c_broad * 6.0) * 0.5 + 0.5;
  let c_pulse = c_win * pow(c_wave, 8.0) * (1.0 - smoothstep(0.72, 1.62, c_since));
  let c_fail = c_lose * smoothstep(0.0, 0.76, c_since);
  let c_dir = normalize(local + vec3f(0.001));
  let c_spin = atan2(c_dir.z, c_dir.x);
  let c_t = c_clock * F.cosmicSpeed;
  var c_color = vec3f(0.0);
  var c_light = 0.0;
  var c_extra = vec3f(0.0);
  if (F.cosmicKind < 0.5) {
    let axis = normalize(vec3f(0.18, 0.96, 0.22));
    let lat = dot(c_dir, axis);
    let pole = pow(abs(lat), 18.0);
    let field = 1.0 - smoothstep(0.04, 0.24, abs(sin(c_spin * 2.2 + lat * 5.6 - c_t * 3.6)));
    let beam = pow(smoothstep(0.56, 0.98, abs(sin(c_spin * 1.2 - c_t * 4.8 + lat * 2.8))), 11.0);
    let neutron = smoothstep(0.34, 0.82, c_broad * 0.58 + c_fine * 0.42);
    let after = c_win * (0.88 + 0.12 * sin(c_clock * 2.8));
    c_color = mix(F.cosmicShadow.rgb, F.cosmicCore.rgb, 0.1 + neutron * 0.16);
    c_color = mix(c_color, F.cosmicBeam.rgb, field * 0.16 + beam * 0.22 + c_pulse * 0.68 + after * 0.72);
    c_color = mix(c_color, F.cosmicAccent.rgb, pole * 0.32 + beam * 0.12 + c_pulse * 0.9 + after * 0.3);
    c_light = 0.68 + neutron * 0.16 + field * 0.18 + beam * 0.28 + c_pulse * 0.92 + after * 0.72;
    c_extra = F.cosmicBeam.rgb * after * 0.5;
  } else {
    let axis = normalize(vec3f(0.24, 0.9, 0.34));
    let axial = dot(c_dir, axis);
    let equator = c_dir - axis * axial;
    let disk_r = length(equator);
    let thick = abs(axial);
    // Squares, not pow: WGSL leaves pow of a negative base undefined.
    let rib = (disk_r - 0.82) / 0.22;
    let ribbon = exp(-rib * rib) * (1.0 - smoothstep(0.08, 0.5, thick));
    let inr = (disk_r - 0.5) / 0.2;
    let inner = exp(-inr * inr) * (1.0 - smoothstep(0.05, 0.38, thick));
    let flow = 0.5 + 0.5 * sin(atan2(equator.z, equator.x) * 5.2 - c_t * 4.2 + c_fine * 3.0);
    let jet_axis = pow(abs(axial), 5.0);
    let jet = exp(-disk_r * 6.0) * smoothstep(0.25, 0.94, abs(axial));
    let corona = smoothstep(0.42, 0.92, c_broad) * (ribbon + inner * 0.8);
    let core = 1.0 - smoothstep(0.08, 0.5, disk_r);
    let after = c_win * smoothstep(0.02, 0.36, c_since) * (0.9 + 0.1 * sin(c_clock * 3.4));
    c_color = mix(F.cosmicShadow.rgb, F.cosmicCore.rgb, core * 0.14 + ribbon * 0.16 + flow * ribbon * 0.26 + inner * 0.24);
    c_color = mix(c_color, F.cosmicBeam.rgb, jet_axis * 0.24 + jet * 0.36 + c_pulse * 0.7);
    c_color = mix(c_color, F.cosmicAccent.rgb, inner * 0.28 + corona * 0.26 + c_pulse * 0.62);
    c_color = mix(c_color, F.cosmicWin.rgb, after * (0.16 + ribbon * 0.58 + corona * 0.26));
    c_color = mix(c_color, F.cosmicWinLight.rgb, after * (inner * 0.28 + core * 0.06 + jet * 0.1));
    c_light = 0.64 + core * 0.12 + ribbon * 0.32 + inner * 0.28 + jet * 0.34 + c_pulse * 0.92 + after * 0.28;
    c_extra = F.cosmicWin.rgb * after * (ribbon * 0.46 + corona * 0.2 + 0.07) + F.cosmicWinLight.rgb * after * (inner * 0.24 + core * 0.05);
  }
  var c_out = c_color * c_light + c_extra;
  let fracture = dice_noise(c_point * 3.3 + vec3f(c_since * 2.1));
  let crack = pow(sin(c_since * 9.2 + c_broad * 5.7) * 0.5 + 0.5, 8.0);
  let broken = mix(F.cosmicLose.rgb, F.cosmicLoseLight.rgb, 0.22 + fracture * 0.54 + crack * 0.24);
  c_out = mix(c_out, broken * (0.58 + fracture * 0.5 + crack * 0.8), c_fail * 0.94);
  c_out += F.cosmicLoseLight.rgb * (crack * 0.56 + c_fail * 0.08) * c_lose;
  p.base_color = c_color * 0.06;
  p.metallic = 0.0;
  p.roughness = 0.14;
  p.emissive += c_out * F.cosmicGlow * (1.0 - m.coverage);`,
  description: 'Playground: pulsars and quasars, after Aether’s. Animated.',
})

// --- the accretion disk ---------------------------------------------------------------------------------

/**
 * Aether's accretion disk: no ring mesh, a window facing the camera through which each pixel's ray
 * is integrated past the hole (128 steps, bent by a 1/r³ pull), crossing a tilted disk that turns.
 * Two windows: one behind the die's middle (the die hides what's behind it) and one in front of it,
 * each drawing the disk crossings on its side, so the near band passes over the die.
 */
export const AccretionDisk = defineMaterial('playground/AccretionDisk', {
  extends: 'none',
  blend: 'additive',
  fields: {
    warm: t.color({ default: hex('#ff8a28'), description: 'The outer, cooler light.' }),
    hot: t.color({ default: hex('#fff0d0'), description: 'The inner, hotter light.' }),
    glow: t.f32({ default: 5200, unit: 'cd/m²', description: 'Light of the disk.' }),
    start: t.f32({ unit: 's', description: 'The shader clock when it opened.' }),
    front: t.f32({ description: '1: crossings in front of the hole; 0: behind it.' }),
  },
  shader: 'playground::accretion',
  description: 'Playground: a ray-traced accretion disk window, after Aether’s.',
})

/** Die radii from the die's center to the window's rim. */
const DISK_RADIUS = 2.8
/** The disk's tilt on screen, radians (Aether's 0.18). */
const DISK_TILT = 0.18

export const ACCRETION_SHADER = {
  path: 'playground::accretion',
  source: `
import shard::pbr::types::VertexOutput;
import shard::globals::globals;
import ${AccretionDisk.modulePath}::${AccretionDisk.varName};

const INCLINATION: f32 = 0.18;

fn disk_hash(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn disk_noise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(disk_hash(i), disk_hash(i + vec3f(1.0, 0.0, 0.0)), u.x),
        mix(disk_hash(i + vec3f(0.0, 1.0, 0.0)), disk_hash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(disk_hash(i + vec3f(0.0, 0.0, 1.0)), disk_hash(i + vec3f(1.0, 0.0, 1.0)), u.x),
        mix(disk_hash(i + vec3f(0.0, 1.0, 1.0)), disk_hash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}

/** The disk's light where a ray crosses its plane: one plane, one clock, every lensed image. */
fn disk_emission(point: vec3f, clock: f32, warm: vec3f, hot: vec3f) -> vec4f {
  let coord = vec2f(point.x, dot(point, vec3f(0.0, -sin(INCLINATION), cos(INCLINATION))));
  let radius = length(coord);
  let angle = atan2(coord.y, coord.x);
  let r = clamp((radius - 1.35) / 1.95, 0.0, 1.0);
  var edge = smoothstep(1.35, 1.48, radius) * (1.0 - smoothstep(2.6, 3.3, radius));
  let ribbon = (radius - 1.75) / 0.34;
  edge *= 0.08 + 0.92 * exp(-ribbon * ribbon);
  let orbit = angle - clock * 0.48;
  let outer = angle - clock * 0.24;
  let fast = disk_noise(vec3f(cos(orbit) * 3.0, sin(orbit) * 3.0, radius * 13.0));
  let slow = disk_noise(vec3f(cos(outer) * 3.0, sin(outer) * 3.0, radius * 13.0));
  let broad = mix(fast, slow, smoothstep(0.15, 0.85, r));
  let detail = disk_noise(vec3f(cos(orbit) * 8.0, sin(orbit) * 8.0, radius * 19.0 + broad * 1.8));
  let density = 0.28 + 0.72 * smoothstep(0.18, 0.82, broad * 0.7 + detail * 0.3);
  let heat = pow(1.0 - r, 0.65);
  let color = mix(warm, hot, pow(heat, 3.0) * 0.8) * (1.0 + density * 1.5);
  return vec4f(color, edge * (0.5 + density * 0.35));
}

fn disk_pull(p: vec3f, l2: f32) -> vec3f {
  let r2 = max(dot(p, p), 0.04);
  return p * (-0.645 * l2 / (r2 * r2 * sqrt(r2)));
}

override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  // The window lies in its x–z plane, turned to face the camera: x right, −z up, in die radii.
  return vec4f(position.x * ${DISK_RADIUS.toFixed(1)}, -position.z * ${DISK_RADIUS.toFixed(1)}, 0.0, 0.0);
}

override fn shade(in: VertexOutput) -> vec4f {
  let D = ${AccretionDisk.varName};
  let clock = globals.time - D.start;
  let reveal = smoothstep(0.0, 1.0, clamp(clock / 0.45, 0.0, 1.0));
  let disk_point = in.extra.xy;
  // Keep the near band below the numbers; pull the lower image toward the die's silhouette.
  let lower = smoothstep(0.38, 0.9, -disk_point.y);
  let framed = disk_point + vec2f(0.0, 0.14 - 0.18 * lower);
  var p = vec3f(framed * 1.64, 8.0);
  var velocity = vec3f(0.0, 0.0, -1.0);
  let l2 = dot(p.xy, p.xy);
  let plane_n = vec3f(0.0, cos(INCLINATION), sin(INCLINATION));
  var near = vec3f(0.0);
  var far = vec3f(0.0);
  var remaining = 1.0;
  for (var i = 0; i < 128; i++) {
    let radius = length(p);
    if (radius < 0.435 || (radius > 9.0 && dot(p, velocity) > 0.0)) { break; }
    let h = clamp(radius * 0.085, 0.018, 0.5);
    let half_v = velocity + disk_pull(p, l2) * h * 0.5;
    let next = p + half_v * h;
    velocity = half_v + disk_pull(next, l2) * h * 0.5;
    let side = dot(p, plane_n);
    let next_side = dot(next, plane_n);
    if (side * next_side < 0.0) {
      let crossing = mix(p, next, side / (side - next_side));
      let s = disk_emission(crossing, clock, D.warm.rgb, D.hot.rgb);
      let light = remaining * s.rgb * s.a;
      if (crossing.z >= 0.0) { near += light; } else { far += light; }
      remaining *= 1.0 - s.a;
    }
    p = next;
    if (remaining < 0.02) { break; }
  }
  // The window's rim, and Aether's art-directed beaming: brighter where the disk comes toward us.
  let boundary = 1.0 - smoothstep(2.6, 2.8, length(disk_point));
  let approaching = 1.0 - smoothstep(-1.35, 1.25, disk_point.x);
  let beaming = mix(0.12, 2.1, pow(approaching, 1.2));
  let light = select(far, near, D.front > 0.5) * beaming;
  return vec4f(light * D.glow, boundary * reveal);
}`,
}

// --- windows facing the camera -----------------------------------------------------------------------

/** One window mesh per world: a quad in its x–z plane, ±1 across. */
const windows = new WeakMap<World, AssetRef<'Mesh'>>()

function windowMesh(w: World): AssetRef<'Mesh'> {
  let mesh = windows.get(w)
  if (!mesh) {
    mesh = w.resource(Meshes).add(plane({ size: 2 })) as AssetRef<'Mesh'>
    windows.set(w, mesh)
  }
  return mesh
}

/** Materials a world's windows share, by name: they differ only by when they opened and colors. */
const shared = new WeakMap<World, Map<string, AssetRef<'Material'>>>()

function sharedMaterial(
  w: World,
  name: string,
  make: () => MaterialAsset,
  set: Record<string, unknown>,
): AssetRef<'Material'> {
  let byName = shared.get(w)
  if (!byName) {
    byName = new Map()
    shared.set(w, byName)
  }
  let ref = byName.get(name)
  if (!ref) {
    ref = w.resource(Materials).add(make()) as AssetRef<'Material'>
    byName.set(name, ref)
  }
  w.resource(Materials).get(ref)?.set(set)
  return ref
}

interface WindowPlacement {
  /** Center, in die radii from the die's center: x right, y up on screen. */
  x: number
  y: number
  /** Size in die radii. */
  width: number
  height: number
  /** Turn on screen, radians counter-clockwise. */
  turn: number
  /** How far toward the camera past the die's center, in die radii (0: at its depth). */
  lift: number
}

/**
 * Spawns a window facing the dice camera over a landed die. A window lifted toward the camera is
 * moved along the line from the camera and scaled by how much nearer it got, so it covers the
 * pixels it would at the die's depth: windows at different depths line up wherever the die is.
 */
function spawnWindow(
  ctx: DiceAttachmentContext,
  material: AssetRef<'Material'>,
  at: WindowPlacement,
): Entity {
  const w = ctx.world
  const camera = w.resource(DiceTable).camera
  const { rotation: cam, translation: eye } = w.get(camera, Transform)
  const [qx, qy, qz, qw] = cam
  // The camera's right and up, in the world.
  const right = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)]
  const up = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)]
  const die = w.get(ctx.die, Transform).translation
  const s = ctx.scale
  const px = die[0]! + (right[0]! * at.x + up[0]! * at.y) * s - eye[0]!
  const py = die[1]! + (right[1]! * at.x + up[1]! * at.y) * s - eye[1]!
  const pz = die[2]! + (right[2]! * at.x + up[2]! * at.y) * s - eye[2]!
  const dx = die[0]! - eye[0]!
  const dy = die[1]! - eye[1]!
  const dz = die[2]! - eye[2]!
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const f = Math.max(0.05, (d - at.lift * s) / d)
  // The window's +y to the camera's +z (its −z reads up on screen), turned on screen.
  const face = quat.multiply(
    [0, 0, 0, 1],
    cam,
    quat.multiply(
      [0, 0, 0, 1],
      quat.fromEuler([0, 0, 0, 1], 0, 0, at.turn),
      quat.fromEuler([0, 0, 0, 1], Math.PI / 2, 0, 0),
    ),
  ) as [number, number, number, number]
  return w.spawn(
    [Mesh3d, { mesh: windowMesh(w) }],
    [MeshMaterial, { material }],
    NotShadowCaster,
    NotShadowReceiver,
    [
      Transform,
      {
        translation: [eye[0]! + px * f, eye[1]! + py * f, eye[2]! + pz * f],
        rotation: face,
        scale: [(at.width / 2) * s * f, 1, (at.height / 2) * s * f],
      },
    ],
  )
}

/** A field of the die's own material (the skin's), for effects that take its colors. */
function dieField(ctx: DiceAttachmentContext, field: string): unknown {
  const ref = ctx.world.get(ctx.die, MeshMaterial).material
  return ref ? ctx.world.resource(Materials).get(ref)?.value[field] : undefined
}

// --- the accretion disk (black hole) --------------------------------------------------------------------

/**
 * The `accretion-disk` attachment: on a landed die, the two windows (behind its middle and in front
 * of it), and a lens field that pulls the table in while it's open.
 */
export function defineAccretionAttachment(): void {
  defineDiceAttachment('accretion-disk', {
    vertices: 8,
    spawn(ctx) {
      // Opens now: both windows turn from this moment on the shader clock.
      const start = ctx.world.resource(Time).elapsed
      const size = DISK_RADIUS * 2
      const window = { x: 0, y: 0, width: size, height: size, turn: DISK_TILT }
      const back = sharedMaterial(
        ctx.world,
        'disk-back',
        () => new MaterialAsset({ front: 0 }, AccretionDisk),
        { start },
      )
      const front = sharedMaterial(
        ctx.world,
        'disk-front',
        () => new MaterialAsset({ front: 1 }, AccretionDisk),
        { start },
      )
      // Past the die's top toward the camera: the near band draws over the die.
      return [
        spawnWindow(ctx, back, { ...window, lift: 0 }),
        spawnWindow(ctx, front, { ...window, lift: 1.05 }),
      ]
    },
    update(ctx, s) {
      // The table under the hole bends in as the disk opens, and breathes while it's open.
      const ramp = Math.min(1, s / 0.6)
      ctx.lens({ radius: 190 + 14 * Math.sin(s * 1.7), strength: -0.8 * ramp, ttlMs: 200 })
      return true
    },
  })
}

// --- the pulsar's beam and the quasar's disk and jet (after Aether's cosmic-result scenes) ---------------

const RESULT_FIELDS = {
  color: t.color({ default: hex('#176bff'), description: 'The body of the light.' }),
  hot: t.color({ default: hex('#e7fbff'), description: 'Its hottest core.' }),
  glow: t.f32({ default: 6000, unit: 'cd/m²', description: 'Light at full strength.' }),
  start: t.f32({ unit: 's', description: 'The shader clock when it appeared.' }),
}

/** A lighthouse beam through the die, flickering, ragged at its ends. */
export const PulsarBeam = defineMaterial('playground/PulsarBeam', {
  extends: 'none',
  blend: 'additive',
  fields: RESULT_FIELDS,
  shader: 'playground::pulsar_beam',
  description: "Playground: a pulsar's lighthouse beam, after Aether's.",
})

/** A quasar's turbulent accretion disk: `near` 1 draws only the band passing in front of the die. */
export const QuasarDisk = defineMaterial('playground/QuasarDisk', {
  extends: 'none',
  blend: 'additive',
  fields: {
    ...RESULT_FIELDS,
    near: t.f32({ description: '1: the near-side band only; 0: the whole disk behind the die.' }),
  },
  shader: 'playground::quasar_disk',
  description: "Playground: a quasar's accretion disk, after Aether's.",
})

/** A one-sided relativistic jet: knots and packets racing out from the die. */
export const QuasarJet = defineMaterial('playground/QuasarJet', {
  extends: 'none',
  blend: 'additive',
  fields: RESULT_FIELDS,
  shader: 'playground::quasar_jet',
  description: "Playground: a quasar's jet, after Aether's.",
})

/** What the result windows' shaders share: the window's coordinates, easing, noise. */
const RESULT_LIBRARY = `
override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  // Across the window, −1..1: x right, y up on screen.
  return vec4f(position.x, -position.z, 0.0, 0.0);
}

fn ease01(x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn gauss(x: f32) -> f32 {
  return exp(-x * x);
}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), f.x),
             mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), f.x), f.y);
}
`

const header = (type: { modulePath: string; varName: string }) => `
import shard::pbr::types::VertexOutput;
import shard::globals::globals;
import ${type.modulePath}::${type.varName};
${RESULT_LIBRARY}`

export const RESULT_SHADERS: { path: string; source: string }[] = [
  {
    path: 'playground::pulsar_beam',
    source: `${header(PulsarBeam)}
fn beam_fbm(q: vec2f) -> f32 {
  var p = q;
  var v = 0.0;
  var w = 0.55;
  for (var o = 0; o < 4; o++) {
    v += noise2(p) * w;
    p = p * 2.03 + vec2f(5.2, 1.7);
    w *= 0.48;
  }
  return v;
}

override fn shade(in: VertexOutput) -> vec4f {
  let B = ${PulsarBeam.varName};
  let clock = max(0.0, globals.time - B.start);
  let reveal = ease01(clock / 0.38);
  let fade = max(0.78, ease01((clock - 0.42) / 0.8));
  // It grows in, and trembles.
  let grow = 0.66 + reveal * 0.36;
  let wob = sin(clock * 34.0) * 0.024;
  let q = vec2f(cos(wob) * in.extra.x + sin(wob) * in.extra.y, -sin(wob) * in.extra.x + cos(wob) * in.extra.y) / grow;
  let p = q * 0.5 * vec2f(1.34, 3.7);
  let ay = abs(p.y);
  let side = sign(p.y + 0.0001);
  let reach = clamp(ay / 1.78, 0.0, 1.0);
  let fast = clock * 10.0;
  let broad = beam_fbm(vec2f(ay * 1.65, fast * 0.22 + side * 8.0));
  let detail = beam_fbm(vec2f(ay * 8.4 - fast * 1.8, fast * 1.37 + side * 19.0));
  var center = (sin(fast * 1.3 + ay * 1.6 + side * 0.8) * 0.075 + sin(fast * 2.5 + ay * 3.2) * 0.026 + (broad - 0.5) * 0.11) * smoothstep(0.03, 1.62, ay);
  center += sin(fast * 1.1 + side * 1.4) * 0.055 * reach;
  let breathing = 0.88 + broad * 0.32 + sin(fast * 1.4 + ay * 6.0) * 0.06;
  var width = (0.016 + reach * 0.026 + reach * reach * reach * 0.14) * breathing;
  width *= mix(0.86, 1.16, smoothstep(0.36, 0.78, detail));
  let dist = abs(p.x - center);
  let hot = gauss(dist / max(0.004, width * 0.2));
  var body = gauss(dist / max(0.008, width));
  var halo = gauss(dist / max(0.016, width * 3.1));
  body *= 0.9 + 0.18 * beam_fbm(vec2f(ay * 13.0 - fast * 2.4, p.x * 17.0 + fast));
  halo *= 0.8 + 0.4 * detail;
  let wisp_center = center + sin(fast * 0.9 + ay * 5.2 + side) * width * 1.6;
  let wisp = gauss(abs(p.x - wisp_center) / max(0.012, width * 1.9)) * smoothstep(0.18, 1.58, ay);
  let flare = smoothstep(0.62, 1.72, ay) * (0.5 + detail * 0.9);
  let tip = beam_fbm(vec2f(p.x * 5.4 + fast * 0.9, fast * 1.2 + side * 13.0));
  let mask = 1.0 - smoothstep(1.44 + tip * 0.2, 1.84, ay);
  let star = exp(-(1.3 * p.x * p.x + p.y * p.y) * 32.0);
  let flicker = 0.84 + 0.12 * sin(fast * 4.2 + ay * 9.0) + 0.08 * sin(fast * 10.7 + ay * 23.0);
  var light = B.color.rgb * (halo * 0.9 + body * (1.25 + flare * 0.55) + wisp * 0.38);
  light += B.hot.rgb * (hot * 2.35 + star * 2.8);
  light *= flicker * mask * reveal;
  let alpha = clamp((halo * 0.28 + body * 0.76 + wisp * 0.18 + hot + star) * mask * reveal * fade, 0.0, 1.0);
  return vec4f(light * B.glow, alpha);
}`,
  },
  {
    path: 'playground::quasar_disk',
    source: `${header(QuasarDisk)}
fn disk_fbm(q: vec2f) -> f32 {
  var p = q;
  var v = 0.0;
  var w = 0.56;
  for (var o = 0; o < 5; o++) {
    v += noise2(p) * w;
    p = p * 2.07 + vec2f(4.3, 7.1);
    w *= 0.47;
  }
  return v;
}

override fn shade(in: VertexOutput) -> vec4f {
  let Q = ${QuasarDisk.varName};
  let clock = max(0.0, globals.time - Q.start);
  let ignition = ease01(clock / 0.52);
  let ambient = max(0.82, ease01((clock - 0.38) / 0.88));
  let c = cos(-0.04);
  let s = sin(-0.04);
  let q = in.extra.xy * 0.5 * vec2f(6.8, 4.2);
  let p = vec2f(c * q.x + s * q.y, -s * q.x + c * q.y);
  let e = vec2f(p.x, p.y * 2.55);
  let r = length(e);
  let a = atan2(e.y, e.x);
  // The band passing in front of the die: its lower half, off the core.
  let near_side = (1.0 - smoothstep(-0.08, 0.34, p.y)) * smoothstep(0.26, 0.52, r) * (1.0 - smoothstep(2.42, 3.06, r));
  if (Q.near > 0.5 && near_side < 0.002) { return vec4f(0.0); }
  let winding = a - log(r + 0.24) * 2.65 - clock * 0.82;
  let flow = vec2f(cos(winding), sin(winding)) * r * 1.85;
  let broad = disk_fbm(flow * 0.62 + vec2f(-clock * 0.11, clock * 0.07));
  let warped = disk_fbm(flow * 1.31 + vec2f(clock * 0.18, -clock * 0.13) + broad * 2.1);
  let fine = disk_fbm(vec2f(winding * 1.42 + warped * 1.8, r * 3.8 - clock * 1.12));
  let filaments = smoothstep(0.47, 0.8, broad * 0.48 + warped * 0.34 + fine * 0.18);
  let veins = smoothstep(0.66, 0.9, fine + warped * 0.16);
  let inner_ring = gauss((r - 0.46) / 0.18);
  let hot_disk = gauss((r - 0.76) / 0.43);
  let outer_disk = gauss((r - 1.38) / 0.82);
  let cloud = (1.0 - smoothstep(0.84, 2.8, r)) * smoothstep(0.22, 1.15, r) * (0.24 + broad * 0.76);
  let tail_width = 0.3 + clamp(-p.x, 0.0, 3.2) * 0.19;
  let tail_axis = p.y + (broad - 0.5) * 0.42 + sin(p.x * 0.72 + clock * 0.26) * 0.08;
  let tail = gauss(tail_axis / max(0.16, tail_width)) * smoothstep(0.12, 2.72, -p.x) * (1.0 - smoothstep(2.34, 3.18, -p.x)) * (0.18 + broad * 0.62 + warped * 0.34);
  let streamers = (1.0 - smoothstep(0.38, 1.62, abs(p.y))) * smoothstep(0.78, 3.05, abs(p.x)) * (0.12 + 0.66 * filaments + 0.32 * veins);
  let core = exp(-r * r * 7.8);
  let layer = mix(1.0, near_side, Q.near);
  let density = inner_ring * 1.54 + hot_disk * (0.5 + filaments * 1.34 + veins * 0.34) + outer_disk * (0.08 + filaments * 0.88) + cloud * 0.58 + tail * 1.12 + streamers * 0.38;
  let flicker = 0.91 + 0.08 * sin(clock * 9.6 + r * 8.0) + 0.05 * sin(clock * 18.7 + a * 4.0);
  let ember = Q.color.rgb * vec3f(0.34, 0.12, 0.045);
  var light = mix(ember, Q.color.rgb, clamp(hot_disk * 0.54 + filaments * 0.52 + veins * 0.18 + tail * 0.24, 0.0, 1.0));
  light = mix(light, Q.hot.rgb, clamp(inner_ring * 0.78 + core + hot_disk * veins * 0.3, 0.0, 1.0));
  light *= density * flicker * (0.92 + ignition * 0.68) * layer;
  light += Q.color.rgb * (cloud * 0.22 + tail * 0.4 + streamers * 0.14) * layer;
  light += Q.hot.rgb * core * 3.2 * (1.0 - Q.near);
  let edge = (1.0 - smoothstep(2.18, 3.34, abs(p.x))) * (1.0 - smoothstep(1.18, 2.06, abs(p.y)));
  let alpha = clamp((density * 0.9 + cloud * 0.2 + tail * 0.24 + core * (1.0 - Q.near)) * edge * layer * ignition * ambient * mix(1.0, 0.72, Q.near), 0.0, 1.0);
  return vec4f(light * Q.glow, alpha);
}`,
  },
  {
    path: 'playground::quasar_jet',
    source: `${header(QuasarJet)}
override fn shade(in: VertexOutput) -> vec4f {
  let J = ${QuasarJet.varName};
  let clock = max(0.0, globals.time - J.start);
  let reveal = ease01((clock - 0.16) / 0.64);
  let opacity = max(0.82, ease01((clock - 0.38) / 0.88)) * (0.88 + sin(clock * 12.4) * 0.06);
  // From the die (the window's bottom) out to the tip.
  let uv = in.extra.xy * 0.5 + 0.5;
  let p = (uv - vec2f(0.5, 0.0)) * vec2f(1.16, 5.4);
  let along = clamp(uv.y, 0.0, 1.0);
  let grain = hash2(floor(vec2f(along * 96.0 - clock * 38.0, p.x * 42.0)));
  let width = 0.022 + along * 0.025;
  let d = abs(p.x);
  let spine = gauss(d / max(0.004, width * 0.34));
  let body = gauss(d / max(0.008, width));
  let sheath = gauss(d / max(0.02, width * 5.4));
  let knots = pow(0.5 + 0.5 * sin(along * 82.0 - clock * 34.0), 12.0);
  let packet = pow(0.5 + 0.5 * sin(along * 31.0 - clock * 19.6 + grain * 2.4), 7.0);
  let mask = 1.0 - smoothstep(reveal, reveal + 0.09, along);
  let root = smoothstep(-0.01, 0.035, along);
  let taper = 1.0 - smoothstep(0.9, 1.02, along);
  let flicker = 0.86 + 0.14 * sin(clock * 16.8 + along * 27.0);
  var light = J.color.rgb * (sheath * 0.58 + body * 0.62 * packet);
  light += J.hot.rgb * (spine * (2.3 + knots * 1.45) + body * 0.78);
  light *= flicker * root * taper * mask * opacity;
  let alpha = clamp((sheath * 0.28 + body * 0.76 + spine) * root * taper * mask * opacity, 0.0, 1.0);
  return vec4f(light * J.glow, alpha);
}`,
  },
]

/** The skin's triumph colors off the die's material (a CosmicDice's cosmicWin and its light). */
function triumphColors(ctx: DiceAttachmentContext): Record<string, unknown> {
  const out: Record<string, unknown> = { start: ctx.world.resource(Time).elapsed }
  const color = dieField(ctx, 'cosmicWin')
  const hot = dieField(ctx, 'cosmicWinLight')
  if (color) out.color = color
  if (hot) out.hot = hot
  return out
}

/**
 * `pulsar-beam`: the lighthouse beam through a landed die, at its depth, so the die hides the part
 * behind it and the beam seems to leave it. It stays while the die rests; with no update of its own,
 * it animates on the family's frames (60 a second), not the display's every frame.
 */
export function definePulsarAttachment(): void {
  defineDiceAttachment('pulsar-beam', {
    vertices: 4,
    spawn(ctx) {
      const beam = sharedMaterial(
        ctx.world,
        'pulsar-beam',
        () => new MaterialAsset({}, PulsarBeam),
        triumphColors(ctx),
      )
      return [spawnWindow(ctx, beam, { x: 0, y: 0, width: 2.8, height: 7, turn: 0, lift: 0 })]
    },
  })
}

/**
 * `quasar-jet`: the turbulent disk behind the die, its near band passing in front, and a one-sided
 * jet racing out from it. It stays while the die rests, on the family's frames.
 */
export function defineQuasarAttachment(): void {
  defineDiceAttachment('quasar-jet', {
    vertices: 12,
    spawn(ctx) {
      const colors = triumphColors(ctx)
      const disk = (near: number) => () => new MaterialAsset({ near }, QuasarDisk)
      const far = sharedMaterial(ctx.world, 'quasar-far', disk(0), colors)
      const near = sharedMaterial(ctx.world, 'quasar-near', disk(1), colors)
      const jet = sharedMaterial(
        ctx.world,
        'quasar-jet',
        () => new MaterialAsset({ glow: 7000 }, QuasarJet),
        colors,
      )
      const window = { x: 0, y: 0, width: 7.2, height: 4.2, turn: -0.14 }
      // Aether's jet leans −0.27 rad from the die: its window's center sits 3.15 up that way.
      const lean = -0.27
      return [
        spawnWindow(ctx, far, { ...window, lift: 0 }),
        spawnWindow(ctx, near, { ...window, lift: 1.05 }),
        spawnWindow(ctx, jet, {
          x: -3.15 * Math.sin(lean),
          y: 3.15 * Math.cos(lean),
          width: 1.55,
          height: 6.3,
          turn: lean,
          lift: 1.08,
        }),
      ]
    },
  })
}
