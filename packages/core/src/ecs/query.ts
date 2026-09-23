import type { ComponentDef } from '../schema/component'
import type { Entity } from './entity'
import type { Table } from './table'

export interface QueryDescriptor {
  /** Entities must have all of these. */
  with?: readonly ComponentDef[]
  /** Entities must have none of these. */
  without?: readonly ComponentDef[]
  /** Documents components the system may read if present. Doesn't affect matching. */
  optional?: readonly ComponentDef[]
  /** Row filter: component added since the `since` tick passed to `each`/`count`. Implies `with`. */
  added?: readonly ComponentDef[]
  /** Row filter: component changed since the `since` tick. Implies `with`. */
  changed?: readonly ComponentDef[]
}

export function queryKey(desc: QueryDescriptor): string {
  const ids = (defs: readonly ComponentDef[] | undefined) =>
    (defs ?? [])
      .map((d) => d.id)
      .sort((a, b) => a - b)
      .join(',')
  return `w${ids(desc.with)}|x${ids(desc.without)}|a${ids(desc.added)}|c${ids(desc.changed)}`
}

/**
 * A cached list of tables matching a descriptor. The world keeps `tables` up to date as new
 * archetypes appear. Create queries once (in system setup) and reuse them.
 *
 * Hot loops should walk `tables` directly; `each` is for cold code.
 */
export class Query {
  readonly tables: Table[] = []
  readonly with: readonly ComponentDef[]
  readonly without: readonly ComponentDef[]
  readonly optional: readonly ComponentDef[]
  readonly added: readonly ComponentDef[]
  readonly changed: readonly ComponentDef[]
  private readonly withIds: readonly number[]
  private readonly withoutIds: readonly number[]

  constructor(desc: QueryDescriptor) {
    this.added = desc.added ?? []
    this.changed = desc.changed ?? []
    this.with = [...new Set([...(desc.with ?? []), ...this.added, ...this.changed])]
    this.without = desc.without ?? []
    this.optional = desc.optional ?? []
    this.withIds = this.with.map((d) => d.id)
    this.withoutIds = this.without.map((d) => d.id)
  }

  /** @internal Called by the world for every table, once. */
  consider(table: Table): void {
    for (const id of this.withIds) if (!table.hasId(id)) return
    for (const id of this.withoutIds) if (table.hasId(id)) return
    this.tables.push(table)
  }

  /** Whether a row passes the `added` / `changed` filters for a given `since` tick. */
  passes(table: Table, row: number, since: number): boolean {
    for (const def of this.added) if (!table.isAdded(def, row, since)) return false
    for (const def of this.changed) if (!table.isChanged(def, row, since)) return false
    return true
  }

  /**
   * Calls `fn` for each matching row. `since` is the tick for `added`/`changed` filters
   * (a system passes `ctx.lastRunTick`). Don't make structural changes inside `fn`; use commands.
   */
  each(fn: (entity: Entity, row: number, table: Table) => void, since = 0): void {
    const filtered = this.added.length > 0 || this.changed.length > 0
    for (const table of this.tables) {
      for (let row = 0; row < table.count; row++) {
        if (filtered && !this.passes(table, row, since)) continue
        fn(table.entities[row]!, row, table)
      }
    }
  }

  count(since = 0): number {
    if (this.added.length === 0 && this.changed.length === 0) {
      let n = 0
      for (const table of this.tables) n += table.count
      return n
    }
    let n = 0
    this.each(() => n++, since)
    return n
  }

  entities(since = 0): Entity[] {
    const out: Entity[] = []
    this.each((e) => out.push(e), since)
    return out
  }
}
