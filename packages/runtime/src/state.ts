import {
  type Condition,
  condition,
  defineResource,
  defineSchedule,
  type ResourceDef,
  type ScheduleLabel,
  ShardError,
  type World,
} from '@aethervtt/shard-core'

export interface StateValue<T extends string> {
  current: T
  /** Requested transition, applied at the start of the next frame. */
  next: T | undefined
}

export interface StateDef<T extends string> {
  readonly kind: 'state'
  readonly name: string
  readonly values: readonly T[]
  readonly resource: ResourceDef<StateValue<T>>
  readonly enter: ReadonlyMap<T, ScheduleLabel>
  readonly exit: ReadonlyMap<T, ScheduleLabel>
}

export function defineState<const T extends string>(
  name: string,
  values: readonly T[],
): StateDef<T> {
  if (values.length === 0) {
    throw new ShardError('app/invalid-state', `State "${name}" needs at least one value`)
  }
  return {
    kind: 'state',
    name,
    values,
    resource: defineResource<StateValue<T>>(name, { description: `Current ${name} state` }),
    enter: new Map(values.map((v) => [v, defineSchedule(`${name}:enter:${v}`)])),
    exit: new Map(values.map((v) => [v, defineSchedule(`${name}:exit:${v}`)])),
  }
}

export function OnEnter<T extends string>(state: StateDef<T>, value: NoInfer<T>): ScheduleLabel {
  return state.enter.get(value) ?? invalid(state, value)
}

export function OnExit<T extends string>(state: StateDef<T>, value: NoInfer<T>): ScheduleLabel {
  return state.exit.get(value) ?? invalid(state, value)
}

export function inState<T extends string>(state: StateDef<T>, value: NoInfer<T>): Condition {
  if (!state.values.includes(value)) invalid(state, value)
  return condition(`inState(${state.name}=${value})`, (world) => {
    return world.tryResource(state.resource)?.current === value
  })
}

/** Requests a transition. It applies at the start of the next frame (OnExit, then OnEnter). */
export function setState<T extends string>(
  world: World,
  state: StateDef<T>,
  value: NoInfer<T>,
): void {
  if (!state.values.includes(value)) invalid(state, value)
  world.resource(state.resource).next = value
}

function invalid(state: StateDef<string>, value: string): never {
  throw new ShardError('app/invalid-state', `"${value}" is not a value of state "${state.name}"`, {
    hint: `Use one of: ${state.values.join(', ')}.`,
  })
}
