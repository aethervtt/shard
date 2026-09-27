import type { PreviewImage } from '@aethervtt/shard-protocol'

// 5×7 glyphs, one row per string, '#' set: enough for "seed 12" and param labels.
const GLYPHS: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  d: ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}

/** Writes `text` at (x, y) in white on a dark box, each glyph pixel `scale` pixels wide. */
export function drawLabel(
  image: PreviewImage,
  text: string,
  x: number,
  y: number,
  scale = 2,
): void {
  const glyphW = 6 * scale
  const w = text.length * glyphW + 2 * scale
  const h = 9 * scale
  const set = (px: number, py: number, v: number, a: number) => {
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) return
    const i = (py * image.width + px) * 4
    for (let c = 0; c < 3; c++) image.data[i + c] = Math.round(image.data[i + c]! * (1 - a) + v * a)
    image.data[i + 3] = 255
  }
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) set(x + px, y + py, 0, 0.6)
  for (let k = 0; k < text.length; k++) {
    const glyph = GLYPHS[text[k]!] ?? GLYPHS[' ']!
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row]![col] !== '#') continue
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++)
            set(x + scale + k * glyphW + col * scale + sx, y + scale + row * scale + sy, 255, 1)
      }
    }
  }
}

/** Lays images out in a grid (`columns` wide), each in a `cell`×`cell` slot, centred. */
export function contactSheet(
  images: readonly PreviewImage[],
  labels: readonly string[],
  cell: number,
  columns = Math.ceil(Math.sqrt(images.length)),
): PreviewImage {
  const rows = Math.ceil(images.length / columns)
  const gap = 2
  const width = columns * cell + (columns + 1) * gap
  const height = rows * cell + (rows + 1) * gap
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 24
    data[i + 1] = 26
    data[i + 2] = 30
    data[i + 3] = 255
  }
  const sheet: PreviewImage = { width, height, data }
  images.forEach((img, n) => {
    const cx = gap + (n % columns) * (cell + gap)
    const cy = gap + Math.floor(n / columns) * (cell + gap)
    const ox = cx + ((cell - img.width) >> 1)
    const oy = cy + ((cell - img.height) >> 1)
    for (let y = 0; y < img.height; y++) {
      const row = img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4)
      data.set(row, ((oy + y) * width + ox) * 4)
    }
    const label = labels[n]
    if (label) drawLabel(sheet, label, cx + 4, cy + 4, cell >= 192 ? 2 : 1)
  })
  return sheet
}

/** Parses `3`, `1-9`, or `1,4,9` into seeds. */
export function parseSeeds(spec: string | readonly number[]): number[] {
  if (Array.isArray(spec)) return spec.map((n) => n >>> 0)
  const out: number[] = []
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    for (let s = Math.min(a, b); s <= Math.max(a, b) && out.length < 64; s++) out.push(s)
  }
  return out
}
