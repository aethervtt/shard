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
import { DataStore, dataEntry } from './data-store'
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
import {
  MAX_OUTLINE_PRIORITIES,
  MAX_OUTLINE_STYLES,
  OUTLINE_OCCLUSION,
  Outline,
  OutlinePath,
} from './outline'
import { Graph, RenderDescribers, RenderSet, Shaders, Views } from './plugin'
import { beginPass, depthTex, idOf, PostCache, tex, uniform } from './post-common'
import { registerShaders } from './shaders'
import { type CameraData, cameraOf } from './view'

// Outlines (0057, 0108): outlined slots draw into a small mask (style, depth, owner, precedence),
// jump flood spreads the nearest silhouette pixel outward, and a composite draws the ring on the
// finished view target. It runs only while an Outline is in view; with none, the node isn't in the
// graph. A renderable's Outline (its owner) is the highest priority among the Outlines on it and its
// ancestors, the nearest on a tie; what it draws with rides in a per-slot array, so the visible
// entries stay plain slots that deform like any other draw (skinned meshes on any LOD level).

export const OUTLINE_SHADERS: Record<string, string> = {
  'shard::outline::mask': `
import shard::view::view;
import shard::mesh::{ mesh_vertex_at, visible, SLOT_MASK };

/** Per slot: style (bits 0–3), priority level (4–7), owner + 1 (8 up). */
@data @group(1) @binding(0) var<storage, read> outline_slots: array<u32>;

struct MaskVertex {
  @builtin(position) clip: vec4f,
  /** Style + 1, owner + 1, priority level. */
  @location(0) @interpolate(flat) id: vec4f,
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
  let word = outline_slots[visible[instance_index] & SLOT_MASK];
  out.id = vec4f(f32(word & 15u) + 1.0, f32(word >> 8u), f32((word >> 4u) & 15u), 0.0);
  return out;
}

/**
 * Style + 1 (0 where nothing is outlined), the surface's reversed-Z depth, owner + 1, and priority
 * level.
 */
@fragment fn fs(in: MaskVertex) -> @location(0) vec4f {
  return vec4f(in.id.x, in.clip.z, in.id.y, in.id.z);
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

/** Whether the outlined surface \`m\` at mask pixel p is in front of the scene there. */
fn seen_at(p: vec2i, m: vec4f) -> bool {
  let size = vec2i(textureDimensions(scene_depth));
  let q = clamp(vec2i((vec2f(p) + 0.5) * styles.scale.xy), vec2i(0), size - 1);
  // Reversed Z: nearer is larger. The mask draws unjittered, the scene may not: a little slack.
  return m.y >= textureLoad(scene_depth, q, 0) * 0.998 - 1e-7;
}

/** The mask at p, with what a hiding style hides cleared (so its seen part's edge seeds). */
fn mask_at(p: vec2i) -> vec4f {
  let m = textureLoad(source, p, 0);
  if (m.x < 0.5 || styles.params[u32(m.x) - 1u].y > 0.5 || seen_at(p, m)) { return m; }
  return vec4f(0.0);
}

/**
 * Seeds: the edge of each owner's silhouette, as (x, y, code, depth), code packing owner + 1,
 * priority level, style and whether it's seen. A pixel is on the edge where a neighbour is outside
 * every outlined silhouette, or another owner's lower in precedence (a lower priority, or the same
 * one farther away): rings draw over what's behind or below them. Parts something hides seed only
 * when their style shows or dims them.
 */
@fragment fn seed(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let m = mask_at(p);
  if (m.x < 0.5) { return NONE; }
  let size = vec2i(textureDimensions(source));
  var edge = false;
  for (var k = 0; k < 4; k++) {
    let q = p + select(vec2i(0, (k & 1) * 2 - 1), vec2i((k & 1) * 2 - 1, 0), k < 2);
    if (any(q < vec2i(0)) || any(q >= size)) { continue; }
    let o = mask_at(q);
    if (o.x < 0.5 || (o.z != m.z && (o.w < m.w || (o.w == m.w && o.y < m.y)))) { edge = true; }
  }
  if (!edge) { return NONE; }
  let style = u32(m.x) - 1u;
  let seen = seen_at(p, m);
  let code = m.z * 512.0 + m.w * 32.0 + f32(style) * 2.0 + select(0.0, 1.0, seen);
  return vec4f(frag.xy, code, m.y);
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

/**
 * The ring: pixels within their nearest seed's width, outside its owner's silhouette and any that
 * comes before it (a higher priority, or the same one nearer).
 */
@fragment fn composite(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let c = textureLoad(source, p, 0);
  if (c.z < 0.5) { discard; }
  let code = u32(c.z);
  let owner = f32(code >> 9u);
  let level = f32((code >> 5u) & 15u);
  let m = textureLoad(mask, p, 0);
  if (m.x > 0.5 && (m.z == owner || m.w > level || (m.w == level && m.y > c.w))) { discard; }
  let style = (code >> 1u) & 15u;
  let params = styles.params[style];
  let d = distance(frag.xy, c.xy);
  var a = clamp(params.x + 0.5 - d, 0.0, 1.0);
  if ((code & 1u) == 0u && params.y > 1.5) { a *= 0.35; }
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
/** Owners the mask tells apart: owner + 1 rides in 15 bits of the seeds' code. */
const MAX_OWNERS = 32766

/**
 * The Outline each outlined renderable takes this frame (0108), by slot: what the mask's vertex
 * stage reads (`outline_slots`), and the slots it draws.
 */
export interface OutlineSlotsValue {
  /** By slot: style | priority level << 4 | (owner + 1) << 8. */
  words: Uint32Array
  /** The slots that took an Outline, and the batch each draws in the mask. */
  slots: Int32Array
  batches: Int32Array
  count: number
  /** The lowest and highest slot written this frame. */
  lo: number
  hi: number
}

export const OutlineSlots = defineResource<OutlineSlotsValue>('render/OutlineSlots', {
  description: 'The Outline each outlined renderable takes this frame, by instance slot (0108).',
  init: () => ({
    words: new Uint32Array(64),
    slots: new Int32Array(64),
    batches: new Int32Array(64),
    count: 0,
    lo: 0,
    hi: -1,
  }),
})

/** Per slot, the winning Outline's priority and depth below it, and the frame that set them. */
let winPriority = new Int32Array(64)
let winDepth = new Int32Array(64)
let winStamp = new Uint32Array(64)
let stamp = 0

function ensureSlots(out: OutlineSlotsValue, n: number): void {
  if (n > winStamp.length) {
    let size = winStamp.length
    while (size < n) size *= 2
    const priority = new Int32Array(size)
    priority.set(winPriority)
    winPriority = priority
    const depth = new Int32Array(size)
    depth.set(winDepth)
    winDepth = depth
    const stamps = new Uint32Array(size)
    stamps.set(winStamp)
    winStamp = stamps
  }
  if (n > out.words.length) {
    let size = out.words.length
    while (size < n) size *= 2
    const words = new Uint32Array(size)
    words.set(out.words)
    out.words = words
  }
}

function wonSlot(out: OutlineSlotsValue, slot: number, batch: number): void {
  if (out.count >= out.slots.length) {
    const s = new Int32Array(out.slots.length * 2)
    s.set(out.slots)
    out.slots = s
    const b = new Int32Array(out.batches.length * 2)
    b.set(out.batches)
    out.batches = b
  }
  out.slots[out.count] = slot
  out.batches[out.count] = batch
  out.count++
  if (slot < out.lo) out.lo = slot
  if (slot > out.hi) out.hi = slot
}

/** Scratch for a view's mask: entries (slots) and their batches. */
let entries = new Uint32Array(64)
let entryBatches = new Int32Array(64)
let entryCount = 0

function push(slot: number, batch: number): void {
  if (entryCount >= entries.length) {
    const e = new Uint32Array(entries.length * 2)
    e.set(entries)
    entries = e
    const b = new Int32Array(entryBatches.length * 2)
    b.set(entryBatches)
    entryBatches = b
  }
  entries[entryCount] = slot
  entryBatches[entryCount] = batch
  entryCount++
}

/**
 * Offers an Outline (its mask word and priority) to an entity's renderable and its descendants':
 * each keeps the highest priority, and on a tie the Outline fewest levels up.
 */
function gather(
  world: World,
  out: OutlineSlotsValue,
  e: Entity,
  word: number,
  priority: number,
  depth: number,
  seen: Set<Entity>,
): void {
  if (seen.has(e) || !world.isAlive(e)) return
  seen.add(e)
  const store = world.resource(Instances)
  const slotData = world.tryGet(e, InstanceSlot)
  const slot = slotData ? slotData.slot - 1 : -1
  if (slot >= 0) {
    const a = store.batchOf[slot]!
    if (a !== -1) {
      ensureSlots(out, slot + 1)
      const fresh = winStamp[slot] !== stamp
      if (
        fresh ||
        priority > winPriority[slot]! ||
        (priority === winPriority[slot] && depth < winDepth[slot]!)
      ) {
        if (fresh) {
          winStamp[slot] = stamp
          wonSlot(out, slot, a >= 0 ? a : store.lodSets[-2 - a]!.batches[0]!)
        }
        winPriority[slot] = priority
        winDepth[slot] = depth
        out.words[slot] = word
      }
    }
  }
  const children = world.tryGet(e, Children)
  if (children)
    for (const child of children.entities)
      if (child !== null) gather(world, out, child, word, priority, depth + 1, seen)
}

/**
 * The index of an Outline's style in `styles` (its color at `c` in a color column), added if new;
 * past the cap, the last one.
 */
function styleOf(
  styles: Style[],
  pool: Style[],
  color: ArrayLike<number>,
  c: number,
  width: number,
  occluded: number,
): number {
  for (let i = 0; i < styles.length; i++) {
    const s = styles[i]!
    if (
      s.width === width &&
      s.occluded === occluded &&
      s.color[0] === color[c] &&
      s.color[1] === color[c + 1] &&
      s.color[2] === color[c + 2] &&
      s.color[3] === color[c + 3]
    ) {
      return i
    }
  }
  if (styles.length >= MAX_OUTLINE_STYLES) return MAX_OUTLINE_STYLES - 1
  // Styles are reused from frame to frame: `styles` only shrinks its length.
  const i = styles.length
  pool[i] ??= { color: [0, 0, 0, 0], width: 0, occluded: 0 }
  const s = pool[i]
  for (let k = 0; k < 4; k++) s.color[k] = color[c + k]!
  s.width = width
  s.occluded = occluded
  styles.push(s)
  return i
}

const ascending = (a: number, b: number) => a - b

/**
 * Settles which Outline each renderable takes, then gathers each camera view's outlined
 * renderables into its mask draws, after the forward queue (so this frame's visible lists are
 * open) and before the upload.
 */
export const queueOutlines = defineSystem({
  name: 'render/queue-outlines',
  description: 'Collects outlined renderables per view for the outline pass (0057).',
  setup: (world) => ({
    q: world.query({ with: [Outline] }),
    seen: new Set<Entity>(),
    live: new Set<string>(),
    styles: [] as Style[],
    pool: [] as Style[],
    priorities: [] as number[],
  }),
  run: ({ q, seen, live, styles, pool, priorities }, world) => {
    const views = world.resource(OutlineViews)
    const out = world.resource(OutlineSlots)
    out.count = 0
    out.lo = Number.POSITIVE_INFINITY
    out.hi = -1
    let any = 0
    for (const t of q.tables) any += t.count
    if (any === 0) {
      if (views.size > 0) {
        for (const v of views.values()) v.textures = destroyTextures(v.textures)
        views.clear()
      }
      return
    }
    // Priority levels: the distinct priorities in order, the highest past the cap sharing the top.
    priorities.length = 0
    for (const table of q.tables) {
      const p = table.column(Outline, 'priority')
      for (let row = 0; row < table.count; row++) {
        if (!priorities.includes(p[row]!)) priorities.push(p[row]!)
      }
    }
    priorities.sort(ascending)
    styles.length = 0
    stamp = (stamp + 1) >>> 0
    let owner = 0
    for (const table of q.tables) {
      const color = table.column(Outline, 'color')
      const width = table.column(Outline, 'width')
      const occluded = table.column(Outline, 'occluded')
      const priority = table.column(Outline, 'priority')
      for (let row = 0; row < table.count; row++) {
        const style = styleOf(styles, pool, color, row * 4, width[row]!, occluded[row]!)
        const p = priority[row]!
        const level = Math.min(priorities.indexOf(p), MAX_OUTLINE_PRIORITIES - 1)
        owner = owner >= MAX_OWNERS ? 1 : owner + 1
        seen.clear()
        gather(
          world,
          out,
          table.entities[row]! as Entity,
          style | (level << 4) | (owner << 8),
          p,
          0,
          seen,
        )
      }
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
          styles,
          count: 0,
          data: new Float32Array(STYLE_FLOATS),
          textures: undefined,
        }
        views.set(view.name, ov)
      }
      live.add(view.name)
      entryCount = 0
      for (let i = 0; i < out.count; i++) {
        const slot = out.slots[i]!
        const flags = store.u32[slot * INSTANCE_FLOATS + 13]!
        if ((flags & InstanceFlags.Visible) !== 0 && (store.layers[slot]! & cam.layers) !== 0)
          push(slot, out.batches[i]!)
      }
      ov.count = entryCount
      store.packEntries(ov.draws, entries, entryBatches, entryCount)
      // Uniforms: widths in target pixels, and the render / target scale for the scene depth.
      // A PixelPerfect camera outlines its low-resolution image, in texels.
      const d = ov.data
      d.fill(0)
      const ratio = outlinePixelRatio(cam)
      for (let i = 0; i < styles.length; i++) {
        const s = styles[i]!
        d.set(s.color, i * 4)
        d[MAX_OUTLINE_STYLES * 4 + i * 4] = s.width * ratio
        d[MAX_OUTLINE_STYLES * 4 + i * 4 + 1] = s.occluded
      }
      d[MAX_OUTLINE_STYLES * 8] = cam.pixelPerfect ? 1 : cam.width / Math.max(1, cam.displayWidth)
      d[MAX_OUTLINE_STYLES * 8 + 1] = cam.pixelPerfect
        ? 1
        : cam.height / Math.max(1, cam.displayHeight)
    }
    for (const [name, v] of views) {
      if (!live.has(name)) {
        v.textures = destroyTextures(v.textures)
        views.delete(name)
      }
    }
  },
})

/** Target pixels per CSS pixel of an outline's width: a texel on a PixelPerfect camera. */
function outlinePixelRatio(cam: CameraData): number {
  return cam.pixelPerfect ? 1 : cam.pixelRatio
}

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
    mask: make('mask', 'rgba32float'),
    depth: make('depth', 'depth32float'),
    a: make('flood-a', 'rgba32float'),
    b: make('flood-b', 'rgba32float'),
  }
  return ov.textures
}

/** The mask's group 1: the per-slot words (a data texture on baseline). */
function slotsLayout(gpu: GpuContext): GPUBindGroupLayout {
  return gpu.layouts.bindGroupLayout({
    label: 'outline/slots',
    entries: [dataEntry(gpu, 0, GPUShaderStage.VERTEX)],
  })
}

/**
 * The mask's pipeline: every outlined slot's style, depth, owner and priority level, through the
 * mesh vertex stage.
 */
function maskPipeline(world: World, gpu: GpuContext, cache: Map<number, GPURenderPipeline>) {
  const state = world.resource(ForwardStateResource)
  // Group 0 grows while interior lighting is on (0069): a pipeline per view layout.
  const key = gpu.generation * 2 + (state.interiorMode !== 0 ? 1 : 0)
  const cached = cache.get(key)
  if (cached) return cached
  const module = world.resource(Shaders).module(gpu, { root: 'shard::outline::mask' })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const store = world.resource(Instances)
  const pipeline = gpu.pipelines.render({
    label: 'outline/mask',
    layout: gpu.layouts.pipelineLayout({
      label: 'outline/mask',
      bindGroupLayouts: [state.layouts.view, slotsLayout(gpu), store.layout],
    }),
    vertex: { module, entryPoint: 'vs', buffers: VERTEX_BUFFERS },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
  })
  if (pipeline) cache.set(key, pipeline)
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
  // The per-slot words the mask reads (group 1), and their bind group.
  let slots: DataStore | undefined
  let slotsGen = -1
  let slotsGroup: GPUBindGroup | undefined
  let slotsBound = -1
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
            depthTex(gpu, 2),
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
      const words = ctx.world.resource(OutlineSlots)
      if (!slots || slotsGen !== gpu.generation) {
        slots = new DataStore(gpu, { label: 'outline/slots', size: words.words.byteLength })
        slotsGen = gpu.generation
        slotsBound = -1
      }
      slots.ensureCapacity(words.words.byteLength)
      if (words.hi >= words.lo) {
        slots.write(words.words, words.lo * 4, words.lo, words.hi - words.lo + 1)
      }
      if (!slotsGroup || slotsBound !== slots.version) {
        slotsGroup = gpu.device.createBindGroup({
          label: 'outline/slots',
          layout: slotsLayout(gpu),
          entries: [{ binding: 0, resource: slots.resource() }],
        })
        slotsBound = slots.version
      }
      pass.setBindGroup(1, slotsGroup)
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
      for (const s of ov.styles) widest = Math.max(widest, s.width * outlinePixelRatio(cam) + 1)
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
  provides: [OutlineViews, OutlineSlots],
  build(app) {
    app.insertResource(OutlinePath, { installed: true })
    app.world.initResource(OutlineViews)
    app.world.initResource(OutlineSlots)
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
