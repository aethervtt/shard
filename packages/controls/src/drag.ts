import {
  ChildOf,
  defineEvent,
  defineResource,
  defineSystem,
  type Entity,
  ShardError,
  type Vec3,
  type World,
} from '@aethervtt/shard-core'
import { Gesture, type GestureEvent, Gestures } from '@aethervtt/shard-input'
import { Camera3d } from '@aethervtt/shard-render'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { viewportOf } from './controls'
import { createView, poseView, viewToPlane } from './view'

// Object drag (0060): the host picks what's under a drag-start and decides it may move; PlaneDrag
// then slides it along a horizontal plane under the pointer, keeping the grab offset, and reports
// previews and the drop. The host commits the move (or not) on DragEnded.

export interface DragMovedEvent {
  entity: Entity
  /** World position now. */
  position: Vec3
  /** Movement since the previous DragMoved (or the start). */
  delta: Vec3
}

export interface DragEndedEvent {
  entity: Entity
  /** Where it ended: the start again when cancelled. */
  position: Vec3
  start: Vec3
  cancelled: boolean
}

export const DragMoved = defineEvent<DragMovedEvent>('controls/DragMoved', {
  description: 'A PlaneDrag moved its entity: a preview, not a commit.',
})

export const DragEnded = defineEvent<DragEndedEvent>('controls/DragEnded', {
  description:
    'A PlaneDrag ended: commit `position` unless `cancelled` (the entity is back at `start`).',
})

export interface PlaneDragOptions {
  entity: Entity
  /** The drag: its `drag-start` event (or that event's id). */
  gesture: GestureEvent | number
  /**
   * The plane the pointer moves on: 'grab' (default), through the grab point (or the entity, with
   * no `grab`); or a height.
   */
  plane?: 'grab' | { y: number }
  /** The point the pointer took hold of, e.g. `PickHit.position`. Default: the start pixel's ray on the plane. */
  grab?: ArrayLike<number>
  /** Adjusts each position in place, e.g. to a grid cell's center. */
  snap?: (position: Vec3) => void
  /** The camera the pointer looks through. Default: the active camera drawn first. */
  camera?: Entity
}

const OWNER = 'controls/plane-drag'

const view = createView()
const hit = new Float64Array(3)
const pointer = new Float64Array(2)
const viewport: [number, number] = [1, 1]

/** The active camera drawn first (lowest `order`). */
function defaultCamera(world: World): Entity | undefined {
  let best: Entity | undefined
  let bestOrder = Number.POSITIVE_INFINITY
  for (const table of world.query({ with: [Camera3d, Transform] }).tables) {
    const active = table.column(Camera3d, 'active')
    const order = table.column(Camera3d, 'order')
    for (let i = 0; i < table.count; i++) {
      if (active[i] === 0 || order[i]! >= bestOrder) continue
      best = table.entities[i]
      bestOrder = order[i]!
    }
  }
  return best
}

/** The floor point under CSS pixel (x, y) of `camera` on plane `y = planeY`. */
function pointOnPlane(
  world: World,
  camera: Entity,
  x: number,
  y: number,
  planeY: number,
  out: Float64Array,
): boolean {
  const table = world.entityTable(camera)
  const row = world.entityRow(camera)
  viewportOf(world, camera, viewport)
  const t = table.column(Transform, 'translation')
  const r = table.column(Transform, 'rotation')
  poseView(
    view,
    t.subarray(row * 3, row * 3 + 3),
    r.subarray(row * 4, row * 4 + 4),
    table.column(Camera3d, 'projection')[row] !== 0,
    table.column(Camera3d, 'fovY')[row]!,
    table.column(Camera3d, 'orthoHeight')[row]!,
    viewport[0] / viewport[1],
  )
  return viewToPlane(view, x, y, viewport[0], viewport[1], planeY, out)
}

/**
 * Drags one entity at a time along a horizontal plane (0060). `begin` it from the host's own
 * `drag-start` handler once `pick` says what's under the pointer and the host decides it moves.
 * Cameras it projects through must be unparented (as controls' cameras are), and a dragged
 * entity's parents may only translate it.
 */
export class PlaneDragState {
  /** @internal */ world: World | undefined = undefined
  /** The dragged entity, while a drag runs. */
  entity: Entity | undefined = undefined
  /** @internal */ gesture = 0
  /** @internal */ camera: Entity = 0 as Entity
  /** @internal */ planeY = 0
  /** @internal */ snap: ((position: Vec3) => void) | undefined = undefined
  /** @internal World-space offset from the pointer's floor point to the entity. */
  readonly offset = new Float64Array(3)
  /** @internal */ readonly startLocal = new Float64Array(3)
  /** @internal */ readonly startWorld = new Float64Array(3)
  /** @internal */ readonly position = new Float64Array(3)

  get active(): boolean {
    return this.entity !== undefined
  }

  /**
   * Starts dragging `entity` with a drag gesture, taking the gesture from whoever had it (a camera
   * control panning on it while the host picked). False when the drag already ended, or there's no
   * camera to project through.
   */
  begin(options: PlaneDragOptions): boolean {
    const world = this.world
    if (!world)
      throw new ShardError('controls/no-plugin', 'PlaneDrag needs controlsPlugin', {
        hint: 'Add "controls" to plugins in shard.json (or app.addPlugin(controlsPlugin)).',
      })
    const id = typeof options.gesture === 'number' ? options.gesture : options.gesture.id
    const gestures = world.resource(Gestures)
    if (!gestures.live(id)) return false
    if (!world.isAlive(options.entity) || !world.has(options.entity, Transform)) {
      throw new ShardError('controls/not-draggable', `Entity ${options.entity} has no Transform`, {
        hint: 'PlaneDrag moves an entity by its Transform.',
      })
    }
    const camera = options.camera ?? defaultCamera(world)
    if (camera === undefined) return false
    if (this.entity !== undefined) this.finish(true)
    gestures.take(id, OWNER)
    const e = options.entity
    const local = world.get(e, Transform).translation
    this.startLocal.set(local)
    // Where it is in the world: a child's from last frame's GlobalTransform.
    const g = world.has(e, ChildOf) ? world.tryGet(e, GlobalTransform)?.matrix : undefined
    this.startWorld[0] = g ? g[3]! : local[0]
    this.startWorld[1] = g ? g[7]! : local[1]
    this.startWorld[2] = g ? g[11]! : local[2]
    const plane = options.plane ?? 'grab'
    this.planeY = plane === 'grab' ? (options.grab?.[1] ?? this.startWorld[1]!) : plane.y
    // The grab point: given, or where the drag started on the plane.
    let gx = this.startWorld[0]!
    let gz = this.startWorld[2]!
    if (options.grab) {
      gx = options.grab[0]!
      gz = options.grab[2]!
    } else {
      const start = typeof options.gesture === 'number' ? undefined : options.gesture
      if (start && pointOnPlane(world, camera, start.startX, start.startY, this.planeY, hit)) {
        gx = hit[0]!
        gz = hit[2]!
      }
    }
    this.offset[0] = this.startWorld[0]! - gx
    this.offset[1] = 0
    this.offset[2] = this.startWorld[2]! - gz
    this.position.set(this.startWorld)
    this.entity = e
    this.gesture = id
    this.camera = camera
    this.snap = options.snap
    // Catch up with where the pointer is now.
    if (gestures.position(id, pointer)) this.moveTo(pointer[0]!, pointer[1]!)
    return true
  }

  /** Ends the drag as cancelled: the entity goes back to where it started. */
  cancel(): void {
    if (this.entity !== undefined) this.finish(true)
  }

  /** The drag as data. For agents. */
  describe() {
    return this.entity === undefined
      ? { active: false }
      : {
          active: true,
          entity: this.entity,
          gesture: this.gesture,
          camera: this.camera,
          planeY: this.planeY,
          start: Array.from(this.startWorld),
          position: Array.from(this.position),
        }
  }

  /** @internal Moves the entity under CSS pixel (x, y). */
  moveTo(x: number, y: number): void {
    const world = this.world!
    const e = this.entity!
    if (!world.isAlive(this.camera)) return
    if (!pointOnPlane(world, this.camera, x, y, this.planeY, hit)) return
    const p: Vec3 = [hit[0]! + this.offset[0]!, this.startWorld[1]!, hit[2]! + this.offset[2]!]
    this.snap?.(p)
    const delta: Vec3 = [
      p[0] - this.position[0]!,
      p[1] - this.position[1]!,
      p[2] - this.position[2]!,
    ]
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return
    this.position.set(p)
    this.place(p)
    world.send(DragMoved, { entity: e, position: p, delta })
  }

  /** @internal */
  finish(cancelled: boolean): void {
    const world = this.world!
    const e = this.entity!
    this.entity = undefined
    const start: Vec3 = [this.startWorld[0]!, this.startWorld[1]!, this.startWorld[2]!]
    if (!world.isAlive(e)) return
    if (cancelled) {
      this.position.set(start)
      world.set(e, Transform, {
        translation: [this.startLocal[0]!, this.startLocal[1]!, this.startLocal[2]!],
      })
    }
    world.resource(Gestures).release(this.gesture, OWNER)
    world.send(DragEnded, {
      entity: e,
      position: [this.position[0]!, this.position[1]!, this.position[2]!],
      start,
      cancelled,
    })
  }

  private place(p: Vec3): void {
    // One Transform write per move: one instance slot to upload.
    this.world!.set(this.entity!, Transform, {
      translation: [
        this.startLocal[0]! + p[0] - this.startWorld[0]!,
        this.startLocal[1]! + p[1] - this.startWorld[1]!,
        this.startLocal[2]! + p[2] - this.startWorld[2]!,
      ],
    })
  }
}

export const PlaneDrag = defineResource<PlaneDragState>('controls/PlaneDrag', {
  description:
    'Drags one entity along a horizontal plane under the pointer (0060); see begin(). Emits DragMoved and DragEnded.',
})

/** Follows the drag's gesture: moves on `drag`, ends on `drag-end` (restoring when cancelled). */
export const updatePlaneDrag = defineSystem({
  name: 'controls/plane-drag',
  description: 'Moves the entity a PlaneDrag holds with its drag gesture, and ends the drag.',
  setup: (world) => world.reader(Gesture),
  run: (reader, world) => {
    const events = reader.read()
    const drag = world.resource(PlaneDrag)
    if (drag.entity === undefined) return
    if (!world.isAlive(drag.entity)) {
      drag.finish(true)
      return
    }
    for (let i = 0; i < events.length && drag.entity !== undefined; i++) {
      const e = events[i]!
      if (e.id !== drag.gesture) continue
      if (e.kind === 'drag-start' || e.kind === 'drag') drag.moveTo(e.x, e.y)
      else if (e.kind === 'drag-end') drag.finish(e.cancelled)
    }
    // Someone else took the gesture, or it ended without a drag-end (a tap): it's over.
    const gestures = world.resource(Gestures)
    if (drag.entity !== undefined && gestures.owner(drag.gesture) !== OWNER) drag.finish(true)
  },
})
