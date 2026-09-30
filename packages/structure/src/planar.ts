// The planar barrier split (0055): each wall cut into spans around its openings, with sight and
// movement channels. A pure function a host may reuse for its own vision and movement rules;
// nothing in the engine depends on it. It matches the split structure compile draws.

export type Channel = 'none' | 'normal'

export interface PlanarWall {
  id: string
  a: readonly [number, number]
  b: readonly [number, number]
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
 * its own channels, and an open door's carries neither. Openings sort by offset, then id.
 */
export function planarBarriers(
  walls: readonly PlanarWall[],
  openings: readonly PlanarOpening[],
): Segment[] {
  const byWall = new Map<string, PlanarOpening[]>()
  for (const opening of openings) {
    const list = byWall.get(opening.wall)
    if (list) list.push(opening)
    else byWall.set(opening.wall, [opening])
  }
  const out: Segment[] = []
  for (const wall of walls) {
    const dx = wall.b[0] - wall.a[0]
    const dy = wall.b[1] - wall.a[1]
    const length = Math.sqrt(dx * dx + dy * dy)
    if (length < 1e-6) continue
    const list = (byWall.get(wall.id) ?? []).slice()
    list.sort((p, q) => p.offset - q.offset || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
    let cursor = 0
    for (const opening of list) {
      if (opening.offset > cursor)
        out.push(
          span(
            wall,
            length,
            cursor,
            opening.offset,
            `struct:${wall.id}:${cursor}`,
            'normal',
            'normal',
          ),
        )
      const open = opening.kind === 'door' && opening.state === 'open'
      const segment = span(
        wall,
        length,
        opening.offset,
        opening.offset + opening.width,
        `struct-opening:${opening.id}`,
        open ? 'none' : opening.sight,
        open ? 'none' : opening.movement,
      )
      segment.openingId = opening.id
      out.push(segment)
      cursor = opening.offset + opening.width
    }
    if (cursor < length)
      out.push(
        span(wall, length, cursor, length, `struct:${wall.id}:${cursor}`, 'normal', 'normal'),
      )
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
