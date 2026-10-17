# 0079 — Adaptive music and scheduled audio transport

- **Status:** implemented
- **Packages:** `@aethervtt/shard-audio`, `@aethervtt/shard-platform`,
  `@aethervtt/shard-platform-web`, `@aethervtt/shard-project`, `@aethervtt/shard-save`,
  `apps/cli`, `apps/playground`
- **Depends on:** 0077, 0031, 0038, 0062, 0074, 0075

## Context

A scene change, combat encounter or tabletop reveal should change music without a timer guessing
where the next bar falls. 0035 has immediate clip playback but no shared audio clock or musical
transport. 0050 explicitly leaves music to a later spec. This spec builds on 0077's scheduling,
prepared resources and parameters; 0078 effects and snapshots are optional enhancements.

The initial guarantee is synchronized **decoded** stems and authored transitions. Browser media
elements remain useful for long ordinary tracks but are not a sample-aligned music backend.
See the [research](research/audio-system-2026-10-17.md) for platform constraints.

## Goals

- Tempo/meter, synchronized stems, looping sections and parameter-driven intensity.
- Beat/bar/marker transitions, crossfades and stingers with explicit readiness and late policies.
- A reusable scheduler with cancel/seek/pause semantics and deterministic headless traces.
- Inspection and browser signal tests that expose actual scheduling limitations.

## Non-goals

- Arbitrary DAW editing, MIDI, time stretching, beat detection, tempo ramps or polymeter.
- Sample-accurate media-element/network streaming, unconditional stall immunity or synchronized
  remote clients. These require separate designs and capabilities.

## Design

### Music assets

`audioMusicPlugin()` depends on `audioEventsPlugin()` and registers `MusicProgram`
(`*.audio-music.json`) using 0031. A program declares fixed BPM, time signature, named sections,
markers, stem clip references and transitions. Each section has a positive integer length in
bars and stems with explicit clip start/end sample markers in imported source coordinates.
Importer records source sample rate; convert markers once to decoded-context coordinates.
Require each stem's usable duration to cover the section and explicit trim/loop metadata;
reject incompatible lengths. Each loop must conform its usable decoded period to the authored
section duration: if they differ, require an explicit `rateConform: true` and apply the fixed
rate `usableSeconds / sectionSeconds`, limited by authored `maxConformCents` (default 1 cent).
Without that opt-in, reject a mismatched period; do not silently permit cumulative drift. This
tiny explicit varispeed is pitch-changing, not time stretching. All stems must pass preparation
validation before admission. Prefer PCM WAV/FLAC for authored loops; lossy codec padding must
be validated after decoding rather than trusted for gapless playback.

Stem gain curves read 0077 local/global parameters, normally `intensity`. Every stem in a section
shares a transport phase, including muted or virtual stems. Continuous gain changes don't
restart them. Default priority reserves prepared musical voices; admission counts all stems
required by an imminent crossfade/stinger against 0077's physical-voice and memory budgets.
If reservation fails, keep the existing section and report why, never start half a section.

Transitions name source/destination, an optional parameter predicate, priority, quantization
(`immediate`, `beat`, `bar`, or named marker), crossfade duration in beats and destination entry
marker. Equal priorities break by stable transition ID. At each decision boundary choose at
most one transition. Re-entry is explicit; setting intensity inside a section is not re-entry.
Default crossfade is equal power for unrelated sections; linear is available for correlated
material. Clip loop seams remain the author's responsibility and are checked by previews.
Different BPM/meter between programs is a stop/transition into a new transport, not time stretch.

### Clock, schedule and cancellation

Use 0077's transport with a fixed tempo mapping. Quarter-note beats per bar are
`numerator * 4 / denominator`; BPM always counts quarter notes, and seconds per quarter note
are `60 / bpm`. `quantize: 'beat'` means one quarter note, including in compound meter; use named
markers for dotted/grouped beats. Represent musical positions as integer ticks at 960 PPQ;
supported meter denominators are 1, 2, 4, 8, 16 and 32. Bars and markers therefore stay exact.
In headless mode, transport time is injected/stepped and scheduling decisions use the same
boundary arithmetic. In realtime playback, the backend clock is authoritative for scheduled
execution; main-thread callbacks only enqueue ahead. Never advance a music playhead by summing
render-frame deltas or decide a bar transition from a delayed frame callback alone.

For each boundary, calculate absolute time from epoch + tick / 960 × 60 / BPM, then round to the
nearest output sample once. This avoids accumulated sample-rounding drift at fractional BPM.
All stems use the same rounded timestamp. Call scheduled source start and gain automation with
that timestamp; do not play stems in separate immediate calls. Backend telemetry distinguishes
requested/scheduled times and engine-observed presentation state. Device output latency remains
unmeasured; a callback arrival time does not claim when a speaker emitted a sample.

Default lookahead is 100 ms, scheduler wake interval 25 ms, minimum commit lead 20 ms; these
are configurable, reported settings. Wake scheduling is a platform service independent of visual
render frames, so on-demand Aether rendering does not stop music. This is still main-thread
scheduling: already scheduled sources continue during stalls; unscheduled future work can miss
its deadline. No worker or AudioWorklet requirement is introduced in this phase.

A transition request selects the first eligible boundary at least commit lead beyond current
audio time. Its dependencies must be prepared before that boundary's commit deadline. If late
or unready, default to the next eligible boundary, record the miss and leave the old loop running.
`drop` and `immediate-crossfade` are explicit alternate policies. A continuous loop itself is
scheduled once using buffer looping, so a scheduler stall cannot leave a gap between iterations.

Maintain a bounded queue of stable command IDs and a transport generation. A newer request
replaces an uncommitted request by default; once committed, it queues for the following eligible
boundary. Explicit cancel stops future source nodes and cancels their automation before start;
if already audible, cancel uses an authored release and reports `already-started`.
Pause/seek/reset invalidates the generation and cancels old starts/stingers before rescheduling.
No stale callback or decoder completion may resurrect old playback.

Realtime music ignores game timeScale and may continue when gameplay pauses. Explicit music
pause freezes its transport and silences/pauses stems at the captured phase; resume reconstructs
sources against a new epoch. Context interruption freezes transport as in 0077. Seeking uses
program phase and excludes old stingers. Hidden-page suspension and failed resume are reported;
the runtime never promises background audio that the browser/OS will not allow.

### Stingers, readiness and persistence

Stingers reference an `AudioEvent`, trigger at a musical boundary and declare cooldown/overlap
policy. Initially require finite prepared decoded layers whose delays are relative to the
scheduled start. Reject media streaming or unsupported event constructs for rhythmic use.
Tags/parameters choose variants deterministically before scheduling. Stinger tails may cross a
section transition unless the program explicitly cancels them.

Prepare current and candidate next sections through 0077 leases. Shared buffers are counted
once; a transition pins both sections until the crossfade ends. Metadata remains cheap to load;
preparing a program does not decode every possible branch. The readiness report lists missing
clips, decoded bytes and reserved voices. A missing scheduled-playback capability errors before
the program starts; an ordinary music clip remains playable through the simple API.

Opt-in 0038 checkpoints persist program GUID/revision, section, beat/phase, intensity and other
parameters, plus committed transition destination. Load cancels old scheduling, prepares content
and resumes phase against a fresh audio epoch. Do not restore backend clock values, transient
stingers or elapsed real wall time. If a section/revision is unavailable, restart the program's
declared entry section and report a restore diagnostic. Capture a musical checkpoint at an
explicit transport time so saving cannot race scheduler callbacks.

### API sketch

```ts
app.addPlugin(audioMusicPlugin({ lookahead: 0.1, commitLead: 0.02 }))
const music = await prepareMusic(world, 'data/audio/exploration.audio-music.json')
const transport = startMusic(world, music, { section: 'explore' })
setMusicParameter(world, transport, 'intensity', 0.8)
requestMusicSection(world, transport, 'combat', { quantize: 'bar' })
playMusicStinger(world, transport, 'discovery', { quantize: 'beat' })
pauseMusic(world, transport)
```

### Agent surface

`audio.describe` gains transport phase/tempo/epoch, active stems, reserved voices, prepared next
sections, committed/pending requests and deadline misses. `audio.log` links transitions and
stingers to command IDs, asset revisions, seed, target boundary and cancellation reason.
Expose schema-backed `audio.music.start`, `parameter`, `transition`, `stinger`, `pause`, `resume`,
`seek` and `stop` methods through existing protocol/CLI/MCP registration. Commands return a
request ID and chosen boundary or rejection, not a fabricated promise of audible timing.

Extend gameplay helpers with logical beat/section assertions. 0078's optional offline preview
accepts music programs and exports the same decision trace plus rendered WAV. Even when 0078
is absent, browser tests exercise the scheduler with decoded impulse stems and captured output.
Errors include `audio/music-invalid`, `audio/music-unprepared`, `audio/music-capacity`,
`audio/music-late`, `audio/music-stale-command` and `audio/music-restore`, with paths/hints.

## Decisions

- **Decoded music first.** Web Audio can schedule prepared buffers precisely; media elements
  cannot provide the same synchronized-stem contract.
- **Absolute boundary arithmetic.** Frame rate and repeated rounding cannot accumulate beat drift.
- **Explicit deadlines.** A missed cue is observable and recovered by policy, not silently late.
- **Independent scheduler.** Embedded/on-demand rendering must not own the musical clock.

## Acceptance criteria

- [x] An authored exploration/combat program uses at least four stems, two sections, intensity
      curves and one stinger; a tabletop scene can request the same transitions without physics.
- [x] Headless runs at different render-frame cadences produce identical boundary/selection
      traces for identical timestamped controls, seed and readiness schedule.
- [x] Offline browser rendering starts four decoded impulse stems within one output sample of
      each other. At 123 BPM, boundaries after 30 minutes of simulated scheduling differ from
      the absolute formula by at most one sample; this does not claim wall-clock/device accuracy.
- [x] Prepared loop periods conform to that grid; a rendered 60-second impulse-loop test at
      123 BPM has no cumulative phase error beyond one output sample. Reject disallowed/excessive
      rate conform. Bar transitions in 3/8 and 7/8 use exact ticks, with documented quarter-note beats.
- [x] Beat/bar/marker transitions, equal-power/linear fades and event-relative stinger delays
      match scheduled output samples. No half-started section when voice/memory reservation fails.
- [x] A fake clock plus 250 ms scheduler stall triggers the chosen missed-deadline policy exactly
      once; the current loop continues. Browser tests separately confirm scheduled-node behavior.
- [x] Cancel, rapid replacement, seek and pause before/after commit never duplicate stems or play
      stale stingers; context suspension/resume remaps epoch and preserves phase as specified.
- [x] Running without render-frame requests for 30 seconds keeps music scheduling active.
      Unsupported media/scheduling backends fail before starting a rhythmic program.
- [x] Checkpoint restoration preserves section/parameters/phase and releases previous transport
      leases; missing revisions yield the documented entry-section fallback.
- [x] Add proposed `audio/music-schedule`: 8 transports × 8 stems, 32 queued requests, median
      0.1 ms per scheduler wake on both named machines (same proposed CPU allowance as current
      `audio/update`). Register 0075 key at implementation, measure worst deadline miss separately,
      and enforce no steady-state engine allocation after preparation. Node creation at section
      changes is measured separately; run `pnpm bench` for scheduler changes.

## Open questions

- None blocking this initial scope. Deferred: tempo maps, sample-accurate streamed stems and
  live time stretching. AudioWorklet streaming requires its own codec/buffer/underrun design;
  secure contexts are required, and SharedArrayBuffer transport additionally needs isolation.

## As built

Music always follows backend audio time; it has no game-clock option. `startMusic({ paused: true })`
prepares an initially silent transport. Save restoration holds all transports paused until every
program/global bank is ready, then resumes; obsolete destinations are discarded on entry fallback.
Missing non-entry clips also fall back to the prepared entry with a diagnostic.

Acceptance evidence and hosted-hardware measurement limits are recorded in
[the implementation checklist](research/audio-implementation-checklist.md).
