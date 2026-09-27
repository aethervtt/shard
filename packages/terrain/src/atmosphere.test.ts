import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@shard/noise'
import { Atmosphere, AtmospherePresets, Atmospheres, captureBuffer, Gpu } from '@shard/render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { placeCamera, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
let hills: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  hills = await NoiseGraph.create({
    output: 'h',
    nodes: { h: { fbm: { source: 'simplex', octaves: 6, frequency: 2e-5, seed: 3 } } },
  })
})

afterAll(() => gpu?.destroy())

const R = 600_000

describe('planet atmospheres (spec 0044)', () => {
  it("takes the planet's radius and hazes its terrain from orbit like its limb", async () => {
    const shots = []
    for (const withAtmosphere of [false, true]) {
      const p = await planetApp(gpu, {
        radius: R,
        heightScale: 4000,
        height: hills,
        width: 96,
        heightPx: 96,
        fovY: 40,
        clearColor: [0, 0, 0, 1],
      })
      if (withAtmosphere) p.world.add(p.planet, Atmosphere, { ...AtmospherePresets.earth })
      // 1 500 km above the surface, looking at the planet's center.
      placeCamera(p, [0, 0, R + 1_500_000], [0, 0, 0])
      await settleTerrain(p)
      if (withAtmosphere) {
        const rec = p.world.resource(Atmospheres).records.get(p.planet)!
        // bottomRadius 0: the Planet's radius, in km.
        expect(rec.model.bottom).toBeCloseTo(R / 1000, 6)
      }
      const shot = captureBuffer(p.world, p.view, 'post-hdr')
      p.app.update(1 / 60)
      shots.push(await shot)
      expect(p.world.resource(Gpu).errors).toEqual([])
    }
    const [bare, hazy] = shots as unknown as [{ data: Float32Array }, { data: Float32Array }]
    const at = (s: { data: Float32Array }, x: number, y: number) => {
      const o = (y * 96 + x) * 4
      return [s.data[o]!, s.data[o + 1]!, s.data[o + 2]!]
    }
    // The limb: a ring between the surface (39 px) and the top of the air (42.6 px) glows blue
    // where the bare planet shows black space.
    const ring = (s: { data: Float32Array }) => {
      let best = 0
      for (let k = 0; k < 360; k++) {
        const x = Math.round(48 + 40.8 * Math.cos((k * Math.PI) / 180))
        const y = Math.round(48 + 40.8 * Math.sin((k * Math.PI) / 180))
        best = Math.max(best, at(s, x, y)[2]!)
      }
      return best
    }
    // The middle of the disk (averaged): the same terrain, bluer through ~60 km of air.
    const mean = (img: { data: Float32Array }) => {
      const c = [0, 0, 0]
      for (let y = 38; y < 58; y++) {
        for (let x = 38; x < 58; x++) {
          const v = at(img, x, y)
          for (let k = 0; k < 3; k++) c[k] = c[k]! + v[k]! / 400
        }
      }
      return c
    }
    const a = mean(bare)
    const b = mean(hazy)
    // Air in front of bright ground: red dimmed by extinction, blue added by in-scattering.
    expect(b[0]!).toBeLessThan(a[0]! * 0.995)
    expect(b[2]! / b[0]!).toBeGreaterThan((a[2]! / a[0]!) * 1.02)
    expect(ring(hazy)).toBeGreaterThan(ring(bare) + 10)
  }, 120_000)
})
