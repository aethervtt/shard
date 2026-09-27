import {
  AssetStore,
  assetServer,
  defineAssetPreview,
  defineAssetType,
  defineDataAsset,
  defineImporter,
  type ImportedAsset,
  type LoadContext,
} from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  defineSchema,
  type JsonValue,
  ShardError,
  t,
} from '@aethervtt/shard-core'
import {
  buildMips,
  decodeImage,
  flipGreen,
  packRects,
  readKtx2,
  writeKtx2,
} from '@aethervtt/shard-texture'
import { alphaOutline } from './outline'
import { drawLabel, drawLine, fitImage, outline } from './preview'

export const TextureAtlasSchema = defineSchema(
  'sprite/TextureAtlas',
  {
    texture: t.handle('Texture', { description: 'The image the regions cut from.' }),
    normals: t.handle('Texture', {
      description:
        'A normal map with the same layout as texture (2D lighting): regions sample it at the same rect.',
    }),
    grid: t.struct(
      {
        columns: t.u32({ description: 'Cells across (0: no grid).' }),
        rows: t.u32({ description: 'Cells down.' }),
        cellWidth: t.u32({ description: 'Cell width in pixels.' }),
        cellHeight: t.u32({ description: 'Cell height in pixels.' }),
        margin: t.u32({ description: 'Pixels before the first cell, on every side.' }),
        spacing: t.u32({ description: 'Pixels between cells.' }),
        prefix: t.string({ default: 'cell', description: 'Region names: prefix0, prefix1, …' }),
      },
      {
        description:
          'A regular sheet: its cells become regions, row by row, before any explicit regions.',
      },
    ),
    regions: t.list(
      t.struct({
        name: t.string({ description: 'Unique name, e.g. "hero/idle_0".' }),
        rect: t.vec4({ min: 0, description: 'x, y, width, height in pixels (y down).' }),
        pivot: t.vec2({
          default: [0.5, 0.5],
          description: 'Default anchor in normalized region space (0, 0 is the top left).',
        }),
        outline: t.list(t.vec2, {
          description:
            "Alpha outline in normalized region space (0, 0 top left), for LightOccluder2d shape 'sprite'. Packed atlases with outlines: true fill it in.",
        }),
      }),
      { description: 'Named rectangles of the texture.' },
    ),
  },
  {
    description:
      'Named regions of one texture, for sprites, animation clips, and tilemaps (tile N is region N − 1).',
  },
)

/**
 * Named pixel rectangles of one texture. Region indices are stable in file order (grid cells
 * first), and tilemaps store them: tile N is region N − 1.
 */
export class TextureAtlas {
  texture: AssetRef<'Texture'> | null
  /** A normal map with the same layout, or null. */
  normals: AssetRef<'Texture'> | null = null
  names: string[]
  /** x, y, width, height per region, in pixels. */
  rects: Float32Array
  /** Default anchor per region (normalized, y down). */
  pivots: Float32Array
  /** Alpha outline per region (normalized x, y pairs, y down), where the atlas has one. */
  outlines: (Float32Array | undefined)[]
  private index: Map<string, number>
  /** Bumps when the regions change (hot reload), so sprites re-read their rects. */
  version = 0

  constructor(
    texture: AssetRef<'Texture'> | null,
    regions: { name: string; rect: number[]; pivot?: number[]; outline?: number[][] }[],
    normals: AssetRef<'Texture'> | null = null,
  ) {
    this.texture = texture
    this.normals = normals
    this.names = regions.map((r) => r.name)
    this.outlines = regions.map((r) =>
      r.outline && r.outline.length >= 3 ? new Float32Array(r.outline.flat()) : undefined,
    )
    this.rects = new Float32Array(regions.length * 4)
    this.pivots = new Float32Array(regions.length * 2)
    this.index = new Map()
    regions.forEach((r, i) => {
      this.rects.set(r.rect.slice(0, 4), i * 4)
      this.pivots[i * 2] = r.pivot?.[0] ?? 0.5
      this.pivots[i * 2 + 1] = r.pivot?.[1] ?? 0.5
      this.index.set(r.name, i)
    })
  }

  get count(): number {
    return this.names.length
  }

  /** A region's index by name, or -1. */
  region(name: string): number {
    return this.index.get(name) ?? -1
  }

  copyFrom(other: TextureAtlas): void {
    this.texture = other.texture
    this.normals = other.normals
    this.outlines = other.outlines
    this.names = other.names
    this.rects = other.rects
    this.pivots = other.pivots
    this.index = other.index
    this.version++
  }

  /** Builds an atlas from its JSON form (`*.atlas.json`), expanding a grid into regions. */
  static fromJson(json: unknown, resolve?: (path: string) => AssetRef | undefined): TextureAtlas {
    const value = TextureAtlasSchema.deserialize(json) as unknown as AtlasValue
    const regions: { name: string; rect: number[]; pivot?: number[]; outline?: number[][] }[] = []
    const g = value.grid
    if (g.columns > 0 && g.rows > 0) {
      for (let row = 0; row < g.rows; row++) {
        for (let col = 0; col < g.columns; col++) {
          regions.push({
            name: `${g.prefix}${row * g.columns + col}`,
            rect: [
              g.margin + col * (g.cellWidth + g.spacing),
              g.margin + row * (g.cellHeight + g.spacing),
              g.cellWidth,
              g.cellHeight,
            ],
          })
        }
      }
    }
    for (const r of value.regions)
      regions.push({ name: r.name, rect: r.rect, pivot: r.pivot, outline: r.outline })
    const names = new Set<string>()
    for (const r of regions) {
      if (names.has(r.name)) {
        throw new ShardError('sprite/duplicate-region', `Region "${r.name}" appears twice`, {
          hint: 'Region names are unique within an atlas.',
        })
      }
      names.add(r.name)
    }
    const ref = value.texture?.path
      ? (resolve?.(value.texture.path) ?? value.texture)
      : value.texture
    const normals = value.normals?.path
      ? (resolve?.(value.normals.path) ?? value.normals)
      : value.normals?.guid
        ? value.normals
        : null
    return new TextureAtlas(
      (ref as AssetRef<'Texture'>) ?? null,
      regions,
      (normals as AssetRef<'Texture'>) ?? null,
    )
  }
}

interface AtlasValue {
  texture: { guid?: string; path?: string } | null
  normals: { guid?: string; path?: string } | null
  grid: {
    columns: number
    rows: number
    cellWidth: number
    cellHeight: number
    margin: number
    spacing: number
    prefix: string
  }
  regions: { name: string; rect: number[]; pivot: number[]; outline: number[][] }[]
}

export class TextureAtlasStore extends AssetStore<TextureAtlas, 'TextureAtlas'> {
  constructor() {
    super('TextureAtlas')
  }
}

export const TextureAtlases = defineResource<TextureAtlasStore>('sprite/TextureAtlases', {
  description: 'Loaded texture atlases by guid.',
  init: () => new TextureAtlasStore(),
})

const resolver = (ctx: LoadContext) => (path: string) => ctx.resolve(path)

export const TextureAtlasAssetType = defineAssetType<TextureAtlas>('TextureAtlas', {
  store: TextureAtlases,
  load: (artifact, ctx) => TextureAtlas.fromJson(artifact.json, resolver(ctx)),
  update: (existing, next) => existing.copyFrom(next),
})

/** `*.atlas.json`: regions written by hand, or a grid. */
export const TextureAtlasImporter = defineDataAsset('TextureAtlas', TextureAtlasSchema, {
  extension: 'atlas',
})

// --- packing ---------------------------------------------------------------------------------

export const AtlasPackSchema = defineSchema(
  'sprite/AtlasPack',
  {
    folder: t.string({
      description:
        'Folder of images to pack, relative to this file. Empty: the folder named like this file (hero.atlas-pack.json packs hero/).',
    }),
    padding: t.u32({ default: 2, max: 16, description: 'Pixels between regions.' }),
    extrude: t.u32({
      default: 1,
      max: 16,
      description:
        "Edge pixels repeated outward (at most the padding), so filtering doesn't bleed.",
    }),
    maxSize: t.u32({ default: 4096, min: 64, max: 16384, description: 'Largest texture side.' }),
    mipmaps: t.bool({ description: 'Generate mips (off: sprites are usually drawn near 1:1).' }),
    outlines: t.bool({
      description:
        "Trace each region's alpha outline (at most 32 points) for LightOccluder2d shape 'sprite'.",
    }),
    normalMap: t.enum(['opengl', 'directx'], {
      description:
        'Convention of the name_n.png normal-map companions: opengl (+Y up) or directx (green flipped on import).',
    }),
  },
  {
    description:
      'Packs a folder of images into one power-of-two atlas texture (premultiplied alpha). Regions are named after the files. name_n.png companions pack into a matching normal-map page (2D lighting).',
  },
)

const IMAGE = /\.(png|jpe?g|webp)$/i

const srgbToLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
const linearToSrgb = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

/**
 * Packs images into one texture: premultiplied (in linear light, then encoded back to sRGB), with
 * `extrude` edge pixels copied outward. Returns the pixels and each image's rect.
 */
export function packImages(
  images: { name: string; width: number; height: number; data: Uint8Array }[],
  options: { padding: number; extrude: number; maxSize: number },
): { width: number; height: number; data: Uint8Array; rects: number[][] } {
  const padding = options.padding
  const extrude = Math.min(options.extrude, padding)
  let packed: ReturnType<typeof packRects>
  try {
    packed = packRects(images, options.maxSize, padding)
  } catch (cause) {
    throw new ShardError('sprite/atlas-too-large', (cause as Error).message, {
      hint: 'Raise maxSize, or split the images into several atlases.',
    })
  }
  if (packed.pages.length > 1) {
    throw new ShardError(
      'sprite/atlas-too-large',
      `${images.length} images need ${packed.pages.length} ${options.maxSize}px pages`,
      { hint: 'Raise maxSize, or split the images into several atlases.' },
    )
  }
  const { width, height } = packed.pages[0] ?? { width: 1, height: 1 }
  const data = new Uint8Array(width * height * 4)
  const rects: number[][] = []
  images.forEach((img, i) => {
    const p = packed.placements[i]!
    rects.push([p.x, p.y, img.width, img.height])
    for (let y = -extrude; y < img.height + extrude; y++) {
      const sy = Math.min(img.height - 1, Math.max(0, y))
      for (let x = -extrude; x < img.width + extrude; x++) {
        const sx = Math.min(img.width - 1, Math.max(0, x))
        const s = (sy * img.width + sx) * 4
        const d = ((p.y + y) * width + p.x + x) * 4
        const a = img.data[s + 3]! / 255
        data[d] = linearToSrgb(srgbToLinear[img.data[s]!]! * a)
        data[d + 1] = linearToSrgb(srgbToLinear[img.data[s + 1]!]! * a)
        data[d + 2] = linearToSrgb(srgbToLinear[img.data[s + 2]!]! * a)
        data[d + 3] = img.data[s + 3]!
      }
    }
  })
  return { width, height, data, rects }
}

/**
 * A normal-map page with the same layout as a packed atlas: each companion at its image's rect,
 * edges extruded, and a flat normal everywhere else (regions without a companion light flat).
 */
export function packNormals(
  width: number,
  height: number,
  rects: number[][],
  normals: ({ width: number; height: number; data: Uint8Array } | undefined)[],
  extrude: number,
): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) data.set(FLAT_NORMAL, p * 4)
  normals.forEach((img, i) => {
    if (!img) return
    const [px, py] = rects[i]!
    for (let y = -extrude; y < img.height + extrude; y++) {
      const sy = Math.min(img.height - 1, Math.max(0, y))
      for (let x = -extrude; x < img.width + extrude; x++) {
        const sx = Math.min(img.width - 1, Math.max(0, x))
        const s = (sy * img.width + sx) * 4
        const d = ((py! + y) * width + px! + x) * 4
        data[d] = img.data[s]!
        data[d + 1] = img.data[s + 1]!
        data[d + 2] = img.data[s + 2]!
        data[d + 3] = 255
      }
    }
  })
  return data
}

const FLAT_NORMAL = [128, 128, 255, 255]

/** A region's alpha outline, normalized to its size (x, y pairs, y down), as JSON points. */
export function regionOutline(img: {
  width: number
  height: number
  data: Uint8Array
}): number[][] {
  const flat = alphaOutline(
    img.width,
    img.height,
    (x, y) => img.data[(y * img.width + x) * 4 + 3]! / 255,
  )
  const out: number[][] = []
  for (let k = 0; k < flat.length; k += 2) {
    out.push([
      Math.round((flat[k]! / img.width) * 1e5) / 1e5,
      Math.round((flat[k + 1]! / img.height) * 1e5) / 1e5,
    ])
  }
  return out
}

const COMPANION = /_n$/

/**
 * `*.atlas-pack.json`: packs a folder of images into an atlas and its texture (`#Texture`), plus a
 * normal-map page (`#Normals`) when images have `name_n.png` companions.
 */
export const AtlasPackImporter = defineImporter({
  name: 'atlas-pack',
  version: 1,
  extensions: ['.atlas-pack.json'],
  settings: defineSchema(
    'sprite/AtlasPackSettings',
    {},
    { description: 'None: options live in the file.' },
  ),
  async import(source, ctx) {
    let json: unknown
    try {
      json = source.text().trim() ? JSON.parse(source.text()) : {}
    } catch (cause) {
      throw new ShardError('assets/import-failed', `${source.path} isn't valid JSON`, {
        path: source.path,
        cause,
      })
    }
    const errors = AtlasPackSchema.validate(json)
    if (errors.length > 0) {
      throw new ShardError('assets/import-failed', `${source.path}: ${errors[0]!.message}`, {
        path: errors[0]!.path,
        details: errors,
      })
    }
    const options = AtlasPackSchema.deserialize(json) as {
      folder: string
      padding: number
      extrude: number
      maxSize: number
      mipmaps: boolean
      outlines: boolean
      normalMap: 'opengl' | 'directx'
    }
    const base = source.path
      .split('/')
      .pop()!
      .replace(/\.atlas-pack\.json$/i, '')
    const folder = options.folder || base
    const files = (await ctx.list(folder)).filter((f) => IMAGE.test(f))
    if (files.length === 0) {
      ctx.warn(`No images in ${ctx.resolve(folder)}; the atlas is empty.`)
    }
    const images = []
    const companions = new Map<
      string,
      { width: number; height: number; data: Uint8Array; file: string }
    >()
    for (const file of files) {
      const image = await decodeImage(await ctx.read(file))
      if (image.kind !== 'u8') {
        throw new ShardError('sprite/unsupported-image', `${file}: HDR images can't be packed`, {
          path: file,
        })
      }
      const name = file.split('/').pop()!.replace(IMAGE, '')
      const entry = {
        name,
        width: image.width,
        height: image.height,
        data: image.data as Uint8Array,
      }
      if (COMPANION.test(name)) {
        const img = options.normalMap === 'directx' ? flipGreen(image) : image
        companions.set(name.replace(COMPANION, ''), {
          width: img.width,
          height: img.height,
          data: img.data as Uint8Array,
          file,
        })
      } else images.push(entry)
    }
    images.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const normals = images.map((img) => {
      const n = companions.get(img.name)
      if (n && (n.width !== img.width || n.height !== img.height)) {
        throw new ShardError(
          'texture/normal-map-mismatch',
          `${n.file} is ${n.width}×${n.height}, but ${img.name} is ${img.width}×${img.height}`,
          { path: n.file, hint: 'A normal-map companion must match its image pixel for pixel.' },
        )
      }
      return n
    })
    for (const name of companions.keys()) {
      if (!images.some((img) => img.name === name)) {
        ctx.warn(`${name}_n has no ${name} image to pair with; it isn't packed.`)
      }
    }
    const packed = packImages(images, options)
    const chain = buildMips(
      { width: packed.width, height: packed.height, kind: 'u8', data: packed.data },
      {
        usage: 'color',
        mipmaps: options.mipmaps,
        maxSize: 16384,
        flipY: false,
        premultiplyAlpha: false,
      },
    )
    const regions: JsonValue[] = images.map((img, i) => ({
      name: img.name,
      rect: packed.rects[i]!,
      pivot: [0.5, 0.5],
      ...(options.outlines ? { outline: regionOutline(img) } : {}),
    }))
    const hasNormals = normals.some((n) => n !== undefined)
    const extra: ImportedAsset[] = []
    if (hasNormals) {
      const page = packNormals(
        packed.width,
        packed.height,
        packed.rects,
        normals,
        Math.min(options.extrude, options.padding),
      )
      const normalChain = buildMips(
        { width: packed.width, height: packed.height, kind: 'u8', data: page },
        {
          usage: 'normal',
          mipmaps: options.mipmaps,
          maxSize: 16384,
          flipY: false,
          premultiplyAlpha: false,
        },
      )
      extra.push({
        label: 'Normals',
        type: 'Texture',
        bytes: writeKtx2(normalChain, 'normal', 1, false),
        info: {
          width: packed.width,
          height: packed.height,
          usage: 'normal',
          companions: normals.filter(Boolean).length,
        } as Record<string, JsonValue>,
      })
    }
    return {
      assets: [
        {
          label: '',
          type: 'TextureAtlas',
          json: {
            texture: { path: '#Texture' },
            ...(hasNormals ? { normals: { path: '#Normals' } } : {}),
            regions,
          } as JsonValue,
          dependencies: hasNormals ? ['#Texture', '#Normals'] : ['#Texture'],
          info: {
            regions: images.length,
            size: `${packed.width}x${packed.height}`,
            folder: ctx.resolve(folder),
            normals: hasNormals,
            outlines: options.outlines,
          } as Record<string, JsonValue>,
        },
        {
          label: 'Texture',
          type: 'Texture',
          bytes: writeKtx2(chain, 'color', 1, true),
          info: {
            width: packed.width,
            height: packed.height,
            usage: 'color',
            premultiplied: true,
            mips: chain.levels.length,
          } as Record<string, JsonValue>,
        },
        ...extra,
      ],
    }
  },
})

// --- preview -----------------------------------------------------------------------------------

/**
 * The atlas texture with each region outlined and labeled with its index, and its alpha outline
 * (green) where it has one. An atlas with normals shows albedo and normals side by side.
 */
export const textureAtlasPreview = defineAssetPreview(
  'TextureAtlas',
  async (world, path, width, height) => {
    const server = assetServer(world)
    const artifact = await server.artifact(path)
    const atlas = TextureAtlas.fromJson(artifact.json)
    const pathOf = (ref: { path?: string } | null) =>
      ref?.path?.startsWith('#') ? `${path.split('#')[0]}${ref.path}` : ref?.path
    const texturePath = pathOf(atlas.texture)
    if (!texturePath) {
      throw new ShardError('sprite/no-texture', `${path} has no texture`, { path: '/texture' })
    }
    const ktx = readKtx2((await server.artifact(texturePath)).bytes!)
    const normalsPath = pathOf(atlas.normals)
    const nktx = normalsPath ? readKtx2((await server.artifact(normalsPath)).bytes!) : undefined
    // Side by side: albedo on the left, normals on the right, with a 4-pixel gap.
    const sw = nktx ? ktx.width * 2 + 4 : ktx.width
    const src = new Uint8Array(sw * ktx.height * 4)
    for (let y = 0; y < ktx.height; y++) {
      src.set(ktx.levels[0]!.subarray(y * ktx.width * 4, (y + 1) * ktx.width * 4), y * sw * 4)
      if (nktx && nktx.width === ktx.width && nktx.height === ktx.height) {
        src.set(
          nktx.levels[0]!.subarray(y * ktx.width * 4, (y + 1) * ktx.width * 4),
          (y * sw + ktx.width + 4) * 4,
        )
      }
    }
    const image = fitImage(src, sw, ktx.height, width, height)
    const scale = image.width / sw
    const panels = nktx ? [0, ktx.width + 4] : [0]
    for (const ox of panels) {
      for (let i = 0; i < atlas.count; i++) {
        const [x, y, w, h] = atlas.rects.subarray(i * 4, i * 4 + 4)
        outline(image, (x! + ox) * scale, y! * scale, w! * scale, h! * scale, [255, 0, 180, 255])
        const o = atlas.outlines[i]
        if (o) {
          const n = o.length / 2
          for (let k = 0; k < n; k++) {
            const j = (k + 1) % n
            drawLine(
              image,
              (x! + ox + o[k * 2]! * w!) * scale,
              (y! + o[k * 2 + 1]! * h!) * scale,
              (x! + ox + o[j * 2]! * w!) * scale,
              (y! + o[j * 2 + 1]! * h!) * scale,
              [40, 255, 90, 255],
            )
          }
        }
        if (ox === 0)
          drawLabel(image, String(i), Math.round(x! * scale) + 2, Math.round(y! * scale) + 2)
      }
    }
    return image
  },
)
