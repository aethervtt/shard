import { definePlugin } from '@aethervtt/shard-runtime'
import { addRenderFeatures } from './features'
import {
  drawMaterials,
  ForwardStateResource,
  PASS_DEPTH,
  PASS_PREPASS,
  PASS_REFRACT,
  PASS_REFRACT_GBUFFER,
  sceneColor,
} from './forward'
import type { NodeContext, NodeDescriptor, RenderView } from './graph'
import { OPAQUE_COPY_PHASE } from './opaque-copy'
import { Gpu, Graph, Shaders } from './plugin'
import { needsPrepass } from './post'
import { REFRACTION_BINDINGS, RefractionPath } from './refraction'
import { registerShaders } from './shaders'
import { cameraOf } from './view'

// Refracting material types (0129): `refraction: true` on defineMaterial. Their draws come out of
// the transparent pass and into their own, after the opaque copy (0097), whose color and depth the
// view group binds there. They're shaded as opaque surfaces and write depth, so fog and everything
// after see them; a second draw adds them to the depth and normals that ink and SSAO read (the
// prepass in forward views, gbuffer1 in deferred ones), so ink outlines the surface and nothing
// seen through it. None of this runs in a view where no such material draws.

/** Where refracting surfaces draw: after the opaque copy, before the water pass and transparents. */
export const REFRACTION_PHASE = OPAQUE_COPY_PHASE + 5

const VERTEX = `
@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @builtin(vertex_index) vertex_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> VertexOutput {
  var out = mesh_vertex_at(instance_index, vertex_index, position, normal, uv, uv1, tangent);
  out.clip = view.viewProj * vec4f(out.world_position, 1.0);
  return out;
}`

const GBUFFER_OUTPUT = `
/** Deferred views: the color, and the normal into gbuffer1 for ink (packed as the G-buffer is). */
struct RefractionGBuffer {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,
}`

export const REFRACTION_SHADERS: Record<string, string> = {
  'shard::refraction': `
import shard::view::view;
@if(REFRACTION) import shard::pbr::environment::env_sampler;

/** The opaque scene's color (0097): pre-exposed HDR at half resolution, with mips. */
@if(REFRACTION) @group(0) @binding(${REFRACTION_BINDINGS.color}) var opaque_color: texture_2d<f32>;
/** Its depth: reversed Z, full resolution, 0 where nothing was drawn. */
@if(REFRACTION) @group(0) @binding(${REFRACTION_BINDINGS.depth}) var opaque_depth: texture_2d<f32>;

/** A distance where nothing was drawn behind (m). */
const REFRACTION_FAR: f32 = 1e30;

/** A fragment's screen UV, from its position (\`in.clip\` in a fragment stage). */
fn refraction_uv(frag: vec4f) -> vec2f {
  return frag.xy * view.viewport.zw;
}

@if(REFRACTION) fn opaque_color_at(uv: vec2f, mip: f32) -> vec3f {
  return textureSampleLevel(opaque_color, env_sampler, uv, mip).rgb;
}

@if(REFRACTION) fn opaque_depth_at(uv: vec2f) -> f32 {
  let size = vec2i(textureDimensions(opaque_depth));
  return textureLoad(opaque_depth, clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1), 0).r;
}

/**
 * What's behind a refracting surface at a screen UV: the opaque scene's luminance (cd/m², like
 * \`emissive\`), from its half-resolution copy; \`mip\` (0 to 4) blurs it for rough refraction.
 * Black outside the refraction pass (the prepass, picking).
 */
fn refraction_color(uv: vec2f, mip: f32) -> vec3f {
  @if(REFRACTION) return opaque_color_at(uv, mip) / view.exposure;
  @if(!REFRACTION) return vec3f(0.0);
}

/** The opaque scene's depth at a screen UV: reversed Z, 0 where nothing was drawn (and outside the pass). */
fn refraction_depth(uv: vec2f) -> f32 {
  @if(REFRACTION) return opaque_depth_at(uv);
  @if(!REFRACTION) return 0.0;
}

/** The world point a reversed-Z depth at a screen UV stands for (either projection; depth above 0). */
fn depth_world(uv: vec2f, depth: f32) -> vec3f {
  let p = view.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return p.xyz / p.w;
}

/** The direction of the view ray through a world point: from the eye, or the view axis when orthographic. */
fn view_ray(world_position: vec3f) -> vec3f {
  let ahead = -vec3f(view.view[0].z, view.view[1].z, view.view[2].z);
  return select(normalize(world_position - view.cameraPosition), ahead, view.pixelScale.z > 0.5);
}

/**
 * How far along its view ray a reversed-Z depth at a screen UV lies (m): from the eye, or from the
 * camera's plane when orthographic. REFRACTION_FAR where nothing was drawn.
 */
fn depth_distance(uv: vec2f, depth: f32) -> f32 {
  if (depth <= 0.0) { return REFRACTION_FAR; }
  let p = depth_world(uv, depth);
  return dot(p - view.cameraPosition, view_ray(p));
}

/**
 * How much of the material the view ray crosses (m): from the surface at \`world_position\` (this
 * fragment's) to the opaque scene behind it at \`uv\`. REFRACTION_FAR where nothing is behind; 0
 * where what's there is in front of the surface (a bent UV can land on something nearer).
 */
fn refraction_thickness(uv: vec2f, world_position: vec3f) -> f32 {
  let depth = refraction_depth(uv);
  if (depth <= 0.0) { return REFRACTION_FAR; }
  return max(dot(depth_world(uv, depth) - world_position, view_ray(world_position)), 0.0);
}

/** \`uv\` moved by \`offset\` (refraction's bend), unless what's there is in front of the surface: then \`uv\`. */
fn refraction_offset(uv: vec2f, offset: vec2f, world_position: vec3f) -> vec2f {
  let moved = clamp(uv + offset, vec2f(0.0), vec2f(1.0));
  return select(uv, moved, refraction_thickness(moved, world_position) > 0.0);
}`,

  'shard::refraction::pbr': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::mesh::mesh_vertex_at;
import shard::pbr::material::{ pbr_input, fragment_output };
import shard::pbr::standard::material;
import shard::pbr::lighting::apply_lighting;
import shard::pbr::gbuffer::oct_encode;
@if(CUTAWAY) import shard::cutaway::cutaway_clip;
${VERTEX}
${GBUFFER_OUTPUT}

/**
 * The forward pass's opaque fragment: the material mixes in what's behind it (shard::refraction,
 * usually as emissive) and covers its pixel. Its normal as the G-buffer packs it.
 */
fn refracted(in: VertexOutput) -> RefractionGBuffer {
  @if(CUTAWAY) cutaway_clip(in.world_position, in.clip.xy, in.flags);
  let p = pbr_input(in);
  if (material.alphaMode == 1u && p.alpha < material.alphaCutoff) { discard; }
  let color = (apply_lighting(p, in.world_position, in.clip, in.flags) + p.emissive) * view.exposure;
  var out: RefractionGBuffer;
  out.color = vec4f(fragment_output(vec4f(color, p.alpha)).rgb, 1.0);
  out.normal = vec4f(oct_encode(p.normal), p.roughness, p.metallic);
  return out;
}

@fragment fn fs(in: VertexOutput) -> @location(0) vec4f {
  return refracted(in).color;
}

@fragment fn fs_gbuffer(in: VertexOutput) -> RefractionGBuffer {
  return refracted(in);
}`,

  'shard::refraction::unlit': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::mesh::mesh_vertex_at;
import shard::unlit::shading::shade;
import shard::pbr::gbuffer::oct_encode;
@if(CUTAWAY) import shard::cutaway::cutaway_clip;
${VERTEX}
${GBUFFER_OUTPUT}

/** The forward pass's opaque fragment: \`shade\` mixes in what's behind (shard::refraction). */
fn refracted(in: VertexOutput) -> vec4f {
  @if(CUTAWAY) cutaway_clip(in.world_position, in.clip.xy, in.flags);
  let c = shade(in);
  @if(MASK) if (c.a < 0.5) { discard; }
  return vec4f(c.rgb * view.exposure, 1.0);
}

@fragment fn fs(in: VertexOutput) -> @location(0) vec4f {
  return refracted(in);
}

@fragment fn fs_gbuffer(in: VertexOutput) -> RefractionGBuffer {
  var out: RefractionGBuffer;
  out.color = refracted(in);
  out.normal = vec4f(oct_encode(normalize(in.world_normal)), 1.0, 0.0);
  return out;
}`,
}

const refracting = (view: RenderView) => (cameraOf(view)?.refraction ?? 0) > 0

const DEFERRED_COLOR = [{ resource: 'scene-color' }, { resource: 'gbuffer1' }]

/** The refracting draws themselves: forward views, or deferred ones with gbuffer1 as well. */
function refractionNode(deferred: boolean): NodeDescriptor {
  return {
    kind: 'render',
    phase: REFRACTION_PHASE,
    enabled: (view) => refracting(view) && cameraOf(view)!.deferred === deferred,
    reads: [
      'opaque-color',
      'opaque-depth',
      'clusters',
      'shadow-cascades',
      'shadow-local',
      'environment',
    ],
    writes: deferred
      ? ['scene-color', 'scene-depth', 'hdr', 'gbuffer1']
      : ['scene-color', 'scene-depth', 'hdr'],
    color: deferred ? DEFERRED_COLOR : (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth' },
    run: (ctx: NodeContext) => {
      const cam = cameraOf(ctx.view)!
      const state = ctx.world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      const pass = deferred ? PASS_REFRACT_GBUFFER : PASS_REFRACT
      drawMaterials(ctx, state, pv, cam, cam.transparent, pass)
    },
  }
}

/**
 * The prepass's depth, normals and velocity for refracting draws, where a view has a prepass (ink
 * and SSAO in forward views, TAA and motion blur): after SSAO has read it for what's behind.
 */
const prepassNode: NodeDescriptor = {
  kind: 'render',
  phase: REFRACTION_PHASE + 1,
  enabled: (view) => refracting(view) && needsPrepass(view),
  writes: ['prepass-normal', 'velocity', 'prepass-depth'],
  color: [{ resource: 'prepass-normal' }, { resource: 'velocity' }],
  depth: { resource: 'prepass-depth' },
  run: (ctx) => {
    const cam = cameraOf(ctx.view)!
    const state = ctx.world.resource(ForwardStateResource)
    const pv = state.views.get(ctx.view.name)
    if (pv) drawMaterials(ctx, state, pv, cam, cam.transparent, PASS_PREPASS, true)
  },
}

/**
 * Baseline (0064) with MSAA: what reads `depth` reads the single-sample depth prepass, which has
 * no refracting surface in it. This draws them into it too, as the water pass does.
 */
function depthNode(baseline: boolean): NodeDescriptor {
  return {
    kind: 'render',
    phase: REFRACTION_PHASE + 1,
    enabled: (view) => baseline && (cameraOf(view)?.msaa ?? 1) > 1 && refracting(view),
    writes: ['depth'],
    after: ['refraction'],
    depth: { resource: 'depth' },
    run: (ctx) => {
      const cam = cameraOf(ctx.view)!
      const state = ctx.world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      if (pv) drawMaterials(ctx, state, pv, cam, cam.transparent, PASS_DEPTH, true)
    },
  }
}

/**
 * Refracting material types (0129): `refraction: true` on defineMaterial draws after the opaque
 * copy, reads it through `shard::refraction`, writes depth, and is outlined by ink as an opaque
 * surface would be. Needs `opaqueCopyPlugin`; forwardPlugin includes both.
 */
export const refractionPlugin = definePlugin({
  name: 'render/refraction',
  dependencies: ['render/forward', 'render/opaque-copy'],
  build(app) {
    app.insertResource(RefractionPath, { installed: true })
  },
  ready(app) {
    const world = app.world
    registerShaders(world.resource(Shaders), REFRACTION_SHADERS)
    addRenderFeatures(world, {
      name: 'render/refraction',
      description:
        'Material types that read the opaque copy behind them (refraction: true), drawn after it and inked like opaque surfaces.',
      nodes: ['refraction', 'refraction-deferred', 'refraction/prepass', 'refraction/depth'],
      baseline: {
        strategy:
          'The same passes; the opaque copy and, with MSAA, the depth prepass come from the single-sample prepass',
      },
    })
    const graph = world.resource(Graph)
    graph.addNode('refraction', refractionNode(false))
    graph.addNode('refraction-deferred', refractionNode(true))
    graph.addNode('refraction/prepass', prepassNode)
    graph.addNode('refraction/depth', depthNode(world.resource(Gpu).tier === 'baseline'))
  },
})
