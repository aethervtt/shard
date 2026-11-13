import { isPlainObject, type JsonValue, type World } from '@aethervtt/shard-core'
import { defineSaveSection } from '@aethervtt/shard-save'
import { type CellDeltaJson, DeltaState } from './delta'
import { flushCell, ownedByPartition, PartitionState, simulated, snapshotDynamic } from './runtime'

/**
 * Writes every cell delta (unloaded and loaded) with the dynamic entities of loaded cells as
 * dormant, so a restored server streams them back. Clients save nothing: the world is the server's.
 */
function capture(world: World): JsonValue | undefined {
  const s = world.tryResource(PartitionState)
  if (!s || s.hooks.role === 'client') return undefined
  const live = new Map<string, Map<string, CellDeltaJson['dormant']>>()
  for (const rt of s.instances.values()) {
    const byCell = new Map<string, CellDeltaJson['dormant']>()
    live.set(rt.partition.name, byCell)
    for (const cell of rt.cells.values()) {
      if (cell.root < 0) continue
      flushCell(world, rt, cell)
      if (simulated(s.hooks.role, cell.level))
        byCell.set(cell.key, snapshotDynamic(world, rt, cell))
    }
  }
  const out: Record<string, Record<string, JsonValue>> = {}
  for (const [name, cells] of s.deltas) {
    const part: Record<string, JsonValue> = {}
    for (const [key, delta] of cells) {
      const json = delta.toJson()
      const awake = live.get(name)?.get(key)
      if (awake && awake.length > 0) json.dormant = [...json.dormant, ...awake]
      if (Object.keys(json.entries).length === 0 && json.dormant.length === 0) continue
      part[key] = json as unknown as JsonValue
    }
    if (Object.keys(part).length > 0) out[name] = part
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Replaces every delta. Cells reload around the restored sources on the next frame. */
function restore(world: World, data: JsonValue): void {
  const s = world.initResource(PartitionState)
  s.instances.clear()
  s.dirty.clear()
  s.deltas.clear()
  if (!isPlainObject(data)) return
  for (const [name, cells] of Object.entries(data as Record<string, JsonValue>)) {
    if (!isPlainObject(cells)) continue
    const byCell = new Map<string, DeltaState>()
    for (const [key, json] of Object.entries(cells as Record<string, JsonValue>)) {
      byCell.set(key, DeltaState.fromJson(json as unknown as CellDeltaJson))
    }
    s.deltas.set(name, byCell)
  }
}

/** Registers the `partition` save section (0113). The plugin calls it. */
export function definePartitionSaveSection(): void {
  defineSaveSection('partition', { capture, restore, owns: ownedByPartition })
}
