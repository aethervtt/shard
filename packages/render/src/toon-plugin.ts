import type { World } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { addRenderFeatures } from './features'
import { viewPixelScale } from './forward'
import { type NodeDescriptor, RenderPhase } from './graph'
import { Graph, RenderDescribers, Shaders, Views } from './plugin'
import { hasEffect, PostEffect, PostFeatures } from './post'
import {
  beginPass,
  depthTex,
  forwardView,
  idOf,
  PostCache,
  roundsRg11,
  targetsFor,
  tex,
  uniform,
} from './post-common'
import { registerShaders } from './shaders'
import { Ink, Toon, ToonPath } from './toon'
import { cameraOf } from './view'

// Toon shading and ink (0108). Toon is the lighting stage's TOON variant, linked from shard::toon
// for the views whose camera has one. Ink is the HDR chain's first effect: edges from depth and
// normals, a row pass, and a composite that turns the distance to the nearest edge into a line.
// Edges are full (silhouettes, anything within the fade's near distance) or fading (lines inside
// silhouettes past it); the rows and the composite keep the nearest of each.

export const TOON_SHADERS: Record<string, string> = {
  'shard::toon': `
import shard::view::view;
import shard::pbr::types::PbrInput;
import shard::pbr::brdf::PI;
import shard::pbr::environment::env_irradiance;

/** Tone k of the view's ramp, darkest first. */
fn toon_tone(k: u32) -> vec3f {
  if (k < 4u) { return view.toonRamp[k].rgb; }
  return view.toonRampHigh[k - 4u].rgb;
}

/**
 * The ramp at a light amount (0–1): the tones' edges evenly spaced, the first on the terminator,
 * each stepping over the camera's softness.
 */
fn toon_ramp(amount: f32) -> vec3f {
  let n = u32(view.toon.x);
  let soft = max(view.toon.y, 1e-4);
  var tone = toon_tone(0u);
  for (var k = 1u; k < n; k++) {
    let edge = f32(k - 1u) / f32(n - 1u);
    tone += (toon_tone(k) - toon_tone(k - 1u)) * smoothstep(edge, edge + soft, amount);
  }
  return tone;
}

/**
 * One light's banded diffuse, before its color: how directly the surface faces it times \`amount\`
 * (received shadow, a spot's cone, walls), through the ramp. No specular.
 */
fn toon_light(n: vec3f, l: vec3f, amount: f32, diffuse_color: vec3f) -> vec3f {
  return diffuse_color / PI * toon_ramp(max(dot(n, l), 0.0) * clamp(amount, 0.0, 1.0));
}

/** The environment's diffuse light alone (its irradiance), in cd/m². */
fn toon_environment(p: PbrInput, n: vec3f) -> vec3f {
  return env_irradiance(n) * p.base_color * p.occlusion * view.envParams.x;
}`,

  'shard::post::ink': `
import shard::pbr::gbuffer::oct_decode;
import shard::post::common::post_out;

struct InkParams {
  /** Line color (linear, straight alpha). */
  color: vec4f,
  /** Depth threshold (m), cos of the normal threshold, half the width (px), radius searched (px). */
  params: vec4f,
  /** Near, far (orthographic), 1 when orthographic. */
  projection: vec4f,
  /** Fade near and far (m; far 0: none), the silhouette fraction of the distance. */
  fade: vec4f,
  /** World to view rotation, by rows. */
  view_x: vec4f,
  view_y: vec4f,
  view_z: vec4f,
  /** One over the projection's x and y scales. */
  lens: vec4f,
}

@group(0) @binding(0) var<uniform> ink: InkParams;
@group(0) @binding(1) var depth_texture: texture_depth_2d;
@group(0) @binding(2) var normal_texture: texture_2d<f32>;
/** The edges (row pass), or each pixel's distance to one along its row (composite). */
@group(0) @binding(3) var source: texture_2d<f32>;
@group(0) @binding(4) var input: texture_2d<f32>;

fn device_at(p: vec2i) -> f32 {
  let size = vec2i(textureDimensions(depth_texture));
  return textureLoad(depth_texture, clamp(p, vec2i(0), size - 1), 0);
}

fn normal_at(p: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(normal_texture));
  return oct_decode(textureLoad(normal_texture, clamp(p, vec2i(0), size - 1), 0).xy);
}

/** Distance along the view axis of a reversed-Z depth: infinite perspective, or orthographic. */
fn linear_depth(d: f32) -> f32 {
  let near = ink.projection.x;
  let far = ink.projection.y;
  if (ink.projection.z > 0.5) { return far - d * (far - near); }
  return near / max(d, 1e-9);
}

/**
 * How far the surface at b lies behind the plane through a and c (c between them), in meters.
 * Device depth is affine across a plane in screen space (either projection): 2c - a is that
 * plane's depth at b, so a plane at any slant gives 0. The sky is infinitely far.
 */
fn fall_back(a: f32, c: f32, b: f32) -> f32 {
  if (b <= 0.0) { return 1e9; }
  return linear_depth(b) - linear_depth(clamp(2.0 * c - a, 1e-9, 1.0));
}

/**
 * How far the depth of q's tangent plane changes (m) between q, at depth zq, and the pixel p next
 * to it: a surface seen edge-on steps far back from one pixel to the next.
 */
fn plane_step(q: vec2i, zq: f32, p: vec2i) -> f32 {
  let n = normal_at(q);
  let v = vec3f(dot(ink.view_x.xyz, n), dot(ink.view_y.xyz, n), dot(ink.view_z.xyz, n));
  let size = vec2f(textureDimensions(depth_texture));
  let flip = vec2f(2.0, -2.0) / size;
  // The ray through p, and q's offset from it, at unit depth (perspective) or in meters.
  let offset = vec2f(q - p) * flip * ink.lens.xy;
  var ray = vec3f(0.0, 0.0, -1.0);
  var scale = 1.0;
  if (ink.projection.z < 0.5) {
    ray = vec3f(((vec2f(p) + 0.5) * flip + vec2f(-1.0, 1.0)) * ink.lens.xy, -1.0);
    scale = zq;
  }
  return scale * abs(dot(v.xy, offset)) / max(abs(dot(v, ray)), 1e-6);
}

/**
 * How far the surface at q (depth b) falls back behind the plane through a and c (c at p, a
 * opposite q), in meters, less the step q's own tangent plane makes toward p. A curved surface
 * seen at a grazing angle falls back by up to that step at each pixel or facet: a convex bend
 * turning by more than the grazing angle would hide what lies past it. An occlusion falls back
 * farther, by the occluder's height in pixels times the step.
 */
fn gap_toward(a: f32, c: f32, b: f32, p: vec2i, q: vec2i) -> f32 {
  let gap = fall_back(a, c, b);
  if (gap <= ink.params.x || b <= 0.0) { return gap; }
  return gap - plane_step(q, linear_depth(b), p);
}

/** How strongly lines inside silhouettes draw at a distance: 1, fading to 0 over the fade. */
fn fade_at(z: f32) -> f32 {
  if (ink.projection.z > 0.5 || ink.fade.y <= 0.0) { return 1.0; }
  return 1.0 - smoothstep(ink.fade.x, max(ink.fade.y, ink.fade.x + 1e-3), z);
}

/** Whether the surface at q turns away from n by more than the threshold, with no jump between. */
fn turns(n: vec3f, q: vec2i, dq: f32, zc: f32) -> bool {
  if (dq <= 0.0 || abs(linear_depth(dq) - zc) > ink.params.x) { return false; }
  return dot(n, normal_at(q)) < ink.params.y;
}

/**
 * An edge's strength (0: none): a neighbour falls back behind this pixel's plane by more than its
 * own surface's step (the line sits on the nearer surface), or the right or lower neighbour's
 * surface turns (creases, edges facing the camera). 1 within the fade's near distance; past it, a
 * depth edge stays 1 where the surface behind lies the silhouette fraction of the distance back
 * (half that: none of its own), and everything else takes the fade.
 */
@fragment fn edges(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let c = device_at(p);
  if (c <= 0.0) { return vec4f(0.0); }
  let pl = p + vec2i(-1, 0);
  let pr = p + vec2i(1, 0);
  let pu = p + vec2i(0, -1);
  let pd = p + vec2i(0, 1);
  let l = device_at(pl);
  let r = device_at(pr);
  let u = device_at(pu);
  let d = device_at(pd);
  let gap = max(
    max(gap_toward(l, c, r, p, pr), gap_toward(r, c, l, p, pl)),
    max(gap_toward(u, c, d, p, pd), gap_toward(d, c, u, p, pu)),
  );
  let zc = linear_depth(c);
  let w = fade_at(zc);
  if (gap > ink.params.x) {
    let s = ink.fade.z * zc;
    if (w >= 1.0 || gap >= s) { return vec4f(1.0); }
    return vec4f(max(w, smoothstep(0.5 * s, s, gap)));
  }
  if (w <= 0.0) { return vec4f(0.0); }
  let n = normal_at(p);
  if (turns(n, pr, r, zc) || turns(n, pd, d, zc)) { return vec4f(w); }
  return vec4f(0.0);
}

/**
 * Along this row, within the radius: the distance to the nearest full edge and to the nearest
 * fading one (255: none), over 255, then that fading edge's strength.
 */
@fragment fn rows(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let width = i32(textureDimensions(source).x);
  let radius = i32(ink.params.w);
  var full = 255.0;
  var fading = 255.0;
  var strength = 0.0;
  for (var dx = -radius; dx <= radius; dx++) {
    let x = p.x + dx;
    if (x < 0 || x >= width) { continue; }
    let e = textureLoad(source, vec2i(x, p.y), 0).x;
    let a = f32(abs(dx));
    if (e > 254.5 / 255.0) {
      full = min(full, a);
    } else if (e > 0.0 && (a < fading || (a == fading && e > strength))) {
      fading = a;
      strength = e;
    }
  }
  return vec4f(full / 255.0, fading / 255.0, strength, 0.0);
}

/** The line: coverage from the distance to the nearest edge pixel, mixed over the image. */
@fragment fn composite(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let c = textureLoad(input, p, 0);
  let height = i32(textureDimensions(source).y);
  let radius = i32(ink.params.w);
  let reach = ink.params.z + 0.5;
  var d2 = 1e9;
  var fading = 0.0;
  for (var dy = -radius; dy <= radius; dy++) {
    let y = p.y + dy;
    if (y < 0 || y >= height) { continue; }
    let s = textureLoad(source, vec2i(p.x, y), 0);
    let dx = round(s.x * 255.0);
    if (dx < 255.0) { d2 = min(d2, dx * dx + f32(dy * dy)); }
    let fx = round(s.y * 255.0);
    if (fx < 255.0) {
      fading = max(fading, clamp(reach - sqrt(fx * fx + f32(dy * dy)), 0.0, 1.0) * s.z);
    }
  }
  let k = max(clamp(reach - sqrt(d2), 0.0, 1.0), fading) * ink.color.a;
  return post_out(vec4f(c.rgb * (1.0 - k) + ink.color.rgb * k, c.a * (1.0 - k) + k));
}`,
}

const EDGE_FORMAT: GPUTextureFormat = 'r8unorm'
const EDGE_TARGETS: GPUColorTargetState[] = [{ format: EDGE_FORMAT }]
const ROW_FORMAT: GPUTextureFormat = 'rgba8unorm'
const ROW_TARGETS: GPUColorTargetState[] = [{ format: ROW_FORMAT }]
const INK_FLOATS = 32

/** post/ink: edges, rows, then the composite into the chain's next texture. */
function inkNode(): NodeDescriptor {
  const cache = new PostCache()
  const data = new Float32Array(INK_FLOATS)
  const scale = new Float32Array(4)
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  return {
    kind: 'raw',
    // First in the HDR chain: fog, aerial perspective and TAA treat the lines like the scene.
    phase: RenderPhase.Post - 10,
    enabled: hasEffect(PostEffect.Ink),
    reads: ['ink-in', 'ink-depth', 'ink-normal'],
    writes: ['ink-out', 'ink-edges', 'ink-rows'],
    run: (ctx) => {
      const v = forwardView(ctx)
      if (!v) return
      const gpu = ctx.gpu
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'ink',
          entries: [
            uniform(0),
            depthTex(gpu, 1),
            tex(2, 'unfilterable-float'),
            tex(3, 'unfilterable-float'),
            tex(4, 'unfilterable-float'),
          ],
        })
      }
      const out = ctx.texture('ink-out')
      const rg11 = roundsRg11(gpu, out)
      const edges = cache.render(
        ctx,
        'ink/edges',
        'shard::post::ink',
        'edges',
        [layout],
        EDGE_TARGETS,
      )
      const rows = cache.render(ctx, 'ink/rows', 'shard::post::ink', 'rows', [layout], ROW_TARGETS)
      const composite = cache.render(
        ctx,
        `ink/composite/${out.format}${rg11 ? '/round' : ''}`,
        'shard::post::ink',
        'composite',
        [layout],
        targetsFor(out),
        { RG11_ROUND: rg11 },
      )
      if (!edges || !rows || !composite) return
      const cam = v.cam
      const ink = cam.post.ink
      // Widths in render pixels: CSS pixels times render pixels per CSS pixel (texels when
      // PixelPerfect), as Outline measures them.
      const half = (ink.width * viewPixelScale(cam, scale)[0]!) / 2
      data.set(ink.color, 0)
      data[4] = ink.depthThreshold
      data[5] = Math.cos((ink.normalThreshold * Math.PI) / 180)
      data[6] = half
      data[7] = Math.ceil(half + 0.5)
      data[8] = cam.near
      data[9] = cam.far
      data[10] = cam.orthographic ? 1 : 0
      data[11] = 0
      data[12] = ink.fade[0]!
      data[13] = ink.fade[1]!
      data[14] = ink.silhouette
      data[15] = 0
      // The view's rotation by rows (column-major), and the lens.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) data[16 + row * 4 + col] = cam.view[col * 4 + row]!
        data[19 + row * 4] = 0
      }
      data[28] = 1 / cam.proj[0]!
      data[29] = 1 / cam.proj[5]!
      data[30] = data[31] = 0
      const params = cache.buffer(gpu, `${ctx.view.name}/ink`, INK_FLOATS * 4)
      params.write(data)
      const input = ctx.texture('ink-in')
      const depth = ctx.texture('ink-depth')
      const normal = ctx.texture('ink-normal')
      const edgeTex = ctx.texture('ink-edges')
      const rowTex = ctx.texture('ink-rows')
      const bind = (slot: string, source: GPUTexture) =>
        cache.group(
          gpu,
          `${ctx.view.name}/${slot}`,
          `${idOf(source)}/${idOf(input)}/${idOf(depth)}/${idOf(normal)}/${params.version}`,
          layout!,
          () => [
            { binding: 0, resource: { buffer: params.buffer } },
            { binding: 1, resource: depth.createView() },
            { binding: 2, resource: normal.createView() },
            { binding: 3, resource: source.createView() },
            { binding: 4, resource: input.createView() },
          ],
        )
      const pass = (
        name: string,
        pipeline: GPURenderPipeline,
        target: GPUTexture,
        source: GPUTexture,
      ) => {
        const p = beginPass(ctx, name, target.createView())
        p.setPipeline(pipeline)
        p.setBindGroup(0, bind(name, source))
        p.draw(3)
        p.end()
      }
      // The edge pass binds the rows texture it doesn't read: one layout for all three.
      pass('ink/edges', edges, edgeTex, rowTex)
      pass('ink/rows', rows, rowTex, edgeTex)
      pass('ink/composite', composite, out, rowTex)
    },
  }
}

/** render.describe's toon section: per view, its tones and edge softness (0 tones: off). */
export function describeToon(world: World) {
  const out: Record<string, unknown> = {}
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    if (!cam || cam.toon.tones === 0) continue
    out[view.name] = { tones: cam.toon.tones, softness: cam.toon.softness }
  }
  return out
}

/**
 * Toon shading and ink (0108): cameras with `Toon` shade in bands, cameras with `Ink` draw lines
 * where depth or surface direction jumps. Neither costs anything for a camera without them.
 */
export const toonPlugin = definePlugin({
  name: 'render/toon',
  dependencies: ['render/forward'],
  build(app) {
    app.insertResource(ToonPath, { installed: true })
    app.world.initResource(PostFeatures).effects |= PostEffect.Ink
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), TOON_SHADERS)
    app.world.initResource(RenderDescribers).set('toon', describeToon)
    const graph = app.world.resource(Graph)
    graph.declare({ name: 'ink-edges', format: EDGE_FORMAT })
    graph.declare({ name: 'ink-rows', format: ROW_FORMAT })
    addRenderFeatures(app.world, {
      name: 'render/toon',
      description: 'Toon shading (a lighting variant) and ink lines from depth and normals.',
      nodes: ['post/ink'],
      baseline: { strategy: 'The same lighting variant and fragment passes' },
      components: [Toon, Ink],
    })
    graph.addNode('post/ink', inkNode())
  },
})
