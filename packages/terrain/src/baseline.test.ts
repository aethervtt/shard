import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { describeRender, Gpu, RenderHealth } from '@aethervtt/shard-render'
import { watchBaseline } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { placeCamera, planetApp } from './test-planet'

// Terrain generates on the GPU with compute, which the baseline tier (0064) doesn't have: there,
// a Planet reports render/feature-unsupported, and the terrain node never runs.

let compat: GpuContext
let hills: NoiseGraph
beforeAll(async () => {
  compat = await createNodeGpuContext({ tier: 'baseline' })
  await loadNoiseKernel()
  hills = await NoiseGraph.create({
    output: 'h',
    nodes: { h: { fbm: { source: 'simplex', octaves: 3, frequency: 4e-4, seed: 1 } } },
  })
})
afterAll(() => compat.destroy())

describe('terrain on the baseline tier (0064)', () => {
  it('reports a Planet as unsupported and runs no compute for it', {
    timeout: 60_000,
  }, async () => {
    const found = watchBaseline(compat)
    const errors = compat.errors.length
    const p = await planetApp(compat, { radius: 4000, heightScale: 300, height: hills })
    placeCamera(p, [0, 0, 14000], [0, 0, 0])
    for (let i = 0; i < 10; i++) p.app.update(1 / 60)
    const health = p.world.resource(RenderHealth)
    const issue = health.issues.find((i) => i.code === 'render/feature-unsupported')
    expect(issue?.ref).toBe('terrain')
    expect(issue?.message).toContain('compute')
    expect(health.state).toBe('degraded')
    const graph = describeRender(p.world) as unknown as {
      perView: Record<string, { order: string[] }>
    }
    expect(p.world.resource(Gpu).tier).toBe('baseline')
    expect(found.computePasses).toBe(0)
    const views = Object.values(graph.perView)
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) expect(v.order).not.toContain('terrain/generate')
    expect(compat.errors.slice(errors)).toEqual([])
    await p.app.dispose()
  })
})
