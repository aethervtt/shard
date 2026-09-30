import {
  defineResource,
  defineSystem,
  type Entity,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { FrameDemand, LogResource, Time } from '@aethervtt/shard-runtime'

// Screen effects (0065): typed requests an app publishes at a point of another app's view, for
// that app to draw (a die setting the table on fire). Lens fields' sibling (0063): CSS pixels,
// ttlMs counted down and refreshed, expiry in core, forwarding between apps. The difference is
// who draws them: a handler the consuming app registered for the kind.

/** Effects `ScreenEffects` holds at once. */
export const MAX_SCREEN_EFFECTS = 8
/** Keys an effect's params may have. */
export const MAX_SCREEN_EFFECT_PARAMS = 8

export type ScreenEffectParams = Record<string, number | string | boolean>

/** An effect another app's view should draw at a screen point (0065). */
export interface ScreenEffect {
  /** What to draw: `fire`, or a kind the consuming app registered. */
  kind: string
  /** Center, in the target's CSS pixels. */
  screen: [number, number]
  /** In CSS pixels. */
  radius: number
  /** Ms it has left: counts down each frame, and refreshing sets it again. At 0 it drops. */
  ttlMs: number
  /** What published it (a die); one effect per (source, kind). */
  source: Entity
  params: ScreenEffectParams
}

export const ScreenEffects = defineResource<{ effects: ScreenEffect[] }>('render/ScreenEffects', {
  hostWritable: true,
  description:
    'Typed effects published at a screen point (at most 8): kind, center and radius in CSS pixels, ms to live, source entity, params. The app whose view they are in draws them through handlers registered with onScreenEffect.',
  init: () => ({ effects: [] }),
})

/** What an app draws for one kind of screen effect. */
export interface ScreenEffectHandler {
  /** An effect of this kind appeared (a new source): spawn what draws it. */
  start(world: World, effect: ScreenEffect): Entity[] | undefined
  /** Each frame it stays live (refreshed), with the frame's seconds. */
  update?(world: World, effect: ScreenEffect, entities: readonly Entity[], dt: number): void
  /** It expired or was cleared. Default: despawn what `start` returned. */
  end?(world: World, effect: ScreenEffect, entities: readonly Entity[]): void
}

interface LiveEffect {
  source: Entity
  kind: string
  handler: ScreenEffectHandler
  entities: Entity[]
  /** The effect as last seen, for `end`. */
  last: ScreenEffect
  seen: boolean
}

/** This app's handlers, the effects they're drawing, and the unhandled kinds already reported. */
export const ScreenEffectHandlers = defineResource<{
  kinds: Map<string, ScreenEffectHandler>
  live: LiveEffect[]
  reported: Set<string>
}>('render/ScreenEffectHandlers', {
  description: 'Handlers by kind (onScreenEffect) and the screen effects they are drawing.',
  init: () => ({ kinds: new Map(), live: [], reported: new Set() }),
})

function invalid(message: string, path: string): ShardError {
  return new ShardError('render/invalid-screen-effect', message, {
    path,
    hint: 'A screen effect has a kind, a radius of at least 0, and at most 8 params.',
  })
}

/**
 * Publishes or refreshes `source`'s effect of this kind. Returns false when `MAX_SCREEN_EFFECTS`
 * others are live. Throws `render/invalid-screen-effect` for an effect without a kind, a negative
 * radius, or more than 8 params.
 */
export function publishScreenEffect(world: World, effect: ScreenEffect): boolean {
  if (!effect.kind) throw invalid('A screen effect needs a kind', 'kind')
  if (!(effect.radius >= 0)) throw invalid(`Radius ${effect.radius} is below 0`, 'radius')
  const keys = Object.keys(effect.params)
  if (keys.length > MAX_SCREEN_EFFECT_PARAMS) {
    throw invalid(`${keys.length} params; at most ${MAX_SCREEN_EFFECT_PARAMS}`, 'params')
  }
  const effects = world.initResource(ScreenEffects).effects
  let i = 0
  while (
    i < effects.length &&
    (effects[i]!.source !== effect.source || effects[i]!.kind !== effect.kind)
  )
    i++
  if (i === MAX_SCREEN_EFFECTS) return false
  const e = effects[i]
  if (e) {
    e.screen[0] = effect.screen[0]
    e.screen[1] = effect.screen[1]
    e.radius = effect.radius
    e.ttlMs = effect.ttlMs
    e.params = effect.params
  } else effects.push({ ...effect, screen: [effect.screen[0], effect.screen[1]] })
  world.touchResource(ScreenEffects)
  return true
}

/** Drops `source`'s effects, or every effect. Publishers call it on dismissal and teardown. */
export function clearScreenEffects(world: World, source?: Entity): void {
  const value = world.tryResource(ScreenEffects)
  if (!value || value.effects.length === 0) return
  if (source === undefined) value.effects.length = 0
  else value.effects = value.effects.filter((e) => e.source !== source)
  world.touchResource(ScreenEffects)
}

const NO_OFFSET = [0, 0] as const

/**
 * Copies `from`'s effects into `to` (another app on the device, 0052), for the host to call each
 * frame, as `forwardLensFields`: copies, each app counting its own down; `offset` is where `to`'s
 * target sits in `from`'s CSS pixels, subtracted from each center.
 */
export function forwardScreenEffects(
  from: World,
  to: World,
  offset: readonly [number, number] = NO_OFFSET,
): void {
  const source = from.tryResource(ScreenEffects)?.effects ?? []
  const out = to.initResource(ScreenEffects).effects
  const n = Math.min(source.length, MAX_SCREEN_EFFECTS)
  for (let i = 0; i < n; i++) {
    const s = source[i]!
    const d = out[i]
    if (d) {
      d.kind = s.kind
      d.radius = s.radius
      d.ttlMs = s.ttlMs
      d.source = s.source
      d.params = s.params
    } else out.push({ ...s, screen: [0, 0] })
    const e = out[i]!
    e.screen[0] = s.screen[0] - offset[0]
    e.screen[1] = s.screen[1] - offset[1]
  }
  if (out.length === 0 && n === 0) return
  out.length = n
  to.touchResource(ScreenEffects)
}

/**
 * Registers what this app draws for a kind of screen effect: `start` when one appears, `update`
 * while it's refreshed, `end` when it expires (default: despawn what `start` returned).
 */
export function onScreenEffect(world: World, kind: string, handler: ScreenEffectHandler): void {
  world.initResource(ScreenEffectHandlers).kinds.set(kind, handler)
}

/** The frame demand live effects hold, so they expire on time and the app idles after (0052). */
export const SCREEN_EFFECTS_DEMAND = 'render/screen-effects'

export const expireScreenEffects = defineSystem({
  name: 'render/expire-screen-effects',
  description:
    'Counts ScreenEffects down by the frame time and drops expired ones; holds frames while any live.',
  run: (_, world) => {
    const effects = world.tryResource(ScreenEffects)?.effects
    let n = 0
    if (effects && effects.length > 0) {
      const ms = world.resource(Time).delta * 1000
      for (let i = 0; i < effects.length; i++) {
        const e = effects[i]!
        e.ttlMs -= ms
        // Bounded, whatever a host patched in.
        if (e.ttlMs > 0 && n < MAX_SCREEN_EFFECTS) effects[n++] = e
      }
      effects.length = n
    }
    const live = world.tryResource(ScreenEffectHandlers)?.live.length ?? 0
    world.tryResource(FrameDemand)?.set(SCREEN_EFFECTS_DEMAND, n > 0 || live > 0)
  },
})

function despawnAll(world: World, entities: readonly Entity[]): void {
  for (const e of entities) if (world.isAlive(e)) world.despawn(e)
}

/**
 * Starts, updates and ends this app's handlers as effects appear, stay and go. An effect of a kind
 * nobody registered is dropped and logged once per kind (`render/unhandled-screen-effect`).
 * Allocates only when an effect starts.
 */
export const runScreenEffects = defineSystem({
  name: 'render/screen-effects',
  description: 'Runs the handlers registered with onScreenEffect for live ScreenEffects.',
  run: (_, world) => {
    const handlers = world.tryResource(ScreenEffectHandlers)
    const effects = world.tryResource(ScreenEffects)?.effects
    if (!handlers || (handlers.live.length === 0 && (!effects || effects.length === 0))) return
    const live = handlers.live
    for (let i = 0; i < live.length; i++) live[i]!.seen = false
    const dt = world.resource(Time).delta
    if (effects) {
      for (let i = 0; i < effects.length; i++) {
        const e = effects[i]!
        let found: LiveEffect | undefined
        for (let j = 0; j < live.length; j++) {
          const l = live[j]!
          if (l.source === e.source && l.kind === e.kind) {
            found = l
            break
          }
        }
        if (found) {
          found.seen = true
          found.last = e
          found.handler.update?.(world, e, found.entities, dt)
          continue
        }
        const handler = handlers.kinds.get(e.kind)
        if (!handler) {
          if (!handlers.reported.has(e.kind)) {
            handlers.reported.add(e.kind)
            world.tryResource(LogResource)?.log('warn', `No handler draws "${e.kind}" effects`, {
              code: 'render/unhandled-screen-effect',
              hint: 'Register one in this app with onScreenEffect(world, kind, handler).',
            })
          }
          continue
        }
        live.push({
          source: e.source,
          kind: e.kind,
          handler,
          entities: handler.start(world, e) ?? [],
          last: e,
          seen: true,
        })
      }
    }
    let kept = 0
    for (let i = 0; i < live.length; i++) {
      const l = live[i]!
      if (l.seen) {
        live[kept++] = l
        continue
      }
      if (l.handler.end) l.handler.end(world, l.last, l.entities)
      else despawnAll(world, l.entities)
    }
    live.length = kept
  },
})

/** For render.describe: live effects, and which kinds this app draws. */
export function describeScreenEffects(world: World) {
  const handlers = world.tryResource(ScreenEffectHandlers)
  return {
    effects: (world.tryResource(ScreenEffects)?.effects ?? []).map((e) => ({
      ...e,
      screen: [...e.screen],
    })),
    kinds: handlers ? [...handlers.kinds.keys()].sort() : [],
    drawing: (handlers?.live ?? []).map((l) => ({
      kind: l.kind,
      source: l.source,
      entities: l.entities.length,
    })),
  }
}
