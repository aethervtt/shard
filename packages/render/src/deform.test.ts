import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadDataTextures } from './data-store'
import { DeformStore } from './deform'

// The deform store's persistent pose region (spec 0115): blocks callers own, before the per-frame
// region, uploaded in dirty ranges, with the clock in vec4 0.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  // SHARD_TIER=baseline: the store's arrays are data textures.
  await loadDataTextures()
})
afterAll(() => gpu.destroy())

/** The pose writes `upload()` makes, as [first vec4, vec4 count]. */
function uploads(store: DeformStore): [number, number][] {
  const write = vi.spyOn(store.poseBuffer, 'write')
  store.upload()
  const out = write.mock.calls.map(
    ([, byteOffset, , count]) => [byteOffset! / 16, count! / 4] as [number, number],
  )
  write.mockRestore()
  return out
}

describe('DeformStore persistent poses', () => {
  it('allocates first fit after the clock, and coalesces what is freed', () => {
    const store = new DeformStore(gpu)
    const a = store.allocPersistent(10)
    const b = store.allocPersistent(20)
    const c = store.allocPersistent(5)
    expect([a, b, c]).toEqual([1, 11, 31])
    store.freePersistent(b, 20)
    // First fit: the hole, not the end.
    expect(store.allocPersistent(15)).toBe(11)
    expect(store.allocPersistent(5)).toBe(26)
    store.freePersistent(11, 15)
    store.freePersistent(26, 5)
    store.freePersistent(a, 10)
    store.freePersistent(c, 5)
    // Everything freed is one block from 1 to the region's end.
    expect(store.persistentFree).toEqual({ vec4s: store.persistentEnd - 1, blocks: 1 })
    expect(store.allocPersistent(store.persistentEnd - 1)).toBe(1)
    expect(() => store.freePersistent(1, store.persistentEnd)).toThrow(/outside the region/)
    store.freePersistent(1, 10)
    expect(() => store.freePersistent(5, 2)).toThrow(/overlaps a free block/)
  })

  it('grows the region keeping its blocks, and puts the frame region after it', () => {
    const store = new DeformStore(gpu)
    const a = store.allocPersistent(3)
    store.poses.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], a * 4)
    store.beginFrame()
    expect(store.allocPoses(6)).toBe(store.persistentEnd)
    // Far past the initial poses array: both regions move up, the block stays.
    const big = store.allocPersistent(3000)
    expect(big).toBeGreaterThanOrEqual(a + 3)
    expect(store.persistentEnd).toBeGreaterThanOrEqual(big + 3000)
    expect(Array.from(store.poses.subarray(a * 4, a * 4 + 12))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
    store.beginFrame()
    expect(store.allocPoses(4)).toBe(store.persistentEnd)
    expect(store.poseCount).toBe(store.persistentEnd + 4)
    // The rest of the grown region is free.
    const after = store.allocPersistent(10)
    expect(after).toBe(big + 3000)
  })

  it('keeps the clock in vec4 0', () => {
    const store = new DeformStore(gpu)
    store.setClock(2.5)
    expect(store.poses[0]).toBe(2.5)
    expect(store.clock).toBe(2.5)
    expect(uploads(store)).toEqual([[0, 1]])
    // Unchanged: nothing to upload.
    store.setClock(2.5)
    expect(uploads(store)).toEqual([])
  })

  it('uploads only the persistent ranges written, then the frame region', () => {
    const store = new DeformStore(gpu)
    const a = store.allocPersistent(30)
    const b = store.allocPersistent(30)
    const c = store.allocPersistent(30)
    store.markPersistent(a, 30)
    store.markPersistent(b, 30)
    store.markPersistent(c, 30)
    store.upload()
    store.beginFrame()
    expect(uploads(store)).toEqual([])
    store.markPersistent(a + 2, 3)
    store.markPersistent(c, 3)
    // Overlapping and touching marks merge.
    store.markPersistent(a + 4, 2)
    store.markPersistent(c + 3, 1)
    store.beginFrame()
    const frame = store.allocPoses(6)
    expect(uploads(store)).toEqual([
      [a + 2, 4],
      [c, 4],
      [frame, 6],
    ])
    // Many scattered marks stay within a bounded list, covering every one.
    for (let i = 0; i < 80; i++) store.markPersistent(1 + ((i * 37) % 89), 1)
    const ranges = uploads(store)
    expect(ranges.length).toBeLessThanOrEqual(32)
    for (let i = 0; i < 80; i++) {
      const v = 1 + ((i * 37) % 89)
      expect(ranges.some(([lo, n]) => v >= lo && v < lo + n)).toBe(true)
    }
  })

  it('uploads everything when the GPU buffer grows', () => {
    const store = new DeformStore(gpu)
    const a = store.allocPersistent(8)
    store.markPersistent(a, 8)
    store.upload()
    const big = store.allocPersistent(5000)
    store.markPersistent(big, 1)
    store.beginFrame()
    store.allocPoses(3)
    // The GPU buffer can't hold it: a new one, so the whole region goes up with this frame's.
    expect(uploads(store)).toEqual([[0, store.persistentEnd + 3]])
    expect(store.poseBuffer.byteLength).toBeGreaterThanOrEqual(store.poseCount * 16)
  })
})
