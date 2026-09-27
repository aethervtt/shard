# 0050 — Soundscapes and procedural audio

- **Status:** accepted
- **Packages:** `@aethervtt/shard-audio`, `@aethervtt/shard-procgen`, `@aethervtt/shard-platform`, `@aethervtt/shard-platform-web`,
  `@aethervtt/shard-weather`, `@aethervtt/shard-creatures`
- **Depends on:** 0035, 0042, 0043, 0046, 0048, 0049

## Context

A generated planet that is silent, or plays the same forest loop everywhere, breaks the illusion
fast. The proof project needs ambience that follows the world: wind that rises on ridges and in
storms, rain on the ground and on the ship's hull, insects at dusk in a jungle, distant calls from
the planet's own creatures, a muffled world underwater, and thunder after lightning. VISION's row
is "Ambience: spatial audio, procedural soundscapes". 0035 deferred effects, reverb zones, and
"audio from procedural sources".

Soundscapes are a rules problem that agents are good at, like scatter. Layers are chosen by biome,
weather, time of day, altitude, and whether you're under cover, then mixed and spatialized
around the listener. The sounds themselves can be generated. Each species gets a unique call
synthesized from its params, and wind and rain beds are synthesized noise. Generated sounds are
0042 generators with a new `audio` output, rendered to PCM on workers, cached, and deterministic.

## Goals

- `Soundscape` data assets: **beds** (continuous loops whose gain and filter follow parameters)
  and **spots** (one-shots placed around the listener by density, distance, and time windows),
  selected per biome with overrides per weather and environment.
- A parameter set sampled every frame from the world: biome weights under the listener, time of
  day, wind, precipitation, altitude, underwater, sheltered, indoor, and the nearest creature
  species. Projects add their own.
- Procedural sound generators (`audio` output for 0042): synthesized creature calls, wind, rain,
  surf, insects, and a small DSP toolkit for writing more.
- Effects: per-bus and per-voice low-pass and high-pass filters, a reverb send with generated
  impulse responses, and `ReverbZone` components (cave, hangar, open field).
- Environment transitions: diving underwater muffles everything, entering a cave adds reverb,
  and stepping inside a ship dulls the storm and adds rain on the hull.
- Thunder from 0049's lightning with distance delay, and creature calls from 0048's behaviors
  (alarm, contact, and idle calls).
- Everything visible in 0035's headless voice log, so tests can assert "dusk in a jungle plays
  insects and not birds".

## Non-goals

- Music systems (adaptive music, stingers). They're a later spec. Soundscapes are diegetic ambience.
- Real-time synthesis in an AudioWorklet. Sounds render to PCM clips offline on workers, which is
  deterministic, headless-friendly, and costs no audio-thread CPU.
- Physically modelled sound propagation (occlusion beyond 0035's gain hook plus sheltered and
  indoor filtering).

## Design

### Soundscape files

```json
{
  "$schema": "../../.shard/schemas/soundscape.schema.json",
  "beds": [
    { "name": "wind", "clip": { "generator": "shard/Wind", "params": { "roughness": 0.4 } },
      "gain": { "param": "wind", "curve": [[0, 0.1], [10, 0.6], [25, 1]] },
      "lowpass": { "param": "sheltered", "curve": [[0, 18000], [1, 900]] } },
    { "name": "jungle-day", "clip": { "path": "audio/ambience/jungle-day.ogg" },
      "when": { "biome": "jungle", "time": [6, 18] }, "fade": 8 }
  ],
  "spots": [
    { "name": "birds", "clips": [{ "path": "audio/birds/*.ogg" }], "rate": 0.2,
      "distance": [10, 60], "height": [3, 20], "when": { "biome": "forest", "time": [5, 20],
      "precipitation": "none" } },
    { "name": "fauna", "source": "creature-calls", "rate": 0.05, "distance": [40, 300] }
  ],
  "overrides": [
    { "when": { "underwater": true }, "bus": "ambience", "lowpass": 600, "gain": 0.6,
      "beds": [{ "clip": { "generator": "shard/Underwater" } }] }
  ]
}
```

- `Soundscape` is a data type (0031). A planet's `Biome` (0043) references one, and a global
  soundscape (on the planet or in `shard.json`) layers under all of them. Soundscapes can
  `$extends` others.
- **Beds** loop on the `ambience` bus (new default bus). `when` gates them, with a `fade` in
  seconds. `gain`, `lowpass`, `highpass`, and `pitch` can each follow a parameter through a
  piecewise curve. Biome beds are weighted by the listener's biome weights, so crossing a border is
  a crossfade.
- **Spots** are one-shots at random positions around the listener: azimuth uniform, `distance`
  and `height` ranges relative to the ground, and `rate` per second as a Poisson process. They're
  seeded from `hashSeed(planetSeed, spot, window)`, so a replay hears the same thing. A spot's clip
  list can hold generator items with `variants`.
- `"source": "creature-calls"` draws from 0048's fauna for the biome, playing their calls at
  plausible distances, so you hear a species before you see it.
- **Overrides** apply when their condition holds (priority by order). They can filter or duck
  buses and add beds. Underwater, indoor, and cave overrides ship in the default global soundscape.
- Clip paths accept globs (`audio/birds/*.ogg`), expanded at import.

### Parameters

```ts
SoundscapeParams (resource): { values: Record<string, number>, biome: Record<string, number> }
```

- `audio/soundscape-params` runs in PostUpdate. It samples `timeOfDay` (0046 local solar hours),
  `wind`, `precipitation` and `intensity` (0049 `weatherAt`), `altitude` (0043 height above
  terrain), `underwater`, `sheltered` (0049 occlusion map), `indoor` (inside a `ReverbZone` with
  `indoor: true`), `speed` (listener velocity), and biome weights under the listener. Values are
  smoothed with a per-param time constant.
- Projects set their own values with `setSoundscapeParam(world, 'alarm', 1)`.

### Procedural sound generators

- 0042 gains an `audio` output: `{ sampleRate, channels, data: Float32Array[] , loop?: [start,
  end] }`. It becomes an `AudioClip` (encoded as WAV in the cache).
- `@aethervtt/shard-audio` ships a DSP toolkit for generator code: oscillators (sine, saw, square, and
  band-limited), noise (white, pink, and brown), ADSR and breakpoint envelopes, biquad filters,
  formant filter banks, FM operators, a delay, waveshaping, and a seamless-loop builder (crossfade
  the tail into the head). It's plain TypedArray code on the worker, deterministic, and seeded
  through `ctx.rng`.
- Engine generators:

| Generator | Output | Key params |
|---|---|---|
| `shard/CreatureCall` | one-shot | size, pitch, harmonicity, formants (vowel-ish), chirps, trill, roughness, kind (`idle`, `alarm`, `contact`, `pain`) |
| `shard/Wind` | 20 s loop | roughness, whistle, gustiness |
| `shard/Rain` | 20 s loop | intensity, surface (`ground`, `leaves`, `metal`, `water`) |
| `shard/Surf` | 30 s loop | wave period, size |
| `shard/Insects` | 20 s loop | density, pitch, pulse rate |
| `shard/Underwater` | 20 s loop | depth, bubbles |
| `shard/Thunder` | one-shot | distance (filters highs, lengthens rumble), intensity |
| `shard/ImpulseResponse` | IR | room size, decay, damping, early reflections |

- `shard/CreatureCall`'s params come from the species (0048). Size lowers pitch and slows
  articulation, temperament shapes roughness, and each species gets idle, alarm, and contact calls
  with `variants`. Calls are cached per species, so a planet's fauna generates its voices once.

### Effects (0035 extensions)

- `AudioBackend` gains `setBusFilter(bus, { lowpass, highpass })`, per-voice `filter` in
  `AudioVoiceParams`, and `setReverb(bus, { ir, send })`. Web Audio uses `BiquadFilterNode` and a
  `ConvolverNode` per reverb, shared per zone type. The headless backend records filter and reverb
  state per voice and applies the same gain math in `measure`, so tests see muffling as numbers.
- `ReverbZone { ir: handle('AudioClip'), send: f32, indoor: bool, shape: 'box' | 'sphere', size:
  vec3, blend: f32 }`: the listener's position blends the sends of the zones it's inside. 0043
  terrain can mark caves in future, and ships and buildings put zones in their prefabs.
- `AudioSource` gains `lowpass` and `highpass` fields (0035's component and schema are updated).

### Thunder and events

- On `LightningStrike` (0049), the soundscape schedules `shard/Thunder` (with a variant by distance
  band) at `time + distance / speedOfSound`, positioned at the strike.
- On 0048's `CreatureNoticed` and flee transitions, the creature plays its alarm call from its
  position. Idle calls play at a species rate while the creature is active. Herds answer with
  contact calls.

### Agent surface

- `audio.describe` gains the soundscape: active beds with gain and filter values and the params
  that set them, recent spots, active overrides, reverb sends, and every param value.
- `soundscape.preview { soundscape, params, seconds }` renders an offline mix (headless) to a WAV
  and returns a per-layer loudness timeline in JSON, so an agent can check a mix without ears.
- `procgen.preview` of an `audio` generator returns a spectrogram PNG plus the WAV, and a contact
  sheet over seeds shows nine spectrograms. That's how an agent tunes a creature's voice.
- `.shard/schemas/soundscape.schema.json`, and `.agents/audio.md` gets a soundscape section
  listing the built-in params and generators.
- MCP tools: `describe_soundscape`, `preview_soundscape`, `set_soundscape_param`.
- **Errors:** `soundscape/unknown-param`, `soundscape/bad-curve` (not monotonic in x),
  `audio/generator-not-audio`, `soundscape/empty-glob`.

## Decisions

- **Rules as data, like scatter.** Agents are good at "insects at dusk in jungles, wind louder on
  ridges", and curves over named params make it one file per biome.
- **Offline synthesis to clips.** It's deterministic, cached, testable headless, and free at runtime.
  Real-time synthesis would need AudioWorklets, a second code path for headless, and audio-thread
  budgets.
- **Creature calls from species params.** Every generated animal gets a matching, unique voice with
  no audio authoring, which is the point of a procedural fauna.
- **Filters and reverb in the backend interface.** Muffling underwater and indoors is the most
  noticeable environmental cue, and it has to be observable headless like the rest of 0035.

## Acceptance criteria

- [ ] On the example planet, a headless run at jungle dusk logs insect spots and the jungle bed and
      no bird spots. At noon in rain, it logs rain beds and no insects (voice log assertions).
- [ ] Crossing from forest to desert crossfades beds over the biome transition, with no voice
      starting or stopping abruptly (gain envelope continuity in the log).
- [ ] Diving underwater lowers the ambience bus low-pass to ≤ 800 Hz within 0.3 s and starts the
      underwater bed. Leaving restores it.
- [ ] A `shard/CreatureCall` for the same species params renders bitwise-identical PCM on Node,
      Chrome, and Tauri. Nine seeds produce distinguishable spectrograms (pairwise spectral
      distance above a threshold).
- [ ] Generated loops are seamless: the crossfaded loop point has no discontinuity (sample
      delta below the signal's median delta × 4).
- [ ] Thunder for a strike 3.4 km away starts 9.9 ± 0.1 s after the strike, and a nearer strike's
      thunder has more high-frequency energy (spectrogram band check).
- [ ] Inside a `ReverbZone` with `indoor: true`, the storm's rain bed switches to the `metal`
      variant and the wind bed's low-pass drops. The headless `measure` reports both.
- [ ] Soundscape evaluation costs ≤ 0.2 ms per frame on the main thread with 12 beds and 8 active
      spots.

## Open questions

- Should caves be detected automatically (occlusion map plus enclosure raycasts) instead of needing
  `ReverbZone`s? Proposed: later, when caves exist (0043 has none yet).
- None blocking. Deferred: adaptive music, real-time synthesis, and sound propagation through
  geometry.
