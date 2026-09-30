import { ShardError } from '@aethervtt/shard-core'

// The authored tilemap format (0059). Version 2 names tiles through a palette of atlas region
// names, so re-packing an atlas never changes a map, and stores cells either as `rows` (chunked,
// run-length, one short line per tile row: an edit is a one-line diff) or as `base64` (compact,
// for large generated maps). Version 1 (base64 of atlas region indices, no palette) still loads.

/** Tile flag bits (shared with the renderer). */
export const TILE_FLAG_NAMES = { fx: 1, fy: 2, r90: 4 } as const

export type TileEncoding = 'rows' | 'base64'

/** What a layer's cells are in memory: tile ids (palette index + 1, 0 empty) and flag bits. */
export interface CellGrid {
  width: number
  height: number
  tiles: Uint16Array
  flags: Uint8Array
}

function invalid(message: string, path: string, hint?: string): ShardError {
  return new ShardError('sprite/invalid-tilemap', message, {
    path,
    hint:
      hint ??
      'Rows are space-separated runs of name[:flags][*count]; flags are fx, fy and r90 joined by +; "." is an empty cell.',
  })
}

/** Whether a palette name can be written in rows (no spaces or the run syntax's characters). */
export function rowsCanName(name: string): boolean {
  return name.length > 0 && name !== '.' && !/[\s:*+]/.test(name)
}

function flagText(flags: number): string {
  const parts: string[] = []
  if (flags & 1) parts.push('fx')
  if (flags & 2) parts.push('fy')
  if (flags & 4) parts.push('r90')
  return parts.join('+')
}

/** The rows of one chunk: `chunkSize` cells a row at most, rows from the top. Undefined if empty. */
export function chunkRows(
  grid: CellGrid,
  palette: readonly string[],
  cx: number,
  cy: number,
  chunkSize: number,
): string[] | undefined {
  const x0 = cx * chunkSize
  const y0 = cy * chunkSize
  const { rows, any } = rectRows(
    grid,
    palette,
    x0,
    y0,
    Math.min(chunkSize, grid.width - x0),
    Math.min(chunkSize, grid.height - y0),
  )
  return any ? rows : undefined
}

/**
 * The cells of a w × h rectangle as rows, in the rows syntax (`tilemap.read` with a rect), and
 * whether any cell is filled. The rectangle must lie inside the grid.
 */
export function rectRows(
  grid: CellGrid,
  palette: readonly string[],
  x0: number,
  y0: number,
  w: number,
  h: number,
): { rows: string[]; any: boolean } {
  let any = false
  const rows: string[] = []
  for (let ly = 0; ly < h; ly++) {
    const runs: string[] = []
    let token = ''
    let count = 0
    for (let lx = 0; lx < w; lx++) {
      const i = (y0 + ly) * grid.width + x0 + lx
      const id = grid.tiles[i]!
      let t: string
      if (id === 0) t = '.'
      else {
        any = true
        const name = palette[id - 1]
        if (name === undefined) throw invalid(`Tile id ${id} has no palette entry`, `/palette`)
        const f = grid.flags[i]!
        t = f ? `${name}:${flagText(f)}` : name
      }
      if (t === token) count++
      else {
        if (count > 0) runs.push(count > 1 ? `${token}*${count}` : token)
        token = t
        count = 1
      }
    }
    if (count > 0) runs.push(count > 1 ? `${token}*${count}` : token)
    rows.push(runs.join(' '))
  }
  return { rows, any }
}

/**
 * Reads one chunk's rows into the grid. Unknown names are added to the palette (the caller
 * checks them against the atlas); `path` is the chunk's JSON pointer.
 */
export function readChunkRows(
  grid: CellGrid,
  palette: string[],
  index: Map<string, number>,
  cx: number,
  cy: number,
  chunkSize: number,
  rows: unknown,
  path: string,
): void {
  if (!Array.isArray(rows)) throw invalid('Expected a list of rows', path)
  const x0 = cx * chunkSize
  const y0 = cy * chunkSize
  const w = Math.min(chunkSize, grid.width - x0)
  const h = Math.min(chunkSize, grid.height - y0)
  if (w <= 0 || h <= 0) throw invalid(`Chunk ${cx},${cy} is outside the layer`, path)
  if (rows.length > h) throw invalid(`Chunk has ${rows.length} rows; it can hold ${h}`, path)
  for (let ly = 0; ly < rows.length; ly++) {
    const row = rows[ly]
    const at = `${path}/${ly}`
    if (typeof row !== 'string') throw invalid('Expected a row string', at)
    let lx = 0
    const runs = row.trim() === '' ? [] : row.trim().split(/\s+/)
    for (const run of runs) {
      const star = run.lastIndexOf('*')
      const body = star === -1 ? run : run.slice(0, star)
      const count = star === -1 ? 1 : Number(run.slice(star + 1))
      if (!Number.isInteger(count) || count < 1) {
        throw invalid(`Bad run count in "${run}" (column ${lx + 1})`, at)
      }
      let id = 0
      let flags = 0
      if (body !== '.') {
        const colon = body.indexOf(':')
        const name = colon === -1 ? body : body.slice(0, colon)
        if (!rowsCanName(name)) throw invalid(`Bad tile name in "${run}" (column ${lx + 1})`, at)
        if (colon !== -1) {
          for (const f of body.slice(colon + 1).split('+')) {
            const bit = TILE_FLAG_NAMES[f as keyof typeof TILE_FLAG_NAMES]
            if (!bit) throw invalid(`Unknown flag "${f}" in "${run}" (column ${lx + 1})`, at)
            flags |= bit
          }
        }
        let p = index.get(name)
        if (p === undefined) {
          p = palette.length
          palette.push(name)
          index.set(name, p)
        }
        id = p + 1
      }
      if (lx + count > w) throw invalid(`Row has more than ${w} cells`, at)
      for (let k = 0; k < count; k++) {
        const i = (y0 + ly) * grid.width + x0 + lx + k
        grid.tiles[i] = id
        grid.flags[i] = flags
      }
      lx += count
    }
    if (lx !== 0 && lx !== w) throw invalid(`Row has ${lx} cells; it needs ${w}`, at)
  }
}

/** All non-empty chunks of a layer as rows, keyed "cx,cy" in row-major order. */
export function layerChunks(
  grid: CellGrid,
  palette: readonly string[],
  chunkSize: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const cols = Math.ceil(grid.width / chunkSize)
  const rowsOfChunks = Math.ceil(grid.height / chunkSize)
  for (let cy = 0; cy < rowsOfChunks; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const rows = chunkRows(grid, palette, cx, cy, chunkSize)
      if (rows) out[`${cx},${cy}`] = rows
    }
  }
  return out
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

/** A layer's tile ids as base64 of little-endian u16s. */
export function tilesToBase64(tiles: Uint16Array): string {
  const bytes = new Uint8Array(tiles.length * 2)
  const view = new DataView(bytes.buffer)
  for (let k = 0; k < tiles.length; k++) view.setUint16(k * 2, tiles[k]!, true)
  return toBase64(bytes)
}

export function tilesFromBase64(s: string, n: number, path: string, name: string): Uint16Array {
  const bytes = fromBase64(s)
  if (bytes.length !== n * 2) {
    throw invalid(`Layer "${name}" has ${bytes.length / 2} tiles; it needs ${n}`, path)
  }
  const tiles = new Uint16Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let k = 0; k < n; k++) tiles[k] = view.getUint16(k * 2, true)
  return tiles
}

export function flagsFromBase64(s: string, n: number, path: string, name: string): Uint8Array {
  if (!s) return new Uint8Array(n)
  const flags = fromBase64(s)
  if (flags.length !== n) {
    throw invalid(`Layer "${name}" has ${flags.length} flag bytes; it needs ${n}`, path)
  }
  return flags
}
