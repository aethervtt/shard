/**
 * Skyline bottom-left rectangle packing (y down: "bottom" is the lowest top edge). Each rectangle
 * is placed where its top edge sits highest, ties going left.
 */
export class SkylinePacker {
  readonly width: number
  readonly height: number
  /** Skyline segments: x, y (top of the free space), width. */
  private xs: number[] = [0]
  private ys: number[] = [0]
  private ws: number[]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.ws = [width]
  }

  /** Places a w×h rectangle; returns its top-left, or undefined when it doesn't fit. */
  insert(w: number, h: number): { x: number; y: number } | undefined {
    let bestY = Infinity
    let bestX = 0
    let bestIndex = -1
    let bestWaste = Infinity
    for (let i = 0; i < this.xs.length; i++) {
      const x = this.xs[i]!
      if (x + w > this.width) break
      // The rectangle rests on the highest segment it spans.
      let y = 0
      let covered = 0
      let j = i
      while (covered < w) {
        y = Math.max(y, this.ys[j]!)
        covered += this.ws[j]!
        j++
      }
      if (y + h > this.height) continue
      let waste = 0
      covered = 0
      for (let k = i; k < j; k++) {
        const segW = Math.min(this.ws[k]!, w - covered)
        waste += (y - this.ys[k]!) * segW
        covered += segW
      }
      if (y < bestY || (y === bestY && waste < bestWaste)) {
        bestY = y
        bestX = x
        bestIndex = i
        bestWaste = waste
      }
    }
    if (bestIndex < 0) return undefined
    this.place(bestIndex, bestX, bestY + h, w)
    return { x: bestX, y: bestY }
  }

  private place(index: number, x: number, top: number, w: number): void {
    const end = x + w
    // Remove the segments the new one covers; trim a partially covered last one.
    const i = index
    while (i < this.xs.length && this.xs[i]! < end) {
      const segEnd = this.xs[i]! + this.ws[i]!
      if (segEnd <= end) {
        this.xs.splice(i, 1)
        this.ys.splice(i, 1)
        this.ws.splice(i, 1)
      } else {
        this.ws[i] = segEnd - end
        this.xs[i] = end
        break
      }
    }
    this.xs.splice(index, 0, x)
    this.ys.splice(index, 0, top)
    this.ws.splice(index, 0, w)
    // Merge neighbors at the same height.
    for (let k = 0; k < this.xs.length - 1; k++) {
      if (this.ys[k] === this.ys[k + 1]) {
        this.ws[k] = this.ws[k]! + this.ws[k + 1]!
        this.xs.splice(k + 1, 1)
        this.ys.splice(k + 1, 1)
        this.ws.splice(k + 1, 1)
        k--
      }
    }
  }
}

export interface PackItem {
  width: number
  height: number
}

export interface PackResult {
  pages: { width: number; height: number }[]
  /** Per item: page, x, y (top-left, in pixels, padding already applied). */
  placements: { page: number; x: number; y: number }[]
}

function tryPack(
  items: readonly PackItem[],
  order: readonly number[],
  w: number,
  h: number,
  padding: number,
  placements: PackResult['placements'],
  page: number,
  partial: boolean,
): number[] {
  const packer = new SkylinePacker(w, h)
  const left: number[] = []
  for (const i of order) {
    const item = items[i]!
    const spot = packer.insert(item.width + padding * 2, item.height + padding * 2)
    if (!spot) {
      if (!partial) return order.slice()
      left.push(i)
      continue
    }
    placements[i] = { page, x: spot.x + padding, y: spot.y + padding }
  }
  return left
}

/**
 * Packs items onto the fewest power-of-two pages no larger than `maxSize`: the smallest page that
 * fits everything left, else a full `maxSize` page and repeat. Padding surrounds every item.
 */
export function packRects(items: readonly PackItem[], maxSize = 2048, padding = 1): PackResult {
  const placements: PackResult['placements'] = new Array(items.length)
  const pages: PackResult['pages'] = []
  let remaining = items
    .map((_, i) => i)
    .sort((a, b) => items[b]!.height - items[a]!.height || items[b]!.width - items[a]!.width)
  for (const i of remaining) {
    const it = items[i]!
    if (it.width + padding * 2 > maxSize || it.height + padding * 2 > maxSize) {
      throw new RangeError(`A ${it.width}x${it.height} item doesn't fit a ${maxSize} page`)
    }
  }
  while (remaining.length > 0) {
    let area = 0
    let maxW = 0
    let maxH = 0
    for (const i of remaining) {
      const it = items[i]!
      area += (it.width + padding * 2) * (it.height + padding * 2)
      maxW = Math.max(maxW, it.width + padding * 2)
      maxH = Math.max(maxH, it.height + padding * 2)
    }
    let packed = false
    // Candidate sizes in area order: 64², 128×64, 128², …, up to maxSize².
    for (let s = 64; s <= maxSize && !packed; s *= 2) {
      for (const [w, h] of [
        [s, s / 2],
        [s, s],
      ] as const) {
        if (h < 32 || w * h < area || w < maxW || h < maxH || h > maxSize) continue
        const left = tryPack(items, remaining, w, h, padding, placements, pages.length, false)
        if (left.length === 0) {
          pages.push({ width: w, height: h })
          packed = true
          break
        }
      }
    }
    if (packed) break
    const left = tryPack(
      items,
      remaining,
      maxSize,
      maxSize,
      padding,
      placements,
      pages.length,
      true,
    )
    pages.push({ width: maxSize, height: maxSize })
    remaining = left
  }
  return { pages, placements }
}
