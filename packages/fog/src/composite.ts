import { GpuBuffer } from '@aethervtt/shard-gpu'
import {
  cameraOf,
  type NodeDescriptor,
  RenderPhase,
  type RenderView,
  Shaders,
  sceneColor,
} from '@aethervtt/shard-render'
import { FogSettings, MAX_FOG_LAYERS } from './components'
import type { FogState } from './masks'

// The composite (0058): after transparent objects and before the overlay band, each pixel's world
// XZ comes from depth (background pixels use the floor plane), every layer's mask is sampled there,
// and the pixel darkens toward the strongest layer's color by its value × opacity × the viewer's
// opacity. Fog is a column over each point of the map: a prop inside hidden fog is covered to its
// top, and the Map and Tabletop views show the same footprint.

/** Floats in the composite uniform (see `fog::composite`). */
const UNIFORM_FLOATS = 16 + 4 + 4 + 4 + MAX_FOG_LAYERS * 12

export const FOG_COMPOSITE_SHADERS: Record<string, string> = {
  'fog::composite': `
struct FogLayerGpu {
  /** min x, min z, 1 / width, 1 / depth of the extent. */
  extent: vec4f,
  /** Linear color (rgb) and opacity (a). */
  color: vec4f,
  /** x: the base outside the extent (1 hidden, 0 revealed). */
  params: vec4f,
}

struct Fog {
  inv_view_proj: mat4x4f,
  /** Camera position (xyz) and the floor height background pixels use (w). */
  camera: vec4f,
  /** Render width, height, and their reciprocals. */
  viewport: vec4f,
  /** x: layers, y: viewer opacity. */
  settings: vec4f,
  layers: array<FogLayerGpu, ${MAX_FOG_LAYERS}>,
}

@group(0) @binding(0) var<uniform> fog: Fog;
@group(0) @binding(1) var mask_sampler: sampler;
@group(0) @binding(2) var mask0: texture_2d<f32>;
@group(0) @binding(3) var mask1: texture_2d<f32>;
@group(0) @binding(4) var mask2: texture_2d<f32>;
@group(0) @binding(5) var mask3: texture_2d<f32>;
@if(MSAA) @group(0) @binding(6) var scene_depth: texture_depth_multisampled_2d;
@if(!MSAA) @group(0) @binding(6) var scene_depth: texture_depth_2d;

fn unproject(ndc: vec3f) -> vec3f {
  let h = fog.inv_view_proj * vec4f(ndc, 1.0);
  return h.xyz / h.w;
}

fn layer_value(i: u32, value: f32, xz: vec2f) -> f32 {
  let l = fog.layers[i];
  let uv = (xz - l.extent.xy) * l.extent.zw;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return l.params.x * l.color.a; }
  return value * l.color.a;
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(frag.xy);
  let depth = textureLoad(scene_depth, pixel, 0);
  let uv = frag.xy * fog.viewport.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  var xz: vec2f;
  if (depth > 0.0) {
    xz = unproject(vec3f(ndc, depth)).xz;
  } else {
    // Nothing drawn here: where the view ray meets the floor (reversed Z: 1 is near).
    let near = unproject(vec3f(ndc, 1.0));
    let dir = unproject(vec3f(ndc, 0.5)) - near;
    if (abs(dir.y) < 1e-6) { discard; }
    let t = (fog.camera.w - near.y) / dir.y;
    if (t < 0.0) { discard; }
    xz = (near + dir * t).xz;
  }
  let count = u32(fog.settings.x);
  // Every sample in uniform control flow; layers past the count add nothing.
  let s0 = textureSampleLevel(mask0, mask_sampler, (xz - fog.layers[0].extent.xy) * fog.layers[0].extent.zw, 0.0).r;
  let s1 = textureSampleLevel(mask1, mask_sampler, (xz - fog.layers[1].extent.xy) * fog.layers[1].extent.zw, 0.0).r;
  let s2 = textureSampleLevel(mask2, mask_sampler, (xz - fog.layers[2].extent.xy) * fog.layers[2].extent.zw, 0.0).r;
  let s3 = textureSampleLevel(mask3, mask_sampler, (xz - fog.layers[3].extent.xy) * fog.layers[3].extent.zw, 0.0).r;
  var strongest = 0.0;
  var color = vec3f(0.0);
  let values = array<f32, 4>(s0, s1, s2, s3);
  for (var i = 0u; i < ${MAX_FOG_LAYERS}u; i++) {
    if (i >= count) { break; }
    let d = layer_value(i, values[i], xz);
    if (d > strongest) {
      strongest = d;
      color = fog.layers[i].color.rgb;
    }
  }
  let a = clamp(strongest * fog.settings.y, 0.0, 1.0);
  if (a <= 0.0) { discard; }
  return vec4f(color, a);
}`,
}

/** Composite bind groups and uniforms per view; rebuilt after a device loss. */
interface ViewState {
  uniform: GpuBuffer
  group: GPUBindGroup | undefined
  /** What the group binds: the uniform version, depth, the four masks, and the MSAA layout. */
  bound: unknown[]
}

const uniformData = new Float32Array(UNIFORM_FLOATS)

export function compositeNode(state: FogState): NodeDescriptor {
  const views = new Map<string, ViewState>()
  let generation = -1
  let layout: GPUBindGroupLayout | undefined
  let layoutMsaa: GPUBindGroupLayout | undefined
  let sampler: GPUSampler | undefined
  let empty: GPUTexture | undefined
  const pipelines = new Map<string, GPURenderPipeline>()
  return {
    kind: 'render',
    phase: RenderPhase.Fog,
    enabled: (view: RenderView) => cameraOf(view) !== undefined && state.active.length > 0,
    reads: ['scene-depth'],
    writes: ['scene-color', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      if (!cam || state.active.length === 0) return
      const gpu = ctx.gpu
      if (generation !== gpu.generation) {
        generation = gpu.generation
        views.clear()
        pipelines.clear()
        const entries = (msaa: boolean): GPUBindGroupLayoutEntry[] => [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          ...[2, 3, 4, 5].map((binding) => ({
            binding,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'float' as const },
          })),
          {
            binding: 6,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'depth', multisampled: msaa },
          },
        ]
        layout = gpu.layouts.bindGroupLayout({ label: 'fog/composite', entries: entries(false) })
        layoutMsaa = gpu.layouts.bindGroupLayout({
          label: 'fog/composite-msaa',
          entries: entries(true),
        })
        sampler = gpu.layouts.sampler({
          label: 'fog/mask',
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        })
        empty = gpu.device.createTexture({
          label: 'fog/empty-mask',
          size: [1, 1],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        })
      }
      const msaa = cam.msaa > 1
      const alpha = cam.alphaOutput
      const key = `${msaa ? 'msaa' : 'single'}/${alpha ? 'alpha' : 'opaque'}`
      let pipeline = pipelines.get(key)
      if (!pipeline) {
        const shaders = ctx.world.resource(Shaders)
        const fs = shaders.module(gpu, { root: 'fog::composite', defines: { MSAA: msaa } })
        const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
        if (!fs || !vs) {
          gpu.pipelines.skipped++
          return
        }
        pipeline = gpu.pipelines.render({
          label: `fog/composite/${key}`,
          layout: gpu.layouts.pipelineLayout({
            label: 'fog/composite',
            bindGroupLayouts: [msaa ? layoutMsaa! : layout!],
          }),
          vertex: { module: vs, entryPoint: 'vs' },
          fragment: {
            module: fs,
            entryPoint: 'fs',
            targets: [
              {
                format: 'rgba16float',
                blend: {
                  color: {
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                  // A transparent view (0052) becomes as opaque as its fog.
                  alpha: alpha
                    ? { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    : { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                },
              },
            ],
          },
          multisample: { count: cam.msaa },
        })
        if (!pipeline) return
        pipelines.set(key, pipeline)
      }
      let v = views.get(ctx.view.name)
      if (!v) {
        v = {
          uniform: new GpuBuffer(gpu, {
            label: 'fog/composite',
            usage: GPUBufferUsage.UNIFORM,
            size: UNIFORM_FLOATS * 4,
          }),
          group: undefined,
          bound: [-1, undefined, undefined, undefined, undefined, undefined, false],
        }
        views.set(ctx.view.name, v)
      }
      writeUniform(ctx.world, state, cam)
      v.uniform.write(uniformData)
      const depth = ctx.texture('scene-depth')
      const layers = state.active
      const b = v.bound
      let stale = b[0] !== v.uniform.version || b[1] !== depth || b[6] !== msaa
      for (let i = 0; i < 4; i++) if (b[2 + i] !== (layers[i]?.texture ?? empty)) stale = true
      if (stale) {
        b[0] = v.uniform.version
        b[1] = depth
        b[6] = msaa
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: v.uniform.buffer } },
          { binding: 1, resource: sampler! },
          { binding: 6, resource: depth.createView() },
        ]
        for (let i = 0; i < 4; i++) {
          const mask = layers[i]?.texture ?? empty!
          b[2 + i] = mask
          entries.push({ binding: 2 + i, resource: mask.createView() })
        }
        v.group = gpu.device.createBindGroup({
          label: 'fog/composite',
          layout: msaa ? layoutMsaa! : layout!,
          entries,
        })
      }
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, v.group!)
      pass.draw(3)
    },
  }
}

function writeUniform(
  world: import('@aethervtt/shard-core').World,
  state: FogState,
  cam: NonNullable<ReturnType<typeof cameraOf>>,
): void {
  const settings = world.resource(FogSettings)
  const u = uniformData
  u.set(cam.invViewProj, 0)
  u[16] = cam.position[0]!
  u[17] = cam.position[1]!
  u[18] = cam.position[2]!
  u[19] = settings.floor
  u[20] = cam.width
  u[21] = cam.height
  u[22] = 1 / cam.width
  u[23] = 1 / cam.height
  const count = Math.min(MAX_FOG_LAYERS, state.active.length)
  u[24] = count
  u[25] = settings.viewerOpacity
  u[26] = 0
  u[27] = 0
  for (let i = 0; i < MAX_FOG_LAYERS; i++) {
    const o = 28 + i * 12
    const layer = state.active[i]
    if (!layer) {
      u.fill(0, o, o + 12)
      continue
    }
    const e = layer.extent
    u[o] = e[0]
    u[o + 1] = e[1]
    u[o + 2] = 1 / (e[2] - e[0])
    u[o + 3] = 1 / (e[3] - e[1])
    u[o + 4] = layer.color[0]!
    u[o + 5] = layer.color[1]!
    u[o + 6] = layer.color[2]!
    u[o + 7] = layer.opacity
    u[o + 8] = layer.base === 'hidden' ? 1 : 0
    u[o + 9] = 0
    u[o + 10] = 0
    u[o + 11] = 0
  }
}
