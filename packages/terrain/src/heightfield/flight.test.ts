import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { Upload } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodePlatform, createNodeWorkers } from '@aethervtt/shard-platform-node'
import { captureView, Shaders, Visibility } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evalHeightPoints } from './kernel'
import { pageGpuBytes } from './runtime'
import { mainNoise } from './stack'
import {
  type HeightfieldApp,
  heightfieldApp,
  holes,
  lookAt,
  openWorldSource,
  settleHeightfield,
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

const W = 64
const H = 48
const FOV = 60

/** The camera basis quat.lookRotation builds for a forward with +Y up. */
function basis(eye: number[], target: number[]) {
  const f = target.map((v, k) => v - eye[k]!)
  const fl = Math.hypot(f[0]!, f[1]!, f[2]!)
  const forward = f.map((v) => v / fl)
  const z = forward.map((v) => -v)
  const up0 = [0, 1, 0]
  let x = [
    up0[1]! * z[2]! - up0[2]! * z[1]!,
    up0[2]! * z[0]! - up0[0]! * z[2]!,
    up0[0]! * z[1]! - up0[1]! * z[0]!,
  ]
  const xl = Math.hypot(x[0]!, x[1]!, x[2]!)
  x = x.map((v) => v / xl)
  const y = [
    z[1]! * x[2]! - z[2]! * x[1]!,
    z[2]! * x[0]! - z[0]! * x[2]!,
    z[0]! * x[1]! - z[1]! * x[0]!,
  ]
  return { forward, right: x, up: y }
}

/**
 * From 5 km up over the terrain's corner region down to 30 m above the ground, then a 300 m/s
 * flight (5 m a frame) 30 m over the ground across it, looking ahead and down: holes per frame.
 */
async function fly(p: HeightfieldApp, size: number, frames: number) {
  const rt = p.runtime()
  const ground = (x: number, z: number) => {
    const out = new Float64Array(1)
    evalHeightPoints(mainNoise(), rt.stack!, [x, z], 1, rt.stack!.height.length, out)
    return out[0]!
  }
  const lowest = rt.lo
  const rect: [number, number, number, number] = [20, 20, size - 20, size - 20]
  let total = 0
  let worst = 0
  let maxRendered = 0
  const descend = Math.floor(frames / 3)
  for (let f = 0; f < frames; f++) {
    let x: number
    let z: number
    let altitude: number
    if (f < descend) {
      x = size * 0.15
      z = size * 0.15
      altitude = 5000 * (30 / 5000) ** (f / descend)
    } else {
      const d = (f - descend) * 5
      x = size * 0.15 + d * 0.7
      z = size * 0.15 + d * 0.7
      altitude = 30
    }
    const eye = [x, ground(x, z) + altitude, z]
    const ahead = Math.max(60, altitude * 1.2)
    const target = [x + ahead * 0.7, ground(x, z), z + ahead * 0.7]
    lookAt(p, eye, target)
    const shot = captureView(p.world, p.view)
    p.app.update(1 / 60)
    const image = await shot
    const b = basis(eye, target)
    const h = holes(image.data, W, H, FOV, eye, b.right, b.up, b.forward, lowest, rect)
    total += h
    worst = Math.max(worst, h)
    maxRendered = Math.max(maxRendered, rt.selection.renderedCount)
  }
  return { holes: total, worst, maxRendered }
}

describe('heightfield streaming without holes (spec 0071)', () => {
  it(
    'sees holes when the terrain isn’t drawn (the detector works)',
    async () => {
      const t = valleySource()
      const p = await heightfieldApp(gpu, {
        ...t,
        noise: { hills },
        workers,
        width: W,
        heightPx: H,
        fovY: FOV,
      })
      await untilStreaming(p)
      lookAt(p, [300, 400, 300], [900, 0, 900])
      await settleHeightfield(p, 60)
      p.world.set(p.terrain, Visibility, { mode: 'hidden' })
      const shot = captureView(p.world, p.view)
      p.app.update(1 / 60)
      const image = await shot
      const b = basis([300, 400, 300], [900, 0, 900])
      expect(
        holes(
          image.data,
          W,
          H,
          FOV,
          [300, 400, 300],
          b.right,
          b.up,
          b.forward,
          -150,
          [20, 20, 2028, 2028],
        ),
      ).toBeGreaterThan(500)
      await p.app.dispose()
    },
    timeout(120_000),
  )

  it(
    'flies from 5 km down to 30 m and on at 300 m/s with no hole in any frame',
    async () => {
      const t = valleySource()
      const p = await heightfieldApp(gpu, {
        ...t,
        noise: { hills },
        workers,
        width: W,
        heightPx: H,
        fovY: FOV,
      })
      await untilStreaming(p)
      lookAt(p, [300, 5000, 300], [900, 0, 900])
      await settleHeightfield(p, 60)
      const textureBytes = () =>
        gpu.owners().reduce((n, o) => n + gpu.uploads(o).bytes[Upload.textures]!, 0)
      const bytes0 = textureBytes()
      const uploaded0 = p.render()!.stats.uploaded
      const result = await fly(p, 2048, 300)
      expect(result.holes).toBe(0)
      expect(result.maxRendered).toBeGreaterThan(20)
      const uploaded = p.render()!.stats.uploaded - uploaded0
      expect(uploaded).toBeGreaterThan(100)
      // Page uploads are counted in 0055's upload accounting: each page's texels and control.
      expect(textureBytes() - bytes0).toBeGreaterThanOrEqual(
        uploaded * pageGpuBytes(p.runtime().layout!),
      )
      await p.app.dispose()
    },
    timeout(240_000),
  )

  it(
    'still shows no hole with every page read delayed 500 ms (coarse levels draw)',
    async () => {
      const t = valleySource()
      const p = await heightfieldApp(gpu, {
        ...t,
        noise: { hills },
        workers,
        width: W,
        heightPx: H,
        fovY: FOV,
      })
      await untilStreaming(p)
      lookAt(p, [300, 5000, 300], [900, 0, 900])
      // Shaders compile and the coarse levels go in; from here every read takes 500 ms more.
      for (let i = 0; i < 10; i++) {
        p.app.update(1 / 60)
        await p.world.resource(Shaders).whenIdle()
        await gpu.pipelines.whenIdle()
      }
      p.runtime().pages!.delayMs = 500
      const result = await fly(p, 2048, 300)
      expect(result.holes).toBe(0)
      await p.app.dispose()
    },
    timeout(240_000),
  )

  // 0071's 16 km terrain at 1 m: too big for `pnpm test` (it bakes once into the OS temp directory,
  // shared with the open-world-fly scenario), so `pnpm bench` or by hand (SHARD_BENCH=1).
  it.runIf(timingMode === 'bench')(
    'flies the 16 km terrain from 5 km down to 30 m and on at 300 m/s with no hole',
    async () => {
      const root = join(tmpdir(), 'shard-open-world-fly')
      mkdirSync(root, { recursive: true })
      const p = await heightfieldApp(gpu, {
        ...openWorldSource(),
        noise: { hills },
        workers,
        width: W,
        heightPx: H,
        fovY: FOV,
        fs: createNodePlatform({ root }).fs,
        name: 'open-world-16km',
      })
      await untilStreaming(p, timeout(1_800_000))
      lookAt(p, [2400, 5000, 2400], [3000, 0, 3000])
      await settleHeightfield(p, 60)
      const result = await fly(p, 16384, 600)
      expect(result.holes).toBe(0)
      await p.app.dispose()
    },
    timeout(3_600_000),
  )
})
