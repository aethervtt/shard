import type { Commands } from '../ecs/commands'
import type { EventReader } from '../ecs/events'
import type { World } from '../ecs/world'
import type { EventDef } from '../schema/resource'

export interface SystemContext {
  /** Deferred changes, applied right after this system runs. */
  readonly commands: Commands
  /** World tick when this system last ran (0 before its first run). Use for added/changed. */
  readonly lastRunTick: number
  /** World tick of the current run. */
  readonly thisRunTick: number
  /** This system's own reader for an event (created on first use, then reused). */
  reader<T>(event: EventDef<T>): EventReader<T>
}

/** A run condition. Give it a `label` (see `condition`) so it shows up readably in `describe()`. */
export type Condition = ((world: World) => boolean) & { readonly label?: string }

export function condition(label: string, fn: (world: World) => boolean): Condition {
  return Object.assign((world: World) => fn(world), { label })
}

export function not(inner: Condition): Condition {
  return condition(`not(${conditionLabel(inner)})`, (world) => !inner(world))
}

export function conditionLabel(c: Condition): string {
  return c.label ?? (c.name || 'anonymous')
}

export interface SystemSpec<S> {
  /** Unique, namespaced (`game/movement`). Shows up in the profiler, logs, and agent API. */
  name: string
  description?: string
  /** Runs once before the first run. Returns the system's local state (queries, scratch). */
  setup?(world: World): S
  run(state: S, world: World, ctx: SystemContext): void
}

export type Label = SystemDef<unknown> | SystemSetDef

interface Orderable<Self> {
  after(...labels: Label[]): Self
  before(...labels: Label[]): Self
  runIf(...conditions: Condition[]): Self
}

export interface SystemDef<S = unknown> extends Orderable<SystemConfig> {
  readonly kind: 'system'
  readonly name: string
  readonly description: string | undefined
  setup?(world: World): S
  run(state: S, world: World, ctx: SystemContext): void
  inSet(...sets: SystemSetDef[]): SystemConfig
}

export interface SystemSetDef extends Orderable<SystemSetConfig> {
  readonly kind: 'set'
  readonly name: string
}

/** A system plus its scheduling constraints. Immutable; every method returns a new config. */
export class SystemConfig implements Orderable<SystemConfig> {
  readonly system: SystemDef<unknown>
  readonly afterLabels: readonly Label[]
  readonly beforeLabels: readonly Label[]
  readonly conditions: readonly Condition[]
  readonly sets: readonly SystemSetDef[]

  constructor(
    system: SystemDef<unknown>,
    after: readonly Label[] = [],
    before: readonly Label[] = [],
    conditions: readonly Condition[] = [],
    sets: readonly SystemSetDef[] = [],
  ) {
    this.system = system
    this.afterLabels = after
    this.beforeLabels = before
    this.conditions = conditions
    this.sets = sets
  }

  after(...labels: Label[]): SystemConfig {
    const { system, afterLabels, beforeLabels, conditions, sets } = this
    return new SystemConfig(system, [...afterLabels, ...labels], beforeLabels, conditions, sets)
  }

  before(...labels: Label[]): SystemConfig {
    const { system, afterLabels, beforeLabels, conditions, sets } = this
    return new SystemConfig(system, afterLabels, [...beforeLabels, ...labels], conditions, sets)
  }

  runIf(...more: Condition[]): SystemConfig {
    const { system, afterLabels, beforeLabels, conditions, sets } = this
    return new SystemConfig(system, afterLabels, beforeLabels, [...conditions, ...more], sets)
  }

  inSet(...more: SystemSetDef[]): SystemConfig {
    const { system, afterLabels, beforeLabels, conditions, sets } = this
    return new SystemConfig(system, afterLabels, beforeLabels, conditions, [...sets, ...more])
  }
}

/** Constraints applied to every system in a set. */
export class SystemSetConfig implements Orderable<SystemSetConfig> {
  readonly set: SystemSetDef
  readonly afterLabels: readonly Label[]
  readonly beforeLabels: readonly Label[]
  readonly conditions: readonly Condition[]

  constructor(
    set: SystemSetDef,
    after: readonly Label[] = [],
    before: readonly Label[] = [],
    conditions: readonly Condition[] = [],
  ) {
    this.set = set
    this.afterLabels = after
    this.beforeLabels = before
    this.conditions = conditions
  }

  after(...labels: Label[]): SystemSetConfig {
    return new SystemSetConfig(
      this.set,
      [...this.afterLabels, ...labels],
      this.beforeLabels,
      this.conditions,
    )
  }

  before(...labels: Label[]): SystemSetConfig {
    return new SystemSetConfig(
      this.set,
      this.afterLabels,
      [...this.beforeLabels, ...labels],
      this.conditions,
    )
  }

  runIf(...more: Condition[]): SystemSetConfig {
    return new SystemSetConfig(this.set, this.afterLabels, this.beforeLabels, [
      ...this.conditions,
      ...more,
    ])
  }
}

export function defineSystem<S = undefined>(spec: SystemSpec<S>): SystemDef<S> {
  const def: SystemDef<S> = {
    kind: 'system',
    name: spec.name,
    description: spec.description,
    run: spec.run,
    after: (...labels) => new SystemConfig(def as SystemDef<unknown>).after(...labels),
    before: (...labels) => new SystemConfig(def as SystemDef<unknown>).before(...labels),
    runIf: (...conditions) => new SystemConfig(def as SystemDef<unknown>).runIf(...conditions),
    inSet: (...sets) => new SystemConfig(def as SystemDef<unknown>).inSet(...sets),
  }
  if (spec.setup) def.setup = spec.setup
  return def
}

export function defineSystemSet(name: string): SystemSetDef {
  const def: SystemSetDef = {
    kind: 'set',
    name,
    after: (...labels) => new SystemSetConfig(def).after(...labels),
    before: (...labels) => new SystemSetConfig(def).before(...labels),
    runIf: (...conditions) => new SystemSetConfig(def).runIf(...conditions),
  }
  return def
}
