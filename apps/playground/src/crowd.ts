import { Camera3d, Exposure } from '@aethervtt/shard-render'
import { crowdCamera, spawnCrowd } from '@aethervtt/shard-render/crowd'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { orbitFrom, still } from './camera'
import { effectsFromUrl } from './post'

/**
 * 0022's crowd (`spawnCrowd`, shared with 0075's `crowd` scenario test): 200k static instances of
 * 20 mesh types over a 600 m field, under a sun with 4 shadow cascades. Most have 3 LOD levels;
 * every fifth is a small prop hidden past 120 m. `?count=` changes the number, `?nolod` draws every
 * instance at full detail. The camera orbits (drag to steer it), so the culled sets change every
 * frame while nothing uploads.
 */
export const crowdPlugin = definePlugin({
  name: 'crowd-demo',
  dependencies: ['render/forward'],
  build() {},
  ready(app) {
    const world = app.world
    const params = new URLSearchParams(location.search)
    const count = Number(params.get('count') ?? 200_000)
    const flat = params.has('nolod')
    // `?effects=` adds post effects (see post.ts), to measure them on a GPU-bound frame.
    const post = params.has('effects') ? effectsFromUrl() : []
    // A turntable 160 m out, 40 m up; `?still` holds it.
    const { eye, target } = crowdCamera(still ? 0.6 : 0)
    world.spawn(
      [Camera3d, { fovY: 60, far: 800 }],
      [Exposure, { ev100: 14 }],
      Transform,
      orbitFrom(eye, target, { turn: 2.86 }),
      ...(post as []),
    )
    spawnCrowd(world, { count, flat })
  },
})
