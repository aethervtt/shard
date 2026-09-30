import { type Fields, ShardError, t } from '@aethervtt/shard-core'
import {
  type BlendMode,
  defineMaterial,
  findMaterialType,
  type MaterialType,
  materialModulePath,
} from '@aethervtt/shard-render'
import { MARK_RANGE } from './cells'

// The `dice` material (0054): the standard material plus a mark atlas and the fields every dice
// family shares. A family is a material type with those fields required; its shader shades the
// body, and the shared library adds marks, the chamfer, the dropped look and the fade.

/** Fields every dice family has, before its own. */
export const DICE_FIELDS = {
  marks: t.handle('Texture', { description: 'The mark atlas (MSDF), baked by the package.' }),
  markColor: t.color({ default: [0.95, 0.94, 0.9, 1], description: 'Mark ink (linear).' }),
  markEmissive: t.f32({
    min: 0,
    unit: 'cd/m²',
    description: 'Glowing marks: luminance of the ink.',
  }),
  markRoughness: t.f32({ default: 0.55, min: 0, max: 1, description: 'Roughness of the ink.' }),
  markMetallic: t.f32({ min: 0, max: 1, description: 'Metallic ink (gilded marks).' }),
  markDepth: t.f32({
    default: 0.6,
    min: 0,
    max: 1,
    description:
      'How deep the marks are engraved: a bump taken from the distance field. 0 prints them.',
  }),
  edgeColor: t.color({
    default: [0.5, 0.5, 0.5, 1],
    description: 'Color the chamfer blends toward.',
  }),
  edgeMix: t.f32({
    default: 0.3,
    min: 0,
    max: 1,
    description: 'How much of edgeColor the chamfer takes.',
  }),
  droppedColor: t.color({
    default: [0.34, 0.38, 0.43, 1],
    description: "The dropped look's tone: dropped dice fade toward it.",
  }),
  dropped: t.f32({
    min: 0,
    max: 1,
    description:
      'Blend toward the dropped look: desaturated, 0.62 opacity, rougher, no transmission.',
  }),
  fade: t.f32({ default: 1, min: 0, max: 1, description: 'Opacity for blended dice fading in.' }),
  result: t.f32({
    min: 0,
    max: 1,
    description: '0 while tumbling, 1 once landed: result-reactive families light the face on top.',
  }),
  resultTime: t.f32({
    unit: 's',
    description:
      'The shader clock (globals.time) when the dice landed: reactions animate from globals.time − resultTime once result is above 0.',
  }),
}

const DICE_FIELD_NAMES = Object.keys(DICE_FIELDS)

/** The shared WGSL: marks from the atlas, the engraving, the chamfer, dropped and fade. */
export const DICE_SHADERS: Record<string, string> = {
  'shard::dice::surface': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::material;
import shard::mesh::vertex_instance_data;
import shard::view::view;

/** The atlas's distance range, in atlas pixels (the bake's MARK_RANGE). */
const DICE_MARK_RANGE: f32 = ${MARK_RANGE.toFixed(1)};

/** What every family's dice fields say, gathered by its shader. */
struct DiceLook {
  mark_color: vec4f,
  edge_color: vec4f,
  dropped_color: vec4f,
  mark_emissive: f32,
  mark_roughness: f32,
  mark_metallic: f32,
  mark_depth: f32,
  edge_mix: f32,
  dropped: f32,
  fade: f32,
  result: f32,
  /** globals.time when the dice landed (see result). */
  result_time: f32,
}

/** The mark at a fragment. */
struct DiceMark {
  /** 1 on faces, 0 on the chamfer. */
  face: f32,
  /** Ink coverage, antialiased in screen space. */
  coverage: f32,
  /** Signed distance to the mark's outline in atlas pixels, positive inside. */
  inside: f32,
  /** The distance's change per atlas pixel along u and v. */
  slope: vec2f,
  /** How squarely this face points up: 1 on the face on top. */
  top: f32,
}

/** For vertex_extra: the object-space position (for body patterns that stick to the die), and the die's value. */
fn dice_extra(position: vec3f) -> vec4f {
  return vec4f(position, vertex_instance_data().x);
}

fn dice_median(c: vec3f) -> f32 {
  return max(min(c.r, c.g), min(max(c.r, c.g), c.b));
}

/** Samples the mark atlas. Call it first in pbr_input: it takes derivatives. */
fn dice_mark(in: VertexOutput, atlas: texture_2d<f32>, samp: sampler) -> DiceMark {
  let size = vec2f(textureDimensions(atlas));
  let texel = 1.0 / size;
  let fw = fwidth(in.uv * size);
  let c = textureSample(atlas, samp, in.uv).rgb;
  let cx = textureSample(atlas, samp, in.uv + vec2f(texel.x, 0.0)).rgb;
  let cy = textureSample(atlas, samp, in.uv + vec2f(0.0, texel.y)).rgb;
  let d = (dice_median(c) - 0.5) * DICE_MARK_RANGE;
  var m: DiceMark;
  m.face = step(0.5, in.uv1.x);
  let per_pixel = max(0.5 * (fw.x + fw.y), 1e-3);
  m.coverage = clamp(d / per_pixel + 0.5, 0.0, 1.0) * m.face;
  m.inside = d;
  m.slope = vec2f((dice_median(cx) - 0.5) * DICE_MARK_RANGE - d, (dice_median(cy) - 0.5) * DICE_MARK_RANGE - d);
  m.top = smoothstep(0.9, 0.995, normalize(in.world_normal).y) * m.face;
  return m;
}

/** The surface from the standard fields: baseColor, metallic, roughness, emissive. */
fn dice_base(in: VertexOutput) -> PbrInput {
  var p: PbrInput;
  p.base_color = material.baseColor.rgb;
  p.alpha = material.baseColor.a;
  p.normal = normalize(in.world_normal);
  p.metallic = material.metallic;
  p.roughness = clamp(material.roughness, 0.045, 1.0);
  p.emissive = material.emissive.rgb * material.emissiveLuminance;
  p.occlusion = 1.0;
  return p;
}

/** From the surface toward the camera. */
fn dice_view(in: VertexOutput) -> vec3f {
  return normalize(view.cameraPosition - in.world_position);
}

/**
 * The ray from the camera through this fragment in the die's own space (unit length), for what's
 * seen inside a die: a vortex, a star field at depth. It's recovered from how the world and object
 * positions change across the pixel (one rigid map for the whole die), so call it where
 * derivatives are valid: in the surface's top level, not under a branch.
 */
fn dice_local_ray(in: VertexOutput, local: vec3f) -> vec3f {
  let wx = dpdx(in.world_position);
  let wy = dpdy(in.world_position);
  let lx = dpdx(local);
  let ly = dpdy(local);
  let wn = cross(wx, wy);
  let ln = cross(lx, ly);
  let d = normalize(in.world_position - view.cameraPosition);
  let det = max(dot(wn, wn), 1e-30);
  // d = a·wx + b·wy + c·wn, and the die's space maps wx, wy, wn to s·lx, s·ly, s²·ln.
  let a = dot(cross(wy, wn), d) / det;
  let b = dot(cross(wn, wx), d) / det;
  let c = dot(wn, d) / det;
  let s = sqrt(length(wn) / max(length(ln), 1e-30));
  let r = a * lx + b * ly + c * s * ln;
  return r / max(length(r), 1e-20);
}

fn dice_hash(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/** Smooth value noise in 0..1, for body patterns in object space. */
fn dice_noise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dice_hash(i), dice_hash(i + vec3f(1.0, 0.0, 0.0)), u.x),
        mix(dice_hash(i + vec3f(0.0, 1.0, 0.0)), dice_hash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(dice_hash(i + vec3f(0.0, 0.0, 1.0)), dice_hash(i + vec3f(1.0, 0.0, 1.0)), u.x),
        mix(dice_hash(i + vec3f(0.0, 1.0, 1.0)), dice_hash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}

/** Two octaves of dice_noise. */
fn dice_fbm(p: vec3f) -> f32 {
  return dice_noise(p) * 0.65 + dice_noise(p * 2.13 + vec3f(5.2, 1.3, 7.1)) * 0.35;
}

fn dice_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

/**
 * Finishes a family's body: the chamfer toward edge_color, the marks (ink, engraving, glow), the
 * dropped look, and the fade. Families shade the body into p, then call this.
 */
fn dice_finish(p: ptr<function, PbrInput>, m: DiceMark, look: DiceLook, in: VertexOutput) {
  let n = normalize(in.world_normal);
  let chamfer = 1.0 - m.face;
  (*p).base_color = mix((*p).base_color, look.edge_color.rgb, look.edge_mix * chamfer);

  // Engraving: the rim of each mark slopes into it, and the recess is a little shadowed.
  let t = in.world_tangent.xyz;
  if (look.mark_depth > 0.0 && m.face > 0.5 && dot(t, t) > 1e-8) {
    let tangent = normalize(t - n * dot(n, t));
    let bitangent = cross(n, tangent) * in.world_tangent.w;
    let rim = clamp((m.inside + 1.0) / 2.5, 0.0, 1.0);
    let wall = 6.0 * rim * (1.0 - rim) * look.mark_depth;
    (*p).normal = normalize(n + (tangent * m.slope.x - bitangent * m.slope.y) * wall * 0.9);
    (*p).occlusion *= 1.0 - 0.35 * look.mark_depth * clamp(m.inside / 3.0, 0.0, 1.0);
  }

  let ink = m.coverage * look.mark_color.a;
  (*p).base_color = mix((*p).base_color, look.mark_color.rgb, ink);
  (*p).roughness = mix((*p).roughness, look.mark_roughness, ink);
  (*p).metallic = mix((*p).metallic, look.mark_metallic, ink);
  (*p).emissive += look.mark_color.rgb * look.mark_emissive * ink;
  (*p).alpha = max((*p).alpha, ink);

  // Dropped: toward the dropped tone, keeping some of the body's lightness; rougher, 0.62 opaque.
  let d = look.dropped;
  let tone = look.dropped_color.rgb * (0.55 + 0.45 * dice_luma((*p).base_color) / max(dice_luma(look.dropped_color.rgb), 0.05));
  (*p).base_color = mix((*p).base_color, tone, d * 0.85);
  (*p).roughness = min(1.0, (*p).roughness + 0.24 * d);
  (*p).metallic *= 1.0 - d;
  (*p).emissive *= 1.0 - 0.8 * d;
  (*p).alpha = mix((*p).alpha, 0.62, d) * look.fade;
}
`,
}

/** What a family adds to the dice fields. */
export interface DiceFamilyOptions {
  /** The family's own fields (names can't clash with the dice or standard fields). */
  fields?: Fields
  /**
   * WGSL shading the body, run inside the family's generated `pbr_input` with `p` (a PbrInput from
   * the standard fields), `m` (DiceMark), `look` (DiceLook), `in`, `local` (object-space
   * position), `value` (the die's value), `v` (toward the camera) and `F` (this family's uniform)
   * in scope, and `globals.time` (seconds) to animate by. Helpers: `dice_hash`, `dice_noise` and
   * `dice_fbm` (object-space noise), `dice_luma`, and `dice_local_ray(in, local)`, the view ray
   * inside the die. The shared `dice_finish` runs after it. Leave it out and give `shader` instead
   * to write the whole module.
   */
  surface?: string
  /**
   * The body moves with `globals.time` (a vortex turning, a pulsar sweeping): while its dice are on
   * the table, frames keep coming, at the display's rate (`true`) or at most `fps`. Without it the
   * table draws nothing once dice rest, and a time-driven body holds still. Reduced motion stops it.
   */
  animated?: boolean | { fps: number }
  /** A shader module with the family's own hook overrides (instead of `surface`). */
  shader?: string
  /**
   * A fixed blend mode, for families that only work blended (an additive glow). Their dice blend in
   * every tier, so they don't batch in large pools. Omitted, dice follow their material's
   * alphaMode: see-through families (`translucent`) blend, but draw opaque in large pools.
   */
  blend?: BlendMode
  /**
   * Whether a skin's parameters make these dice see-through (their material blends, so they cast
   * no shadow and get a contact blob instead). Families with a fixed transparent blend always are.
   */
  translucent?: (params: Record<string, unknown>) => boolean
  description?: string
}

export interface DiceFamily {
  name: string
  type: MaterialType
  /** The generated module (families defined with `surface`), for the dice plugin to register. */
  module: { path: string; source: string } | undefined
  translucent: ((params: Record<string, unknown>) => boolean) | undefined
  /** Frames per second the body animates at while shown: 0 still, Infinity the display's rate. */
  fps: number
}

const families = new Map<string, DiceFamily>()

function snake(name: string): string {
  return materialModulePath(name).slice('material::'.length)
}

function familyModule(
  name: string,
  type: MaterialType,
  surface: string,
): { path: string; source: string } {
  const u = type.varName
  const look = [
    'markColor',
    'edgeColor',
    'droppedColor',
    'markEmissive',
    'markRoughness',
    'markMetallic',
    'markDepth',
    'edgeMix',
    'dropped',
    'fade',
    'result',
    'resultTime',
  ]
    .map((f) => `${u}.${f}`)
    .join(', ')
  const path = `dice::family::${snake(name)}`
  const source = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::globals::globals;
import shard::dice::surface::{ DiceLook, DiceMark, dice_base, dice_mark, dice_finish, dice_extra, dice_view, dice_local_ray, dice_hash, dice_noise, dice_fbm, dice_luma };
import ${type.modulePath}::{ ${u}, ${u}_marks, ${u}_marks_sampler };

override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  return dice_extra(position);
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  let m = dice_mark(in, ${u}_marks, ${u}_marks_sampler);
  let look = DiceLook(${look});
  var p = dice_base(in);
  let F = ${u};
  let local = in.extra.xyz;
  let value = floor(in.extra.w + 0.5);
  let v = dice_view(in);
${surface}
  dice_finish(&p, m, look, in);
  return p;
}
`
  return { path, source }
}

/**
 * Declares a dice family: `defineMaterial` extending the standard material with the dice fields
 * required. Skins name it by `name`. Aether's nebula, plasma, stained glass and black hole are
 * such families, defined in Aether.
 */
export function defineDiceFamily(name: string, options: DiceFamilyOptions): DiceFamily {
  for (const key of Object.keys(options.fields ?? {})) {
    if (DICE_FIELD_NAMES.includes(key)) {
      throw new ShardError(
        'dice/family-field-clash',
        `Dice family ${name} redefines the dice field "${key}"`,
        {
          hint: 'Give the field another name: the dice fields are shared by every family.',
        },
      )
    }
  }
  if (!options.surface && !options.shader) {
    throw new ShardError(
      'dice/invalid-family',
      `Dice family ${name} has no surface and no shader`,
      {
        hint: 'Give a WGSL `surface` snippet, or a `shader` module overriding pbr_input.',
      },
    )
  }
  const shaderPath = options.shader ?? `dice::family::${snake(name)}`
  const type = defineMaterial(name, {
    extends: 'standard',
    standardTextures: false,
    fields: { ...DICE_FIELDS, ...options.fields },
    blend: options.blend,
    shader: shaderPath,
    description: options.description ?? `Dice family ${name}.`,
  })
  const animated = options.animated
  if (typeof animated === 'object' && !(animated.fps > 0)) {
    throw new ShardError(
      'dice/invalid-family',
      `Dice family ${name} animates at ${animated.fps} fps`,
      { hint: 'Give animated: true (the display rate) or { fps } above 0.', path: 'animated.fps' },
    )
  }
  const family: DiceFamily = {
    name,
    type,
    module: options.surface ? familyModule(name, type, options.surface) : undefined,
    translucent: options.translucent,
    fps: animated === true ? Number.POSITIVE_INFINITY : animated ? animated.fps : 0,
  }
  families.set(name, family)
  return family
}

export function findDiceFamily(name: string): DiceFamily | undefined {
  return families.get(name)
}

export function allDiceFamilies(): DiceFamily[] {
  return [...families.values()]
}

/** Whether a material type has every dice field (a family defined some other way still renders). */
export function isDiceMaterial(type: MaterialType): boolean {
  return DICE_FIELD_NAMES.every((f) => f in type.schema.fields)
}

export { findMaterialType }
