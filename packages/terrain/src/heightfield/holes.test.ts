import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box } from '@aethervtt/shard-mesh'
import { findPath, NavMesh, navPlugin } from '@aethervtt/shard-nav'
import { NoiseGraph } from '@aethervtt/shard-noise'
import {
  CharacterController,
  CharacterIntent,
  CharacterState,
  Collider,
  RigidBody,
} from '@aethervtt/shard-physics'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import {
  captureView,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
} from '@aethervtt/shard-render'
import { compareGolden } from '@aethervtt/shard-render/testing'
import { FloatingOrigin, placeInGrid, Transform, worldPosition64 } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainAnchor } from '../components'
import { bakeTerrain } from './bake'
import { tilesOf } from './colliders'
import { bakeNearPage, cellOpen, PAGE, readPage } from './kernel'
import { sampleHeightfield } from './methods'
import { memoryPackStore, packOf, readIndex } from './pack'
import { terrainHeightAt } from './queries'
import { terrainLayout } from './source'
import { mainNoise } from './stack'
import {
  groundSource,
  groundStack,
  heightfieldApp,
  lookAt,
  NEAR_GRAIN,
  settleHeightfield,
  untilStreaming,
} from './testing'

const here = dirname(fileURLToPath(import.meta.url))
const workers = createNodeWorkers(3)
let full: GpuContext
let compat: GpuContext
let grain: NoiseGraph

beforeAll(async () => {
  await groundStack()
  grain = await NoiseGraph.create(NEAR_GRAIN)
})
afterAll(async () => {
  for (const g of [full, compat]) {
    await g?.device.queue.onSubmittedWorkDone()
    g?.destroy()
  }
  workers.dispose()
}, timeout(120_000))

/** The basement: 10 × 8 m at (1000, 1000), in the test generator's 24 × 16 m pad at 110 m. */
const BASEMENT = { x0: 995, x1: 1005, z0: 996, z1: 1004 }
const holed = (extra: Record<string, unknown> = {}) =>
  groundSource(2048, { holes: { generator: 'shard-test/Ground' }, ...extra })

describe('terrain holes (0120)', () => {
  it(
    'opens exactly the footprint’s cells, with the same bytes ahead, near and inline',
    async () => {
      const { source, stack } = await groundStack(holed())
      const layout = terrainLayout(source, 4)
      const store = memoryPackStore()
      await bakeTerrain({ source, layout, deps: {}, hash: 'holes' }, stack, store, { workers })
      const D = layout.depth
      let open = 0
      for (let z = 14; z <= 16; z++) {
        for (let x = 14; x <= 16; x++) {
          const { path, slot } = packOf(D, x, z)
          const pack = await store.read(path)
          const e = readIndex(path, pack!).entries[slot]!
          const ahead = readPage(pack!.subarray(e.offset, e.offset + e.length), true, layout.cells)
          const near = bakeNearPage(mainNoise(), stack, layout, D, x, z)
          expect(near.control).toEqual(ahead.control)
          for (let j = 0; j < PAGE; j++) {
            for (let i = 0; i < PAGE; i++) {
              const cx = x * PAGE + i + 0.5
              const cz = z * PAGE + j + 0.5
              const inside =
                cx > BASEMENT.x0 && cx < BASEMENT.x1 && cz > BASEMENT.z0 && cz < BASEMENT.z1
              const o = cellOpen(near.control, layout.cells, layout.paintStep, i, j)
              expect(o, `cell ${cx}, ${cz}`).toBe(inside)
              if (o) open++
            }
          }
        }
      }
      expect(open).toBe(80)
      // Parents carry none.
      const parent = bakeNearPage(mainNoise(), stack, layout, D - 1, 7, 7)
      for (let i = 3; i < parent.control.length; i += 4) expect(parent.control[i]).toBe(0)
    },
    timeout(120_000),
  )

  it(
    'lets a character fall through onto a floor below, and holds one beside it on the same ground',
    async () => {
      const stand = async (source: unknown, x: number, z: number, floor: boolean) => {
        const p = await heightfieldApp(undefined, { source, noise: { grain }, physics: true })
        await untilStreaming(p)
        const w = p.world
        if (floor) {
          const f = w.spawn(
            [RigidBody, { kind: 'fixed' }],
            [Collider, { shape: 'cuboid', halfExtents: [7, 0.25, 6] }],
            Transform,
          )
          placeInGrid(w, f, p.terrain, [1000, 106.75, 1000])
        }
        const c = w.spawn(
          [CharacterController, { radius: 0.35, height: 1.8 }],
          [CharacterIntent, {}],
          [CharacterState, {}],
          Transform,
          FloatingOrigin,
        )
        placeInGrid(w, c, p.terrain, [x, 111.5, z])
        for (let f = 0; f < 180; f++) p.app.update(1 / 60)
        const pos = worldPosition64(w, c, new Float64Array(3), p.terrain)
        const tiles = tilesOf(p.runtime())
        const at = terrainHeightAt(w, p.terrain, x, z)
        await p.app.dispose()
        return { y: pos[1]!, withHoles: tiles.withHoles, open: at.open, ground: at.height }
      }
      const fell = await stand(holed(), 1000, 1000, true)
      expect(fell.withHoles).toBeGreaterThan(0)
      expect(fell.open).toBe(true)
      // On the floor's top (107 m), not the pad (110 m).
      expect(fell.y).toBeLessThan(109)
      expect(fell.y).toBeGreaterThan(107)
      // Beside it, the trimesh tile is the heightfield's surface.
      const beside = await stand(holed(), 1009, 1000, false)
      const plain = await stand(groundSource(), 1009, 1000, false)
      expect(beside.withHoles).toBeGreaterThan(0)
      expect(plain.withHoles).toBe(0)
      expect(beside.open).toBe(false)
      expect(Math.abs(beside.y - plain.y)).toBeLessThan(0.01)
      expect(beside.y - beside.ground).toBeGreaterThan(0.8)
    },
    timeout(120_000),
  )

  it(
    'leaves a gap in the navmesh that paths go around',
    async () => {
      const p = await heightfieldApp(undefined, {
        source: holed(),
        noise: { grain },
        physics: true,
        extra: [navPlugin],
      })
      await untilStreaming(p)
      const w = p.world
      const rt = p.runtime()
      const origin = w.spawn(Transform, FloatingOrigin)
      placeInGrid(w, origin, p.terrain, [1000, 110, 1000])
      const anchor = w.spawn([TerrainAnchor, { radius: 60 }], Transform)
      placeInGrid(w, anchor, p.terrain, [1000, 110, 1000])
      for (let f = 0; f < 5; f++) p.app.update(1 / 60)
      const lo = new Float64Array(3)
      const hi = new Float64Array(3)
      rt.frame.pointToOrigin(960, 60, 960, lo)
      rt.frame.pointToOrigin(1040, 160, 1040, hi)
      w.spawn([
        NavMesh,
        {
          agentRadius: 0.4,
          agentHeight: 1.8,
          maxSlope: 40,
          maxClimb: 0.5,
          cellSize: 0.3,
          cellHeight: 0.15,
          tileSize: 64,
          boundsMin: [lo[0]!, lo[1]!, lo[2]!],
          boundsMax: [hi[0]!, hi[1]!, hi[2]!],
        },
      ])
      for (let f = 0; f < 120; f++) p.app.update(1 / 60)
      const a = new Float64Array(3)
      const b = new Float64Array(3)
      rt.frame.pointToOrigin(990, 110, 1000, a)
      rt.frame.pointToOrigin(1010, 110, 1000, b)
      const path = findPath(w, a, b)
      expect(path.status).toBe('complete')
      expect(path.length).toBeGreaterThan(21)
      const t = new Float64Array(3)
      for (let i = 1; i < path.count; i++) {
        const p0 = path.corners.subarray((i - 1) * 3, i * 3)
        const p1 = path.corners.subarray(i * 3, i * 3 + 3)
        for (let s = 0; s <= 1; s += 0.02) {
          rt.frame.pointToPlanet(
            p0[0]! + (p1[0]! - p0[0]!) * s,
            p0[1]! + (p1[1]! - p0[1]!) * s,
            p0[2]! + (p1[2]! - p0[2]!) * s,
            t,
          )
          const inside =
            t[0]! > BASEMENT.x0 + 0.2 &&
            t[0]! < BASEMENT.x1 - 0.2 &&
            t[2]! > BASEMENT.z0 + 0.2 &&
            t[2]! < BASEMENT.z1 - 0.2
          expect(inside, `path point ${t[0]}, ${t[2]}`).toBe(false)
        }
      }
      await p.app.dispose()
    },
    timeout(180_000),
  )

  it('reports open points to terrain.sample', async () => {
    const p = await heightfieldApp(undefined, { source: holed(), noise: { grain } })
    await untilStreaming(p)
    const s = await sampleHeightfield(p.world, p.runtime(), [
      [1000, 1000],
      [1009, 1000],
    ])
    expect(s.map((v) => v.open)).toEqual([true, false])
    await p.app.dispose()
  })

  for (const tier of ['full', 'baseline'] as const) {
    it(
      `shows the floor below through the hole (${tier})`,
      async () => {
        if (tier === 'full') full ??= await createNodeGpuContext()
        else compat ??= await createNodeGpuContext({ tier: 'baseline' })
        const gpu = tier === 'full' ? full : compat
        const p = await heightfieldApp(gpu, {
          source: holed(),
          noise: { grain },
          width: 96,
          heightPx: 96,
          clearColor: [0.4, 0.55, 0.8, 1],
        })
        expect(p.world.resource(Gpu).tier).toBe(tier)
        const w = p.world
        const lamp = w.resource(Materials).add(
          new MaterialAsset({
            baseColor: [0, 0, 0, 1],
            emissive: [1, 0.1, 0.05, 1],
            emissiveLuminance: 40_000,
          }),
        )
        const floor = w.spawn(
          [Mesh3d, { mesh: w.resource(Meshes).add(box()) }],
          [MeshMaterial, { material: lamp }],
          [Transform, { scale: [14, 0.5, 12] }],
        )
        placeInGrid(w, floor, p.terrain, [1000, 106.75, 1000])
        const anchor = w.spawn([TerrainAnchor, { radius: 40 }], Transform)
        placeInGrid(w, anchor, p.terrain, [1000, 110, 1000])
        await untilStreaming(p)
        lookAt(p, [1000, 122, 986], [1000, 107, 1000])
        await settleHeightfield(p)
        const shot = captureView(w, p.view)
        p.app.update(1 / 60)
        const image = await shot
        // The lamp's red inside the hole's middle, ground around it.
        const at = (px: number, py: number) => {
          const o = (py * image.width + px) * 4
          return [image.data[o]!, image.data[o + 1]!, image.data[o + 2]!]
        }
        const [r, g] = at(48, 48)
        expect(r).toBeGreaterThan(240)
        expect(r! - g!).toBeGreaterThan(80)
        const [r2] = at(4, 4)
        expect(r2).toBeLessThan(200)
        if (tier === 'full') compareGolden(here, 'holes-full', image)
        else expect(compareGolden(here, 'holes-full', image).mean).toBeLessThan(1.5)
        await p.app.dispose()
      },
      timeout(120_000),
    )
  }
})
