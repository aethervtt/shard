import type { ByteReader, ByteWriter, ComponentDef, RowCodec, Table } from '@aethervtt/shard-core'
import { type ReplicationEntry, replicate } from '@aethervtt/shard-net'
import { Ragdoll, REACTION_STATES, Reaction } from './components'

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** A float as IEEE half precision (rounded to nearest; overflow to ±65504). */
export function toHalf(v: number): number {
  f32[0] = v
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  const exp = ((x >>> 23) & 0xff) - 127 + 15
  let mant = x & 0x7fffff
  if (exp <= 0) {
    if (exp < -10) return sign
    mant = (mant | 0x800000) >> (1 - exp)
    return sign | ((mant + 0x1000) >> 13)
  }
  if (exp >= 31) return sign | 0x7bff
  const h = sign | (exp << 10) | ((mant + 0x1000) >> 13)
  return (h & 0x7fff) > 0x7bff ? sign | 0x7bff : h
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >>> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024)
  if (exp === 31) return sign * 65504
  return sign * 2 ** (exp - 15) * (1 + mant / 1024)
}

/**
 * Reaction on the wire (0117): 16 bytes. State and the launch flag (1), bone, rest and role (3),
 * the impulse or launch as three f16 (6), seq (2), and the server time it began, f32 (4).
 * Stagger stays on the server.
 */
export function reactionCodec(def: ComponentDef): RowCodec {
  const d = def as typeof Reaction
  const write = (
    w: ByteWriter,
    state: number,
    launch: boolean,
    bone: number,
    rest: number,
    role: number,
    impulse: ArrayLike<number>,
    seq: number,
    since: number,
  ) => {
    w.u8(state | (launch ? 0x80 : 0))
    w.u8(bone)
    w.u8(rest)
    w.u8(role)
    w.u16(toHalf(impulse[0]!))
    w.u16(toHalf(impulse[1]!))
    w.u16(toHalf(impulse[2]!))
    w.u16(seq)
    w.f32(since)
  }
  return {
    def,
    encodeRow(table: Table, row: number, w: ByteWriter) {
      write(
        w,
        table.column(d, 'state')[row]!,
        table.column(d, 'launch')[row] !== 0,
        table.column(d, 'bone')[row]!,
        table.column(d, 'rest')[row]!,
        table.column(d, 'role')[row]!,
        table.column(d, 'impulse').subarray(row * 3, row * 3 + 3),
        table.column(d, 'seq')[row]!,
        table.column(d, 'since')[row]!,
      )
    },
    decodeRow(r: ByteReader, table: Table, row: number) {
      const s = r.u8()
      table.column(d, 'state')[row] = s & 0x7f
      table.column(d, 'launch')[row] = s & 0x80 ? 1 : 0
      table.column(d, 'bone')[row] = r.u8()
      table.column(d, 'rest')[row] = r.u8()
      table.column(d, 'role')[row] = r.u8()
      const imp = table.column(d, 'impulse')
      imp[row * 3] = fromHalf(r.u16())
      imp[row * 3 + 1] = fromHalf(r.u16())
      imp[row * 3 + 2] = fromHalf(r.u16())
      table.column(d, 'seq')[row] = r.u16()
      table.column(d, 'since')[row] = r.f32()
      table.column(d, 'stagger')[row] = 0
      table.markChanged(d, row)
      return true
    },
    encode(value, w) {
      const v = value as Record<string, unknown>
      write(
        w,
        Math.max(
          0,
          REACTION_STATES.indexOf((v.state as (typeof REACTION_STATES)[number]) ?? 'none'),
        ),
        v.launch === true,
        Number(v.bone ?? 0),
        Number(v.rest ?? 0),
        Number(v.role ?? 255),
        (v.impulse as number[] | undefined) ?? [0, 0, 0],
        Number(v.seq ?? 0),
        Number(v.since ?? 0),
      )
    },
    decode(r) {
      const s = r.u8()
      return {
        state: REACTION_STATES[s & 0x7f] ?? 'none',
        launch: (s & 0x80) !== 0,
        bone: r.u8(),
        rest: r.u8(),
        role: r.u8(),
        impulse: [fromHalf(r.u16()), fromHalf(r.u16()), fromHalf(r.u16())],
        seq: r.u16(),
        since: r.f32(),
        stagger: 0,
      }
    },
  } as RowCodec
}

/**
 * What reactions replicate, for `netPlugin({ replicate: [...ragdollReplicate(), …] })` on both
 * sides: Ragdoll, and Reaction through its 16-byte codec.
 */
export function ragdollReplicate(): ReplicationEntry[] {
  return [replicate(Ragdoll), replicate(Reaction, { codec: reactionCodec })]
}
