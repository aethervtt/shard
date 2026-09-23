import { ShardError } from '../error'
import type { ComponentDef } from '../schema/component'
import type { Fields, InferFields, InitFields } from '../schema/field'
import { Registry } from '../schema/registry'
import type { EventDef, ResourceDef } from '../schema/resource'
import { type Entity, formatEntity, MAX_ENTITIES, makeEntity } from './entity'
import { EventQueue, EventReader } from './events'
import { ChildOf, Children } from './hierarchy'
import {
  type LifecycleKind,
  type LifecycleObserver,
  type LifecycleTrigger,
  ObserverTable,
  onAdd,
  onRemove,
  onSet,
  type TriggerObserver,
} from './observers'
import { Query, type QueryDescriptor, queryKey } from './query'
import { Table, type TickSource } from './table'

/** A component to spawn/add with: the bare definition (defaults), or `[definition, values]`. */
export type ComponentInit<F extends Fields = Fields> =
  | ComponentDef<F>
  | readonly [ComponentDef<F>, InitFields<F>]

export interface WorldStats {
  entities: number
  archetypes: number
  tables: { components: string[]; count: number; capacity: number; bytes: number }[]
}

const FREE = 0xffffffff
const PENDING = 0xfffffffe
const MAX_GENERATION = 0x7fffffff

const byId = (a: ComponentDef, b: ComponentDef) => a.id - b.id

/**
 * Entities, their components (in archetype tables), resources, events, and observers.
 *
 * Direct methods (`spawn`, `add`, `remove`, `despawn`) apply immediately and fire observers
 * synchronously. Don't call them while iterating a query; record them on `Commands` instead.
 */
export class World implements TickSource {
  /** Change-detection clock. The scheduler advances it once per system run. */
  tick = 1
  readonly registry = new Registry()

  private generations = new Uint32Array(1024)
  private tableOf = new Uint32Array(1024).fill(FREE)
  private rowOf = new Uint32Array(1024)
  private nextIndex = 0
  private readonly freeIndices: number[] = []
  private aliveCount = 0

  private readonly tables: Table[] = []
  private readonly tableByKey = new Map<string, Table>()
  private readonly emptyTable: Table
  private readonly queries = new Map<string, Query>()
  private readonly resources = new Map<number, unknown>()
  private readonly eventQueues = new Map<number, EventQueue<unknown>>()
  private readonly observers = new ObserverTable()
  private readonly registered: boolean[] = []

  constructor() {
    this.emptyTable = this.getOrCreateTable([])
    this.installHierarchy()
  }

  incrementTick(): number {
    return ++this.tick
  }

  // --- entities --------------------------------------------------------------

  spawn<const T extends readonly Fields[]>(
    ...inits: { [K in keyof T]: ComponentInit<T[K]> }
  ): Entity {
    const entity = this.allocate()
    this.insert(entity, inits as readonly ComponentInit[])
    return entity
  }

  /** Allocates an id that comes alive later via `spawnReserved`. Used by `Commands.spawn`. */
  reserveEntity(): Entity {
    return this.allocate()
  }

  spawnReserved(entity: Entity, inits: readonly ComponentInit[]): void {
    const index = entity % MAX_ENTITIES
    if (
      index >= this.nextIndex ||
      this.tableOf[index] !== PENDING ||
      this.generations[index] !== Math.floor(entity / MAX_ENTITIES)
    ) {
      throw new ShardError('ecs/dead-entity', `Entity ${formatEntity(entity)} is not reserved`)
    }
    this.insert(entity, inits)
  }

  isAlive(entity: Entity): boolean {
    if (!Number.isInteger(entity) || entity < 0) return false
    const index = entity % MAX_ENTITIES
    if (index >= this.nextIndex || this.tableOf[index]! >= PENDING) return false
    return this.generations[index] === Math.floor(entity / MAX_ENTITIES)
  }

  get entityCount(): number {
    return this.aliveCount
  }

  /** Despawns the entity and, if it has children, all of its descendants. */
  despawn(entity: Entity): void {
    this.locate(entity)
    const children = this.tryGet(entity, Children)
    if (children) {
      for (const child of children.entities) {
        if (child !== null && this.isAlive(child)) this.despawn(child)
      }
    }
    this.despawnSingle(entity)
  }

  /** Despawns only this entity. Its children lose their `ChildOf` and become roots. */
  despawnSingle(entity: Entity): void {
    this.locate(entity)
    const children = this.tryGet(entity, Children)
    if (children) {
      for (const child of children.entities) {
        if (child !== null && this.isAlive(child)) this.remove(child, ChildOf)
      }
    }

    let index = this.locate(entity)
    const components = this.tables[this.tableOf[index]!]!.components
    for (const def of components) {
      this.fire('remove', entity, def, undefined)
      if (!this.isAlive(entity)) return // an observer despawned it
    }

    index = this.locate(entity)
    const table = this.tables[this.tableOf[index]!]!
    const moved = table.removeRow(this.rowOf[index]!)
    if (moved !== -1) this.rowOf[moved % MAX_ENTITIES] = this.rowOf[index]!
    this.generations[index] = (this.generations[index]! + 1) & MAX_GENERATION
    this.tableOf[index] = FREE
    this.freeIndices.push(index)
    this.aliveCount--
  }

  // --- components ------------------------------------------------------------

  /** Adds a component (defaults for missing fields). If present, replaces it and fires `onSet`. */
  add<F extends Fields>(entity: Entity, component: ComponentDef<F>, value?: InitFields<F>): void {
    const def = component as ComponentDef
    const index = this.locate(entity)
    this.ensureRegistered(def)
    const table = this.tables[this.tableOf[index]!]!
    const row = this.rowOf[index]!
    const init = value as Record<string, unknown> | undefined

    if (table.has(def)) {
      const previous = this.hasObservers('set', def) ? table.readComponent(def, row) : undefined
      const added = table.addedTicks(def)[row]!
      table.initComponent(def, row, init)
      table.addedTicks(def)[row] = added
      this.fire('set', entity, def, previous)
      return
    }

    // One move, straight to the archetype with `def` and everything it requires.
    const target = this.tableWith(table, def)
    const newRow = this.moveEntity(index, table, row, target)
    target.initComponent(def, newRow, init)
    const added = target.components
    for (let i = 0; i < added.length; i++) {
      const c = added[i]!
      if (c !== def && !table.has(c)) target.initComponent(c, newRow, undefined)
    }
    this.fire('add', entity, def, undefined)
    for (let i = 0; i < added.length; i++) {
      const c = added[i]!
      if (c !== def && !table.has(c)) this.fire('add', entity, c, undefined)
    }
  }

  /** Removes a component. Returns false if the entity didn't have it. */
  remove(entity: Entity, component: ComponentDef): boolean {
    let index = this.locate(entity)
    if (!this.tables[this.tableOf[index]!]!.has(component)) return false
    this.fire('remove', entity, component, undefined)

    index = this.locate(entity)
    const table = this.tables[this.tableOf[index]!]!
    if (!table.has(component)) return true
    this.moveEntity(index, table, this.rowOf[index]!, this.tableWithout(table, component))
    return true
  }

  has(entity: Entity, component: ComponentDef): boolean {
    if (!this.isAlive(entity)) return false
    return this.tables[this.tableOf[entity % MAX_ENTITIES]!]!.has(component)
  }

  /** A copy of the component's value. Cold path: allocates. */
  get<F extends Fields>(entity: Entity, component: ComponentDef<F>): InferFields<F> {
    const index = this.locate(entity)
    const table = this.tables[this.tableOf[index]!]!
    if (!table.has(component as ComponentDef)) throw missingComponent(entity, component.name)
    return table.readComponent(component, this.rowOf[index]!)
  }

  tryGet<F extends Fields>(entity: Entity, component: ComponentDef<F>): InferFields<F> | undefined {
    if (!this.has(entity, component as ComponentDef)) return undefined
    const index = entity % MAX_ENTITIES
    return this.tables[this.tableOf[index]!]!.readComponent(component, this.rowOf[index]!)
  }

  /** Writes the given fields and marks the component changed. */
  set<F extends Fields>(entity: Entity, component: ComponentDef<F>, values: InitFields<F>): void {
    const def = component as ComponentDef
    const index = this.locate(entity)
    const table = this.tables[this.tableOf[index]!]!
    if (!table.has(def)) throw missingComponent(entity, def.name)
    const row = this.rowOf[index]!
    const previous = this.hasObservers('set', def) ? table.readComponent(def, row) : undefined
    table.writeComponent(def, row, values as Record<string, unknown>)
    this.fire('set', entity, def, previous)
  }

  /** The table holding the entity's components. For system code that walks relationships. */
  entityTable(entity: Entity): Table {
    return this.tables[this.tableOf[this.locate(entity)]!]!
  }

  /** The entity's row in its table. Valid until the next structural change. */
  entityRow(entity: Entity): number {
    return this.rowOf[this.locate(entity)]!
  }

  /**
   * Like `entityTable` / `entityRow` but without the liveness check, for hot relationship walks
   * where the caller already knows the entity is alive (e.g. entries of a `Children` list).
   */
  entityTableUnchecked(entity: Entity): Table {
    return this.tables[this.tableOf[entity % MAX_ENTITIES]!]!
  }

  entityRowUnchecked(entity: Entity): number {
    return this.rowOf[entity % MAX_ENTITIES]!
  }

  componentsOf(entity: Entity): readonly ComponentDef[] {
    return this.tables[this.tableOf[this.locate(entity)]!]!.components
  }

  // --- queries ---------------------------------------------------------------

  /** Returns a cached query; the same descriptor always gives the same `Query`. */
  query(desc: QueryDescriptor): Query {
    const key = queryKey(desc)
    let query = this.queries.get(key)
    if (!query) {
      query = new Query(desc)
      for (const def of query.with) this.ensureRegistered(def)
      for (const table of this.tables) query.consider(table)
      this.queries.set(key, query)
    }
    return query
  }

  // --- resources -------------------------------------------------------------

  insertResource<T>(def: ResourceDef<T>, value: T): void {
    this.registry.register(def as ResourceDef<unknown>)
    this.resources.set(def.id, value)
  }

  /** Inserts the resource from its `init` if it isn't present yet, and returns it. */
  initResource<T>(def: ResourceDef<T>): T {
    if (!this.resources.has(def.id)) {
      if (!def.init) {
        throw new ShardError(
          'ecs/no-resource-init',
          `Resource "${def.name}" has no init function`,
          {
            hint: 'Use insertResource with a value instead.',
          },
        )
      }
      this.insertResource(def, def.init())
    }
    return this.resources.get(def.id) as T
  }

  resource<T>(def: ResourceDef<T>): T {
    if (!this.resources.has(def.id)) {
      throw new ShardError('ecs/missing-resource', `Resource "${def.name}" is not in the world`, {
        hint: 'Insert it with insertResource, or add the plugin that provides it.',
      })
    }
    return this.resources.get(def.id) as T
  }

  tryResource<T>(def: ResourceDef<T>): T | undefined {
    return this.resources.get(def.id) as T | undefined
  }

  hasResource(def: ResourceDef<unknown>): boolean {
    return this.resources.has(def.id)
  }

  removeResource(def: ResourceDef<unknown>): boolean {
    return this.resources.delete(def.id)
  }

  // --- events ----------------------------------------------------------------

  send<T>(def: EventDef<T>, ...data: T extends undefined ? [data?: T] : [data: T]): void {
    this.eventQueue(def).send(data[0] as T)
  }

  reader<T>(def: EventDef<T>): EventReader<T> {
    return new EventReader(this.eventQueue(def))
  }

  /** Advances every event queue by one frame. Called by the app at the start of each frame. */
  updateEvents(): void {
    for (const queue of this.eventQueues.values()) queue.update()
  }

  private eventQueue<T>(def: EventDef<T>): EventQueue<T> {
    let queue = this.eventQueues.get(def.id)
    if (!queue) {
      this.registry.register(def as EventDef<unknown>)
      queue = new EventQueue(def as EventDef<unknown>)
      this.eventQueues.set(def.id, queue)
    }
    return queue as EventQueue<T>
  }

  // --- observers -------------------------------------------------------------

  /** Registers an observer. Returns a function that unregisters it. */
  observe<F extends Fields>(trigger: LifecycleTrigger<F>, fn: LifecycleObserver<F>): () => void
  observe<T>(event: EventDef<T>, fn: TriggerObserver<T>): () => void
  observe(
    target: LifecycleTrigger | EventDef<unknown>,
    fn: LifecycleObserver | TriggerObserver<unknown>,
  ): () => void {
    let lists: unknown[][]
    let id: number
    if (target.kind === 'event') {
      this.registry.register(target)
      lists = this.observers.custom as unknown[][]
      id = target.id
    } else {
      this.ensureRegistered(target.component)
      lists = this.observers.listFor(target.kind) as unknown[][]
      id = target.component.id
    }
    let list = lists[id]
    if (!list) {
      list = []
      lists[id] = list
    }
    list.push(fn)
    return () => {
      const i = list.indexOf(fn)
      if (i !== -1) list.splice(i, 1)
    }
  }

  /** Runs observers registered for `event`, synchronously. */
  trigger<T>(event: EventDef<T>, data: T, entity?: Entity): void {
    const list = this.observers.custom[event.id]
    if (!list || list.length === 0) return
    const payload = { event: event as EventDef<unknown>, data, entity, world: this }
    for (const fn of list.slice()) fn(payload)
  }

  // --- introspection ---------------------------------------------------------

  stats(): WorldStats {
    return {
      entities: this.aliveCount,
      archetypes: this.tables.length,
      tables: this.tables.map((t) => ({
        components: t.components.map((c) => c.name),
        count: t.count,
        capacity: t.capacity,
        bytes: t.bytes(),
      })),
    }
  }

  /** All archetype tables, including empty ones. */
  allTables(): readonly Table[] {
    return this.tables
  }

  // --- internals -------------------------------------------------------------

  private allocate(): Entity {
    let index = this.freeIndices.pop()
    if (index === undefined) {
      if (this.nextIndex >= MAX_ENTITIES) {
        throw new ShardError('ecs/entity-limit', `Cannot exceed ${MAX_ENTITIES} live entities`, {
          hint: 'High-count data (particles, foliage, tiles) belongs in buffers, not entities.',
        })
      }
      index = this.nextIndex++
      if (index >= this.generations.length) this.growIndex()
    }
    this.tableOf[index] = PENDING
    return makeEntity(index, this.generations[index]!)
  }

  private growIndex(): void {
    const size = Math.min(this.generations.length * 2, MAX_ENTITIES)
    const generations = new Uint32Array(size)
    generations.set(this.generations)
    const tableOf = new Uint32Array(size).fill(FREE)
    tableOf.set(this.tableOf)
    const rowOf = new Uint32Array(size)
    rowOf.set(this.rowOf)
    this.generations = generations
    this.tableOf = tableOf
    this.rowOf = rowOf
  }

  /** Returns the entity's index, or throws if it isn't alive. */
  private locate(entity: Entity): number {
    if (!this.isAlive(entity)) {
      throw new ShardError('ecs/dead-entity', `Entity ${formatEntity(entity)} is not alive`, {
        hint: 'It was despawned, or the id is stale. Check world.isAlive(entity) first.',
      })
    }
    return entity % MAX_ENTITIES
  }

  private insert(entity: Entity, inits: readonly ComponentInit[]): void {
    let table = this.emptyTable
    for (let i = 0; i < inits.length; i++) {
      const init = inits[i]!
      const def = (Array.isArray(init) ? init[0] : init) as ComponentDef
      this.ensureRegistered(def)
      table = this.tableWith(table, def)
    }
    const row = table.pushRow(entity)
    const index = entity % MAX_ENTITIES
    this.tableOf[index] = table.id
    this.rowOf[index] = row
    this.aliveCount++
    // Required components not given explicitly start at their defaults.
    const components = table.components
    for (let c = 0; c < components.length; c++) {
      if (!initsInclude(inits, components[c]!)) table.initComponent(components[c]!, row, undefined)
    }
    for (let i = 0; i < inits.length; i++) {
      const init = inits[i]!
      if (Array.isArray(init)) table.initComponent(init[0], row, init[1] as Record<string, unknown>)
      else table.initComponent(init as ComponentDef, row, undefined)
    }
    for (let c = 0; c < components.length; c++) this.fire('add', entity, components[c]!, undefined)
  }

  private moveEntity(index: number, from: Table, row: number, to: Table): number {
    const entity = from.entities[row]!
    const newRow = to.pushRow(entity)
    from.copySharedTo(row, to, newRow)
    const moved = from.removeRow(row)
    if (moved !== -1) this.rowOf[moved % MAX_ENTITIES] = row
    this.tableOf[index] = to.id
    this.rowOf[index] = newRow
    return newRow
  }

  /** The archetype with `def` and everything `def` requires (transitively) added. Cached. */
  private tableWith(table: Table, def: ComponentDef): Table {
    let next = table.addEdges.get(def.id)
    if (next) return next
    const components = [...table.components]
    const stack = [def]
    while (stack.length > 0) {
      const c = stack.pop()!
      if (components.includes(c)) continue
      this.ensureRegistered(c)
      components.push(c)
      stack.push(...c.requires)
    }
    next =
      components.length === table.components.length
        ? table
        : this.getOrCreateTable(components.sort(byId))
    table.addEdges.set(def.id, next)
    return next
  }

  private tableWithout(table: Table, def: ComponentDef): Table {
    let next = table.removeEdges.get(def.id)
    if (next) return next
    next = table.has(def)
      ? this.getOrCreateTable(table.components.filter((c) => c.id !== def.id))
      : table
    table.removeEdges.set(def.id, next)
    return next
  }

  private getOrCreateTable(components: readonly ComponentDef[]): Table {
    const key = components.map((c) => c.id).join(',')
    let table = this.tableByKey.get(key)
    if (!table) {
      table = new Table(this.tables.length, components, this)
      this.tables.push(table)
      this.tableByKey.set(key, table)
      for (const query of this.queries.values()) query.consider(table)
    }
    return table
  }

  private ensureRegistered(def: ComponentDef): void {
    if (this.registered[def.id]) return
    this.registry.register(def)
    this.registered[def.id] = true
  }

  private hasObservers(kind: LifecycleKind, def: ComponentDef): boolean {
    const list = this.observers.listFor(kind)[def.id]
    return list !== undefined && list.length > 0
  }

  private fire(
    kind: LifecycleKind,
    entity: Entity,
    def: ComponentDef,
    previous: Record<string, unknown> | undefined,
  ): void {
    const list = this.observers.listFor(kind)[def.id]
    if (!list || list.length === 0) return
    const event = { kind, entity, component: def, world: this, previous }
    for (const fn of list.slice()) fn(event)
  }

  /** Keeps `Children` in sync with `ChildOf`. */
  private installHierarchy(): void {
    this.observe(onAdd(ChildOf), ({ entity }) => {
      const { parent } = this.get(entity, ChildOf)
      if (parent !== null) this.addChild(parent, entity)
    })
    this.observe(onSet(ChildOf), ({ entity, previous }) => {
      const before = previous?.parent ?? null
      const { parent } = this.get(entity, ChildOf)
      if (before === parent) return
      if (before !== null && this.isAlive(before)) this.removeChild(before, entity)
      if (parent !== null) this.addChild(parent, entity)
    })
    this.observe(onRemove(ChildOf), ({ entity }) => {
      const { parent } = this.get(entity, ChildOf)
      if (parent !== null && this.isAlive(parent)) this.removeChild(parent, entity)
    })
  }

  private childList(parent: Entity): Entity[] | undefined {
    const index = this.locate(parent)
    const table = this.tables[this.tableOf[index]!]!
    if (!table.has(Children)) return undefined
    return table.column(Children, 'entities')[this.rowOf[index]!] as Entity[]
  }

  private addChild(parent: Entity, child: Entity): void {
    const list = this.childList(parent)
    if (!list) {
      this.add(parent, Children, { entities: [child] })
      return
    }
    if (!list.includes(child)) list.push(child)
    const index = parent % MAX_ENTITIES
    this.tables[this.tableOf[index]!]!.markChanged(Children, this.rowOf[index]!)
  }

  private removeChild(parent: Entity, child: Entity): void {
    const list = this.childList(parent)
    if (!list) return
    const i = list.indexOf(child)
    if (i === -1) return
    list.splice(i, 1)
    if (list.length === 0) {
      this.remove(parent, Children)
      return
    }
    const index = parent % MAX_ENTITIES
    this.tables[this.tableOf[index]!]!.markChanged(Children, this.rowOf[index]!)
  }
}

function initsInclude(inits: readonly ComponentInit[], def: ComponentDef): boolean {
  for (let i = 0; i < inits.length; i++) {
    const init = inits[i]!
    if ((Array.isArray(init) ? init[0] : init) === def) return true
  }
  return false
}

function missingComponent(entity: Entity, name: string): ShardError {
  return new ShardError(
    'ecs/missing-component',
    `Entity ${formatEntity(entity)} has no "${name}" component`,
    { hint: 'Check world.has(entity, component) first, or use tryGet.' },
  )
}
