import type {
  AssetRef,
  ComponentDef,
  Entity,
  Table,
  TypedArray,
  World,
} from '@aethervtt/shard-core'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { ComputedVisibility } from './visibility'

export const VFX_STRIDE = 14
export interface VfxRecord {
  entity: Entity
  def: ComponentDef
  kind: 'trail' | 'beam' | 'decal'
  table: Table
  row: number
  columns: Record<string, TypedArray | unknown[]>
  matrix: Float64Array
  vertices: Float32Array
  count: number
  version: number
  age: number
  wasPlaying: boolean
  error: string | null
  seen: number
  opacity: number
  texture: AssetRef<'Texture'> | null
  layers: number
  additive: boolean
  textureState: string
  visible: boolean
}
export function createRecord(
  world: World,
  entity: Entity,
  def: ComponentDef,
  kind: VfxRecord['kind'],
  vertices: number,
): VfxRecord {
  const table = world.entityTable(entity)
  return {
    entity,
    def,
    kind,
    table,
    row: world.entityRow(entity),
    columns: table.storage(def)!.byName,
    matrix: new Float64Array(12),
    vertices: new Float32Array(vertices * VFX_STRIDE),
    count: 0,
    version: 0,
    age: 0,
    wasPlaying: false,
    error: null,
    seen: 0,
    opacity: 1,
    texture: null,
    layers: 1,
    additive: false,
    textureState: 'none',
    visible: true,
  }
}
export function refreshRecord(world: World, r: VfxRecord): void {
  r.table = world.entityTableUnchecked(r.entity)
  r.row = world.entityRowUnchecked(r.entity)
  r.columns = r.table.storage(r.def)!.byName
  r.texture = r.columns.texture![r.row] as AssetRef<'Texture'> | null
  r.opacity = number(r, 'opacity')
  r.layers = number(r, 'layers')
  r.additive = number(r, 'blend') === 1
  r.visible =
    !r.table.has(ComputedVisibility) || r.table.column(ComputedVisibility, 'visible')[r.row] !== 0
}
export function number(r: VfxRecord, field: string): number {
  return r.columns[field]![r.row] as number
}
export function matrixChanged(world: World, entity: Entity, out: Float64Array): boolean {
  const t = world.entityTableUnchecked(entity),
    row = world.entityRowUnchecked(entity)
  const m = t.column(GlobalTransform, 'matrix') as Float32Array
  let changed = false
  for (let i = 0; i < 12; i++) {
    const v = m[row * 12 + i]!
    if (out[i] !== v) changed = true
    out[i] = v
  }
  return changed
}
export function point(
  out: Float64Array,
  at: number,
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): void {
  out[at] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
  out[at + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
  out[at + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
}
export function recordDescription(r: VfxRecord) {
  return {
    entity: r.entity,
    kind: r.kind,
    vertices: r.count,
    age: r.age,
    opacity: r.opacity,
    error: r.error,
    visible: r.visible,
    cpuBytes: r.vertices.byteLength,
    texture: r.textureState,
    playing: !!number(r, 'playing'),
    paused: !!number(r, 'paused'),
  }
}
