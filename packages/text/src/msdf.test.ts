import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packRects } from '@aethervtt/shard-texture'
import { describe, expect, it } from 'vitest'
import { blitMsdf, generateMsdf, msdfBox, prepareShape } from './msdf'
import {
  EdgeColor,
  linear,
  type OutlineCommand,
  type Shape,
  shapeBounds,
  shapeFromCommands,
} from './shape'
import { FontSource, type GlyphBitmap, rasterizeGlyph } from './source'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const inter = new FontSource(new Uint8Array(readFileSync(resolve(fixtures, 'Inter-Regular.ttf'))))
const interCff = new FontSource(
  new Uint8Array(readFileSync(resolve(fixtures, 'Inter-Regular-ascii.otf'))),
)

/** An independent reference: the outline flattened to polygons, nonzero fill at a point. */
function referenceFill(commands: readonly OutlineCommand[]): (x: number, y: number) => boolean {
  const segs: number[] = []
  let sx = 0
  let sy = 0
  let x = 0
  let y = 0
  const line = (x1: number, y1: number) => {
    segs.push(x, y, x1, y1)
    x = x1
    y = y1
  }
  for (const c of commands) {
    if (c.type === 'M') {
      if (x !== sx || y !== sy) line(sx, sy)
      sx = x = c.x
      sy = y = c.y
    } else if (c.type === 'L') line(c.x, c.y)
    else if (c.type === 'Q') {
      const [x0, y0] = [x, y]
      for (let i = 1; i <= 64; i++) {
        const t = i / 64
        const s = 1 - t
        line(
          s * s * x0 + 2 * s * t * c.x1 + t * t * c.x,
          s * s * y0 + 2 * s * t * c.y1 + t * t * c.y,
        )
      }
    } else if (c.type === 'C') {
      const [x0, y0] = [x, y]
      for (let i = 1; i <= 64; i++) {
        const t = i / 64
        const s = 1 - t
        line(
          s * s * s * x0 + 3 * s * s * t * c.x1 + 3 * s * t * t * c.x2 + t * t * t * c.x,
          s * s * s * y0 + 3 * s * s * t * c.y1 + 3 * s * t * t * c.y2 + t * t * t * c.y,
        )
      }
    } else if (x !== sx || y !== sy) line(sx, sy)
  }
  if (x !== sx || y !== sy) line(sx, sy)
  return (px, py) => {
    let winding = 0
    for (let i = 0; i < segs.length; i += 4) {
      const [x0, y0, x1, y1] = [segs[i]!, segs[i + 1]!, segs[i + 2]!, segs[i + 3]!]
      if (y0 <= py !== y1 <= py) {
        const t = (py - y0) / (y1 - y0)
        if (x0 + t * (x1 - x0) > px) winding += y1 > y0 ? 1 : -1
      }
    }
    return winding !== 0
  }
}

const median = (a: number, b: number, c: number) =>
  Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))

/** The bitmap's median at a pixel-space point (x right, y down from the top-left corner). */
function sample(bmp: GlyphBitmap, x: number, y: number): number {
  const fx = Math.min(Math.max(x - 0.5, 0), bmp.width - 1)
  const fy = Math.min(Math.max(y - 0.5, 0), bmp.height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, bmp.width - 1)
  const y1 = Math.min(y0 + 1, bmp.height - 1)
  const tx = fx - x0
  const ty = fy - y0
  const ch = (c: number) => {
    const p = (xx: number, yy: number) => bmp.pixels[(yy * bmp.width + xx) * 4 + c]! / 255
    return (
      (p(x0, y0) * (1 - tx) + p(x1, y0) * tx) * (1 - ty) +
      (p(x0, y1) * (1 - tx) + p(x1, y1) * tx) * ty
    )
  }
  return median(ch(0), ch(1), ch(2))
}

/** Font-unit coordinates of a bitmap pixel-space point. */
function toFont(bmp: GlyphBitmap, size: number, upem: number, x: number, y: number) {
  const plane = bmp.plane!
  // Plane left and top are texel centers, 0.5 px in from the box's corner.
  return [(plane[0] + (x - 0.5) / size) * upem, (plane[3] - (y - 0.5) / size) * upem] as const
}

function agreement(source: FontSource, char: string, size = 48, upscale = 1) {
  const index = source.glyphIndex(char.codePointAt(0)!)
  const commands = source.font.glyphs.get(index).path.commands as OutlineCommand[]
  const fill = referenceFill(commands)
  const bmp = rasterizeGlyph(source.shape(index), source.unitsPerEm, { size, range: 4 })
  let same = 0
  let total = 0
  let inside = 0
  const step = 1 / upscale
  for (let y = step / 2; y < bmp.height; y += step) {
    for (let x = step / 2; x < bmp.width; x += step) {
      const [fx, fy] = toFont(bmp, size, source.unitsPerEm, x, y)
      const want = fill(fx, fy)
      const got = sample(bmp, x, y) > 0.5
      if (want) inside++
      if (want === got) same++
      total++
    }
  }
  return { ratio: same / total, inside, total, bmp }
}

describe('MSDF generation', () => {
  it('thresholds to the outline: median > 0.5 inside, < 0.5 outside (A, O, g, &, @, ‰)', () => {
    for (const char of ['A', 'O', 'g', '&', '@', '‰', 'ß', 'Ø']) {
      const { ratio, inside } = agreement(inter, char)
      expect(inside, char).toBeGreaterThan(50)
      expect(ratio, char).toBeGreaterThan(0.97)
    }
  })

  it('handles cubic (CFF) outlines', () => {
    for (const char of ['A', 'O', 'g', 'S', '&']) {
      const { ratio } = agreement(interCff, char)
      expect(ratio, char).toBeGreaterThan(0.97)
    }
  })

  it('stays sharp when magnified 4x with bilinear sampling', () => {
    for (const char of ['A', 'O', 'g', 'E', 'L', 'W']) {
      const { ratio } = agreement(inter, char, 48, 4)
      expect(ratio, char).toBeGreaterThan(0.97)
    }
  })

  /** Checks points `off` px diagonally from every outline vertex; returns the misclassified count. */
  function cornerErrors(char: string, off: number, singleChannel = false): number {
    const index = inter.glyphIndex(char.codePointAt(0)!)
    const commands = inter.font.glyphs.get(index).path.commands as OutlineCommand[]
    const fill = referenceFill(commands)
    const size = 48
    const upem = inter.unitsPerEm
    let bmp: GlyphBitmap
    if (singleChannel) {
      // One color for every edge: what a single-channel distance field stores.
      const shape = inter.shape(index)
      const bounds = shapeBounds(shape)!
      prepareShape(shape)
      for (const c of shape.contours) for (const e of c.edges) e.color = EdgeColor.white
      const box = msdfBox(bounds, size / upem, 4)
      const sdf = generateMsdf(shape, box, { scale: size / upem, range: 4 })
      const pixels = new Uint8Array(box.width * box.height * 4)
      blitMsdf(sdf, box.width, box.height, pixels, box.width, 0, 0)
      const plane = box.plane.map((v) => v / upem) as [number, number, number, number]
      bmp = { width: box.width, height: box.height, pixels, plane }
    } else {
      bmp = rasterizeGlyph(inter.shape(index), upem, { size, range: 4 })
    }
    const plane = bmp.plane!
    let wrong = 0
    for (const c of commands) {
      if (c.type !== 'M' && c.type !== 'L') continue
      // The vertex in bitmap pixel space.
      const cx = (c.x / upem - plane[0]) * size + 0.5
      const cy = (plane[3] - c.y / upem) * size + 0.5
      for (const [dx, dy] of [
        [off, off],
        [-off, off],
        [off, -off],
        [-off, -off],
      ] as const) {
        const [fx, fy] = toFont(bmp, size, upem, cx + dx, cy + dy)
        if (sample(bmp, cx + dx, cy + dy) > 0.5 !== fill(fx, fy)) wrong++
      }
    }
    return wrong
  }

  it('keeps sharp corners: points 0.15 and 0.3 px from every corner of L, E, T, H classify right', () => {
    for (const char of ['L', 'E', 'T', 'H']) {
      expect(cornerErrors(char, 0.15), char).toBe(0)
      expect(cornerErrors(char, 0.3), char).toBe(0)
    }
  })

  it('a single-channel field rounds those corners (so the corner test means something)', () => {
    expect(cornerErrors('L', 0.15, true)).toBeGreaterThan(4)
  })

  it('fills overlapping contours as their union', () => {
    const square = (l: number, b: number, s: number) => ({
      edges: [
        linear(l, b, l, b + s),
        linear(l, b + s, l + s, b + s),
        linear(l + s, b + s, l + s, b),
        linear(l + s, b, l, b),
      ],
    })
    const shape: Shape = { contours: [square(0.1, 0.1, 10), square(5.1, 5.1, 10)] }
    const scale = 3
    const box = msdfBox([0, 0, 15, 15], scale, 4)
    prepareShape(shape)
    const sdf = generateMsdf(shape, box, { scale, range: 4 })
    let wrong = 0
    for (let y = 0; y < box.height; y++) {
      for (let x = 0; x < box.width; x++) {
        const px = (x + 0.5) / scale - box.tx
        const py = (y + 0.5) / scale - box.ty
        const inside =
          (px > 0.1 && px < 10.1 && py > 0.1 && py < 10.1) ||
          (px > 5.1 && px < 15.1 && py > 5.1 && py < 15.1)
        const o = (y * box.width + x) * 3
        if (median(sdf[o]!, sdf[o + 1]!, sdf[o + 2]!) > 0.5 !== inside) wrong++
      }
    }
    expect(wrong).toBe(0)
  })

  it('colors edges so neighbors across a corner differ, smooth contours one color', () => {
    const shape = inter.shape(inter.glyphIndex('L'.codePointAt(0)!))
    prepareShape(shape)
    const edges = shape.contours[0]!.edges
    for (let i = 0; i < edges.length; i++) {
      const a = edges[i]!.color
      const b = edges[(i + 1) % edges.length]!.color
      // Two channels per edge, one shared across each corner.
      expect([EdgeColor.cyan, EdgeColor.magenta, EdgeColor.yellow]).toContain(a)
      expect(a).not.toBe(b)
    }
    const o = inter.shape(inter.glyphIndex('o'.codePointAt(0)!))
    prepareShape(o)
    for (const c of o.contours) expect(new Set(c.edges.map((e) => e.color)).size).toBe(1)
  })

  it('reads zero-length edges and open contours without breaking', () => {
    const shape = shapeFromCommands([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 0, y: 0 },
      { type: 'L', x: 0, y: 10 },
      { type: 'Q', x1: 10, y1: 10, x: 10, y: 0 },
    ])
    expect(shape.contours).toHaveLength(1)
    expect(shape.contours[0]!.edges.map((e) => e.kind)).toEqual([1, 2, 1])
  })
})

describe('atlas packing', () => {
  it('packs without overlaps onto the smallest power-of-two page, then more pages', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      width: 10 + ((i * 7) % 31),
      height: 12 + ((i * 13) % 29),
    }))
    const one = packRects(items, 2048, 1)
    expect(one.pages).toHaveLength(1)
    const { width, height } = one.pages[0]!
    expect(Math.log2(width) % 1).toBe(0)
    expect(Math.log2(height) % 1).toBe(0)
    const multi = packRects(items, 128, 1)
    expect(multi.pages.length).toBeGreaterThan(1)
    for (const result of [one, multi]) {
      const placed = items.map((it, i) => ({ ...it, ...result.placements[i]! }))
      for (const p of placed) {
        const page = result.pages[p.page]!
        expect(p.x).toBeGreaterThanOrEqual(1)
        expect(p.y).toBeGreaterThanOrEqual(1)
        expect(p.x + p.width + 1).toBeLessThanOrEqual(page.width)
        expect(p.y + p.height + 1).toBeLessThanOrEqual(page.height)
      }
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i]!
          const b = placed[j]!
          if (a.page !== b.page) continue
          const apart =
            a.x + a.width + 1 <= b.x ||
            b.x + b.width + 1 <= a.x ||
            a.y + a.height + 1 <= b.y ||
            b.y + b.height + 1 <= a.y
          expect(apart).toBe(true)
        }
      }
    }
  })
})
