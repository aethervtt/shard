import { type Entity, Last, PreUpdate } from '@aethervtt/shard-core'
import { App, FrameDemand, LogResource } from '@aethervtt/shard-runtime'
import { describe, expect, it } from 'vitest'
import {
  clearScreenEffects,
  expireScreenEffects,
  forwardScreenEffects,
  MAX_SCREEN_EFFECTS,
  onScreenEffect,
  publishScreenEffect,
  runScreenEffects,
  SCREEN_EFFECTS_DEMAND,
  type ScreenEffect,
  ScreenEffectHandlers,
  ScreenEffects,
} from './screen-effects'

const effect = (source: number, over: Partial<ScreenEffect> = {}): ScreenEffect => ({
  kind: 'fire',
  screen: [32, 24],
  radius: 40,
  ttlMs: 1000,
  source: source as Entity,
  params: {},
  ...over,
})

async function effectsApp() {
  const app = new App()
  app.world.initResource(ScreenEffects)
  app.world.initResource(ScreenEffectHandlers)
  app.addSystems(PreUpdate, runScreenEffects)
  app.addSystems(Last, expireScreenEffects)
  await app.init()
  return app
}

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return (err as { code: string; path?: string }).code
  }
  return 'ok'
}

describe('ScreenEffects (0065)', () => {
  it('refreshes (source, kind) in place, holds at most 8, clears by source, and rejects bad effects', async () => {
    const app = await effectsApp()
    const w = app.world
    for (let s = 1; s <= MAX_SCREEN_EFFECTS; s++)
      expect(publishScreenEffect(w, effect(s))).toBe(true)
    expect(publishScreenEffect(w, effect(99))).toBe(false)
    // The same source may hold another kind only if there's room; refreshing its fire replaces it.
    expect(publishScreenEffect(w, effect(2, { radius: 90, params: { heat: 2 } }))).toBe(true)
    const effects = w.resource(ScreenEffects).effects
    expect(effects).toHaveLength(MAX_SCREEN_EFFECTS)
    expect(effects[1]).toMatchObject({ source: 2, radius: 90, params: { heat: 2 } })
    clearScreenEffects(w, 2 as Entity)
    const left = w.resource(ScreenEffects).effects.map((e) => e.source)
    expect(left).toHaveLength(MAX_SCREEN_EFFECTS - 1)
    expect(left).not.toContain(2)
    expect(publishScreenEffect(w, effect(2, { kind: 'frost' }))).toBe(true)
    expect(w.resource(ScreenEffects).effects.at(-1)).toMatchObject({ source: 2, kind: 'frost' })
    clearScreenEffects(w)
    expect(w.resource(ScreenEffects).effects).toEqual([])
    expect(code(() => publishScreenEffect(w, effect(1, { kind: '' })))).toBe(
      'render/invalid-screen-effect',
    )
    expect(code(() => publishScreenEffect(w, effect(1, { radius: -1 })))).toBe(
      'render/invalid-screen-effect',
    )
    const params = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, i]))
    expect(code(() => publishScreenEffect(w, effect(1, { params })))).toBe(
      'render/invalid-screen-effect',
    )
    await app.dispose()
  })

  it('starts a handler once, updates it while refreshed, and ends it ttlMs after the last refresh', async () => {
    const app = await effectsApp()
    const w = app.world
    const calls: string[] = []
    let spawned: Entity | undefined
    onScreenEffect(w, 'fire', {
      start(world, e) {
        calls.push(`start ${e.radius}`)
        spawned = world.spawn()
        return [spawned]
      },
      update(_, e, entities, dt) {
        calls.push(`update ${e.radius} ${entities.length} ${dt > 0}`)
      },
    })
    const demand = w.resource(FrameDemand)
    publishScreenEffect(w, effect(1, { ttlMs: 90 }))
    app.update(1 / 60)
    expect(calls).toEqual(['start 40'])
    expect(demand.isHeld(SCREEN_EFFECTS_DEMAND)).toBe(true)
    publishScreenEffect(w, effect(1, { ttlMs: 90, radius: 60 }))
    app.update(1 / 60)
    expect(calls.at(-1)).toBe('update 60 1 true')
    // No refresh: it expires ~90 ms later, and the default end despawns what start spawned.
    for (let i = 0; i < 8; i++) app.update(1 / 60)
    expect(w.resource(ScreenEffects).effects).toHaveLength(0)
    expect(w.isAlive(spawned!)).toBe(false)
    expect(calls.filter((c) => c.startsWith('start'))).toHaveLength(1)
    app.update(1 / 60)
    expect(demand.isHeld(SCREEN_EFFECTS_DEMAND)).toBe(false)
    expect(w.resource(ScreenEffectHandlers).live).toHaveLength(0)
    await app.dispose()
  })

  it('forwards copies into another app, whose handler draws them; a kind nobody handles logs once', async () => {
    const dice = await effectsApp()
    const table = await effectsApp()
    const ended: number[] = []
    onScreenEffect(table.world, 'fire', {
      start: () => [],
      end: (_, e) => {
        ended.push(e.screen[1])
      },
    })
    publishScreenEffect(dice.world, effect(7, { ttlMs: 100 }))
    publishScreenEffect(dice.world, effect(8, { kind: 'confetti', ttlMs: 100 }))
    // The table's canvas sits 40 CSS pixels down and 10 across in the dice's.
    forwardScreenEffects(dice.world, table.world, [10, 40])
    const copied = table.world.resource(ScreenEffects).effects
    expect(copied.map((e) => [e.kind, e.screen[0], e.screen[1]])).toEqual([
      ['fire', 22, -16],
      ['confetti', 22, -16],
    ])
    expect(copied[0]).not.toBe(dice.world.resource(ScreenEffects).effects[0])
    for (let i = 0; i < 3; i++) table.update(1 / 60)
    const warnings = table.world
      .resource(LogResource)
      .tail(50, 'warn')
      .filter((e) => e.code === 'render/unhandled-screen-effect')
    expect(warnings).toHaveLength(1)
    expect(table.world.resource(ScreenEffectHandlers).live.map((l) => l.kind)).toEqual(['fire'])
    // The host stops forwarding: the table's copies expire on their own and the handler ends.
    for (let i = 0; i < 10; i++) table.update(1 / 60)
    expect(ended).toEqual([-16])
    expect(table.world.resource(FrameDemand).isHeld(SCREEN_EFFECTS_DEMAND)).toBe(false)
    await dice.dispose()
    await table.dispose()
  })
})
