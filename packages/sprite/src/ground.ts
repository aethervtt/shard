import {
  type AssetRef,
  affine,
  ChildOf,
  Derived,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  onRemove,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Mesh } from '@aethervtt/shard-mesh'
import {
  defineMaterial,
  GroundLayer,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  type PickDetail,
  type PickHit,
  RenderLayers,
} from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { Textures } from '@aethervtt/shard-texture'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { type TextureAtlas, TextureAtlases } from './atlas'
import { resolveTiles } from './render'
import { Tilemap, type TilemapData, TilemapDatas } from './tilemap'

// Tilemaps on the ground (0059): a Tilemap with a GroundLayer draws in the ground phase, among the
// tabletop's bands, instead of the sprite pass. Each chunk of each layer is a mesh of its tiles'
// quads with the atlas as its texture: a standard material ('3d': lit by 3D lights, shadowed,
// fogged, hidden by walls like any band) or an unlit one ('none'). Edits rebuild only their chunk.
// Both sample the atlas isotropically, as the sprite pass does: anisotropic filtering would reach
// past a region's edge into its neighbours at grazing angles, so a re-packed atlas would draw a
// different map.

/** Marks a chunk mesh a ground tilemap spawned: which layer and chunk of which tilemap. */
export const TileChunk = defineComponent(
  'sprite/TileChunk',
  {
    tilemap: t.entity({ readonly: true, description: 'The Tilemap this chunk belongs to.' }),
    layer: t.u16({ readonly: true, description: 'Layer index in the tilemap data.' }),
    chunk: t.u32({ readonly: true, description: 'Chunk index: cy · chunks across + cx.' }),
  },
  {
    description: "A ground tilemap's chunk mesh: spawned and kept by the sprite plugin.",
    serialize: false,
    save: false,
  },
)

/** The rotation that lays a tilemap's XY plane on the ground, rows going +Z, facing up. */
export function tilemapOnGround(elevation = 0): {
  translation: [number, number, number]
  rotation: [number, number, number, number]
} {
  return { translation: [0, elevation, 0], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] }
}

/** Tiles lit like a floor: flat albedo from the atlas, an up normal, roughness 1. */
export const TileLit = defineMaterial('sprite/TileLit', {
  extends: 'standard',
  blend: 'mask',
  standardTextures: false,
  fields: { atlas: t.handle('Texture', { description: 'The tile atlas.' }) },
  colors: ['atlas'],
  shader: 'sprite::tile_lit',
  description: 'Lit ground tiles (a Tilemap on a GroundLayer, lit: 3d or 2d).',
})

/** Tiles drawn without lighting: the atlas as it is, display-referred like any overlay. */
export const TileUnlit = defineMaterial('sprite/TileUnlit', {
  extends: 'none',
  blend: 'mask',
  fields: { atlas: t.handle('Texture', { description: 'The tile atlas.' }) },
  colors: ['atlas'],
  shader: 'sprite::tile_unlit',
  description: 'Unlit ground tiles (a Tilemap on a GroundLayer, lit: none).',
})

export const GROUND_TILE_SHADERS: Record<string, string> = {
  'sprite::tile_sample': `
/** Trilinear at the larger axis's footprint, never anisotropic: a region's edge stays its edge. */
fn tile_sample(atlas: texture_2d<f32>, s: sampler, uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(atlas));
  let dx = dpdx(uv * size);
  let dy = dpdy(uv * size);
  let lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
  return textureSampleLevel(atlas, s, uv, lod);
}`,
  'sprite::tile_lit': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import sprite::tile_sample::tile_sample;
import material::tile_lit::{ TileLit_atlas, TileLit_atlas_sampler };

override fn pbr_input(in: VertexOutput) -> PbrInput {
  let c = tile_sample(TileLit_atlas, TileLit_atlas_sampler, in.uv);
  var p: PbrInput;
  p.base_color = c.rgb;
  p.alpha = c.a;
  p.normal = normalize(in.world_normal);
  p.metallic = 0.0;
  p.roughness = 1.0;
  p.emissive = vec3f(0.0);
  p.occlusion = 1.0;
  return p;
}`,
  'sprite::tile_unlit': `
import shard::pbr::types::VertexOutput;
import shard::view::view;
import sprite::tile_sample::tile_sample;
import material::tile_unlit::{ TileUnlit_atlas, TileUnlit_atlas_sampler };

override fn shade(in: VertexOutput) -> vec4f {
  let c = tile_sample(TileUnlit_atlas, TileUnlit_atlas_sampler, in.uv);
  return vec4f(c.rgb / view.exposure, c.a);
}`,
}

interface ChunkState {
  entity: Entity
  mesh: Mesh
  meshRef: AssetRef<'Mesh'>
}

interface LayerState {
  /** Edit log position and base (see TileLayer.edits): what's been rebuilt. */
  cursor: number
  base: number
  chunks: Map<number, ChunkState>
  /** Chunks holding an animated tile: rebuilt when a frame turns. */
  animated: number[]
}

interface GroundMap {
  data: TilemapData
  dataVersion: number
  atlas: TextureAtlas
  atlasVersion: number
  chunkSize: number
  tileSize: [number, number]
  material: AssetRef<'Material'>
  lit: '2d' | '3d' | 'none'
  layers: LayerState[]
  /** Tile id → region + 1 with animations applied, and what it was built from. */
  remap: Uint32Array
  base: Uint32Array
  /** The palette's length when `base` was resolved: an edit naming a new tile grows it. */
  paletteLength: number
  /** Tile ids that animate: chunks holding one rebuild when its frame turns. */
  animatedIds: Set<number>
  band: number
  order: number
  level: number
  mask: number
  seen: number
}

export interface GroundTilesState {
  maps: Map<Entity, GroundMap>
  /** Chunk meshes rebuilt and uploaded last frame. */
  chunkUploads: number
  materials: Map<string, AssetRef<'Material'>>
  frame: number
}

export const GroundTiles = defineResource<GroundTilesState>('sprite/GroundTiles', {
  description: 'Ground tilemaps (0059): their chunk meshes, and how many were rebuilt last frame.',
  init: () => ({ maps: new Map(), chunkUploads: 0, materials: new Map(), frame: 0 }),
})

const LITS = ['2d', '3d', 'none'] as const

/** The material a ground tilemap draws with: per atlas texture and lighting, shared. */
function materialFor(
  world: World,
  state: GroundTilesState,
  texture: AssetRef<'Texture'>,
  lit: '2d' | '3d' | 'none',
): AssetRef<'Material'> {
  const key = `${texture.guid}/${lit === 'none' ? 'none' : '3d'}`
  let ref = state.materials.get(key)
  if (!ref) {
    const materials = world.resource(Materials)
    const material =
      lit === 'none'
        ? new MaterialAsset({ atlas: texture }, TileUnlit)
        : new MaterialAsset({ atlas: texture, alphaMode: 'mask', alphaCutoff: 0.5 }, TileLit)
    ref = materials.add(material, `tiles:${key}`) as AssetRef<'Material'>
    state.materials.set(key, ref)
  }
  return ref
}

/** The mesh of one chunk's tiles, or undefined when it has none. */
function buildChunk(
  map: GroundMap,
  layerIndex: number,
  chunk: number,
  texW: number,
  texH: number,
): { mesh: Mesh | undefined; animated: boolean } {
  const layer = map.data.layers[layerIndex]!
  const cs = map.chunkSize
  const chunksX = Math.ceil(layer.width / cs)
  const cx = chunk % chunksX
  const cy = Math.floor(chunk / chunksX)
  const [tw, th] = map.tileSize
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let animated = false
  const rects = map.atlas.rects
  for (let y = cy * cs; y < Math.min((cy + 1) * cs, layer.height); y++) {
    for (let x = cx * cs; x < Math.min((cx + 1) * cs, layer.width); x++) {
      const i = y * layer.width + x
      const id = layer.tiles[i]!
      if (id === 0) continue
      const region = (map.remap[Math.min(id, map.remap.length - 1)] ?? 0) - 1
      if (region < 0) continue
      if (map.animatedIds.has(id)) animated = true
      // Half a texel in from the region's edge, so filtering never reads a neighbour.
      const u0 = (rects[region * 4]! + 0.5) / texW
      const v0 = (rects[region * 4 + 1]! + 0.5) / texH
      const u1 = (rects[region * 4]! + rects[region * 4 + 2]! - 0.5) / texW
      const v1 = (rects[region * 4 + 1]! + rects[region * 4 + 3]! - 0.5) / texH
      const flags = layer.flags[i]!
      const base = positions.length / 3
      // Corners (c.x, c.y) in the tile's square, y down: (0,0) (1,0) (1,1) (0,1).
      for (const [ax, ay] of CORNERS) {
        positions.push((x + ax) * tw, -(y + ay) * th, 0)
        normals.push(0, 0, 1)
        let sx = ax
        let sy = ay
        if (flags & 4) {
          const r = sx
          sx = sy
          sy = 1 - r
        }
        if (flags & 1) sx = 1 - sx
        if (flags & 2) sy = 1 - sy
        uvs.push(u0 + (u1 - u0) * sx, v0 + (v1 - v0) * sy)
      }
      // Facing +Z (up once on the ground): counter-clockwise seen from above.
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
  }
  if (indices.length === 0) return { mesh: undefined, animated }
  const vertexCount = positions.length / 3
  return {
    mesh: Mesh.create({
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    }),
    animated,
  }
}

const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

function despawnMap(world: World, map: GroundMap): void {
  for (const layer of map.layers) {
    for (const c of layer.chunks.values()) {
      if (world.isAlive(c.entity)) world.despawn(c.entity)
      world.resource(Meshes).delete(c.meshRef.guid!)
    }
  }
}

/**
 * Keeps each ground tilemap's chunk meshes current: all of them when the map, its atlas or its
 * settings change; the chunks its edits touched otherwise; animated chunks as their frames turn.
 */
export const syncGroundTiles = defineSystem({
  name: 'sprite/ground-tiles',
  description: 'Builds and rebuilds the chunk meshes of tilemaps on the ground (0059).',
  setup: (world) => ({ q: world.query({ with: [Tilemap, GroundLayer] }) }),
  // Per frame with nothing edited and no frame turning, this reads columns and allocates nothing.
  run: ({ q }, world) => {
    const state = world.resource(GroundTiles)
    state.frame++
    state.chunkUploads = 0
    const datas = world.tryResource(TilemapDatas)
    const atlases = world.tryResource(TextureAtlases)
    const textures = world.tryResource(Textures)
    const time = world.tryResource(Time)?.elapsed ?? 0
    let seen = 0
    for (const table of q.tables) {
      const dataRefs = table.column(Tilemap, 'data')
      const atlasRefs = table.column(Tilemap, 'atlas')
      const tileSizes = table.column(Tilemap, 'tileSize')
      const chunkSizes = table.column(Tilemap, 'chunkSize')
      const lits = table.column(Tilemap, 'lit')
      const bands = table.column(GroundLayer, 'band')
      const orders = table.column(GroundLayer, 'order')
      const levels = table.column(GroundLayer, 'level')
      const masks = table.has(RenderLayers) ? table.column(RenderLayers, 'mask') : undefined
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]! as Entity
        const data = datas?.get(dataRefs[row] as AssetRef<'TilemapData'> | null)
        const atlas = atlases?.get(atlasRefs[row] as AssetRef<'TextureAtlas'> | null)
        const texture = atlas?.texture ? textures?.get(atlas.texture) : undefined
        if (!data || !atlas || !texture || !atlas.texture) continue
        // Enum columns hold the option's index.
        const lit = LITS[lits[row] as number] ?? '2d'
        const mask = masks ? masks[row]! : 1
        const tw = tileSizes[row * 2]!
        const th = tileSizes[row * 2 + 1]!
        const chunkSize = chunkSizes[row]!
        const band = bands[row]!
        const order = orders[row]!
        const level = levels[row]!
        let map = state.maps.get(entity)
        const stale =
          !map ||
          map.data !== data ||
          map.dataVersion !== data.version ||
          map.atlas !== atlas ||
          map.atlasVersion !== atlas.version ||
          map.chunkSize !== chunkSize ||
          map.tileSize[0] !== tw ||
          map.tileSize[1] !== th ||
          map.lit !== lit ||
          map.band !== band ||
          map.order !== order ||
          map.level !== level ||
          map.mask !== mask
        if (stale) {
          if (map) despawnMap(world, map)
          const base = resolveTiles(world, data, atlas)
          map = {
            data,
            dataVersion: data.version,
            atlas,
            atlasVersion: atlas.version,
            chunkSize,
            tileSize: [tw, th],
            material: materialFor(world, state, atlas.texture, lit),
            lit,
            layers: data.layers.map((l) => ({
              cursor: l.edits.length,
              base: -1,
              chunks: new Map(),
              animated: [],
            })),
            remap: base.slice(),
            base,
            paletteLength: data.palette?.length ?? -1,
            animatedIds: new Set(data.animations.map((a) => a.tile)),
            band,
            order,
            level,
            mask,
            seen: 0,
          }
          state.maps.set(entity, map)
        }
        const m = map!
        m.seen = state.frame
        seen++
        // A new palette name (an edit naming a tile the map hadn't used): resolve the ids again.
        // Only the edited cells use it, and their chunks rebuild below.
        if ((data.palette?.length ?? -1) !== m.paletteLength) {
          m.base = resolveTiles(world, data, atlas)
          m.remap = m.base.slice()
          m.paletteLength = data.palette?.length ?? -1
        }
        // Animated tiles: point each at its current frame; chunks holding one rebuild on a change.
        let frameChanged = false
        for (let k = 0; k < data.animations.length; k++) {
          const a = data.animations[k]!
          if (a.frames.length === 0 || a.tile >= m.remap.length) continue
          const id = a.frames[Math.floor(time / a.frameTime) % a.frames.length]!
          const region = m.base[Math.min(id, m.base.length - 1)]!
          if (m.remap[a.tile] !== region) {
            m.remap[a.tile] = region
            frameChanged = true
          }
        }
        for (let li = 0; li < data.layers.length; li++) {
          const l = data.layers[li]!
          const ls = m.layers[li]!
          // Nothing edited and no frame turned: nothing to do (and nothing allocated).
          if (ls.base === l.editBase && ls.cursor === l.edits.length && !frameChanged) continue
          const cs = m.chunkSize
          const chunksX = Math.ceil(l.width / cs)
          const dirty = new Set<number>()
          if (ls.base !== l.editBase) {
            for (let c = 0; c < chunksX * Math.ceil(l.height / cs); c++) dirty.add(c)
            ls.base = l.editBase
          } else {
            for (let k = ls.cursor; k < l.edits.length; k++) {
              const i = l.edits[k]!
              dirty.add(
                Math.floor(Math.floor(i / l.width) / cs) * chunksX + Math.floor((i % l.width) / cs),
              )
            }
          }
          ls.cursor = l.edits.length
          if (frameChanged) for (let k = 0; k < ls.animated.length; k++) dirty.add(ls.animated[k]!)
          for (const c of dirty)
            rebuild(world, state, entity, m, li, c, texture.width, texture.height)
        }
      }
    }
    // Maps not drawn this frame (their data or atlas unloaded): free their chunks. Only looked for
    // when one went missing; removed components are handled by observeGroundTiles.
    if (seen === state.maps.size) return
    for (const [entity, map] of state.maps) {
      if (map.seen === state.frame) continue
      despawnMap(world, map)
      state.maps.delete(entity)
    }
  },
})

function rebuild(
  world: World,
  state: GroundTilesState,
  tilemap: Entity,
  map: GroundMap,
  li: number,
  c: number,
  texW: number,
  texH: number,
): void {
  const ls = map.layers[li]!
  const existing = ls.chunks.get(c)
  const built = buildChunk(map, li, c, texW, texH)
  state.chunkUploads++
  const at = ls.animated.indexOf(c)
  if (built.mesh && built.animated) {
    if (at === -1) ls.animated.push(c)
  } else if (at !== -1) ls.animated.splice(at, 1)
  if (!built.mesh) {
    if (existing) {
      if (world.isAlive(existing.entity)) world.despawn(existing.entity)
      world.resource(Meshes).delete(existing.meshRef.guid!)
      ls.chunks.delete(c)
    }
    return
  }
  if (existing && world.isAlive(existing.entity)) {
    // Same mesh object, new data: its GPU copy is rewritten in place when it fits (0055).
    existing.mesh.update(built.mesh.data())
    return
  }
  const meshRef = world
    .resource(Meshes)
    .add(built.mesh, `tiles:${tilemap}/${li}/${c}`) as AssetRef<'Mesh'>
  const entity = world.spawn(
    [Mesh3d, { mesh: meshRef }],
    [MeshMaterial, { material: map.material }],
    // Layers stack in order within the tilemap's band.
    [GroundLayer, { band: map.band, order: map.order * 64 + li, level: map.level }],
    [RenderLayers, { mask: map.mask }],
    [TileChunk, { tilemap, layer: li, chunk: c }],
    NotShadowCaster,
    Derived,
    Transform,
    [ChildOf, { parent: tilemap }],
  )
  ls.chunks.set(c, { entity, mesh: built.mesh, meshRef })
}

/** Frees a ground tilemap's chunks when it loses its Tilemap or GroundLayer. */
export function observeGroundTiles(world: World): void {
  const drop = ({ entity }: { entity: Entity }) => {
    const state = world.tryResource(GroundTiles)
    const map = state?.maps.get(entity)
    if (!map || !state) return
    despawnMap(world, map)
    state.maps.delete(entity)
  }
  world.observe(onRemove(Tilemap), drop)
  world.observe(onRemove(GroundLayer), drop)
}

const inverse = affine.create()
const local = new Float32Array(3)

/**
 * The tile under a pick (0059): the cell of the tilemap the hit landed on, and the tile there
 * named as the palette names it. A ground chunk knows its layer; a tilemap in the sprite pass
 * reports its topmost filled layer at the cell. Undefined for hits on anything else.
 */
export function tileDetail(world: World, hit: PickHit): PickDetail | undefined {
  const chunk = world.tryGet(hit.entity, TileChunk)
  const tilemap = chunk ? (chunk.tilemap as Entity) : hit.entity
  const value = world.tryGet(tilemap, Tilemap)
  const g = world.tryGet(tilemap, GlobalTransform)?.matrix
  if (!value || !g) return undefined
  const data = world.tryResource(TilemapDatas)?.get(value.data as AssetRef<'TilemapData'> | null)
  if (!data || data.layers.length === 0 || !affine.invert(inverse, g)) return undefined
  affine.transformPoint(local, inverse, hit.position)
  const [tw, th] = value.tileSize as ArrayLike<number> as [number, number]
  const x = Math.floor(local[0]! / tw)
  const y = Math.floor(-local[1]! / th)
  let layer = chunk ? chunk.layer : -1
  if (!chunk) {
    for (let li = data.layers.length - 1; li >= 0; li--) {
      if (data.layers[li]!.get(x, y) !== 0) {
        layer = li
        break
      }
    }
  }
  const l = data.layers[layer]
  if (!l || x < 0 || y < 0 || x >= l.width || y >= l.height) return undefined
  const atlas = world
    .tryResource(TextureAtlases)
    ?.get(value.atlas as AssetRef<'TextureAtlas'> | null)
  const id = l.get(x, y)
  return { kind: 'tile', tilemap, layer: l.name, x, y, id, tile: data.tileName(id, atlas) ?? null }
}
