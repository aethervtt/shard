import {
  affine,
  defineResource,
  defineSystem,
  type Entity,
  type World,
} from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Materials, Meshes } from './assets'
import { Mesh3d, MeshMaterial, MorphWeights, SkinnedMesh } from './instances'
import { RenderLayers } from './layers'
import { isTransparent } from './materials'
import { Decal, DecalReceiver } from './vfx'
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
import { ComputedVisibility } from './visibility'

export const DECAL_TRIANGLE_BUDGET = 32768
export interface DecalRange {
  start: number
  count: number
  entity: Entity
  layers: number
}
interface Receiver {
  entity: Entity
  matrix: Float64Array
  mesh: Mesh | undefined
  version: number
  mask: number
  visible: boolean
  unsupported: boolean
  layers: number
  seen: number
}
export interface DecalRecord extends VfxRecord {
  inverse: Float64Array
  settings: Float64Array
  geometryCount: number
  receiverRevision: number
  rebuilds: number
  ranges: DecalRange[]
  clipA: Float64Array
  clipB: Float64Array
  worldTriangle: Float64Array
}
export const Decals = defineResource('render/Decals', {
  init: () => ({
    records: [] as DecalRecord[],
    receivers: [] as Receiver[],
    receiverByEntity: new Map<Entity, Receiver>(),
    frame: 0,
    revision: 0,
    rejected: 0,
  }),
})
function create(world: World, entity: Entity): DecalRecord {
  const max = world.get(entity, Decal).maxVertices
  return {
    ...createRecord(world, entity, Decal, 'decal', max),
    inverse: new Float64Array(12),
    settings: new Float64Array(8).fill(NaN),
    geometryCount: 0,
    receiverRevision: -1,
    rebuilds: 0,
    ranges: [],
    clipA: new Float64Array(48),
    clipB: new Float64Array(48),
    worldTriangle: new Float64Array(9),
  }
}
/** Clips a convex polygon against one axis-aligned half-space. Scratch fits a clipped triangle. */
export function clipPlane(
  input: Float64Array,
  count: number,
  output: Float64Array,
  axis: number,
  sign: number,
  half: number,
): number {
  let n = 0
  for (let i = 0; i < count; i++) {
    const a = ((i + count - 1) % count) * 3,
      b = i * 3
    const da = half - sign * input[a + axis]!,
      db = half - sign * input[b + axis]!
    if (da >= 0 !== db >= 0) {
      const f = da / (da - db)
      for (let k = 0; k < 3; k++)
        output[n * 3 + k] = input[a + k]! + (input[b + k]! - input[a + k]!) * f
      n++
    }
    if (db >= 0) {
      for (let k = 0; k < 3; k++) output[n * 3 + k] = input[b + k]!
      n++
    }
  }
  return n
}
function intersects(
  r: DecalRecord,
  receiver: Receiver,
  sx: number,
  sy: number,
  sz: number,
): boolean {
  const bounds = receiver.mesh!.bounds,
    scratch = r.worldTriangle
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity
  for (let i = 0; i < 8; i++) {
    point(
      scratch,
      0,
      receiver.matrix,
      bounds[i & 1 ? 3 : 0]!,
      bounds[i & 2 ? 4 : 1]!,
      bounds[i & 4 ? 5 : 2]!,
    )
    point(scratch, 3, r.inverse, scratch[0]!, scratch[1]!, scratch[2]!)
    minX = Math.min(minX, scratch[3]!)
    minY = Math.min(minY, scratch[4]!)
    minZ = Math.min(minZ, scratch[5]!)
    maxX = Math.max(maxX, scratch[3]!)
    maxY = Math.max(maxY, scratch[4]!)
    maxZ = Math.max(maxZ, scratch[5]!)
  }
  return (
    minX <= sx / 2 &&
    maxX >= -sx / 2 &&
    minY <= sy / 2 &&
    maxY >= -sy / 2 &&
    minZ <= sz / 2 &&
    maxZ >= -sz / 2
  )
}
/** Cold projection work. Output is all-or-nothing on budget/unsupported errors. */
export function projectDecal(r: DecalRecord, receivers: readonly Receiver[]): void {
  r.count = 0
  r.geometryCount = 0
  r.ranges.length = 0
  r.error = null
  r.rebuilds++
  if (!affine.invert(r.inverse, r.matrix)) {
    r.error = 'render/decal-singular'
    return
  }
  const size = r.columns.size as Float32Array,
    so = r.row * 3
  const sx = size[so]!,
    sy = size[so + 1]!,
    sz = size[so + 2]!
  if (!(sx > 0 && sy > 0 && sz > 0)) {
    r.error = 'render/decal-size'
    return
  }
  const mask = number(r, 'receiverMask'),
    offset = number(r, 'offset'),
    cos = Math.cos((number(r, 'maxAngle') * Math.PI) / 180)
  const zx = r.matrix[2]!,
    zy = r.matrix[6]!,
    zz = r.matrix[10]!,
    zl = Math.sqrt(zx * zx + zy * zy + zz * zz)
  let tested = 0
  for (let ri = 0; ri < receivers.length; ri++) {
    const receiver = receivers[ri]!,
      mesh = receiver.mesh
    if (
      !receiver.visible ||
      !(receiver.mask & mask) ||
      !mesh ||
      !intersects(r, receiver, sx, sy, sz)
    )
      continue
    if (receiver.unsupported) {
      r.error = 'render/decal-unsupported-receiver'
      break
    }
    const start = r.count,
      positions = mesh.positions,
      indices = mesh.indices
    const triangles = Math.floor((indices ? indices.length : positions.length / 3) / 3)
    if (tested + triangles > DECAL_TRIANGLE_BUDGET) {
      r.error = 'render/decal-input-budget'
      break
    }
    tested += triangles
    for (let t = 0; t < triangles; t++) {
      for (let v = 0; v < 3; v++) {
        const vi = (indices ? indices[t * 3 + v]! : t * 3 + v) * 3
        point(
          r.worldTriangle,
          v * 3,
          receiver.matrix,
          positions[vi]!,
          positions[vi + 1]!,
          positions[vi + 2]!,
        )
      }
      const w = r.worldTriangle
      const ax = w[3]! - w[0]!,
        ay = w[4]! - w[1]!,
        az = w[5]! - w[2]!,
        bx = w[6]! - w[0]!,
        by = w[7]! - w[1]!,
        bz = w[8]! - w[2]!
      let nx = ay * bz - az * by,
        ny = az * bx - ax * bz,
        nz = ax * by - ay * bx
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (length < 1e-12) continue
      nx /= length
      ny /= length
      nz /= length
      if ((nx * zx + ny * zy + nz * zz) / zl < cos) continue
      for (let v = 0; v < 3; v++)
        point(r.clipA, v * 3, r.inverse, w[v * 3]!, w[v * 3 + 1]!, w[v * 3 + 2]!)
      let a = r.clipA,
        b = r.clipB,
        count = 3
      for (let plane = 0; plane < 6 && count; plane++) {
        const axis = plane >> 1,
          half = (axis === 0 ? sx : axis === 1 ? sy : sz) * 0.5
        count = clipPlane(a, count, b, axis, plane % 2 ? -1 : 1, half)
        const swap = a
        a = b
        b = swap
      }
      if (count < 3) continue
      if (r.count + (count - 2) * 3 > r.vertices.length / VFX_STRIDE) {
        r.error = 'render/decal-output-budget'
        break
      }
      for (let fan = 1; fan < count - 1; fan++)
        for (let v = 0; v < 3; v++) {
          const at = (v === 0 ? 0 : v === 1 ? fan : fan + 1) * 3,
            o = r.count++ * VFX_STRIDE
          point(w, 0, r.matrix, a[at]!, a[at + 1]!, a[at + 2]!)
          r.vertices[o] = w[0]! + nx * offset
          r.vertices[o + 1] = w[1]! + ny * offset
          r.vertices[o + 2] = w[2]! + nz * offset
          r.vertices[o + 3] = 0
          r.vertices[o + 4] = 0
          r.vertices[o + 5] = 0
          r.vertices[o + 6] = a[at]! / sx + 0.5
          r.vertices[o + 7] = 0.5 - a[at + 1]! / sy
          for (let k = 8; k < 12; k++) r.vertices[o + k] = 1
          r.vertices[o + 12] = 0
          r.vertices[o + 13] = 0
        }
    }
    if (r.error) break
    if (r.count > start)
      r.ranges.push({
        start,
        count: r.count - start,
        entity: receiver.entity,
        layers: receiver.layers,
      })
  }
  if (r.error) {
    r.count = 0
    r.ranges.length = 0
  }
  r.geometryCount = r.count
  r.version++
}
export const updateDecals = defineSystem({
  name: 'render/decals-update',
  setup: (world) => ({
    q: world.query({ with: [Decal, GlobalTransform] }),
    receivers: world.query({ with: [DecalReceiver, Mesh3d, GlobalTransform] }),
  }),
  run({ q, receivers }, world) {
    const state = world.resource(Decals),
      meshes = world.resource(Meshes),
      delta = world.resource(Time).delta
    state.frame++
    state.rejected = 0
    for (let ti = 0; ti < receivers.tables.length; ti++) {
      const table = receivers.tables[ti]!,
        mask = table.column(DecalReceiver, 'mask'),
        refs = table.column(Mesh3d, 'mesh')
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]! as Entity
        let receiver = state.receiverByEntity.get(entity)
        if (!receiver) {
          receiver = {
            entity,
            matrix: new Float64Array(12),
            mesh: undefined,
            version: -1,
            mask: -1,
            visible: false,
            unsupported: false,
            layers: 1,
            seen: 0,
          }
          state.receivers.push(receiver)
          state.receiverByEntity.set(entity, receiver)
          state.revision++
        }
        const mesh = meshes.get(refs[row] as never),
          version = mesh?.version ?? -1
        const visible =
          !table.has(ComputedVisibility) || table.column(ComputedVisibility, 'visible')[row] !== 0
        const layers = table.has(RenderLayers)
          ? (table.column(RenderLayers, 'mask')[row] as number)
          : 1
        let unsupported =
          !!mesh &&
          (!mesh.positions ||
            !!mesh.joints ||
            !!mesh.targets?.length ||
            table.has(SkinnedMesh) ||
            table.has(MorphWeights))
        if (table.has(MeshMaterial)) {
          const material = world
            .tryResource(Materials)
            ?.get(table.column(MeshMaterial, 'material')[row] as never)
          if (material && isTransparent(material.type.blendOf(material.value))) unsupported = true
        }
        if (
          matrixChanged(world, entity, receiver.matrix) ||
          receiver.mesh !== mesh ||
          receiver.version !== version ||
          receiver.mask !== mask[row] ||
          receiver.visible !== visible ||
          receiver.layers !== layers ||
          receiver.unsupported !== unsupported
        )
          state.revision++
        receiver.mesh = mesh
        receiver.version = version
        receiver.mask = mask[row] as number
        receiver.visible = visible
        receiver.layers = layers
        receiver.unsupported = unsupported
        receiver.seen = state.frame
      }
    }
    for (let i = state.receivers.length - 1; i >= 0; i--)
      if (state.receivers[i]!.seen !== state.frame) {
        state.receiverByEntity.delete(state.receivers[i]!.entity)
        state.receivers.splice(i, 1)
        state.revision++
      }
    let demand = false
    for (let ti = 0; ti < q.tables.length; ti++) {
      const table = q.tables[ti]!
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]! as Entity
        const maxVertices = table.column(Decal, 'maxVertices')[row] as number
        if (maxVertices < 3 || maxVertices > 65535) {
          state.rejected++
          continue
        }
        let r: DecalRecord | undefined
        for (let i = 0; i < state.records.length; i++)
          if (state.records[i]!.entity === entity) {
            r = state.records[i]
            break
          }
        if (!r) {
          if (state.records.length >= 64) {
            state.rejected++
            continue
          }
          r = create(world, entity)
          state.records.push(r)
        }
        refreshRecord(world, r)
        r.seen = state.frame
        let changed = matrixChanged(world, entity, r.matrix)
        const size = r.columns.size as Float32Array
        for (let i = 0; i < 8; i++) {
          const value =
            i < 3
              ? size[row * 3 + i]!
              : i === 3
                ? number(r, 'receiverMask')
                : i === 4
                  ? number(r, 'maxAngle')
                  : i === 5
                    ? number(r, 'offset')
                    : i === 6
                      ? number(r, 'maxVertices')
                      : 0
          if (r.settings[i] !== value) changed = true
          r.settings[i] = value
        }
        const capacity = number(r, 'maxVertices') * VFX_STRIDE
        if (r.vertices.length !== capacity) {
          r.vertices = new Float32Array(capacity)
          changed = true
        }
        const playing = !!number(r, 'playing'),
          paused = !!number(r, 'paused'),
          lifetime = number(r, 'lifetime')
        if (playing && !r.wasPlaying) r.age = 0
        r.wasPlaying = playing
        if (playing && !paused) r.age += delta
        if (changed || r.receiverRevision !== state.revision) {
          projectDecal(r, state.receivers)
          r.receiverRevision = state.revision
        }
        r.count = playing && (!lifetime || r.age < lifetime) ? r.geometryCount : 0
        if (lifetime && number(r, 'fadeOut') > 0)
          r.opacity *= Math.min(1, Math.max(0, (lifetime - r.age) / number(r, 'fadeOut')))
        if (playing && !paused && lifetime > 0 && r.age < lifetime) demand = true
      }
    }
    for (let i = state.records.length - 1; i >= 0; i--)
      if (state.records[i]!.seen !== state.frame) state.records.splice(i, 1)
    world.tryResource(FrameDemand)?.set('render/decals', demand)
  },
})
export function describeDecals(world: World) {
  const s = world.resource(Decals)
  return {
    rejected: s.rejected,
    error: s.rejected ? 'render/decal-limit' : null,
    receivers: s.receivers.length,
    records: s.records.map((r) => ({
      ...recordDescription(r),
      cpuBytes:
        r.vertices.byteLength +
        r.matrix.byteLength +
        r.inverse.byteLength +
        r.settings.byteLength +
        r.clipA.byteLength +
        r.clipB.byteLength +
        r.worldTriangle.byteLength,
      rebuilds: r.rebuilds,
      triangles: r.geometryCount / 3,
    })),
  }
}
