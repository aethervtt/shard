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

// ---------------------------------------------------------------------------
// Snapping (0066): Aether's rules, so a host's tools and an agent snap walls and tokens alike.

type Point = [number, number]

function hexCorners(grid: GridGeometry, cx: number, cz: number, out: Point[]): void {
  const radius = grid.size / SQRT3
  const start = grid.orientation === 'pointy' ? -30 : 0
  for (let i = 0; i < 6; i++) {
    const a = ((start + i * 60) * Math.PI) / 180
    out.push([cx + radius * Math.cos(a), cz + radius * Math.sin(a)])
  }
}

/** The centres of the hex containing (x, z) and its six neighbours. */
function nearbyHexes(grid: GridGeometry, x: number, z: number): Point[] {
  const cell = cellAt(grid, x, z)
  return [cell, ...neighbors(grid, cell)].map((c) => cellCenter(grid, c))
}

function nearest(x: number, z: number, choices: readonly Point[]): Point {
  let best = choices[0] ?? [x, z]
  let d = Infinity
  for (const c of choices) {
    const e = (c[0] - x) ** 2 + (c[1] - z) ** 2
    if (e < d) {
      d = e
      best = c
    }
  }
  return [best[0], best[1]]
}

/** The grid corner nearest (x, z): a square's intersection, or a hex's vertex. */
export function gridVertex(grid: GridGeometry, x: number, z: number): Point {
  if (grid.kind === 'square') {
    return [
      grid.offset[0] + Math.round((x - grid.offset[0]) / grid.size) * grid.size,
      grid.offset[1] + Math.round((z - grid.offset[1]) / grid.size) * grid.size,
    ]
  }
  const corners: Point[] = []
  for (const [cx, cz] of nearbyHexes(grid, x, z)) hexCorners(grid, cx, cz, corners)
  return nearest(x, z, corners)
}

/** The midpoints of the edges of the cell containing (x, z). */
export function edgeMidpoints(grid: GridGeometry, x: number, z: number): Point[] {
  const [cx, cz] = cellCenter(grid, cellAt(grid, x, z))
  if (grid.kind === 'square') {
    const h = grid.size / 2
    return [
      [cx, cz - h],
      [cx + h, cz],
      [cx, cz + h],
      [cx - h, cz],
    ]
  }
  const corners: Point[] = []
  hexCorners(grid, cx, cz, corners)
  return corners.map((a, i) => {
    const b = corners[(i + 1) % 6]!
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  })
}

/** Where a wall's end snaps: the nearest cell corner or edge midpoint. */
export function wallAnchor(grid: GridGeometry, x: number, z: number): Point {
  if (grid.kind === 'square')
    return nearest(x, z, [gridVertex(grid, x, z), ...edgeMidpoints(grid, x, z)])
  const features: Point[] = []
  for (const [cx, cz] of nearbyHexes(grid, x, z)) {
    const corners: Point[] = []
    hexCorners(grid, cx, cz, corners)
    features.push(...corners)
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!
      const b = corners[(i + 1) % 6]!
      features.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
    }
  }
  return nearest(x, z, features)
}

/**
 * Where a token's centre snaps: odd square footprints (in cells) to a cell centre, even ones to an
 * intersection; hex tokens always to a cell centre.
 */
export function tokenCenter(grid: GridGeometry, x: number, z: number, footprint = 1): Point {
  if (grid.kind === 'hex' || Math.max(1, Math.round(footprint)) % 2 === 1)
    return cellCenter(grid, cellAt(grid, x, z))
  return gridVertex(grid, x, z)
}
