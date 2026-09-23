import type { ComponentDef } from '../schema/component'
import type { Fields, InferFields } from '../schema/field'
import type { EventDef } from '../schema/resource'
import type { Entity } from './entity'
import type { World } from './world'

export type LifecycleKind = 'add' | 'remove' | 'set'

export interface LifecycleTrigger<F extends Fields = Fields> {
  readonly kind: LifecycleKind
  readonly component: ComponentDef<F>
}

/** Fires after the component is added (not when an existing one is replaced; that's `onSet`). */
export const onAdd = <F extends Fields>(component: ComponentDef<F>): LifecycleTrigger<F> => ({
  kind: 'add',
  component,
})
/** Fires before the component is removed, including on despawn. The value is still readable. */
export const onRemove = <F extends Fields>(component: ComponentDef<F>): LifecycleTrigger<F> => ({
  kind: 'remove',
  component,
})
/** Fires after `world.set`, or after `world.add` replaces an existing value. */
export const onSet = <F extends Fields>(component: ComponentDef<F>): LifecycleTrigger<F> => ({
  kind: 'set',
  component,
})

export interface LifecycleEvent<F extends Fields = Fields> {
  readonly kind: LifecycleKind
  readonly entity: Entity
  readonly component: ComponentDef<F>
  readonly world: World
  /** For `set`: the value before the write. */
  readonly previous: InferFields<F> | undefined
}

export interface TriggerEvent<T> {
  readonly event: EventDef<T>
  readonly data: T
  readonly entity: Entity | undefined
  readonly world: World
}

export type LifecycleObserver<F extends Fields = Fields> = (event: LifecycleEvent<F>) => void
export type TriggerObserver<T> = (event: TriggerEvent<T>) => void

/** Observer lists indexed by component or event id. */
export class ObserverTable {
  readonly add: (LifecycleObserver[] | undefined)[] = []
  readonly remove: (LifecycleObserver[] | undefined)[] = []
  readonly set: (LifecycleObserver[] | undefined)[] = []
  readonly custom: (TriggerObserver<unknown>[] | undefined)[] = []

  listFor(kind: LifecycleKind): (LifecycleObserver[] | undefined)[] {
    return kind === 'add' ? this.add : kind === 'remove' ? this.remove : this.set
  }
}
