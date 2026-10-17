import { ShardError } from '@aethervtt/shard-core'
import { buildMips, type Image, resizeImage, Texture } from '@aethervtt/shard-texture'

export interface CardImage {
  id: string
  image: Image
}
export interface CardTexturePage {
  texture: Texture
  indices: ReadonlyMap<string, number>
  aspects: readonly number[]
}

/** Cold-path preparation; layer zero is neutral. Images never bleed across mip boundaries. */
export function prepareCardTextures(
  images: readonly CardImage[],
  options: { width?: number; height?: number; mask?: boolean; budgetMiB?: number } = {},
): CardTexturePage {
  const width = options.width ?? 512,
    height = options.height ?? 720
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384
  ) {
    throw new ShardError(
      'cards/texture-size',
      'Texture page dimensions must be integers between 1 and 16384',
    )
  }
  const indices = new Map<string, number>()
  const unique: CardImage[] = []
  for (const image of images)
    if (!indices.has(image.id)) {
      indices.set(image.id, unique.length + 1)
      unique.push(image)
    }
  const layers = unique.length + 1
  let bytes = 0
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    bytes += w * h * 4 * layers
    if (w === 1 && h === 1) break
  }
  if (bytes > (options.budgetMiB ?? 64) * 1024 * 1024 || layers > 256) {
    throw new ShardError('cards/texture-budget', 'Prepared card textures exceed the page budget', {
      hint: 'Use a visible subset or a smaller resolution; prepare an inspection page separately.',
    })
  }
  const usage = options.mask ? 'data' : 'color'
  const mips: Uint8Array[] = []
  const aspects = [width / height]
  for (let layer = 0; layer < layers; layer++) {
    const item = unique[layer - 1]
    const image: Image = item
      ? resizeImage(item.image, width, height)
      : { width, height, kind: 'u8', data: new Uint8Array(width * height * 4).fill(255) }
    if (item) aspects.push(item.image.width / item.image.height)
    const chain = buildMips(image, {
      usage,
      mipmaps: true,
      maxSize: 16384,
      flipY: false,
      premultiplyAlpha: false,
    })
    for (let level = 0; level < chain.levels.length; level++) {
      const data = chain.levels[level] as Uint8Array
      mips[level] ??= new Uint8Array(data.length * layers)
      mips[level]!.set(data, layer * data.length)
    }
  }
  return { texture: Texture.create({ width, height, layers, usage, mips }), indices, aspects }
}
