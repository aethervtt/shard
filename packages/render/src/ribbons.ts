import { defineResource, defineSystem, type Entity, type World } from '@aethervtt/shard-core'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Beam, Trail } from './vfx'
import {
  createRecord,
  matrixChanged,
  number,
  point,
  recordDescription,
  refreshRecord,
  VFX_STRIDE,
  type VfxRecord,
} from './vfx-state'

export interface RibbonRecord extends VfxRecord {
  points: Float64Array
  capacity: number
  head: number
  pointsCount: number
  distance: number
  targetMatrix: Float64Array
  scratch: Float64Array
}
export const Ribbons = defineResource('render/Ribbons', {
  init: () => ({
    records: [] as RibbonRecord[],
    trails: new Map<Entity, RibbonRecord>(),
    beams: new Map<Entity, RibbonRecord>(),
    frame: 0,
    rejected: 0,
  }),
})
function create(world: World, entity: Entity, beam: boolean): RibbonRecord {
  const capacity = beam ? 256 : world.get(entity, Trail).capacity
  return {
    ...createRecord(
      world,
      entity,
      beam ? Beam : Trail,
      beam ? 'beam' : 'trail',
      (capacity - 1) * 6,
    ),
    points: new Float64Array(capacity * 5),
    capacity,
    head: 0,
    pointsCount: 0,
    distance: 0,
    targetMatrix: new Float64Array(12),
    scratch: new Float64Array(6),
  }
}
/** Stable 32-bit spatial noise; independent of admission order and wall clock. */
function noise(seed: number, index: number): number {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
  return (((x ^ (x >>> 15)) >>> 0) / 0xffffffff) * 2 - 1
}
function trail(r: RibbonRecord, playing: boolean, paused: boolean): void {
  const life = number(r, 'lifetime'),
    p = r.points
  while (r.pointsCount && r.age - p[r.head * 5 + 3]! >= life) {
    r.head = (r.head + 1) % r.capacity
    r.pointsCount--
  }
  if (!playing || paused) return
  const offset = r.columns.offset as Float32Array,
    o = r.row * 3
  point(r.scratch, 0, r.matrix, offset[o]!, offset[o + 1]!, offset[o + 2]!)
  let distance = 0
  if (r.pointsCount) {
    const last = ((r.head + r.pointsCount - 1) % r.capacity) * 5
    const dx = r.scratch[0]! - p[last]!,
      dy = r.scratch[1]! - p[last + 1]!,
      dz = r.scratch[2]! - p[last + 2]!
    distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (distance < number(r, 'minDistance')) return
    if (distance > number(r, 'breakDistance')) {
      r.head = 0
      r.pointsCount = 0
      r.distance = 0
      distance = 0
    }
  }
  if (r.pointsCount === r.capacity) {
    r.head = (r.head + 1) % r.capacity
    r.pointsCount--
  }
  const at = ((r.head + r.pointsCount++) % r.capacity) * 5
  p[at] = r.scratch[0]!
  p[at + 1] = r.scratch[1]!
  p[at + 2] = r.scratch[2]!
  p[at + 3] = r.age
  p[at + 4] = r.distance += distance
}
function beam(world: World, r: RibbonRecord): void {
  const authored = r.columns.points![r.row] as number[][]
  if (authored.length > 256 || authored.length === 1) {
    r.error = 'render/beam-points'
    r.pointsCount = 0
    return
  }
  const p = r.points
  r.head = 0
  if (authored.length) {
    r.pointsCount = authored.length
    for (let i = 0; i < authored.length; i++) {
      const v = authored[i]!
      point(p, i * 5, r.matrix, v[0]!, v[1]!, v[2]!)
    }
  } else {
    const target = number(r, 'target'),
      start = r.columns.start as Float32Array,
      end = r.columns.end as Float32Array,
      o = r.row * 3
    if (target >= 0 && (!world.isAlive(target) || !world.has(target, GlobalTransform))) {
      r.error = 'render/beam-target'
      r.pointsCount = 0
      return
    }
    const m = target >= 0 ? r.targetMatrix : r.matrix
    if (target >= 0) matrixChanged(world, target, m)
    point(r.scratch, 0, r.matrix, start[o]!, start[o + 1]!, start[o + 2]!)
    point(r.scratch, 3, m, end[o]!, end[o + 1]!, end[o + 2]!)
    const segments = number(r, 'segments'),
      strength = number(r, 'noise'),
      seed = number(r, 'seed')
    r.pointsCount = segments + 1
    for (let i = 0; i <= segments; i++) {
      const f = i / segments,
        amplitude = i === 0 || i === segments ? 0 : strength
      for (let k = 0; k < 3; k++)
        p[i * 5 + k] =
          r.scratch[k]! +
          (r.scratch[k + 3]! - r.scratch[k]!) * f +
          noise(seed, i * 3 + k) * amplitude
    }
  }
  let distance = 0
  for (let i = 0; i < r.pointsCount; i++) {
    if (i) {
      const dx = p[i * 5]! - p[(i - 1) * 5]!,
        dy = p[i * 5 + 1]! - p[(i - 1) * 5 + 1]!,
        dz = p[i * 5 + 2]! - p[(i - 1) * 5 + 2]!
      distance += Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    p[i * 5 + 4] = distance
  }
  r.distance = distance
}
/** Geometry is camera-independent; the vertex shader extrudes shared point tangents per view. */
export function ribbonGeometry(r: RibbonRecord): void {
  r.count = 0
  const curve = r.columns.widthCurve![r.row] as { at: number; value: number }[]
  if (curve.length > 16) {
    r.error = 'render/ribbon-curve'
    return
  }
  for (let i = 0; i < curve.length; i++)
    if (
      !Number.isFinite(curve[i]!.at) ||
      !Number.isFinite(curve[i]!.value) ||
      curve[i]!.at < 0 ||
      curve[i]!.at > 1 ||
      curve[i]!.value < 0 ||
      curve[i]!.value > 16 ||
      (i > 0 && curve[i]!.at <= curve[i - 1]!.at)
    ) {
      r.error = 'render/ribbon-curve'
      return
    }
  const p = r.points,
    out = r.vertices,
    c = r.columns.color as Float32Array,
    e = r.columns.endColor as Float32Array
  const width = number(r, 'width'),
    repeat = number(r, 'repeat'),
    scroll = number(r, 'scroll') * r.age
  const life = r.kind === 'trail' ? number(r, 'lifetime') : 1
  for (let segment = 0; segment < r.pointsCount - 1; segment++) {
    const a = ((r.head + segment) % r.capacity) * 5,
      b = ((r.head + segment + 1) % r.capacity) * 5
    const dx = p[b]! - p[a]!,
      dy = p[b + 1]! - p[a + 1]!,
      dz = p[b + 2]! - p[a + 2]!
    if (dx * dx + dy * dy + dz * dz < 1e-16) continue
    for (let v = 0; v < 6; v++) {
      const next = v === 1 || v === 2 || v === 4,
        side = v === 2 || v === 4 || v === 5 ? 1 : -1
      const index = segment + (next ? 1 : 0),
        at = next ? b : a
      const prev = ((r.head + Math.max(0, index - 1)) % r.capacity) * 5,
        after = ((r.head + Math.min(r.pointsCount - 1, index + 1)) % r.capacity) * 5
      const f = Math.min(
        1,
        Math.max(
          0,
          r.kind === 'trail'
            ? (r.age - p[at + 3]!) / life
            : p[at + 4]! / Math.max(r.distance, 1e-9),
        ),
      )
      let scale = 1
      if (curve.length) {
        scale = curve[0]!.value
        for (let k = 1; k < curve.length; k++) {
          const x = curve[k - 1]!,
            y = curve[k]!
          if (f >= y.at) scale = y.value
          else if (f > x.at) {
            scale = x.value + ((y.value - x.value) * (f - x.at)) / (y.at - x.at)
            break
          } else break
        }
      }
      const o = r.count++ * VFX_STRIDE
      out[o] = p[at]!
      out[o + 1] = p[at + 1]!
      out[o + 2] = p[at + 2]!
      out[o + 3] = p[after]! - p[prev]!
      out[o + 4] = p[after + 1]! - p[prev + 1]!
      out[o + 5] = p[after + 2]! - p[prev + 2]!
      out[o + 6] = p[at + 4]! / repeat + scroll
      out[o + 7] = (side + 1) * 0.5
      for (let k = 0; k < 4; k++)
        out[o + 8 + k] = c[r.row * 4 + k]! + (e[r.row * 4 + k]! - c[r.row * 4 + k]!) * f
      out[o + 12] = width * scale * 0.5
      out[o + 13] = side
    }
  }
  r.version++
}
export const updateRibbons = defineSystem({
  name: 'render/ribbons-update',
  setup: (world) => ({
    trails: world.query({ with: [Trail, GlobalTransform] }),
    beams: world.query({ with: [Beam, GlobalTransform] }),
  }),
  run({ trails, beams }, world) {
    const state = world.resource(Ribbons),
      delta = world.resource(Time).delta
    state.frame++
    state.rejected = 0
    let demand = false
    for (let kind = 0; kind < 2; kind++) {
      const q = kind ? beams : trails
      for (let t = 0; t < q.tables.length; t++) {
        const table = q.tables[t]!
        for (let row = 0; row < table.count; row++) {
          const entity = table.entities[row]! as Entity
          const limit = (
            kind ? table.column(Beam, 'segments')[row] : table.column(Trail, 'capacity')[row]
          ) as number
          if (limit < (kind ? 1 : 2) || limit > (kind ? 255 : 256)) {
            state.rejected++
            continue
          }
          const lookup = kind ? state.beams : state.trails
          let r = lookup.get(entity)
          if (!r) {
            if (state.records.length >= 256) {
              state.rejected++
              continue
            }
            r = create(world, entity, kind === 1)
            state.records.push(r)
            lookup.set(entity, r)
          }
          refreshRecord(world, r)
          matrixChanged(world, entity, r.matrix)
          r.seen = state.frame
          r.error = null
          const playing = !!number(r, 'playing'),
            paused = !!number(r, 'paused')
          if (r.kind === 'trail' && r.capacity !== number(r, 'capacity')) {
            r.capacity = number(r, 'capacity')
            r.points = new Float64Array(r.capacity * 5)
            r.vertices = new Float32Array((r.capacity - 1) * 6 * VFX_STRIDE)
            r.head = 0
            r.pointsCount = 0
          }
          if (playing && !r.wasPlaying && r.kind === 'beam') r.age = 0
          r.wasPlaying = playing
          if (!paused) r.age += delta
          if (kind) {
            if (playing && (!paused || r.pointsCount === 0)) beam(world, r)
            else if (!playing) r.pointsCount = 0
          } else trail(r, playing, paused)
          ribbonGeometry(r)
          if (!paused && (playing || r.pointsCount > 0)) demand = true
        }
      }
    }
    for (let i = state.records.length - 1; i >= 0; i--)
      if (state.records[i]!.seen !== state.frame) {
        const r = state.records[i]!
        ;(r.kind === 'beam' ? state.beams : state.trails).delete(r.entity)
        state.records.splice(i, 1)
      }
    world.tryResource(FrameDemand)?.set('render/ribbons', demand)
  },
})
export function shiftRibbons(world: World, x: number, y: number, z: number): void {
  const records = world.resource(Ribbons).records
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    if (r.kind !== 'trail') continue
    for (let j = 0; j < r.pointsCount; j++) {
      const at = ((r.head + j) % r.capacity) * 5
      r.points[at] = r.points[at]! + x
      r.points[at + 1] = r.points[at + 1]! + y
      r.points[at + 2] = r.points[at + 2]! + z
    }
  }
}
export function describeRibbons(world: World) {
  const s = world.resource(Ribbons)
  return {
    rejected: s.rejected,
    error: s.rejected ? 'render/ribbon-limit' : null,
    records: s.records.map((r) => ({
      ...recordDescription(r),
      cpuBytes:
        r.vertices.byteLength +
        r.points.byteLength +
        r.matrix.byteLength +
        r.targetMatrix.byteLength +
        r.scratch.byteLength,
      points: r.pointsCount,
      capacity: r.capacity,
    })),
  }
}
