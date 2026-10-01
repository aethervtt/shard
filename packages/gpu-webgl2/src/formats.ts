import { GL } from './gl'

// WebGPU texture formats as WebGL2 stores them. `kind` says how a shader reads the texture (and so
// its sampler and filtering), `renderable` whether it can be an attachment (float formats need
// EXT_color_buffer_float), `compressed` the extension family that must be complete.

export type FormatKind = 'float' | 'unfilterable-float' | 'uint' | 'sint' | 'depth' | 'stencil'

export interface GlFormat {
  internal: number
  /** Pixel format and type for uploads and reads (uncompressed). */
  format: number
  type: number
  /** Bytes per texel, or per 4×4 block when compressed. */
  bytes: number
  /** Texels a block covers per side (4 when compressed). */
  block: number
  kind: FormatKind
  /** Renderable without extensions (true), with EXT_color_buffer_float ('float'), or never. */
  renderable: boolean | 'float'
  /** Linear filtering needs OES_texture_float_linear. */
  float32?: boolean
  depth?: boolean
  stencil?: boolean
  srgb?: boolean
  /** Components: 1 to 4. */
  components: number
  compressed?: 'bc' | 'astc' | 'etc2'
}

const f = (
  internal: number,
  format: number,
  type: number,
  bytes: number,
  kind: FormatKind,
  renderable: GlFormat['renderable'],
  components: number,
  extra: Partial<GlFormat> = {},
): GlFormat => ({ internal, format, type, bytes, block: 1, kind, renderable, components, ...extra })

const compressed = (
  internal: number,
  family: GlFormat['compressed'],
  extra: Partial<GlFormat> = {},
) =>
  ({
    internal,
    format: 0,
    type: 0,
    bytes: 16,
    block: 4,
    kind: 'float',
    renderable: false,
    components: 4,
    compressed: family,
    ...extra,
  }) satisfies GlFormat

export const FORMATS: Readonly<Record<string, GlFormat>> = {
  r8unorm: f(GL.R8, GL.RED, GL.UNSIGNED_BYTE, 1, 'float', true, 1),
  rg8unorm: f(GL.RG8, GL.RG, GL.UNSIGNED_BYTE, 2, 'float', true, 2),
  rgba8unorm: f(GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 4, 'float', true, 4),
  'rgba8unorm-srgb': f(GL.SRGB8_ALPHA8, GL.RGBA, GL.UNSIGNED_BYTE, 4, 'float', true, 4, {
    srgb: true,
  }),
  rgb10a2unorm: f(GL.RGB10_A2, GL.RGBA, GL.UNSIGNED_INT_2_10_10_10_REV, 4, 'float', true, 4),
  r16float: f(GL.R16F, GL.RED, GL.HALF_FLOAT, 2, 'float', 'float', 1),
  rg16float: f(GL.RG16F, GL.RG, GL.HALF_FLOAT, 4, 'float', 'float', 2),
  rgba16float: f(GL.RGBA16F, GL.RGBA, GL.HALF_FLOAT, 8, 'float', 'float', 4),
  r32float: f(GL.R32F, GL.RED, GL.FLOAT, 4, 'unfilterable-float', 'float', 1, { float32: true }),
  rg32float: f(GL.RG32F, GL.RG, GL.FLOAT, 8, 'unfilterable-float', 'float', 2, { float32: true }),
  rgba32float: f(GL.RGBA32F, GL.RGBA, GL.FLOAT, 16, 'unfilterable-float', 'float', 4, {
    float32: true,
  }),
  rg11b10ufloat: f(
    GL.R11F_G11F_B10F,
    GL.RGB,
    GL.UNSIGNED_INT_10F_11F_11F_REV,
    4,
    'float',
    'float',
    3,
  ),
  r8uint: f(GL.R8UI, GL.RED_INTEGER, GL.UNSIGNED_BYTE, 1, 'uint', true, 1),
  rgba8uint: f(GL.RGBA8UI, GL.RGBA_INTEGER, GL.UNSIGNED_BYTE, 4, 'uint', true, 4),
  r16uint: f(GL.R16UI, GL.RED_INTEGER, GL.UNSIGNED_SHORT, 2, 'uint', true, 1),
  r32uint: f(GL.R32UI, GL.RED_INTEGER, GL.UNSIGNED_INT, 4, 'uint', true, 1),
  rg32uint: f(GL.RG32UI, GL.RG_INTEGER, GL.UNSIGNED_INT, 8, 'uint', true, 2),
  rgba32uint: f(GL.RGBA32UI, GL.RGBA_INTEGER, GL.UNSIGNED_INT, 16, 'uint', true, 4),
  depth16unorm: f(
    GL.DEPTH_COMPONENT16,
    GL.DEPTH_COMPONENT,
    GL.UNSIGNED_SHORT,
    2,
    'depth',
    true,
    1,
    {
      depth: true,
    },
  ),
  depth24plus: f(GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, 4, 'depth', true, 1, {
    depth: true,
  }),
  depth32float: f(GL.DEPTH_COMPONENT32F, GL.DEPTH_COMPONENT, GL.FLOAT, 4, 'depth', true, 1, {
    depth: true,
  }),
  'depth24plus-stencil8': f(
    GL.DEPTH24_STENCIL8,
    GL.DEPTH_STENCIL,
    GL.UNSIGNED_INT_24_8,
    4,
    'depth',
    true,
    1,
    {
      depth: true,
      stencil: true,
    },
  ),
  'depth32float-stencil8': f(
    GL.DEPTH32F_STENCIL8,
    GL.DEPTH_STENCIL,
    GL.FLOAT_32_UNSIGNED_INT_24_8_REV,
    8,
    'depth',
    true,
    1,
    { depth: true, stencil: true },
  ),
  // Only as an attachment (a renderbuffer): WebGL2 can't sample stencil.
  stencil8: f(GL.STENCIL_INDEX8, 0, 0, 1, 'stencil', true, 1, { stencil: true }),
  'bc5-rg-unorm': compressed(0x8dbd, 'bc', { components: 2 }),
  'bc7-rgba-unorm': compressed(0x8e8c, 'bc'),
  'bc7-rgba-unorm-srgb': compressed(0x8e8d, 'bc', { srgb: true }),
  'astc-4x4-unorm': compressed(0x93b0, 'astc'),
  'astc-4x4-unorm-srgb': compressed(0x93d0, 'astc', { srgb: true }),
  'etc2-rgba8unorm': compressed(0x9278, 'etc2'),
  'etc2-rgba8unorm-srgb': compressed(0x9279, 'etc2', { srgb: true }),
  'eac-rg11unorm': compressed(0x9272, 'etc2', { components: 2 }),
}

/** The format, or an error naming it: the shim only has what the engine uses. */
export function formatOf(name: string): GlFormat {
  const format = FORMATS[name]
  if (!format) throw new Error(`gpu-webgl2/unsupported: the texture format "${name}"`)
  return format
}
