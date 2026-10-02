import { defineSchema, PostUpdate, type World } from '@aethervtt/shard-core'
import { type AppMethod, definePlugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { ControlsSettings, MapControls, OrbitControls } from './components'
import { ControlsState, updateControls } from './controls'
import { DragEnded, DragMoved, PlaneDrag, PlaneDragState, updatePlaneDrag } from './drag'

/** Every control's camera, fields, eased state and whether it moves, and the PlaneDrag. For agents. */
export function describeControls(world: World) {
  const state = world.resource(ControlsState)
  const controls = [...state.live.values()].map((live) => {
    const fields =
      live.kind === 'orbit'
        ? world.tryGet(live.entity, OrbitControls)
        : world.tryGet(live.entity, MapControls)
    return {
      camera: live.entity,
      kind: live.kind,
      active: live.active,
      moving: live.moving,
      dragging: live.dragId !== 0 ? live.dragMode : live.twoId !== 0 ? 'touch' : null,
      fields: fields ? { ...fields, target: Array.from(fields.target) } : null,
      current:
        live.kind === 'orbit'
          ? {
              target: Array.from(live.target),
              distance: live.scale,
              yaw: live.yaw,
              pitch: live.pitch,
            }
          : { target: Array.from(live.target), zoom: live.scale },
    }
  })
  return {
    controls,
    drag: world.resource(PlaneDrag).describe(),
    settings: world.resource(ControlsSettings),
  }
}

export const controlsMethods: AppMethod[] = [
  {
    name: 'controls.describe',
    description:
      "Camera controls (0060): each control's camera, kind (orbit or map), whether it's active and moving, what it drags, its fields and its eased state, plus the PlaneDrag.",
    params: defineSchema('controls/DescribeParams', {}),
    handler: ({ world }) => JSON.parse(JSON.stringify(describeControls(world))),
  },
]

/**
 * Camera controls and object drag (0060): `OrbitControls`, `MapControls`, `PlaneDrag`, and the
 * `controls.describe` method. Needs `gesturesPlugin` (and `inputPlugin` with a live source for
 * real input), `TransformPlugin` and the render components.
 */
export const controlsPlugin = definePlugin({
  name: 'controls',
  dependencies: ['input/gestures', 'core/transform'],
  provides: [
    OrbitControls,
    MapControls,
    ControlsSettings,
    ControlsState,
    PlaneDrag,
    DragMoved,
    DragEnded,
    updateControls,
    updatePlaneDrag,
  ],
  build(app) {
    app.world.initResource(ControlsSettings)
    app.world.initResource(ControlsState)
    const drag = new PlaneDragState()
    drag.world = app.world
    app.insertResource(PlaneDrag, drag)
    app.addSystems(
      PostUpdate,
      updateControls.before(TransformSystems),
      updatePlaneDrag.after(updateControls).before(TransformSystems),
    )
    app.addMethod(...controlsMethods)
  },
})
