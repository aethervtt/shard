# 0084 — Authored dice audio

- **Status:** accepted
- **Packages:** `@aethervtt/shard-dice`, `@aethervtt/shard-audio`
- **Depends on:** 0054, 0065, 0077, 0078, 0080

## Context

Dice uses the shared audio backend but selects synthesized clips in code. Hosts need
editable, layered impact and result sounds using their asset catalogs, including database
assets. This connects dice to the existing authored event runtime and audio editor.

## Goals

- Optional event references on skins and sound-accent recipes; unchanged procedural defaults.
- Physics-driven parameters, seeded playback, preparation and cancellation owned by the roll.
- Independent dice mixing without loading an editor into the engine.

## Non-goals

- A separate sound engine, filesystem/URL picker, or Aether application changes.
- Spatial dice audio in this iteration: these presentation events play flat.

## Design

Skin `sounds` gains nullable `impactEvent`, `entranceEvent`, and `resultEvent` handles of
type `audio/AudioEvent`. A `sound-accent` recipe gains an `event` handle which overrides its
procedural cue. Old documents deserialize with null handles. Event documents and clip handles
resolve through the ordinary asset catalog; GUIDs work without disk paths.

Prepare unique referenced events before presentation, retaining their decode leases until
the roll ends. Silent rolls and apps without audio do not fetch audio assets. With audio
enabled, configured events require `audioEventsPlugin`; missing assets, incompatible parameter
contracts or invalid routing fail the roll with a structured error before presentation.
Cancellation during preparation releases leases even if asynchronous preparation finishes later.
Skin and recipe assets retain dependency metadata but defer loading referenced content; the table
already explicitly loads layouts/recipes/fonts, and audible rolls prepare the selected audio.
Simply loading a skin into a silent host therefore does not fetch its event documents or clips.

An impact event replaces the selected procedural hit, including placed and entrance landings.
Contact selection retains the strongest-four-per-frame and 45 ms per-die bounds. Entrance
events play once when an actual entrance scene starts, never for warm-up/skipped/fallback scenes.
Result events replace the skin's landing accent under the existing one-cue budget. Recipe
events take precedence, allowing a high-roll or natural-20 recipe to select a special event.
Reduced motion, effects-off, dropped dice and large-pool rules retain their existing semantics.

Events can declare any subset of these local numeric parameters: `strength` (0..1), `pitch`
(die-size playback ratio), `value` (host result), `high` and `low` (0/1), `count` (physical dice
count), and `contact` (0 tray, 1 die-to-die). Only declared names are supplied; unrelated
parameters keep their authored defaults. Reserved names must be writable numeric parameters;
the runtime clamps to authored bounds. Label selectors can use unrelated authored parameters.

`PlayAudioEventOptions.volume` is a validated nonnegative linear multiplier (default 1),
applied to every layer after envelopes and curves and preserved by checkpoints. Dice applies
`soundGain` here so authors cannot accidentally bypass per-roll volume. Events use explicit
roll-derived seeds. All owned event instances stop immediately on dismiss, replacement,
abort, failure, and disposal. No authored asset is mutated. Event document edits during a roll
fail the next onset with `dice/audio-changed`; the next roll validates and prepares the new
revision, preventing hot edits from bypassing routing or parameter contracts.

Dice creates a `dice` category bus under `master` when audio is present, preserving host definitions.
Procedural dice sounds default to this bus. Authored dice events must route their layers to
`dice` or a descendant, so `setAudioUserBus(world, 'dice', { volume, muted })` controls all of
them. Hosts using an authored mixer include `dice` in its graph (and any sends/sub-buses).
Dice never replaces the host mixer. Custom attachment clip calls retain explicit bus choices.

### API sketch

```ts
const skin = diceSkin({
  id: 'enchanted',
  sounds: {
    impact: 'metal',
    impactEvent: { guid: 'host-impact-event' },
    resultEvent: { guid: 'host-result-event' },
  },
})
// Save/edit those event documents with the existing audio editor and host asset services.
// Set their bus to 'dice'; use a strength curve or high == 1 layer condition.
```

### Agent surface

Schema-generated skin/recipe handles expose the bindings. Existing audio event inspection
reports parameters, selected layers, decisions and lifecycle. Dice reports preparation errors
through its existing lastError/outcome surface. No new protocol family is necessary.

## Decisions

- Preserve generated sounds as defaults; authors opt into shared events.
- Keep contact throttling in dice and sound selection/mixing in audio.
- Dice is a direct child of master: user-control domains require category roots, including tail muting.
- Use asset handles and schema-derived serialization, independent of storage backend.
- Event onsets use existing event-runtime allocations; idle/contact scanning adds none.
- `dice/audio-onsets` budgets four prepared onsets at a proposed 1 ms on laptop/desktop;
  hosted measurements report their own hardware and do not claim named-machine compliance.

## Acceptance criteria

- [ ] Old skins/recipes remain valid; new bindings serialize as typed asset references.
- [ ] Headless tests prove GUID event preparation, parameters, seeds, layer replacement and gain.
- [ ] Tests prove dice bus isolation, flat playback and rejection of incompatible events.
- [ ] Tests prove silent/no-audio behavior and cancellation during preparation, plus lease cleanup.
- [ ] Table integration tests exercise impact/result/recipe/entrance dispatch and legacy defaults.
- [ ] Event gain is validated, applied to all layers, and survives checkpoint restore.
- [ ] CI typecheck, tests, lint, packaging and affected performance checks pass; evidence is recorded.

## Open questions

None. User authorized implementation and green-PR merge.
