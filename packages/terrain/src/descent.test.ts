import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@shard/noise'
import { captureView, Gpu } from '@shard/render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Planet } from './components'
import { heightAt } from './heights'
import { holes, type PlanetApp, placeCamera, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
let terrain: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  terrain = await NoiseGraph.create({
    output: 'h',
    nodes: {
      continents: { fbm: { source: 'simplex', octaves: 7, frequency: 3e-4, seed: 1 } },
      ridges: { ridged: { source: 'simplex', octaves: 8, frequency: 3e-3, seed: 2 } },
      h: { add: ['continents', { multiply: ['ridges', 0.15] }] },
    },
  })
})

afterAll(() => gpu?.destroy())

const W = 64
const H = 48
const FOV = 60

interface Descent {
  frames: number
  holes: number
  worstFrame: number
  generated: number
  maxRendered: number
}

/**
 * Flies the camera down over a point from `from` metres of altitude to `to`: exponentially (a
 * constant fraction per frame, `frames` frames for the whole way), and at `speed` once that's
 * slower, so the last stretch is flown at `speed`. It looks at the ground ahead (40° down near the
 * surface, at the planet from far away).
 */
async function descend(
  p: PlanetApp,
  radius: number,
  heightScale: number,
  from: number,
  to: number,
  frames: number,
  speed: number,
): Promise<Descent> {
  const rt = p.runtime()
  const dir = [0.3, 0.9, 0.3]
  const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
  const n = dir.map((v) => v / dl)
  const ground = heightAt(rt, n[0]!, n[1]!, n[2]!)
  const east = [n[2]!, 0, -n[0]!]
  const el = Math.hypot(east[0]!, east[1]!, east[2]!)
  const e = east.map((v) => v / el)
  const north = [
    n[1]! * e[2]! - n[2]! * e[1]!,
    n[2]! * e[0]! - n[0]! * e[2]!,
    n[0]! * e[1]! - n[1]! * e[0]!,
  ]
  // The per-frame factor that makes the whole descent (exponential, then `speed`) take `frames`.
  const length = (r: number) => {
    let a = from
    let f = 0
    while (a > to && f < frames * 4) {
      a = Math.max(to, a - Math.max(a - a * r, Math.min(speed / 60, a - to)))
      f++
    }
    return f
  }
  let lo = 0.5
  let hi = 0.999999
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (length(mid) > frames) hi = mid
    else lo = mid
  }
  const ratio = lo
  const eyeAt = (a: number) => n.map((v) => v * (radius + ground + a))
  /** Camera basis (as quat.lookRotation builds it) looking at the ground 1.2 × altitude ahead. */
  const basis = (a: number) => {
    const eye = eyeAt(a)
    const theta = Math.min((1.2 * a) / radius, 0.6)
    const t = [0, 1, 2].map((k) => (n[k]! * Math.cos(theta) + north[k]! * Math.sin(theta)) * radius)
    const f = [0, 1, 2].map((k) => t[k]! - eye[k]!)
    const fl = Math.hypot(f[0]!, f[1]!, f[2]!)
    const forward = f.map((v) => v / fl)
    const z = forward.map((v) => -v)
    let x = [
      n[1]! * z[2]! - n[2]! * z[1]!,
      n[2]! * z[0]! - n[0]! * z[2]!,
      n[0]! * z[1]! - n[1]! * z[0]!,
    ]
    const xl = Math.hypot(x[0]!, x[1]!, x[2]!)
    x = x.map((v) => v / xl)
    const y = [
      z[1]! * x[2]! - z[2]! * x[1]!,
      z[2]! * x[0]! - z[0]! * x[2]!,
      z[0]! * x[1]! - z[1]! * x[0]!,
    ]
    return { eye, target: t, forward, right: x, up: y }
  }
  let altitude = from
  let total = 0
  let worst = 0
  let frame = 0
  let maxRendered = 0
  let b = basis(altitude)
  placeCamera(p, b.eye, b.target)
  await settleTerrain(p, 60)
  while (altitude > to) {
    const step = Math.max(altitude - altitude * ratio, Math.min(speed / 60, altitude - to))
    altitude = Math.max(to, altitude - step)
    b = basis(altitude)
    placeCamera(p, b.eye, b.target)
    const shot = captureView(p.world, p.view)
    p.app.update(1 / 60)
    const image = await shot
    const h = holes(image.data, W, H, FOV, b.eye, b.right, b.up, b.forward, radius - heightScale)
    total += h
    if (h > worst) worst = h
    maxRendered = Math.max(maxRendered, rt.selection.renderedCount)
    frame++
  }
  const pr = rt.parts.get('render') as { stats: { generated: number } }
  return {
    frames: frame,
    holes: total,
    worstFrame: worst,
    generated: pr.stats.generated,
    maxRendered,
  }
}

/** Stands 2 m over the landing point looking toward the horizon (5° down); rendered chunks. */
async function standingView(p: PlanetApp, radius: number): Promise<number> {
  const rt = p.runtime()
  const n = [0.3, 0.9, 0.3].map((v) => v / Math.hypot(0.3, 0.9, 0.3))
  const ground = heightAt(rt, n[0]!, n[1]!, n[2]!)
  const eye = n.map((v) => v * (radius + ground + 2))
  const east = [n[2]!, 0, -n[0]!]
  const el = Math.hypot(east[0]!, east[1]!, east[2]!)
  const north = [0, 1, 2].map((k) => {
    const e = east.map((v) => v / el)
    return [
      n[1]! * e[2]! - n[2]! * e[1]!,
      n[2]! * e[0]! - n[0]! * e[2]!,
      n[0]! * e[1]! - n[1]! * e[0]!,
    ][k]!
  })
  const down = Math.tan((5 * Math.PI) / 180)
  placeCamera(
    p,
    eye,
    eye.map((v, k) => v + north[k]! - n[k]! * down),
  )
  await settleTerrain(p)
  return rt.selection.renderedCount
}

describe('descent without holes (spec 0043)', () => {
  it('sees holes when there is no terrain (the detector works)', async () => {
    const radius = 6.371e6
    const p = await planetApp(gpu, {
      radius,
      heightScale: 600,
      height: terrain,
      width: W,
      heightPx: H,
      fovY: FOV,
      chunksPerFrame: 0,
    })
    const d = [0.3, 0.9, 0.3].map((v) => v / Math.hypot(0.3, 0.9, 0.3))
    const eye = d.map((v) => v * (radius + 5000))
    const target = d.map((v, k) => v * radius + (k === 2 ? 4000 : 0))
    placeCamera(p, eye, target)
    await settleTerrain(p, 10)
    const shot = captureView(p.world, p.view)
    p.app.update(1 / 60)
    const image = await shot
    // The camera basis placeCamera builds (quat.lookRotation with up = radial).
    const f = target.map((v, k) => v - eye[k]!)
    const fl = Math.hypot(f[0]!, f[1]!, f[2]!)
    const forward = f.map((v) => v / fl)
    const z = forward.map((v) => -v)
    let x = [
      d[1]! * z[2]! - d[2]! * z[1]!,
      d[2]! * z[0]! - d[0]! * z[2]!,
      d[0]! * z[1]! - d[1]! * z[0]!,
    ]
    const xl = Math.hypot(x[0]!, x[1]!, x[2]!)
    x = x.map((v) => v / xl)
    const y = [
      z[1]! * x[2]! - z[2]! * x[1]!,
      z[2]! * x[0]! - z[0]! * x[2]!,
      z[0]! * x[1]! - z[1]! * x[0]!,
    ]
    expect(holes(image.data, W, H, FOV, eye, x, y, forward, radius - 600)).toBeGreaterThan(
      W * H * 0.5,
    )
  })

  it('lands on a 4 km planet from 20 000 km (500 m/s near the ground) without a hole', async () => {
    const p = await planetApp(gpu, {
      radius: 4000,
      heightScale: 300,
      height: terrain,
      width: W,
      heightPx: H,
      fovY: FOV,
    })
    const result = await descend(p, 4000, 300, 2e7, 2, 600, 500)
    expect(p.world.resource(Gpu).errors).toEqual([])
    expect(result.holes).toBe(0)
    expect(result.frames).toBeGreaterThan(400)
    expect(result.generated).toBeGreaterThan(50)
  }, 240_000)

  it('lands on an Earth-sized planet from 40 000 km in 120 s, and a 16 000 km super-Earth, without a hole', async () => {
    const counts: number[] = []
    for (const radius of [6.371e6, 1.6e7]) {
      const p = await planetApp(gpu, {
        radius,
        heightScale: 600,
        height: terrain,
        width: W,
        heightPx: H,
        fovY: FOV,
      })
      // 120 s at 60 fps, the last stretch at 500 m/s.
      const result = await descend(p, radius, 600, 4e7, 2, 7200, 500)
      expect(p.world.resource(Gpu).errors).toEqual([])
      expect(result.holes).toBe(0)
      expect(result.frames).toBeGreaterThan(7000)
      // LOD structure across planet sizes: uncapped (vertexPixels cuts small planets' detail more).
      p.world.set(p.planet, Planet, { vertexPixels: 0 })
      counts.push(await standingView(p, radius))
    }
    // The same view, and the same terrain, 2 m over a 4 km planet.
    const small = await planetApp(gpu, {
      radius: 4000,
      heightScale: 600,
      height: terrain,
      width: W,
      heightPx: H,
      fovY: FOV,
      vertexPixels: 0,
    })
    const reference = await standingView(small, 4000)
    for (const c of counts) {
      expect(c / reference).toBeLessThan(2)
      expect(reference / c).toBeLessThan(2)
    }
  }, 600_000)
})
