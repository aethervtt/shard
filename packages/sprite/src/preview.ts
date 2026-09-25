import type { PreviewImage } from '@shard/assets'

/** Nearest-neighbour fit of RGBA8 pixels into width × height, keeping the aspect ratio. */
export function fitImage(
  src: Uint8Array,
  sw: number,
  sh: number,
  width: number,
  height: number,
): PreviewImage {
  const scale = Math.min(width / sw, height / sh)
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(y / scale))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor(x / scale))
      out.set(src.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out }
}

function put(image: PreviewImage, x: number, y: number, c: readonly number[]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  image.data.set(c, (y * image.width + x) * 4)
}

/** A one-pixel rectangle outline. */
export function outline(
  image: PreviewImage,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly number[],
): void {
  const x0 = Math.round(x)
  const y0 = Math.round(y)
  const x1 = Math.round(x + w) - 1
  const y1 = Math.round(y + h) - 1
  for (let i = x0; i <= x1; i++) {
    put(image, i, y0, color)
    put(image, i, y1, color)
  }
  for (let j = y0; j <= y1; j++) {
    put(image, x0, j, color)
    put(image, x1, j, color)
  }
}

/** A one-pixel line (DDA). */
export function drawLine(
  image: PreviewImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly number[],
): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    put(image, Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t), color)
  }
}

/** 3×5 digits, one row of 3 bits per line, top to bottom. */
const DIGITS = [
  [7, 5, 5, 5, 7],
  [2, 6, 2, 2, 7],
  [7, 1, 7, 4, 7],
  [7, 1, 3, 1, 7],
  [5, 5, 7, 1, 1],
  [7, 4, 7, 1, 7],
  [7, 4, 7, 5, 7],
  [7, 1, 1, 2, 2],
  [7, 5, 7, 5, 7],
  [7, 5, 7, 1, 7],
]

/** Draws a number in a 3×5 pixel font, white on a black box so it reads on any image. */
export function drawLabel(image: PreviewImage, text: string, x: number, y: number): void {
  const w = text.length * 4 + 1
  for (let j = -1; j < 6; j++) for (let i = -1; i < w; i++) put(image, x + i, y + j, [0, 0, 0, 255])
  for (let k = 0; k < text.length; k++) {
    const glyph = DIGITS[text.charCodeAt(k) - 48]
    if (!glyph) continue
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if ((glyph[row]! >> (2 - col)) & 1)
          put(image, x + k * 4 + col, y + row, [255, 255, 255, 255])
      }
    }
  }
}
