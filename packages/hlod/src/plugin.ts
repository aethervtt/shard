import { defineSchema, PostUpdate, t } from '@aethervtt/shard-core'
import { computeVisibility } from '@aethervtt/shard-render'
import { type AppMethod, definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { StructureSettings } from '@aethervtt/shard-structure'
import { TransformSystems } from '@aethervtt/shard-transform'
import { Exclude, HlodProxy, HlodSettings } from './components'
import { describeHlod, Hlod, hookHlod, selectProxies } from './runtime'

const NoParams = defineSchema('hlod/NoParams', {})

export const hlodMethods: AppMethod[] = [
  {
    name: 'hlod.describe',
    description:
      'HLOD proxies (0073): per level, cells loaded, covered by a proxy, drawn as shells, building and stale; proxies, their triangles, builds so far, jobs in flight and last frame ms.',
    params: NoParams,
    handler: ({ world }) => describeHlod(world),
  },
  {
    name: 'hlod.cell',
    description:
      "One cell's proxy: covered or not, its proxy's levels and triangles, and whether a build is in flight or it is stale.",
    params: defineSchema('hlod/CellParams', {
      key: t.string({
        required: true,
        description: 'The cell key, as partition.describe lists it.',
      }),
    }),
    handler: ({ world }, p) => {
      const state = world.resource(Hlod)
      const rec = [...state.cells.values()].find((r) => r.cell.key === p.key)
      if (!rec) return null
      const proxy =
        rec.proxy !== null && world.isAlive(rec.proxy) ? world.get(rec.proxy, HlodProxy) : null
      return {
        level: rec.cell.grid.levels[rec.cell.level]?.name,
        covered: rec.covered,
        proxy,
        building: rec.job !== undefined || rec.result !== undefined,
        stale: rec.proxy !== null && rec.dirtyFrame > rec.gathered,
      }
    },
  },
]

/**
 * Runtime HLOD (0073): cells at a grid level with `proxy: true` draw as merged proxies built on
 * the worker pool from what they draw. Client only: a server or a headless run adds nothing and
 * builds nothing. Puts structure's ground pieces in a ground group per cell root, so a cell's
 * ground goes with it, and turns on structure's camera region meshes, so near cells draw a mesh
 * per 32 m region and material instead of one per chunk.
 */
export function hlodPlugin(): Plugin {
  return definePlugin({
    name: 'hlod',
    dependencies: ['render/forward', 'structure', 'partition'],
    provides: [HlodProxy, Exclude, HlodSettings, Hlod],
    build(app) {
      const world = app.world
      world.initResource(HlodSettings)
      world.initResource(Hlod)
      const structure = world.resource(StructureSettings)
      structure.groundGroups = 'root'
      structure.cameraRegions = true
      hookHlod(world)
      app.addSystems(PostUpdate, selectProxies.after(TransformSystems).before(computeVisibility))
      app.addMethod(...hlodMethods)
    },
  })
}
