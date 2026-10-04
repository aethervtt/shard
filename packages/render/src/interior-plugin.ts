import { defineResource, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { GpuBuffer } from '@aethervtt/shard-gpu'
import { definePlugin } from '@aethervtt/shard-runtime'
import { addRenderFeatures } from './features'
import {
  INTERIOR_BINDINGS,
  INTERIOR_BLOCKED,
  INTERIOR_SKY,
  InteriorPath,
  type InteriorSupport,
} from './interior'
import { Gpu, RenderDescribers, Shaders } from './plugin'
import { registerShaders } from './shaders'
import { bindingDimension } from './tier'

// Interior lighting (0069), render's half: the sky visibility field, the wall-blocked lights' polar
// rows and a level table, bound at group 0 while a part is on, and the WGSL the lighting stage
// links through SKY_VISIBILITY and BLOCKED_LIGHTS. Structure's interiorLightingPlugin fills them
// from the plan. Field and rows share one r32uint array, two 16-bit halves a texel, read with
// textureLoad (the WebGL2 shim has no rg16uint, and integer loads read the same everywhere).

/** Level table entries; entry `INTERIOR_GROUND` is the ground level's (pieces with no Level). */
export const INTERIOR_LEVELS = 8
export const INTERIOR_GROUND = INTERIOR_LEVELS

/** Floats in the table: field, size, rows, then INTERIOR_LEVELS + 1 levels and ambients. */
const TABLE_FLOATS = 12 + (INTERIOR_LEVELS + 1) * 8
const LEVELS_AT = 12
const AMBIENT_AT = 12 + (INTERIOR_LEVELS + 1) * 4

/** A field texel's cover code: 0 uncovered, else 32768 + 64 × (cover top y − the layer's base). */
export const COVER_SCALE = 64
export const COVER_ZERO = 32768
/** Visibility, in a field texel's low 16 bits above the two link bits. */
export const VISIBILITY_MAX = 16383
/** A field texel's link bits: flux to the +x and +z neighbours is blocked. */
export const LINK_X = 1
export const LINK_Z = 2
/** A row bin: distance (low 16 bits) and the barrier's top relative to the light (high), in 1/256 m. */
export const ROW_SCALE = 256
export const ROW_ZERO = 32768
/** A bin with no barrier: the low half all ones (256 m, past any range). */
export const ROW_CLEAR = 0x8000ffff

export const INTERIOR_SHADERS: Record<string, string> = {
  'shard::interior': `
import shard::pbr::lights::{ Light, LIGHT_SPOT };

struct Interior {
  /** The field's origin (x, z, m), 1 / texel, and how many levels the table holds. */
  field: vec4f,
  /** The field's size (texels x, z), bins per light row, filter taps. */
  size: vec4f,
  /** Where rows start: after the field's layers (x), \`y\` rows to a layer. */
  rows: vec4f,
  /**
   * Levels by elevation: floor y, top y, field layer, the y cover heights count from. Entry 8 is
   * the ground level's, for any y no level holds.
   */
  levels: array<vec4f, 9>,
  /** Per entry: interior ambient (rgb, cd/m²), and the share of the sky's ambient kept indoors. */
  ambient: array<vec4f, 9>,
}

/** The field's layers, then the light rows. */
@group(0) @binding(16) var interior_data: texture_2d_array<u32>;
@group(0) @binding(17) var<uniform> interior: Interior;

const INTERIOR_GROUND: u32 = 8u;
/** How far a blocked light's receiver moves off its surface, so each face reads its own side. */
const INTERIOR_OFFSET: f32 = 0.05;

/** The table entry whose [floor, top) holds y, or the ground level's. */
fn interior_level(y: f32) -> u32 {
  let count = u32(interior.field.w);
  for (var i = 0u; i < count; i++) {
    let e = interior.levels[i];
    if (y >= e.x && y < e.y) { return i; }
  }
  return INTERIOR_GROUND;
}

fn interior_visibility(texel: u32) -> f32 {
  return f32((texel & 0xffffu) >> 2u) / ${VISIBILITY_MAX}.0;
}

/**
 * Sky visibility at a point on a surface: 1 outdoors (outside the field, on an uncovered texel, or
 * above its cover), else the field, filtered between the texel centres the point reaches without
 * crossing a barrier, so light never bleeds through a wall. The point moves a texel along the
 * normal first: a wall's inside face reads the room, not the outdoor texel next to it.
 */
fn sky_visibility(world: vec3f, n: vec3f, level: u32) -> f32 {
  let p = world + n / interior.field.z;
  let entry = interior.levels[level];
  let size = vec2i(interior.size.xy);
  let t = (p.xz - interior.field.xy) * interior.field.z - 0.5;
  let home = vec2i(floor(t + 0.5));
  if (any(home < vec2i(0)) || any(home >= size)) { return 1.0; }
  let layer = i32(entry.z);
  let own = textureLoad(interior_data, home, layer, 0).r;
  let cover = own >> 16u;
  if (cover == 0u) { return 1.0; }
  if (p.y >= entry.w + (f32(cover) - ${COVER_ZERO}.0) / ${COVER_SCALE}.0) { return 1.0; }
  // One filter tap (quality low): the texel alone.
  if (interior.size.w < 1.5) { return interior_visibility(own); }
  let f = t - floor(t);
  let i0 = clamp(vec2i(floor(t)), vec2i(0), size - 1);
  let i1 = min(i0 + 1, size - 1);
  let a = textureLoad(interior_data, i0, layer, 0).r;
  let b = textureLoad(interior_data, vec2i(i1.x, i0.y), layer, 0).r;
  let c = textureLoad(interior_data, vec2i(i0.x, i1.y), layer, 0).r;
  let d = textureLoad(interior_data, i1, layer, 0).r;
  let hx = f.x >= 0.5;
  let hz = f.y >= 0.5;
  // Open links: along x on rows 0 and 1, along z on columns 0 and 1.
  let ab = (a & ${LINK_X}u) == 0u;
  let cd = (c & ${LINK_X}u) == 0u;
  let ac = (a & ${LINK_Z}u) == 0u;
  let bd = (b & ${LINK_Z}u) == 0u;
  let x_home = select(ab, cd, hz);
  let x_other = select(cd, ab, hz);
  let z_home = select(ac, bd, hx);
  let z_other = select(bd, ac, hx);
  let across = select(0.0, 1.0, x_home);
  let along = select(0.0, 1.0, z_home);
  let diagonal = select(0.0, 1.0, (x_home && z_other) || (z_home && x_other));
  // Weights of the home texel, its row neighbour, its column neighbour, and the diagonal one.
  let wx = select(f.x, 1.0 - f.x, hx);
  let wz = select(f.y, 1.0 - f.y, hz);
  let w_home = (1.0 - wx) * (1.0 - wz);
  let w_row = wx * (1.0 - wz) * across;
  let w_col = (1.0 - wx) * wz * along;
  let w_diag = wx * wz * diagonal;
  let row = select(select(b, a, hx), select(d, c, hx), hz);
  let col = select(select(c, d, hx), select(a, b, hx), hz);
  let diag = select(select(d, c, hx), select(b, a, hx), hz);
  let sum = w_home * interior_visibility(own) + w_row * interior_visibility(row)
    + w_col * interior_visibility(col) + w_diag * interior_visibility(diag);
  return sum / (w_home + w_row + w_col + w_diag);
}

/**
 * Ambient light under the plan's cover: \`sky\` (the uniform ambient or the environment's light,
 * already shaded) scaled by sky visibility s, plus the level's interior ambient on \`albedo\`
 * (diffuse colour times occlusion) where the sky doesn't reach. Indoors the sky keeps the level's
 * fill share: mix(fill × sky + interior, sky, s).
 */
fn interior_ambient(sky: vec3f, albedo: vec3f, world: vec3f, n: vec3f) -> vec3f {
  let level = interior_level(world.y + n.y / interior.field.z);
  let s = sky_visibility(world, n, level);
  let a = interior.ambient[level];
  return sky * (s + (1.0 - s) * a.w) + albedo * a.rgb * (1.0 - s);
}

/**
 * A direction's place around the circle, 0 to 1 from −x counter-clockwise (+x at ½): a pseudo-angle
 * (one division, not an atan2), monotonic in the angle. Rows bin by it (interior.ts's binOf).
 */
fn interior_bin(v: vec2f) -> f32 {
  let t = v.y / (abs(v.x) + abs(v.y));
  // 0 to 4 counter-clockwise from +x: t in the first quadrant, 2 − t left of the z axis, 4 + t
  // in the fourth quadrant.
  let p = select(select(4.0 + t, t, t >= 0.0), 2.0 - t, v.x < 0.0);
  return fract(p * 0.25 + 0.5);
}

/**
 * Where wall-blocked lights (0069) test a fragment: moved off its surface along the normal (xyz),
 * and its level (w). Once per fragment, before the light loop.
 */
fn interior_receiver(world: vec3f, n: vec3f) -> vec4f {
  let p = world + n * INTERIOR_OFFSET;
  return vec4f(p, f32(interior_level(p.y)));
}

/**
 * How much of a wall-blocked light reaches a receiver (\`interior_receiver\`): 0 on another
 * level, else the share of the bins around its direction whose barrier it isn't behind, or whose
 * top the light passes over. A light without a row (its row word is 0) is unblocked.
 */
fn wall_visibility(light: Light, receiver: vec4f) -> f32 {
  // Row + 1, in a word this kind never reads (LIGHT_ROW_WORD): a point's spot scale, a spot's bright.
  let row = u32(select(light.spot_scale, light.bright, light.kind == LIGHT_SPOT));
  if (row == 0u) { return 1.0; }
  let p = receiver.xyz;
  if (u32(receiver.w) != interior_level(light.position.y)) { return 0.0; }
  let to = p.xz - light.position.xz;
  let d = length(to);
  if (d < 1e-4) { return 1.0; }
  let bins = i32(interior.size.z);
  let taps = i32(interior.size.w);
  let at = i32(floor(interior_bin(to) * f32(bins)));
  let r = i32(row) - 1;
  let h = i32(interior.rows.y);
  let first = i32(interior.rows.x);
  var lit = 0.0;
  for (var k = -(taps / 2); k <= taps / 2; k++) {
    let v = textureLoad(interior_data, vec2i((at + k + bins) % bins, r % h), first + r / h, 0).r;
    let r = f32(v & 0xffffu) / ${ROW_SCALE}.0;
    let top = light.position.y + (f32(v >> 16u) - ${ROW_ZERO}.0) / ${ROW_SCALE}.0;
    // Behind the barrier, unless the line from the light clears its top there.
    let y_at = light.position.y + (p.y - light.position.y) * r / d;
    lit += select(1.0, 0.0, d > r && y_at <= top);
  }
  return lit / f32(taps);
}`,
}

/**
 * Interior lighting's GPU side: what providers write, and what forward binds. One r32uint texture
 * array holds both parts (a stage has 16 sampled textures, and the baseline tier's standard
 * material already uses 15): the field's layers, then the rows, `height` to a layer. Providers
 * (structure) size and fill it, write the table, and switch the parts on; with both off nothing
 * is bound at all.
 */
export class InteriorLighting implements InteriorSupport {
  sky = false
  blocked = false
  provided = false
  version = 0
  /**
   * Set when the texture is made again (a size changed, or the device was lost): the provider
   * writes the field and every row again, then clears it.
   */
  stale = false
  /** The field's size in texels and layers, and the rows' bins and count (0: none). */
  fieldWidth = 0
  fieldHeight = 0
  fieldLayers = 0
  rowBins = 0
  rowCount = 0
  /** The texture's size: rows sit `height` to a layer after the field's layers. */
  width = 0
  height = 0
  layers = 0
  /** The table as written; `writeTable` uploads it when it changed. */
  readonly table = new Float32Array(TABLE_FLOATS)
  private readonly sent = new Float32Array(TABLE_FLOATS)
  private tableStale = true
  private texture: GPUTexture | undefined
  private generation = -1
  private placeholder: { texture: GPUTexture; generation: number } | undefined
  private buffer: GpuBuffer | undefined
  private readonly gpu: GpuContext
  private bound: { version: number; entries: GPUBindGroupEntry[] } | undefined

  constructor(gpu: GpuContext) {
    this.gpu = gpu
  }

  get mode(): number {
    return (this.sky ? INTERIOR_SKY : 0) | (this.blocked ? INTERIOR_BLOCKED : 0)
  }

  /**
   * Sizes the texture for a field of `fieldLayers` layers (0: none) and `rows` rows of `bins` bins
   * (0: none). Made again, and `stale`, only when a size changes or the device was lost.
   */
  configure(
    fieldWidth: number,
    fieldHeight: number,
    fieldLayers: number,
    bins: number,
    rows: number,
  ): void {
    const lost = this.texture !== undefined && this.generation !== this.gpu.generation
    if (
      !lost &&
      fieldWidth === this.fieldWidth &&
      fieldHeight === this.fieldHeight &&
      fieldLayers === this.fieldLayers &&
      bins === this.rowBins &&
      rows === this.rowCount
    )
      return
    this.texture?.destroy()
    this.texture = undefined
    this.fieldWidth = fieldWidth
    this.fieldHeight = fieldHeight
    this.fieldLayers = fieldLayers
    this.rowBins = bins
    this.rowCount = rows
    // At most 64 layers of rows: WebGPU guarantees 256 layers.
    const height =
      fieldLayers > 0 ? Math.max(fieldHeight, Math.ceil(rows / 64)) : Math.min(rows, 2048)
    this.width = Math.max(1, fieldWidth, bins)
    this.height = Math.max(1, height)
    this.layers = fieldLayers + (rows > 0 ? Math.ceil(rows / this.height) : 0)
    const t = this.table
    t[8] = fieldLayers
    t[9] = this.height
    this.version++
    if (this.layers === 0) return
    this.texture = this.gpu.device.createTexture({
      label: 'interior/data',
      size: { width: this.width, height: this.height, depthOrArrayLayers: this.layers },
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      ...bindingDimension(this.gpu, '2d-array'),
    })
    this.generation = this.gpu.generation
    this.stale = true
  }

  /**
   * Whether the device was lost since the texture was made: makes it again (`stale`), so the
   * provider writes everything once more. Providers check it each frame they're on.
   */
  lost(): boolean {
    if (this.texture === undefined || this.generation === this.gpu.generation) return false
    const { fieldWidth, fieldHeight, fieldLayers, rowBins, rowCount } = this
    this.configure(fieldWidth, fieldHeight, fieldLayers, rowBins, rowCount)
    this.tableStale = true
    return true
  }

  /**
   * Writes a rectangle of field layer `layer` from `data`, a whole layer's texels (fieldWidth ×
   * fieldHeight, row by row): only the rectangle uploads.
   */
  writeField(layer: number, x: number, z: number, w: number, h: number, data: Uint32Array): void {
    if (!this.texture || w <= 0 || h <= 0 || layer >= this.fieldLayers) return
    this.gpu.device.queue.writeTexture(
      { texture: this.texture, origin: { x, y: z, z: layer } },
      data as Uint32Array<ArrayBuffer>,
      {
        // Relative to the view's start, as WebGPU reads a typed array.
        offset: (z * this.fieldWidth + x) * 4,
        bytesPerRow: this.fieldWidth * 4,
        rowsPerImage: h,
      },
      { width: w, height: h, depthOrArrayLayers: 1 },
    )
  }

  /** Writes row `row` from `data` (`rowBins` bins). */
  writeRow(row: number, data: Uint32Array): void {
    if (!this.texture || row >= this.rowCount) return
    this.gpu.device.queue.writeTexture(
      {
        texture: this.texture,
        origin: { x: 0, y: row % this.height, z: this.fieldLayers + Math.floor(row / this.height) },
      },
      data as Uint32Array<ArrayBuffer>,
      { offset: 0, bytesPerRow: this.rowBins * 4 },
      { width: this.rowBins, height: 1 },
    )
  }

  /**
   * Sets the table's field and size: origin (x, z), texel (m), field size, bins per row, filter
   * taps. `writeTable` uploads.
   */
  setGrid(
    originX: number,
    originZ: number,
    texel: number,
    width: number,
    height: number,
    bins: number,
    taps: number,
  ): void {
    const t = this.table
    t[0] = originX
    t[1] = originZ
    t[2] = 1 / texel
    t[4] = width
    t[5] = height
    t[6] = bins
    t[7] = taps
  }

  /**
   * Sets level `i`'s entry (`INTERIOR_GROUND` for the ground level): its [floor, top) y, field
   * layer, the y its cover heights count from, its interior ambient (rgb, cd/m²) and fill share.
   */
  setLevel(
    i: number,
    floor: number,
    top: number,
    layer: number,
    base: number,
    ambient: ArrayLike<number>,
    fill: number,
  ): void {
    const t = this.table
    const l = LEVELS_AT + i * 4
    t[l] = floor
    t[l + 1] = top
    t[l + 2] = layer
    t[l + 3] = base
    const a = AMBIENT_AT + i * 4
    t[a] = ambient[0]!
    t[a + 1] = ambient[1]!
    t[a + 2] = ambient[2]!
    t[a + 3] = fill
  }

  /** How many levels (besides the ground's) the table holds. */
  setLevelCount(count: number): void {
    this.table[3] = Math.min(count, INTERIOR_LEVELS)
  }

  /** Uploads the table if it changed since the last upload. */
  writeTable(): void {
    const t = this.table
    let same = !this.tableStale && this.buffer !== undefined
    for (let i = 0; same && i < t.length; i++) if (!Object.is(t[i], this.sent[i])) same = false
    if (same) return
    if (!this.buffer) {
      this.buffer = new GpuBuffer(this.gpu, {
        label: 'interior/table',
        usage: GPUBufferUsage.UNIFORM,
        size: TABLE_FLOATS * 4,
      })
      this.version++
    }
    this.buffer.write(t)
    this.sent.set(t)
    this.tableStale = false
  }

  /** GPU bytes the texture holds. */
  get bytes(): number {
    return this.texture ? this.width * this.height * this.layers * 4 : 0
  }

  entries(gpu: GpuContext): readonly GPUBindGroupEntry[] {
    if (!this.buffer) this.writeTable()
    // Reading .buffer first: after a device loss it makes a new buffer, bumping its version.
    const buffer = this.buffer!
    const gpuBuffer = buffer.buffer
    const version = this.version * 4096 + buffer.version
    if (this.bound?.version === version) return this.bound.entries
    let texture = this.texture
    if (!texture || this.generation !== gpu.generation) {
      // Nothing to read yet: a 1×1 placeholder, as every feature's off state binds (0056).
      if (!this.placeholder || this.placeholder.generation !== gpu.generation) {
        this.placeholder = {
          texture: gpu.device.createTexture({
            label: 'interior/placeholder',
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: 'r32uint',
            usage: GPUTextureUsage.TEXTURE_BINDING,
            ...bindingDimension(gpu, '2d-array'),
          }),
          generation: gpu.generation,
        }
      }
      texture = this.placeholder.texture
    }
    const entries: GPUBindGroupEntry[] = [
      { binding: INTERIOR_BINDINGS.data, resource: texture.createView({ dimension: '2d-array' }) },
      { binding: INTERIOR_BINDINGS.table, resource: { buffer: gpuBuffer } },
    ]
    this.bound = { version, entries }
    return entries
  }

  /** Frees the texture (both parts off). */
  free(): void {
    if (!this.texture) return
    this.texture.destroy()
    this.texture = undefined
    this.fieldWidth = this.fieldHeight = this.fieldLayers = this.rowBins = this.rowCount = 0
    this.width = this.height = this.layers = 0
    this.version++
  }

  /** Frees everything (the plugin's dispose). */
  destroy(): void {
    this.free()
    this.placeholder?.texture.destroy()
    this.buffer?.destroy()
  }
}

export const InteriorLightingResource = defineResource<InteriorLighting>(
  'render/InteriorLighting',
  {
    description:
      "Interior lighting's textures and level table (0069): sky visibility field, wall-blocked lights' rows. Structure's interiorLightingPlugin fills them.",
  },
)

/** render.describe's interior section. */
export function describeInterior(world: World) {
  const s = world.tryResource(InteriorLightingResource)
  if (!s) return undefined
  return {
    sky: s.sky,
    blockedLights: s.blocked,
    provided: s.provided,
    field:
      s.fieldLayers > 0
        ? { width: s.fieldWidth, height: s.fieldHeight, layers: s.fieldLayers }
        : null,
    rows: s.rowCount > 0 ? { bins: s.rowBins, rows: s.rowCount } : null,
    bytes: s.bytes,
  }
}

/**
 * Interior lighting (0069): the lighting stage scales sky ambient by a plan's sky visibility and
 * occludes wall-blocked lights through polar rows, once a provider (structure's
 * interiorLightingPlugin) turns a part on. Until then nothing links or binds differently.
 */
export const interiorPlugin = definePlugin({
  name: 'render/interior',
  dependencies: ['render/forward'],
  provides: [InteriorLightingResource],
  build() {
    // Everything needs the device: see ready.
  },
  ready(app) {
    const world = app.world
    const state = new InteriorLighting(world.resource(Gpu))
    app.insertResource(InteriorLightingResource, state)
    app.insertResource(InteriorPath, state)
    registerShaders(world.resource(Shaders), INTERIOR_SHADERS)
    world.initResource(RenderDescribers).set('interior', describeInterior)
    addRenderFeatures(world, {
      name: 'render/interior',
      description: 'Sky visibility and wall-blocked lights from a structure plan.',
      nodes: [],
      baseline: {
        strategy: 'The same integer texture loads (texelFetch); the table a uniform block',
      },
    })
  },
  dispose(app) {
    app.world.tryResource(InteriorLightingResource)?.destroy()
  },
})
