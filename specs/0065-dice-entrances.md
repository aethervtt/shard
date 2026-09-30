# 0065 — Dice entrances and screen effects

- **Status:** accepted
- **Packages:** `@aethervtt/shard-dice`, `@aethervtt/shard-render`, `apps/playground`
- **Depends on:** 0054, 0063, 0026, 0035

## Context

0054 plays every die the same way: a recorded physics tumble, then effects once the dice have
landed. Aether's premium skins want some results to arrive differently. The Elderflame d20, on a
natural 20, shouldn't roll at all: a fire dragon's head rises and breathes fire, and where the
flames hit, at the peak, the d20 appears in flames with the 20 up, and the map catches fire. A
natural 1 might fizzle instead. The pattern will be reused widely: special arrivals on natural 20s
and 1s, keyed by skin and die.

Two things are missing. A die can't skip its tumble and arrive through a host scene that decides
when it lands. And the dice can only ask the table under them for one thing, a lens field (0063),
which bends pixels; they can't ask it to burn, freeze or glow.

Everything needed to decide an entrance is known before anything moves: the host supplies the
values, and effect recipes (0054) read only the roll. So the table can choose entrances at `play()`,
record physics for the other dice, and hand the chosen dice to their scenes.

## Goals

- **Entrances:** a recipe effect that takes a die out of the physics and brings it in through a
  registered host scene (models, particles, sound), which lands it at a moment it chooses, target up
  and readable, where the table tells it to.
- Reuse: one entrance serves many skins, with parameters from the recipe and colors from the die's
  own material.
- **Screen effects:** typed, bounded requests (`fire`, or a host's own kind) that the dice publish at
  a screen point and a host's table app renders, beside lens fields and with the same lifecycle.
- Entrances are cosmetic, and a roll never fails or stalls because of one: a missing asset or a
  slow load places the die instead.

## Non-goals

- A die's entrance that ends in a physical throw (the dragon spits the die, which then tumbles).
  Deferred: the entrance lands the die itself.
- An engine fire renderer on the table. The table is the host's; the playground ships a reference
  `fire` consumer.
- Moving other dice. An entrance owns its die and its scene, nothing else.

## Design

### Declaring an entrance

A recipe effect names a registered entrance: `{ kind: 'entrance', entrance: 'meteor', params }`.
Like `attachment`, it applies to the recipe's anchors: the kept dice that meet its die conditions,
whose skin carries the recipe. `params` is a small JSON object (at most 16 keys) the scene reads,
so one entrance serves many skins. Other effects in the same recipe play when that die lands.

```ts
defineDiceEntrance('meteor', {
  vertices: 20_000,                     // declared and held to (default budget 60,000)
  durationMs: 3200,                     // the whole scene, at most 8,000
  landAtMs: 1400,                       // when the die lands: at most durationMs
  spot: 'center',                       // where it wants the die: 'center', or [u, v] in −1..1 of the tray
  assets: [meteorMesh, fireTexture],    // loaded before it plays
  spawn(ctx) { return [...] },          // the scene; the table despawns it
  update(ctx, seconds, entities) {      // every frame from its start; false ends it early
    if (seconds < ctx.landAt) ctx.pose(...)   // the die in flight (or hidden until it appears)
    return true
  },
})
```

### Choosing, before the physics

At `play()`, once the skins load, the table matches recipes (0054's `matchRecipes`, moved from the
accent phase to here; the accent reuses the result). Dice anchored by an `entrance` effect become
**entrance dice**, at most 2 per roll in roll order; extra matches tumble. No entrances play in
reduced motion, with effects off, or in the balanced and large-pool tiers: their dice are physical
as today, and `dice.describe` says why.

The track request (0054 `rollTrackRequest`) leaves entrance dice out: the other dice tumble without
them. A roll with no physical dice records nothing. The set of entrance dice is a function of the
roll, its skins and its settings, so every viewer with the same inputs records the same track and
picks the same rest spots.

### The rest spot

Once the track is recorded, the table knows where the physical dice end. It gives each entrance die
a rest pose: the free grid spot (0054's placement grid) nearest the entrance's `spot`, clear of the
other dice's final footprints, with the target up and the readable twist (0054 `restRotation`) and
the resting height. The scene gets it as `ctx.rest` before it spawns, so it can aim at it.

### The timeline

Phases gain `entrance`: `simulating → tumble → entrance → accent → rest`. Entrances start when the
physical dice have landed (at once when there are none), one after another. Each runs on its own
clock:

- **Before `landAt`:** the die exists but is hidden (`Visibility: hidden`) unless the scene shows or
  poses it (`ctx.show`, `ctx.pose`). Its material's `result` is 0.
- **At `landAt`:** the table snaps the die to its rest pose and shows it, sets its `result` ramp and
  `resultTime` (0054), plays its impact (the skin's impact sound, `strength` from the entrance,
  default 0.8), and starts the other effects of the recipe that chose the entrance, anchored there.
- **After `landAt`:** the scene keeps its entities until `durationMs`, or until `update` returns
  false, then they're despawned. The next entrance starts at the previous one's `landAt`.

When the last entrance die lands, the accent phase runs the other recipes as today (0054). The
presentation holds its frame demand while an entrance plays.

An entrance die draws with its own material (the look key gains `entrance`), so its `result` and
`resultTime` are its own: a family reacts when that die lands, not when the others did. The scene
can set its own die's family fields with `ctx.material({ ... })` (not the reserved dice fields), to
make it glow while it's carried, or catch fire before it lands.

### The context

```ts
interface DiceEntranceContext {
  world: World
  die: Entity; kind: DieKind; value: number; label: string; scale: number
  params: Record<string, unknown>            // from the recipe effect
  rest: { position: Vec3; rotation: Quat }   // where it lands
  landAt: number                             // seconds
  seed: number                               // from the roll: variation, the same for every viewer
  camera: Entity                             // the dice camera
  soundGain: number
  skipped: boolean                           // the host skipped: land at once, wind down
  pose(position: Vec3, rotation: Quat, scale?: number): void
  show(visible: boolean): void
  material(fields: Record<string, unknown>): void
  screen(point?: Vec3): [number, number] | null  // CSS pixels in the dice view (default: the rest spot)
  sound(clip: AssetRef | AudioClipAsset, options?: PlaySoundOptions): number   // × soundGain
  cue(cue: AccentCue, gain?: number): void
  lens(field: { radius: number; strength: number; ttlMs?: number }): boolean   // 0063, on the rest spot
  effect(effect: { kind: string; radius: number; ttlMs?: number; params?: ScreenEffectParams;
                   at?: Vec3 }): boolean                                        // below
}
```

Attachments (0054) get `camera`, `screen`, `effect`, `sound` and `seed` too, so an attachment on a
landed die can set the map on fire as well.

**Windows.** Both kinds of scene draw effects on camera-facing quads. The package exports what the
playground's cosmic dice proved: `spawnDiceWindow(ctx, material, { x, y, width, height, turn,
lift })` places a quad facing the dice camera over the die, in die radii, `lift` die radii toward
the camera, moved along the line from the camera and scaled by how much nearer it got, so windows
at different depths line up wherever the die is.

### Skipping, cancelling, failing

- `dice.skip()` (and the `dice.skip` method) lands every playing or waiting entrance now:
  `ctx.skipped` turns true, the die snaps to its rest pose, and scenes get 400 ms to wind down.
- Dismissal, replacement, cancellation, device loss and disposal despawn the scene with the dice,
  stop its sounds and clear its lens fields and screen effects.
- An entrance that isn't registered, whose assets fail to load, or that isn't loaded 1,500 ms after
  the physics is ready, doesn't play: its die drops into its rest spot (0054's placed drop) with
  its recipe's other effects, and `dice/entrance-unavailable` is logged once per entrance.

### Budgets and first frames

`dicePlugin({ budgets: { attachmentVertices = 12_000, entranceVertices = 60_000, entranceMs =
8_000 } })`. A definition over its budget throws `dice/entrance-budget` at `defineDiceEntrance`; a
scene that spawns more than it declared is ended at spawn, as attachments are.

A scene's first frame mustn't compile. While the worker records, the table loads the entrance's
`assets`, spawns its scene hidden and draws it once to an offscreen target on the app's device (as
`renderDiceThumbnail` does), so its pipelines and uploads are ready, then despawns that copy.

### Screen effects

```ts
ScreenEffects (resource) {
  effects: { kind: string; screen: Vec2; radius: f32; ttlMs: f32; source: Entity;
             params: ScreenEffectParams }[]            // at most 8
}
type ScreenEffectParams = Record<string, number | string | boolean>   // at most 8 keys

publishScreenEffect(world, effect): boolean            // publishes or refreshes (source, kind)
clearScreenEffects(world, source?)
forwardScreenEffects(from, to, offset?)                // as forwardLensFields
onScreenEffect(world, kind, {                          // in the consuming app
  start(world, effect): Entity[]                       // when a (source, kind) first appears
  update?(world, effect, entities, dt): void           // while it's refreshed
  end?(world, effect, entities): void                  // when it expires; default despawns
})
```

They're lens fields' sibling in `@aethervtt/shard-render`: in CSS pixels of the target, `ttlMs`
counted down and refreshed, expired in core with a frame demand while live, forwarded between apps
with an origin offset. The difference is who draws them: lens fields feed the engine's `post/lens`
pass; a screen effect goes to whatever the consuming app registered for its kind. A kind nobody
registered is dropped and logged once (`render/unhandled-screen-effect`). Reduced motion, effects
off, the large-pool tier, a hidden document and disposal clear the dice's effects, as they do lens
fields.

The playground registers `fire` on its table: it maps the screen point onto the table plane (0057's
`screenToPlane`; until then the camera's `invViewProj`), and spawns flames (0026 particles), a
flickering light and a scorch mark sized from `radius`; on `end` the flames die down over a second
and the scorch fades over ten.

### Demo

The dice page gains an `inferno` skin: an animated family whose flames lick up the die and burn
brightest on its top face from `resultTime`. On a natural 20 its `meteor` entrance drops the d20
from above the page as a burning meteor (a trail on a camera-facing window, sparks), strikes its
rest spot with a flash and a shockwave, lands it in flames, and sets the table on fire around it
(`fire`). On a natural 1, `fizzle` drops it with a sputter and a puff of smoke, and leaves a small
scorch. Rolled with other dice (advantage, 2d20 + 1d6), the others tumble first. A "skip" button
calls `dice.skip()`.

### Agent surface

- `dice.describe` adds `entrances`: `{ name, die, state: 'waiting' | 'playing' | 'landed' |
  'done', seconds, landAtMs, durationMs, rest, fallback: reason | null }`, and why a matched entrance
  didn't play (tier, reduced motion, effects off, over 2); and the dice's `screenEffects`.
- `dice.skip` through the protocol. `render.describe` lists live screen effects and their handlers.
- **Errors:** `dice/entrance-budget`, `dice/entrance-unavailable` (logged, not thrown),
  `dice/registry-conflict` (a name defined twice), `dice/recipe-bounds` for entrance params over 16
  keys, `render/unhandled-screen-effect`.

## Decisions

- **Choose entrances at `play()`, not after landing.** A die with an entrance mustn't be in the
  physics at all: other dice would bounce off a body that isn't there. Recipes read only the roll,
  so the choice can move to the start.
- **Tracks depend on which dice have entrances.** 0054's tracks don't depend on values; a roll with
  an entrance does, through the set of physical dice. Every viewer still gets the same track from the
  same inputs; only recording before the result is known is lost, and only for such rolls.
- **Entrances play after the tumble, one at a time.** A climax reads best alone, and landing spots
  are only known to be free once the others have landed.
- **The table owns the landing.** The scene chooses when; the table decides where and how (target
  up, readable twist), so a scene can't show a wrong or unreadable result.
- **Entrance dice get their own material.** `result` and `resultTime` are per material in 0054, and
  an entrance die lands later than dice that share its kind and skin.
- **Screen effects beside lens fields, not replacing them.** Lens fields are consumed by an engine
  pass with bounds of their own and are implemented; screen effects are consumed by host code. One
  lifecycle, two consumers; merging them can come later.
- **Fallback to the placed drop.** A cosmetic scene that can't play mustn't cost the player their
  result or a stalled roll.

## Acceptance criteria

- [ ] A roll of a d20 at 20 with an `inferno` skin and a d6: the track's request holds only the d6;
      the d6 tumbles, then the meteor plays; at `landAtMs` the d20 is at its rest pose with 20 up,
      within the readable bound (0054), not overlapping the d6, and the recipe's other effects start
      then, not before.
- [ ] The same roll records the same track hash inline and in the worker, and the same rest spot.
- [ ] No entrance plays in reduced motion, with effects off, or in the balanced or large-pool tiers;
      the die is physical (or placed) as in 0054, and `dice.describe` gives the reason. A third
      matching die in one roll tumbles.
- [ ] The entrance die's `resultTime` is its own landing time; dice of the same kind and skin that
      landed earlier keep theirs.
- [ ] `dice.skip()` lands a playing entrance within one frame, target up; dismissing or cancelling
      mid-entrance leaves no entrance entities, no screen effects and no held frame demand.
- [ ] An entrance whose asset fails to load, or loads after 1,500 ms, drops its die into its rest spot
      instead, logs `dice/entrance-unavailable` once, and the roll finishes.
- [ ] An entrance definition over its vertex budget throws `dice/entrance-budget`.
- [ ] The first frame of an entrance compiles no pipeline (the scene was drawn once offscreen while
      the worker recorded).
- [ ] A screen effect published in one app and forwarded to another starts its handler once, updates
      it while refreshed, and ends it `ttlMs` after the last refresh; the consuming app goes idle
      after. An unregistered kind logs `render/unhandled-screen-effect` once.
- [ ] In the dice page, the meteor's natural 20 sets the table on fire around the die, and the fire
      dies down after the roll; `renderer-min` stays within its size budget.

## Open questions

- ~~Should entrances be allowed in the balanced tier?~~ No, until measured; a 13–16 die roll with a
  natural-20 entrance is rare.
- ~~Should an entrance be able to end in a physical throw of its die (a short recorded track from
  the scene's release pose)?~~ Deferred: it needs 0053 to record from a supplied starting pose.
- ~~Should lens fields become a kind of screen effect (`lens`), with `post/lens` its engine
  handler?~~ Deferred until screen effects have a second engine consumer.
