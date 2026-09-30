import type { AssetRef } from '@aethervtt/shard-core'
import {
  type Contour,
  type Font,
  generateMsdf,
  type MsdfBox,
  prepareShape,
  type Shape,
  shapeBounds,
  shapeFromCommands,
} from '@aethervtt/shard-text'
import { type CellLayout, cellLayout, cellPixel, MARK_RANGE } from './cells'
import type { DieGeometry } from './definition'
import { findDiceGlyph, parseSvgPath } from './glyphs'
import { type FaceLayoutValue, type ResolvedMark, resolveMark } from './layout'
import { add, scale, sub } from './math'
import { DICE_NUMERALS, NUMERAL_HEIGHT } from './numerals'

// Baking face marks (0054): one RGBA8 atlas per (definition, layout), a multi-channel distance
// field in RGB (0.5 on the outline, MARK_RANGE pixels across), alpha 255. Pure CPU: it runs in
// Node, in a worker, or on the page, and is cached by what went into it.

export interface MarkAtlas {
  /** What it was baked from: definition hash, layout, fonts. */
  key: string
  width: number
  height: number
  layout: CellLayout
  /** Distance range in pixels. */
  range: number
  pixels: Uint8Array
  /** Values drawn, per face (d4 faces carry three). */
  values: number[][]
  /** How long the bake took, ms. */
  ms: number
}

export interface BakeMarksOptions {
  /** Loaded fonts for text marks that name one. */
  font?: (ref: AssetRef) => Font | undefined
}

/** Pip positions for 1..9 on a −1..1 grid, y up. */
const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [
    [-1, 1],
    [1, -1],
  ],
  3: [
    [-1, 1],
    [0, 0],
    [1, -1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
  7: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [0, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
  8: [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ],
  9: [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [0, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ],
}

/** A glyph outline in em units (y up), and its advance. */
interface Outline {
  shape: Shape
  advance: number
}

const numeralShapes = new Map<string, Outline>()

function numeral(ch: string): Outline | undefined {
  let o = numeralShapes.get(ch)
  if (o) return o
  const n = DICE_NUMERALS[ch]
  if (!n) return undefined
  const cmds = parseSvgPath(n.path, `numeral ${ch}`)
  const shape = shapeFromCommands(cmds)
  // Thousandths of an em → em.
  for (const c of shape.contours)
    for (const e of c.edges) for (let i = 0; i < e.p.length; i++) e.p[i]! /= 1000
  o = { shape, advance: n.advance / 1000 }
  numeralShapes.set(ch, o)
  return o
}

function fontGlyph(font: Font, ch: string): Outline | undefined {
  const source = font.source
  if (!source) return undefined
  const index = source.glyphIndex(ch.codePointAt(0)!)
  if (index === 0) return undefined
  const shape = source.shape(index)
  const upem = source.unitsPerEm
  for (const c of shape.contours)
    for (const e of c.edges) for (let i = 0; i < e.p.length; i++) e.p[i]! /= upem
  return { shape, advance: source.advance(index) / upem }
}

/** Copies contours through (x, y) → m · (x, y) + (tx, ty). */
function place(
  out: Contour[],
  shape: Shape,
  m: readonly [number, number, number, number],
  tx: number,
  ty: number,
): void {
  for (const c of shape.contours) {
    out.push({
      edges: c.edges.map((e) => {
        const p = e.p.slice()
        for (let i = 0; i < p.length; i += 2) {
          const x = p[i]!
          const y = p[i + 1]!
          p[i] = m[0] * x + m[1] * y + tx
          p[i + 1] = m[2] * x + m[3] * y + ty
        }
        return { kind: e.kind, p, color: e.color }
      }),
    })
  }
}

/** Signed area of a contour's control polygon (y up: positive counter-clockwise). */
function area(c: Contour): number {
  let a = 0
  for (const e of c.edges) {
    const p = e.p
    const n = p.length
    a += p[0]! * p[n - 1]! - p[n - 2]! * p[1]!
  }
  return a / 2
}

function rect(l: number, b: number, r: number, t: number, ccw: boolean): Contour {
  const pts = ccw ? [l, b, r, b, r, t, l, t] : [l, b, l, t, r, t, r, b]
  const edges = []
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    edges.push({
      kind: 1 as const,
      p: [pts[i * 2]!, pts[i * 2 + 1]!, pts[j * 2]!, pts[j * 2 + 1]!],
      color: 7,
    })
  }
  return { edges }
}

export interface Placement {
  mark: ResolvedMark
  /** Center in cell pixels (y up). */
  x: number
  y: number
  /** Mark height in pixels. */
  height: number
  /** Up direction angle, radians counter-clockwise from +y. */
  angle: number
  /** The flat area the mark keeps inside, in cell pixels: [x0, y0, x1, y1, …]. */
  region: number[]
  /** The largest height the mark's ink can take there, keeping the margin clear. */
  fit: number
}

/**
 * Contours with an origin in cell pixels (y up). A piece with a key doesn't depend on where it
 * sits: its tile is baked once and reused wherever the key comes back (digits across a d100).
 */
interface Piece {
  contours: Contour[]
  ox: number
  oy: number
  key: string | undefined
}

function scaled(shape: Shape, sx: number, sy: number, dx: number, dy: number): Contour[] {
  const out: Contour[] = []
  place(out, shape, [sx, 0, 0, sy], dx, dy)
  return out
}

/**
 * A text or glyph mark as pieces. Upright text is one piece per character, its origin on a whole
 * pixel (at most half a pixel from exact), so every occurrence of a character at a size shares a
 * tile. Turned marks are one piece in place.
 */
function markPieces(p: Placement, options: BakeMarksOptions, weightPx: number): Piece[] {
  const m = p.mark
  const turn = p.angle - m.rotation
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  if (m.kind === 'glyph') {
    const glyph = findDiceGlyph(m.glyph)
    if (!glyph) return []
    const s = p.height
    const contours: Contour[] = []
    place(
      contours,
      shapeFromCommands(glyph.commands),
      [cos * s, -sin * s, sin * s, cos * s],
      p.x,
      p.y,
    )
    return [{ contours, ox: 0, oy: 0, key: undefined }]
  }
  const font = m.font ? options.font?.(m.font) : undefined
  const chars: { ch: string; outline: Outline }[] = []
  for (const ch of m.text) {
    const outline = font ? fontGlyph(font, ch) : numeral(ch)
    if (outline) chars.push({ ch, outline })
  }
  if (chars.length === 0) return []
  // Lay the characters out on a baseline in em, then fit: cap height to the mark's height,
  // condensed when a long label would be wider than 1.35 heights.
  const capHeight = font ? capOf(chars.map((c) => c.outline)) : NUMERAL_HEIGHT / 1000
  let width = 0
  for (const c of chars) width += c.outline.advance
  const sy = p.height / capHeight
  const sx = sy * Math.min(1, (1.35 * p.height) / (width * sy))
  const baseline = -capHeight / 2
  // Pieces in em around the mark's center, before turning.
  const local: { contours: Contour[]; x: number; key: string }[] = []
  const fontKey = m.font?.guid ?? m.font?.path ?? 'numerals'
  const size = `${sx.toFixed(3)}:${sy.toFixed(3)}:${weightPx.toFixed(2)}`
  let pen = -width / 2
  for (const c of chars) {
    local.push({ contours: c.outline.shape.contours, x: pen, key: `${fontKey}:${c.ch}:${size}` })
    pen += c.outline.advance
  }
  let bar: Contour | undefined
  if (m.underline) {
    // The underline winds like the glyphs' outer contours, so the fill rule keeps it solid.
    const all = chars.flatMap((c) => c.outline.shape.contours)
    const outer = all.reduce((a, c) => (Math.abs(area(c)) > Math.abs(area(a)) ? c : a), all[0]!)
    const w = Math.min(width * 0.72, capHeight * 0.95)
    const y = baseline - capHeight * 0.2
    bar = rect(-w / 2, y - capHeight * 0.09, w / 2, y, area(outer) > 0)
  }
  if (Math.abs(turn) < 1e-6) {
    const pieces: Piece[] = local.map((l) => {
      const ox = Math.round(p.x + l.x * sx)
      const oy = Math.round(p.y + baseline * sy)
      return { contours: scaled({ contours: l.contours }, sx, sy, 0, 0), ox, oy, key: l.key }
    })
    if (bar) {
      const contours: Contour[] = []
      place(contours, { contours: [bar] }, [sx, 0, 0, sy], 0, 0)
      pieces.push({ contours, ox: Math.round(p.x), oy: Math.round(p.y), key: undefined })
    }
    return pieces
  }
  const contours: Contour[] = []
  const r: [number, number, number, number] = [cos * sx, -sin * sy, sin * sx, cos * sy]
  for (const l of local) {
    for (const c of l.contours) {
      place(
        contours,
        { contours: [c] },
        r,
        p.x + r[0] * (l.x + 0) + r[1] * baseline,
        p.y + r[2] * l.x + r[3] * baseline,
      )
    }
  }
  if (bar) place(contours, { contours: [bar] }, r, p.x, p.y)
  return [{ contours, ox: 0, oy: 0, key: undefined }]
}

function capOf(outlines: Outline[]): number {
  let top = 0
  for (const o of outlines) {
    const b = shapeBounds(o.shape)
    if (b) top = Math.max(top, b[3])
  }
  return top || 0.7
}

/** A piece's field: `data` holds 3 channels per pixel, row 0 at the bottom (y = b). */
interface Tile {
  l: number
  b: number
  width: number
  height: number
  data: Float32Array
}

const tiles = new Map<string, Tile>()
const TILE_CACHE = 1024

function bakeTile(piece: Piece, weightPx: number): Tile | undefined {
  const shape: Shape = { contours: piece.contours }
  prepareShape(shape)
  const bounds = shapeBounds(shape)
  if (!bounds) return undefined
  const half = MARK_RANGE / 2 + 1
  const l = Math.floor(bounds[0] - half)
  const b = Math.floor(bounds[1] - half)
  const r = Math.ceil(bounds[2] + half)
  const t = Math.ceil(bounds[3] + half)
  const box: MsdfBox = { width: r - l, height: t - b, tx: -l, ty: -b, plane: [l, b, r, t] }
  const sdf = generateMsdf(shape, box, { scale: 1, range: MARK_RANGE })
  const data = new Float32Array(box.width * box.height * 3)
  const bias = weightPx / MARK_RANGE
  for (let i = 0; i < data.length; i++) data[i] = sdf[i]! + bias
  return { l, b, width: box.width, height: box.height, data }
}

function tileOf(piece: Piece, weightPx: number): Tile | undefined {
  if (!piece.key) return bakeTile(piece, weightPx)
  const hit = tiles.get(piece.key)
  if (hit) return hit
  const tile = bakeTile(piece, weightPx)
  if (!tile) return undefined
  tiles.set(piece.key, tile)
  if (tiles.size > TILE_CACHE) tiles.delete(tiles.keys().next().value!)
  return tile
}

const med = (a: number, b: number, c: number) =>
  Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))

const byte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255))

/**
 * Writes a tile into the atlas cell at its piece's origin. `owner` holds, per texel, the piece
 * that wrote it (−1 for none). Where two pieces' fields overlap, the texel takes the larger median
 * in all three channels: a plain distance field there. Keeping one piece's channels per texel
 * instead would put texels of different fields side by side, and filtering between them draws
 * cracks between characters that sit close (a condensed "20").
 */
function blitTile(
  atlas: Uint8Array,
  owner: Int32Array,
  piece: number,
  atlasWidth: number,
  cellX: number,
  cellY: number,
  cell: number,
  tile: Tile,
  ox: number,
  oy: number,
): void {
  for (let row = 0; row < tile.height; row++) {
    const y = oy + tile.b + row
    if (y < 0 || y >= cell) continue
    const atlasRow = cellY + (cell - 1 - y)
    for (let col = 0; col < tile.width; col++) {
      const x = ox + tile.l + col
      if (x < 0 || x >= cell) continue
      const s = (row * tile.width + col) * 3
      const r = tile.data[s]!
      const g = tile.data[s + 1]!
      const b = tile.data[s + 2]!
      const t = atlasRow * atlasWidth + cellX + x
      const o = t * 4
      const was = owner[t]!
      owner[t] = piece
      if (was < 0 || was === piece) {
        atlas[o] = byte(r)
        atlas[o + 1] = byte(g)
        atlas[o + 2] = byte(b)
        continue
      }
      const m = Math.max(byte(med(r, g, b)), med(atlas[o]!, atlas[o + 1]!, atlas[o + 2]!))
      atlas[o] = atlas[o + 1] = atlas[o + 2] = m
    }
  }
}

/** Analytic pips: the exact distance to the nearest disc, the same in all three channels. */
function drawPips(
  atlas: Uint8Array,
  atlasWidth: number,
  cellX: number,
  cellY: number,
  cell: number,
  p: Placement,
): void {
  const layout = PIPS[p.mark.count]
  if (!layout) return
  const spread = p.height * 0.62
  const radius = p.height * 0.21 + p.mark.weight * p.height
  const cos = Math.cos(p.angle - p.mark.rotation)
  const sin = Math.sin(p.angle - p.mark.rotation)
  const centers = layout.map(([gx, gy]) => [
    p.x + (cos * gx - sin * gy) * spread,
    p.y + (sin * gx + cos * gy) * spread,
  ])
  for (let y = 0; y < cell; y++) {
    const atlasRow = cellY + (cell - 1 - y)
    const py = y + 0.5
    for (let x = 0; x < cell; x++) {
      const px = x + 0.5
      let d = Number.NEGATIVE_INFINITY
      for (const c of centers)
        d = Math.max(d, radius - Math.sqrt((px - c[0]!) ** 2 + (py - c[1]!) ** 2))
      const v = d / MARK_RANGE + 0.5
      const byte = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
      const o = (atlasRow * atlasWidth + cellX + x) * 4
      if (byte > atlas[o]!) atlas[o] = atlas[o + 1] = atlas[o + 2] = byte
    }
  }
}

/** The share of a region's inscribed radius a mark's ink keeps clear of its edges. */
export const MARK_MARGIN = 0.12

/**
 * Where a face's marks may go, in its cell's pixels: the flat face (the corners pulled in by the
 * bevel), or on a vertex die, each corner's share of it (the kite from the face's center to the
 * midpoints of the corner's two edges), reading toward the corner.
 */
function regions(
  g: DieGeometry,
  layout: CellLayout,
  faceIndex: number,
): { value: number; poly: number[]; angle: number }[] {
  const face = layout.faces[faceIndex]!
  const poly = g.polytope.faces[faceIndex]!
  const bevel = g.definition.bevel
  const flat = poly.vertices.map((v) => {
    const p = g.polytope.points[v]!
    return cellPixel(layout, face, add(p, scale(sub(face.center, p), bevel)))
  })
  if (face.value !== undefined) return [{ value: face.value, poly: flat.flat(), angle: 0 }]
  const c = layout.cell / 2
  const n = flat.length
  return poly.vertices.map((v, i) => {
    const [x, y] = flat[i]!
    const [px, py] = flat[(i + n - 1) % n]!
    const [nx, ny] = flat[(i + 1) % n]!
    return {
      value: g.vertexValues![v]!,
      poly: [c, c, (x + nx) / 2, (y + ny) / 2, x, y, (x + px) / 2, (y + py) / 2],
      angle: Math.atan2(-(x - c), y - c),
    }
  })
}

/** A convex polygon's edges: outward unit normal and offset (n · p ≤ d inside), 3 numbers each. */
function edgesOf(poly: number[]): number[] {
  const n = poly.length / 2
  let twice = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    twice += poly[i * 2]! * poly[j * 2 + 1]! - poly[j * 2]! * poly[i * 2 + 1]!
  }
  const sign = twice > 0 ? 1 : -1
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = poly[j * 2]! - poly[i * 2]!
    const dy = poly[j * 2 + 1]! - poly[i * 2 + 1]!
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 1e-9) continue
    const nx = (sign * dy) / len
    const ny = (-sign * dx) / len
    out.push(nx, ny, nx * poly[i * 2]! + ny * poly[i * 2 + 1]!)
  }
  return out
}

/** How far (x, y) is inside the polygon: the distance to its nearest edge. */
function clearance(edges: number[], x: number, y: number): number {
  let m = Number.POSITIVE_INFINITY
  for (let e = 0; e < edges.length; e += 3)
    m = Math.min(m, edges[e + 2]! - edges[e]! * x - edges[e + 1]! * y)
  return m
}

/** The maximum of a concave f on [a, b], by golden-section search. */
function golden(f: (t: number) => number, a: number, b: number): number {
  const k = (Math.sqrt(5) - 1) / 2
  let lo = a
  let hi = b
  for (let i = 0; i < 28; i++) {
    const m1 = hi - k * (hi - lo)
    const m2 = lo + k * (hi - lo)
    if (f(m1) < f(m2)) lo = m1
    else hi = m2
  }
  return (lo + hi) / 2
}

/**
 * The point deepest inside a convex polygon (its inscribed circle's center), found from (x, y) by
 * coordinate search. A point that barely gains stays put, so regular faces keep their centers.
 */
function deepest(edges: number[], x: number, y: number, span: number): [number, number] {
  let bx = x
  let by = y
  for (let round = 0; round < 3; round++) {
    by = golden((t) => clearance(edges, bx, t), by - span, by + span)
    bx = golden((t) => clearance(edges, t, by), bx - span, bx + span)
  }
  return clearance(edges, bx, by) > clearance(edges, x, y) * 1.02 ? [bx, by] : [x, y]
}

/**
 * The points bounding a mark's ink, in units of its height around its center (y up), and how
 * much the weight grows the ink beyond them. Outline control points bound their curves.
 */
function inkOf(
  m: ResolvedMark,
  options: BakeMarksOptions,
): { points: number[]; grow: number } | undefined {
  if (m.kind === 'blank') return undefined
  if (m.kind === 'pips') {
    const layout = PIPS[m.count]
    if (!layout) return undefined
    return { points: layout.flatMap(([x, y]) => [x * 0.62, y * 0.62]), grow: 0.21 + m.weight }
  }
  if (m.kind === 'glyph') {
    const glyph = findDiceGlyph(m.glyph)
    if (!glyph) return undefined
    const points: number[] = []
    for (const c of shapeFromCommands(glyph.commands).contours)
      for (const e of c.edges) for (let i = 0; i < e.p.length; i++) points.push(e.p[i]!)
    return { points, grow: 0 }
  }
  const font = m.font ? options.font?.(m.font) : undefined
  const outlines: Outline[] = []
  for (const ch of m.text) {
    const o = font ? fontGlyph(font, ch) : numeral(ch)
    if (o) outlines.push(o)
  }
  if (outlines.length === 0) return undefined
  // As markPieces lays text out: cap height to the mark's height, condensed past 1.35 heights.
  const cap = font ? capOf(outlines) : NUMERAL_HEIGHT / 1000
  let width = 0
  for (const o of outlines) width += o.advance
  const sy = 1 / cap
  const sx = sy * Math.min(1, 1.35 / (width * sy))
  const points: number[] = []
  let pen = -width / 2
  for (const o of outlines) {
    for (const c of o.shape.contours) {
      for (const e of c.edges) {
        for (let i = 0; i < e.p.length; i += 2)
          points.push((e.p[i]! + pen) * sx, (e.p[i + 1]! - cap / 2) * sy)
      }
    }
    pen += o.advance
  }
  if (m.underline) {
    const w = Math.min(width * 0.72, cap * 0.95) / 2
    const bottom = -0.5 - 0.29
    points.push(-w * sx, bottom, w * sx, bottom)
  }
  // The field's bias grows the outline by the weight, in em: in heights, over the cap height.
  return { points, grow: m.weight / cap }
}

/** The largest height the ink can take at (x, y), turned by `turn`, keeping `margin` px inside. */
function fitHeight(
  edges: number[],
  ink: { points: number[]; grow: number },
  x: number,
  y: number,
  turn: number,
  margin: number,
): number {
  const c = Math.cos(turn)
  const s = Math.sin(turn)
  let h = Number.POSITIVE_INFINITY
  for (let e = 0; e < edges.length; e += 3) {
    const nx = edges[e]!
    const ny = edges[e + 1]!
    let reach = Number.NEGATIVE_INFINITY
    for (let i = 0; i < ink.points.length; i += 2) {
      const px = ink.points[i]!
      const py = ink.points[i + 1]!
      reach = Math.max(reach, nx * (c * px - s * py) + ny * (s * px + c * py))
    }
    reach += ink.grow
    const room = edges[e + 2]! - nx * x - ny * y - margin
    if (reach > 1e-9) h = Math.min(h, room / reach)
  }
  return Math.max(0, h)
}

/**
 * A face's marks, each at the deepest point of its region, at the definition's height and the
 * largest height its ink fits (bakeMarks takes the smaller, one scale for the whole die).
 */
function placements(
  g: DieGeometry,
  layout: CellLayout,
  faceIndex: number,
  marks: FaceLayoutValue,
  options: BakeMarksOptions,
): Placement[] {
  const def = g.definition
  const inner = layout.cell * (1 - 2 * layout.pad)
  const height = (def.markScale ?? 0.4) * inner
  return regions(g, layout, faceIndex).map((r) => {
    const mark = resolveMark(marks, def, r.value)
    const edges = edgesOf(r.poly)
    // Start from the region's centroid (the face's center, for a face).
    let cx = 0
    let cy = 0
    for (let i = 0; i < r.poly.length; i += 2) {
      cx += r.poly[i]!
      cy += r.poly[i + 1]!
    }
    cx /= r.poly.length / 2
    cy /= r.poly.length / 2
    const [x, y] = deepest(edges, cx, cy, inner * 0.35)
    const ink = inkOf(mark, options)
    const margin = MARK_MARGIN * clearance(edges, x, y)
    const fit = ink ? fitHeight(edges, ink, x, y, r.angle - mark.rotation, margin) : Infinity
    return { mark, x, y, height: height * mark.size, angle: r.angle, region: r.poly, fit }
  })
}

/**
 * Every mark of a die under a layout, where the bake draws it: at the definition's height, shrunk
 * (one scale for the whole die, so its numbers match) until every mark's ink fits its region.
 */
export function markPlacements(
  g: DieGeometry,
  layout: FaceLayoutValue,
  options: BakeMarksOptions = {},
): Placement[][] {
  const cells = cellLayout(g)
  const all = cells.faces.map((face) => placements(g, cells, face.face, layout, options))
  let k = 1
  for (const face of all) for (const p of face) if (p.height > 0) k = Math.min(k, p.fit / p.height)
  if (k < 1) for (const face of all) for (const p of face) p.height *= k
  return all
}

const cache = new Map<string, MarkAtlas>()
const CACHE_SIZE = 24

/** The cache key of a bake: the definition's hash, the layout's content, and its fonts' guids. */
export function markAtlasKey(g: DieGeometry, layout: FaceLayoutValue): string {
  return `${g.hash.toString(16)}:${JSON.stringify(layout)}`
}

/**
 * Bakes a die's marks under a layout into one MSDF atlas: glyph outlines from the font (or the
 * built-in numerals), pips as analytic circles, glyphs from their registered paths. Cached by
 * (definition, layout).
 */
export function bakeMarks(
  g: DieGeometry,
  layout: FaceLayoutValue,
  options: BakeMarksOptions = {},
): MarkAtlas {
  const key = markAtlasKey(g, layout)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const start = performance.now()
  const cells = cellLayout(g)
  const width = cells.cols * cells.cell
  const height = cells.rows * cells.cell
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
  const values: number[][] = []
  const placed = markPlacements(g, layout, options)
  const owner = new Int32Array(width * height).fill(-1)
  let pieces = 0
  for (const face of cells.faces) {
    const cellX = face.col * cells.cell
    const cellY = face.row * cells.cell
    for (const p of placed[face.face]!) {
      if (p.mark.kind === 'blank') continue
      if (p.mark.kind === 'pips') {
        drawPips(pixels, width, cellX, cellY, cells.cell, p)
        continue
      }
      // Weight is in em: pixels per em follow the mark's height.
      const weightPx = p.mark.weight * (p.height / (NUMERAL_HEIGHT / 1000))
      for (const piece of markPieces(p, options, weightPx)) {
        const tile = tileOf(piece, weightPx)
        if (!tile) continue
        blitTile(pixels, owner, pieces++, width, cellX, cellY, cells.cell, tile, piece.ox, piece.oy)
      }
    }
    values.push(
      face.value !== undefined
        ? [face.value]
        : g.polytope.faces[face.face]!.vertices.map((v) => g.vertexValues![v]!),
    )
  }
  const atlas: MarkAtlas = {
    key,
    width,
    height,
    layout: cells,
    range: MARK_RANGE,
    pixels,
    values,
    ms: performance.now() - start,
  }
  cache.set(key, atlas)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return atlas
}

/** Drops every cached bake (tests, or a host changing fonts under the same refs). */
export function clearMarkCache(): void {
  cache.clear()
}
