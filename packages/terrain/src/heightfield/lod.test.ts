import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { captureView, Gpu } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainBudget } from '../components'
import { evalHeightPoints } from './kernel'
import { HeightfieldDebug } from './render'
import { mainNoise } from './stack'
import {
  drawnHeightAt,
  heightfieldApp,
  holes,
  lookAt,
  settleHeightfield,
  snapshotDrawn,
  untilStreaming,
  VALLEY_HILLS,
  valleySource,
} from './testing'

let gpu: GpuContext
let hills: NoiseGraph
/** Fine relief everywhere, so splits everywhere are near the depth's error (the morph test). */
let rough: NoiseGraph
const workers = createNodeWorkers(3)

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
  rough = await NoiseGraph.create({
    output: 'h',
    nodes: {
      ...VALLEY_HILLS.nodes,
      fine: { fbm: { source: 'simplex', octaves: 5, frequency: 0.03, seed: 9 } },
      h: { add: [VALLEY_HILLS.nodes.h, { multiply: ['fine', 0.06] }] },
    },
  })
})

afterAll(async () => {
  HeightfieldDebug.mode = 0
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  workers.dispose()
}, timeout(120_000))

/** The camera basis quat.lookRotation builds for a forward with +Y up. */
function basis(eye: number[], target: number[]) {
  const f = target.map((v, k) => v - eye[k]!)
  const fl = Math.hypot(f[0]!, f[1]!, f[2]!)
  const forward = f.map((v) => v / fl)
  const z = forward.map((v) => -v)
  let x = [z[2]!, 0, -z[0]!]
  const xl = Math.hypot(x[0]!, x[1]!, x[2]!)
  x = x.map((v) => v / xl)
  const y = [
    z[1]! * x[2]! - z[2]! * x[1]!,
    z[2]! * x[0]! - z[0]! * x[2]!,
    z[0]! * x[1]! - z[1]! * x[0]!,
  ]
  return { forward, right: x, up: y }
}

describe('heightfield LOD (spec 0071)', () => {
  it(
    'shows no background through edges between levels with skirts off, in five views',
    async () => {
      const W = 160
      const H = 120
      const FOV = 60
      const p = await heightfieldApp(gpu, {
        ...valleySource(),
        noise: { hills },
        workers,
        skirts: false,
        width: W,
        heightPx: H,
        fovY: FOV,
      })
      HeightfieldDebug.mode = 2
      await untilStreaming(p)
      const rt = p.runtime()
      const ground = (x: number, z: number) => {
        const out = new Float64Array(1)
        evalHeightPoints(mainNoise(), rt.stack!, [x, z], 1, rt.stack!.height.length, out)
        return out[0]!
      }
      const views = [
        { at: [400, 400], altitude: 15, toward: [1, 0.4] },
        { at: [900, 700], altitude: 60, toward: [0.3, 1] },
        { at: [1500, 300], altitude: 250, toward: [-0.6, 1] },
        { at: [300, 1700], altitude: 900, toward: [1, -0.5] },
        { at: [1024, 1024], altitude: 3000, toward: [0.2, 0.2] },
      ]
      let worstDepths = 0
      for (const v of views) {
        const [x, z] = v.at as [number, number]
        const eye = [x, ground(x, z) + v.altitude, z]
        const d = Math.max(80, v.altitude * 1.5)
        const target = [x + v.toward[0]! * d, ground(x, z), z + v.toward[1]! * d]
        lookAt(p, eye, target)
        await settleHeightfield(p)
        const shot = captureView(p.world, p.view)
        p.app.update(1 / 60)
        const image = await shot
        const b = basis(eye, target)
        expect(
          holes(image.data, W, H, FOV, eye, b.right, b.up, b.forward, rt.lo, [8, 8, 2040, 2040]),
          JSON.stringify(v),
        ).toBe(0)
        const depths = new Set<number>()
        for (let i = 0; i < rt.selection.renderedCount; i++)
          depths.add(rt.tree.depth[rt.selection.rendered[i]!]!)
        worstDepths = Math.max(worstDepths, depths.size)
      }
      // The views do cross levels (edges between depths are what's tested).
      expect(worstDepths).toBeGreaterThanOrEqual(3)
      expect(p.world.resource(Gpu).errors).toEqual([])
      HeightfieldDebug.mode = 0
      await p.app.dispose()
    },
    timeout(240_000),
  )

  it(
    'never moves the ground more than a pixel between frames in a descent, uncapped',
    async () => {
      const W = 160
      const H = 120
      const FOV = 60
      const p = await heightfieldApp(gpu, {
        ...valleySource(),
        noise: { hills: rough },
        workers,
        width: W,
        heightPx: H,
        fovY: FOV,
        vertexPixels: 0,
        // Coarse on purpose: an unmorphed split would jump several pixels.
        errorPixels: 8,
      })
      p.world.resource(TerrainBudget).triangles = 0
      await untilStreaming(p)
      const rt = p.runtime()
      const ground = (x: number, z: number) => {
        const out = new Float64Array(1)
        evalHeightPoints(mainNoise(), rt.stack!, [x, z], 1, rt.stack!.height.length, out)
        return out[0]!
      }
      const x0 = 700
      const z0 = 600
      const g0 = ground(x0, z0)
      const frames = 360
      const ratio = (20 / 1500) ** (1 / frames)
      let altitude = 1500
      const eyeAt = (a: number) => [x0, g0 + a, z0]
      const down = Math.tan((35 * Math.PI) / 180)
      const aim = (eye: number[]) => [eye[0]! + 0.7, eye[1]! - down, eye[2]! + 0.7]
      lookAt(p, eyeAt(altitude), aim(eyeAt(altitude)))
      await settleHeightfield(p)
      let previous = snapshotDrawn(p)
      let worst = 0
      let compared = 0
      let deepest = 0
      const ty = Math.tan(((FOV / 2) * Math.PI) / 180)
      const tx = ty * (W / H)
      for (let f = 0; f < frames; f++) {
        altitude = Math.max(altitude * ratio, altitude - 300 / 60)
        const eye = eyeAt(altitude)
        const target = aim(eye)
        lookAt(p, eye, target)
        p.app.update(1 / 60)
        await gpu.pipelines.whenIdle()
        // A turn of the event loop, as between real frames: page reads land.
        await new Promise((r) => setTimeout(r, 0))
        const current = snapshotDrawn(p)
        const b = basis(eye, target)
        const project = (q: number[]) => {
          const r = [q[0]! - eye[0]!, q[1]! - eye[1]!, q[2]! - eye[2]!]
          const depth = r[0]! * b.forward[0]! + r[1]! * b.forward[1]! + r[2]! * b.forward[2]!
          const sx = (r[0]! * b.right[0]! + r[1]! * b.right[1]! + r[2]! * b.right[2]!) / depth / tx
          const sy = (r[0]! * b.up[0]! + r[1]! * b.up[1]! + r[2]! * b.up[2]!) / depth / ty
          return [((sx + 1) / 2) * W, ((1 - sy) / 2) * H, depth]
        }
        for (let py = 4; py < H; py += 8) {
          for (let px = 4; px < W; px += 8) {
            const sa = ((px + 0.5) / W) * 2 - 1
            const sb = 1 - ((py + 0.5) / H) * 2
            const d = [0, 1, 2].map(
              (k) => b.forward[k]! + b.right[k]! * sa * tx + b.up[k]! * sb * ty,
            )
            if (d[1]! >= -1e-3) continue
            // Where the ray meets the plane of the ground under the camera: a terrain point.
            const t = (g0 - eye[1]!) / d[1]!
            const x = eye[0]! + d[0]! * t
            const z = eye[2]! + d[2]! * t
            if (x < 0 || z < 0 || x > 2048 || z > 2048) continue
            const ha = drawnHeightAt(rt, previous, x, z)
            const hb = drawnHeightAt(rt, current, x, z)
            if (ha === undefined || hb === undefined) continue
            const pa = project([x, ha, z])
            const pb = project([x, hb, z])
            if (pa[2]! <= 1 || pb[2]! <= 1) continue
            compared++
            worst = Math.max(worst, Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!))
          }
        }
        previous = current
        for (const n of current.nodes.values()) deepest = Math.max(deepest, n.depth)
      }
      // It went all the way down: leaves drawn near the end.
      expect(deepest).toBe(rt.layout!.depth)
      expect(compared).toBeGreaterThan(frames * 50)
      expect(worst).toBeLessThanOrEqual(1)
      await p.app.dispose()
    },
    timeout(300_000),
  )
})
