import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Gpu } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildChunk, type ChunkMesh } from './chunk'
import { TerrainBudget } from './components'
import { directionToFace, keyString } from './cube'
import { chunkLayout, lockCode } from './grid-mesh'
import { heightAt } from './heights'
import { morphFactor } from './lod'
import type { PlanetRuntime } from './planet'
import type { PlanetRender } from './render'
import { placeCamera, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
let terrain: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  terrain = await NoiseGraph.create({
    output: 'h',
    nodes: {
      base: { fbm: { source: 'simplex', octaves: 7, frequency: 5e-4, seed: 5 } },
      ridges: { ridged: { source: 'simplex', octaves: 6, frequency: 4e-3, seed: 6 } },
      h: { add: ['base', { multiply: ['ridges', 0.25] }] },
    },
  })
})

// Descents submit frames faster than a software GPU runs them: wait for the queue before destroying.
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
}, timeout(120_000))

/** What was on screen in one frame: rendered nodes with their locks, and the morph camera. */
interface Frame {
  nodes: Map<
    string,
    {
      depth: number
      face: number
      x: number
      y: number
      locks: number[]
      fade: number
      mask: number
    }
  >
  camera: number[]
  splitScale: number
}

function snapshot(rt: PlanetRuntime, pr: PlanetRender): Frame {
  const nodes = new Map<string, Frame['nodes'] extends Map<string, infer V> ? V : never>()
  const t = rt.tree
  for (let i = 0; i < rt.selection.renderedCount; i++) {
    const n = rt.selection.rendered[i]!
    nodes.set(keyString(t.face[n]!, t.depth[n]!, t.x[n]!, t.y[n]!), {
      depth: t.depth[n]!,
      face: t.face[n]!,
      x: t.x[n]!,
      y: t.y[n]!,
      locks: Array.from(t.locks.subarray(n * 4, n * 4 + 4)),
      fade: pr.slots[t.slot[n]!]?.fade ?? 0,
      mask: t.mask[n]!,
    })
  }
  return { nodes, camera: Array.from(pr.view.position), splitScale: pr.camera[3]! }
}

describe('geomorphing (spec 0043)', () => {
  /**
   * The worst screen motion (px) of surface points between frames during a descent from 3 km to
   * 20 m (at most 500 m/s, `slow` times slower), with the planet's vertexPixels.
   */
  async function descentMotion(
    vertexPixels: number,
    slow: number,
    triangles?: number,
  ): Promise<number> {
    const radius = 4000
    const heightScale = 300
    const W = 160
    const H = 120
    const FOV = 60
    const p = await planetApp(gpu, {
      radius,
      heightScale,
      height: terrain,
      width: W,
      heightPx: H,
      fovY: FOV,
      vertexPixels,
    })
    if (triangles !== undefined) p.world.resource(TerrainBudget).triangles = triangles
    const rt = p.runtime()
    const pr = () => rt.parts.get('render') as PlanetRender
    const s = rt.settings!
    const layout = chunkLayout(s.resolution)
    const meshes = new Map<string, ChunkMesh>()
    const meshOf = (key: string, v: { face: number; depth: number; x: number; y: number }) => {
      let m = meshes.get(key)
      if (!m) {
        m = buildChunk({
          ...v,
          radius,
          shape: s.shape,
          heightScale,
          seed: s.seed,
          resolution: s.resolution,
          height: rt.height,
          climate: undefined,
          morphError: v.depth === 0 ? 0 : rt.errors[v.depth]!,
          skirtDepth: 0,
        })
        // Copies: buildChunk shares nothing, but keep them immutable here.
        meshes.set(key, m)
      }
      return m
    }
    /** The rendered surface point in `dir` (planet frame), morphed as the vertex stage does. */
    const surface = (f: Frame, dir: number[], out: number[]): boolean => {
      const uv = new Float64Array(2)
      const face = directionToFace(dir[0]!, dir[1]!, dir[2]!, uv)
      for (let depth = rt.maxDepth; depth >= 0; depth--) {
        const size = 2 ** depth
        const fx = ((uv[0]! + 1) / 2) * size
        const fy = ((uv[1]! + 1) / 2) * size
        const x = Math.min(size - 1, Math.floor(fx))
        const y = Math.min(size - 1, Math.floor(fy))
        const key = keyString(face, depth, x, y)
        const node = f.nodes.get(key)
        if (!node) continue
        const m = meshOf(key, node)
        const n = s.resolution
        const gi = (fx - x) * (n - 1)
        const gj = (fy - y) * (n - 1)
        const i = Math.min(n - 2, Math.floor(gi))
        const j = Math.min(n - 2, Math.floor(gj))
        const corners =
          gi - i >= gj - j
            ? [
                [i, j],
                [i + 1, j],
                [i + 1, j + 1],
              ]
            : [
                [i, j],
                [i + 1, j + 1],
                [i, j + 1],
              ]
        const pts = corners.map(([a, b]) => {
          const v = layout.index[a! + b! * n]!
          const pos = m.data.positions
          const tan = m.data.tangents!
          const px = pos[v * 3]! + m.center[0]!
          const py = pos[v * 3 + 1]! + m.center[1]!
          const pz = pos[v * 3 + 2]! + m.center[2]!
          // As the vertex stage does: distance, then edge locks, center-line locks, and the fade.
          const split = (node.depth === 0 ? 0 : rt.errors[node.depth]!) * f.splitScale
          const d = Math.hypot(px - f.camera[0]!, py - f.camera[1]!, pz - f.camera[2]!)
          let t = morphFactor(d, split)
          const code = lockCode(a!, b!, n, v, layout.ring)
          if (code >= 0 && code < 4) {
            const lock = node.locks[code]!
            if (lock >= 0) t = lock
          } else if (code >= 4 && node.mask !== 15) {
            const [qa, qb] =
              code === 5 ? [2, 3] : code === 6 ? [0, 2] : code === 7 ? [1, 3] : [0, 1]
            const differ = ((node.mask >> qa!) & 1) !== ((node.mask >> qb!) & 1)
            t = differ || (code === 8 && node.mask !== 0) ? 0 : Math.max(t, node.fade)
          } else t = Math.max(t, node.fade)
          return [px + tan[v * 4]! * t, py + tan[v * 4 + 1]! * t, pz + tan[v * 4 + 2]! * t]
        })
        // The ray from the planet's center along dir, against the triangle's plane.
        const [a, b, c] = pts as [number[], number[], number[]]
        const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
        const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
        const nrm = [
          e1[1]! * e2[2]! - e1[2]! * e2[1]!,
          e1[2]! * e2[0]! - e1[0]! * e2[2]!,
          e1[0]! * e2[1]! - e1[1]! * e2[0]!,
        ]
        const denom = nrm[0]! * dir[0]! + nrm[1]! * dir[1]! + nrm[2]! * dir[2]!
        const tt = (nrm[0]! * a[0]! + nrm[1]! * a[1]! + nrm[2]! * a[2]!) / denom
        out[0] = dir[0]! * tt
        out[1] = dir[1]! * tt
        out[2] = dir[2]! * tt
        return true
      }
      return false
    }
    // Descend over a point from 3 km to 20 m, at most 500 m/s, looking 35° down toward the horizon.
    const n0 = [0.2, 0.95, 0.24].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const ground = heightAt(rt, n0[0]!, n0[1]!, n0[2]!)
    const east = [n0[2]!, 0, -n0[0]!]
    const el = Math.hypot(east[0]!, east[1]!, east[2]!)
    const e = east.map((v) => v / el)
    const north = [
      n0[1]! * e[2]! - n0[2]! * e[1]!,
      n0[2]! * e[0]! - n0[0]! * e[2]!,
      n0[0]! * e[1]! - n0[1]! * e[0]!,
    ]
    const down = Math.tan((35 * Math.PI) / 180)
    const frames = 480 * slow
    let altitude = 3000
    const ratio = (20 / 3000) ** (1 / frames)
    const eyeAt = (a: number) => n0.map((v) => v * (radius + ground + a))
    const aim = (eye: number[]) => eye.map((v, k) => v + north[k]! - n0[k]! * down)
    placeCamera(p, eyeAt(altitude), aim(eyeAt(altitude)))
    await settleTerrain(p)
    let previous = snapshot(rt, pr())
    let worst = 0
    let compared = 0
    const ty = Math.tan(((FOV / 2) * Math.PI) / 180)
    const tx = ty * (W / H)
    const a = [0, 0, 0]
    const b = [0, 0, 0]
    for (let f = 0; f < frames; f++) {
      altitude = Math.max(altitude * ratio, altitude - 500 / slow / 60)
      const eye = eyeAt(altitude)
      const target = aim(eye)
      placeCamera(p, eye, target)
      p.app.update(1 / 60)
      await gpu.pipelines.whenIdle()
      const current = snapshot(rt, pr())
      // Camera basis (as placeCamera builds it) and a grid of surface points in view.
      const fw = target.map((v, k) => v - eye[k]!)
      const fl = Math.hypot(fw[0]!, fw[1]!, fw[2]!)
      const forward = fw.map((v) => v / fl)
      const z = forward.map((v) => -v)
      let x = [
        n0[1]! * z[2]! - n0[2]! * z[1]!,
        n0[2]! * z[0]! - n0[0]! * z[2]!,
        n0[0]! * z[1]! - n0[1]! * z[0]!,
      ]
      const xl = Math.hypot(x[0]!, x[1]!, x[2]!)
      x = x.map((v) => v / xl)
      const y = [
        z[1]! * x[2]! - z[2]! * x[1]!,
        z[2]! * x[0]! - z[0]! * x[2]!,
        z[0]! * x[1]! - z[1]! * x[0]!,
      ]
      const project = (q: number[]) => {
        const r = [q[0]! - eye[0]!, q[1]! - eye[1]!, q[2]! - eye[2]!]
        const depth = r[0]! * forward[0]! + r[1]! * forward[1]! + r[2]! * forward[2]!
        const sx = (r[0]! * x[0]! + r[1]! * x[1]! + r[2]! * x[2]!) / depth / tx
        const sy = (r[0]! * y[0]! + r[1]! * y[1]! + r[2]! * y[2]!) / depth / ty
        return [((sx + 1) / 2) * W, ((1 - sy) / 2) * H, depth]
      }
      for (let py = 4; py < H; py += 8) {
        for (let px = 4; px < W; px += 8) {
          const sa = ((px + 0.5) / W) * 2 - 1
          const sb = 1 - ((py + 0.5) / H) * 2
          const d = [0, 1, 2].map((k) => forward[k]! + x[k]! * sa * tx + y[k]! * sb * ty)
          const dl = Math.hypot(d[0]!, d[1]!, d[2]!)
          const dir = d.map((v) => v / dl)
          // Where the ray meets the sphere at the terrain's mean radius: a surface direction.
          const bq = eye[0]! * dir[0]! + eye[1]! * dir[1]! + eye[2]! * dir[2]!
          const c = eye[0]! ** 2 + eye[1]! ** 2 + eye[2]! ** 2 - radius * radius
          const disc = bq * bq - c
          if (disc <= 0) continue
          const hit = [0, 1, 2].map((k) => eye[k]! + dir[k]! * (-bq - Math.sqrt(disc)))
          const hl = Math.hypot(hit[0]!, hit[1]!, hit[2]!)
          const sdir = hit.map((v) => v / hl)
          if (!surface(previous, sdir, a) || !surface(current, sdir, b)) continue
          const pa = project(a)
          const pb = project(b)
          if (pa[2]! <= 1 || pb[2]! <= 1) continue
          compared++
          worst = Math.max(worst, Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!))
        }
      }
      previous = current
    }
    expect(p.world.resource(Gpu).errors).toEqual([])
    expect(compared).toBeGreaterThan(frames * 50)
    return worst
  }

  it('never moves the surface more than a pixel between frames during a descent, uncapped', {
    timeout: timeout(240_000),
  }, async () => {
    // The LOD machinery alone: no vertex cap, and no triangle budget steering the detail.
    expect(await descentMotion(0, 1, 0)).toBeLessThanOrEqual(1)
  })

  it('with vertexPixels, morphs continuously: a few px a frame at any speed, never a pop', {
    timeout: timeout(480_000),
  }, async () => {
    // Capped detail splits closer, so each split's parent-to-child displacement is larger and the
    // new chunk's 0.5 s fade paces it: at most 1/30 of it a frame. A pop would move the whole
    // displacement at once, tens of pixels here. Slower descents don't move faster.
    const fast = await descentMotion(4, 1)
    const slow = await descentMotion(4, 2)
    expect(fast).toBeLessThan(6)
    expect(slow).toBeLessThan(6)
    expect(slow).toBeLessThan(fast * 1.25)
  })
})
