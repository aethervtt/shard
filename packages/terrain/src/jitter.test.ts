import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quat } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Cameras, captureView, Gpu } from '@aethervtt/shard-render'
import { compareGolden } from '@aethervtt/shard-render/testing'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildChunk, chunkLayout } from './chunk'
import { heightAt } from './heights'
import type { PlanetRender } from './render'
import { placeCamera, planetApp, settleTerrain, sunOver } from './test-planet'

const here = dirname(fileURLToPath(import.meta.url))
let gpu: GpuContext
let fine: NoiseGraph
/** The 0.5 m octave's share of heightScale (6 cm at 600 m). */
const PEBBLES = 1e-4

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  // Continents, hills, and a 0.5 m octave (6 cm tall at heightScale 600).
  fine = await NoiseGraph.create({
    output: 'h',
    nodes: {
      continents: { fbm: { source: 'simplex', octaves: 5, frequency: 2e-6, seed: 1 } },
      hills: { fbm: { source: 'simplex', octaves: 4, frequency: 1e-3, seed: 2 } },
      pebbles: { simplex: { frequency: 2, seed: 3 } },
      h: { add: ['continents', { multiply: ['hills', 0.05] }, { multiply: ['pebbles', PEBBLES] }] },
    },
  })
})

afterAll(() => gpu?.destroy())

const R = 6.371e6

describe('precision on an Earth-sized planet (spec 0043)', () => {
  it('keeps vertices still on screen (0.01 px over 600 frames) while the planet spins under a standing camera', async () => {
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: 600,
      height: fine,
      width: 160,
      heightPx: 120,
    })
    const w = p.world
    const rt = p.runtime()
    const n = [0.5, 0.7, -0.51].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const ground = heightAt(rt, n[0]!, n[1]!, n[2]!)
    const eye = n.map((v) => v * (R + ground + 1.7))
    placeCamera(
      p,
      eye,
      eye.map((v, k) => v - n[k]! * 0.8 + (k === 2 ? 1 : 0)),
    )
    await settleTerrain(p)
    const pr = rt.parts.get('render') as PlanetRender
    // Every visible chunk's vertices (CPU copies: the same numbers the GPU holds).
    const layout = chunkLayout(33)
    const chunks = pr.slots
      .filter((s) => s.shown && s.node >= 0)
      .slice(0, 40)
      .map((s) => {
        const t = rt.tree
        const m = buildChunk({
          face: t.face[s.node]!,
          depth: t.depth[s.node]!,
          x: t.x[s.node]!,
          y: t.y[s.node]!,
          radius: R,
          shape: [1, 1, 1],
          heightScale: 600,
          seed: rt.settings!.seed,
          resolution: 33,
          height: fine,
          climate: undefined,
          morphError: 0,
          skirtDepth: 0,
        })
        return { entity: s.entity, positions: m.data.positions }
      })
    expect(chunks.length).toBeGreaterThan(4)
    const f = Math.fround
    const screen = (): Float64Array => {
      const cam = w.resource(Cameras).get(p.camera)!
      const vp = cam.viewProj
      const out: number[] = []
      for (const c of chunks) {
        const m = w.get(c.entity, GlobalTransform).matrix
        for (let v = 0; v < layout.surface; v += 7) {
          const x = c.positions[v * 3]!
          const y = c.positions[v * 3 + 1]!
          const z = c.positions[v * 3 + 2]!
          // The vertex stage in f32: instance rows, then the view-projection.
          const wx = f(f(f(m[0]! * x) + f(m[1]! * y)) + f(f(m[2]! * z) + m[3]!))
          const wy = f(f(f(m[4]! * x) + f(m[5]! * y)) + f(f(m[6]! * z) + m[7]!))
          const wz = f(f(f(m[8]! * x) + f(m[9]! * y)) + f(f(m[10]! * z) + m[11]!))
          const cx = f(vp[0]! * wx + vp[4]! * wy + vp[8]! * wz + vp[12]!)
          const cy = f(vp[1]! * wx + vp[5]! * wy + vp[9]! * wz + vp[13]!)
          const cw = f(vp[3]! * wx + vp[7]! * wy + vp[11]! * wz + vp[15]!)
          if (cw <= 0) continue
          out.push(((cx / cw + 1) / 2) * cam.width, ((1 - cy / cw) / 2) * cam.height)
        }
      }
      return Float64Array.from(out)
    }
    const first = screen()
    let worst = 0
    let spin = 0
    for (let frame = 0; frame < 600; frame++) {
      // The planet turns once a day, a little each frame; the camera stands on it.
      spin += ((2 * Math.PI) / 86400) * (1 / 60) * 1000
      w.set(p.planet, Transform, {
        rotation: quat.fromAxisAngle([0, 0, 0, 1], [0, 1, 0], spin) as [
          number,
          number,
          number,
          number,
        ],
      })
      p.app.update(1 / 60)
      const now = screen()
      expect(now.length).toBe(first.length)
      for (let i = 0; i < now.length; i++) worst = Math.max(worst, Math.abs(now[i]! - first[i]!))
    }
    expect(first.length).toBeGreaterThan(1000)
    expect(worst).toBeLessThanOrEqual(0.01)
    expect(w.resource(Gpu).errors).toEqual([])
  }, 120_000)

  it('renders a 0.5 m noise octave as smooth bumps, not steps (golden)', async () => {
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: 600,
      height: fine,
      minSpacing: 0.05,
      width: 192,
      heightPx: 128,
      fovY: 50,
    })
    const rt = p.runtime()
    const n = [-0.2, 0.3, 0.93].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const ground = heightAt(rt, n[0]!, n[1]!, n[2]!)
    // The height along a 2 m line at 1 cm: a smooth curve (steps would be jumps between samples).
    const east = [n[2]!, 0, -n[0]!]
    const el = Math.hypot(east[0]!, east[1]!, east[2]!)
    let worstStep = 0
    let previous = ground
    for (let i = 1; i <= 200; i++) {
      const d = n.map((v, k) => v * R + (east[k]! / el) * i * 0.01)
      const dl = Math.hypot(d[0]!, d[1]!, d[2]!)
      const h = heightAt(rt, d[0]! / dl, d[1]! / dl, d[2]! / dl)
      worstStep = Math.max(worstStep, Math.abs(h - previous))
      previous = h
    }
    // The octave's steepest slope over a centimetre (plus the hills'); a step would be several cm.
    expect(worstStep).toBeLessThan(1.5 * (PEBBLES * 600 * ((2 * Math.PI) / 0.5) * 0.01 + 0.002))
    const eye = n.map((v) => v * (R + ground + 1.2))
    sunOver(p, n, 25)
    placeCamera(
      p,
      eye,
      eye.map((v, k) => v - n[k]! * 1 + (east[k]! / el) * 1.2),
    )
    await settleTerrain(p, 600)
    p.app.update(1 / 60)
    const shot = captureView(p.world, p.view)
    p.app.update(1 / 60)
    const image = await shot
    expect(p.world.resource(Gpu).errors).toEqual([])
    const golden = compareGolden(here, 'half-metre-octave', image)
    expect(golden.mean).toBeLessThan(2)
    // Deep enough near the camera to show the octave: vertices a few centimetres apart.
    let deepest = 0
    for (let i = 0; i < rt.selection.renderedCount; i++)
      deepest = Math.max(deepest, rt.tree.depth[rt.selection.rendered[i]!]!)
    expect(rt.spacing(deepest)).toBeLessThan(0.1)
  }, 120_000)
})
