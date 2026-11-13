import {
  type ByteReader,
  type ByteWriter,
  type ComponentDef,
  defineComponent,
  type RowCodec,
  type Table,
  t,
} from '@aethervtt/shard-core'

/** On a zombie: who it is across saves, dormancy and the wire, and which look stands in for it. */
export const HordeMember = defineComponent(
  'characters/HordeMember',
  {
    id: t.u32({
      description:
        'Stable id: the client matches live replicated zombies to far proxies by it. 0 is assigned by the server.',
    }),
    look: t.u16({ description: 'Index of a registered look (characterLooks) its proxy wears.' }),
  },
  {
    description:
      'A horde member (0115): replicated, saved, and kept in 0113 dormant entities, so it shows past replication.',
  },
)

/**
 * A server entity per occupied cell near a player (0115): its members' ids and looks, sent only
 * when membership changes. `rev` ties them to the HordeMembers positions that index them.
 */
export const HordeCell = defineComponent(
  'characters/HordeCell',
  {
    grid: t.u8(),
    x: t.i32(),
    z: t.i32(),
    y: t.f32({ description: 'Height the members’ y (i8 at 0.25 m) is relative to.' }),
    rev: t.u16({ description: 'Membership revision (wraps).' }),
    ids: t.list(t.u32(), { description: 'HordeMember ids, ascending.' }),
    looks: t.list(t.u16(), { description: 'Each member’s look, by position in ids.' }),
  },
  { description: 'Horde members of one cell, past replication (0115).' },
)

/** The cell's members' packed positions, refreshed at 2 Hz: 4 bytes each, by position in ids. */
export const HordeMembers = defineComponent(
  'characters/HordeMembers',
  {
    rev: t.u16({ description: 'The HordeCell membership revision these positions index.' }),
    members: t.list(t.u32(), {
      description:
        'Per member: x u8 and z u8 within the cell (cellSize/256 m), y i8 (0.25 m) from HordeCell.y, heading 5 bits + activity 3 bits.',
    }),
  },
  { description: 'Packed horde member positions of a HordeCell (0115).' },
)

// --- packing -----------------------------------------------------------------------------------

/** Activities a member's packed byte carries; a look's `clips` follow this order. */
export const ACTIVITIES = ['idle', 'walk', 'attack'] as const
export const IDLE = 0
export const WALK = 1
export const ATTACK = 2

/** Height step of a member's y (m). */
export const Y_STEP = 0.25
const TWO_PI = Math.PI * 2
const HEADINGS = 32

/** One member's world position and yaw (radians), relative to a cell. */
export interface MemberPose {
  x: number
  y: number
  z: number
  yaw: number
  activity: number
}

/**
 * Packs one member: x and z in steps of cellSize/256 from the cell's corner (clamped into the
 * cell), y in 0.25 m steps from `baseY` (clamped to ±31.75 m), heading in 32 steps, activity 0–7.
 */
export function packMember(
  cellSize: number,
  cellX: number,
  cellZ: number,
  baseY: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  activity: number,
): number {
  const step = cellSize / 256
  let qx = Math.floor((x - cellX * cellSize) / step)
  let qz = Math.floor((z - cellZ * cellSize) / step)
  qx = qx < 0 ? 0 : qx > 255 ? 255 : qx
  qz = qz < 0 ? 0 : qz > 255 ? 255 : qz
  let qy = Math.round((y - baseY) / Y_STEP)
  qy = qy < -127 ? -127 : qy > 127 ? 127 : qy
  let h = Math.round((yaw / TWO_PI) * HEADINGS) % HEADINGS
  if (h < 0) h += HEADINGS
  return (qx | (qz << 8) | ((qy & 0xff) << 16) | ((h | ((activity & 7) << 5)) << 24)) >>> 0
}

/** Whether `y` packs without clamping against `baseY`. */
export function yFits(baseY: number, y: number): boolean {
  const q = Math.round((y - baseY) / Y_STEP)
  return q >= -127 && q <= 127
}

/** Unpacks into `out`: the centre of the member's x/z step, its y, yaw and activity. */
export function unpackMember(
  word: number,
  cellSize: number,
  cellX: number,
  cellZ: number,
  baseY: number,
  out: MemberPose,
): MemberPose {
  const step = cellSize / 256
  out.x = cellX * cellSize + ((word & 0xff) + 0.5) * step
  out.z = cellZ * cellSize + (((word >>> 8) & 0xff) + 0.5) * step
  out.y = baseY + ((((word >>> 16) & 0xff) << 24) >> 24) * Y_STEP
  const top = word >>> 24
  out.yaw = ((top & 31) / HEADINGS) * TWO_PI
  out.activity = top >>> 5
  return out
}

// --- wire codecs -------------------------------------------------------------------------------
// Lists cross the schema codec as JSON text (about 11 bytes a packed member). These write them as
// bytes: members 4 bytes each; ids ascending as deltas (about 1 byte each); looks as nibbles when
// there are at most 16 (half a byte). Passed to net's `replicate(…, { codec })`.

type Lists = number[][]
/** How a list is written: members as u32, ids as ascending deltas, looks as nibbles. */
const FIXED = 0
const IDS = 1
const LOOKS = 2

function readInto(r: ByteReader, list: number[], kind: number): number[] {
  const n = r.varuint()
  list.length = n
  if (kind === FIXED) {
    for (let i = 0; i < n; i++) list[i] = r.u32()
    return list
  }
  const mode = n > 0 ? r.u8() : 0
  if (mode === 0) for (let i = 0; i < n; i++) list[i] = r.varuint()
  else if (kind === IDS) {
    let v = r.varuint()
    list[0] = v
    for (let i = 1; i < n; i++) {
      v += r.varuint() + 1
      list[i] = v
    }
  } else {
    for (let i = 0; i < n; i += 2) {
      const b = r.u8()
      list[i] = b & 15
      if (i + 1 < n) list[i + 1] = b >>> 4
    }
  }
  return list
}

function listInto(column: unknown[], row: number, r: ByteReader, kind: number): void {
  let list = column[row] as number[] | undefined
  if (!list) {
    list = []
    column[row] = list
  }
  readInto(r, list, kind)
}

function writeList(w: ByteWriter, list: readonly number[] | undefined, kind: number): void {
  const n = list?.length ?? 0
  w.varuint(n)
  if (n === 0) return
  const l = list!
  if (kind === FIXED) {
    for (let i = 0; i < n; i++) w.u32(l[i]!)
    return
  }
  let packed = true
  for (let i = 0; i < n && packed; i++) {
    if (kind === IDS ? i > 0 && l[i]! <= l[i - 1]! : l[i]! > 15) packed = false
  }
  w.u8(packed ? 1 : 0)
  if (!packed) for (let i = 0; i < n; i++) w.varuint(l[i]!)
  else if (kind === IDS) {
    w.varuint(l[0]!)
    for (let i = 1; i < n; i++) w.varuint(l[i]! - l[i - 1]! - 1)
  } else {
    for (let i = 0; i < n; i += 2) w.u8(l[i]! | ((i + 1 < n ? l[i + 1]! : 0) << 4))
  }
}

export function hordeCellCodec(def: ComponentDef): RowCodec {
  const d = def as typeof HordeCell
  return {
    def,
    encodeRow(table: Table, row: number, w: ByteWriter) {
      w.u8(table.column(d, 'grid')[row]!)
      w.varint(table.column(d, 'x')[row]!)
      w.varint(table.column(d, 'z')[row]!)
      w.f32(table.column(d, 'y')[row]!)
      w.u16(table.column(d, 'rev')[row]!)
      writeList(w, (table.column(d, 'ids') as unknown as Lists)[row], IDS)
      writeList(w, (table.column(d, 'looks') as unknown as Lists)[row], LOOKS)
    },
    decodeRow(r: ByteReader, table: Table, row: number) {
      table.column(d, 'grid')[row] = r.u8()
      table.column(d, 'x')[row] = r.varint()
      table.column(d, 'z')[row] = r.varint()
      table.column(d, 'y')[row] = r.f32()
      table.column(d, 'rev')[row] = r.u16()
      listInto(table.column(d, 'ids') as unknown as unknown[], row, r, IDS)
      listInto(table.column(d, 'looks') as unknown as unknown[], row, r, LOOKS)
      table.markChanged(d, row)
      return true
    },
    encode(value, w) {
      const v = value as Record<string, unknown>
      w.u8(Number(v.grid ?? 0))
      w.varint(Number(v.x ?? 0))
      w.varint(Number(v.z ?? 0))
      w.f32(Number(v.y ?? 0))
      w.u16(Number(v.rev ?? 0))
      writeList(w, v.ids as number[] | undefined, IDS)
      writeList(w, v.looks as number[] | undefined, LOOKS)
    },
    decode(r) {
      return {
        grid: r.u8(),
        x: r.varint(),
        z: r.varint(),
        y: r.f32(),
        rev: r.u16(),
        ids: readInto(r, [], IDS),
        looks: readInto(r, [], LOOKS),
      }
    },
  } as RowCodec
}

export function hordeMembersCodec(def: ComponentDef): RowCodec {
  const d = def as typeof HordeMembers
  return {
    def,
    encodeRow(table: Table, row: number, w: ByteWriter) {
      w.u16(table.column(d, 'rev')[row]!)
      writeList(w, (table.column(d, 'members') as unknown as Lists)[row], FIXED)
    },
    decodeRow(r: ByteReader, table: Table, row: number) {
      table.column(d, 'rev')[row] = r.u16()
      listInto(table.column(d, 'members') as unknown as unknown[], row, r, FIXED)
      table.markChanged(d, row)
      return true
    },
    encode(value, w) {
      const v = value as Record<string, unknown>
      w.u16(Number(v.rev ?? 0))
      writeList(w, v.members as number[] | undefined, FIXED)
    },
    decode(r) {
      return { rev: r.u16(), members: readInto(r, [], FIXED) }
    },
  } as RowCodec
}
