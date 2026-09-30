// Grid cell math (0057): square and hex (pointy and flat) grids in world units, as pure functions.
// Hex grids follow Aether's convention: `size` is the distance between adjacent cell centres, and
// cells are addressed by axial coordinates (q, r). Game distance ("5 ft per square") is a rule
// for measuring only: `distance` takes the diagonal rule, and nothing here places anything by it.

export type GridKind = 'square' | 'hex'
export type HexOrientation = 'pointy' | 'flat'
/** Aether's diagonal rules: true length, every step one cell, or 1-2-1-2 alternating. */
export type DiagonalRule = 'euclidean' | 'equal' | 'alternating'

/** What cell math needs of a grid: its shape, cell size and origin, in world units. */
export interface GridGeometry {
  kind: GridKind
  orientation: HexOrientation
  /** Square: cell edge. Hex: distance between adjacent cell centres. */
  size: number
  /** Where cell (0, 0) starts (square) or is centred (hex), as (x, z). */
  offset: readonly [number, number]
}

/** A cell: (column, row) for square grids, axial (q, r) for hex grids. */
export type Cell = [number, number]

const SQRT3 = Math.sqrt(3)

/** Axial hex coordinates to cube (x, y, z), with x + y + z = 0. */
export function axialToCube(q: number, r: number): [number, number, number] {
  return [q, -q - r, r]
}

/** Cube hex coordinates to axial (q, r). */
export function cubeToAxial(x: number, _y: number, z: number): Cell {
  return [x, z]
}

/** Rounds fractional axial coordinates to the nearest hex, through cube space. */
export function roundAxial(q: number, r: number): Cell {
  const x = q
  const z = r
  const y = -x - z
  let rx = Math.round(x)
  let ry = Math.round(y)
  let rz = Math.round(z)
  const dx = Math.abs(rx - x)
  const dy = Math.abs(ry - y)
  const dz = Math.abs(rz - z)
  if (dx > dy && dx > dz) rx = -ry - rz
  else if (dy > dz) ry = -rx - rz
  else rz = -rx - ry
  return [rx + 0, rz + 0]
}

/** Fractional axial coordinates of a world point. */
export function pointToAxial(grid: GridGeometry, x: number, z: number): Cell {
  const px = x - grid.offset[0]
  const pz = z - grid.offset[1]
  if (grid.orientation === 'flat') {
    const q = (2 * px) / (SQRT3 * grid.size)
    return [q, pz / grid.size - q / 2]
  }
  const r = (2 * pz) / (SQRT3 * grid.size)
  return [px / grid.size - r / 2, r]
}

/** The cell containing a world point (x, z). */
export function cellAt(grid: GridGeometry, x: number, z: number): Cell {
  if (grid.kind === 'hex') {
    const [q, r] = pointToAxial(grid, x, z)
    return roundAxial(q, r)
  }
  return [
    Math.floor((x - grid.offset[0]) / grid.size),
    Math.floor((z - grid.offset[1]) / grid.size),
  ]
}

/** A cell's centre, as world (x, z). */
export function cellCenter(grid: GridGeometry, cell: readonly [number, number]): [number, number] {
  const [a, b] = cell
  if (grid.kind === 'hex') {
    if (grid.orientation === 'flat') {
      return [
        grid.offset[0] + grid.size * (SQRT3 / 2) * a,
        grid.offset[1] + grid.size * (b + a / 2),
      ]
    }
    return [grid.offset[0] + grid.size * (a + b / 2), grid.offset[1] + grid.size * (SQRT3 / 2) * b]
  }
  return [grid.offset[0] + (a + 0.5) * grid.size, grid.offset[1] + (b + 0.5) * grid.size]
}

/** A cell's outline: its corners as world (x, z), in order around it. */
export function cellPolygon(
  grid: GridGeometry,
  cell: readonly [number, number],
): [number, number][] {
  const [cx, cz] = cellCenter(grid, cell)
  if (grid.kind === 'square') {
    const h = grid.size / 2
    return [
      [cx - h, cz - h],
      [cx + h, cz - h],
      [cx + h, cz + h],
      [cx - h, cz + h],
    ]
  }
  // Circumradius: size / √3 (size is the distance between adjacent centres).
  const radius = grid.size / SQRT3
  const start = grid.orientation === 'pointy' ? -30 : 0
  const out: [number, number][] = []
  for (let i = 0; i < 6; i++) {
    const a = ((start + i * 60) * Math.PI) / 180
    out.push([cx + radius * Math.cos(a), cz + radius * Math.sin(a)])
  }
  return out
}

const SQUARE_NEIGHBORS: readonly Cell[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

const HEX_NEIGHBORS: readonly Cell[] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
]

/** A cell's neighbours: 8 for square grids (diagonals included), 6 for hex grids. */
export function neighbors(grid: GridGeometry, cell: readonly [number, number]): Cell[] {
  const list = grid.kind === 'hex' ? HEX_NEIGHBORS : SQUARE_NEIGHBORS
  return list.map(([dx, dy]) => [cell[0] + dx, cell[1] + dy])
}

/** Hex steps between two axial cells (orientation doesn't matter). */
export function hexDistance(a: readonly [number, number], b: readonly [number, number]): number {
  const dq = a[0] - b[0]
  const dr = a[1] - b[1]
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

/**
 * The distance from world point `a` to `b`, in cells, by Aether's rules: hex grids count hex
 * steps; square grids measure the true length (`euclidean`), the longer axis (`equal`), or count
 * diagonals 1, 2, 1, 2 (`alternating`, starting cheap).
 */
export function distance(
  grid: GridGeometry,
  a: readonly [number, number],
  b: readonly [number, number],
  diagonal: DiagonalRule,
): number {
  return pathDistance(grid, [a, b], diagonal).total
}

/**
 * The distance along a path of world points, per leg and in total, in cells. With `alternating`,
 * the 1-2-1-2 phase carries across waypoints; diagonal steps round to whole cells, straight
 * movement stays fractional (Aether's `pathCells`).
 */
export function pathDistance(
  grid: GridGeometry,
  points: readonly (readonly [number, number])[],
  diagonal: DiagonalRule,
): { legs: number[]; total: number } {
  const legs: number[] = []
  let total = 0
  let expensiveNext = false
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    let value: number
    if (grid.kind === 'hex') {
      value = hexDistance(cellAt(grid, a[0], a[1]), cellAt(grid, b[0], b[1]))
    } else {
      const dx = Math.abs(b[0] - a[0]) / grid.size
      const dz = Math.abs(b[1] - a[1]) / grid.size
      if (diagonal === 'equal') value = Math.max(dx, dz)
      else if (diagonal === 'alternating') {
        const diagonals = Math.round(Math.min(dx, dz))
        const straight = Math.abs(dx - dz)
        value = straight + Math.floor(diagonals / 2) * 3
        if (diagonals % 2 === 1) {
          value += expensiveNext ? 2 : 1
          expensiveNext = !expensiveNext
        }
      } else value = Math.sqrt(dx * dx + dz * dz)
    }
    legs.push(value)
    total += value
  }
  return { legs, total }
}
