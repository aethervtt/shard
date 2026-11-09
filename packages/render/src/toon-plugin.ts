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

/** Whether the surface at q turns away from n by more than the threshold, with no jump between. */
fn turns(n: vec3f, q: vec2i, dq: f32, zc: f32) -> bool {
  if (dq <= 0.0 || abs(linear_depth(dq) - zc) > ink.params.x) { return false; }
  return dot(n, normal_at(q)) < ink.params.y;
}

/**
 * 1 on an edge: a neighbour falls back behind this pixel's plane (the line sits on the nearer
 * surface), or the right or lower neighbour's surface turns (creases, edges facing the camera).
 */
@fragment fn edges(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let c = device_at(p);
  if (c <= 0.0) { return vec4f(0.0); }
  let l = device_at(p + vec2i(-1, 0));
  let r = device_at(p + vec2i(1, 0));
  let u = device_at(p + vec2i(0, -1));
  let d = device_at(p + vec2i(0, 1));
  let gap = max(max(fall_back(l, c, r), fall_back(r, c, l)), max(fall_back(u, c, d), fall_back(d, c, u)));
  if (gap > ink.params.x) { return vec4f(1.0); }
  let n = normal_at(p);
  let zc = linear_depth(c);
  if (turns(n, p + vec2i(1, 0), r, zc) || turns(n, p + vec2i(0, 1), d, zc)) { return vec4f(1.0); }
  return vec4f(0.0);
}

/** The distance to the nearest edge along this row, within the radius (255: none), over 255. */
@fragment fn rows(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let width = i32(textureDimensions(source).x);
  let radius = i32(ink.params.w);
  var best = 255.0;
  for (var dx = -radius; dx <= radius; dx++) {
    let x = p.x + dx;
    if (x < 0 || x >= width) { continue; }
    if (textureLoad(source, vec2i(x, p.y), 0).x > 0.5) { best = min(best, f32(abs(dx))); }
  }
  return vec4f(best / 255.0, 0.0, 0.0, 0.0);
}

/** The line: coverage from the distance to the nearest edge pixel, mixed over the image. */
@fragment fn composite(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let c = textureLoad(input, p, 0);
  let height = i32(textureDimensions(source).y);
  let radius = i32(ink.params.w);
  var d2 = 1e9;
  for (var dy = -radius; dy <= radius; dy++) {
    let y = p.y + dy;
    if (y < 0 || y >= height) { continue; }
    let dx = round(textureLoad(source, vec2i(p.x, y), 0).x * 255.0);
    if (dx < 255.0) { d2 = min(d2, dx * dx + f32(dy * dy)); }
  }
  let k = clamp(ink.params.z + 0.5 - sqrt(d2), 0.0, 1.0) * ink.color.a;
  return post_out(vec4f(c.rgb * (1.0 - k) + ink.color.rgb * k, c.a * (1.0 - k) + k));
}`,
}

const EDGE_FORMAT: GPUTextureFormat = 'r8unorm'
const EDGE_TARGETS: GPUColorTargetState[] = [{ format: EDGE_FORMAT }]
const INK_FLOATS = 12

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
      const rows = cache.render(ctx, 'ink/rows', 'shard::post::ink', 'rows', [layout], EDGE_TARGETS)
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
    graph.declare({ name: 'ink-rows', format: EDGE_FORMAT })
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
