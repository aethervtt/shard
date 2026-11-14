import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Gpu, Instances, Mesh3d, Views } from '@aethervtt/shard-render'
import { renderView, settle } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Structure } from './compile'
import {
  ContactMesh,
  StructureCameraRegion,
  StructureChunk,
  StructureSettings,
  Wall,
} from './components'
import { rig } from './harness'
import { town } from './town'

// Region meshes for camera views (0073): one mesh per (32 m region, group, material) instead of a
// mesh per (8 m chunk, material), the same triangles in the same world space. Contact shade meshes
// (blended, one per chunk) stay as they are.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

describe('camera region meshes (0073)', () => {
  it('draw the same picture with a fraction of the meshes, and an edit rebuilds only its regions', {
    timeout: timeout(120_000),
  }, async () => {
    const r = await rig(gpu, { width: 192, height: 108 })
    const world = r.app.world
    const t = town(world, { buildings: 60 })
    r.look([-20, 25, -20], [60, 0, 60])
    await settle(r.app)
    const view = world.resource(Views).list[0]!.name
    const slots = () => world.resource(Instances).drawableCount
    const before = await renderView(r.app, view)
    const chunked = slots()
    const chunkMeshes = world
      .query({ with: [StructureChunk, Mesh3d], without: [ContactMesh] })
      .entities().length
    expect(chunkMeshes).toBeGreaterThan(100)

    world.resource(StructureSettings).cameraRegions = true
    const after = await renderView(r.app, view)
    const regions = world.query({ with: [StructureCameraRegion, Mesh3d] }).entities().length
    expect(
      world.query({ with: [StructureChunk, Mesh3d], without: [ContactMesh] }).entities().length,
      'chunks drawn',
    ).toBe(0)
    expect(regions / chunkMeshes).toBeLessThanOrEqual(0.3)
    expect(slots()).toBeLessThan(chunked)
    let differ = 0
    for (let i = 0; i < before.data.length; i += 4)
      if (
        Math.abs(before.data[i]! - after.data[i]!) +
          Math.abs(before.data[i + 1]! - after.data[i + 1]!) +
          Math.abs(before.data[i + 2]! - after.data[i + 2]!) >
        3
      )
        differ++
    expect(differ / (before.data.length / 4), `${differ} pixels differ`).toBeLessThanOrEqual(0.001)

    // A wall moves: its chunks rebuild, and only the regions they lie in.
    const state = world.resource(Structure)
    const wall = t.buildings[5]!.left
    const value = world.get(wall, Wall)
    world.set(wall, Wall, { a: [value.a[0] + 0.5, value.a[1]], b: [value.b[0] + 0.5, value.b[1]] })
    r.frame()
    const span = Math.round(state.regionSize() / state.chunkSize)
    const touched = new Set(
      state.last.dirtyChunks.map(
        ([x, z], i) =>
          `${state.last.dirtyGroups[i]}:${Math.floor(x / span)},${Math.floor(z / span)}`,
      ),
    )
    expect(state.regions.lastRebuilt).toBe(touched.size)
    expect(touched.size).toBeLessThanOrEqual(2)

    // Off again: chunk meshes draw for themselves.
    world.resource(StructureSettings).cameraRegions = false
    r.frame()
    expect(world.query({ with: [StructureCameraRegion] }).entities()).toHaveLength(0)
    expect(
      world.query({ with: [StructureChunk, Mesh3d], without: [ContactMesh] }).entities().length,
    ).toBe([...state.chunks.values()].reduce((n, c) => n + c.meshes.size, 0))
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })
})
