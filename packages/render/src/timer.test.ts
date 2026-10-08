import { Profiler, ProfilerResource, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { describe, expect, it } from 'vitest'
import { GpuTimer } from './timer'

// The flags the timer reads, without a WebGPU implementation loaded.
Object.assign(globalThis, {
  GPUBufferUsage: (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ?? {
    QUERY_RESOLVE: 0x200,
    COPY_SRC: 0x4,
    COPY_DST: 0x8,
    MAP_READ: 0x1,
  },
  GPUMapMode: (globalThis as { GPUMapMode?: unknown }).GPUMapMode ?? { READ: 1 },
})

/**
 * A device whose query set holds what `stamp` writes and keeps a slot's values until it's written
 * again, as tile-based GPUs do for passes they skip.
 */
function fakeTimer() {
  const slots = new BigUint64Array(192)
  let copied = new BigUint64Array(0)
  const device = {
    createQuerySet: () => ({ destroy() {} }),
    createBuffer: () => ({
      mapAsync: () => Promise.resolve(),
      getMappedRange: () => copied.slice().buffer,
      unmap() {},
    }),
  }
  const gpu = { features: new Set(['timestamp-query']), device, generation: 0 }
  const timer = new GpuTimer(gpu as unknown as GpuContext)
  const profiler = new Profiler()
  const world = { tryResource: (r: unknown) => (r === ProfilerResource ? profiler : undefined) }
  const encoder = {
    resolveQuerySet() {},
    copyBufferToBuffer: (_a: unknown, _b: number, _c: unknown, _d: number, bytes: number) => {
      copied = slots.slice(0, bytes / 8)
    },
  }
  /** One frame: passes by name, each with [begin, end] in ns, or null when the GPU skipped it. */
  const frame = async (passes: [string, [number, number] | null][]) => {
    timer.beginFrame()
    for (const [name, stamps] of passes) {
      const w = timer.allocate(name)!
      if (stamps) {
        slots[w.beginningOfPassWriteIndex!] = BigInt(stamps[0])
        slots[w.endOfPassWriteIndex!] = BigInt(stamps[1])
      }
    }
    timer.resolve(encoder as unknown as GPUCommandEncoder)
    timer.readback(world as unknown as World)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const last = (name: string) => profiler.all()[name]?.last
  return { timer, frame, last }
}

describe('GpuTimer', () => {
  it('drops a skipped pass whose slot keeps an old frame’s stamps', async () => {
    const t = fakeTimer()
    await t.frame([
      ['a', [1_000, 2_000_000]],
      ['b', [2_000_000, 3_000_000]],
    ])
    await t.frame([
      ['a', [10_000_000, 11_000_000]],
      ['b', null],
    ])
    expect(t.timer.frameSamples).toBe(2)
    // b's slot still held frame 1's stamps: frame 2 is a alone.
    expect(t.timer.frameMs).toBeCloseTo(1, 6)
  })

  it('keeps timing after the GPU clock steps back (Dawn on Metal while it calibrates)', async () => {
    const t = fakeTimer()
    // An early frame where most draws were skipped: one pass lands, 73 s ahead of what follows.
    await t.frame([
      ['sky', [73_000_000_000, 73_001_000_000]],
      ['forward', [0, 0]],
    ])
    for (let i = 0; i < 3; i++) {
      const base = 1_000_000_000 + i * 16_000_000
      await t.frame([
        ['sky', [base, base + 500_000]],
        ['forward', [base + 500_000, base + 2_500_000]],
      ])
    }
    expect(t.timer.frameSamples).toBe(4)
    expect(t.timer.frameMs).toBeCloseTo(2.5, 6)
    expect(t.last('gpu:forward')).toBeCloseTo(2, 6)
  })
})
