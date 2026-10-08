import { defineSystem, Last } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { App } from '@aethervtt/shard-runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type NodeDescriptor, VIEW_TARGET } from './graph'
import { Gpu, Graph, RenderSet, renderPlugin, Views } from './plugin'
import { OffscreenTarget } from './target'

// Render nodes on the same attachments share one render pass (tile-based GPUs keep the tile on chip
// between them); anything that needs the attachments stored first begins its own.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu?.destroy())

/** Runs one frame of `nodes` (in order) and returns the render pass each one drew in. */
async function passesOf(nodes: [string, Omit<NodeDescriptor, 'run' | 'kind'>][]) {
  const target = new OffscreenTarget(gpu, { label: 'passes', width: 8, height: 8 })
  const app = new App().addPlugin(renderPlugin({ gpu, windowView: false }))
  app.addSystems(
    Last,
    defineSystem({
      name: 'test-passes/view',
      run: (_, world) =>
        world.resource(Views).list.push({ name: 'main', target, order: 0, data: {} }),
    }).inSet(RenderSet.Extract),
  )
  await app.init()
  const graph = app.world.resource(Graph)
  graph.declare({ name: 'color', format: 'rgba8unorm' })
  graph.declare({ name: 'depth', format: 'depth32float' })
  const seen = new Map<string, GPURenderPassEncoder | undefined>()
  for (const [i, [name, node]] of nodes.entries()) {
    graph.addNode(name, {
      kind: 'render',
      phase: i,
      ...node,
      run: (ctx) => void seen.set(name, ctx.renderPass),
    })
  }
  app.update(1 / 60)
  await gpu.device.queue.onSubmittedWorkDone()
  expect(app.world.resource(Gpu).errors).toEqual([])
  await app.dispose()
  target.destroy()
  // Every node ran, in some pass: a check of 'not shared' means something.
  expect([...seen.keys()].sort()).toEqual(nodes.map(([n]) => n).sort())
  for (const pass of seen.values()) expect(pass).toBeDefined()
  return (a: string, b: string) => seen.get(a) === seen.get(b)
}

const out = { writes: [VIEW_TARGET], color: [{ resource: VIEW_TARGET, clear: [0, 0, 0, 1] }] }
const draws = (clear?: number): Omit<NodeDescriptor, 'run' | 'kind'> => ({
  writes: ['color', 'depth'],
  color: [{ resource: 'color', clear: clear === undefined ? undefined : [0, 0, 0, 1] }],
  depth: { resource: 'depth', clear },
})

describe('render passes', () => {
  it('runs consecutive render nodes on the same attachments in one pass', async () => {
    const same = await passesOf([
      ['opaque', draws(0)],
      ['sky', { ...draws(), depth: { resource: 'depth', readOnly: true } }],
      ['present', { ...out, reads: ['color'] }],
    ])
    expect(same('opaque', 'sky')).toBe(true)
    // The next node samples the color: it needs it stored, in a pass of its own.
    expect(same('sky', 'present')).toBe(false)
  })

  it('begins a new pass for a node that clears, samples an attachment, or writes read-only depth', async () => {
    const same = await passesOf([
      ['a', draws(0)],
      ['clears', draws(0)],
      ['samples', { ...draws(), reads: ['depth'], depth: { resource: 'depth', readOnly: true } }],
      ['writes', draws()],
      ['present', { ...out, reads: ['color'] }],
    ])
    expect(same('a', 'clears')).toBe(false)
    expect(same('clears', 'samples')).toBe(false)
    // The pass `samples` began binds depth read-only: a node that writes it needs its own.
    expect(same('samples', 'writes')).toBe(false)
  })

  it('keeps a node that asks for its own pass (its GPU time is read on its own) apart', async () => {
    const same = await passesOf([
      ['opaque', draws(0)],
      ['foliage', { ...draws(), ownPass: true }],
      ['sky', { ...draws(), depth: { resource: 'depth', readOnly: true } }],
      ['present', { ...out, reads: ['color'] }],
    ])
    expect(same('opaque', 'foliage')).toBe(false)
    expect(same('foliage', 'sky')).toBe(false)
  })
})
