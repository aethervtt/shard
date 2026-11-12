import type { AnyField, Fields } from '../schema'
import type { Entity } from './entity'
import { ChildOf, Derived } from './hierarchy'
import type { World } from './world'

/**
 * One sorted row per entity: its serializable components (and parent), as JSON. Equal worlds give
 * equal rows, so a hash of them (`worldHash` in `@aethervtt/shard-node`) checks determinism.
 * `core/Derived` entities (rebuilt from other state, like terrain chunks) are left out, and entity
 * ids are numbered by rank among the rest, so a run that spawns render-only chunks (a GPU) hashes
 * like one that doesn't (headless). Components are in name order, whatever order they were defined. In core so a bundle with its own engine copy (an export, 0110)
 * can produce them.
 */
export function worldHashRows(world: World): string[] {
  const kept: Entity[] = []
  for (const table of world.allTables()) {
    if (table.has(Derived)) continue
    for (let row = 0; row < table.count; row++) kept.push(table.entities[row]!)
  }
  kept.sort((a, b) => a - b)
  const rank = new Map<number, number>()
  for (let i = 0; i < kept.length; i++) rank.set(kept[i]!, i)
  const id = (e: unknown) => (typeof e === 'number' && e >= 0 ? (rank.get(e) ?? -1) : e)
  const remap = (field: AnyField, value: unknown): unknown => {
    if (value === null || value === undefined) return value
    if (field.kind === 'entity') return id(value)
    if (field.kind === 'list' && field.item && Array.isArray(value))
      return value.map((v) => remap(field.item!, v))
    if (field.kind === 'struct' && field.fields && typeof value === 'object')
      return remapFields(field.fields, value as Record<string, unknown>)
    return value
  }
  const remapFields = (fields: Fields, value: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...value }
    for (const key in fields) if (key in out) out[key] = remap(fields[key]!, out[key])
    return out
  }
  const rows: string[] = []
  for (const table of world.allTables()) {
    if (table.has(Derived)) continue
    // By name: the order of a table's columns follows definition order, which a bundle may change.
    const components = table.components
      .filter((c) => c.serializable || c === ChildOf)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      const values = components.map((c) => [
        c.name,
        remapFields(c.fields, c.serialize(table.readComponent(c, row)) as Record<string, unknown>),
      ])
      rows.push(JSON.stringify([rank.get(entity), values]))
    }
  }
  return rows.sort()
}
