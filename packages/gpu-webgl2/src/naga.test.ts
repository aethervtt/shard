import { describe, expect, it } from 'vitest'
import { loadNaga } from './naga'

const SHADER = `
struct View { view_proj: mat4x4f, tint: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var albedo: texture_2d<f32>;
@group(1) @binding(1) var albedo_sampler: sampler;
@group(2) @binding(0) var data: texture_2d<u32>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat, either) id: u32,
}

@vertex fn vs(@builtin(instance_index) i: u32, @location(0) position: vec3f) -> Out {
  var out: Out;
  out.clip = view.view_proj * vec4f(position, 1.0);
  out.uv = position.xy;
  out.id = textureLoad(data, vec2i(i32(i), 0), 0).x;
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  return textureSample(albedo, albedo_sampler, in.uv) * view.tint + f32(in.id);
}
`

describe('naga (0064)', () => {
  it('translates both stages to GLSL ES 3.00 with the bindings the shim needs', async () => {
    const naga = await loadNaga()
    expect(naga.version).toBe('30.0.1')
    const vs = naga.translate(SHADER, 'vs', 'vertex', { clipControl: false })
    expect(vs.glsl.startsWith('#version 300 es')).toBe(true)
    // WebGPU's clip space: y flipped, z mapped from [0, 1] to GL's [-1, 1].
    expect(vs.glsl).toContain(
      'gl_Position.yz = vec2(-gl_Position.y, gl_Position.z * 2.0 - gl_Position.w);',
    )
    // The draw's first instance comes in through a uniform.
    expect(vs.firstInstance).toBe(true)
    expect(vs.uniforms).toEqual([
      { name: expect.stringContaining('View_block'), group: 0, binding: 0 },
    ])
    // texelFetch needs no sampler.
    expect(vs.textures).toEqual([{ name: expect.any(String), group: 2, binding: 0, sampler: null }])
    const fs = naga.translate(SHADER, 'fs', 'fragment', { clipControl: false })
    expect(fs.firstInstance).toBe(false)
    expect(fs.textures).toEqual([
      { name: expect.any(String), group: 1, binding: 0, sampler: [1, 1] },
    ])
  })

  it('only flips y when EXT_clip_control keeps depth in [0, 1]', async () => {
    const naga = await loadNaga()
    const vs = naga.translate(SHADER, 'vs', 'vertex', { clipControl: true })
    expect(vs.glsl).toContain('gl_Position.y = -gl_Position.y;')
    expect(vs.glsl).not.toContain('gl_Position.z * 2.0')
  })

  it('names the line of a WGSL error, refuses what ES 3.00 lacks, and survives either', async () => {
    const naga = await loadNaga()
    expect(() => naga.translate('fn broken( {', 'vs', 'vertex', { clipControl: false })).toThrow(
      expect.objectContaining({
        code: 'gpu-webgl2/translate',
        message: expect.stringContaining(':1:'),
      }),
    )
    const storage = `@group(0) @binding(0) var<storage, read> things: array<vec4f>;
@fragment fn fs() -> @location(0) vec4f { return things[0]; }`
    expect(() => naga.translate(storage, 'fs', 'fragment', { clipControl: false })).toThrow(
      expect.objectContaining({ code: 'gpu-webgl2/translate' }),
    )
    // Still answers afterwards.
    expect(naga.translate(SHADER, 'fs', 'fragment', { clipControl: false }).glsl).toContain(
      '#version 300 es',
    )
  })
})
