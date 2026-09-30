import type { DieGeometry } from './definition'
import { cross, dot, stableTangent, sub, type V3 } from './math'

// Every face of a die has a square cell in its mark atlas. The mesh maps the face into its cell
// (UVs) and the bake draws its marks there, through this one mapping.

export interface FaceCell {
  face: number
  /** The value the face reads (undefined on a d4: its marks are per corner). */
  value: number | undefined
  col: number
  row: number
  /** The face's frame: marks read up along `bitangent`. */
  tangent: V3
  bitangent: V3
  center: V3
  /** Half the side of the square, in face units, that maps onto the cell's inner square. */
  extent: number
}

export interface CellLayout {
  cols: number
  rows: number
  /** Cell side in atlas pixels. */
  cell: number
  /** Margin inside each cell, as a fraction of its side. */
  pad: number
  faces: FaceCell[]
}

export const CELL_PAD = 0.06
/** Distance range of the atlas, in pixels: marks shade from ±range / 2 of their outline. */
export const MARK_RANGE = 8

const layouts = new WeakMap<DieGeometry, CellLayout>()

/** The cells of a die's faces: a near-square grid, faces in polytope order. */
export function cellLayout(g: DieGeometry): CellLayout {
  const cached = layouts.get(g)
  if (cached) return cached
  const faces = g.polytope.faces
  const cols = Math.ceil(Math.sqrt(faces.length))
  const rows = Math.ceil(faces.length / cols)
  const cell = faces.length <= 24 ? 128 : 64
  const out: FaceCell[] = faces.map((face, i) => {
    const value = g.faceValues[i]
    const frame = value === undefined ? undefined : g.frames[value - 1]
    const tangent = frame ? frame.tangent : stableTangent(face.normal)
    const bitangent = frame ? frame.bitangent : cross(face.normal, tangent)
    let extent = 1e-6
    for (const v of face.vertices) {
      const d = sub(g.polytope.points[v]!, face.center)
      extent = Math.max(extent, Math.abs(dot(d, tangent)), Math.abs(dot(d, bitangent)))
    }
    return {
      face: i,
      value,
      col: i % cols,
      row: Math.floor(i / cols),
      tangent,
      bitangent,
      center: face.center,
      extent,
    }
  })
  const layout = { cols, rows, cell, pad: CELL_PAD, faces: out }
  layouts.set(g, layout)
  return layout
}

/** A point on a face in its cell's pixels: x right, y up from the cell's bottom-left corner. */
export function cellPixel(layout: CellLayout, cell: FaceCell, p: V3): [number, number] {
  const d = sub(p, cell.center)
  const k = (layout.cell * (1 - 2 * layout.pad)) / (2 * cell.extent)
  return [layout.cell / 2 + dot(d, cell.tangent) * k, layout.cell / 2 + dot(d, cell.bitangent) * k]
}

/** A point on a face as atlas UVs (v down, as textures sample). */
export function cellUv(layout: CellLayout, cell: FaceCell, p: V3, out: number[], o: number): void {
  const [x, y] = cellPixel(layout, cell, p)
  out[o] = (cell.col * layout.cell + x) / (layout.cols * layout.cell)
  out[o + 1] = (cell.row * layout.cell + (layout.cell - y)) / (layout.rows * layout.cell)
}
