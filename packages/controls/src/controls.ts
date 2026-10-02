import {
  defineResource,
  defineSystem,
  type Entity,
  quat,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { Gesture, type GestureEvent, Gestures, type GesturesState } from '@aethervtt/shard-input'
import { MODIFIERS, type MouseButton, type PointerPolicy } from '@aethervtt/shard-platform'
import { Camera3d, Cameras } from '@aethervtt/shard-render'
import { FrameDemand, Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { ControlsSettings, MapControls, OrbitControls } from './components'
import { createView, mapView, orbitView, type ViewBasis, viewToPlane } from './view'

// The controls' system (0060): it reads gestures, moves each control's goal (its component), eases
// the camera toward it and writes that camera's Transform (and the map's orthoHeight). It only
// runs a control whose camera is active and which is enabled, and writes nothing else.

const BUTTON_NAMES: readonly MouseButton[] = ['left', 'middle', 'right']
const BUTTON_BITS = { left: 1, middle: 2, right: 4, back: 0, forward: 0 } as const
const DEMAND = 'controls'
/** Pan and zoom ignore floor hits farther than this many view sizes (rays near the horizon). */
const MAX_HIT = 50
/** Wheel pixels to zoom: a 100 px mouse notch is about 16%. */
const WHEEL_RATE = 0.0015

type Kind = 'orbit' | 'map'

export interface ControlLive {
  entity: Entity
  kind: Kind
  /** The owner name it claims gestures with. */
  owner: string
  /** Where the camera is now (eased toward the component's fields). */
  target: Float64Array
  /** Orbit: distance. Map: zoom. */
  scale: number
  yaw: number
  pitch: number
  /** The one-finger drag it owns (0: none), what it does, and the floor point it grabbed. */
  dragId: number
  dragMode: 'pan' | 'orbit'
  grab: Float64Array
  /** The two-finger gesture it owns (0: none). */
  twoId: number
  moving: boolean
  active: boolean
  /** The buttons its pointer policy takes (bits), -1 when it has none set. */
  policyBits: number
  seen: number
}

export interface ControlsStateValue {
  live: Map<Entity, ControlLive>
  frame: number
}

export const ControlsState = defineResource<ControlsStateValue>('controls/State', {
  description: "Each control's eased camera state, and the gestures it owns.",
  init: () => ({ live: new Map(), frame: 0 }),
})

/** The goal a gesture moves: a control's component fields, read into scratch. */
interface Goal {
  target: Float64Array
  scale: number
  yaw: number
  pitch: number
  minScale: number
  maxScale: number
  minPitch: number
  maxPitch: number
  /** Map: height at zoom 1 and elevation. Orbit: fovY. */
  height: number
  elevation: number
  fovY: number
  /** The floor's normal axis (1: the xz floor, 2: the xy plane of 2D) and the map's tilt. */
  axis: 1 | 2
  mapPitch: number
  bounded: boolean
  boundsMin0: number
  boundsMin1: number
  boundsMax0: number
  boundsMax1: number
}

const goal: Goal = {
  target: new Float64Array(3),
  scale: 1,
  yaw: 0,
  pitch: 0,
  minScale: 0,
  maxScale: 1,
  minPitch: 0,
  maxPitch: 0,
  height: 1,
  elevation: 1,
  fovY: 60,
  axis: 1,
  mapPitch: 90,
  bounded: false,
  boundsMin0: 0,
  boundsMin1: 0,
  boundsMax0: 0,
  boundsMax1: 0,
}
const view = createView()
const hitA = new Float64Array(3)
const hitB = new Float64Array(3)
const viewport: [number, number] = [1, 1]
const scratchQuat = new Float32Array(4)
const back = new Float64Array(3)
const eye = new Float64Array(3)

/** The size in CSS pixels `camera` is shown at: its target's once rendered, else the setting. */
export function viewportOf(world: World, camera: Entity, out: [number, number]): [number, number] {
  const cam = world.tryResource(Cameras)?.get(camera)
  if (cam && cam.frames > 0) {
    out[0] = cam.displayWidth / cam.pixelRatio
    out[1] = cam.displayHeight / cam.pixelRatio
  } else {
    const v = world.resource(ControlsSettings).viewport
    out[0] = v[0]
    out[1] = v[1]
  }
  return out
}

function clampGoal(kind: Kind, g: Goal): void {
  if (!(g.scale >= g.minScale)) g.scale = g.minScale
  if (g.scale > g.maxScale) g.scale = Math.max(g.minScale, g.maxScale)
  if (kind === 'orbit') {
    if (!(g.pitch >= g.minPitch)) g.pitch = g.minPitch
    if (g.pitch > g.maxPitch) g.pitch = Math.max(g.minPitch, g.maxPitch)
  }
  if (g.bounded) {
    const t = g.target
    t[0] = Math.min(Math.max(t[0]!, g.boundsMin0), Math.max(g.boundsMin0, g.boundsMax0))
    const b = g.axis === 1 ? 2 : 1
    t[b] = Math.min(Math.max(t[b]!, g.boundsMin1), Math.max(g.boundsMin1, g.boundsMax1))
  }
}

/** The view the goal describes, so input lands where the camera is going. */
function goalView(kind: Kind, g: Goal, aspect: number): ViewBasis {
  return kind === 'orbit'
    ? orbitView(view, g.target, g.scale, g.yaw, g.pitch, g.fovY, aspect)
    : mapView(view, g.target, g.elevation, g.mapPitch, g.height / g.scale, aspect, planeOf(g))
}

function planeOf(g: Goal): 'xz' | 'xy' {
  return g.axis === 1 ? 'xz' : 'xy'
}

function viewSize(kind: Kind, g: Goal): number {
  return kind === 'orbit' ? g.scale : g.height / g.scale
}

/** Scales the view about the floor point under (x, y): it stays under the cursor. */
function zoomAt(kind: Kind, g: Goal, x: number, y: number, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return
  const before = g.scale
  const hit = grabAt(kind, g, x, y, hitA)
  // Orbit: factor scales the distance. Map: it scales the view height, so zoom divides by it.
  g.scale = kind === 'orbit' ? before * factor : before / factor
  clampGoal(kind, g)
  if (!hit) return
  // Scaling the camera about the hit keeps the hit on the same ray, so under the same pixel.
  const k = kind === 'orbit' ? g.scale / before : before / g.scale
  const t = g.target
  const b = g.axis === 1 ? 2 : 1
  t[0] = hitA[0]! + (t[0]! - hitA[0]!) * k
  t[b] = hitA[b]! + (t[b]! - hitA[b]!) * k
  clampGoal(kind, g)
}

/** Moves the target so floor point `grab` lands under (x, y). */
function panTo(kind: Kind, g: Goal, grab: Float64Array, x: number, y: number): void {
  const v = goalView(kind, g, viewport[0] / viewport[1])
  const max = MAX_HIT * viewSize(kind, g)
  const a = g.axis
  if (!viewToPlane(v, x, y, viewport[0], viewport[1], g.target[a]!, hitB, max, a)) return
  const b = a === 1 ? 2 : 1
  g.target[0] = g.target[0]! + grab[0]! - hitB[0]!
  g.target[b] = g.target[b]! + grab[b]! - hitB[b]!
  clampGoal(kind, g)
}

/** Grabs the floor point under (x, y). False when the ray misses the floor. */
function grabAt(kind: Kind, g: Goal, x: number, y: number, out: Float64Array): boolean {
  const v = goalView(kind, g, viewport[0] / viewport[1])
  return viewToPlane(
    v,
    x,
    y,
    viewport[0],
    viewport[1],
    g.target[g.axis]!,
    out,
    MAX_HIT * viewSize(kind, g),
    g.axis,
  )
}

interface Buttons {
  orbit: MouseButton | undefined
  pan: MouseButton
  left: 'orbit' | 'pan' | 'none'
}

const buttons: Buttons = { orbit: undefined, pan: 'middle', left: 'none' }

/** What a drag does for this control: by its button, Shift, and the fallback for left drags. */
function dragMode(g: GestureEvent): 'pan' | 'orbit' | 'none' {
  if (g.pointer !== 'touch') {
    if (buttons.orbit !== undefined && g.button === buttons.orbit)
      return (g.modifiers & MODIFIERS.shift) !== 0 ? 'pan' : 'orbit'
    if (g.button === buttons.pan) return 'pan'
    if (g.button !== 'left') return 'none'
  }
  return buttons.left
}

function handle(
  kind: Kind,
  g: Goal,
  live: ControlLive,
  e: GestureEvent,
  gestures: GesturesState,
  rotateSpeed: number,
  zoomSpeed: number,
): void {
  switch (e.kind) {
    case 'drag-start':
    case 'drag': {
      if (live.dragId === e.id) {
        if (gestures.owner(e.id) !== live.owner) {
          live.dragId = 0 // taken (PlaneDrag took over a drag the host decided on)
          return
        }
      } else {
        // Claims wait until nothing else wants the drag: hosts claim theirs in Update, first.
        if (live.dragId !== 0 || !gestures.free(e.id)) return
        const mode = dragMode(e)
        if (mode === 'none') return
        if (mode === 'pan' && !grabAt(kind, g, e.startX, e.startY, live.grab)) return
        if (!gestures.claim(e.id, live.owner)) return
        live.dragId = e.id
        live.dragMode = mode
        if (mode === 'orbit') {
          // Catch up on the movement before the claim.
          g.yaw -= (e.x - e.startX - e.dx) * rotateSpeed
          g.pitch += (e.y - e.startY - e.dy) * rotateSpeed
        }
      }
      if (live.dragMode === 'pan') panTo(kind, g, live.grab, e.x, e.y)
      else if (kind === 'orbit') {
        g.yaw -= e.dx * rotateSpeed
        g.pitch += e.dy * rotateSpeed
        clampGoal(kind, g)
      }
      return
    }
    case 'drag-end':
      if (live.dragId === e.id) live.dragId = 0
      return
    case 'wheel':
      zoomAt(kind, g, e.x, e.y, Math.exp(e.dy * WHEEL_RATE * zoomSpeed))
      return
    case 'pinch':
    case 'pan2':
    case 'twist': {
      if (e.id !== 0 && live.twoId !== e.id) {
        if (!gestures.free(e.id) || !gestures.claim(e.id, live.owner)) return
        live.twoId = e.id
      } else if (e.id !== 0 && gestures.owner(e.id) !== live.owner) return
      if (e.kind === 'pinch') zoomAt(kind, g, e.x, e.y, 1 / e.scale)
      else if (e.kind === 'pan2') {
        if (grabAt(kind, g, e.x - e.dx, e.y - e.dy, hitA)) {
          hitB.set(hitA)
          panTo(kind, g, hitB, e.x, e.y)
        }
      } else if (kind === 'orbit') g.yaw += (e.angle * 180) / Math.PI
      return
    }
  }
}

function setPolicy(gestures: GesturesState, live: ControlLive, bits: number): void {
  if (live.policyBits === bits) return
  live.policyBits = bits
  if (bits < 0) {
    gestures.setPolicy(live.owner, undefined)
    return
  }
  const list: MouseButton[] = []
  for (let i = 0; i < 3; i++) if ((bits & (1 << i)) !== 0) list.push(BUTTON_NAMES[i]!)
  const policy: PointerPolicy = { buttons: list, wheel: true, touch: true }
  gestures.setPolicy(live.owner, policy)
}

function releaseAll(gestures: GesturesState, live: ControlLive): void {
  if (live.dragId !== 0) gestures.release(live.dragId, live.owner)
  if (live.twoId !== 0) gestures.release(live.twoId, live.owner)
  live.dragId = 0
  live.twoId = 0
  setPolicy(gestures, live, -1)
}

function createLive(entity: Entity, kind: Kind, g: Goal): ControlLive {
  return {
    entity,
    kind,
    owner: `controls:${entity}`,
    target: Float64Array.from(g.target),
    scale: g.scale,
    yaw: g.yaw,
    pitch: g.pitch,
    dragId: 0,
    dragMode: 'pan',
    grab: new Float64Array(3),
    twoId: 0,
    moving: false,
    active: false,
    policyBits: -1,
    seen: 0,
  }
}

function stepTo(from: number, to: number, alpha: number, eps: number): number {
  const next = from + (to - from) * alpha
  return Math.abs(to - next) <= eps ? to : next
}

/** Eases `live` toward the goal; true while it still moves. */
function ease(live: ControlLive, g: Goal, alpha: number): boolean {
  const eps = Math.max(1e-6, viewSize(live.kind, g)) * 1e-5
  const t = live.target
  t[0] = stepTo(t[0]!, g.target[0]!, alpha, eps)
  t[1] = stepTo(t[1]!, g.target[1]!, alpha, eps)
  t[2] = stepTo(t[2]!, g.target[2]!, alpha, eps)
  live.scale = stepTo(live.scale, g.scale, alpha, Math.max(1e-6, g.scale * 1e-5))
  live.yaw = stepTo(live.yaw, g.yaw, alpha, 1e-4)
  live.pitch = stepTo(live.pitch, g.pitch, alpha, 1e-4)
  return (
    t[0] !== g.target[0] ||
    t[1] !== g.target[1] ||
    t[2] !== g.target[2] ||
    live.scale !== g.scale ||
    live.yaw !== g.yaw ||
    live.pitch !== g.pitch
  )
}

/** Writes `value` into `column[index]` (as f32); true when that changed it. */
function put(column: Float32Array, index: number, value: number): boolean {
  const v = Math.fround(value)
  if (column[index] === v) return false
  column[index] = v
  return true
}

/** Writes the camera pose the live state describes; marks only what changed. */
function writeCamera(table: Table, row: number, kind: Kind, live: ControlLive, g: Goal): void {
  const aspect = viewport[0] / viewport[1]
  const v =
    kind === 'orbit'
      ? orbitView(view, live.target, live.scale, live.yaw, live.pitch, g.fovY, aspect)
      : mapView(
          view,
          live.target,
          g.elevation,
          g.mapPitch,
          g.height / live.scale,
          aspect,
          planeOf(g),
        )
  back[0] = -v.forward[0]!
  back[1] = -v.forward[1]!
  back[2] = -v.forward[2]!
  quat.fromBasis(scratchQuat, v.right, v.up, back)
  eye.set(v.eye)
  const translation = table.column(Transform, 'translation')
  const rotation = table.column(Transform, 'rotation')
  let changed = false
  for (let k = 0; k < 3; k++) {
    const value = Math.fround(eye[k]!)
    if (translation[row * 3 + k] !== value) {
      translation[row * 3 + k] = value
      changed = true
    }
  }
  for (let k = 0; k < 4; k++) {
    if (rotation[row * 4 + k] !== scratchQuat[k]) {
      rotation[row * 4 + k] = scratchQuat[k]!
      changed = true
    }
  }
  if (changed) table.markChanged(Transform, row)
  if (kind === 'map') {
    const height = table.column(Camera3d, 'orthoHeight')
    const value = Math.fround(g.height / live.scale)
    if (height[row] !== value) {
      height[row] = value
      table.markChanged(Camera3d, row)
    }
  }
}

const ORBIT_LEFT = ['orbit', 'pan', 'none'] as const

function run(
  world: World,
  events: readonly GestureEvent[],
  kind: Kind,
  table: Table,
  state: ControlsStateValue,
  reduced: boolean,
  dt: number,
): boolean {
  const o = kind === 'orbit'
  const def = o ? OrbitControls : MapControls
  const gestures = world.resource(Gestures)
  const active = table.column(Camera3d, 'active')
  const fov = table.column(Camera3d, 'fovY')
  const target = o ? table.column(OrbitControls, 'target') : table.column(MapControls, 'target')
  const enabled = o ? table.column(OrbitControls, 'enabled') : table.column(MapControls, 'enabled')
  const smoothing = o
    ? table.column(OrbitControls, 'smoothing')
    : table.column(MapControls, 'smoothing')
  const zoomSpeed = o
    ? table.column(OrbitControls, 'zoomSpeed')
    : table.column(MapControls, 'zoomSpeed')
  const panButton = o
    ? table.column(OrbitControls, 'panButton')
    : table.column(MapControls, 'panButton')
  const leftDrag = o
    ? table.column(OrbitControls, 'leftDrag')
    : table.column(MapControls, 'leftDrag')
  const distance = o ? table.column(OrbitControls, 'distance') : undefined
  const yaw = o ? table.column(OrbitControls, 'yaw') : undefined
  const pitch = o ? table.column(OrbitControls, 'pitch') : undefined
  const minPitch = o ? table.column(OrbitControls, 'minPitch') : undefined
  const maxPitch = o ? table.column(OrbitControls, 'maxPitch') : undefined
  const minScale = o
    ? table.column(OrbitControls, 'minDistance')
    : table.column(MapControls, 'minZoom')
  const maxScale = o
    ? table.column(OrbitControls, 'maxDistance')
    : table.column(MapControls, 'maxZoom')
  const orbitButton = o ? table.column(OrbitControls, 'orbitButton') : undefined
  const rotateSpeed = o ? table.column(OrbitControls, 'rotateSpeed') : undefined
  const autoRotate = o ? table.column(OrbitControls, 'autoRotate') : undefined
  const zoom = o ? undefined : table.column(MapControls, 'zoom')
  const height = o ? undefined : table.column(MapControls, 'height')
  const elevation = o ? undefined : table.column(MapControls, 'elevation')
  const bounded = o ? undefined : table.column(MapControls, 'bounded')
  const mapPitch = o ? undefined : table.column(MapControls, 'pitch')
  const plane = o ? undefined : table.column(MapControls, 'plane')
  const boundsMin = o ? undefined : table.column(MapControls, 'boundsMin')
  const boundsMax = o ? undefined : table.column(MapControls, 'boundsMax')
  let moving = false
  for (let i = 0; i < table.count; i++) {
    const entity = table.entities[i]!
    // Read the goal.
    goal.target[0] = target[i * 3]!
    goal.target[1] = target[i * 3 + 1]!
    goal.target[2] = target[i * 3 + 2]!
    goal.scale = o ? distance![i]! : zoom![i]!
    goal.yaw = o ? yaw![i]! : 0
    goal.pitch = o ? pitch![i]! : 90
    goal.minScale = minScale[i]!
    goal.maxScale = maxScale[i]!
    goal.minPitch = o ? minPitch![i]! : 90
    goal.maxPitch = o ? maxPitch![i]! : 90
    goal.fovY = fov[i]!
    goal.height = o ? 1 : height![i]!
    goal.elevation = o ? 1 : elevation![i]!
    goal.bounded = o ? false : bounded![i] !== 0
    goal.axis = o || plane![i] === 0 ? 1 : 2
    goal.mapPitch = o ? 90 : mapPitch![i]!
    goal.boundsMin0 = o ? 0 : boundsMin![i * 2]!
    goal.boundsMin1 = o ? 0 : boundsMin![i * 2 + 1]!
    goal.boundsMax0 = o ? 0 : boundsMax![i * 2]!
    goal.boundsMax1 = o ? 0 : boundsMax![i * 2 + 1]!
    let live = state.live.get(entity)
    if (!live || live.kind !== kind) {
      clampGoal(kind, goal)
      live = createLive(entity, kind, goal)
      state.live.set(entity, live)
    }
    live.seen = state.frame
    live.active = active[i] !== 0 && enabled[i] !== 0
    // An inactive camera's control keeps its state and writes nothing.
    if (!live.active) {
      releaseAll(gestures, live)
      continue
    }
    viewportOf(world, entity, viewport)
    buttons.orbit = o ? BUTTON_NAMES[orbitButton![i]!] : undefined
    buttons.pan = BUTTON_NAMES[panButton[i]!]!
    buttons.left = o ? ORBIT_LEFT[leftDrag[i]!]! : leftDrag[i] === 0 ? 'pan' : 'none'
    setPolicy(
      gestures,
      live,
      (buttons.orbit ? BUTTON_BITS[buttons.orbit] : 0) |
        BUTTON_BITS[buttons.pan] |
        (buttons.left !== 'none' ? BUTTON_BITS.left : 0),
    )
    clampGoal(kind, goal)
    const rs = o ? rotateSpeed![i]! : 0
    for (let k = 0; k < events.length; k++)
      handle(kind, goal, live, events[k]!, gestures, rs, zoomSpeed[i]!)
    const turning = o && autoRotate![i] !== 0 && live.dragId === 0 && live.twoId === 0
    if (turning) goal.yaw += autoRotate![i]! * dt
    clampGoal(kind, goal)
    // Write the goal back where input (or clamping) changed it.
    let changed = put(target, i * 3, goal.target[0]!)
    if (put(target, i * 3 + 1, goal.target[1]!)) changed = true
    if (put(target, i * 3 + 2, goal.target[2]!)) changed = true
    if (o) {
      if (put(distance!, i, goal.scale)) changed = true
      if (put(yaw!, i, goal.yaw)) changed = true
      if (put(pitch!, i, goal.pitch)) changed = true
    } else if (put(zoom!, i, goal.scale)) changed = true
    if (changed) table.markChanged(def, i)
    // Ease toward it (the goal as stored, f32), and place the camera.
    goal.target[0] = target[i * 3]!
    goal.target[1] = target[i * 3 + 1]!
    goal.target[2] = target[i * 3 + 2]!
    goal.scale = o ? distance![i]! : zoom![i]!
    goal.yaw = o ? yaw![i]! : 0
    goal.pitch = o ? pitch![i]! : 90
    const s = smoothing[i]!
    const alpha = reduced || !(s > 0) ? 1 : 1 - Math.exp(-dt / s)
    live.moving = ease(live, goal, alpha) || turning
    if (live.moving) moving = true
    writeCamera(table, i, kind, live, goal)
  }
  return moving
}

/** Reads gestures into the controls and places their cameras, before transform propagation. */
export const updateControls = defineSystem({
  name: 'controls/update',
  description:
    'Orbit and Map controls: gestures move each active control, which eases and places its camera.',
  setup: (world) => ({
    reader: world.reader(Gesture),
    orbit: world.query({ with: [OrbitControls, Camera3d, Transform] }),
    map: world.query({ with: [MapControls, Camera3d, Transform] }),
  }),
  run: ({ reader, orbit, map }, world) => {
    const events = reader.read()
    const state = world.resource(ControlsState)
    state.frame++
    const dt = world.resource(Time).delta
    const reduced = world.resource(ControlsSettings).reducedMotion
    let moving = false
    for (const table of orbit.tables)
      if (run(world, events, 'orbit', table, state, reduced, dt)) moving = true
    for (const table of map.tables)
      if (run(world, events, 'map', table, state, reduced, dt)) moving = true
    // Controls that went away: give back their gestures and policy.
    let live = 0
    for (const table of orbit.tables) live += table.count
    for (const table of map.tables) live += table.count
    if (live !== state.live.size) {
      const gestures = world.resource(Gestures)
      for (const [entity, l] of state.live) {
        if (l.seen === state.frame) continue
        releaseAll(gestures, l)
        state.live.delete(entity)
      }
    }
    world.resource(FrameDemand).set(DEMAND, moving)
  },
})

/** Jumps a control's camera to its fields, skipping the easing (after a host sets a view). */
export function snapControls(world: World, entity: Entity): void {
  const live = world.resource(ControlsState).live.get(entity)
  if (!live) return
  const orbit = world.tryGet(entity, OrbitControls)
  const map = orbit ? undefined : world.tryGet(entity, MapControls)
  const value = orbit ?? map
  if (!value) return
  live.target.set(value.target)
  live.scale = orbit ? orbit.distance : map!.zoom
  live.yaw = orbit ? orbit.yaw : 0
  live.pitch = orbit ? orbit.pitch : 90
}
