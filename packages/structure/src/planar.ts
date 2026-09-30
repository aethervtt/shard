// The planar barrier split (0055, 0066): each wall cut into spans around its openings, with sight
// and movement channels. A pure function a host's server calls for its vision and movement rules;
// nothing in the engine depends on it. Curved walls are split at the same samples structure
// compile draws (curve.ts, one tolerance), so the server blocks what players see.

import { type Centerline, CURVE_TOLERANCE, pointAt, sampleWall, type WallCurve } from './curve'

export type Channel = 'none' | 'normal'

export interface PlanarWall {
  id: string
  a: readonly [number, number]
  b: readonly [number, number]
  /** Curved walls (0066); straight when absent. */
  shape?: WallCurve
  bow?: number
  c0?: readonly [number, number]
  c1?: readonly [number, number]
}

export interface PlanarOptions {
  /** Chord tolerance for curved walls: StructureSettings.curveTolerance. Default 0.01. */
  tolerance?: number
}

export interface PlanarOpening {
  id: string
  /** The host wall's id. */
  wall: string
  kind: 'door' | 'window'
  offset: number
  width: number
  /** Doors only; an open door blocks nothing. */
  state?: 'closed' | 'open' | 'locked'
  sight: Channel
  movement: Channel
}

export interface Segment {
  /** `struct:<wall>:<start>` for wall spans, `struct-opening:<opening>` for openings. */
  id: string
  sourceWallId: string
  openingId?: string
  a: [number, number]
  b: [number, number]
  sight: Channel
  movement: Channel
}

/**
 * Splits walls into barrier segments: solid spans block both channels; an opening's span carries
 * its own channels, and an open door's carries neither. Openings sort by offset, then id; offsets
 * are arc lengths on curved walls. A curved span becomes one segment per sample interval: the
 * first keeps the span's id, the rest append `~1`, `~2`, …
 */
export function planarBarriers(
  walls: readonly PlanarWall[],
  openings: readonly PlanarOpening[],
  options: PlanarOptions = {},
): Segment[] {
  const tolerance = options.tolerance ?? CURVE_TOLERANCE
  const byWall = new Map<string, PlanarOpening[]>()
  for (const opening of openings) {
    const list = byWall.get(opening.wall)
    if (list) list.push(opening)
    else byWall.set(opening.wall, [opening])
  }
  const out: Segment[] = []
  for (const wall of walls) {
    const curved = wall.shape === 'arc' || wall.shape === 'bezier'
    const line = curved ? sampleWall(wall, tolerance) : undefined
    const dx = wall.b[0] - wall.a[0]
    const dy = wall.b[1] - wall.a[1]
    const length = line ? line.length : Math.sqrt(dx * dx + dy * dy)
    if (length < 1e-6) continue
    const cut = (
      from: number,
      to: number,
      id: string,
      sight: Channel,
      movement: Channel,
      openingId?: string,
    ) => {
      const pieces = line
        ? curvedSpan(line, from, to, id, wall.id, sight, movement)
        : [span(wall, length, from, to, id, sight, movement)]
      for (const piece of pieces) {
        if (openingId !== undefined) piece.openingId = openingId
        out.push(piece)
      }
    }
    const list = (byWall.get(wall.id) ?? []).slice()
    list.sort((p, q) => p.offset - q.offset || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
    let cursor = 0
    for (const opening of list) {
      if (opening.offset > cursor)
        cut(cursor, opening.offset, `struct:${wall.id}:${cursor}`, 'normal', 'normal')
      const open = opening.kind === 'door' && opening.state === 'open'
      cut(
        opening.offset,
        opening.offset + opening.width,
        `struct-opening:${opening.id}`,
        open ? 'none' : opening.sight,
        open ? 'none' : opening.movement,
        opening.id,
      )
      cursor = opening.offset + opening.width
    }
    if (cursor < length) cut(cursor, length, `struct:${wall.id}:${cursor}`, 'normal', 'normal')
  }
  return out
}

/** A curved span [from, to] as segments between the centreline's samples inside it. */
function curvedSpan(
  line: Centerline,
  from: number,
  to: number,
  id: string,
  wall: string,
  sight: Channel,
  movement: Channel,
): Segment[] {
  const at = new Float64Array(4)
  const points: [number, number][] = []
  const push = (s: number) => {
    pointAt(line, s, at)
    points.push([at[0]!, at[1]!])
  }
  push(from)
  for (let i = 1; i < line.count - 1; i++) {
    const s = line.s[i]!
    if (s > from + 1e-9 && s < to - 1e-9) push(s)
  }
  push(to)
  const out: Segment[] = []
  for (let k = 0; k + 1 < points.length; k++) {
    out.push({
      id: k === 0 ? id : `${id}~${k}`,
      sourceWallId: wall,
      a: points[k]!,
      b: points[k + 1]!,
      sight,
      movement,
    })
  }
  return out
}

function span(
  wall: PlanarWall,
  length: number,
  from: number,
  to: number,
  id: string,
  sight: Channel,
  movement: Channel,
): Segment {
  const ax = wall.a[0]
  const ay = wall.a[1]
  const dx = (wall.b[0] - ax) / length
  const dy = (wall.b[1] - ay) / length
  return {
    id,
    sourceWallId: wall.id,
    a: [ax + dx * from, ay + dy * from],
    b: [ax + dx * to, ay + dy * to],
    sight,
    movement,
  }
}
