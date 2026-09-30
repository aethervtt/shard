import {
  Children,
  defineResource,
  defineSystem,
  type Entity,
  Last,
  type World,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { definePlugin } from '@aethervtt/shard-runtime'
import { addRenderFeatures } from './features'
import { ForwardStateResource, forwardQueue, VERTEX_BUFFERS, viewBindGroup } from './forward'
import { GpuAssetsResource } from './gpu-assets'
import { type NodeDescriptor, RenderPhase } from './graph'
import {
  createDrawList,
  type DrawList,
  INSTANCE_FLOATS,
  InstanceFlags,
  InstanceSlot,
  Instances,
} from './instances'
import { MAX_OUTLINE_STYLES, OUTLINE_OCCLUSION, Outline, OutlinePath } from './outline'
import { Graph, RenderDescribers, RenderSet, Shaders, Views } from './plugin'
import { beginPass, idOf, PostCache, tex, uniform } from './post-common'
import { registerShaders } from './shaders'
import { cameraOf } from './view'

// Outlines (0057): outlined slots draw into a small mask (style and depth), jump flood spreads the
// nearest silhouette pixel outward, and a composite draws the ring on the finished view target.
// It runs only while an Outline is in view; with none, the node isn't in the graph.

export const OUTLINE_SHADERS: Record<string, string> = {
  'shard::outline::mask': `
import shard::view::view;
import shard::mesh::{ mesh_vertex_at, visible };

struct MaskVertex {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) style: u32,
}

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @builtin(vertex_index) vertex_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> MaskVertex {
  let m = mesh_vertex_at(instance_index, vertex_index, position, normal, uv, uv1, tangent);
  var out: MaskVertex;
  out.clip = view.viewProjNoJitter * vec4f(m.world_position, 1.0);
  // The pass packs each slot's style into its visible entry's top 4 bits.
  out.style = visible[instance_index] >> 28u;
  return out;
}

/** Style + 1 (0 where nothing is outlined), and the surface's reversed-Z depth. */
@fragment fn fs(in: MaskVertex) -> @location(0) vec4f {
  return vec4f(f32(in.style) + 1.0, in.clip.z, 0.0, 0.0);
}`,

  'shard::outline::post': `
import shard::color::linear_to_srgb;

struct Styles {
  /** Per style: color (linear, straight alpha). */
  colors: array<vec4f, ${MAX_OUTLINE_STYLES}>,
  /** Per style: width in target pixels (x), occluded parts: 0 hide, 1 show, 2 dim (y). */
  params: array<vec4f, ${MAX_OUTLINE_STYLES}>,
  /** Render size over target size (xy), to read the scene's depth. */
  scale: vec4f,
}

@group(0) @binding(0) var<uniform> styles: Styles;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var scene_depth: texture_depth_2d;
@group(0) @binding(3) var<uniform> step: vec4f;
@group(0) @binding(4) var mask: texture_2d<f32>;

const NONE = vec4f(-1.0e9, -1.0e9, 0.0, 0.0);

/**
 * Seeds: every outlined pixel, as (x, y, style + 1, visible). Parts something hides seed only
 * when their style shows or dims them.
 */
@fragment fn seed(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let m = textureLoad(source, p, 0);
  if (m.x < 0.5) { return NONE; }
  let style = u32(m.x) - 1u;
  let size = vec2i(textureDimensions(scene_depth));
  let q = clamp(vec2i(frag.xy * styles.scale.xy), vec2i(0), size - 1);
  let scene = textureLoad(scene_depth, q, 0);
  // Reversed Z: nearer is larger. The mask draws unjittered, the scene may not: a little slack.
  let seen = m.y >= scene * 0.998 - 1e-7;
  if (!seen && styles.params[style].y < 0.5) { return NONE; }
  return vec4f(frag.xy, m.x, select(0.0, 1.0, seen));
}

/** One jump flood step: the nearest seed among the 3×3 neighbours \`step.x\` pixels apart. */
@fragment fn flood(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(source));
  let s = i32(step.x);
  var best = NONE;
  var best_d = 1.0e20;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = vec2i(frag.xy) + vec2i(x, y) * s;
      if (any(q < vec2i(0)) || any(q >= size)) { continue; }
      let c = textureLoad(source, q, 0);
      if (c.z < 0.5) { continue; }
      let d = distance(frag.xy, c.xy);
      if (d < best_d) {
        best_d = d;
        best = c;
      }
    }
  }
  return best;
}

/** The ring: pixels outside every silhouette within their nearest seed's width. */
@fragment fn composite(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  if (textureLoad(mask, p, 0).x > 0.5) { discard; }
  let c = textureLoad(source, p, 0);
  if (c.z < 0.5) { discard; }
  let style = u32(c.z) - 1u;
  let params = styles.params[style];
  let d = distance(frag.xy, c.xy);
  var a = clamp(params.x + 0.5 - d, 0.0, 1.0);
  if (c.w < 0.5 && params.y > 1.5) { a *= 0.35; }
  let color = styles.colors[style];
  a *= color.a;
  if (a <= 0.0) { discard; }
  var rgb = color.rgb;
  @if(!SRGB_TARGET) { rgb = linear_to_srgb(rgb); }
  return vec4f(rgb * a, a);
}`,
}

/** One outline style in a view: what an Outline draws. */
interface Style {
  color: [number, number, number, number]
  width: number
  occluded: number
}

/** A view's outlines this frame: the mask's draws and the styles they use. */
export interface OutlineView {
  view: string
  camera: Entity
  draws: DrawList
  styles: Style[]
  /** Outlined entities (renderables) drawn. */
  count: number
  /** The style uniforms: colors, then params, then the scale. */
  data: Float32Array
  textures: OutlineTextures | undefined
}

interface OutlineTextures {
  generation: number
  width: number
  height: number
  mask: GPUTexture
  depth: GPUTexture
  a: GPUTexture
  b: GPUTexture
}

export const OutlineViews = defineResource<Map<string, OutlineView>>('render/OutlineViews', {
  description: "Each view's outlines this frame (outline pass, 0057).",
  init: () => new Map(),
})

const STYLE_FLOATS = MAX_OUTLINE_STYLES * 8 + 4

/** Scratch for gathering: entries (slot | style << 28) and their batches. */
let entries = new Uint32Array(64)
let entryBatches = new Int32Array(64)
let entryCount = 0

function push(slot: number, style: number, batch: number): void {
  if (entryCount >= entries.length) {
    const e = new Uint32Array(entries.length * 2)
    e.set(entries)
    entries = e
    const b = new Int32Array(entryBatches.length * 2)
    b.set(entryBatches)
    entryBatches = b
  }
  entries[entryCount] = (slot | (style << 28)) >>> 0
  entryBatches[entryCount] = batch
  entryCount++
}

/** Adds an entity's renderable (and its descendants') to this view's mask. */
function gather(world: World, e: Entity, style: number, layers: number, seen: Set<Entity>): void {
  if (seen.has(e) || !world.isAlive(e)) return
  seen.add(e)
  const store = world.resource(Instances)
  const slotData = world.tryGet(e, InstanceSlot)
  const slot = slotData ? slotData.slot - 1 : -1
  if (slot >= 0) {
    const flags = store.u32[slot * INSTANCE_FLOATS + 13]!
    const a = store.batchOf[slot]!
    const visible = (flags & InstanceFlags.Visible) !== 0
    if (visible && a !== -1 && (store.layers[slot]! & layers) !== 0) {
      const batch = a >= 0 ? a : store.lodSets[-2 - a]!.batches[0]!
      push(slot, style, batch)
    }
  }
  const children = world.tryGet(e, Children)
  if (children)
    for (const child of children.entities)
      if (child !== null) gather(world, child, style, layers, seen)
}

/**
 * Gathers each camera view's outlined renderables into its mask draws, after the forward queue
 * (so this frame's visible lists are open) and before the upload.
 */
export const queueOutlines = defineSystem({
  name: 'render/queue-outlines',
  description: 'Collects outlined renderables per view for the outline pass (0057).',
  setup: (world) => ({
    q: world.query({ with: [Outline] }),
    seen: new Set<Entity>(),
    live: new Set<string>(),
  }),
  run: ({ q, seen, live }, world) => {
    const views = world.resource(OutlineViews)
    let any = 0
    for (const t of q.tables) any += t.count
    if (any === 0) {
      if (views.size > 0) {
        for (const v of views.values()) v.textures = destroyTextures(v.textures)
        views.clear()
      }
      return
    }
    const store = world.resource(Instances)
    live.clear()
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      let ov = views.get(view.name)
      if (!ov) {
        ov = {
          view: view.name,
          camera: cam.entity,
          draws: createDrawList(),
          styles: [],
          count: 0,
          data: new Float32Array(STYLE_FLOATS),
          textures: undefined,
        }
        views.set(view.name, ov)
      }
      live.add(view.name)
      ov.styles.length = 0
      entryCount = 0
      seen.clear()
      for (const table of q.tables) {
        for (let row = 0; row < table.count; row++) {
          const e = table.entities[row]! as Entity
          const o = world.get(e, Outline)
          let style = ov.styles.findIndex(
            (s) =>
              s.width === o.width &&
              s.occluded === OUTLINE_OCCLUSION.indexOf(o.occluded) &&
              s.color.every((c, i) => c === o.color[i]),
          )
          if (style < 0) {
            if (ov.styles.length >= MAX_OUTLINE_STYLES) style = MAX_OUTLINE_STYLES - 1
            else {
              style = ov.styles.length
              ov.styles.push({
                color: o.color as [number, number, number, number],
                width: o.width,
                occluded: OUTLINE_OCCLUSION.indexOf(o.occluded),
              })
            }
          }
          gather(world, e, style, cam.layers, seen)
        }
      }
      ov.count = entryCount
      store.packEntries(ov.draws, entries, entryBatches, entryCount)
      // Uniforms: widths in target pixels, and the render / target scale for the scene depth.
      const d = ov.data
      d.fill(0)
      for (let i = 0; i < ov.styles.length; i++) {
        const s = ov.styles[i]!
        d.set(s.color, i * 4)
        d[MAX_OUTLINE_STYLES * 4 + i * 4] = s.width * cam.pixelRatio
        d[MAX_OUTLINE_STYLES * 4 + i * 4 + 1] = s.occluded
      }
      d[MAX_OUTLINE_STYLES * 8] = cam.width / Math.max(1, cam.displayWidth)
      d[MAX_OUTLINE_STYLES * 8 + 1] = cam.height / Math.max(1, cam.displayHeight)
    }
    for (const [name, v] of views) {
      if (!live.has(name)) {
        v.textures = destroyTextures(v.textures)
        views.delete(name)
      }
    }
  },
})

function destroyTextures(t: OutlineTextures | undefined): undefined {
  if (t) for (const x of [t.mask, t.depth, t.a, t.b]) x.destroy()
  return undefined
}

function textures(
  gpu: GpuContext,
  ov: OutlineView,
  width: number,
  height: number,
): OutlineTextures {
  const t = ov.textures
  if (t && t.generation === gpu.generation && t.width === width && t.height === height) return t
  destroyTextures(t)
  const make = (label: string, format: GPUTextureFormat) =>
    gpu.device.createTexture({
      label: `${ov.view}/outline/${label}`,
      size: [width, height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
  ov.textures = {
    generation: gpu.generation,
    width,
    height,
    mask: make('mask', 'rg32float'),
    depth: make('depth', 'depth32float'),
    a: make('flood-a', 'rgba32float'),
    b: make('flood-b', 'rgba32float'),
  }
  return ov.textures
}

/** The mask's pipeline: every outlined slot's style and depth, through the mesh vertex stage. */
function maskPipeline(world: World, gpu: GpuContext, cache: Map<number, GPURenderPipeline>) {
  const cached = cache.get(gpu.generation)
  if (cached) return cached
  const module = world.resource(Shaders).module(gpu, { root: 'shard::outline::mask' })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const state = world.resource(ForwardStateResource)
  const store = world.resource(Instances)
  const empty = gpu.layouts.bindGroupLayout({ label: 'outline/empty', entries: [] })
  const pipeline = gpu.pipelines.render({
    label: 'outline/mask',
    layout: gpu.layouts.pipelineLayout({
      label: 'outline/mask',
      bindGroupLayouts: [state.layouts.view, empty, store.layout],
    }),
    vertex: { module, entryPoint: 'vs', buffers: VERTEX_BUFFERS },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rg32float' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
  })
  if (pipeline) cache.set(gpu.generation, pipeline)
  return pipeline
}

const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
}

/** Jump flood step uniforms: reused, rewritten only when a step's size changes. */
const stepData = new Float32Array(4)
const stepSizes: number[] = []
const stepWritten: unknown[] = []
const stepBuffers: { buffer: GPUBuffer; version: number }[] = []

/**
 * post/outline: the mask, a seed pass, jump flood down to 1 pixel, and the composite, drawn on
 * the view target after the display stage.
 */
function outlineNode(world: World): NodeDescriptor {
  const views = world.resource(OutlineViews)
  const cache = new PostCache()
  const masks = new Map<number, GPURenderPipeline>()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  const empty = new Map<number, GPUBindGroup>()
  return {
    kind: 'raw',
    phase: RenderPhase.Display + 30,
    enabled: (view) => (views.get(view.name)?.draws.length ?? 0) > 0,
    reads: ['depth'],
    writes: ['view-target'],
    run: (ctx) => {
      const gpu = ctx.gpu
      const ov = views.get(ctx.view.name)!
      const cam = cameraOf(ctx.view)!
      const state = ctx.world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      const store = ctx.world.resource(Instances)
      const assets = ctx.world.resource(GpuAssetsResource)
      if (!pv || !store.bindGroup) return
      const target = ctx.texture('view-target')
      const t = textures(gpu, ov, target.width, target.height)
      const mask = maskPipeline(ctx.world, gpu, masks)
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'outline',
          entries: [
            uniform(0),
            tex(1, 'unfilterable-float'),
            tex(2, 'depth'),
            uniform(3),
            tex(4, 'unfilterable-float'),
          ],
        })
      }
      const srgb = target.format.endsWith('-srgb')
      const seed = cache.render(
        ctx,
        'outline/seed',
        'shard::outline::post',
        'seed',
        [layout],
        [{ format: 'rgba32float' }],
        { SRGB_TARGET: srgb },
      )
      const flood = cache.render(
        ctx,
        'outline/flood',
        'shard::outline::post',
        'flood',
        [layout],
        [{ format: 'rgba32float' }],
        { SRGB_TARGET: srgb },
      )
      const composite = cache.render(
        ctx,
        `outline/composite/${target.format}`,
        'shard::outline::post',
        'composite',
        [layout],
        [{ format: target.format, blend: PREMULTIPLIED }],
        { SRGB_TARGET: srgb },
      )
      if (!mask || !seed || !flood || !composite) return
      // 1. The mask.
      const pass = ctx.encoder.beginRenderPass({
        label: `${ctx.view.name}/outline/mask`,
        colorAttachments: [
          {
            view: t.mask.createView(),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: t.depth.createView(),
          depthLoadOp: 'clear',
          depthClearValue: 0,
          depthStoreOp: 'discard',
        },
      })
      pass.setPipeline(mask)
      pass.setBindGroup(0, viewBindGroup(gpu, ctx.world, pv, cam))
      let group1 = empty.get(gpu.generation)
      if (!group1) {
        group1 = gpu.device.createBindGroup({
          label: 'outline/empty',
          layout: gpu.layouts.bindGroupLayout({ label: 'outline/empty', entries: [] }),
          entries: [],
        })
        empty.clear()
        empty.set(gpu.generation, group1)
      }
      pass.setBindGroup(1, group1)
      pass.setBindGroup(2, store.bindGroup)
      const draws = ov.draws
      for (let d = 0; d < draws.length; d++) {
        const item = draws.items[d]!
        const gm = assets.mesh(item.batch.mesh)
        pass.setVertexBuffer(0, gm.positions)
        pass.setVertexBuffer(1, gm.normals)
        pass.setVertexBuffer(2, gm.uvs)
        pass.setVertexBuffer(3, gm.uvs1)
        pass.setVertexBuffer(4, gm.tangents)
        if (gm.indices) {
          pass.setIndexBuffer(gm.indices, gm.indexFormat)
          pass.drawIndexed(gm.count, item.count, 0, gm.baseVertex, item.first)
        } else pass.draw(gm.count, item.count, 0, item.first)
      }
      pass.end()
      // 2. Seeds, then 3. jump flood from the widest outline down to 1 pixel.
      const styles = cache.buffer(gpu, `${ctx.view.name}/outline/styles`, ov.data.byteLength)
      styles.write(ov.data)
      const depth = ctx.texture('depth')
      let widest = 1
      for (const s of ov.styles) widest = Math.max(widest, s.width * cam.pixelRatio + 1)
      let step = 1
      while (step * 2 <= widest) step *= 2
      let steps = 0
      for (let s = step; s >= 1; s /= 2) {
        const b = cache.buffer(gpu, `outline/step${steps}`, 16)
        if (b.version === 0 || stepSizes[steps] !== s || stepWritten[steps] !== b) {
          stepData[0] = s
          b.write(stepData)
          stepSizes[steps] = s
          stepWritten[steps] = b
        }
        stepBuffers[steps++] = b
      }
      const bind = (slot: string, source: GPUTexture, stepBuffer: GPUBuffer) =>
        cache.group(
          gpu,
          `${ctx.view.name}/${slot}`,
          `${idOf(source)}/${idOf(depth)}/${idOf(t.mask)}/${styles.version}/${idOf(stepBuffer)}`,
          layout!,
          () => [
            { binding: 0, resource: { buffer: styles.buffer } },
            { binding: 1, resource: source.createView() },
            { binding: 2, resource: depth.createView({ aspect: 'depth-only' }) },
            { binding: 3, resource: { buffer: stepBuffer } },
            { binding: 4, resource: t.mask.createView() },
          ],
        )
      let from = t.a
      let to = t.b
      const seedPass = beginPass(ctx, 'outline/seed', t.a.createView())
      seedPass.setPipeline(seed)
      seedPass.setBindGroup(0, bind('outline/seed', t.mask, stepBuffers[0]!.buffer))
      seedPass.draw(3)
      seedPass.end()
      for (let i = 0; i < steps; i++) {
        const p = beginPass(ctx, 'outline/flood', to.createView())
        p.setPipeline(flood)
        p.setBindGroup(0, bind(`outline/flood${i}`, from, stepBuffers[i]!.buffer))
        p.draw(3)
        p.end()
        const x = from
        from = to
        to = x
      }
      // 4. The ring, over the finished picture.
      const c = beginPass(ctx, 'outline/composite', target.createView(), true)
      c.setPipeline(composite)
      c.setBindGroup(0, bind('outline/composite', from, stepBuffers[0]!.buffer))
      c.draw(3)
      c.end()
    },
  }
}

/** render.describe's outlines section: per view, its styles and how many renderables they cover. */
export function describeOutlines(world: World) {
  const out: Record<string, unknown> = {}
  for (const [name, v] of world.resource(OutlineViews)) {
    out[name] = {
      renderables: v.count,
      draws: v.draws.length,
      styles: v.styles.map((s) => ({
        color: [...s.color],
        width: s.width,
        occluded: OUTLINE_OCCLUSION[s.occluded],
      })),
    }
  }
  return out
}

/**
 * Selection and hover outlines (0057): a mask of the outlined renderables, jump flood, and a ring
 * composited on the view target. Not in the graph while no Outline is in view.
 */
export const outlinePlugin = definePlugin({
  name: 'render/outline',
  dependencies: ['render/forward'],
  provides: [OutlineViews],
  build(app) {
    app.insertResource(OutlinePath, { installed: true })
    app.world.initResource(OutlineViews)
    app.addSystems(Last, queueOutlines.inSet(RenderSet.Queue).after(forwardQueue))
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), OUTLINE_SHADERS)
    app.world.initResource(RenderDescribers).set('outlines', describeOutlines)
    addRenderFeatures(app.world, {
      name: 'render/outline',
      description: 'Selection outlines (mask and jump flood).',
      nodes: ['post/outline'],
      baseline: { strategy: 'The same fragment passes' },
    })
    app.world.resource(Graph).addNode('post/outline', outlineNode(app.world))
  },
})
