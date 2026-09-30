import { polygon } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import {
  ClipScratch,
  chunkKey,
  chunkX,
  chunkZ,
  emitFloor,
  emitWall,
  floorChunks,
  floorShape,
  MeshBuilder,
  type OpeningShape,
  type Piece,
  type WallShape,
  wallChunks,
  wallPieces,
} from './geometry'

const wall = (
  ax: number,
  az: number,
  bx: number,
  bz: number,
  extra: Partial<WallShape> = {},
): WallShape => ({
  ax,
  az,
  bx,
  bz,
  height: 3,
  thickness: 0.2,
  elevation: 0,
  ...extra,
})

const door = (offset: number, extra: Partial<OpeningShape> = {}): OpeningShape => ({
  kind: 'door',
  offset,
  width: 1,
  height: 2.1,
  sill: 0,
  frameWidth: 0.08,
  frameDepth: 0.04,
  ...extra,
})

/** Separating-axis overlap of a wall's thick footprint (all pieces' extent) and a chunk square. */
function referenceOverlap(
  w: WallShape,
  half: number,
  s0: number,
  s1: number,
  size: number,
  cx: number,
  cz: number,
): boolean {
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az)
  const dx = (w.bx - w.ax) / len
  const dz = (w.bz - w.az) / len
  const corners: [number, number][] = []
  for (const s of [s0, s1])
    for (const t of [-half, half]) corners.push([w.ax + dx * s - dz * t, w.az + dz * s + dx * t])
  const square: [number, number][] = [
    [cx * size, cz * size],
    [(cx + 1) * size, cz * size],
    [(cx + 1) * size, (cz + 1) * size],
    [cx * size, (cz + 1) * size],
  ]
  const axes: [number, number][] = [
    [1, 0],
    [0, 1],
    [dx, dz],
    [-dz, dx],
  ]
  for (const [ax, az] of axes) {
    const project = (pts: [number, number][]) => {
      let lo = Infinity
      let hi = -Infinity
      for (const [x, z] of pts) {
        const d = x * ax + z * az
        lo = Math.min(lo, d)
        hi = Math.max(hi, d)
      }
      return [lo, hi] as const
    }
    const [a0, a1] = project(corners)
    const [b0, b1] = project(square)
    // Touching edges without area don't overlap.
    if (a1 <= b0 + 1e-9 || b1 <= a0 + 1e-9) return false
  }
  return true
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('wall pieces', () => {
  it('splits a wall around a door and a window into spans, lintels, sills and frames', () => {
    const pieces: Piece[] = []
    const w = wall(0, 0, 6, 0)
    const n = wallPieces(w, [door(1), door(4, { kind: 'window', sill: 1, height: 1 })], pieces)
    const body = pieces.slice(0, n).filter((p) => !p.frame)
    // Solid 0–1, lintel over the door, solid 2–4, below and above the window, solid 5–6.
    expect(body.map((p) => [p.s0, p.s1, p.y0, p.y1])).toEqual([
      [0, 1, 0, 3],
      [1, 2, 2.1, 3],
      [2, 4, 0, 3],
      [4, 5, 0, 1],
      [4, 5, 2, 3],
      [5, 6, 0, 3],
    ])
    const lintel = body[1]!
    expect(lintel.bottom).toBe(true)
    expect(lintel.capStart || lintel.capEnd).toBe(false)
    // Door frame: two jambs and a head; window frame: jambs, head and a sill rail.
    const frames = pieces.slice(0, n).filter((p) => p.frame)
    expect(frames.filter((p) => p.source === 0)).toHaveLength(3)
    expect(frames.filter((p) => p.source === 1)).toHaveLength(4)
    for (const f of frames) expect(f.half).toBeCloseTo(0.1 + 0.04, 9)
  })
})

describe('chunks', () => {
  it('a wall overlaps exactly the chunks the reference overlap test finds', () => {
    const random = rng(7)
    const scratch = new ClipScratch()
    const pieces: Piece[] = []
    for (let k = 0; k < 400; k++) {
      const ax = (random() - 0.5) * 60
      const az = (random() - 0.5) * 60
      const angle = random() * Math.PI * 2
      const length = 0.5 + random() * 20
      const w = wall(ax, az, ax + Math.cos(angle) * length, az + Math.sin(angle) * length, {
        thickness: 0.05 + random() * 0.6,
      })
      const n = wallPieces(w, [], pieces)
      const found = new Set<number>()
      wallChunks(w, pieces, n, 8, found, scratch)
      const expected = new Set<number>()
      for (let cx = -12; cx <= 12; cx++)
        for (let cz = -12; cz <= 12; cz++)
          if (referenceOverlap(w, w.thickness / 2, 0, length, 8, cx, cz))
            expected.add(chunkKey(cx, cz))
      expect([...found].sort()).toEqual([...expected].sort())
    }
  })

  it('a wall along a chunk edge belongs to both chunks, and its parts meet without caps', () => {
    const scratch = new ClipScratch()
    const pieces: Piece[] = []
    const w = wall(2, 8, 6, 8)
    const n = wallPieces(w, [], pieces)
    const found = new Set<number>()
    wallChunks(w, pieces, n, 8, found, scratch)
    expect([...found].map((k) => [chunkX(k), chunkZ(k)]).sort()).toEqual([
      [0, 0],
      [0, 1],
    ])
    // Top area split across the two chunks sums to the whole top.
    let top = 0
    for (const key of found) {
      const b = new MeshBuilder()
      const x = chunkX(key) * 8
      const z = chunkZ(key) * 8
      emitWall(w, pieces, n, x, z, x + 8, z + 8, () => b, scratch)
      for (let i = 0; i < b.indexCount; i += 3) {
        const [p, q, r] = [b.indices[i]! * 3, b.indices[i + 1]! * 3, b.indices[i + 2]! * 3]
        const ys = [b.positions[p + 1], b.positions[q + 1], b.positions[r + 1]]
        if (ys.every((y) => y === 3))
          top +=
            Math.abs(
              (b.positions[q]! - b.positions[p]!) * (b.positions[r + 2]! - b.positions[p + 2]!) -
                (b.positions[r]! - b.positions[p]!) * (b.positions[q + 2]! - b.positions[p + 2]!),
            ) / 2
      }
      // No face lies on the cut (z = 8): every vertical face's normal is along x or z of the wall.
      for (let v = 0; v < b.vertexCount; v++) {
        if (b.normals[v * 3 + 1] !== 0) continue
        const onCut = Math.abs(b.positions[v * 3 + 2]! - 8) < 1e-6
        const facesCut = Math.abs(b.normals[v * 3 + 2]!) === 1
        expect(onCut && facesCut && b.positions[v * 3]! > 2 && b.positions[v * 3]! < 6).toBe(false)
      }
    }
    expect(top).toBeCloseTo(4 * 0.2, 5)
  })

  it('clips a 60 m concave floor into chunks at its exact area, each part inside its chunk', () => {
    // A comb: a 60 m bar with deep notches crossing chunk boundaries.
    const points: [number, number][] = [
      [0, 0],
      [60, 0],
      [60, 40],
    ]
    for (let i = 12; i > 0; i--) {
      const x = i * 5
      const top = i % 2 === 0 ? 40 : 6
      points.push([x, top], [x - 5, top])
    }
    const flat = points.flat()
    const area = Math.abs(polygon.signedArea(flat))
    const shape = floorShape(points, 0)
    const scratch = new ClipScratch()
    const chunks = new Set<number>()
    floorChunks(shape, 8, chunks, scratch)
    let total = 0
    for (const key of chunks) {
      const b = new MeshBuilder()
      const x0 = chunkX(key) * 8
      const z0 = chunkZ(key) * 8
      expect(emitFloor(shape, x0, z0, x0 + 8, z0 + 8, b, scratch)).toBe(true)
      for (let v = 0; v < b.vertexCount; v++) {
        const x = b.positions[v * 3]!
        const z = b.positions[v * 3 + 2]!
        expect(x).toBeGreaterThanOrEqual(x0 - 1e-9)
        expect(x).toBeLessThanOrEqual(x0 + 8 + 1e-9)
        expect(z).toBeGreaterThanOrEqual(z0 - 1e-9)
        expect(z).toBeLessThanOrEqual(z0 + 8 + 1e-9)
        expect(b.normals[v * 3 + 1]).toBe(1)
      }
      let part = 0
      for (let i = 0; i < b.indexCount; i += 3) {
        const [p, q, r] = [b.indices[i]! * 3, b.indices[i + 1]! * 3, b.indices[i + 2]! * 3]
        // Wound to face up: (q − p) × (r − p) points along +y.
        const cross =
          (b.positions[r]! - b.positions[p]!) * (b.positions[q + 2]! - b.positions[p + 2]!) -
          (b.positions[q]! - b.positions[p]!) * (b.positions[r + 2]! - b.positions[p + 2]!)
        expect(cross).toBeGreaterThanOrEqual(-1e-9)
        part += Math.abs(cross) / 2
      }
      expect(part).toBeLessThanOrEqual(64 + 1e-6)
      total += part
    }
    expect(Math.abs(total - area) / area).toBeLessThan(0.001)
  })
})
