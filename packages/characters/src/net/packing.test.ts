import { ByteReader, ByteWriter, Rng } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import {
  HordeCell,
  HordeMembers,
  hordeCellCodec,
  hordeMembersCodec,
  type MemberPose,
  packMember,
  unpackMember,
  yFits,
} from './components'
import { hordeEvery } from './interest'

const out: MemberPose = { x: 0, y: 0, z: 0, yaw: 0, activity: 0 }

describe('horde member packing (0115)', () => {
  it('round-trips within half a step on x and z, 0.125 m on y, and 1/64 turn on heading', () => {
    const rng = new Rng(7)
    let worstXZ = 0
    let worstY = 0
    let worstYaw = 0
    for (let i = 0; i < 20_000; i++) {
      const cx = rng.int(-20, 20)
      const cz = rng.int(-20, 20)
      const baseY = rng.range(-50, 50)
      const x = cx * 64 + rng.range(0, 64 - 1e-6)
      const z = cz * 64 + rng.range(0, 64 - 1e-6)
      const y = baseY + rng.range(-31.75, 31.75)
      const yaw = rng.range(-Math.PI, Math.PI)
      const activity = rng.int(0, 7)
      const word = packMember(64, cx, cz, baseY, x, y, z, yaw, activity)
      expect(word).toBeGreaterThanOrEqual(0)
      expect(word).toBeLessThan(2 ** 32)
      unpackMember(word, 64, cx, cz, baseY, out)
      worstXZ = Math.max(worstXZ, Math.abs(out.x - x), Math.abs(out.z - z))
      worstY = Math.max(worstY, Math.abs(out.y - y))
      let d = Math.abs(out.yaw - yaw) % (2 * Math.PI)
      if (d > Math.PI) d = 2 * Math.PI - d
      worstYaw = Math.max(worstYaw, d)
      expect(out.activity).toBe(activity)
    }
    expect(worstXZ).toBeLessThanOrEqual(0.125 + 1e-9)
    expect(worstY).toBeLessThanOrEqual(0.125 + 1e-9)
    expect(worstYaw).toBeLessThanOrEqual(Math.PI / 32 + 1e-9)
  })

  it('clamps members outside the cell or the y range to its edge', () => {
    // 1 m past the cell's far corner (re-homing leaves 1 m of slack), 40 m above.
    const word = packMember(64, 2, -3, 10, 2 * 64 + 65, 80, -3 * 64 - 1, 0, 1)
    unpackMember(word, 64, 2, -3, 10, out)
    expect(out.x).toBeCloseTo(2 * 64 + 63.875)
    expect(out.z).toBeCloseTo(-3 * 64 + 0.125)
    expect(out.y).toBeCloseTo(10 + 127 * 0.25)
    expect(yFits(10, 80)).toBe(false)
    expect(yFits(10, 41.5)).toBe(true)
    // Bigger cells keep 256 steps: half a step is the bound.
    const w2 = packMember(128, 0, 0, 0, 100.3, 0, 7.9, 0, 0)
    unpackMember(w2, 128, 0, 0, 0, out)
    expect(Math.abs(out.x - 100.3)).toBeLessThanOrEqual(0.25)
  })

  it('encodes members at 4 bytes each, and ids and looks once, through the packed codecs', () => {
    const n = 2000
    const members = Array.from({ length: n }, (_, i) => (i * 2654435761) >>> 0)
    const ids = Array.from({ length: n }, (_, i) => 1000 + i)
    const looks = Array.from({ length: n }, (_, i) => i % 5)
    const mc = hordeMembersCodec(HordeMembers)
    const w = new ByteWriter()
    mc.encode({ rev: 9, members }, w)
    expect(w.length).toBeLessThanOrEqual(4 * n + 5)
    const back = mc.decode(new ByteReader(w.finish())) as { rev: number; members: number[] }
    expect(back.rev).toBe(9)
    expect(back.members).toEqual(members)
    const cc = hordeCellCodec(HordeCell)
    const w2 = new ByteWriter()
    cc.encode({ grid: 0, x: -3, z: 7, y: 1.5, rev: 9, ids, looks }, w2)
    // Ascending ids as deltas (1 byte), looks as nibbles: 1.5 bytes a member, sent on change.
    expect(w2.length).toBeLessThanOrEqual(1.5 * n + 20)
    const cell = cc.decode(new ByteReader(w2.finish())) as Record<string, unknown>
    expect(cell).toEqual({ grid: 0, x: -3, z: 7, y: 1.5, rev: 9, ids, looks })
    // Anything else still round-trips, as plain varuints.
    const odd = { grid: 1, x: 5, z: -5, y: 0, rev: 1, ids: [9, 3, 70000], looks: [300, 0, 17] }
    const w3 = new ByteWriter()
    cc.encode(odd, w3)
    expect(cc.decode(new ByteReader(w3.finish()))).toEqual(odd)
  })
})

describe('hordeInterest decisions (0115)', () => {
  // replicate.range 160, last level 512: inner 128, near 240.
  const at = (x: number, z: number) => Float64Array.of(x, z)
  const every = (focus: Float64Array, cx: number, cz: number) =>
    hordeEvery(focus, focus.length / 2, 64, cx, cz, 512, 128, 240)

  it('skips cells entirely within 0.8 × replicate.range: their members replicate themselves', () => {
    expect(every(at(32, 32), 0, 0)).toBe(0)
    expect(every(at(32, 32), 1, 0)).toBe(0)
    // Reaching past 128 m: relevant, at 1 s (within 240 m).
    expect(every(at(32, 32), 2, 0)).toBe(1)
  })

  it('sends every 1 s within 1.5 × replicate.range and every 2 s out to the last level', () => {
    expect(every(at(32, 32), 3, 0)).toBe(1) // nearest 160 m
    expect(every(at(32, 32), 4, 0)).toBe(1) // nearest 224 m
    expect(every(at(32, 32), 5, 0)).toBe(2) // nearest 288 m
    expect(every(at(32, 32), 8, 0)).toBe(2) // nearest 480 m
    expect(every(at(32, 32), 9, 0)).toBe(0) // nearest 544 m, past the last level
    expect(every(at(32, 32), 0, -9)).toBe(0)
  })

  it('uses the nearest focus for range, and any focus close enough skips the cell', () => {
    const two = Float64Array.of(32, 32, 632, 32)
    // 544 m from the first focus, but the second stands in it: its members replicate.
    expect(every(two, 9, 0)).toBe(0)
    // 136 m from the second (reaching past 128): sent at 1 s although 736 m from the first.
    expect(every(two, 12, 0)).toBe(1)
  })
})
