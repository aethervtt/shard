# 0078 — Audio mixers, snapshots, effects and acoustics

- **Status:** implemented
- **Packages:** `@aethervtt/shard-audio`, `@aethervtt/shard-platform`,
  `@aethervtt/shard-platform-web`, `@aethervtt/shard-project`, `apps/cli`, `apps/playground`
- **Depends on:** 0077, 0031, 0038, 0040, 0062, 0074, 0075

## Context

0035's bus hierarchy multiplies gains but every Web Audio bus connects directly to output.
It cannot put a filter on a parent bus, share a reverb return, or blend an underwater mix with
a dialogue mix. 0050 proposes these effects for planets; they also belong in Aether rooms,
ordinary games, menus and cinematics, independently of procedural-world dependencies.

This spec supplies the shared mixer and lightweight acoustics. 0050 keeps biome/weather rules
and procedural clip generation, consuming these primitives. See the
[research and baseline audit](research/audio-system-2026-10-17.md).

## Goals

- Schema-authored routing, effects, sends/returns and composable snapshots.
- Clear separation between authored mix, player settings and host/session output controls.
- Spatial filtering, authored reverb zones and bounded optional obstruction queries.
- Inspectable signal paths and actual audio previews/tests in addition to headless decisions.

## Non-goals

- Arbitrary external DSP plugins, multichannel/surround authoring, mastering certification,
  convolution-based world propagation, room/portal graphs or personalized HRTFs.
- A physics dependency in `audio`, a new Node DSP renderer, or bit-identical browser mixes.

## Design

### Mixer assets and signal path

`audioMixerPlugin()` registers `AudioMixer` (`*.audio-mixer.json`) and `AudioSnapshot`
(`*.audio-snapshot.json`) using 0031. Compilation creates stable numeric bus/effect IDs and a
topologically sorted graph, with one master output per 0077 session. Each ordinary bus has
one parent; additional edges are explicit sends to return buses. Return buses have one output
parent and may send onward only if the complete graph stays acyclic. Reject unknown destinations,
self routes and cycles with the involved asset/edge paths. Cap at 64 buses, 128 sends and 128
inserts per session as schema safety limits; a configurable node cap also bounds graph compilation.

Signal order is clip → voice gain/filter → spatializer → bus input → ordered bus inserts →
bus fader → parent. A pre-fader send taps after inserts, before the fader; post-fader taps after
the fader. All sends tap after source spatialization. Returns are wet-only by default. Parent
gain is applied once by routing; the engine separately computes effective analytical gains for
inspection. Never feed ancestor-multiplied gains into already hierarchical nodes.

The existing `AudioBuses` resource becomes the compatibility authoring input when no mixer asset
is configured. Existing `setBus`, mute and `duck` controls remain. Keep 0035 playback through a
legacy flat backend adapter; advanced graph loading requires the graph capability. Bus changes
compile/validate off the update path, then commit atomically. Invalid edits preserve the old
graph. Compatible scalar edits automate nodes in place; topology changes retain old tails and
crossfade to the new graph within explicit node/memory limits, otherwise defer with a diagnostic.

Authored faders/snapshot gain are dB, API compatibility volumes and user settings are linear.
For a dry path: source gain × product of bus authored gain, snapshot gain, duck gain and user
gain × session output gain. User gain never becomes a snapshot baseline and user mute wins
over every gameplay control. Pre-fader sends bypass the musical fader, but wet paths retain
their originating user-control ancestry. Stateful returns are instantiated separately per
user-control domain (an ordinary direct child of master), with that domain's effective user gain/mute applied once at the return
output; this can silence existing tails without silencing another category's tails. Send inputs
exclude those same user gains to avoid applying them twice. Partitioned nodes/IR work count
against graph budgets; reject graphs that exceed them. Returns may combine domains only after
their gates and never enter shared stateful wet processing afterward; onward stateful sends
retain domain partitioning. Ordinary buses sum their children into one insert chain; only return chains are cloned per
control domain. Descendant faders preserve existing tails. Master cannot own sends, delay or
reverb: after category signals merge their nonlinear histories cannot be separated for independent
mute. A master compressor operates on the aggregate signal. Master user gain is applied only at
master. `setAudioUserBus` accepts master and ordinary direct-child categories; nested and return
buses reject independent player controls because their wet history belongs to the category.
`setBus` remains the gameplay fader, independent from player volume/mute. Expose all factors separately.

### Effects and automation

Initial registry: low/high-pass and peaking EQ (`BiquadFilterNode`), compressor
(`DynamicsCompressorNode`), delay with bounded feedback, and convolution reverb
(`ConvolverNode` using an imported `AudioClip` impulse response). Per-voice inserts initially
support only low/high-pass; expensive effects belong on shared returns. Schema declares each
parameter's range, unit, default and automation support. Frequency bounds also respect backend
sample rate; preparation rejects unusable IRs. A delay's internal feedback is encapsulated and
restricted to absolute gain < 1; it cannot introduce external graph feedback.

Use 0077's curves/parameters; event automation may target voice gain/pitch/filters and send level.
Each layer declares at most eight unique sends (`target`, `gainDb`, optional parameter/points
curve in dB). These additive taps are after voice gain/filter/spatialization and before the bus
inserts/fader. The source bus must declare the return route (its bus send can be -120 dB); this
prepares the return's category partition before playback. One instance's send automation never
changes another's send. Graph replacement preserves these routes or rejects the edit.
Scheduling/automation uses audio time; engine evaluation emits changes only when needed.
Short ramps default to 10 ms for abrupt fader changes, with exact zero at ramp completion.
Sample start boundaries and deliberately percussive envelopes may request zero ramp explicitly.
Changing a ramp mid-flight starts from its current effective value, not its old target.
Web delay uses a finite impulse response: echo amplitudes follow the authored feedback series,
truncated at `tailSeconds`. Reverb IRs longer than the cap are truncated with a final 5 ms fade.
Delay edits rebuild one of two preallocated kernels and crossfade over 20 ms; faster edits coalesce
to the latest target. Generated effect kernels have a separate 64 MiB graph ceiling. Cascaded
inserts add their tails; parallel paths take their maximum. Graph retirement starts after its
20 ms input fade and waits for this longest path in audio-context time, including suspension.

Stopping dry playback allows bounded delay/reverb tails; `tailSeconds` is required for effects
without an analytic finite tail, capped at 10 seconds by default. Hard session disposal cancels
tails. A hard user mute suppresses returns too; ordinary musical fades preserve tails.

No claim of true-peak limiting or signal-dependent sidechain compression: initial ducking is
event-activity driven, as in 0035, extended to include descendant buses and instance tags.
Virtual or merely preparing voices do not duck unless a rule explicitly opts into logical activity.
External sidechain DSP and a mastering limiter need a separate implementation/capability.

### Snapshot composition

A snapshot lists only the bus/effect/send fields it changes, with priority, attack/release and
weight in [0,1]. Unmentioned properties stay untouched. Targets are `offset` (gain/pitch in
dB/semitones only) or `override`. Resolve overrides from low to high priority; at the same
priority, form a weighted mean target and blend from the lower-priority result by
`min(1, sum(weights))`. Then add all weighted offsets. Equal priority is independent of activation
order. Targets are numeric mixer fields; continuous values interpolate in schema units and
frequencies use log Hz. Player mute is a separate user control, outside snapshot composition.

Attack/release animate weight, not stored asset values. Removing one snapshot recomputes the
composition from current inputs, avoiding stale restoration of another snapshot's state.
Player settings, host gain and mute are always applied afterward. Multiple acquisitions of the
same snapshot have separate handles; each may release independently. Cap active handles at 64.
Underwater, pause-menu and dialogue can overlap deterministically.

### Spatial and acoustic layer

`audioAcousticsPlugin()` optionally registers `ReverbZone` and obstruction evaluation on top of
the mixer; it imports no physics host. One zone is a box or sphere in world space with a return
bus/IR, wet send, priority, blend distance and `indoor` flag. Its geometric influence is 1 inside
and falls linearly to 0 across the exterior blend distance. Normalize weights within a priority
band when their sum exceeds 1; higher priority consumes available influence first. Limit audible
returns to four slots targeting the strongest influences, tie by stable zone ID. A challenger
must exceed an occupied slot's influence by 0.05 before replacement; fade that slot to zero over
100 ms, replace its IR only at zero, then fade in over 100 ms. Recompute targets during the fade
without discontinuity. This bounded handoff can briefly reduce wet energy but cannot pop or use
a fifth audible return. Report discarded influences and pending replacements.

Zone membership is listener-based in the first implementation. It drives sends for buses/events
that opt into environmental acoustics, normally sfx/ambience/voice; UI and music stay dry by
default. Zone transforms and blend distances use the engine's metres and floating-origin rules.
Zones share prepared IRs by asset revision. Reverb IR replacement crossfades within the resource
budget; zoning alone never decodes a new IR on the frame path.

An injected acoustic query provider supplies transmission [0,1] for a source/listener segment;
physics adapters live outside audio. Default evaluation: at most 16 provider calls per frame,
refresh each eligible physical spatial voice at most 10 Hz, prioritize stale/high-audibility
voices deterministically, reuse caller-owned result buffers. Smooth transmission with 50 ms
attack and 200 ms release. Default mapping is clear→0 dB/20 kHz and blocked→-18 dB/800 Hz,
overridable through curves. This is art-directed obstruction, not physical propagation.
No provider means clear transmission and a reported capability state. Keep the legacy gain-only
occlusion callback supported without requiring both paths to run or applying gain twice.

### API sketch

```ts
app.addPlugin(audioMixerPlugin({ mixer: 'data/audio/main.audio-mixer.json' }))
app.addPlugin(audioAcousticsPlugin({ query: physicsTransmission, maxQueriesPerFrame: 16 }))
const underwater = await acquireAudioSnapshot(world, 'data/audio/underwater.audio-snapshot.json')
setAudioSnapshotWeight(world, underwater, 0.75)
releaseAudioSnapshot(world, underwater) // uses authored release
setBus(world, 'music', { volume: 0.5 }) // compatibility control, not snapshot mutation
```

### Verification and agent surface

`audio.describe` exposes routes, inserts, effective/user/authored gains, snapshot contributions,
zones, obstruction ages and capabilities. `audio.meters` reports optional bus peak/RMS sampled
at at most 20 Hz, with bus identity, window size, sample rate and audio timestamp. A headless backend returns
`available: false` for signal meters; analytical gains are never labeled measured loudness.
Main-thread work uses 0074 spans; browser DSP CPU time is unknown unless actually instrumented.

Add `audio.snapshot.acquire/set/release`, `audio.mix.inspect` and `audio.preview` methods with
matching CLI/MCP surfaces. `shard audio preview <plan.json> --out mix.wav --json` launches the
existing browser automation host with a separate `OfflineAudioContext`; it requires neither
GPU rendering nor a sound card. The same graph builder targets live/offline contexts inside
`platform-web`. Plans declare assets, seed, parameter timeline, listener/source paths, duration,
sample rate and tail duration. Output: WAV, decision trace, sample peak/RMS/clipping counts,
backend version and capability report. Limit duration to 60 seconds by default and reject
estimated output/resource sizes above configured caps before allocation.

Preview uses decoded local/prepared assets, never live network streams or microphone input.
Unsupported offline nodes/codecs fail explicitly. No browser installed yields an actionable
`audio/preview-unavailable`; pure Node inspection still works. 0050's `soundscape.preview`
delegates to this renderer. Browser output is compared with signal tolerances, not bit hashes.
Errors include `audio/mixer-cycle`, `audio/invalid-effect`, `audio/mixer-capacity`,
`audio/invalid-snapshot`, `audio/invalid-zone` and `audio/preview-unavailable`.

## Decisions

- **Real graph routing.** Parent effects and shared returns require more than inherited volume.
- **Deterministic composition.** Overlapping states must release independently and preserve settings.
- **Optional bounded acoustics.** VTT rooms and games get useful spatial cues without planet/physics
  dependencies or a per-source raycast every frame.
- **Separate semantic and signal tests.** Node validates decisions; browser offline renders validate
  routing, filters, envelopes and tails. HRTF still needs browser listening/coverage.

## Acceptance criteria

- [x] A child and parent at 0.5 linear gain render a unit signal at 0.25 before other processing;
      no doubled ancestor attenuation. Parent inserts process descendant audio exactly once.
- [x] Cycles/unknown buses/effects fail with paths; invalid hot edits preserve the running graph.
- [x] Pre/post-fader sends differ as specified; zero user category volume or mute silences both
      dry/wet output, while unrelated categories remain audible.
- [x] Snapshot overlap/release is order-independent at equal priority; underwater + dialogue +
      pause tests preserve user volume and return to current base values without stale restores.
- [x] Offline probes verify a low-pass attenuates a 10 kHz tone by at least 12 dB relative to
      100 Hz with 800 Hz cutoff; delay impulse timing is within one sample; reverb tails persist
      through dry stop and end by their cap. Test gain ramps against specified envelopes.
- [x] Five overlapping zones blend continuously as ranks swap; only four returns activate. A
      floating-origin rebase leaves influences and obstruction segments unchanged.
- [x] With 512 potential emitters, the fake query provider is called at most 16 times/frame;
      stale ages are observable; no provider leaves dry/clear playback correct.
- [x] Browser preview produces WAV + trace + measured peak/RMS and reports missing capabilities;
      headless meters never fabricate measured values. No microphone or audio output is needed.
- [x] An Aether-style room-switch demo, an underwater demo and overlapping dialogue/pause states
      work through JSON assets, live parameter edits and headless assertions.
- [x] Add proposed `audio/mix` (32 buses/64 inserts/16 snapshots: 0.2 ms median) and
      `audio/acoustics` (64 physical voices/32 zones: 0.2 ms median, fake queries) for both named
      machines, each twice `audio/update`'s current target. Register 0075 keys on implementation;
      instrument real provider cost separately. Warm engine updates allocate nothing; browser
      node creation/teardown and optional metering are measured separately, never hidden in that claim.

## Open questions

- None blocking. Deferred: portals/diffraction, multiple listeners, true peak/loudness standards,
  custom AudioWorklet DSP and external sidechain compression. Add only with dedicated requirements,
  capability contracts and measurements; do not imply FMOD DSP/plugin parity.

## As built

`configureAudioMixer` is the explicit apply boundary after importing an edited mixer. Compatible
fader/effect/send edits preserve nodes, unchanged automation and acoustic factors; changed IR bytes
or topology crossfade to a replacement within the overlap budget. Snapshot targets are numeric;
player mute stays outside gameplay composition. Obstruction `gainCurve` and `lowpassCurve` options
replace the default transmission mapping without adding a physics dependency.

Meters are pull-based 2,048-sample windows refreshed at most 20 Hz, with timestamp/sample rate;
they do not infer dropped device samples. Output-device latency and browser DSP CPU remain
unmeasured. Acceptance evidence is in [the implementation checklist](research/audio-implementation-checklist.md).
