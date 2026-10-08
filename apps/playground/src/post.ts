import { defineSystem, Update } from '@aethervtt/shard-core'
import { Camera3d } from '@aethervtt/shard-render'
import {
  ALL_POST_EFFECTS,
  POST_EYE,
  POST_LENS,
  POST_TARGET,
  postCamera,
  postEffects,
  postScenePlugin,
  spawnPostScene,
} from '@aethervtt/shard-render/post-scene'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { orbitFrom } from './camera'

/** The components `?effects=` names (default: every effect but FXAA). */
export function effectsFromUrl(): unknown[] {
  const param = new URLSearchParams(location.search).get('effects')
  return postEffects(param === null ? ALL_POST_EFFECTS : param.split(',').filter(Boolean))
}

/** `?path`: the camera follows 0075's `post-stack` path instead of orbit controls. */
const followPath = defineSystem({
  name: 'post-demo/path',
  setup: (world) => ({ q: world.query({ with: [Camera3d, Transform] }) }),
  run: ({ q }, world) => {
    const { eye, target } = postCamera(world.resource(Time).elapsed)
    const rotation = lookAt(eye, target)
    for (const table of q.tables) {
      const tr = table.column(Transform, 'translation')
      const rot = table.column(Transform, 'rotation')
      for (let i = 0; i < table.count; i++) {
        tr.set(eye, i * 3)
        rot.set(rotation, i * 4)
      }
      table.markChanged(Transform)
    }
  },
})

/**
 * Every post effect on a sunlit courtyard (`spawnPostScene`, shared with 0075's `post-stack`
 * scenario test): blocks and spheres, neon panels, orbiting balls for motion blur and TAA, fog
 * toward the horizon. `?effects=bloom,fog` picks effects (default: all but fxaa; empty for none);
 * `noaa` turns MSAA off, for a baseline to measure against. `?path` flies the scenario's camera path.
 */
export const postPlugin = definePlugin({
  name: 'post-demo',
  dependencies: ['render/forward'],
  build(app) {
    app.addPlugin(postScenePlugin)
    if (new URLSearchParams(location.search).has('path')) app.addSystems(Update, followPath)
  },
  ready(app) {
    const world = app.world
    const path = new URLSearchParams(location.search).has('path')
    world.spawn(
      [Camera3d, { fovY: 50 }],
      POST_LENS,
      Transform,
      ...(path ? [] : [orbitFrom(POST_EYE, POST_TARGET)]),
      ...(effectsFromUrl() as []),
    )
    spawnPostScene(world)
  },
})
