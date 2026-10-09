import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import {
  CharacterController,
  CharacterIntent,
  CharacterState,
  createRayHit,
  Physics,
} from '@aethervtt/shard-physics'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { placeInGrid, Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evalHeightPoints } from './kernel'
import { heightfieldSample, loadTerrainRegion, terrainHeightAt } from './queries'
import { mainNoise } from './stack'
import {
  drawnHeightAt,
  heightfieldApp,
  lookAt,
  settleHeightfield,
  snapshotDrawn,
  untilStreaming,
  VALLEY_HILLS,
  valleySource,
} from './testing'

let gpu: GpuContext
let hills: NoiseGraph
const workers = createNodeWorkers(3)

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
})

afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  workers.dispose()
}, timeout(120_000))

describe('the ground you see is the ground you stand on (0071)', () => {
  it(
    'puts a character’s collider surface within 1 cm of the drawn triangles around it',
    async () => {
      const p = await heightfieldApp(gpu, {
        ...valleySource(),
        noise: { hills },
        workers,
        physics: true,
        width: 160,
        heightPx: 120,
      })
      await untilStreaming(p)
      const rt = p.runtime()
      const out = new Float64Array(1)
      const [x0, z0] = [820, 1130]
      evalHeightPoints(mainNoise(), rt.stack!, [x0, z0], 1, rt.stack!.height.length, out)
      const c = p.world.spawn(
        [CharacterController, { radius: 0.35, height: 1.8 }],
        [CharacterIntent, {}],
        [CharacterState, {}],
        Transform,
      )
      placeInGrid(p.world, c, p.terrain, [x0, out[0]! + 1.2, z0])
      lookAt(p, [x0, out[0]! + 1.7, z0], [x0 + 20, out[0]!, z0 + 20])
      await settleHeightfield(p)
      for (let f = 0; f < 40; f++) p.app.update(1 / 60)
      expect(p.world.get(c, CharacterState).grounded).toBe(true)
      const frame = snapshotDrawn(p)
      // Leaves are drawn around the anchor (render depth there is the colliders').
      const physics = p.world.resource(Physics)
      const hit = createRayHit()
      const origin = new Float64Array(3)
      let compared = 0
      let worst = 0
      for (let dz = -24; dz <= 24; dz += 1.37) {
        for (let dx = -24; dx <= 24; dx += 1.29) {
          const x = x0 + dx
          const z = z0 + dz
          const drawn = drawnHeightAt(rt, frame, x, z)
          if (drawn === undefined) continue
          rt.frame.pointToOrigin(x, 500, z, origin)
          if (!physics.raycast(origin, [0, -1, 0], undefined, hit)) continue
          if (hit.entity === c) continue
          const solid = 500 - hit.distance
          worst = Math.max(worst, Math.abs(solid - drawn))
          compared++
        }
      }
      expect(compared).toBeGreaterThan(600)
      expect(worst).toBeLessThan(0.01)
      await p.app.dispose()
    },
    timeout(240_000),
  )

  it(
    'flattens the road across its width and paints its gravel to within blend of its edge',
    async () => {
      const p = await heightfieldApp(undefined, { ...valleySource(), noise: { hills }, workers })
      await untilStreaming(p)
      const rt = p.runtime()
      const road = rt.stack!.height[2] as { spline: { pts: Float64Array; count: number } }
      const pts = road.spline.pts
      const half = 4 // width 8
      const blend = 2
      let stations = 0
      let worstSlope = 0
      for (let k = 40; k + 1 < road.spline.count - 40; k += 37) {
        const ax = pts[k * 3]!
        const az = pts[k * 3 + 2]!
        const bx = pts[k * 3 + 3]!
        const bz = pts[k * 3 + 5]!
        const l = Math.hypot(bx - ax, bz - az)
        // Across the road, perpendicular to it.
        const px = -(bz - az) / l
        const pz = (bx - ax) / l
        await loadTerrainRegion(p.world, p.terrain, [ax - 12, az - 12, ax + 12, az + 12])
        const at = (d: number) => heightfieldSample(rt, ax + px * d, az + pz * d)
        const left = at(-(half - 0.6))
        const right = at(half - 0.6)
        expect(left.depth).toBe(rt.layout!.depth)
        const slope =
          (Math.atan(Math.abs(right.height - left.height) / (2 * (half - 0.6))) * 180) / Math.PI
        worstSlope = Math.max(worstSlope, slope)
        // Gravel on the road; not past its edge plus blend (and a paint cell of rounding).
        for (const d of [-3, -1.5, 0, 1.5, 3])
          expect(at(d).layers[0], `station ${k} at ${d}`).toBe('gravel')
        for (const d of [-(half + blend + 1.2), half + blend + 1.2])
          expect(at(d).layers[0]).not.toBe('gravel')
        const exact = terrainHeightAt(p.world, p.terrain, ax, az)
        expect(exact.exact).toBe(true)
        stations++
      }
      expect(stations).toBeGreaterThan(10)
      expect(worstSlope).toBeLessThan(1)
      await p.app.dispose()
    },
    timeout(240_000),
  )
})
