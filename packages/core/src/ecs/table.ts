import type { ComponentDef } from '../schema/component'
import type {
  Column,
  Fields,
  FieldType,
  InferFields,
  Storage,
  TypedArray,
  TypedArrayFor,
} from '../schema/field'
import type { Entity } from './entity'

/** Anything that knows the current change-detection tick (the world). */
export interface TickSource {
  readonly tick: number
}

/** The column type for a field: a TypedArray for numeric storage, a JS array otherwise. */
export type ColumnOf<T> =
  T extends FieldType<infer V, infer S>
    ? S extends 'object'
      ? (V | undefined)[]
      : TypedArrayFor<Exclude<S, 'object'>>
    : never

const TYPED: Record<Exclude<Storage, 'object'>, new (length: number) => TypedArray> = {
  f32: Float32Array,
  f64: Float64Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
}

function createColumn(storage: Storage, length: number): Column {
  return storage === 'object' ? new Array(length) : new TYPED[storage](length)
}

function growColumn(column: Column, storage: Storage, length: number): Column {
  if (storage === 'object') return column
  const next = new TYPED[storage](length)
  next.set(column as TypedArray)
  return next
}

function growTicks(ticks: Uint32Array, length: number): Uint32Array {
  const next = new Uint32Array(length)
  next.set(ticks)
  return next
}

/** Storage for one component inside one table. */
export class ComponentStorage {
  readonly columns: Column[]
  /** Columns by field name. Same arrays as `columns`. */
  readonly byName: Record<string, Column> = Object.create(null)
  added: Uint32Array
  changed: Uint32Array
  readonly def: ComponentDef

  constructor(def: ComponentDef, capacity: number) {
    this.def = def
    this.columns = def.layout.map((c) => createColumn(c.storage, capacity * c.stride))
    this.reindex()
    this.added = new Uint32Array(capacity)
    this.changed = new Uint32Array(capacity)
  }

  grow(capacity: number): void {
    const layout = this.def.layout
    for (let i = 0; i < layout.length; i++) {
      const c = layout[i]!
      this.columns[i] = growColumn(this.columns[i]!, c.storage, capacity * c.stride)
    }
    this.reindex()
    this.added = growTicks(this.added, capacity)
    this.changed = growTicks(this.changed, capacity)
  }

  private reindex(): void {
    const layout = this.def.layout
    for (let i = 0; i < layout.length; i++) this.byName[layout[i]!.name] = this.columns[i]!
  }
}

/**
 * All entities that have exactly one set of components (an archetype), stored as columns.
 *
 * Column arrays are replaced when the table grows, so fetch them each frame rather than
 * holding on to them.
 */
export class Table {
  count = 0
  capacity: number
  entities: Float64Array
  /** Component ids in this archetype, sorted. */
  readonly ids: readonly number[]
  readonly storages: readonly ComponentStorage[]
  /** Cached archetype transitions: component id → table with it added / removed. */
  readonly addEdges = new Map<number, Table>()
  readonly removeEdges = new Map<number, Table>()
  private readonly idSet: ReadonlySet<number>
  private readonly byId = new Map<number, ComponentStorage>()
  readonly id: number
  readonly components: readonly ComponentDef[]
  private readonly clock: TickSource

  constructor(id: number, components: readonly ComponentDef[], clock: TickSource, capacity = 16) {
    this.id = id
    this.components = components
    this.clock = clock
    this.capacity = capacity
    this.entities = new Float64Array(capacity)
    this.ids = components.map((c) => c.id)
    this.idSet = new Set(this.ids)
    this.storages = components.map((def) => {
      const storage = new ComponentStorage(def, capacity)
      this.byId.set(def.id, storage)
      return storage
    })
  }

  has(def: ComponentDef): boolean {
    return this.idSet.has(def.id)
  }

  hasId(id: number): boolean {
    return this.idSet.has(id)
  }

  storage(def: ComponentDef): ComponentStorage | undefined {
    return this.byId.get(def.id)
  }

  /**
   * The raw column for one field. Numeric fields are TypedArrays with `stride` values per row
   * (a vec3 at row `i` is at `[i * 3]`, `[i * 3 + 1]`, `[i * 3 + 2]`).
   */
  column<F extends Fields, K extends keyof F & string>(
    def: ComponentDef<F>,
    field: K,
  ): ColumnOf<F[K]> {
    return this.byId.get(def.id)!.byName[field] as ColumnOf<F[K]>
  }

  addedTicks(def: ComponentDef): Uint32Array {
    return this.byId.get(def.id)!.added
  }

  changedTicks(def: ComponentDef): Uint32Array {
    return this.byId.get(def.id)!.changed
  }

  /** Marks one row, or every row, as changed at the current tick. */
  markChanged(def: ComponentDef, row?: number): void {
    const changed = this.byId.get(def.id)!.changed
    if (row === undefined) changed.fill(this.clock.tick, 0, this.count)
    else changed[row] = this.clock.tick
  }

  isAdded(def: ComponentDef, row: number, since: number): boolean {
    return this.byId.get(def.id)!.added[row]! > since
  }

  isChanged(def: ComponentDef, row: number, since: number): boolean {
    return this.byId.get(def.id)!.changed[row]! > since
  }

  // --- structural operations (used by the world) ----------------------------

  pushRow(entity: Entity): number {
    if (this.count === this.capacity) this.grow(this.capacity * 2)
    const row = this.count++
    this.entities[row] = entity
    return row
  }

  /** Swap-removes a row. Returns the entity moved into `row`, or -1 if it was the last row. */
  removeRow(row: number): Entity {
    const last = --this.count
    const storages = this.storages
    if (row === last) {
      for (let s = 0; s < storages.length; s++) {
        const storage = storages[s]!
        const layout = storage.def.layout
        for (let c = 0; c < layout.length; c++) {
          if (layout[c]!.storage === 'object') (storage.columns[c] as unknown[])[last] = undefined
        }
      }
      return -1
    }
    const moved = this.entities[last]!
    this.entities[row] = moved
    for (let s = 0; s < storages.length; s++) {
      const storage = storages[s]!
      copyRow(storage, last, storage, row)
      const layout = storage.def.layout
      for (let c = 0; c < layout.length; c++) {
        if (layout[c]!.storage === 'object') (storage.columns[c] as unknown[])[last] = undefined
      }
    }
    return moved
  }

  /** Copies the components both tables share from `row` here into `targetRow` there. */
  copySharedTo(row: number, target: Table, targetRow: number): void {
    const storages = this.storages
    for (let s = 0; s < storages.length; s++) {
      const from = storages[s]!
      const to = target.byId.get(from.def.id)
      if (to) copyRow(from, row, to, targetRow)
    }
  }

  /** Writes a full component value; fields missing from `init` take their defaults. */
  initComponent(def: ComponentDef, row: number, init: Record<string, unknown> | undefined): void {
    const storage = this.byId.get(def.id)!
    const layout = def.layout
    for (let c = 0; c < layout.length; c++) {
      const { name, field } = layout[c]!
      const value = init?.[name]
      field.write(storage.columns[c]!, row, value === undefined ? field.defaultValue() : value)
    }
    const tick = this.clock.tick
    storage.added[row] = tick
    storage.changed[row] = tick
  }

  /** Writes only the fields present in `values`. */
  writeComponent(def: ComponentDef, row: number, values: Record<string, unknown>): void {
    const storage = this.byId.get(def.id)!
    const layout = def.layout
    for (let c = 0; c < layout.length; c++) {
      const { name, field } = layout[c]!
      const value = values[name]
      if (value !== undefined) field.write(storage.columns[c]!, row, value)
    }
    storage.changed[row] = this.clock.tick
  }

  readComponent<F extends Fields>(def: ComponentDef<F>, row: number): InferFields<F> {
    const storage = this.byId.get(def.id)!
    const out: Record<string, unknown> = {}
    const layout = def.layout
    for (let c = 0; c < layout.length; c++) {
      const { name, field } = layout[c]!
      out[name] = field.read(storage.columns[c]!, row)
    }
    return out as InferFields<F>
  }

  /** Approximate bytes used by TypedArray columns (object columns count as 8 bytes a slot). */
  bytes(): number {
    let total = this.entities.byteLength
    for (const storage of this.storages) {
      total += storage.added.byteLength + storage.changed.byteLength
      for (const column of storage.columns) {
        total += Array.isArray(column) ? this.capacity * 8 : column.byteLength
      }
    }
    return total
  }

  private grow(capacity: number): void {
    const entities = new Float64Array(capacity)
    entities.set(this.entities)
    this.entities = entities
    for (const storage of this.storages) storage.grow(capacity)
    this.capacity = capacity
  }
}

function copyRow(from: ComponentStorage, fromRow: number, to: ComponentStorage, toRow: number) {
  const layout = from.def.layout
  for (let c = 0; c < layout.length; c++) {
    const stride = layout[c]!.stride
    const src = from.columns[c]!
    const dst = to.columns[c]!
    if (stride === 1) {
      dst[toRow] = src[fromRow]
    } else {
      const a = fromRow * stride
      const b = toRow * stride
      for (let i = 0; i < stride; i++) dst[b + i] = src[a + i]!
    }
  }
  to.added[toRow] = from.added[fromRow]!
  to.changed[toRow] = from.changed[fromRow]!
}
