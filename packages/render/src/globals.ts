import { defineResource, ShardError } from '@aethervtt/shard-core'

/** vec4 slots in `shard::globals`' `data` array, shared by every plugin that reserves some. */
export const GLOBALS_DATA_SLOTS = 128

/**
 * What `shard::globals` holds: time, delta time and frame, then `data`, vec4 slots plugins reserve
 * for values every shader may read (wind, 0096). The forward renderer uploads it each frame, and it
 * is bound wherever materials run (camera views, shadows, foliage).
 */
export class ShaderGlobalsData {
  /** time, delta_time, frame (as u32 bits), padding, then the data slots. */
  readonly values = new Float32Array(4 + GLOBALS_DATA_SLOTS * 4)
  /** `values` as u32, for the frame counter. */
  readonly bits = new Uint32Array(this.values.buffer)
  private next = 0
  private readonly reserved = new Map<string, { slot: number; count: number }>()

  /**
   * Reserves `count` vec4 slots under `name` and returns the first: `globals.data[slot]` in WGSL,
   * `values[4 + slot * 4]` here. The same name and count get the same slots again.
   */
  reserve(name: string, count: number): number {
    const existing = this.reserved.get(name)
    if (existing && existing.count === count) return existing.slot
    if (this.next + count > GLOBALS_DATA_SLOTS) {
      throw new ShardError(
        'render/globals-full',
        `${name} needs ${count} shader globals slots; ${GLOBALS_DATA_SLOTS - this.next} are left`,
        { hint: 'Plugins share shard::globals’ data array; reserve fewer slots.' },
      )
    }
    const slot = this.next
    this.next += count
    this.reserved.set(name, { slot, count })
    return slot
  }

  /** Floats in use (the header and every reserved slot): what is uploaded. */
  get length(): number {
    return 4 + this.next * 4
  }
}

export const ShaderGlobals = defineResource<ShaderGlobalsData>('render/ShaderGlobals', {
  description:
    'shard::globals for shaders: time, delta time, frame, and vec4 slots plugins reserve (wind).',
  init: () => new ShaderGlobalsData(),
})
