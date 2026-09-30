import { defineResource, defineSystem, type Entity, Last, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { definePlugin } from '@aethervtt/shard-runtime'
import { type NodeDescriptor, RenderPhase } from './graph'
import { Lens, LensFields, LensPath, MAX_LENS_FIELDS } from './lens'
import { Graph, RenderDescribers, RenderSet, Shaders, Views } from './plugin'
import { beginPass, idOf, PostCache, tex, uniform } from './post-common'
import { registerShaders } from './shaders'
import { cameraOf, extractCameras } from './view'

/** The largest lens target, in pixels: the bound of Aether's ADR-0098. */
export const MAX_LENS_PIXELS = 2_097_152

export const LENS_SHADERS: Record<string, string> = {
  'shard::post::lens': `
struct Lens {
  /** The copied region of the target: origin (xy) and size (zw), in pixels. */
  region: vec4f,
  /** x: how many fields. */
  count: vec4f,
  /** Center (xy) and radius (z) in target pixels, strength (w). */
  fields: array<vec4f, 4>,
}

@group(0) @binding(0) var region_copy: texture_2d<f32>;
@group(0) @binding(1) var<uniform> lens: Lens;

fn texel(p: vec2f) -> vec4f {
  let last = vec2i(lens.region.zw) - 1;
  return textureLoad(region_copy, clamp(vec2i(p), vec2i(0), last), 0);
}

/** Bilinear between the copy's texel centers, clamped to its edge; exact on a center. */
fn sample_copy(p: vec2f) -> vec4f {
  let q = p - lens.region.xy - 0.5;
  let base = floor(q);
  let t = q - base;
  let top = mix(texel(base), texel(base + vec2f(1.0, 0.0)), t.x);
  let bottom = mix(texel(base + vec2f(0.0, 1.0)), texel(base + vec2f(1.0, 1.0)), t.x);
  return mix(top, bottom, t.y);
}

/** Inside a field, the view's own pixels at displaced coordinates; outside every field, nothing. */
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  var offset = vec2f(0.0);
  var inside = false;
  let n = u32(lens.count.x);
  for (var i = 0u; i < n; i++) {
    let f = lens.fields[i];
    let d = frag.xy - f.xy;
    let u = length(d) / f.z;
    if (u < 1.0) {
      inside = true;
      // Distance u samples from u (1 - s (1 - u)²): unchanged at the rim, never outside it.
      let k = 1.0 - u;
      offset -= d * (f.w * k * k);
    }
  }
  if (!inside) { discard; }
  return sample_copy(frag.xy + offset);
}`,
}

/** A Lens view's fields this frame, in its target's pixels, and the texture they bend from. */
export interface LensView {
  /** The view's name last frame. */
  view: string
  /** Fields that intersect the view. */
  count: number
  /** The pass's uniforms: region (4), count (4), then center x, y, radius, strength per field. */
  params: Float32Array
  /** The source of each field. */
  sources: Float64Array
  /** Target pixels per CSS pixel. */
  pixelRatio: number
  /** Cut down to MAX_LENS_PIXELS: the fields' bounds were larger. */
  clipped: boolean
  /** The copy of the region, while a field intersects the view. */
  texture: GPUTexture | undefined
  generation: number
  /** post/lens ran for the view last frame. */
  ran: boolean
  seen: number
}

export const LensViews = defineResource<Map<Entity, LensView>>('render/LensViews', {
  description: "Lens cameras' fields in target pixels and their lens targets, by camera entity.",
  init: () => new Map(),
})

const clamp1 = (s: number) => (Number.isNaN(s) ? 0 : Math.min(1, Math.max(-1, s)))

let frame = 0

/** Releases the lens target of a camera that stopped rendering with Lens. */
function releaseUnseen(state: LensView, entity: Entity, map: Map<Entity, LensView>): void {
  if (state.seen === frame) return
  state.texture?.destroy()
  map.delete(entity)
}

export const extractLens = defineSystem({
  name: 'render/extract-lens',
  description:
    "Maps live LensFields into each Lens view's pixels, and sizes or releases its lens target.",
  run: (_, world) => {
    frame++
    const views = world.resource(Views).list
    const fields = world.resource(LensFields).fields
    const states = world.resource(LensViews)
    for (let v = 0; v < views.length; v++) {
      const view = views[v]!
      const cam = cameraOf(view)
      // PixelPerfect cameras draw a low-resolution image: not bent (spec 0063).
      if (!cam || cam.pixelPerfect || !world.has(cam.entity, Lens)) continue
      let s = states.get(cam.entity)
      if (!s) {
        s = {
          view: view.name,
          count: 0,
          params: new Float32Array(8 + 4 * MAX_LENS_FIELDS),
          sources: new Float64Array(MAX_LENS_FIELDS),
          pixelRatio: 1,
          clipped: false,
          texture: undefined,
          generation: -1,
          ran: false,
          seen: 0,
        }
        states.set(cam.entity, s)
      }
      s.seen = frame
      s.view = view.name
      s.ran = false
      s.clipped = false
      const width = cam.displayWidth
      const height = cam.displayHeight
      const ratio = cam.pixelRatio
      s.pixelRatio = ratio
      const p = s.params
      let count = 0
      let x0 = width
      let y0 = height
      let x1 = 0
      let y1 = 0
      for (let i = 0; i < fields.length && count < MAX_LENS_FIELDS; i++) {
        const f = fields[i]!
        const cx = f.screen[0] * ratio
        const cy = f.screen[1] * ratio
        const r = f.radius * ratio
        if (!(r > 0) || !Number.isFinite(r + cx + cy)) continue
        const fx0 = Math.max(0, Math.floor(cx - r))
        const fy0 = Math.max(0, Math.floor(cy - r))
        const fx1 = Math.min(width, Math.ceil(cx + r))
        const fy1 = Math.min(height, Math.ceil(cy + r))
        if (fx0 >= fx1 || fy0 >= fy1) continue
        const o = 8 + count * 4
        p[o] = cx
        p[o + 1] = cy
        p[o + 2] = r
        p[o + 3] = clamp1(f.strength)
        s.sources[count] = f.source
        count++
        if (fx0 < x0) x0 = fx0
        if (fy0 < y0) y0 = fy0
        if (fx1 > x1) x1 = fx1
        if (fy1 > y1) y1 = fy1
      }
      s.count = count
      p[4] = count
      if (count === 0) {
        // Nothing to bend: the pass leaves the graph and its target is released.
        s.texture?.destroy()
        s.texture = undefined
        continue
      }
      let w = x1 - x0
      let h = y1 - y0
      if (w * h > MAX_LENS_PIXELS) {
        // Cut down around the middle; pixels outside the region stay unbent.
        const k = Math.sqrt(MAX_LENS_PIXELS / (w * h))
        const cw = Math.max(1, Math.floor(w * k))
        const ch = Math.max(1, Math.floor(h * k))
        x0 = Math.min(width - cw, Math.max(0, Math.round(x0 + (w - cw) / 2)))
        y0 = Math.min(height - ch, Math.max(0, Math.round(y0 + (h - ch) / 2)))
        w = cw
        h = ch
        s.clipped = true
      }
      p[0] = x0
      p[1] = y0
      p[2] = w
      p[3] = h
    }
    states.forEach(releaseUnseen)
  },
})

/** The view's lens target: at least the region, grown in place up to MAX_LENS_PIXELS. */
function lensTexture(gpu: GpuContext, s: LensView, format: GPUTextureFormat): GPUTexture {
  const w = s.params[2]!
  const h = s.params[3]!
  let t = s.texture
  if (t && s.generation === gpu.generation && t.format === format) {
    if (t.width >= w && t.height >= h) return t
  } else t = undefined
  let tw = Math.max(w, t?.width ?? 0)
  let th = Math.max(h, t?.height ?? 0)
  if (tw * th > MAX_LENS_PIXELS) {
    tw = w
    th = h
  }
  s.texture?.destroy()
  s.generation = gpu.generation
  s.texture = gpu.device.createTexture({
    label: `${s.view}/lens`,
    size: [tw, th],
    format,
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
  return s.texture
}

/**
 * post/lens: copies the fields' region of the finished view target, then draws it back displaced,
 * scissored to the region and discarding outside every field, so no other pixel is written.
 */
function lensNode(states: Map<Entity, LensView>): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  return {
    kind: 'raw',
    // After the display stage wrote the target (tonemap, FXAA, upscale), before overlays.
    phase: RenderPhase.Display + 20,
    enabled: (view) => {
      const cam = cameraOf(view)
      return cam !== undefined && (states.get(cam.entity)?.count ?? 0) > 0
    },
    writes: ['view-target'],
    run: (ctx) => {
      const gpu = ctx.gpu
      const s = states.get(cameraOf(ctx.view)!.entity)!
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'lens',
          entries: [tex(0, 'unfilterable-float'), uniform(1)],
        })
      }
      const target = ctx.texture('view-target')
      const format = target.format
      const pipeline = cache.render(
        ctx,
        `lens/${format}`,
        'shard::post::lens',
        'fs',
        [layout],
        [{ format }],
      )
      if (!pipeline) return
      const copy = lensTexture(gpu, s, format)
      const p = s.params
      const x = p[0]!
      const y = p[1]!
      const w = p[2]!
      const h = p[3]!
      ctx.encoder.copyTextureToTexture(
        { texture: target, origin: { x, y } },
        { texture: copy },
        { width: w, height: h },
      )
      const params = cache.buffer(gpu, `${ctx.view.name}/lens`, p.byteLength)
      params.write(p)
      const group = cache.group(
        gpu,
        `${ctx.view.name}/lens`,
        `${idOf(copy)}/${params.version}`,
        layout,
        () => [
          { binding: 0, resource: copy.createView() },
          { binding: 1, resource: { buffer: params.buffer } },
        ],
      )
      const pass = beginPass(ctx, 'post/lens', target.createView(), true)
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.setScissorRect(x, y, w, h)
      pass.draw(3)
      pass.end()
      s.ran = true
    },
  }
}

/** render.describe's lens section: live fields, and per Lens view what it bent and at what size. */
export function describeLens(world: World) {
  const views: Record<string, unknown> = {}
  world.resource(LensViews).forEach((s) => {
    const fields = []
    for (let i = 0; i < s.count; i++) {
      const o = 8 + i * 4
      fields.push({
        source: s.sources[i],
        screen: [s.params[o]! / s.pixelRatio, s.params[o + 1]! / s.pixelRatio],
        radius: s.params[o + 2]! / s.pixelRatio,
        strength: s.params[o + 3],
      })
    }
    views[s.view] = {
      fields,
      ran: s.ran,
      region: s.count > 0 ? [...s.params.subarray(0, 4)] : null,
      target: s.texture ? [s.texture.width, s.texture.height] : null,
      clipped: s.clipped,
    }
  })
  return { fields: world.resource(LensFields).fields.map((f) => ({ ...f })), views }
}

/**
 * Screen-space lens fields (spec 0063): cameras with Lens bend their own pixels inside the live
 * LensFields, in a post pass that isn't in the graph while no field is.
 */
export const lensPlugin = definePlugin({
  name: 'render/lens',
  dependencies: ['render/forward'],
  provides: [LensViews],
  build(app) {
    app.insertResource(LensPath, { installed: true })
    app.world.initResource(LensViews)
    app.addSystems(Last, extractLens.inSet(RenderSet.Extract).after(extractCameras))
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), LENS_SHADERS)
    app.world.initResource(RenderDescribers).set('lens', describeLens)
    app.world.resource(Graph).addNode('post/lens', lensNode(app.world.resource(LensViews)))
  },
})
