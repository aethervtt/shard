import type { ComponentDef } from '../schema/component'
import type { Fields, InitFields } from '../schema/field'
import type { Entity } from './entity'
import type { ComponentInit, World } from './world'

const SPAWN = 0
const DESPAWN = 1
const DESPAWN_SINGLE = 2
const ADD = 3
const REMOVE = 4
const SET = 5
const RUN = 6

/**
 * Deferred world changes, applied in issue order at the next sync point. Use these for
 * structural changes (spawn, despawn, add, remove) while iterating a query.
 *
 * Stored in flat, reused arrays: after warm-up, recording a command doesn't allocate
 * beyond the values you pass in.
 */
export class Commands {
  private readonly ops: number[] = []
  private readonly targets: Entity[] = []
  private readonly defs: (ComponentDef | undefined)[] = []
  private readonly payloads: unknown[] = []
  private readonly world: World

  constructor(world: World) {
    this.world = world
  }

  get length(): number {
    return this.ops.length
  }

  /** Reserves an entity id now; the entity comes alive when the commands apply. */
  spawn(...inits: ComponentInit[]): Entity {
    const entity = this.world.reserveEntity()
    this.push(SPAWN, entity, undefined, inits)
    return entity
  }

  /** Despawns the entity and its descendants. Already-dead entities are skipped. */
  despawn(entity: Entity): void {
    this.push(DESPAWN, entity, undefined, undefined)
  }

  despawnSingle(entity: Entity): void {
    this.push(DESPAWN_SINGLE, entity, undefined, undefined)
  }

  add<F extends Fields>(entity: Entity, component: ComponentDef<F>, value?: InitFields<F>): void {
    this.push(ADD, entity, component as ComponentDef, value)
  }

  remove(entity: Entity, component: ComponentDef): void {
    this.push(REMOVE, entity, component, undefined)
  }

  set<F extends Fields>(entity: Entity, component: ComponentDef<F>, value: InitFields<F>) {
    this.push(SET, entity, component as ComponentDef, value)
  }

  /** Runs arbitrary code against the world at apply time. */
  run(fn: (world: World) => void): void {
    this.push(RUN, -1, undefined, fn)
  }

  /** Applies every recorded command in order, then clears the buffer. */
  apply(): void {
    const world = this.world
    // Commands issued while applying (e.g. by observers) run in the same pass.
    for (let i = 0; i < this.ops.length; i++) {
      const entity = this.targets[i]!
      const def = this.defs[i]
      const payload = this.payloads[i]
      switch (this.ops[i]) {
        case SPAWN:
          world.spawnReserved(entity, payload as ComponentInit[])
          break
        case DESPAWN:
          if (world.isAlive(entity)) world.despawn(entity)
          break
        case DESPAWN_SINGLE:
          if (world.isAlive(entity)) world.despawnSingle(entity)
          break
        case ADD:
          world.add(entity, def!, payload as Record<string, unknown> | undefined)
          break
        case REMOVE:
          world.remove(entity, def!)
          break
        case SET:
          world.set(entity, def!, payload as Record<string, unknown>)
          break
        case RUN:
          ;(payload as (world: World) => void)(world)
          break
      }
    }
    this.clear()
  }

  clear(): void {
    this.ops.length = 0
    this.targets.length = 0
    this.defs.length = 0
    this.payloads.length = 0
  }

  private push(op: number, entity: Entity, def: ComponentDef | undefined, payload: unknown): void {
    this.ops.push(op)
    this.targets.push(entity)
    this.defs.push(def)
    this.payloads.push(payload)
  }
}
