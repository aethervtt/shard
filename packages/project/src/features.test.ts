import { dicePlugin } from '@aethervtt/shard-dice'
import { fogPlugin } from '@aethervtt/shard-fog'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { particlesPlugin } from '@aethervtt/shard-particles'
import {
  forwardPlugin,
  Graph,
  OffscreenTarget,
  RenderFeatures,
  renderPlugin,
} from '@aethervtt/shard-render'
import { materialNoisePlugin } from '@aethervtt/shard-render/noise'
import { App } from '@aethervtt/shard-runtime'
import { spritePlugin } from '@aethervtt/shard-sprite'
import { terrainPlugin } from '@aethervtt/shard-terrain'
import { textPlugin } from '@aethervtt/shard-text'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { uiPlugin } from '@aethervtt/shard-ui'
import { describe, expect, it } from 'vitest'

// The render feature registry (0064): with every render plugin installed, each graph node belongs
// to exactly one registered feature, and every feature says what it does on the baseline tier.

describe('render features', () => {
  it('every graph node belongs to one feature, and every feature declares a baseline strategy', async () => {
    const gpu = await createNodeGpuContext()
    try {
      const app = new App().addPlugin(
        TransformPlugin,
        renderPlugin({
          gpu,
          target: new OffscreenTarget(gpu, { label: 'features', width: 4, height: 4 }),
        }),
        forwardPlugin(),
        materialNoisePlugin,
        spritePlugin,
        textPlugin,
        uiPlugin,
        particlesPlugin,
        terrainPlugin(),
        dicePlugin(),
        fogPlugin,
      )
      await app.init()
      const features = [...app.world.resource(RenderFeatures).values()]
      const owners = new Map<string, string[]>()
      for (const f of features) {
        expect(f.baseline === 'unsupported' || f.baseline.strategy.length > 0, f.name).toBe(true)
        for (const node of f.nodes) owners.set(node, [...(owners.get(node) ?? []), f.name])
      }
      const nodes = app.world.resource(Graph).nodeNames()
      const orphans = nodes.filter((n) => !owners.has(n))
      expect(orphans).toEqual([])
      for (const [node, names] of owners) {
        expect(names, node).toHaveLength(1)
        expect(nodes, `${names[0]} lists ${node}, which isn't in the graph`).toContain(node)
      }
      // Compute-only features say so.
      expect(features.find((f) => f.name === 'terrain')?.baseline).toBe('unsupported')
      await app.dispose()
    } finally {
      gpu.destroy()
    }
  })
})
