# Audio implementation evidence

Acceptance map for specs [0077](../0077-audio-events-runtime.md),
[0078](../0078-audio-mixing-acoustics.md), and [0079](../0079-adaptive-music.md).
Tests distinguish logical decisions, rendered signals, resource ownership, and performance.
Builds and strict allocation/performance runs execute in GitHub Actions.

## Acceptance map

Paths below are relative to the repository root. The numbered rows follow each spec's
acceptance criteria in order; one row may require several complementary tests.

| Spec / criterion | Implementation and evidence |
| --- | --- |
| 0077 / 1 — legacy playback and live edits | `packages/audio/src/audio.test.ts`, `runtime.test.ts`: all 0035 scenarios, live route/loop/spatial edits, x=10/refDistance=5 produces gain 0.5 without a second logical start. |
| 0077 / 2 — schema/API validation | `runtime.test.ts`, `events.test.ts`, `mix.test.ts`, `music.test.ts`; schema-derived data import validation in `packages/assets/src/data.test.ts`. Invalid input fails before admission/stealing. |
| 0077 / 3 — authored footsteps, engine and spell | `examples/audio-lab/assets/`; `apps/cli/src/audio-preview.test.ts` renders the authored showcase twice, compares exact decisions and PCM within two 16-bit LSBs. |
| 0077 / 4 — parameters, selectors, gates and concurrency | `events.test.ts`, `event-lifecycle.test.ts`, `lifecycle.test.ts`, `mix.test.ts`: shared globals, smoothing, release/reopen, command-ordered admission, cooldowns, validation before stealing, sequence history and per-instance sends. |
| 0077 / 5 — readiness, cancellation and autoplay | `lifecycle.test.ts`, `event-lifecycle.test.ts`, `music-lifecycle.test.ts`; `apps/playground/src/audio.test.ts` uses a real trusted browser gesture, invalid encoded bytes, suspension and resumed audio-clock retirement. |
| 0077 / 6 — clocks and virtualization | `event-lifecycle.test.ts`: scale 0/0.5/2, default and pitch-linked cursors; `events.test.ts` and `lifecycle.test.ts`: pause, virtual state and no-frame realtime pumping. |
| 0077 / 7 — independent sessions | `apps/playground/src/audio-probes.ts`: two listener poses produce opposite panning, shared decode survives one session's disposal, 100-session churn returns owned counters to baseline, host group reservations arbitrate atomically. |
| 0077 / 8 — collection/cache/media ownership | `runtime.test.ts`, `references.test.ts`, asset lazy-byte tests; browser probes measure shared/collected decoded bytes and owned Blob URL 1→0 versus external URL ownership 0. Tauri media URL resolution is an optional injected host capability. |
| 0077 / 9 — revision and save lifecycle | `event-lifecycle.test.ts`, `lifecycle.test.ts`, `packages/save/src/audio-save.test.ts`: pinned revisions, source GUID, sustained state, cooldown/history rewind, legacy saves, stale async completions and no transient replay. |
| 0077 / 10 — bounded retention/allocation | `runtime.test.ts`: 36,000 frames of churn and saturated 4,096-record trace; strict warmed allocation checks in `perf.test.ts` and `advanced-perf.test.ts`. |
| 0077 / 11 — registered performance | `bench/perf/budgets.json`: `audio/update`, `audio/update-virtual`, `audio/events`, `audio/commands`; Actions report preserves actual CPU identity and enforcement state. |
| 0078 / 1 — hierarchical routing and parent inserts | `mix.test.ts`; browser hierarchy signal and two-child compressor versus a single equivalent summed input. |
| 0078 / 2 — validation and transactional edits | `mix.test.ts`, `acoustics.test.ts`: invalid topology keeps old graph, scalar edits retain nodes/zone factors, changed IR bytes rebuild. Browser scalar edit probe verifies a previously excited delay tail survives a fader edit with no replacement-node capacity. |
| 0078 / 3 — sends and category controls | Browser pre/post-send, independent-instance-send and domain-tail probes; mute suppresses one category's old/new wet output while unrelated old/new music remains audible. |
| 0078 / 4 — snapshot composition | `mix.test.ts`: equal-priority order independence, overlapping handles, user volume/mute, current-base restoration and full-duration weight fades without visual frames. |
| 0078 / 5 — measured filters/envelopes/tails | Browser low-pass rejection, one-sample delay timing, finite delay/reverb caps, category-tail retirement and native fades. These use actual OfflineAudioContext output. |
| 0078 / 6 — zones and rebase | `acoustics.test.ts`: five-zone rank swap, four slots, 100 ms handoff, unchanged influence/Doppler after floating-origin rebase; authored room→empty→hall preview trace. |
| 0078 / 7 — bounded queries | `acoustics.test.ts`: 512 emitters, at most 16 provider calls/frame, observable stale age and optional provider. |
| 0078 / 8 — preview and meters | `preview.test.ts` protocol roundtrip/missing-host error; `apps/cli/src/audio-preview.test.ts` actual WAV, decisions, peak/RMS, clipping/nonfinite counts; headless meters report unavailable. |
| 0078 / 9 — runnable authored showcase | `examples/audio-lab`: two rooms, underwater/dialogue/pause snapshots, live RPM and intensity controls; `apps/cli/src/audio-project.test.ts` opens the real project and reloads its script without duplicate sustained events or music. |
| 0078 / 10 — performance | `advanced-perf.test.ts`: 32 buses/64 inserts/16 snapshots and 64 voices/32 zones; `audio/mix`, `audio/acoustics` registered keys and strict warmed allocation checks. |
| 0079 / 1 — authored adaptive program | Audio-lab four-stem exploration/combat program and stinger; authored CLI preview and project lifecycle tests. No physics dependency. |
| 0079 / 2 — render cadence independence | `music-lifecycle.test.ts`: equal controls/readiness across different frame cadences and shared smoothing without frames. |
| 0079 / 3 — start alignment/long absolute grid | Browser four-impulse alignment; `music.test.ts` checks 123 BPM after 30 simulated minutes within one sample of the absolute formula. |
| 0079 / 4 — actual loop period/compound meter | Browser renders 60 seconds at 123 BPM, compares every detected peak and rejects extra peaks; `music.test.ts` validates explicit rate conform and exact 3/8 and 7/8 bar ticks. |
| 0079 / 5 — transitions/fades/stingers/reservations | `music.test.ts`, `music-lifecycle.test.ts`; browser actual MusicProgram linear/equal-power crossfades, parameter change during fade, relative stinger delay, host reservation rejection and group stealing. |
| 0079 / 6 — missed deadline | `music.test.ts`: injected 250 ms stall reports exactly one miss and retains the current loop; browser evidence separately verifies scheduled sources. |
| 0079 / 7 — cancellation/seek/pause | `music-lifecycle.test.ts`: cancellation before/after promotion, failed readiness recovery, rules after resume/seek, per-transport stinger histories; browser pause output is silent and suspended audio time/tails remain frozen. |
| 0079 / 8 — no-frame scheduling/capabilities | `music.test.ts`, `music-lifecycle.test.ts`: 30 seconds without visual updates, capability rejection before admission and stale preparation rejection. |
| 0079 / 9 — save/load | `packages/save/src/audio-save.test.ts`: non-entry section, phase, parameters, paused/running variants, committed destination and old voice cleanup. `music-lifecycle.test.ts`: all preparations finish before any restored native source starts, changed/missing section fallback retains entry playback. |
| 0079 / 10 — performance | `advanced-perf.test.ts`: eight eight-stem transports after 32 request replacements; `audio/music-schedule` span/key, strict warmed allocation check and separately observable deadline misses. |

Additional integration checks cover schema/provides/dependency direction, generated audio guidance,
CLI/MCP method registration, bundle size and release-package installation/use. `references.test.ts`
covers path-only handles across every authored asset type, collections addressed by GUID, shared
canonical global banks, and GUID precedence over an outdated path.

## Measured evidence and limits

The machine-readable record is [audio-runtime-evidence.json](audio-runtime-evidence.json).
Downloadable Actions artifacts contain the complete performance report, browser signal/live
measurements, rendered showcase WAV and its JSON decisions/measurements. The committed record
identifies its tested runtime commit; later documentation-only commits do not change that runtime.

- Web Audio evidence measures Chromium's rendered samples, not speakers, device latency or subjective
  HRTF quality. Preview control dispatch is 60 Hz aligned to 128-sample render quanta; native music
  starts and envelopes use audio timestamps. Requested and actual control times are recorded.
- Hosted CPU timings retain the detected machine identity. The named laptop/desktop budget entries
  remain proposed until measured on those machines; unknown-host timings are reported against the
  reference allowance, not falsely marked as named-hardware enforcement. Allocation checks still run.
- Browser decode/node memory overhead, DSP CPU, network buffering, acoustic-provider cost and real
  device output latency are not included in engine-owned PCM/node counts or warmed engine timings.
- No claim of FMOD plugin/DAW parity, streamed sample-accurate stems, time stretching, portals,
  multilistener mixing within one session, or cross-client synchronized playback is made.

## Completion gates

- [x] Implement event/runtime, mixer/acoustics and adaptive-music contracts with schema-backed APIs.
- [x] Provide authored assets, generated guidance, CLI/MCP preview and the runnable audio-lab project.
- [x] Add logical, lifecycle, resource-ownership, browser-signal and warmed performance tests.
- [ ] Verify final audio evidence pipeline, inspect its artifacts and refresh the committed record.
- [ ] Pass the full repository pipeline and mark 0077–0079 implemented.
- [ ] Open the PR after the implementation/evidence checklist is complete.
- [ ] Pass all PR checks and merge the authorized change.
