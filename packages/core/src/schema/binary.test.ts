import { describe, expect, it } from 'vitest'
import { World } from '../ecs/world'
import { ByteReader, ByteWriter, createRowCodec, defineComponent, defineSchema, t } from '.'

const Everything = defineComponent('test/BinaryEverything', {
  f32: t.f32(),
  f64: t.f64(),
  i8: t.i8(),
  i16: t.i16(),
  i32: t.i32(),
  u8: t.u8(),
  u16: t.u16(),
  u32: t.u32(),
  flag: t.bool(),
  v2: t.vec2(),
  v3: t.vec3(),
  v4: t.vec4(),
  cell: t.ivec3(),
  rotation: t.quat(),
  m3: t.mat3(),
  tint: t.color(),
  mode: t.enum(['a', 'b', 'c'] as const),
  target: t.entity(),
  label: t.string(),
  tags: t.list(t.string()),
  info: t.struct({ x: t.f32(), name: t.string() }),
  extra: t.json(),
})

const value = {
  f32: 1.5,
  f64: Math.PI,
  i8: -100,
  i16: -30_000,
  i32: -2_000_000_000,
  u8: 250,
  u16: 65_000,
  u32: 4_000_000_000,
  flag: true,
  v2: [1, -2] as [number, number],
  v3: [0.25, 0.5, -0.75] as [number, number, number],
  v4: [1, 2, 3, 4] as [number, number, number, number],
  cell: [-5, 0, 7] as [number, number, number],
  rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number],
  m3: [1, 2, 3, 4, 5, 6, 7, 8, 9] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
  tint: [0.5, 0.25, 1, 1] as [number, number, number, number],
  mode: 'c' as const,
  target: 12,
  label: 'héllo 🌍',
  tags: ['x', 'y'],
  info: { x: 2, name: 'n' },
  extra: { deep: [1, { two: 2 }] },
}

describe('ByteWriter / ByteReader', () => {
  it('round-trips integers, floats and strings, growing as needed', () => {
    const w = new ByteWriter(4)
    w.varuint(0)
    w.varuint(300)
    w.varuint(2 ** 40)
    w.varint(-1)
    w.varint(-123_456)
    w.f64(Math.E)
    w.string('')
    w.string('a€😀')
    const r = new ByteReader(w.finish())
    expect([r.varuint(), r.varuint(), r.varuint(), r.varint(), r.varint()]).toEqual([
      0,
      300,
      2 ** 40,
      -1,
      -123_456,
    ])
    expect(r.f64()).toBe(Math.E)
    expect(r.string()).toBe('')
    expect(r.string()).toBe('a€😀')
    expect(r.remaining).toBe(0)
  })

  it('reports truncated data', () => {
    const r = new ByteReader(new Uint8Array([1]))
    expect(() => r.u32()).toThrow(expect.objectContaining({ code: 'schema/binary-truncated' }))
  })
})

describe('createRowCodec', () => {
  it('round-trips every field kind between table rows', () => {
    const world = new World()
    const from = world.spawn([Everything, value])
    const to = world.spawn(Everything)
    const codec = createRowCodec(Everything)
    const w = new ByteWriter()
    codec.encodeRow(world.entityTable(from), world.entityRow(from), w)
    const r = new ByteReader(w.finish())
    expect(codec.decodeRow(r, world.entityTable(to), world.entityRow(to))).toBe(true)
    expect(r.remaining).toBe(0)

    const got = world.get(to, Everything)
    const { rotation, ...rest } = got
    const { rotation: expected, ...restExpected } = world.get(from, Everything)
    expect(rest).toEqual(restExpected)
    for (let i = 0; i < 4; i++) expect(rotation[i]).toBeCloseTo(expected[i]!, 4)
  })

  it('round-trips plain values', () => {
    const codec = createRowCodec(Everything)
    const w = new ByteWriter()
    codec.encode(value, w)
    const decoded = codec.decode(new ByteReader(w.finish()))!
    expect(decoded.label).toBe(value.label)
    expect(decoded.mode).toBe('c')
    expect(decoded.target).toBe(12)
    expect(decoded.info).toEqual(value.info)
    expect(decoded.f32).toBe(1.5)
  })

  it('keeps quantized floats within their step and quaternions within 0.001 rad', () => {
    const Pose = defineSchema('test/BinaryPose', { position: t.vec3(), rotation: t.quat() })
    const codec = createRowCodec(Pose, { quantize: { position: { step: 0.01 } } })
    const w = new ByteWriter()
    for (let i = 0; i < 200; i++) {
      const position: [number, number, number] = [i * 1.2345, -i * 0.777, i * 0.0049]
      const a = (i * 0.37) % (Math.PI * 2)
      const axis = [Math.sin(i), Math.cos(i * 1.3), Math.sin(i * 0.7)]
      const len = Math.sqrt(axis[0]! ** 2 + axis[1]! ** 2 + axis[2]! ** 2)
      const s = Math.sin(a / 2) / len
      const rotation: [number, number, number, number] = [
        axis[0]! * s,
        axis[1]! * s,
        axis[2]! * s,
        Math.cos(a / 2),
      ]
      w.reset()
      codec.encode({ position, rotation }, w)
      const got = codec.decode(new ByteReader(w.finish()))!
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(got.position[k]! - position[k]!)).toBeLessThanOrEqual(0.005 + 1e-4)
      }
      // q and -q are the same rotation: compare the angle between them.
      const dot = Math.abs(
        got.rotation[0] * rotation[0] +
          got.rotation[1] * rotation[1] +
          got.rotation[2] * rotation[2] +
          got.rotation[3] * rotation[3],
      )
      expect(2 * Math.acos(Math.min(1, dot))).toBeLessThan(0.001)
    }
  })

  it('maps entity fields and reports unknown ids', () => {
    const Ref = defineSchema('test/BinaryRef', { a: t.entity(), b: t.entity() })
    const out = createRowCodec(Ref, {
      entities: { toWire: (e) => e + 100, fromWire: () => null },
    })
    const w = new ByteWriter()
    out.encode({ a: 5, b: null }, w)
    const known = createRowCodec(Ref, {
      entities: { toWire: (e) => e, fromWire: (id) => (id === 0 ? null : id - 100) },
    })
    expect(known.decode(new ByteReader(w.finish()))).toEqual({ a: 5, b: null })
    const unknown = createRowCodec(Ref, {
      entities: { toWire: (e) => e, fromWire: (id) => (id === 0 ? null : undefined) },
    })
    expect(unknown.decode(new ByteReader(w.finish()))).toBeUndefined()
  })
})
