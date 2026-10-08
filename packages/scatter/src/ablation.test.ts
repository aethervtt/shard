import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { Gpu, Graph, setOverlays } from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { planetHeightAt } from '@aethervtt/shard-terrain'
import { capture, placeCamera, settleTerrain, sunOver } from '@aethervtt/shard-terrain/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Wind } from './foliage'
import { scatterPlanet, settleScatter, TEST_RADIUS } from './testing'

// 0075: ablating any node of the scatter page's graph raises no validation error, and the frames
// after match the frames before. The graph is the playground #scatter page's, headless: the test
// planet's forest with props, grass in its own foliage/draw pass, a shadowed sun, 4× MSAA, render
// scale 0.5 upscaled, and the perf overlay's gizmos.

const roots: string[] = []
let gpu: GpuContext

beforeAll(async () => {
  await loadNoiseKernel()
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe("ablating the scatter page's passes (0075)", () => {
  it('raises no validation error for any node, foliage/draw included, and frames after match frames before', {
    timeout: timeout(300_000),
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-scatter-ablation-'))
    roots.push(root)
    const p = await scatterPlanet(gpu, createNodePlatform({ root, logTo: () => {} }), {
      msaa: 4,
      renderScale: 0.5,
    })
    const w = p.world
    // Still: sway follows the clock.
    w.resource(Wind).strength = 0
    const d = [Math.cos(18 * 0.157) * 0.3, 0.9, Math.sin(18 * 0.157) * 0.3]
    const l = Math.hypot(d[0]!, d[1]!, d[2]!)
    const n = d.map((x) => x / l)
    const eye = n.map((x) => x * (TEST_RADIUS + planetHeightAt(w, p.planet, n) + 1.7))
    const t = [n[2]!, 0, -n[0]!]
    placeCamera(
      p,
      eye,
      eye.map((x, k) => x + t[k]! * 20 - n[k]! * 2),
    )
    sunOver(p, n, 40)
    await settleTerrain(p)
    await settleScatter(p)
    await settleTerrain(p)
    await settle(p.app)
    const before = await capture(p)
    // The perf overlay's gizmos while passes are ablated (its numbers change, so not in the shots).
    setOverlays(w, { perf: true })
    p.app.update(1 / 60)
    const graph = w.resource(Graph)
    const ran = (graph.describe().perView as Record<string, { order: string[] }>)[p.view]!.order
    expect(ran).toEqual(
      expect.arrayContaining([
        'forward-opaque',
        'foliage/draw',
        'tonemap',
        'post/upscale',
        'gizmos',
      ]),
    )
    for (const name of graph.nodeNames()) {
      graph.ablate([name])
      for (let i = 0; i < 2; i++) p.app.update(1 / 60)
      await gpu.device.queue.onSubmittedWorkDone()
      expect(w.resource(Gpu).errors, `ablating ${name}`).toEqual([])
    }
    graph.ablate(ran)
    p.app.update(1 / 60)
    await gpu.device.queue.onSubmittedWorkDone()
    expect(w.resource(Gpu).errors).toEqual([])
    graph.ablate([])
    setOverlays(w, { perf: false })
    await settle(p.app)
    const after = await capture(p)
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(true)
    await p.app.dispose()
  })
})
