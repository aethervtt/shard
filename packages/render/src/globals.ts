import { defineResource, ShardError } from '@aethervtt/shard-core'

/** vec4 slots in `shard::globals`' `data` array, shared by every plugin that reserves some. */
export const GLOBALS_DATA_SLOTS = 128

/**
 * vec4 slots in `shard::shader_data` (0127): 16 KiB, the most one uniform block holds on WebGL2's
 * floor and on a WebGPU compatibility device.
 */
export const SHADER_DATA_SLOTS = 1024

/** Group-0 binding of `shard::shader_data`, in camera views and shadow views alike. */
export const SHADER_DATA_BINDING = 18

/** Named ranges of vec4 slots, handed out in order from one block. */
class Slots {
  next = 0
  private readonly reserved = new Map<string, { slot: number; count: number }>()

  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  /** The first of `count` slots under `name`, or -1 when fewer are left. */
  reserve(name: string, count: number): number {
    const existing = this.reserved.get(name)
    if (existing && existing.count === count) return existing.slot
    if (this.next + count > this.capacity) return -1
    const slot = this.next
    this.next += count
    this.reserved.set(name, { slot, count })
    return slot
  }

  get left(): number {
    return this.capacity - this.next
  }
}

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
  private readonly slots = new Slots(GLOBALS_DATA_SLOTS)

  /**
   * Reserves `count` vec4 slots under `name` and returns the first: `globals.data[slot]` in WGSL,
   * `values[4 + slot * 4]` here. The same name and count get the same slots again.
   */
  reserve(name: string, count: number): number {
    const slot = this.slots.reserve(name, count)
    if (slot < 0) {
      throw new ShardError(
        'render/globals-full',
        `${name} needs ${count} shader globals slots; ${this.slots.left} are left`,
        { hint: 'Plugins share shard::globals’ data array; reserve fewer slots.' },
      )
    }
    return slot
  }

  /** Floats in use (the header and every reserved slot): what is uploaded. */
  get length(): number {
    return 4 + this.slots.next * 4
  }
}

export const ShaderGlobals = defineResource<ShaderGlobalsData>('render/ShaderGlobals', {
  description:
    'shard::globals for shaders: time, delta time, frame, and vec4 slots plugins reserve (wind).',
  init: () => new ShaderGlobalsData(),
})

/**
 * What `shard::shader_data` holds (0127): SHADER_DATA_SLOTS vec4s a game reserves and rewrites
 * each frame (a sea's waves, water masks, hull contacts), for its materials to read in every pass
 * they draw in. The forward renderer uploads the reserved slots each frame.
 */
export class ShaderDataBlock {
  /** The slots, four floats each. */
  readonly values = new Float32Array(SHADER_DATA_SLOTS * 4)
  private readonly slots = new Slots(SHADER_DATA_SLOTS)

  /**
   * Reserves `count` vec4 slots under `name` and returns the first: `shader_data[slot]` in WGSL,
   * `values[slot * 4]` here. The same name and count get the same slots again.
   */
  reserve(name: string, count: number): number {
    const slot = this.slots.reserve(name, count)
    if (slot < 0) {
      throw new ShardError(
        'render/shader-data-full',
        `${name} needs ${count} shard::shader_data slots; ${this.slots.left} are left`,
        {
          hint: 'A game’s materials share shard::shader_data’s 1024 slots; reserve fewer, or pack values tighter.',
        },
      )
    }
    return slot
  }

  /** Floats in use (every reserved slot): what is uploaded. */
  get length(): number {
    return this.slots.next * 4
  }
}

export const ShaderData = defineResource<ShaderDataBlock>('render/ShaderData', {
  description:
    'shard::shader_data for materials: 1024 vec4 slots a game reserves and rewrites each frame.',
  init: () => new ShaderDataBlock(),
})
