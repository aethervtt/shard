import { First, Last } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { OriginShift } from '@aethervtt/shard-transform'
import { GIZMO_SHADERS } from './debug-shaders'
import { upload } from './forward'
import { beginGizmos, GizmoGpuResource, Gizmos, gizmoNode, uploadGizmos } from './gizmos'
import { DebugOverlays, drawOverlays, gridsOverlay } from './overlays'
import { Graph, RenderSet, Shaders } from './plugin'
import { registerShaders } from './shaders'

/**
 * Debug drawing (spec 0027): the Gizmos lines, shapes, and labels gameplay draws each frame, and the
 * overlays (`debug.overlays`) that other packages register. Picking is pickingPlugin.
 */
export const gizmosPlugin = definePlugin({
  name: 'render/gizmos',
  dependencies: ['render/forward'],
  provides: [GizmoGpuResource, Gizmos, DebugOverlays, gridsOverlay],
  build(app) {
    const w = app.world
    w.initResource(Gizmos)
    w.initResource(DebugOverlays)
    // Gizmos drawn this frame in the old origin frame move with it (spec 0040).
    w.observe(OriginShift, ({ world, data }) => {
      world.tryResource(Gizmos)?.shiftOrigin(data.offset[0], data.offset[1], data.offset[2])
    })
    app
      .addSystems(
        Last,
        drawOverlays.inSet(RenderSet.Upload).after(upload),
        uploadGizmos.inSet(RenderSet.Upload).after(drawOverlays),
      )
      .addSystems(First, beginGizmos)
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), GIZMO_SHADERS)
    app.world.resource(Graph).addNode('gizmos', gizmoNode(app.world))
  },
})
