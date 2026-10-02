import {
  defineEvent,
  defineResource,
  defineSystem,
  First,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import {
  MODIFIERS,
  type MouseButton,
  type PointerKind,
  type PointerPolicy,
  type RawInputEvent,
} from '@aethervtt/shard-platform'
import { definePlugin, FrameDemand, type Plugin, Time } from '@aethervtt/shard-runtime'
import { type ActionState, defineActions } from './actions'
import type { PointerInput } from './devices'
import {
  addActions,
  InputQueue,
  Mouse,
  Pointers,
  scheduleInput,
  Touches,
  updateActions,
} from './plugin'

// Gestures (0060): taps, presses, drags and two-finger gestures from the pointer stream, in CSS
// pixels. A consumer claims a gesture when it starts; unclaimed gestures pass through, and the DOM
// source keeps its default handling for them.

export type GestureKind =
  | 'tap'
  | 'double-tap'
  | 'long-press'
  | 'drag-start'
  | 'drag'
  | 'drag-end'
  | 'pinch'
  | 'twist'
  | 'pan2'
  | 'wheel'

export interface GestureEvent {
  kind: GestureKind
  /**
   * The gesture this event belongs to: a drag's events share it, and so do a two-finger gesture's.
   * Claims are by id. 0 for the wheel (and a ctrl-wheel pinch), which nothing claims.
   */
  id: number
  pointer: PointerKind
  /** The button the gesture started with ('left' for touch and the wheel). */
  button: MouseButton
  /** `MODIFIERS` bits held when it started (the wheel: when it turned). */
  modifiers: number
  /** Where it is now, in CSS pixels; a two-finger gesture's is the fingers' center. */
  x: number
  y: number
  /** Where it started. */
  startX: number
  startY: number
  /** Movement since this gesture's previous event (`wheel`: the wheel's, in pixels). */
  dx: number
  dy: number
  /** `pinch`: this event's scale factor, above 1 as the fingers spread. 1 otherwise. */
  scale: number
  /** `twist`: this event's turn in radians, clockwise on screen. 0 otherwise. */
  angle: number
  /** `drag-end`: the drag was cancelled (Escape, focus loss, a pointercancel). */
  cancelled: boolean
}

export const Gesture = defineEvent<GestureEvent>('input/Gesture', {
  description:
    'Taps, long presses, drags, pinches, twists, two-finger pans and the wheel, in CSS pixels (0060).',
})

/** Thresholds the recognizer uses. Change them on `world.resource(Gestures).settings`. */
export interface GestureSettings {
  /** A press that moves at least this far (CSS px) is a drag. */
  dragPx: number
  /** A second tap within this long and this near the first is a double tap. */
  doubleTapMs: number
  doubleTapPx: number
  /** A press held this long without dragging is a long press. */
  longPressMs: number
}

/** What controls take from the pointer while they're enabled, per owner (see `PointerPolicy`). */
type PolicyPart = PointerPolicy

type TrackState = 'pending' | 'pressed' | 'dragging' | 'two' | 'done'

interface Track {
  pointerId: number
  gesture: number
  pointer: PointerKind
  button: MouseButton
  modifiers: number
  startX: number
  startY: number
  x: number
  y: number
  downAt: number
  state: TrackState
}

interface TwoFinger {
  gesture: number
  a: Track
  b: Track
  startX: number
  startY: number
  x: number
  y: number
  distance: number
  angle: number
}

interface ClaimState {
  owner: string | undefined
  held: number
  pointers: number[]
  ended: boolean
}

/**
 * The gesture recognizer's state, and who owns which gesture. Consumers read `Gesture` events,
 * claim the ones they use on their first event (`claim`), and ignore the rest.
 */
export class GesturesState {
  readonly settings: GestureSettings = {
    dragPx: 4,
    doubleTapMs: 300,
    doubleTapPx: 6,
    longPressMs: 500,
  }
  /** @internal */ readonly tracks = new Map<number, Track>()
  /** @internal */ two: TwoFinger | undefined = undefined
  /** @internal */ readonly claims = new Map<number, ClaimState>()
  /** @internal */ lastTap: { at: number; x: number; y: number; button: MouseButton } | undefined
  /** @internal */ nextId = 1
  /** @internal */ readonly policies = new Map<string, PolicyPart>()
  /** @internal */ policyKey = ''
  /** @internal */ world: World | undefined = undefined
  /** @internal Cancels the next frame applies (`cancel()` between frames). */
  cancelRequested = false

  /**
   * Takes gesture `id` for `owner`, from its first event on: its pointers are the scene's (the DOM
   * source stops their default handling and captures them). False when someone else owns it.
   */
  claim(id: number, owner: string): boolean {
    const c = this.claims.get(id)
    if (!c || c.ended) return false
    if (c.owner !== undefined && c.owner !== owner) return false
    this.own(c, owner)
    return true
  }

  /**
   * Takes gesture `id` for `owner` even from another owner (whose next look at `owner(id)` tells
   * it). PlaneDrag takes a drag a fallback control took while the host was still deciding.
   */
  take(id: number, owner: string): boolean {
    const c = this.claims.get(id)
    if (!c || c.ended) return false
    this.own(c, owner)
    return true
  }

  /**
   * Says a consumer is deciding about gesture `id` (an async pick): fallback consumers (a control
   * panning on a drag over empty floor) leave it alone until it's claimed or every hold is let go.
   */
  hold(id: number): void {
    const c = this.claims.get(id)
    if (c && !c.ended) c.held++
  }

  /** Lets go of a `hold`, or of a claim `owner` made. */
  release(id: number, owner?: string): void {
    const c = this.claims.get(id)
    if (!c) return
    if (owner === undefined) c.held = Math.max(0, c.held - 1)
    else if (c.owner === owner) c.owner = undefined
  }

  /** Who owns gesture `id`, if anyone. */
  owner(id: number): string | undefined {
    return this.claims.get(id)?.owner
  }

  /** Whether a fallback consumer may claim gesture `id`: it's live, unowned and nobody holds it. */
  free(id: number): boolean {
    const c = this.claims.get(id)
    return c !== undefined && !c.ended && c.owner === undefined && c.held === 0
  }

  /**
   * Where gesture `id`'s pointer is now (a two-finger gesture: the center), in CSS pixels. False
   * once it ended. A consumer that claims late (after an async pick) catches up from here.
   */
  position(id: number, out: { [index: number]: number }): boolean {
    for (const t of this.tracks.values()) {
      if (t.gesture !== id || t.state === 'done') continue
      out[0] = t.x
      out[1] = t.y
      return true
    }
    if (this.two?.gesture === id) {
      out[0] = this.two.x
      out[1] = this.two.y
      return true
    }
    return false
  }

  /** Whether gesture `id` is still going (its pointers are down). */
  live(id: number): boolean {
    const c = this.claims.get(id)
    return c !== undefined && !c.ended
  }

  /**
   * Ends every active drag and two-finger gesture, with `drag-end { cancelled: true }` for drags,
   * at the start of the next frame. Their pointers are ignored until they lift. The `cancel` action
   * (Escape) calls it.
   */
  cancel(): void {
    this.cancelRequested = true
  }

  /**
   * What `owner` takes from the pointer while enabled; `undefined` removes it. The DOM source gets
   * the union of every owner's, so it stops default handling for those and nothing else.
   */
  setPolicy(owner: string, policy: PointerPolicy | undefined): void {
    if (policy) this.policies.set(owner, policy)
    else this.policies.delete(owner)
  }

  /** Active pointers, gestures and claims. For agents. */
  describe() {
    return {
      settings: { ...this.settings },
      pointers: [...this.tracks.values()].map((t) => ({
        pointer: t.pointer,
        button: t.button,
        state: t.state,
        gesture: t.gesture,
        position: [t.x, t.y],
      })),
      claims: [...this.claims]
        .filter(([, c]) => !c.ended)
        .map(([id, c]) => ({ id, owner: c.owner ?? null, held: c.held > 0 })),
      policy: union(this.policies),
    }
  }

  private own(c: ClaimState, owner: string): void {
    c.owner = owner
    const source = this.world?.tryResource(InputQueue)?.source
    for (const p of c.pointers) source?.claimPointer?.(p)
  }
}

export const Gestures = defineResource<GesturesState>('input/Gestures', {
  description:
    'Gesture recognizer (0060): thresholds, active pointers, and who claimed which gesture.',
})

/** The built-in `cancel` action: Escape ends a drag. Rebind it with `rebindAction`. */
export const GestureActions = defineActions(
  'input/GestureActions',
  { cancel: { kind: 'button', bindings: ['Key:Escape'] } },
  { context: 'any' },
)

const BUTTON_ORDER: readonly MouseButton[] = ['left', 'middle', 'right', 'back', 'forward']

function union(policies: Map<string, PolicyPart>): PointerPolicy {
  const buttons = new Set<MouseButton>()
  let wheel = false
  let touch = false
  for (const p of policies.values()) {
    for (const b of p.buttons) buttons.add(b)
    wheel ||= p.wheel
    touch ||= p.touch
  }
  return { buttons: BUTTON_ORDER.filter((b) => buttons.has(b)), wheel, touch }
}

function send(
  world: World,
  kind: GestureKind,
  id: number,
  t: { pointer: PointerKind; button: MouseButton; modifiers: number },
  x: number,
  y: number,
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  scale = 1,
  angle = 0,
  cancelled = false,
): void {
  world.send(Gesture, {
    kind,
    id,
    pointer: t.pointer,
    button: t.button,
    modifiers: t.modifiers,
    x,
    y,
    startX,
    startY,
    dx,
    dy,
    scale,
    angle,
    cancelled,
  })
}

function endDrag(world: World, s: GesturesState, t: Track, cancelled: boolean): void {
  if (t.state === 'dragging')
    send(world, 'drag-end', t.gesture, t, t.x, t.y, t.startX, t.startY, 0, 0, 1, 0, cancelled)
  end(s, t.gesture)
}

function end(s: GesturesState, id: number): void {
  const c = s.claims.get(id)
  if (c) c.ended = true
}

function cancelAll(world: World, s: GesturesState): void {
  for (const t of s.tracks.values()) {
    if (t.state === 'dragging') endDrag(world, s, t, true)
    else if (t.state !== 'done') end(s, t.gesture)
    t.state = 'done'
  }
  if (s.two) {
    end(s, s.two.gesture)
    s.two = undefined
  }
}

function startTwo(world: World, s: GesturesState, a: Track, b: Track): void {
  // A one-finger drag becoming two fingers ends as a drag: the two-finger gesture takes over.
  for (const t of [a, b]) {
    if (t.state === 'dragging') endDrag(world, s, t, false)
    else end(s, t.gesture)
    t.state = 'two'
  }
  const id = s.nextId++
  s.claims.set(id, {
    owner: undefined,
    held: 0,
    pointers: [a.pointerId, b.pointerId],
    ended: false,
  })
  const x = (a.x + b.x) / 2
  const y = (a.y + b.y) / 2
  s.two = {
    gesture: id,
    a,
    b,
    startX: x,
    startY: y,
    x,
    y,
    distance: Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  }
}

function moveTwo(world: World, two: TwoFinger): void {
  const { a, b } = two
  const x = (a.x + b.x) / 2
  const y = (a.y + b.y) / 2
  const distance = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
  const angle = Math.atan2(b.y - a.y, b.x - a.x)
  // The pan first: the pinch and twist then turn about where the fingers are now.
  if (x !== two.x || y !== two.y)
    send(world, 'pan2', two.gesture, a, x, y, two.startX, two.startY, x - two.x, y - two.y)
  if (distance > 0 && two.distance > 0 && distance !== two.distance)
    send(
      world,
      'pinch',
      two.gesture,
      a,
      x,
      y,
      two.startX,
      two.startY,
      0,
      0,
      distance / two.distance,
    )
  let turn = angle - two.angle
  if (turn > Math.PI) turn -= 2 * Math.PI
  else if (turn < -Math.PI) turn += 2 * Math.PI
  if (turn !== 0) send(world, 'twist', two.gesture, a, x, y, two.startX, two.startY, 0, 0, 1, turn)
  two.x = x
  two.y = y
  two.distance = distance
  two.angle = angle
}

function down(world: World, s: GesturesState, e: PointerEvent, now: number, ui: boolean): void {
  const old = s.tracks.get(e.id)
  if (old) up(world, s, old, now, true)
  const id = s.nextId++
  const t: Track = {
    pointerId: e.id,
    gesture: id,
    pointer: e.pointer,
    button: e.pointer === 'touch' ? 'left' : e.button,
    modifiers: e.modifiers,
    startX: e.x,
    startY: e.y,
    x: e.x,
    y: e.y,
    downAt: now,
    state: 'pending',
  }
  s.tracks.set(e.id, t)
  // A press on UI drawn over the scene is the UI's: no control takes it.
  s.claims.set(id, { owner: ui ? 'ui' : undefined, held: 0, pointers: [e.id], ended: false })
  if (e.pointer !== 'touch') return
  let touching = 0
  let other: Track | undefined
  for (const u of s.tracks.values()) {
    if (u.pointer !== 'touch') continue
    touching++
    if (u !== t && u.state !== 'done') other = u
  }
  if (touching === 2 && other && !s.two) startTwo(world, s, other, t)
  else if (touching > 2) t.state = 'done' // a third finger joins nothing
}

function move(world: World, s: GesturesState, t: Track, x: number, y: number): void {
  const dx = x - t.x
  const dy = y - t.y
  t.x = x
  t.y = y
  if (t.state === 'two') {
    if (s.two && (s.two.a === t || s.two.b === t)) moveTwo(world, s.two)
    return
  }
  if (t.state === 'dragging') {
    send(world, 'drag', t.gesture, t, x, y, t.startX, t.startY, dx, dy)
    return
  }
  if (t.state !== 'pending' && t.state !== 'pressed') return
  const ox = x - t.startX
  const oy = y - t.startY
  if (ox * ox + oy * oy < s.settings.dragPx * s.settings.dragPx) return
  t.state = 'dragging'
  send(world, 'drag-start', t.gesture, t, x, y, t.startX, t.startY, ox, oy)
}

function up(world: World, s: GesturesState, t: Track, now: number, cancelled: boolean): void {
  s.tracks.delete(t.pointerId)
  if (t.state === 'dragging') {
    endDrag(world, s, t, cancelled)
    return
  }
  if (t.state === 'two') {
    // Lifting one finger ends the two-finger gesture; the other is done until it lifts too.
    const two = s.two
    if (two && (two.a === t || two.b === t)) {
      end(s, two.gesture)
      const rest = two.a === t ? two.b : two.a
      rest.state = 'done'
      s.two = undefined
    }
    end(s, t.gesture)
    return
  }
  end(s, t.gesture)
  if (t.state !== 'pending' || cancelled) return
  send(world, 'tap', t.gesture, t, t.x, t.y, t.startX, t.startY, 0, 0)
  const last = s.lastTap
  const { doubleTapMs, doubleTapPx } = s.settings
  if (
    last &&
    last.button === t.button &&
    now - last.at <= doubleTapMs &&
    (t.x - last.x) ** 2 + (t.y - last.y) ** 2 <= doubleTapPx * doubleTapPx
  ) {
    send(world, 'double-tap', t.gesture, t, t.x, t.y, t.startX, t.startY, 0, 0)
    s.lastTap = undefined
  } else {
    s.lastTap = { at: now, x: t.x, y: t.y, button: t.button }
  }
}

const WHEEL = { pointer: 'mouse' as PointerKind, button: 'left' as MouseButton, modifiers: 0 }

function wheel(world: World, e: WheelInput, fx: number, fy: number): void {
  const x = e.x ?? fx
  const y = e.y ?? fy
  WHEEL.modifiers = e.modifiers ?? 0
  // A trackpad pinch arrives as a ctrl wheel.
  if ((WHEEL.modifiers & MODIFIERS.ctrl) !== 0)
    send(world, 'pinch', 0, WHEEL, x, y, x, y, 0, 0, Math.exp(-e.dy * 0.01))
  else send(world, 'wheel', 0, WHEEL, x, y, x, y, e.dx, e.dy)
}

type PointerEvent = Extract<RawInputEvent, { type: 'pointer' }>
type WheelInput = Extract<RawInputEvent, { type: 'wheel' }>

function onUi(world: World, e: PointerEvent): boolean {
  if (e.pointer === 'touch') return world.tryResource(Touches)?.captured.has(e.id) ?? false
  return world.tryResource(Mouse)?.captured ?? false
}

function apply(
  world: World,
  s: GesturesState,
  e: PointerInput,
  now: number,
  fx: number,
  fy: number,
): void {
  if (e.type === 'wheel') {
    wheel(world, e, fx, fy)
    return
  }
  if (e.type === 'focus') {
    if (!e.focused) {
      cancelAll(world, s)
      s.tracks.clear()
    }
    return
  }
  if (e.phase === 'down') {
    down(world, s, e, now, onUi(world, e))
    return
  }
  const t = s.tracks.get(e.id)
  if (!t) return
  if (e.phase === 'move') move(world, s, t, e.x, e.y)
  else {
    if (e.x !== t.x || e.y !== t.y) move(world, s, t, e.x, e.y)
    up(world, s, t, now, e.phase === 'cancel')
  }
}

/** Turns this frame's pointer events into gestures, after `input/actions` (for Escape). */
export const updateGestures = defineSystem({
  name: 'input/gestures',
  description: 'Recognizes taps, presses, drags and two-finger gestures from pointer events.',
  run: (_, world) => {
    const s = world.resource(Gestures)
    // Claims of gestures that ended last frame: their consumers have seen the end.
    for (const [id, c] of s.claims) if (c.ended) s.claims.delete(id)
    const now = world.resource(Time).elapsed * 1000
    const actions = world.tryResource(GestureActions.resource) as ActionState<'cancel'> | undefined
    if (s.cancelRequested) {
      s.cancelRequested = false
      cancelAll(world, s)
    }
    const pointers = world.resource(Pointers)
    const fx = pointers.position[0]
    const fy = pointers.position[1]
    for (const e of pointers.events) apply(world, s, e, now, fx, fy)
    // Escape: the actions updated just before this system.
    if (actions?.justPressed('cancel')) cancelAll(world, s)
    // Long presses, and a frame to fire the next one on (0052).
    let soonest = Number.POSITIVE_INFINITY
    for (const t of s.tracks.values()) {
      if (t.state !== 'pending') continue
      const left = t.downAt + s.settings.longPressMs - now
      if (left <= 0) {
        t.state = 'pressed'
        send(world, 'long-press', t.gesture, t, t.x, t.y, t.startX, t.startY, 0, 0)
      } else if (left < soonest) soonest = left
    }
    if (soonest !== Number.POSITIVE_INFINITY) world.resource(FrameDemand).after(soonest)
    syncPolicy(world, s)
  },
})

function syncPolicy(world: World, s: GesturesState): void {
  if (s.policies.size === 0 && s.policyKey === '') return
  const policy = union(s.policies)
  const key = `${policy.buttons.join(',')}|${policy.wheel}|${policy.touch}`
  if (key === s.policyKey) return
  s.policyKey = key
  world.resource(InputQueue).source?.setPointerPolicy?.(policy)
}

/**
 * Gestures (0060): `Gesture` events from pointers and the wheel, claims, and the `cancel` action
 * (Escape). Needs `inputPlugin`.
 */
export const gesturesPlugin: Plugin = definePlugin({
  name: 'input/gestures',
  dependencies: ['input'],
  provides: [Gestures, Gesture, GestureActions.resource, updateGestures],
  build(app) {
    const state = new GesturesState()
    state.world = app.world
    app.insertResource(Gestures, state)
    addActions(app.world, GestureActions)
    app.addSystems(First, updateGestures.after(updateActions))
  },
})

// --- simulation ------------------------------------------------------------------------------

type Point = readonly [number, number]

/** A gesture to simulate (`simulateGestures`, the protocol's `input.simulate`), in CSS pixels. */
export type SimulatedGesture =
  | {
      drag: {
        from: Point
        to: Point
        button?: MouseButton
        pointer?: PointerKind
        modifiers?: number
        /** Frames the move takes. Default 10. */
        frames?: number
        /** Ends with Escape instead of lifting (a cancelled drag). */
        cancel?: boolean
      }
    }
  | {
      pinch: {
        center: Point
        /** Distance between the fingers at the start and the end, px. */
        from: number
        to: number
        /** Turn over the gesture, radians clockwise. Default 0. */
        twist?: number
        /** The center's movement over the gesture (two-finger pan). Default none. */
        pan?: Point
        frames?: number
      }
    }
  | { wheel: { at: Point; dy: number; dx?: number; modifiers?: number } }
  | { tap: Point; button?: MouseButton; pointer?: PointerKind }
  | { wait: number }

const SIM_ID = 1_000_000

/**
 * Raw input frames that play `gestures` one after another, a step per frame. Pointers start at
 * id 1,000,000 so they never collide with a live one.
 */
export function gestureFrames(gestures: readonly SimulatedGesture[]): RawInputEvent[][] {
  const frames: RawInputEvent[][] = []
  let id = SIM_ID
  const p = (
    pid: number,
    phase: 'down' | 'move' | 'up',
    x: number,
    y: number,
    pointer: PointerKind = 'mouse',
    button: MouseButton = 'left',
    modifiers = 0,
  ): RawInputEvent => ({ type: 'pointer', id: pid, phase, pointer, button, x, y, modifiers })
  for (const g of gestures) {
    if ('drag' in g) {
      const d = g.drag
      const n = Math.max(1, d.frames ?? 10)
      const pid = id++
      const kind = d.pointer ?? 'mouse'
      const button = d.button ?? 'left'
      frames.push([p(pid, 'down', d.from[0], d.from[1], kind, button, d.modifiers)])
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const x = d.from[0] + (d.to[0] - d.from[0]) * t
        const y = d.from[1] + (d.to[1] - d.from[1]) * t
        frames.push([p(pid, 'move', x, y, kind, button, d.modifiers)])
      }
      if (d.cancel) {
        frames.push([{ type: 'key', code: 'Escape', pressed: true }])
        frames.push([{ type: 'key', code: 'Escape', pressed: false }])
      }
      frames.push([p(pid, 'up', d.to[0], d.to[1], kind, button, d.modifiers)])
    } else if ('pinch' in g) {
      const q = g.pinch
      const n = Math.max(1, q.frames ?? 10)
      const a = id++
      const b = id++
      const at = (t: number) => {
        const r = (q.from + (q.to - q.from) * t) / 2
        const turn = (q.twist ?? 0) * t
        const cx = q.center[0] + (q.pan?.[0] ?? 0) * t
        const cy = q.center[1] + (q.pan?.[1] ?? 0) * t
        const c = Math.cos(turn) * r
        const s = Math.sin(turn) * r
        return [cx - c, cy - s, cx + c, cy + s] as const
      }
      const start = at(0)
      frames.push([
        p(a, 'down', start[0], start[1], 'touch'),
        p(b, 'down', start[2], start[3], 'touch'),
      ])
      for (let i = 1; i <= n; i++) {
        const f = at(i / n)
        frames.push([p(a, 'move', f[0], f[1], 'touch'), p(b, 'move', f[2], f[3], 'touch')])
      }
      const end = at(1)
      frames.push([p(a, 'up', end[0], end[1], 'touch'), p(b, 'up', end[2], end[3], 'touch')])
    } else if ('wheel' in g) {
      const w = g.wheel
      frames.push([
        {
          type: 'wheel',
          dx: w.dx ?? 0,
          dy: w.dy,
          x: w.at[0],
          y: w.at[1],
          modifiers: w.modifiers ?? 0,
        },
      ])
    } else if ('tap' in g) {
      const pid = id++
      const kind = g.pointer ?? 'mouse'
      const button = g.button ?? 'left'
      frames.push([p(pid, 'down', g.tap[0], g.tap[1], kind, button)])
      frames.push([p(pid, 'up', g.tap[0], g.tap[1], kind, button)])
    } else if ('wait' in g) {
      for (let i = 0; i < g.wait; i++) frames.push([])
    } else {
      throw new ShardError('input/unknown-gesture', `Can't simulate ${JSON.stringify(g)}`, {
        hint: 'Simulate { drag }, { pinch }, { wheel }, { tap } or { wait }.',
      })
    }
  }
  return frames
}

/**
 * Plays gestures through the input stream, a step per frame from the next one on, so gameplay
 * tests and agents drive controls and drags headless. Returns how many frames they take.
 */
export function simulateGestures(world: World, gestures: readonly SimulatedGesture[]): number {
  const frames = gestureFrames(gestures)
  scheduleInput(world, frames)
  return frames.length
}
