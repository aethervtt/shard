import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  Camera3d,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { pixel, renderView } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { cardDefinition } from './definition'
import { defineCardFinish } from './finishes'
import { cardsPlugin } from './plugin'
import { Cards } from './table'
import { prepareCardTextures } from './textures'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu?.destroy())
const red = defineCardFinish('cards-test/Red', {
  surface: 'return vec3f(1.0, 0.0, 0.0);',
  response: 'return vec2f(0.0, 1.0);',
})
const blue = defineCardFinish('cards-test/Blue', {
  surface: 'return vec3f(0.0, 0.0, 1.0);',
  response: 'return current;',
})
async function scene(lighting: 'pbr' | 'unlit' = 'pbr') {
  const art = prepareCardTextures([], { width: 2, height: 2 })
  const masks = prepareCardTextures(
    [
      {
        id: 'gray',
        image: { width: 2, height: 2, kind: 'u8', data: new Uint8Array(16).fill(128) },
      },
    ],
    { width: 2, height: 2, mask: true },
  )
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin(),
    cardsPlugin({ art, masks, lighting, finishes: [red, blue] }),
  )
  await app.init()
  const world = app.world
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { width: 64, height: 64, label: 'cards-test' }))
  const camera = world.spawn(
    [
      Camera3d,
      {
        target,
        projection: 'orthographic',
        orthoHeight: 0.11,
        near: 0.001,
        far: 1,
        clearColor: [0, 0, 0, 1],
      },
    ],
    [Transform, { translation: [0, 0, 0.5] }],
    [Exposure, { ev100: 0 }],
    [Tonemapping, { curve: 'none', dither: false }],
  )
  const table = world.resource(Cards)
  const sample = async () => pixel(await renderView(app, `camera:${camera}`), 32, 32).slice(0, 3)
  return { app, world, table, sample }
}

it(
  'defaults to PBR, receives scene light and writes no emission from foil',
  async () => {
    const { app, world, table, sample } = await scene()
    try {
      table.spawn(
        cardDefinition({
          front: {
            background: [0.25, 0.25, 0.25, 1],
            finishes: [{ family: red.name, strength: 1 }],
          },
        }),
        'lit',
      )
      expect(table.material.type.extends).toBe('standard')
      expect(await sample()).toEqual([0, 0, 0])
      const light = world.spawn([DirectionalLight, { illuminance: 2 }], Transform)
      const on = await sample()
      expect(on[0]).toBeGreaterThan(80)
      expect(on[0]).toBeGreaterThan(on[1]! * 3)
      world.set(light, DirectionalLight, { illuminance: 0 })
      expect(await sample()).toEqual([0, 0, 0])
      expect(world.resource(LogResource).tail(10, 'error')).toEqual([])
    } finally {
      await app.dispose()
    }
  },
  timeout(15_000),
)

it(
  'composes grayscale layers in order, disables them independently, and isolates the back',
  async () => {
    const { app, world, table, sample } = await scene('unlit')
    try {
      table.configure({ gloss: 0, luminance: 1 })
      const card = table.spawn(
        cardDefinition({
          front: {
            background: [0, 0, 0, 1],
            finishes: [
              { family: red.name, strength: 1, mask: { texture: { path: 'gray' } } },
              { family: blue.name, strength: 0.5 },
            ],
          },
          back: { background: [0, 0.5, 0, 1] },
        }),
        'layers',
      )
      const both = await sample()
      expect(both[2]).toBeGreaterThan(both[0]!)
      expect(both[0]).toBeGreaterThan(80)
      expect(both[1]).toBe(0)
      card.setStrength(0, 1)
      const first = await sample()
      expect(first[0]).toBeGreaterThan(both[0]!)
      expect(first[2]).toBe(0)
      card.setStrength(0, 0)
      expect(await sample()).toEqual([0, 0, 0])
      card.flip(0)
      const back = await sample()
      expect(back[1]).toBeGreaterThan(100)
      expect(back[0]).toBe(0)
      expect(back[2]).toBe(0)
      expect(world.resource(LogResource).tail(10, 'error')).toEqual([])
    } finally {
      await app.dispose()
    }
  },
  timeout(15_000),
)
