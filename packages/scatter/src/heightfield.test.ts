import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import type { Entity, World } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import { Camera3d } from '@aethervtt/shard-render'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { mainNoise, pageHeight, Terrain } from '@aethervtt/shard-terrain'
import {
  heightfieldApp,
  untilStreaming,
  VALLEY_HILLS,
  valleySource,
} from '@aethervtt/shard-terrain/testing'
import { placeInGrid, Transform, worldPosition64 } from '@aethervtt/shard-transform'
import { afterAll, describe, expect, it } from 'vitest'
import { Prop } from './components'
import { scatterPlugin } from './plugin'
import { Scatter } from './runtime'
import { ScatterSet } from './set'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const SET = {
  rules: [
    {
      name: 'boulders',
      items: [{ generator: 'shard/Rock', params: { detail: 2 }, variants: 3 }],
      density: 0.004,
      spacing: 6,
      align: 0.7,
      scale: [0.6, 1.6],
      sink: 0.2,
      range: 250,
    },
  ],
}

function props(w: World): Entity[] {
  const out: Entity[] = []
  for (const table of w.query({ with: [Prop] }).tables)
    for (let row = 0; row < table.count; row++) out.push(table.entities[row]!)
  return out
}

describe('scatter on a heightfield (0045, 0071)', () => {
  it(
    'places props on the terrain’s own triangles around the camera (Terrain.scatter)',
    async () => {
      await loadNoiseKernel()
      const hills = await NoiseGraph.create(VALLEY_HILLS)
      const p = await heightfieldApp(undefined, {
        ...valleySource(),
        noise: { hills },
        extra: [ScenePlugin, procgenPlugin(), scatterPlugin()],
      })
      const root = mkdtempSync(join(tmpdir(), 'shard-scatter-'))
      roots.push(root)
      await assetServer(p.world)
        .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
        .scan()
      await untilStreaming(p)
      const w = p.world
      const set = w.initResource(ScatterSet.store).add(ScatterSet.deserialize(SET as never), 'set')
      w.set(p.terrain, Terrain, { ...w.get(p.terrain, Terrain), scatter: set })
      const camera = w.spawn([Camera3d, {}], Transform)
      placeInGrid(w, camera, p.terrain, [900, 200, 900])
      let quiet = 0
      for (let i = 0; i < 900 && quiet < 3; i++) {
        p.app.update(1 / 60)
        await new Promise((r) => setTimeout(r, 1))
        let busy = props(w).length === 0
        for (const ss of w.resource(Scatter).surfaces.values())
          if (!ss.ready || ss.spawnedLast > 0 || ss.despawnedLast > 0) busy = true
        quiet = busy ? 0 : quiet + 1
      }
      const all = props(w)
      expect(all.length).toBeGreaterThan(50)
      const rt = p.runtime()
      const size = rt.layout!.leafSize
      const pos = new Float64Array(3)
      for (const e of all) {
        worldPosition64(w, e, pos, p.terrain)
        const page = rt.pages!.leafNow(
          mainNoise(),
          rt.stack!,
          Math.floor(pos[0]! / size),
          Math.floor(pos[2]! / size),
        )
        const ground = pageHeight(rt, page, pos[0]!, pos[2]!)
        // On the ground, sunk a little (sink × scale), never floating.
        expect(pos[1]!).toBeLessThanOrEqual(ground + 1e-3)
        expect(pos[1]!).toBeGreaterThan(ground - 3)
        expect(Math.hypot(pos[0]! - 900, pos[2]! - 900)).toBeLessThan(250 * 1.15 + 120)
      }
      expect(w.resource(Scatter).surfaces.get(p.terrain)!.problem).toBeNull()
      await p.app.dispose()
    },
    timeout(120_000),
  )
})
