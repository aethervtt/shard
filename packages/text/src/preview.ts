import { assetServer, defineAssetPreview } from '@shard/assets'
import { ShardError } from '@shard/core'
import { readKtx2 } from '@shard/texture'
import { Fonts } from './importer'
import { layoutText } from './layout'

const SPECIMEN = [
  'AaBbCcDdEeFfGg 0123456789',
  'The quick brown fox jumps over the lazy dog.',
  'Sharp at any size — ÀÉÎõü ?!&@',
]

/** A font specimen: sample lines at 16, 32, and 64 px, rendered from the distance field on the CPU. */
defineAssetPreview('Font', async (world, path, width, height) => {
  const server = assetServer(world)
  await server.whenSettled([path])
  const font = world.resource(Fonts).get(server.resolve(path) as never)
  if (!font) throw new ShardError('text/not-loaded', `${path} isn't loaded`, { path })
  // Page pixels: runtime pages keep theirs; imported ones come from their artifact.
  const pages = await Promise.all(
    font.pages.map(async (page, i) => {
      if (page.texture?.levels)
        return { w: page.width, h: page.height, data: page.texture.levels[0]! }
      const ktx = readKtx2(
        (await server.artifact(`${path}#${i === 0 ? 'Atlas' : `Atlas/${i}`}`)).bytes!,
      )
      return { w: ktx.width, h: ktx.height, data: ktx.levels[0]! }
    }),
  )
  const out = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) out.set([24, 26, 32, 255], p * 4)
  let baseline = 8
  for (const px of [16, 32, 64]) {
    for (const line of SPECIMEN) {
      baseline += px * 1.25
      if (baseline > height) break
      const layout = layoutText(font, line, { size: px, anchor: [0, 0] })
      for (let q = 0; q < layout.count; q++) {
        const page = pages[layout.pages[layout.page[q]!]!.index]
        if (!page) continue
        const gFont = layout.glyphs[q]!.font
        const screenRange = gFont.range * (px / gFont.size)
        const [x, y, w, h] = layout.quads.subarray(q * 4, q * 4 + 4)
        const [u0, v0, u1, v1] = layout.uvs.subarray(q * 4, q * 4 + 4)
        for (let j = Math.floor(baseline - y! - h!); j < Math.ceil(baseline - y!); j++) {
          if (j < 0 || j >= height) continue
          for (let i = Math.floor(8 + x!); i < Math.ceil(8 + x! + w!); i++) {
            if (i < 0 || i >= width) continue
            const fu = (i + 0.5 - 8 - x!) / w!
            const fv = (j + 0.5 - (baseline - y! - h!)) / h!
            const sd = sample(page, u0! + (u1! - u0!) * fu, v0! + (v1! - v0!) * fv)
            const a = Math.min(1, Math.max(0, screenRange * (sd - 0.5) + 0.5))
            const o = (j * width + i) * 4
            for (let k = 0; k < 3; k++) out[o + k] = Math.round(out[o + k]! * (1 - a) + 240 * a)
          }
        }
      }
    }
  }
  return { width, height, data: out }
})

/** Bilinear median of the three distance channels at a uv. */
function sample(page: { w: number; h: number; data: Uint8Array }, u: number, v: number): number {
  const x = Math.min(page.w - 1, Math.max(0, u * page.w - 0.5))
  const y = Math.min(page.h - 1, Math.max(0, v * page.h - 0.5))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(page.w - 1, x0 + 1)
  const y1 = Math.min(page.h - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const c = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const at = (px: number, py: number) => page.data[(py * page.w + px) * 4 + k]! / 255
    c[k] =
      (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
      (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
  }
  return Math.max(Math.min(c[0]!, c[1]!), Math.min(Math.max(c[0]!, c[1]!), c[2]!))
}
