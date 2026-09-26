import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@shard/noise'
import { captureView, DebugOverlays, GizmoStore, Gpu } from '@shard/render'
import { GlobalTransform, placeInGrid, Transform } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collidersOf } from './colliders'
import { TerrainAnchor } from './components'
import { heightAt } from './heights'
import { terrainCollidersOverlay } from './overlays'
import type { PlanetRender } from './render'
import { holes, placeCamera, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
const W = 64
const H = 48
const FOV = 60
const R = 60_000
const HEIGHT = 800

const graph = (ridges: number) => ({
  output: 'h',
  nodes: {
    base: { fbm: { source: 'simplex', octaves: 6, frequency: 4e-5, seed: 1 } },
    ridges: { ridged: { source: 'simplex', octaves: 6, frequency: 1e-3, seed: 2 } },
    h: { add: ['base', { multiply: ['ridges', ridges] }] },
  },
})

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
})

afterAll(() => gpu?.destroy())

describe('hot reload (spec 0043)', () => {
  it('regenerates visible chunks within 1 s of a height graph edit, without holes, and rebuilds colliders', async () => {
    const height = await NoiseGraph.create(graph(0.1))
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: HEIGHT,
      height,
      physics: true,
      width: W,
      heightPx: H,
      fovY: FOV,
    })
    const w = p.world
    const rt = p.runtime()
    const n = [0.4, 0.8, 0.45].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const east = [n[2]!, 0, -n[0]!].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const ground = heightAt(rt, n[0]!, n[1]!, n[2]!)
    // Colliders live around an anchor on the ground; the camera looks at it from above.
    const anchor = w.spawn([TerrainAnchor, { radius: 50 }], Transform)
    placeInGrid(
      w,
      anchor,
      p.planet,
      n.map((v) => v * (R + ground)),
    )
    const eye = n.map((v, k) => v * (R + ground + 1500) - east[k]! * 1500)
    placeCamera(
      p,
      eye,
      n.map((v) => v * (R + ground)),
    )
    await settleTerrain(p)
    const before = rt.version
    const colliders = collidersOf(rt)
    expect(colliders.chunks.size).toBeGreaterThan(0)
    // What the asset server does when the .noise.json changes: the graph updates in place.
    height.copyFrom(await NoiseGraph.create(graph(0.6)))
    const m = w.get(p.camera, GlobalTransform).matrix
    const right = [m[0]!, m[4]!, m[8]!]
    const up = [m[1]!, m[5]!, m[9]!]
    const forward = [-m[2]!, -m[6]!, -m[10]!]
    const pr = rt.parts.get('render') as PlanetRender
    let done = -1
    let seen = 0
    for (let f = 0; f < 90 && done < 0; f++) {
      const shot = captureView(w, p.view)
      p.app.update(1 / 60)
      await gpu.pipelines.whenIdle()
      const image = await shot
      seen += holes(image.data, W, H, FOV, eye, right, up, forward, R - HEIGHT)
      if (rt.version === before) continue
      // Every drawn chunk holds the new contents: a GPU chunk at this version, or a collider chunk.
      // (The new graph is rougher, so finer chunks keep arriving after that.)
      const stale = pr.slots.filter((s) => s.shown && s.gpuVersion !== rt.version)
      if (stale.length === 0) done = f
    }
    expect(rt.version).toBe(before + 1)
    expect(seen).toBe(0)
    expect(done).toBeGreaterThanOrEqual(0)
    expect(done).toBeLessThan(60)
    // Colliders: rebuilt for the new version, with vertices on the new surface.
    for (const chunk of colliders.chunks.values()) {
      if (chunk.entity < 0) continue
      expect(chunk.version).toBe(rt.version)
      const P = chunk.mesh.data.positions
      const x = P[0]! + chunk.mesh.center[0]!
      const y = P[1]! + chunk.mesh.center[1]!
      const z = P[2]! + chunk.mesh.center[2]!
      const l = Math.hypot(x, y, z)
      expect(Math.abs(l - R - heightAt(rt, x / l, y / l, z / l))).toBeLessThan(1e-3 * HEIGHT)
    }
    // The overlays: collider borders and anchors as gizmos, LOD shading through the material.
    const g = new GizmoStore()
    terrainCollidersOverlay.draw(w, g, () => true)
    expect(g.frame.lineCount).toBeGreaterThan(colliders.chunks.size * 4)
    w.resource(DebugOverlays).extra['terrain-lod'] = true
    p.app.update(1 / 60)
    expect((pr.material.value as Record<string, number[]>).debugParams![0]).toBe(3)
    w.resource(DebugOverlays).extra['terrain-lod'] = false
    p.app.update(1 / 60)
    expect((pr.material.value as Record<string, number[]>).debugParams![0]).toBe(0)
    expect(w.resource(Gpu).errors).toEqual([])
  }, 120_000)
})
