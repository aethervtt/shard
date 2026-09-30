import type { AssetRef, World } from '@aethervtt/shard-core'
import { MaterialAsset, Materials } from '@aethervtt/shard-render'
import { packMetallicRoughness, Texture, Textures } from '@aethervtt/shard-texture'

// A procedural brick material (0066), for tests and demos of textured structure: running-bond
// courses, per-brick colour variation, recessed mortar in the normal map, rougher mortar. One
// texture tile holds two bricks across and four courses up, so its size in metres follows the
// brick size, and the material's slot scale maps structure's metre UVs onto it.

export interface BrickOptions {
  seed?: number
  /** Brick length and height, metres. Default 0.4 × 0.2 (a VTT-scale block). */
  brick?: [number, number]
  /** Mortar joint width, metres. Default 0.025. */
  mortar?: number
  /** Brick colour (linear) and how much each brick varies from it. */
  color?: [number, number, number]
  variation?: number
  mortarColor?: [number, number, number]
  /** Texels across one tile. Default 512. */
  resolution?: number
}

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const toSrgb = (c: number) =>
  Math.round(255 * Math.min(1, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))

/** The brick textures (albedo, normal, roughness), and the tile's size in metres. */
export function brickTextures(options: BrickOptions = {}) {
  const seed = options.seed ?? 1
  const [bw, bh] = options.brick ?? [0.4, 0.2]
  const mortar = options.mortar ?? 0.025
  const color = options.color ?? [0.36, 0.13, 0.07]
  const variation = options.variation ?? 0.25
  const mortarColor = options.mortarColor ?? [0.42, 0.4, 0.36]
  const res = options.resolution ?? 512
  const tileW = bw * 2
  const tileH = bh * 4
  const w = res
  const h = Math.max(4, Math.round((res * tileH) / tileW))
  const height = new Float32Array(w * h)
  const albedo = new Uint8Array(w * h * 4)
  const rough = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    // Image row 0 is the top of the tile; courses count up from the bottom.
    const y = ((h - row - 0.5) / h) * tileH
    const course = Math.floor(y / bh)
    const shift = course % 2 === 1 ? bw / 2 : 0
    for (let col = 0; col < w; col++) {
      const x = ((col + 0.5) / w) * tileW
      const bx = x + shift
      const brick = Math.floor(bx / bw)
      const fx = bx - brick * bw
      const fy = y - course * bh
      // Distance into the brick from its nearest edge, less half a joint.
      const edge = Math.min(fx, bw - fx, fy, bh - fy) - mortar / 2
      const inBrick = edge > 0
      // A bevel into the joint, and a little surface noise on the brick face.
      const bevel = Math.min(1, Math.max(0, edge / (mortar * 0.8)))
      const noise = hash(col, row, seed + 7) * 0.08
      const i = row * w + col
      height[i] = inBrick ? 0.6 + 0.4 * bevel + noise * bevel : hash(col, row, seed + 11) * 0.05
      // Brick ids wrap with the tile (two across): the tile repeats seamlessly.
      const id = ((brick % 2) + 2) % 2
      const tint = 1 + (hash(id, course % 4, seed) - 0.5) * 2 * variation
      const speck = 1 + (hash(col, row, seed + 3) - 0.5) * 0.12
      const c = inBrick ? color.map((v) => v * tint * speck) : mortarColor.map((v) => v * speck)
      albedo[i * 4] = toSrgb(c[0]!)
      albedo[i * 4 + 1] = toSrgb(c[1]!)
      albedo[i * 4 + 2] = toSrgb(c[2]!)
      albedo[i * 4 + 3] = 255
      const r = inBrick ? 0.78 + noise : 0.95
      rough[i * 4] = Math.round(255 * Math.min(1, r))
    }
  }
  // Normals from the height field (OpenGL convention: +y toward the top of the image).
  const normal = new Uint8Array(w * h * 4)
  const strength = 2.5
  const at = (c: number, r: number) => height[((r + h) % h) * w + ((c + w) % w)]!
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const dx = (at(col + 1, row) - at(col - 1, row)) * strength
      const dUp = (at(col, row - 1) - at(col, row + 1)) * strength
      const l = Math.sqrt(dx * dx + dUp * dUp + 1)
      const i = (row * w + col) * 4
      normal[i] = Math.round(((-dx / l) * 0.5 + 0.5) * 255)
      normal[i + 1] = Math.round(((-dUp / l) * 0.5 + 0.5) * 255)
      normal[i + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255)
      normal[i + 3] = 255
    }
  }
  return {
    albedo: Texture.create({ width: w, height: h, usage: 'color', mips: [albedo], mipmaps: true }),
    normal: Texture.create({ width: w, height: h, usage: 'normal', mips: [normal], mipmaps: true }),
    metallicRoughness: packMetallicRoughness({ width: w, height: h, kind: 'u8', data: rough }),
    tile: [tileW, tileH] as [number, number],
  }
}

/**
 * A brick material: its textures in the world's Textures store, tiled so one brick is
 * `options.brick` metres on structure's metre UVs.
 */
export function brickMaterial(world: World, options: BrickOptions = {}): AssetRef<'Material'> {
  const t = brickTextures(options)
  const textures = world.resource(Textures)
  const name = `bricks/${options.seed ?? 1}`
  const slot = (texture: Texture, suffix: string) => ({
    texture: textures.add(texture, `${name}/${suffix}`),
    scale: [1 / t.tile[0], 1 / t.tile[1]],
    wrap: 'repeat',
  })
  return world.resource(Materials).add(
    new MaterialAsset({
      baseColor: [1, 1, 1, 1],
      roughness: 1,
      metallic: 0,
      baseColorTexture: slot(t.albedo, 'albedo'),
      normalTexture: slot(t.normal, 'normal'),
      metallicRoughnessTexture: slot(t.metallicRoughness, 'roughness'),
    }),
    name,
  ) as AssetRef<'Material'>
}
