import { ShardError } from '../error'
import { defineComponent } from '../schema/component'
import { t } from '../schema/field'
import { defineEvent } from '../schema/resource'
import type { Entity } from './entity'
import { ChildOf, Children } from './hierarchy'
import { withHostWrite } from './host-write'
import { onAdd, onRemove, onSet } from './observers'
import type { ComponentInit, World } from './world'

// Ownership (0061): who made an entity or holds an asset, so a host can remove exactly what
// belonged to a scene or a mod, GPU memory included. An Owner is an object only its creator holds:
// ids and names can be read by anyone, but spawning, leasing and releasing take the object.

/** What an owner may hold at most, itself and its child owners together. */
export interface OwnerLimits {
  entities?: number
  triangles?: number
  textures?: number
  bytes?: number
}

export type OwnerQuota = keyof OwnerLimits

/** What an owner holds now: its own and its child owners' together. */
export interface OwnerUsage {
  entities: number
  triangles: number
  textures: number
  bytes: number
}

export interface OwnerDescription {
  name: string
  parent: string | undefined
  children: string[]
  released: boolean
  /** Usage including child owners, which is what limits apply to. */
  usage: OwnerUsage
  limits: OwnerLimits
  /** Sections other packages add: asset leases, GPU objects. */
  [section: string]: unknown
}

export const OwnedBy = defineComponent(
  'core/OwnedBy',
  {
    owner: t.u32({ description: 'The owner id; world.owners.nameOf(entity) gives its name.' }),
    inherited: t.bool({ description: "Set when the entity took its parent's owner." }),
  },
  {
    description:
      "Who owns this entity (0061). Only host code holding the Owner writes it (world.owners.spawn / adopt); children take their parent's owner. Never in scene files.",
    hostOnly: true,
  },
)

export const OwnerReleased = defineEvent<{ name: string; entities: number }>('core/OwnerReleased', {
  description: 'An owner was released: its entities despawned, its leases dropped.',
})

const QUOTAS: readonly OwnerQuota[] = ['entities', 'triangles', 'textures', 'bytes']
const ISSUE = Symbol('owner')

/** Created by `world.owners.create`; held by host code, never serialized. */
export class Owner {
  readonly name: string
  readonly parent: Owner | undefined
  readonly limits: Readonly<OwnerLimits>
  /** @internal The value `OwnedBy.owner` stores. */
  readonly id: number

  /** @internal Use `world.owners.create`. */
  constructor(
    token: symbol,
    id: number,
    name: string,
    parent: Owner | undefined,
    limits: OwnerLimits,
  ) {
    if (token !== ISSUE) {
      throw new ShardError('core/owner-invalid', 'Owners are created with world.owners.create', {
        hint: 'An Owner is a grant from host code; it cannot be constructed or copied.',
      })
    }
    this.id = id
    this.name = name
    this.parent = parent
    this.limits = Object.freeze({ ...limits })
  }
}

interface OwnerState {
  owner: Owner
  children: Set<OwnerState>
  parent: OwnerState | undefined
  /** Own plus children's. */
  usage: OwnerUsage
  released: boolean
}

type ReleaseHook = (owner: Owner) => void
type Describer = (owner: Owner) => unknown

/** The world's owners (`world.owners`). */
export class Owners {
  private readonly world: World
  private readonly states = new Map<number, OwnerState>()
  private readonly issued = new WeakMap<Owner, OwnerState>()
  private readonly releaseHooks = new Set<ReleaseHook>()
  private readonly describers = new Map<string, Describer>()
  private nextId = 1
  private live = 0

  constructor(world: World) {
    this.world = world
    world.observe(onAdd(OwnedBy), ({ entity }) => {
      const state = this.states.get(world.get(entity, OwnedBy).owner)
      if (state) this.adjust(state, 'entities', 1)
    })
    world.observe(onRemove(OwnedBy), ({ entity }) => {
      const state = this.states.get(world.get(entity, OwnedBy).owner)
      if (state) this.adjust(state, 'entities', -1)
    })
    world.observe(onSet(OwnedBy), ({ entity, previous }) => {
      const before = previous && this.states.get(previous.owner)
      const after = this.states.get(world.get(entity, OwnedBy).owner)
      if (before === after) return
      if (before) this.adjust(before, 'entities', -1)
      if (after) this.adjust(after, 'entities', 1)
    })
    // Children take their parent's owner unless the host gave them their own.
    world.observe(onAdd(ChildOf), ({ entity }) => this.inherit(entity))
    world.observe(onSet(ChildOf), ({ entity }) => this.inherit(entity))
  }

  /** A new owner. With `parent`, its usage counts toward the parent's limits too. */
  create(name: string, options: { parent?: Owner; limits?: OwnerLimits } = {}): Owner {
    const parent = options.parent ? this.state(options.parent) : undefined
    for (const [key, value] of Object.entries(options.limits ?? {})) {
      if (!QUOTAS.includes(key as OwnerQuota) || !(typeof value === 'number' && value >= 0)) {
        throw new ShardError('core/owner-invalid', `Invalid owner limit ${key}: ${value}`, {
          hint: `Limits are non-negative numbers for ${QUOTAS.join(', ')}.`,
        })
      }
    }
    const owner = new Owner(ISSUE, this.nextId++, name, parent?.owner, options.limits ?? {})
    const state: OwnerState = {
      owner,
      children: new Set(),
      parent,
      usage: { entities: 0, triangles: 0, textures: 0, bytes: 0 },
      released: false,
    }
    parent?.children.add(state)
    this.states.set(owner.id, state)
    this.issued.set(owner, state)
    this.live++
    return owner
  }

  /** Spawns an entity owned by `owner`: the only way to create an owned entity. */
  spawn(owner: Owner, ...inits: readonly ComponentInit[]): Entity {
    const state = this.state(owner)
    this.check(state, 'entities', 1)
    const spawn = this.world.spawn.bind(this.world) as (...i: readonly ComponentInit[]) => Entity
    return withHostWrite(() => spawn(...inits, [OwnedBy, { owner: owner.id, inherited: false }]))
  }

  /** Gives an existing entity, and the descendants that had no owner of their own, to `owner`. */
  adopt(owner: Owner, entity: Entity): void {
    const state = this.state(owner)
    const previous = this.world.tryGet(entity, OwnedBy)?.owner
    const moving: Entity[] = []
    this.collect(entity, previous, moving)
    this.check(state, 'entities', moving.filter((e) => this.ownerIdOf(e) !== owner.id).length)
    withHostWrite(() => {
      for (let i = 0; i < moving.length; i++) {
        const e = moving[i]!
        const value = { owner: owner.id, inherited: e !== entity }
        if (this.world.has(e, OwnedBy)) this.world.set(e, OwnedBy, value)
        else this.world.add(e, OwnedBy, value)
      }
    })
  }

  /**
   * Despawns everything `owner` and its child owners hold (with descendants), drops their leases
   * (unloading assets no one else leases, and their GPU objects), and sends `OwnerReleased`. The
   * owner and its children are unusable afterwards (`core/owner-released`).
   */
  release(owner: Owner): void {
    const state = this.state(owner)
    const all: OwnerState[] = []
    const gather = (s: OwnerState) => {
      for (const child of s.children) gather(child)
      all.push(s)
    }
    gather(state)
    const ids = new Set(all.map((s) => s.owner.id))
    const world = this.world
    const doomed: Entity[] = []
    const q = world.query({ with: [OwnedBy] })
    for (const table of q.tables) {
      const column = table.column(OwnedBy, 'owner')
      for (let i = 0; i < table.count; i++) {
        if (ids.has(column[i]!)) doomed.push(table.entities[i]! as Entity)
      }
    }
    const counts = new Map<number, number>()
    for (const s of all) counts.set(s.owner.id, s.usage.entities)
    for (const e of doomed) if (world.isAlive(e)) world.despawn(e)
    for (const s of all) {
      for (const hook of this.releaseHooks) hook(s.owner)
      s.released = true
      this.states.delete(s.owner.id)
      this.live--
      world.send(OwnerReleased, { name: s.owner.name, entities: counts.get(s.owner.id) ?? 0 })
    }
    state.parent?.children.delete(state)
  }

  /** Counts, limits and the sections other packages add (asset leases, GPU objects). */
  describe(owner: Owner): OwnerDescription {
    const state = this.issued.get(owner)
    if (!state) throw invalid()
    const out: OwnerDescription = {
      name: owner.name,
      parent: owner.parent?.name,
      children: [...state.children].map((c) => c.owner.name),
      released: state.released,
      usage: { ...state.usage },
      limits: { ...owner.limits },
    }
    if (!state.released) for (const [key, fn] of this.describers) out[key] = fn(owner)
    return out
  }

  /** Every live owner, for agents (`owners.describe` with no name). */
  list(): { name: string; parent: string | undefined; usage: OwnerUsage }[] {
    return [...this.states.values()].map((s) => ({
      name: s.owner.name,
      parent: s.owner.parent?.name,
      usage: { ...s.usage },
    }))
  }

  /** The live owner named `name`, for host code that keeps names rather than objects. */
  find(name: string): Owner | undefined {
    for (const s of this.states.values()) if (s.owner.name === name) return s.owner
    return undefined
  }

  /** The name of the entity's owner, or undefined. Reading ownership needs no grant. */
  nameOf(entity: Entity): string | undefined {
    const id = this.ownerIdOf(entity)
    return id === undefined ? undefined : this.states.get(id)?.owner.name
  }

  isReleased(owner: Owner): boolean {
    return this.issued.get(owner)?.released ?? true
  }

  /**
   * Reserves `amount` of a quota for work about to happen (an asset lease, a GPU upload): throws
   * `core/owner-quota` and changes nothing if it would exceed a limit of the owner or an ancestor.
   */
  charge(owner: Owner, quota: Exclude<OwnerQuota, 'entities'>, amount: number): void {
    const state = this.state(owner)
    this.check(state, quota, amount)
    this.adjust(state, quota, amount)
  }

  /**
   * Throws `core/owner-quota` unless `amount` more of `quota` fits `owner` and its ancestors. For work
   * that makes many things at once (a scene load) and must create nothing if it doesn't fit.
   */
  ensureCapacity(owner: Owner, quota: OwnerQuota, amount: number): void {
    this.check(this.state(owner), quota, amount)
  }

  /** Gives back what `charge` reserved. */
  refund(owner: Owner, quota: Exclude<OwnerQuota, 'entities'>, amount: number): void {
    const state = this.issued.get(owner)
    if (state && !state.released) this.adjust(state, quota, -amount)
  }

  /** Runs when an owner is released, after its entities are gone (assets drop its leases here). */
  onRelease(hook: ReleaseHook): () => void {
    this.releaseHooks.add(hook)
    return () => this.releaseHooks.delete(hook)
  }

  /** Adds a section to `describe` (e.g. `leases`, `gpu`). */
  addDescriber(section: string, describe: Describer): () => void {
    this.describers.set(section, describe)
    return () => this.describers.delete(section)
  }

  /** Throws `core/owner-released` or `core/owner-invalid` unless `owner` is live and issued here. */
  private state(owner: Owner): OwnerState {
    const state = this.issued.get(owner)
    if (!state) throw invalid()
    if (state.released) {
      throw new ShardError('core/owner-released', `Owner "${owner.name}" was released`, {
        hint: 'Create a new owner; a released one holds nothing and accepts nothing.',
      })
    }
    return state
  }

  private check(state: OwnerState, quota: OwnerQuota, amount: number): void {
    if (amount <= 0) return
    for (let s: OwnerState | undefined = state; s; s = s.parent) {
      const limit = s.owner.limits[quota]
      if (limit !== undefined && s.usage[quota] + amount > limit) {
        throw new ShardError(
          'core/owner-quota',
          `Owner "${s.owner.name}" is at its ${quota} limit (${s.usage[quota]} of ${limit}; ${amount} more requested)`,
          {
            path: quota,
            hint:
              s === state
                ? 'Release what it no longer needs, or create it with a higher limit.'
                : `The limit belongs to "${s.owner.name}", which counts its child owners' usage.`,
          },
        )
      }
    }
  }

  private adjust(state: OwnerState, quota: OwnerQuota, amount: number): void {
    for (let s: OwnerState | undefined = state; s; s = s.parent) s.usage[quota] += amount
  }

  private ownerIdOf(entity: Entity): number | undefined {
    return this.world.tryGet(entity, OwnedBy)?.owner
  }

  /** The entity and its descendants that are unowned or owned by `from` through inheritance. */
  private collect(entity: Entity, from: number | undefined, out: Entity[]): void {
    out.push(entity)
    const children = this.world.tryGet(entity, Children)
    if (!children) return
    for (const child of children.entities) {
      if (child === null || !this.world.isAlive(child)) continue
      const own = this.world.tryGet(child, OwnedBy)
      if (own && !(own.inherited && own.owner === from)) continue
      this.collect(child, from, out)
    }
  }

  /** A new child of an owned parent takes the parent's owner, unless it has its own. */
  private inherit(entity: Entity): void {
    if (this.live === 0) return
    const world = this.world
    const own = world.tryGet(entity, OwnedBy)
    if (own && !own.inherited) return
    const parent = world.get(entity, ChildOf).parent
    const from =
      parent !== null && world.isAlive(parent) ? world.tryGet(parent, OwnedBy) : undefined
    if (!from || !this.states.has(from.owner)) return
    if (own?.owner === from.owner) return
    const moving: Entity[] = []
    this.collect(entity, own?.owner, moving)
    withHostWrite(() => {
      for (let i = 0; i < moving.length; i++) {
        const e = moving[i]!
        const value = { owner: from.owner, inherited: true }
        if (world.has(e, OwnedBy)) world.set(e, OwnedBy, value)
        else world.add(e, OwnedBy, value)
      }
    })
  }
}

function invalid(): ShardError {
  return new ShardError('core/owner-invalid', 'Not an owner of this world', {
    hint: 'Pass the Owner object world.owners.create returned, in the same world.',
  })
}
