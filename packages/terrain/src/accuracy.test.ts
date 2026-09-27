import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { CharacterController, CharacterIntent, CharacterState } from '@aethervtt/shard-physics'
import { Gpu, GpuAssetsResource } from '@aethervtt/shard-render'
import { FloatingOrigin, placeInGrid, Transform, worldPosition64 } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildChunk, chunkLayout } from './chunk'
import { collidersOf } from './colliders'
import { keyString } from './cube'
import { heightAt, planetHeightAt } from './heights'
import { createChunkPoints, prepareChunkPoints } from './points'
import { NODE_READY } from './quadtree'
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
      continents: { fbm: { source: 'simplex', octaves: 6, frequency: 2e-6, seed: 1 } },
      hills: { fbm: { source: 'simplex', octaves: 6, frequency: 2e-3, seed: 2 } },
      h: { add: ['continents', { multiply: ['hills', 0.1] }] },
    },
  })
})

// Descents submit frames faster than a software GPU runs them: wait for the queue before destroying.
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
}, timeout(120_000))

async function readBuffer(buffer: GPUBuffer, floats: number, offset = 0): Promise<Float32Array> {
  const read = gpu.device.createBuffer({
    size: floats * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const enc = gpu.device.createCommandEncoder()
  enc.copyBufferToBuffer(buffer, offset, read, 0, floats * 4)
  gpu.device.queue.submit([enc.finish()])
  await read.mapAsync(GPUMapMode.READ)
  const out = new Float32Array(read.getMappedRange().slice(0))
  read.unmap()
  read.destroy()
  return out
}

const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
const mad = (a: number[], b: number[], s: number) => [
  a[0]! + b[0]! * s,
  a[1]! + b[1]! * s,
  a[2]! + b[2]! * s,
]

/** Closest point to p on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: number[], a: number[], b: number[], c: number[]): number[] {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(p, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return mad(a, ab, d1 / (d1 - d3))
  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return mad(a, ac, d2 / (d2 - d6))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return mad(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))
  const denom = 1 / (va + vb + vc)
  return mad(mad(a, ab, vb * denom), ac, vc * denom)
}

describe('CPU and GPU agree (spec 0043)', () => {
  it('GPU chunk heights match CPU heights (and planetHeightAt) within the noise tolerance at 10 000 points', {
    timeout: timeout(120_000),
  }, async () => {
    const radius = 6.371e6
    const heightScale = 600
    const p = await planetApp(gpu, {
      radius,
      heightScale,
      height: terrain,
      width: 96,
      heightPx: 64,
    })
    const rt = p.runtime()
    const n = [0.4, 0.8, -0.44].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const ground = heightAt(rt, n[0]!, n[1]!, n[2]!)
    const eye = n.map((v) => v * (radius + ground + 150))
    placeCamera(
      p,
      eye,
      eye.map((v, k) => v - n[k]! * 3 + (k === 0 ? 1 : 0)),
    )
    await settleTerrain(p)
    const pr = rt.parts.get('render') as PlanetRender
    const assets = p.world.resource(GpuAssetsResource)
    const layout = chunkLayout(33)
    let points = 0
    let worstCpu = 0
    let worstQuery = 0
    // The finest chunks first (the ones near the camera), then coarser.
    const slots = [...pr.slots].sort(
      (a, b) =>
        (b.node < 0 ? -1 : rt.tree.depth[b.node]!) - (a.node < 0 ? -1 : rt.tree.depth[a.node]!),
    )
    for (const slot of slots) {
      if (points >= 10_000) break
      const node = slot.node
      if (
        node < 0 ||
        slot.source !== 0 ||
        slot.gpuNode !== node ||
        !(rt.tree.flags[node]! & NODE_READY)
      )
        continue
      const t = rt.tree
      const spec = {
        face: t.face[node]!,
        depth: t.depth[node]!,
        x: t.x[node]!,
        y: t.y[node]!,
        radius,
        shape: [1, 1, 1],
        heightScale,
        seed: rt.settings!.seed,
        resolution: 33,
        height: terrain,
        climate: undefined,
        morphError: 0,
        skirtDepth: 0,
      }
      const cpu = buildChunk(spec)
      const gm = assets.mesh(slot.mesh)
      // The slot's range of its arena's buffer.
      const tangents = await readBuffer(gm.tangents, layout.surface * 4, gm.baseVertex * 16)
      // Canonical vertex directions (what both kernels sample at), for the gameplay query.
      const pts = prepareChunkPoints(
        spec.face,
        spec.depth,
        spec.x,
        spec.y,
        33,
        radius,
        createChunkPoints(),
      )
      const dirOf = new Float64Array(layout.surface * 3)
      for (let j = 0; j < 33; j++) {
        for (let i = 0; i < 33; i++) {
          const v = layout.index[i + j * 33]!
          const k = i + 1 + (j + 1) * pts.side
          dirOf.set(pts.dirs.subarray(k * 3, k * 3 + 3), v * 3)
        }
      }
      for (let v = 0; v < layout.surface; v++) {
        const g = tangents[v * 4 + 3]!
        const c = cpu.data.tangents![v * 4 + 3]!
        // 0041's contract, in metres: 1e-5 × (1 + |value|) per sample, × the graph's gain.
        const tolerance = 1e-5 * (1 + Math.abs(c / heightScale)) * heightScale
        worstCpu = Math.max(worstCpu, Math.abs(g - c) / tolerance)
        // The gameplay query at the vertex's direction.
        const q = planetHeightAt(p.world, p.planet, dirOf.subarray(v * 3, v * 3 + 3))
        worstQuery = Math.max(worstQuery, Math.abs(g - q) / tolerance)
        points++
      }
    }
    expect(points).toBeGreaterThanOrEqual(10_000)
    expect(worstCpu).toBeLessThanOrEqual(1)
    expect(worstQuery).toBeLessThanOrEqual(1)
    expect(p.world.resource(Gpu).errors).toEqual([])
  })

  it('renders collider chunks from the collider’s own vertices: feet within 1 cm of the visible ground', {
    timeout: timeout(120_000),
  }, async () => {
    const radius = 6.371e6
    const p = await planetApp(gpu, {
      radius,
      heightScale: 600,
      height: terrain,
      physics: true,
      width: 96,
      heightPx: 64,
    })
    const w = p.world
    const rt = p.runtime()
    const n = [-0.3, 0.2, 0.93].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const ground = planetHeightAt(w, p.planet, n)
    const c = w.spawn(
      [CharacterController, { up: 'gravity', radius: 0.35, height: 1.8 }],
      [CharacterIntent, {}],
      [CharacterState, {}],
      Transform,
    )
    placeInGrid(
      w,
      c,
      p.planet,
      n.map((v) => v * (radius + ground + 1.2)),
    )
    // The camera looks at the character from a few metres away; the origin rides with it.
    w.remove(p.camera, FloatingOrigin)
    w.add(c, FloatingOrigin)
    const eye = n.map((v, k) => v * (radius + ground + 3) + (k === 0 ? 4 : 0))
    placeCamera(
      p,
      eye,
      n.map((v) => v * (radius + ground)),
    )
    for (let f = 0; f < 90; f++) {
      p.app.update(1 / 60)
      await gpu.pipelines.whenIdle()
    }
    await settleTerrain(p)
    expect(w.get(c, CharacterState).grounded).toBe(true)
    // The chunk under the character shows the collider chunk's vertices.
    const pr = rt.parts.get('render') as PlanetRender
    const pos = worldPosition64(w, c, new Float64Array(3), p.planet)
    const len = Math.hypot(pos[0]!, pos[1]!, pos[2]!)
    const shown = pr.slots.filter((s) => s.shown && s.source === 1 && s.cpu)
    expect(shown.length).toBeGreaterThan(0)
    // Closest distance from the capsule's bottom sphere to the visible triangles, less its
    // radius: what you see is what it stands on, up to the controller's 1 cm skin.
    const bottom = Array.from(pos, (v) => v - (v / len) * (0.9 - 0.35))
    let gap = Infinity
    const assets = w.resource(GpuAssetsResource)
    for (const slot of shown) {
      const chunk = slot.cpu!
      // The slot's vertex buffers hold the collider's own numbers, bit for bit.
      const gm = assets.mesh(slot.mesh)
      const P = await readBuffer(gm.positions, chunk.collider.positions.length, gm.baseVertex * 12)
      expect(P).toEqual(chunk.collider.positions)
      const m = chunk.mesh
      // The triangles the slot draws (its current index set), skirts excluded.
      const idx = slot.mesh.gpu!.indices
      for (let t = 0; t < idx.length; t += 3) {
        const surface = chunkLayout(33).surface
        if (idx[t]! >= surface || idx[t + 1]! >= surface || idx[t + 2]! >= surface) continue
        const [a, b, c] = [0, 1, 2].map((k) => {
          const v = idx[t + k]!
          return [
            P[v * 3]! + m.center[0]!,
            P[v * 3 + 1]! + m.center[1]!,
            P[v * 3 + 2]! + m.center[2]!,
          ]
        }) as [number[], number[], number[]]
        const q = closestOnTriangle(bottom, a, b, c)
        gap = Math.min(
          gap,
          Math.hypot(q[0]! - bottom[0]!, q[1]! - bottom[1]!, q[2]! - bottom[2]!) - 0.35,
        )
      }
    }
    expect(gap).toBeGreaterThan(-0.002)
    expect(gap).toBeLessThan(0.011)
    // The collider chunk is the one the character stands on.
    expect(collidersOf(rt).chunks.size).toBeGreaterThan(0)
    expect(w.resource(Gpu).errors).toEqual([])
    void keyString
  })
})
