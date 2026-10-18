# Authored dice audio

Install `audioPlugin({ backend })` and `audioEventsPlugin()` alongside `dicePlugin()`.
The editor is optional: dice consumes the same `audio/AudioEvent` documents it edits.

Old skins keep their synthesized sounds. To customize a skin, reference host catalog events:

```ts
const skin = diceSkin({
  id: 'enchanted',
  sounds: {
    impact: 'glass',
    impactEvent: { guid: 'my-impact-event' },
    entranceEvent: { guid: 'my-portal-event' },
    resultEvent: { guid: 'my-result-event' },
  },
})
```

These are asset identities, not files or URLs. In Aether, the host's asset adapter supplies
event documents and referenced audio bytes from its database/catalog. Saving an event in
the embedded audio editor and assigning its GUID to a skin is the integration boundary.
Shard does not access Aether's database directly or provide a local-file picker for dice.

Set event `bus` to `dice`, leave layer `bus` empty to inherit, and use flat one-shot layers.
Dice creates this category under `master` without changing existing settings. If the host
loads an authored mixer, include `{ id: 'dice', parent: 'master' }` in that graph. Layer
sub-buses may descend from `dice`; sends can use the host's declared returns. For example,
`setAudioUserBus(world, 'dice', { volume: 0.5 })` turns down dice independently from music
and other sound effects. `{ muted: true }` uses the shared category gate, including effect tails.

An event can declare any subset of these local inputs:

| Parameter | Value supplied by dice |
|---|---|
| `strength` | Contact strength, 0–1; 1 for entrance/result cues |
| `pitch` | Die-size pitch ratio; author a pitch curve to apply it |
| `value` | Host's rolled value, including the full percentile result |
| `high`, `low` | Host flags as 0 or 1 |
| `count` | Number of physical dice on the table |
| `contact` | 0 for tray/landing/cues, 1 for die-to-die impacts |

Use writable numeric parameters (`strength` and `pitch` must be continuous). Authored bounds
clamp values. Unrelated parameters retain their authored defaults. Use `strength` conditions
to select soft/hard layers, no-repeat selectors for variation, and a `high == 1` condition for
an extra celebratory layer. Per-roll `soundGain` multiplies every layer automatically; it
does not require a parameter or curve. Event playback is seeded from the roll.

For a special natural-20 cue, add an event to a conditional sound-accent recipe:

```ts
const recipe = diceEffectRecipe({
  id: 'natural-20',
  conditions: [{ kind: 'die', die: 'd20', value: 20, state: 'kept' }],
  effects: [{ kind: 'sound-accent', event: { guid: 'critical-event' }, gain: 0.8 }],
})
```

Recipe cues take precedence over the skin result cue; one cue plays per roll. Entrance
sounds play when an entrance scene starts, not when warming up or falling back to a drop.
Impact events also replace placed-die and entrance landing knocks. Reduced motion suppresses
presentation audio; effects-off suppresses entrance/result cues but retains tumble impacts.

The roll prepares events and retains their audio leases, then stops owned instances and
releases leases on dismissal, replacement, abort, failure, completion or disposal. Missing
plugins/assets and incompatible event definitions fail preparation through `table.lastError`.
Global audio saturation may drop a transient without failing the roll. Changing a configured
event while a roll is playing follows the shared audio runtime's asset revision semantics;
change bindings between rolls. Use `audio.describe`/event inspection to inspect layer choices,
parameters and playback decisions.

The playground's **enchanted audio** skin is a working example: layered glass impacts,
no-repeat variations, and an extra bass accent for high rolls. Its documents are created in
`apps/playground/src/dice-audio.ts`; the catalog can store equivalent documents in SQLite.
