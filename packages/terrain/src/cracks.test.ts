import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { captureView, Gpu } from '@aethervtt/shard-render'
import { compareGolden } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { heightAt } from './heights'
import { TerrainDebug } from './render'
import { placeCamera, planetApp, settleTerrain } from './test-planet'

const here = dirname(fileURLToPath(import.meta.url))
let gpu: GpuContext
let terrain: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  terrain = await NoiseGraph.create({
    output: 'h',
    nodes: {
      base: { fbm: { source: 'simplex', octaves: 7, frequency: 4e-4, seed: 3 } },
      ridges: { ridged: { source: 'simplex', octaves: 7, frequency: 3e-3, seed: 4 } },
      h: { add: ['base', { multiply: ['ridges', 0.2] }] },
    },
  })
})

afterAll(() => {
  TerrainDebug.mode = 0
  gpu?.destroy()
})

const W = 160
const H = 120
const FOV = 60

describe('no cracks between levels (spec 0043)', () => {
  it('shows no background through 2:1 edges with skirts off, in five views', {
    timeout: timeout(240_000),
  }, async () => {
    const radius = 6.371e6
    const p = await planetApp(gpu, {
      radius,
      heightScale: 600,
      height: terrain,
      skirts: false,
      width: W,
      heightPx: H,
      fovY: FOV,
      clearColor: [0, 0, 0, 1],
    })
    TerrainDebug.mode = 2
    const rt = p.runtime()
    const views = [
      { dir: [0.3, 0.9, 0.3], altitude: 40, look: 12 },
      { dir: [-0.5, 0.2, 0.84], altitude: 300, look: 25 },
      { dir: [0.9, -0.3, 0.2], altitude: 2000, look: 30 },
      { dir: [0.1, -0.2, -0.97], altitude: 15, look: 8 },
      { dir: [0.7, 0.7, 0.14], altitude: 8000, look: 45 },
    ]
    for (const [index, v] of views.entries()) {
      const l = Math.hypot(v.dir[0]!, v.dir[1]!, v.dir[2]!)
      const n = v.dir.map((x) => x / l)
      const ground = heightAt(rt, n[0]!, n[1]!, n[2]!)
      const eye = n.map((x) => x * (radius + Math.max(ground, 0) + 600 + v.altitude))
      // Look down `look` degrees toward a tangent direction.
      const t = [n[2]!, 0, -n[0]!]
      const tl = Math.hypot(t[0]!, t[1]!, t[2]!)
      const down = Math.tan((v.look * Math.PI) / 180)
      const target = eye.map((x, k) => x + t[k]! / tl - n[k]! * down)
      placeCamera(p, eye, target)
      await settleTerrain(p)
      const shot = captureView(p.world, p.view)
      p.app.update(1 / 60)
      const image = await shot
      // Chunks meeting a coarser neighbor lock their edge: count them to know the view has 2:1 edges.
      let edges = 0
      for (let i = 0; i < rt.selection.renderedCount; i++) {
        const node = rt.selection.rendered[i]!
        for (let e = 0; e < 4; e++) if (rt.tree.locks[node * 4 + e] === 1) edges++
      }
      expect(edges).toBeGreaterThan(4)
      // Seam pixels: background inside the planet's silhouette (the lowest surface's sphere).
      const f = target.map((x, k) => x - eye[k]!)
      const fl = Math.hypot(f[0]!, f[1]!, f[2]!)
      const forward = f.map((x) => x / fl)
      const z = forward.map((x) => -x)
      let x = [
        n[1]! * z[2]! - n[2]! * z[1]!,
        n[2]! * z[0]! - n[0]! * z[2]!,
        n[0]! * z[1]! - n[1]! * z[0]!,
      ]
      const xl = Math.hypot(x[0]!, x[1]!, x[2]!)
      x = x.map((c) => c / xl)
      const y = [
        z[1]! * x[2]! - z[2]! * x[1]!,
        z[2]! * x[0]! - z[0]! * x[2]!,
        z[0]! * x[1]! - z[1]! * x[0]!,
      ]
      const ty = Math.tan(((FOV / 2) * Math.PI) / 180)
      const tx = ty * (W / H)
      const r = radius - 600
      let seams = 0
      let inside = 0
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const a = ((px + 0.5) / W) * 2 - 1
          const b = 1 - ((py + 0.5) / H) * 2
          const d = [0, 1, 2].map((k) => forward[k]! + x[k]! * a * tx + y[k]! * b * ty)
          const dl = Math.hypot(d[0]!, d[1]!, d[2]!)
          const bq = (eye[0]! * d[0]! + eye[1]! * d[1]! + eye[2]! * d[2]!) / dl
          const c = eye[0]! ** 2 + eye[1]! ** 2 + eye[2]! ** 2 - r * r
          const disc = bq * bq - c
          if (disc <= r * r * 0.005 || -bq - Math.sqrt(disc) < 0) continue
          inside++
          const o = (py * W + px) * 4
          if (image.data[o]! < 128) seams++
        }
      }
      expect(inside).toBeGreaterThan((W * H) / 3)
      expect(seams, `view ${index}`).toBe(0)
      const golden = compareGolden(here, `cracks-${index}`, image)
      expect(golden.mean).toBeLessThan(1)
    }
    expect(p.world.resource(Gpu).errors).toEqual([])
  })
})
