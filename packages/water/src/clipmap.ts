import type { WaterBodiesState } from './bodies'
import { groundAt } from './query'
import { INFO_LEVELS, INFO_SIZE, INFO_TEXEL, MAX_RINGS, NO_GROUND, RING_CELLS } from './shaders'

// The CPU side of the info texture and the surface rings (0097): where each clipmap level sits
// around the camera, the ground under each level's texels (filled from the terrain on the CPU and
// kept toroidally, so a move fills only the texels that scrolled in), and which rings draw. None of
// it allocates per frame.

/** Texels a level's window snaps to: it moves (and rebuilds) every 8 texels of camera travel. */
export const INFO_SNAP = 8
/** Ground texels filled per frame at most (each a terrain lookup). */
export const GROUND_TEXELS_PER_FRAME = 32768
/** Metres per cell of the innermost surface ring; each ring doubles it. */
export const RING_BASE_CELL = 0.5

const TEXELS = INFO_SIZE * INFO_SIZE
const UNFILLED = -2147483648

/** Metres per texel of a clipmap level. */
export const levelTexel = (level: number) => INFO_TEXEL * 4 ** level

const mod = (a: number, n: number) => ((a % n) + n) % n

export class InfoClipmap {
  /** Each level's window: its first texel's cell (x, z), in that level's texels. */
  readonly origin = new Int32Array(INFO_LEVELS * 2)
  readonly placed = new Uint8Array(INFO_LEVELS)
  /** Levels whose info layer must be redrawn. */
  readonly dirty = new Uint8Array(INFO_LEVELS)
  /** Ground per level, toroidal: cell (x, z) lives at texel (x mod size, z mod size). */
  readonly ground: Float32Array[] = []
  /** The cell each ground texel holds (UNFILLED before its first fill). */
  readonly cellX: Int32Array[] = []
  readonly cellZ: Int32Array[] = []
  /** Levels whose ground isn't filled yet for their window, and where the fill got to. */
  readonly pending = new Uint8Array(INFO_LEVELS)
  readonly cursor = new Int32Array(INFO_LEVELS)
  /** Levels whose ground changed since the last upload. */
  readonly groundChanged = new Uint8Array(INFO_LEVELS)
  bodiesVersion = -1
  terrainVersion = Number.NaN
  /** Ground texels filled in the last update. */
  filled = 0
  /** Info layers redrawn last frame, and since the start. */
  rebuilds = 0
  totalRebuilds = 0

  constructor() {
    for (let l = 0; l < INFO_LEVELS; l++) {
      this.ground.push(new Float32Array(TEXELS).fill(NO_GROUND))
      this.cellX.push(new Int32Array(TEXELS).fill(UNFILLED))
      this.cellZ.push(new Int32Array(TEXELS).fill(UNFILLED))
    }
  }

  /** The world x or z of a level's first texel corner. */
  corner(level: number, axis: 0 | 1): number {
    return this.origin[level * 2 + axis]! * levelTexel(level)
  }

  /**
   * Moves the windows to the camera, marks levels to redraw (moved, bodies or terrain changed),
   * and fills up to `budget` ground texels. Returns whether any level needs drawing.
   */
  update(state: WaterBodiesState, x: number, z: number, budget = GROUND_TEXELS_PER_FRAME): boolean {
    if (state.version !== this.bodiesVersion) {
      this.bodiesVersion = state.version
      this.dirty.fill(1)
    }
    if (state.terrainVersion !== this.terrainVersion || state.groundRefresh) {
      this.terrainVersion = state.terrainVersion
      state.groundRefresh = false
      state.groundEdits.length = 0
      for (let l = 0; l < INFO_LEVELS; l++) {
        this.cellX[l]!.fill(UNFILLED)
        this.pending[l] = 1
        this.cursor[l] = 0
      }
    }
    // Terrain edits (0104): the texels under them refill.
    const edits = state.groundEdits
    for (let k = 0; k < edits.length; k += 4)
      this.invalidate(edits[k]!, edits[k + 1]!, edits[k + 2]!, edits[k + 3]!)
    edits.length = 0
    for (let l = 0; l < INFO_LEVELS; l++) {
      const t = levelTexel(l)
      const ox = Math.floor(Math.floor(x / t) / INFO_SNAP) * INFO_SNAP - INFO_SIZE / 2
      const oz = Math.floor(Math.floor(z / t) / INFO_SNAP) * INFO_SNAP - INFO_SIZE / 2
      if (!this.placed[l] || ox !== this.origin[l * 2] || oz !== this.origin[l * 2 + 1]) {
        this.placed[l] = 1
        this.origin[l * 2] = ox
        this.origin[l * 2 + 1] = oz
        this.dirty[l] = 1
        this.pending[l] = 1
        this.cursor[l] = 0
      }
    }
    this.filled = 0
    for (let l = 0; l < INFO_LEVELS && this.filled < budget; l++) {
      if (this.pending[l]) this.fillGround(state, l, budget)
    }
    let any = false
    for (let l = 0; l < INFO_LEVELS; l++) if (this.dirty[l]) any = true
    return any
  }

  /** Marks every level's ground texels over a world rectangle unfilled, so they read the ground again. */
  invalidate(x0: number, z0: number, x1: number, z1: number): void {
    for (let l = 0; l < INFO_LEVELS; l++) {
      const t = levelTexel(l)
      const cx = this.cellX[l]!
      let any = false
      for (let z = Math.floor(z0 / t); z <= Math.floor(z1 / t); z++) {
        for (let x = Math.floor(x0 / t); x <= Math.floor(x1 / t); x++) {
          const i = mod(z, INFO_SIZE) * INFO_SIZE + mod(x, INFO_SIZE)
          if (cx[i] !== x || this.cellZ[l]![i] !== z) continue
          cx[i] = UNFILLED
          any = true
        }
      }
      if (any) {
        this.pending[l] = 1
        this.cursor[l] = 0
      }
    }
  }

  /** Fills a level's ground texels that don't hold their window's cells yet, from the cursor on. */
  private fillGround(state: WaterBodiesState, l: number, budget: number): void {
    const t = levelTexel(l)
    const ox = this.origin[l * 2]!
    const oz = this.origin[l * 2 + 1]!
    const ground = this.ground[l]!
    const cx = this.cellX[l]!
    const cz = this.cellZ[l]!
    const noTerrain = state.terrainCount === 0
    let i = this.cursor[l]!
    for (; i < TEXELS; i++) {
      const tx = i % INFO_SIZE
      const tz = (i - tx) / INFO_SIZE
      const x = ox + mod(tx - ox, INFO_SIZE)
      const z = oz + mod(tz - oz, INFO_SIZE)
      if (cx[i] === x && cz[i] === z) continue
      if (this.filled >= budget) break
      cx[i] = x
      cz[i] = z
      const h = noTerrain ? NO_GROUND : groundAt(state, (x + 0.5) * t, 0, (z + 0.5) * t)
      ground[i] = h > NO_GROUND ? h : NO_GROUND
      this.filled++
      this.groundChanged[l] = 1
    }
    this.cursor[l] = i
    if (i >= TEXELS) this.pending[l] = 0
    // Redraw the level as its ground arrives, so the surface collapses below it as it fills.
    if (this.groundChanged[l]) this.dirty[l] = 1
  }
}

/** Rings: each one's centre and cell size, its hole's offset, and which draw this frame. */
export class SurfaceRings {
  /** Per ring: centre x, z (m). */
  readonly centre = new Float64Array(MAX_RINGS * 2)
  /** Per ring: the hole variant (0–3: its x and z offset of one cell), or -1 for the full grid. */
  readonly variant = new Int8Array(MAX_RINGS)
  /** Rings that draw, in order; `count` of them. */
  readonly draws = new Int32Array(MAX_RINGS)
  count = 0
  /** The ring that runs to the horizon, or -1. */
  last = -1
}

/** Metres per cell of ring k. */
export const ringCell = (k: number) => RING_BASE_CELL * 2 ** k

/** The info level a ring with this cell size reads: the finest whose texels are at least as large. */
export function ringLevel(cell: number): number {
  for (let l = 0; l < INFO_LEVELS; l++) if (levelTexel(l) >= cell) return l
  return INFO_LEVELS - 1
}

/**
 * Places the rings around the camera (x, z): ring k snaps to twice its cell, so its hole lines up
 * with ring k − 1 by a whole cell either way. Rings that don't reach any bounded body are skipped
 * unless an unbounded ocean is there; the ocean's outermost ring runs to the horizon.
 */
export function placeRings(rings: SurfaceRings, state: WaterBodiesState, x: number, z: number) {
  rings.count = 0
  rings.last = -1
  const half = RING_CELLS / 2
  const b = state.bounds
  for (let k = 0; k < MAX_RINGS; k++) {
    const s = ringCell(k)
    const cx = Math.floor(x / (2 * s)) * 2 * s
    const cz = Math.floor(z / (2 * s)) * 2 * s
    rings.centre[k * 2] = cx
    rings.centre[k * 2 + 1] = cz
    if (k === 0) rings.variant[k] = -1
    else {
      const dx = Math.round((rings.centre[(k - 1) * 2]! - cx) / s)
      const dz = Math.round((rings.centre[(k - 1) * 2 + 1]! - cz) / s)
      rings.variant[k] = dx + dz * 2
    }
    const r = half * s
    const reaches = cx + r >= b[0]! && cz + r >= b[1]! && cx - r <= b[2]! && cz - r <= b[3]!
    if (state.unbounded || reaches) rings.draws[rings.count++] = k
  }
  if (state.unbounded) rings.last = MAX_RINGS - 1
}
