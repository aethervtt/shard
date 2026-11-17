import { defineResource, defineSystem, ShardError, type World } from '@aethervtt/shard-core'
import { NetClock, NetRole } from '@aethervtt/shard-net'
import { FixedTime } from '@aethervtt/shard-runtime'
import { HourChanged, TimeOfDay, type TimeOfDayValue } from './components'

/**
 * The clock's anchor (0130): game hours since day 0 at a tick (`skyTick`'s). The clock is a function
 * of the tick from there, so every machine at the same tick reads the same time, with no drift.
 */
export interface ClockState {
  anchorTick: number
  /** Game hours since day 0 at `anchorTick`. */
  anchorHours: number
  /** A timed change: hours since day 0 move linearly from `from` to `to` over these ticks. */
  transition: { startTick: number; endTick: number; from: number; to: number } | undefined
  /** The settings the anchor was taken with: changing any re-anchors. */
  rates: Float64Array
  /** Hours since day 0 last frame (events). */
  last: number
  /** The tick (with its fraction) the clock last read. */
  tick: number
}

export const Clock = defineResource<ClockState>('sky/Clock', {
  description: "The clock's anchor tick and hours, and a timed transition in progress.",
  init: () => ({
    anchorTick: 0,
    anchorHours: Number.NaN,
    transition: undefined,
    rates: new Float64Array(6).fill(Number.NaN),
    last: Number.NaN,
    tick: 0,
  }),
})

/**
 * Real seconds the clock takes from `from` to `to` hours since day 0 (to ≥ from) at speed 1: the
 * inverse of `advanceHours`.
 */
export function secondsBetween(c: TimeOfDayValue, from: number, to: number): number {
  const dayHours = c.dusk - c.dawn
  const nightHours = 24 - dayHours
  const cycle = c.dayLength + c.nightLength
  if (!(cycle > 0) || !(dayHours > 0) || !(nightHours > 0) || !(to > from)) return 0
  const whole = Math.floor((to - from) / 24)
  let seconds = whole * cycle
  let h = from + whole * 24
  for (let guard = 0; guard < 4 && h < to; guard++) {
    const hod = h - Math.floor(h / 24) * 24
    const day = hod >= c.dawn && hod < c.dusk
    const rate = day ? dayHours / c.dayLength : nightHours / c.nightLength
    const toEdge = day ? c.dusk - hod : hod >= c.dusk ? 24 - hod + c.dawn : c.dawn - hod
    if (to - h <= toEdge) return seconds + (to - h) / rate
    h += toEdge
    seconds += toEdge / rate
  }
  return seconds
}

/**
 * Game hours after `seconds` of real time from `hours` (since day 0): hours between dawn and dusk
 * pass in dayLength, the rest in nightLength.
 */
export function advanceHours(c: TimeOfDayValue, hours: number, seconds: number): number {
  const dayHours = c.dusk - c.dawn
  const nightHours = 24 - dayHours
  const cycle = c.dayLength + c.nightLength
  if (!(cycle > 0) || !(dayHours > 0) || !(nightHours > 0)) return hours
  const whole = Math.floor(seconds / cycle)
  let h = hours + whole * 24
  let s = seconds - whole * cycle
  for (let guard = 0; guard < 4 && s > 0; guard++) {
    const hod = h - Math.floor(h / 24) * 24
    const day = hod >= c.dawn && hod < c.dusk
    const rate = day ? dayHours / c.dayLength : nightHours / c.nightLength
    const toEdge = day ? c.dusk - hod : hod >= c.dusk ? 24 - hod + c.dawn : c.dawn - hod
    const need = toEdge / rate
    if (s <= need) return h + s * rate
    h += toEdge
    s -= need
  }
  return h
}

/**
 * The tick the sky runs on (0130, 0131, 0133): the fixed tick and its fraction, or on a multiplayer
 * client the server's (NetClock), so every player sees the same sky with nothing sent for it.
 */
export function skyTick(world: World): number {
  const fixed = world.tryResource(FixedTime)
  if (!fixed) return 0
  if (world.tryResource(NetRole)?.role === 'client') {
    return world.tryResource(NetClock)?.serverTick ?? 0
  }
  return fixed.tick + fixed.alpha
}

function step(world: World): number {
  return world.tryResource(FixedTime)?.step ?? 1 / 60
}

/** Hours since day 0 at a tick, from the anchor and any transition. */
function hoursAt(c: TimeOfDayValue, s: ClockState, tick: number, dt: number): number {
  const tr = s.transition
  if (tr && tick < tr.endTick) {
    const f = Math.max(0, (tick - tr.startTick) / Math.max(1, tr.endTick - tr.startTick))
    return tr.from + (tr.to - tr.from) * f
  }
  if (c.paused) return s.anchorHours
  return advanceHours(c, s.anchorHours, (tick - s.anchorTick) * dt * c.speed)
}

/** Game hours since day 0 at a tick (`skyTick`'s), past or future, from the anchor. */
export function clockHoursAt(world: World, tick: number): number {
  const c = world.resource(TimeOfDay)
  const s = world.resource(Clock)
  if (Number.isNaN(s.anchorHours)) return c.day * 24 + c.hours
  return hoursAt(c, s, tick, step(world))
}

function reanchor(world: World, s: ClockState, hours: number): void {
  s.anchorTick = skyTick(world)
  s.anchorHours = hours
}

/** Parses "18:30", "6pm", "6:15am", "0630" or a number of hours. */
export function parseTime(time: string | number): number {
  if (typeof time === 'number') return time
  const m = /^\s*(\d{1,2})(?::?(\d{2}))?(?::(\d{2}))?\s*([ap]m)?\s*$/i.exec(time)
  if (!m) {
    throw new ShardError('sky/bad-time', `"${time}" isn't a time of day`, {
      hint: 'Use "18:30", "6pm", "6:15am", "0630", or a number of hours.',
    })
  }
  let h = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600
  const ampm = m[4]?.toLowerCase()
  if (ampm === 'pm' && h < 12) h += 12
  if (ampm === 'am' && h >= 12) h -= 12
  return h
}

/** Sets the clock to a time of day (on `day`, default the current one) from now. */
export function setTimeOfDay(
  world: World,
  time: string | number,
  options: { day?: number } = {},
): void {
  const c = world.resource(TimeOfDay)
  const s = world.resource(Clock)
  const h = parseTime(time)
  const day = options.day ?? c.day
  s.transition = undefined
  reanchor(world, s, day * 24 + h)
  s.last = Number.NaN
  c.hours = h
  c.day = day
}

/** Moves the clock to the next `time` over `seconds` of real time, then runs on from there. */
export function transitionTimeOfDay(world: World, time: string | number, seconds: number): void {
  const c = world.resource(TimeOfDay)
  const s = world.resource(Clock)
  const from = c.day * 24 + c.hours
  let to = c.day * 24 + parseTime(time)
  while (to < from) to += 24
  const start = skyTick(world)
  s.transition = { startTick: start, endTick: start + seconds / step(world), from, to }
}

/** Advances TimeOfDay from the fixed tick, and raises HourChanged. */
export const updateClock = defineSystem({
  name: 'sky/clock',
  description:
    'Sets TimeOfDay from the fixed tick and the clock anchor (0130); raises HourChanged.',
  run: (_, world) => {
    const c = world.resource(TimeOfDay)
    const s = world.resource(Clock)
    const tick = skyTick(world)
    const dt = step(world)
    s.tick = tick
    if (Number.isNaN(s.anchorHours)) {
      // The clock starts at TimeOfDay's hours now, or on a client at the server's tick 0: where
      // every player's clock started, whenever they joined.
      reanchor(world, s, c.day * 24 + c.hours)
      if (world.tryResource(NetRole)?.role === 'client') s.anchorTick = 0
    }
    // Hours or day written directly, or new rates: re-anchor where the clock is now.
    const r = s.rates
    const changed =
      r[0] !== c.dawn ||
      r[1] !== c.dusk ||
      r[2] !== c.dayLength ||
      r[3] !== c.nightLength ||
      r[4] !== c.speed ||
      r[5] !== (c.paused ? 1 : 0)
    if (changed) {
      if (!Number.isNaN(r[0]!)) reanchor(world, s, s.last)
      r[0] = c.dawn
      r[1] = c.dusk
      r[2] = c.dayLength
      r[3] = c.nightLength
      r[4] = c.speed
      r[5] = c.paused ? 1 : 0
    } else if (!Number.isNaN(s.last) && c.day * 24 + c.hours !== s.last) {
      // A game wrote hours or day itself: take it as the new anchor.
      reanchor(world, s, c.day * 24 + c.hours)
    }
    const tr = s.transition
    if (tr && tick >= tr.endTick) {
      s.transition = undefined
      s.anchorTick = tr.endTick
      s.anchorHours = tr.to
    }
    const total = hoursAt(c, s, tick, dt)
    const day = Math.floor(total / 24)
    c.day = day
    c.hours = total - day * 24
    const previous = s.last
    s.last = day * 24 + c.hours
    if (!Number.isNaN(previous) && Math.floor(previous) !== Math.floor(s.last)) {
      world.send(HourChanged, { hour: Math.floor(c.hours), day })
    }
  },
})
