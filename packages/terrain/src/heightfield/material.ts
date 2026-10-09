import { t } from '@aethervtt/shard-core'
import { defineMaterial } from '@aethervtt/shard-render'
import { MORPH_WGSL } from '../lod'
import { LEAF_SIDE, PAGE } from './kernel'

/** Texels a side of the chunk table (one RGBA8 texel per pool slot, rows of this many). */
export const CHUNK_TABLE_WIDTH = 1024

const hidden = (description: string) => t.vec4({ hidden: true, description })

/**
 * Heightfield terrain's surface (spec 0071). One shared grid mesh draws every chunk: its vertex
 * stage reads heights from the chunk's page in the pool (vertex fetch), geomorphs odd vertices
 * toward their parent level from the page's own samples, and drops skirts; its surface stage reads
 * the page's normals and control texels per fragment and blends the two heaviest material layers
 * from the albedo and ORM arrays (planar on XZ, triplanar on steep `triplanar` layers). Shading
 * normals are the pages' (averaged from their subtree, so far ground keeps its relief); layer
 * normal maps would take a 17th sampled texture on the baseline tier.
 */
export const TerrainSurfaceMaterial = defineMaterial('terrain/TerrainSurface', {
  shader: 'terrain::heightfield',
  arrays: ['pages', 'control', 'albedoArray', 'ormArray'],
  standardTextures: false,
  fields: {
    pages: t.handle('Texture', {
      hidden: true,
      description:
        'Set by the terrain: the page pool, RGBA8 texels of (height low, height high, normal x, normal z).',
    }),
    control: t.handle('Texture', {
      hidden: true,
      description: 'Set by the terrain: control texels per page (two layers and their blend).',
    }),
    chunks: t.handle('Texture', {
      hidden: true,
      description:
        'Set by the terrain: per pool slot, edge locks, drawn quadrants, fade and depth.',
    }),
    layerTable: t.handle('Texture', {
      hidden: true,
      description:
        'Set by the terrain: per material layer, its array layers, scale, tint, triplanar.',
    }),
    albedoArray: t.handle('Texture', { description: 'The source’s albedo texture array.' }),
    ormArray: t.handle('Texture', {
      description: 'The source’s occlusion/roughness/metallic array.',
    }),
    center: hidden('Set by the terrain: its origin in the origin frame (xyz).'),
    rot0: hidden('Set by the terrain: origin → terrain rotation rows (xyz), texture origin (w).'),
    rot1: hidden('Set by the terrain.'),
    rot2: hidden('Set by the terrain.'),
    camera: hidden(
      'Set by the terrain: the selecting camera (xyz), pixels per radian / errorPixels (w).',
    ),
    pool: hidden(
      'Set by the terrain: pages per atlas row, per layer, atlas side, control cell side.',
    ),
    range: hidden(
      'Set by the terrain: lowest and highest height, paint cells per page, layer count.',
    ),
    errors0: hidden('Set by the terrain: morph error per depth (0–3).'),
    errors1: hidden('Set by the terrain: morph error per depth (4–7).'),
    errors2: hidden('Set by the terrain: morph error per depth (8–11).'),
    skirts0: hidden('Set by the terrain: skirt depth per depth (0–3).'),
    skirts1: hidden('Set by the terrain: skirt depth per depth (4–7).'),
    skirts2: hidden('Set by the terrain: skirt depth per depth (8–11).'),
    debug: hidden(
      'Set by the terrain: debug mode (0 off, 1 layers, 2 seams, 3 levels, 4 normals, 5 pages), has albedo, has ORM, texture period.',
    ),
  },
  description:
    'Heightfield terrain: vertex fetch from streamed pages, geomorphing between levels, and two blended material layers from the paint control pages.',
})

const S = TerrainSurfaceMaterial.varName

export const HEIGHTFIELD_SHADERS: Record<string, string> = {
  'terrain::heightfield': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::view::view;
import shard::mesh::{ vertex_world, vertex_instance_data };
import material::terrain_surface::{ ${S}, ${S}_pages, ${S}_pages_sampler, ${S}_control, ${S}_chunks, ${S}_layerTable, ${S}_albedoArray, ${S}_albedoArray_sampler, ${S}_ormArray, ${S}_ormArray_sampler };

/** Page grid: PAGE segments a side; each page takes CELL texels a side in the pool (a border). */
const PAGE: i32 = ${PAGE};
const CELL: i32 = ${LEAF_SIDE};

struct Chunk {
  locks: u32,
  mask: u32,
  fade: f32,
  depth: u32,
  /** A leaf near an anchor: drawn exactly as its collider, no distance morph. */
  anchored: bool,
  layer: i32,
  corner: vec2i,
}

/** Where a pool slot's page is: its atlas layer and corner texel. */
fn terrain_cell(slot: u32) -> vec3i {
  let per_row = u32(${S}.pool.x + 0.5);
  let per_layer = u32(${S}.pool.y + 0.5);
  let cell = slot % per_layer;
  return vec3i(i32(cell % per_row) * CELL, i32(cell / per_row) * CELL, i32(slot / per_layer));
}

/** The drawn chunk: InstanceData.y is its pool slot; the chunk table has the rest. */
fn terrain_chunk() -> Chunk {
  let slot = u32(vertex_instance_data().y + 0.5);
  let t = textureLoad(${S}_chunks, vec2i(i32(slot % ${CHUNK_TABLE_WIDTH}u), i32(slot / ${CHUNK_TABLE_WIDTH}u)), 0);
  var c: Chunk;
  c.locks = u32(t.r * 255.0 + 0.5);
  c.mask = u32(t.g * 255.0 + 0.5);
  c.fade = t.b;
  let d = u32(t.a * 255.0 + 0.5);
  c.depth = d & 127u;
  c.anchored = d >= 128u;
  let cell = terrain_cell(slot);
  c.corner = cell.xy;
  c.layer = cell.z;
  return c;
}

/** The page's height (m) at vertex (i, j), from its 16-bit sample. */
fn page_height(c: Chunk, i: i32, j: i32) -> f32 {
  let t = textureLoad(${S}_pages, c.corner + vec2i(i + 1, j + 1), c.layer, 0);
  let q = round(t.r * 255.0) + round(t.g * 255.0) * 256.0;
  return ${S}.range.x + q * ((${S}.range.y - ${S}.range.x) / 65535.0);
}

/** Depth \`depth\`'s entry of a 12-entry table packed in three vec4s (selects, no array: see paint_offer). */
fn per_depth(a: vec4f, b: vec4f, c: vec4f, depth: u32) -> f32 {
  let d = min(depth, 11u);
  let v = select(select(c, b, d < 8u), a, d < 4u);
  let i = d % 4u;
  return select(select(select(v.w, v.z, i == 2u), v.y, i == 1u), v.x, i == 0u);
}

/**
 * A vertex's lock code (grid-mesh.ts lockCode): its edge on the border ring (0 bottom, 1 right,
 * 2 top, 3 left, each edge owning its first corner), the center lines (4-7), the center (8), else -1.
 */
fn terrain_lock(i: i32, j: i32) -> i32 {
  let s = PAGE;
  let h = PAGE / 2;
  if (j == 0 && i < s) { return 0; }
  if (i == s && j < s) { return 1; }
  if (j == s && i > 0) { return 2; }
  if (i == 0 && j > 0) { return 3; }
  if (i == h && j == h) { return 8; }
  if (i == h) { return select(5, 4, j < h); }
  if (j == h) { return select(7, 6, i < h); }
  return -1;
}

/**
 * How far toward its parent level a vertex has morphed (0043's rules): by distance within the band
 * where the parent splits (not at all on a leaf near an anchor: what's drawn there is the collider);
 * overridden on edges by the chunk's locks (1 this level, 2 the parent's) and on center lines where
 * a partial parent meets a child; never less than the chunk's fade.
 */
fn terrain_morph(c: Chunk, i: i32, j: i32, local: vec3f) -> f32 {
  var t = 0.0;
  let split = select(per_depth(${S}.errors0, ${S}.errors1, ${S}.errors2, c.depth) * ${S}.camera.w, 0.0, c.depth == 0u || c.anchored);
  if (split > 0.0) {
    let d = distance(vertex_world(local), ${S}.camera.xyz);
    t = ${MORPH_WGSL};
  }
  let code = terrain_lock(i, j);
  if (code >= 0 && code < 4) {
    let bits = (c.locks >> (u32(code) * 2u)) & 3u;
    if (bits == 1u) { return 0.0; } else if (bits == 2u) { return 1.0; }
    return t;
  } else if (code >= 4 && c.mask != 15u) {
    var a = 0u;
    var b = 1u;
    if (code == 5) { a = 2u; b = 3u; } else if (code == 6) { a = 0u; b = 2u; } else if (code == 7) { a = 1u; b = 3u; }
    let differ = ((c.mask >> a) & 1u) != ((c.mask >> b) & 1u);
    if (differ || (code == 8 && c.mask != 0u)) { return 0.0; }
  }
  return max(t, c.fade);
}

/**
 * Object space is the page's grid (x, z from -32 to 32, scaled to metres by the chunk's transform)
 * and height in metres. Odd vertices morph to the parent level's surface, interpolated from their
 * even neighbors on the same page (odd-odd ones along the anti-diagonal, as the parent's quad is
 * split); skirt vertices (position.y 1) hang below.
 */
override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  let c = terrain_chunk();
  let i = i32(position.x + 0.5);
  let j = i32(position.z + 0.5);
  let h = page_height(c, i, j);
  let oi = (i & 1) == 1;
  let oj = (j & 1) == 1;
  var parent = h;
  if (oi && oj) {
    parent = 0.5 * (page_height(c, i + 1, j - 1) + page_height(c, i - 1, j + 1));
  } else if (oi) {
    parent = 0.5 * (page_height(c, i - 1, j) + page_height(c, i + 1, j));
  } else if (oj) {
    parent = 0.5 * (page_height(c, i, j - 1) + page_height(c, i, j + 1));
  }
  let local = vec3f(f32(i - PAGE / 2), h, f32(j - PAGE / 2));
  var y = mix(h, parent, terrain_morph(c, i, j, local));
  if (position.y > 0.5) { y -= per_depth(${S}.skirts0, ${S}.skirts1, ${S}.skirts2, c.depth); }
  return vec3f(local.x, y, local.z);
}

/** To the surface stage: the vertex across its page (xy, 0–1), the pool slot (z), its depth (w). */
override fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  let c = terrain_chunk();
  let slot = u32(vertex_instance_data().y + 0.5);
  return vec4f(position.x / f32(PAGE), position.z / f32(PAGE), f32(slot), f32(c.depth));
}

fn layer_info(l: u32) -> vec4f {
  return textureLoad(${S}_layerTable, vec2i(0, i32(l)), 0);
}

fn layer_tint(l: u32) -> vec4f {
  return textureLoad(${S}_layerTable, vec2i(1, i32(l)), 0);
}

/** The two heaviest layers so far (l0 first), and their summed weights (-1 before any). */
struct Top2 {
  l0: u32,
  w0: f32,
  l1: u32,
  w1: f32,
}

/**
 * Offers layer \`id\` (its entry's weight \`own\`, all its entries' \`total\`) to the top two, in the
 * order the control texels list them: a layer already first, or with no weight here, is skipped,
 * and ties keep the layer listed first. Plain values only: arrays indexed at run time spill out of
 * registers on some GPUs (Apple's), which cost more than the rest of the terrain's shading.
 */
fn paint_offer(s: Top2, id: u32, own: f32, total: f32) -> Top2 {
  if (own <= 0.0 || (s.w0 >= 0.0 && id == s.l0)) { return s; }
  var r = s;
  if (total > s.w0) {
    r.l1 = s.l0;
    r.w1 = s.w0;
    r.l0 = id;
    r.w0 = total;
  } else if (total > s.w1) {
    r.l1 = id;
    r.w1 = total;
  }
  return r;
}

/** A layer's summed weight over the four texels' two entries each. */
fn paint_total(id: u32, la: vec4u, lb: vec4u, wa: vec4f, wb: vec4f) -> f32 {
  let x = vec4u(id);
  return dot(select(vec4f(0.0), wa, la == x), vec4f(1.0)) + dot(select(vec4f(0.0), wb, lb == x), vec4f(1.0));
}

struct Layered {
  albedo: vec3f,
  normal: vec3f,
  orm: vec3f,
}

/** One material layer at terrain-space point q: planar on XZ, or triplanar where steep. */
fn sample_layer(l: u32, q: vec3f, gx: vec3f, gy: vec3f, n: vec3f) -> Layered {
  var out: Layered;
  let info = layer_info(l);
  let tint = layer_tint(l);
  out.normal = n;
  out.orm = vec3f(1.0, 0.9, 0.0);
  if (${S}.debug.y < 0.5) {
    out.albedo = tint.rgb;
    return out;
  }
  let s = 1.0 / max(info.w, 1e-3);
  let ia = i32(info.x + 0.5);
  let io = i32(info.z + 0.5);
  var w = vec3f(0.0, 1.0, 0.0);
  if (tint.w > 0.5 && n.y < 0.7071) {
    w = pow(abs(n), vec3f(4.0));
    w /= max(1e-6, w.x + w.y + w.z);
  }
  var albedo = vec3f(0.0);
  var orm = vec3f(0.0);
  // Top-down always (weight w.y); the sides only on steep triplanar layers.
  let uy = q.xz * s;
  albedo += textureSampleGrad(${S}_albedoArray, ${S}_albedoArray_sampler, uy, ia, gx.xz * s, gy.xz * s).rgb * w.y;
  orm += textureSampleGrad(${S}_ormArray, ${S}_ormArray_sampler, uy, io, gx.xz * s, gy.xz * s).rgb * w.y;
  if (w.x > 0.001) {
    let ux = q.zy * s;
    albedo += textureSampleGrad(${S}_albedoArray, ${S}_albedoArray_sampler, ux, ia, gx.zy * s, gy.zy * s).rgb * w.x;
    orm += textureSampleGrad(${S}_ormArray, ${S}_ormArray_sampler, ux, io, gx.zy * s, gy.zy * s).rgb * w.x;
  }
  if (w.z > 0.001) {
    let uz = q.xy * s;
    albedo += textureSampleGrad(${S}_albedoArray, ${S}_albedoArray_sampler, uz, ia, gx.xy * s, gy.xy * s).rgb * w.z;
    orm += textureSampleGrad(${S}_ormArray, ${S}_ormArray_sampler, uz, io, gx.xy * s, gy.xy * s).rgb * w.z;
  }
  out.albedo = albedo * tint.rgb;
  out.orm = orm;
  return out;
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p: PbrInput;
  p.base_color = vec3f(1.0);
  p.alpha = 1.0;
  p.metallic = 0.0;
  p.roughness = 0.9;
  p.emissive = vec3f(0.0);
  p.occlusion = 1.0;
  let slot = u32(round(in.extra.z));
  let depth = u32(round(in.extra.w));
  let cell = terrain_cell(slot);
  let uv = clamp(in.extra.xy, vec2f(0.0), vec2f(1.0));
  // Normals: the page's, filtered across its texels (vertex i is texel i + 1).
  let texel = vec2f(cell.xy) + 1.5 + uv * f32(PAGE);
  let nt = textureSampleLevel(${S}_pages, ${S}_pages_sampler, texel / ${S}.pool.z, cell.z, 0.0);
  let nx = nt.b * 2.0 - 1.0;
  let nz = nt.a * 2.0 - 1.0;
  let nl = normalize(vec3f(nx, sqrt(max(0.0, 1.0 - nx * nx - nz * nz)), nz));
  // Terrain space to world: the rotation rows transposed.
  let n = normalize(${S}.rot0.xyz * nl.x + ${S}.rot1.xyz * nl.y + ${S}.rot2.xyz * nl.z);
  p.normal = n;
  // Terrain-space position (offset so it stays small; repeats line up across the offset).
  let q = vec3f(dot(${S}.rot0.xyz, in.world_position), dot(${S}.rot1.xyz, in.world_position), dot(${S}.rot2.xyz, in.world_position)) +
    vec3f(${S}.rot0.w, ${S}.rot1.w, ${S}.rot2.w);
  let gx = dpdx(q);
  let gy = dpdy(q);
  // Paint: the four control texels around the fragment, bilinear, their layers summed.
  let cells = ${S}.range.z;
  let side = ${S}.pool.w;
  let ccorner = vec2i(cell.xy / CELL) * i32(side + 0.5);
  let pc = uv * cells;
  let c0 = clamp(vec2i(floor(pc)), vec2i(0), vec2i(i32(cells) - 1));
  let f = pc - vec2f(c0);
  // Texels (0,0), (1,0), (0,1), (1,1) in x, y, z, w; each lists two layers and the second's share.
  let base = ccorner + c0;
  let t0 = textureLoad(${S}_control, base, cell.z, 0);
  let t1 = textureLoad(${S}_control, base + vec2i(1, 0), cell.z, 0);
  let t2 = textureLoad(${S}_control, base + vec2i(0, 1), cell.z, 0);
  let t3 = textureLoad(${S}_control, base + vec2i(1, 1), cell.z, 0);
  let bw = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  let sh = vec4f(t0.b, t1.b, t2.b, t3.b);
  let la = vec4u(vec4f(t0.r, t1.r, t2.r, t3.r) * 255.0 + 0.5);
  let lb = vec4u(vec4f(t0.g, t1.g, t2.g, t3.g) * 255.0 + 0.5);
  let wa = bw * (1.0 - sh);
  let wb = bw * sh;
  var top = Top2(0u, -1.0, 0u, -1.0);
  top = paint_offer(top, la.x, wa.x, paint_total(la.x, la, lb, wa, wb));
  top = paint_offer(top, lb.x, wb.x, paint_total(lb.x, la, lb, wa, wb));
  top = paint_offer(top, la.y, wa.y, paint_total(la.y, la, lb, wa, wb));
  top = paint_offer(top, lb.y, wb.y, paint_total(lb.y, la, lb, wa, wb));
  top = paint_offer(top, la.z, wa.z, paint_total(la.z, la, lb, wa, wb));
  top = paint_offer(top, lb.z, wb.z, paint_total(lb.z, la, lb, wa, wb));
  top = paint_offer(top, la.w, wa.w, paint_total(la.w, la, lb, wa, wb));
  top = paint_offer(top, lb.w, wb.w, paint_total(lb.w, la, lb, wa, wb));
  let l0 = top.l0;
  let w0 = top.w0;
  let w1 = top.w1;
  let l1 = select(l0, top.l1, w1 > 0.0);
  let share = select(0.0, w1 / max(1e-6, w0 + w1), w1 > 0.0);
  let debug = u32(${S}.debug.x + 0.5);
  if (debug == 1u) {
    p.base_color = mix(layer_tint(l0).rgb, layer_tint(l1).rgb, share);
    return p;
  }
  if (debug == 2u) {
    p.base_color = vec3f(1.0);
    p.emissive = vec3f(20000.0);
    return p;
  }
  if (debug == 3u) {
    let hue = fract(f32(depth) * 0.37);
    p.base_color = 0.5 + 0.5 * cos(6.2832 * (vec3f(hue) + vec3f(0.0, 0.33, 0.67)));
    p.emissive = p.base_color * 3000.0;
    return p;
  }
  if (debug == 4u) {
    p.base_color = nl * 0.5 + 0.5;
    p.emissive = p.base_color * 3000.0;
    return p;
  }
  if (debug == 5u) {
    let hue = fract(f32(slot) * 0.618);
    p.base_color = 0.5 + 0.5 * cos(6.2832 * (vec3f(hue) + vec3f(0.0, 0.33, 0.67)));
    return p;
  }
  let a = sample_layer(l0, q, gx, gy, nl);
  var c = a;
  if (share > 0.004 && l1 != l0) {
    let b = sample_layer(l1, q, gx, gy, nl);
    c.albedo = mix(a.albedo, b.albedo, share);
    c.orm = mix(a.orm, b.orm, share);
  }
  p.base_color = c.albedo;
  if (${S}.debug.z > 0.5) {
    p.occlusion = c.orm.r;
    p.roughness = clamp(c.orm.g, 0.045, 1.0);
    p.metallic = c.orm.b;
  }
  return p;
}
`,
}
