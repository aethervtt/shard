import {
  ChildOf,
  Children,
  defineSystem,
  type Entity,
  Last,
  type World,
} from '@aethervtt/shard-core'
import type { GpuBuffer } from '@aethervtt/shard-gpu'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Camera3d } from './camera'
import { addRenderFeatures } from './features'
import { InstanceSlot, type InstanceStore, Instances, prepareInstances } from './instances'
import { RenderDescribers, RenderSet } from './plugin'
import { Cameras } from './view'
import { type HiddenSet, HiddenSetsResource, ViewVisibility } from './view-visibility'

// Per-view hiding (0070): resolves each camera's ViewVisibility to a bitset of instance slots.
// Lists re-resolve only when they change, when a slot is allocated or freed, or when the hierarchy
// changes; a still frame does no work.

/**
 * Every camera's hidden set, one range of words each. The GPU culler reads them from a region of
 * its LOD state buffer; only words that changed upload there.
 */
export class HiddenSets {
  /** Words per set: one bit per instance slot of the store's capacity. */
  words = 0
  data = new Uint32Array(0)
  readonly sets = new Map<Entity, HiddenSet>()
  /** Free set indices, reused before growing. */
  private readonly free: number[] = []
  private count = 0
  private dirty = new Uint8Array(0)
  private dirtyLo = Number.POSITIVE_INFINITY
  private dirtyHi = -1
  /** Every word uploads next time (a new layout, buffer, region or device). */
  private all = true
  /** Where the last upload went: a buffer version (it bumps when replaced) and byte offset. */
  private target: GpuBuffer | undefined
  private targetVersion = -1
  private targetOffset = -1
  /** Bytes uploaded by the last `upload`. */
  uploadedBytes = 0
  /** Resolves since start (tests: a still frame resolves nothing). */
  resolves = 0

  /** The set of `camera`, made on first use. */
  setOf(camera: Entity): HiddenSet {
    let set = this.sets.get(camera)
    if (set) return set
    const index = this.free.pop() ?? this.count++
    if (index * this.words + this.words > this.data.length) this.layout(this.words, index + 1)
    const base = index * this.words
    set = {
      camera,
      base,
      bits: this.data.subarray(base, base + this.words),
      slots: 0,
      hide: [],
      shadows: false,
      frame: -1,
    }
    this.sets.set(camera, set)
    return set
  }

  /** Frees a set: its words clear (and upload, so a reused index starts empty). */
  drop(set: HiddenSet): void {
    for (let w = 0; w < set.bits.length; w++) if (set.bits[w] !== 0) this.write(set.base + w, 0)
    this.sets.delete(set.camera)
    this.free.push(set.base / Math.max(1, this.words))
  }

  /** Makes room for `capacity` slots per set; a new width re-lays every set and uploads all. */
  ensureSlots(capacity: number): void {
    const words = Math.ceil(capacity / 32)
    if (words > this.words) this.layout(words, this.count)
  }

  private layout(words: number, sets: number): void {
    const data = new Uint32Array(words * Math.max(1, sets * 2))
    for (const set of this.sets.values()) {
      const index = set.base / Math.max(1, this.words)
      data.set(set.bits, index * words)
      set.base = index * words
    }
    this.data = data
    for (const set of this.sets.values()) set.bits = data.subarray(set.base, set.base + words)
    this.words = words
    this.dirty = new Uint8Array(data.length)
    this.all = true
  }

  private write(word: number, value: number): void {
    if (this.data[word] === value) return
    this.data[word] = value
    if (this.dirty[word]) return
    this.dirty[word] = 1
    if (word < this.dirtyLo) this.dirtyLo = word
    if (word > this.dirtyHi) this.dirtyHi = word
  }

  /**
   * Writes a set's new bits (from `next`, `words` long), marking only words that differ. Returns
   * whether any did.
   */
  assign(set: HiddenSet, next: Uint32Array): boolean {
    let changed = false
    for (let w = 0; w < set.bits.length; w++) {
      const value = next[w]!
      if (set.bits[w] !== value) {
        this.write(set.base + w, value)
        changed = true
      }
    }
    return changed
  }

  /**
   * Uploads changed words in runs to `buffer` at `byteOffset`; everything when that's not where
   * the last upload went, or the buffer was replaced (grown, or a new device).
   */
  upload(buffer: GpuBuffer, byteOffset: number): number {
    buffer.ensureCapacity(byteOffset + this.data.byteLength)
    // Reading .buffer makes a new one after a device loss (bumping its version).
    void buffer.buffer
    if (
      buffer !== this.target ||
      buffer.version !== this.targetVersion ||
      byteOffset !== this.targetOffset
    ) {
      this.target = buffer
      this.targetVersion = buffer.version
      this.targetOffset = byteOffset
      this.all = true
    }
    let bytes = 0
    if (this.all) {
      this.all = false
      this.dirty.fill(0)
      this.dirtyLo = Number.POSITIVE_INFINITY
      this.dirtyHi = -1
      if (this.data.length === 0) return 0
      buffer.write(this.data, byteOffset)
      this.uploadedBytes = this.data.byteLength
      return this.uploadedBytes
    }
    let start = -1
    for (let w = this.dirtyLo; w <= this.dirtyHi + 1; w++) {
      if (w <= this.dirtyHi && this.dirty[w] === 1) {
        this.dirty[w] = 0
        if (start < 0) start = w
      } else if (start >= 0) {
        buffer.write(this.data, byteOffset + start * 4, start, w - start)
        bytes += (w - start) * 4
        start = -1
      }
    }
    this.dirtyLo = Number.POSITIVE_INFINITY
    this.dirtyHi = -1
    this.uploadedBytes = bytes
    return bytes
  }
}

/** Scratch for resolving: the next bits of a set, and the walk's stack. */
let next = new Uint32Array(0)
const stack: Entity[] = []

/** Sets the bits of every slot under `roots` in `out`; returns how many slots. */
function resolve(world: World, roots: readonly (Entity | null)[], out: Uint32Array): number {
  out.fill(0)
  let slots = 0
  stack.length = 0
  for (const e of roots) if (e !== null && e !== undefined) stack.push(e)
  while (stack.length > 0) {
    const e = stack.pop()!
    if (!world.isAlive(e)) continue
    const table = world.entityTable(e)
    const row = world.entityRow(e)
    if (table.has(InstanceSlot)) {
      const slot = table.column(InstanceSlot, 'slot')[row]! - 1
      if (slot >= 0 && (out[slot >>> 5]! & (1 << (slot & 31))) === 0) {
        out[slot >>> 5] = out[slot >>> 5]! | (1 << (slot & 31))
        slots++
      }
    }
    if (table.has(Children)) {
      const children = table.column(Children, 'entities')[row]
      if (children) for (const c of children) if (c !== null) stack.push(c)
    }
  }
  return slots
}

/**
 * Resolves each camera's ViewVisibility into its hidden set, after the instance slots are current.
 * Lists resolve again only when they change, a slot is allocated or freed, or a ChildOf changes.
 */
export const resolveViewVisibility = defineSystem({
  name: 'render/resolve-view-visibility',
  description: "Resolves cameras' ViewVisibility lists to hidden slot bitsets (0070).",
  setup: (world) => ({
    q: world.query({ with: [Camera3d, ViewVisibility] }),
    hierarchy: world.query({ with: [ChildOf] }),
    epoch: -1,
    frame: 0,
  }),
  run: (state, world, ctx) => {
    const sets = world.tryResource(HiddenSetsResource)
    if (!sets) return
    const cameras = world.resource(Cameras)
    const store: InstanceStore = world.resource(Instances)
    const frame = ++state.frame
    let listed = 0
    for (const table of state.q.tables) listed += table.count
    if (listed === 0 && sets.sets.size === 0) return
    sets.ensureSlots(store.capacity)
    if (next.length < sets.words) next = new Uint32Array(sets.words)
    const since = ctx.lastRunTick
    // Anything that can move a slot into or out of a listed subtree: every list resolves again.
    let moved = store.slotEpoch !== state.epoch
    state.epoch = store.slotEpoch
    if (!moved) {
      for (const table of state.hierarchy.tables) {
        if (table.lastStructural > since || table.lastChanged(ChildOf) > since) {
          moved = true
          break
        }
      }
    }
    for (const table of state.q.tables) {
      const hide = table.column(ViewVisibility, 'hide')
      const shadows = table.column(ViewVisibility, 'shadows')
      const changed = table.changedTicks(ViewVisibility)
      for (let i = 0; i < table.count; i++) {
        const camera = table.entities[i]!
        const fresh = !sets.sets.has(camera)
        const set = sets.setOf(camera)
        set.frame = frame
        const cam = cameras.get(camera)
        if (cam) cam.hidden = set
        const hideShadows = shadows[i] === 1
        if (!fresh && !moved && changed[i]! <= since && set.shadows === hideShadows) continue
        const list = (hide[i] ?? []) as (Entity | null)[]
        const words = next.subarray(0, sets.words)
        set.slots = resolve(world, list, words)
        set.hide = list.filter((e): e is Entity => e !== null)
        sets.resolves++
        // Cached cascades (0055) of a camera that hides its sets' shadows redraw on a change.
        if ((sets.assign(set, words) && hideShadows) || set.shadows !== hideShadows)
          store.shadowEpoch++
        set.shadows = hideShadows
      }
    }
    // Cameras that lost the component (or despawned): only then is there a set not seen.
    if (sets.sets.size > listed) {
      for (const set of sets.sets.values()) {
        if (set.frame === frame) continue
        const cam = cameras.get(set.camera)
        if (cam?.hidden === set) cam.hidden = undefined
        if (set.shadows) store.shadowEpoch++
        sets.drop(set)
      }
    }
  },
})

/** render.describe's viewVisibility section: per camera, what it hides and the slots it resolves to. */
export function describeViewVisibility(world: World) {
  const out: Record<string, unknown> = {}
  for (const set of world.tryResource(HiddenSetsResource)?.sets.values() ?? [])
    out[`camera:${set.camera}`] = {
      hide: [...set.hide],
      slots: set.slots,
      shadows: set.shadows ? 'hide' : 'keep',
    }
  return out
}

/** Per-view hiding (0070): cameras' ViewVisibility lists, resolved for their culls. */
export const viewVisibilityPlugin = definePlugin({
  name: 'render/view-visibility',
  dependencies: ['render/forward'],
  build(app) {
    app.insertResource(HiddenSetsResource, new HiddenSets())
    app.addSystems(Last, resolveViewVisibility.inSet(RenderSet.Prepare).after(prepareInstances))
  },
  ready(app) {
    app.world.initResource(RenderDescribers).set('viewVisibility', describeViewVisibility)
    addRenderFeatures(app.world, {
      name: 'render/view-visibility',
      description: "Cameras' hidden lists (ViewVisibility).",
      nodes: [],
      baseline: { strategy: 'CPU culls read the same bits' },
    })
  },
})
