# 0077 — Audio events, parameters, and runtime reliability

- **Status:** accepted (implementation in progress)
- **Packages:** `@aethervtt/shard-audio`, `@aethervtt/shard-platform`,
  `@aethervtt/shard-platform-web`, `@aethervtt/shard-assets`, `@aethervtt/shard-project`,
  `@aethervtt/shard-save`, `@aethervtt/shard-testing`, `apps/cli`, `apps/playground`
- **Depends on:** 0035, 0031, 0038, 0052, 0061, 0074, 0075

## Context

0035 supplies clip playback, spatial sources, scalar buses, variation and virtual voices.
Games still need code to turn a footstep, engine, spell, notification or scene ambience into
layers of sound that react to named inputs. FMOD's event/parameter model is a useful precedent;
Shard's authoring surface is schema-backed text, TypeScript and observable execution.

[The audit and research](research/audio-system-2026-10-17.md) distinguish tested functionality
from missing capabilities and confirmed defects. This spec is the shared foundation for Aether,
2D/3D games, 0078 mixing/acoustics, 0079 music and 0050 procedural soundscapes. Those features must
not wait for planets, weather, a visual editor or each other unless explicitly dependent.

## Goals

- Reusable events with layers, switches, variation, envelopes and parameter automation.
- Reliable preparation, playback state, cancellation, ownership and bounded memory/telemetry.
- Keep `AudioSource`, `playSound`, `preloadSound`, existing logs and simple projects compatible.
- A deterministic control model testable in Node; capability-aware browser/Tauri playback.
- Independently owned audio sessions for hosts embedding multiple Shard apps.

## Non-goals

- FMOD binary/project compatibility, FMOD SDK integration, a DAW or a visual node editor.
- New codecs, sample-accurate streaming, a software mixer in Node or general real-time synthesis.
- Network synchronization, voice chat, speech synthesis or dialogue localization authoring.
  Recorded localized dialogue can select ordinary event assets through existing game code.

## Design

### Delivery order and compatibility

Land in three reviewable increments: **A**, fix the source/backend mismatch, finite/range
validation, graph-cycle rejection, bounded retention and disposal; **B**, backend capabilities,
preparation, sessions and clock/command lifecycle; **C**, authored events and collections.
Each increment preserves 0035's regression suite. 0078/0079 build on these contracts.

Keep `audioPlugin()` as the base. `audioEventsPlugin()` explicitly registers the optional event
types and systems and depends on `audio`. Nothing registers on import. Existing APIs and their
linear gain/pitch units remain; new authored assets use `gainDb` and `pitchSemitones` with explicit
conversion. No change silently reinterprets an old number. The backend extension is optional:
legacy injected backends retain clip playback; unsupported advanced operations report capabilities
and `audio/unsupported-capability`, rather than claim successful playback.

### Assets and parameters

Use 0031 `defineDataType` for `AudioEvent` (`*.audio-event.json`), `AudioParameters`
(`*.audio-parameters.json`) and `AudioCollection` (`*.audio-collection.json`). Handles, schemas,
defaults, `$extends`, validation, dependencies, GUIDs and hot reload use the existing asset system.
Compiled runtime plans are derived artifacts keyed by normalized data, dependency revisions and
compiler version. Definitions never execute arbitrary code.

An event contains stable named layers. Each has a clip selector, bus, spatial settings, start
delay in seconds, loop policy, attack/release, conditions and curves for gain/pitch. Selectors:
single clip, weighted random, weighted random excluding the last N eligible choices, sequential
wrap, or switch on a discrete/labeled parameter. Reject empty choices, nonpositive total weight,
missing switch defaults and no-repeat windows at least as large as the choice pool. Runtime
filtering that leaves too few choices reduces the no-repeat window deterministically and traces
that decision. Nested event references and arbitrary timeline graphs are deferred.

Parameters are continuous (finite min/max/default), discrete integers or declared labels.
Scope is event-local or session-global; global definitions live in `AudioParameters`, referenced
by events, mixers, music and soundscapes. Resolve names to typed numeric IDs at compilation.
Unknown names, invalid labels and nonfinite values error; out-of-range continuous values clamp
and report target/effective values. Read-only built-ins include listener distance and speed.
Local smoothing uses `y += (target-y) * (1-exp(-dt/tau))`; tau zero is immediate. Continuous
curves require strictly increasing x, interpolate linearly in their declared output units and
clamp endpoints. Discrete/labeled inputs select exact branches. One evaluator serves all specs.

Layers with `trigger: 'start'` evaluate their condition once. `trigger: 'while'` layers start on
false-to-true and release on true-to-false; scalar automation never retriggers playback.
Loops default to resume their logical phase when gated back on; `restart` is explicit.
An event is `oneshot` (ends when children finish) or `sustain` (lives until stopped, including
while all gates are closed). A looping layer in a oneshot requires an explicit finite duration.
Random choices derive from session seed, stable event GUID, accepted instance ordinal and layer
ID. Virtualization never rerolls; rendering/backend readiness never advances RNG.

### Instances, voices and ownership

An instance is a logical event; a voice is one rendered clip layer. Separate limits cover
logical instances, physical voices, per-event instances and concurrency groups. Groups specify
scope (session or emitter), maximum, cooldown and reject-new/steal-oldest/steal-quietest policy.
Admission order is command sequence; ties use instance ID. Existing clip-voice priority remains
higher-number-wins. Reject before selecting clips, consuming the admitted ordinal or pinning data.
Virtual sustained instances keep clocks and selection state; one-shots default to drop if they
cannot obtain a voice. Eligibility thresholds have hysteresis; limits apply even during fades.

Default capacities: 256 logical instances, 64 physical voices, 2,048 pending commands and a
4,096-record trace ring per session. Configurable caps include per-clip voices and concurrent
loads/decodes (default 4); overflow returns a structured result, never grows an unbounded queue.
Generation-tagged IDs prevent commands for released instances reaching reused slots. Stopping
pending, virtual or already stopped instances is idempotent. Entity destruction cancels its
attached instances; detached playback requires an explicit session-owned handle.

Every app owns a backend session beneath a host-owned context/output. Bus IDs, listener state,
voice limits, callbacks and teardown are session-scoped. Disposing a session cancels loads,
scheduled starts and voices, disconnects nodes, releases references and unregisters its callbacks.
It never closes a supplied context or alters another session's buses. A host may set an aggregate
physical-voice ceiling; deterministic arbitration uses session priority then host session ordinal.
Web Audio has one listener per context: on a context owned by Shard's session host, hold it at
identity and transform each session's source positions/orientations into its listener space.
An externally supplied context must agree to this fixed-listener contract; otherwise independent
listeners require separate contexts or an unsupported-capability result. Never modify an unrelated
host listener. One active listener per session; explicit selection replaces query-order dependence.
Floating-origin rebases rebase previous positions too, preventing a false Doppler impulse.

### Preparation, time and backend state

Add host-neutral capability flags for scheduled decoded playback, automation, mixer graphs,
media playback, meters and offline rendering. Preparation returns an awaitable lease with asset
revision, byte accounting, ready/failed/cancelled state and release. Keep the old void preload
helper as a compatibility wrapper. Backend feedback distinguishes requested, preparing, blocked,
scheduled, rendering, virtual, stopping, ended and failed; logical intent is separately exposed.
No API equates a recorded start with sound reaching a speaker. End/error feedback is tied to a
voice generation, and late decode results after cancellation cannot start playback.

Use three explicit domains: simulation time for gameplay decisions/replay; a session transport
for logical playheads; backend audio-context time for scheduled rendering. Session transports
choose `simulation` (decisions/envelopes follow pause/timeScale) or `realtime` (music/UI may
continue); no implicit mixing of `performance.now()` offsets and simulation deltas. Clip sample
playheads are separate: by default they play at the authored rate, pause with their transport,
and advance at that same unscaled rate while virtual. Explicit `pitch-linked` mode scales both
sample progression and pitch by timeScale. Pitch-preserving time stretching is not supplied,
and a default clip is not promised to stay phase-locked to a scaled simulation timeline.
A scheduled command carries an ID,
transport time, backend deadline and generation. Pause/seek/reset invalidates obsolete commands
and rebases mappings. 0079 defines rhythmic scheduling on the realtime contract.

Autoplay suspension is visible. New transient events expire after 250 ms by default; sustained
events wait and resume logical phase. Authors may choose wait/restart/drop and a maximum age.
Browser interruption freezes the realtime transport by default; resume remaps its audio epoch.
Asset readiness cannot silently turn a missed transient into a much later cue. Legacy clip calls
retain their existing catch-up policy until explicitly migrated. Real backend completion/errors
correct presentation state; headless completion follows declared duration and the same controls.

All mutable `AudioSource` fields must reach playback: update supported fields in place, or
recreate the backend voice at the current phase with a short crossfade under the same logical ID.
Validation is shared by component data and code APIs. Reject invalid bus graphs and clip loop
regions. Unknown legacy source buses retain 0035's logged master fallback; new event assets fail
validation on unknown buses. Decode/codec support is probed, never inferred from file extension.

### Residency, streaming, reload and saves

Collections are manifests of existing event/clip references and preparation modes, not a new
binary bank format. Loading acquires an owner lease; unloading releases that lease. Active,
scheduled and explicitly prepared content remains pinned. Track encoded bytes and decoded PCM
separately, plus active/loading/pinned/evictable counts. Decoded PCM costs sampleCount × channels
× 4 bytes; report decoder/browser overhead as unmeasured. Default decoded budget is 64 MiB.
Evict unpinned least-recently-used buffers before admission; pinned overcommit fails new prepares
with `audio/memory-budget`, without interrupting already playing content. Release Blob URLs and
cached resources when their last owner/voice goes away. Bound headless history and clip counters.

The current `stream` mode is fully loaded encoded bytes played through a media element. Preserve
that compatibility path and label its memory behavior honestly. Add a capability-gated asset
location source resolved by the platform (including Tauri), with media-element URL playback for
long tracks; it must avoid eager artifact-byte loading, handle cancellation and report readiness.
Browser buffering is not a strict memory bound and media playback is not synchronized-stem
playback. Asset metadata dependencies must not eagerly pin every collection's decoded samples.

In-flight instances pin an immutable compiled revision, even though data stores update in place.
New instances use a validated replacement; invalid edits leave last-good data. Explicit restart
or crossfade applies an edit to active loops. Stale preparation completions cannot overwrite the
new revision. Save/load first cancels transient voices and scheduled work. Opt-in schema-backed
audio checkpoints persist global params, sustained event IDs/revisions, selections, playheads and
RNG/admission state; never backend nodes/handles. Missing revisions follow an explicit restart or
skip-with-diagnostic policy. Ordinary one-shots do not replay on load; user volume remains in 0038.

### API sketch

```ts
app.addPlugin(audioPlugin({ backend: platform.audio }))
app.addPlugin(audioEventsPlugin({ maxInstances: 256, decodedBudgetMiB: 64 }))
const lease = await prepareAudio(world, 'data/audio/ship.audio-collection.json')
const engine = playAudioEvent(world, 'data/audio/engine.audio-event.json', {
  entity: ship, parameters: { rpm: 0.2 }, clock: 'simulation',
})
setAudioParameter(world, engine, 'rpm', 0.8)
stopAudioEvent(world, engine, { release: 0.2 })
lease.release() // active content retains its own pin
```

### Agent surface

Extend `audio.describe` with capabilities, sessions, parameters, instances/revisions, presentation
states, memory and voice decisions. Preserve old fields. Extend `audio.log` with monotonic
cursors, oldest/next cursor and `truncated`; keep the legacy frame filter. Typed packed ring
records allocate JSON only on inspection. Add schema-backed `audio.play`, `audio.stop`,
`audio.parameter.set`, `audio.prepare` and `audio.release` methods, CLI wrappers and MCP tools
using the existing protocol. Read-only inspection never starts sound. Commands target a session,
reuse existing attachment authorization and expose cancellation/error outcomes.

Generated `.agents/audio.md` documents units, policies and recipes; schemas expose all asset
types. `game.audioLog()` stays compatible and gains instance/parameter assertions. Errors include
`audio/invalid-event`, `audio/unknown-parameter`, `audio/invalid-range`, `audio/bus-cycle`,
`audio/capacity`, `audio/memory-budget`, `audio/stale-handle`, `audio/unsupported-capability` and
`audio/prepare-failed`, with asset path/JSON pointer and corrective hint.

## Decisions

- **Events over clip-only scripting.** Sound behavior becomes reusable, testable project data.
- **Shared parameters and explicit plugins.** Tabletop/apps and games compose the same primitives.
- **Separate intent and presentation.** Deterministic logs cannot certify audible output.
- **Ownership before effects.** Embedded apps must coexist and release audio without global leaks.
- **Collections over proprietary banks.** Reuse Shard's dependency graph and static-host exports.

## Acceptance criteria

- [ ] All 0035 correctness tests pass; live bus/loop/panning/distance edits match backend state
      and calculated gain. The audit's x=10/refDistance=5 repro measures 0.5 on the new bus.
- [ ] JSON/schema/API reject equivalent invalid ranges, NaN, cycles and references with paths.
- [ ] Surface-switched footsteps, RPM-blended engine loops and layered spell events are authored
      entirely as assets. Equal seeds/commands yield identical selections and logical traces.
- [ ] Local/global scope, smoothing, gates, cooldowns and every concurrency policy have headless
      tests, including virtual-to-real transitions without rerolls or duplicated child voices.
- [ ] Fake delayed/failed/cancelled decoders prove no ghost start, false rendering state or leaked
      lease; browser tests cover gesture suspension, resume and unsupported codecs.
- [ ] At timeScale 0, 0.5 and 2, default and pitch-linked modes preserve the specified sample
      cursor/completion behavior through pause and virtual/resume; inspect decision and sample clocks.
- [ ] Two apps sharing a context have independent buses/listeners; disposing one leaves the other
      playing. Distinct listener poses produce correct session-relative panning. Repeating
      create/play/dispose 100 times returns owned resource counters to baseline.
- [ ] Collection eviction respects 64 MiB decoded budget; active pins survive unload; complete
      unload revokes URLs. URL media mode loads without allocating a whole-file encoded buffer.
- [ ] Invalid hot edits keep last-good data; active revisions remain stable; save/load restores
      opt-in sustained state and never replays transient one-shots or accepts stale completions.
- [ ] Ten minutes of voice churn and saturated telemetry stay within configured capacities;
      cursor gaps are reported. No steady-state allocations in warmed engine evaluation.
- [ ] Preserve `audio/update` and `audio/update-virtual` budgets. Add proposed
      `audio/events` (128 instances × 4 layers, 16 global parameters: 0.2 ms median on both named
      machines, twice the existing 48-source target) and `audio/commands` (256 queued changes:
      0.2 ms median). Register keys/measurements in 0075's budgets when implementing; test churn
      separately from steady state with `budget()`, `allocationChecks` and `timeout()`.

## Open questions

- None blocking acceptance of this scope. Deferred: strict streaming via AudioWorklet, nested
  events, multiple simultaneous listeners within one session and synchronized remote playback.

### Shared parameter clock clarification

Session-global smoothing advances once from the backend clock, including scheduler wakes without
visual frames. Local event parameters follow their event decision clock. This prevents a shared
music/mixer parameter from freezing or advancing twice when frame cadence changes.

## As built

Catalog references canonicalize to GUID before lookup, including path-only schema handles and
collections requested by GUID. GUID identity takes precedence over a stale path. Tauri's scoped
media URL resolver is injected by its host; without one it retains encoded-byte playback and does
not advertise an unusable URL. Public instance IDs are monotonic and never reused; internal
generations reject stale asynchronous work.

Acceptance evidence and hosted-hardware measurement limits are recorded in
[the implementation checklist](research/audio-implementation-checklist.md).
