# Audio system audit and research — 2026-10-17

This is supporting evidence and implementation prioritization, not an accepted feature contract.
The request is an engine-wide sound system for Aether, games and other embedded applications.
Recommendation: build FMOD-like event authoring and runtime control on Shard's existing audio,
with text assets and testable behavior. Do not replace the backend or recreate FMOD Studio's GUI.

## Proposal map

| Stage | Contract | Why first / proof |
|---|---|---|
| 1A | [0077: runtime corrections](../0077-audio-events-runtime.md) | Eliminate inspection/playback disagreement and lifecycle leaks before adding complexity. |
| 1B–C | [0077: sessions, preparation, events and parameters](../0077-audio-events-runtime.md) | Surface footsteps, layered spells, RPM engine, UI notifications and Aether scene beds share an authoring model. |
| 2 | [0078: mixer, snapshots, effects and acoustics](../0078-audio-mixing-acoustics.md) | Dialogue ducking, underwater filters, room reverb and player settings work together. |
| 3 | [0079: adaptive music](../0079-adaptive-music.md) | Layered exploration/combat music, next-bar reveals and stingers; can follow 0077 independently of 0078. |
| 4 | [0050: soundscapes](../0050-soundscapes.md) | Procedural ambience/weather/creatures reuse shared parameters, effects and preview. |
| Later | Separate specs only when needed | AudioWorklet streaming/custom DSP, room/portal propagation, real-time synthesis, surround/multiple listeners and network clock synchronization. |

Priorities are architectural judgment, not a claim that all products need all plugins. Aether
should be able to use room/scene events and music without terrain, physics, weather or procgen.
Simple games keep `playSound`; advanced sound authoring does not become mandatory setup.

## Current implementation: source audit

Paths refer to this checkout at audit time. 0035 is implemented; 0050 is accepted but its
soundscape, reverb-zone and procedural-audio runtime is not implemented. Existing tests establish
logical correctness, not the complete browser/audio-device behavior described in 0035.

| Capability | Current evidence | Assessment |
|---|---|---|
| Imports | `packages/audio/src/clip.ts`, `formats.ts`, `formats.test.ts` | WAV, Vorbis, Opus, MP3 and FLAC metadata; import settings, loop regions, peak normalization metadata. Actual decoding remains host-dependent. |
| Clip playback | `packages/audio/src/api.ts`, `components.ts`, `plugin.ts` | ECS source/listener, one-shots, loops, preload helper, stop fades, pitch/gain variation. |
| Spatial | `packages/audio/src/spatial.ts`, `mixer.ts`, `headless.ts` | Attenuation, equal-power pan model, Web HRTF option, Doppler, gain-only occlusion hook. No geometry acoustics. |
| Mixing | `packages/audio/src/mixer.ts:372`, `components.ts:127` | Named buses, mute, parent gain multiplication, activity ducking. Bus resource is not schema-backed. |
| Voice limits | `packages/audio/src/mixer.ts` | Global/per-clip physical limits, priorities, quietest/oldest tie breaking, virtual entity sources, stolen/dropped one-shots. |
| Observation | `packages/audio/src/methods.ts:19`, `apps/cli/src/mcp.ts:561`, `packages/testing/src/index.ts:109` | Describe/log, MCP and gameplay audio assertions exist. No event authoring/control or measured signal validation. |
| Hosts | `packages/project/src/host.ts:117`, `packages/platform-tauri/src/index.ts:124` | Backend injection; Tauri reuses browser implementation; Node uses metadata records. |
| Data integration | `packages/assets/src/data.ts:343`, `apps/cli/src/commands.ts:220` | Reuse schema-backed data assets, GUIDs, dependency collection, `$extends`, validation and generated docs. |
| Settings/save | `packages/save/src/settings.ts:309`, `save.ts:330` | Player bus volumes persist through settings; voices/playheads are not automatically saved. Save needs explicit schema + persist resources. |
| Performance | `packages/audio/src/perf.test.ts`, `bench/perf/budgets.json:36` | Existing targets: 0.1 ms/48 moving sources and 0.5 ms/512 sources with 64 real voices on both named machines. Not remeasured in this documentation task. |

## Confirmed defect and foundation gaps

**Runtime-confirmed: source reconfiguration diverges from playback.** Start a spatial source at
`[10, 0, 0]`, then change its bus to `music`, loop to false, minDistance to 5 and panning to HRTF.
`audio.describe` reports music/nonlooping/gain 0.5; the actual headless backend retains
sfx/looping/equal-power/refDistance 1 and measures gain 0.1. `mixer.ts:559` updates logical fields,
but `mixer.ts:746` only sends gain/pitch/position through the restricted backend update interface
(`packages/platform/src/index.ts:277`). Add this as a regression before expanding the API.

The following findings are source-proven limitations; no audible browser reproduction is claimed:

- **Clock/readiness:** `platform-web/src/audio.ts:131` computes delayed offsets from wall time
  and current pitch, while `mixer.ts:604` integrates simulation delta and previous rate. Web
  buffer sources start immediately (`audio.ts:179`). No transport/deadline/cancel contract exists.
  `preload` returns void; decode failures log without per-voice presentation feedback.
- **Streaming:** `audio/src/clip.ts:53` reads the entire artifact, then
  `platform-web/src/audio.ts:120` copies bytes into a Blob for media-element playback. This
  avoids eager full PCM decoding, but is not bounded encoded-memory/network streaming.
- **Routing:** every Web bus connects directly to output (`platform-web/src/audio.ts:87`).
  Shared inserts/sends require real topology and must avoid applying parent gain twice.
- **Resource lifetime:** decoded buffers use a WeakMap keyed by bytes; there is no explicit PCM
  budget/eviction, preparation lease or URL revocation. Headless history retains every voice;
  clip-count maps retain clip objects. Metadata logs are capped but lack truncation cursors.
- **Validation:** parent cycles are depth-capped rather than rejected (`mixer.ts:381`);
  component random ranges are clamped/reordered (`mixer.ts:784`) while API ranges throw.
  Direct scalar options also need consistent finite/range checks.
- **Reload/save:** clips update in place (`clip.ts:76`) while existing browser sources hold the
  old buffer. There is no defined live revision/crossfade or audio save-reset lifecycle.
- **Embedding:** current disposal avoids closing an injected backend, but buses, listener and
  error callback are backend-global. Isolated sessions need an explicit contract. Web Audio's
  one listener per context also requires listener-relative session coordinates or separate contexts.
- **Verification:** headless `measure` models scalar gain/pan, not waveform peaks, normalization,
  filters, HRTF, clipping, tails or actual speaker timing. New tests must distinguish these domains.

## Research: useful FMOD ideas

Primary documentation was consulted on 2026-10-17. These are conceptual precedents, not claims
of binary/API compatibility, equivalent DSP quality or a requirement to adopt FMOD's SDK.

| Precedent | Source | Shard decision |
|---|---|---|
| Events combine sound sources, parameters and timeline behavior; each instance has its own state. | [FMOD authoring events](https://www.fmod.com/docs/2.04/studio/authoring-events.html) | Reusable event assets, separate instances and clip voices, layered/selectable sound. |
| Continuous, discrete/labeled and local/global parameters drive automation. | [FMOD parameter reference](https://www.fmod.com/docs/2.04/studio/parameters-reference.html) | A shared typed parameter/curve evaluator used by events, music, mixing and soundscapes. |
| Routing, returns and snapshots shape the mix. | [FMOD mixing](https://fmod.com/docs/2.04/studio/mixing.html) | An acyclic graph and deterministic snapshot composition, with settings kept separate. |
| Logical/virtual channels differ from physical rendering channels. | [FMOD resource management](https://www.fmod.com/docs/2.04/api/managing-resources-in-the-core-api.html) | Separate instance/voice limits; preserve virtual playheads and expose admission decisions. |
| Streaming reads incrementally rather than holding all sample data. | [FMOD Core concepts](https://www.fmod.com/docs/2.04/api/core-api-concepts.html) | Honest playback/memory modes, readiness leases, collections and explicit eviction. |
| Live iteration and capture reveal running event/mixer behavior. | [FMOD live update](https://www.fmod.com/docs/2.04/studio/editing-during-live-update.html), [profiling](https://www.fmod.com/docs/2.04/studio/profiling.html) | Existing Shard protocol, hot reload, traces, parameter sweeps and preview renders become the authoring loop. |

## Platform feasibility and deliberate limits

Web Audio supports time-scheduled decoded sources and parameter automation. Use one audio epoch
for aligned stems, schedule ahead, and expose missed deadlines; a JavaScript scheduler does not
guarantee immunity to long stalls. The standard identifies AudioWorklet as the route for precise
streamed playback, beyond this initial scope. [W3C Web Audio](https://www.w3.org/TR/webaudio-1.0/#AudioBufferSourceNode)

`decodeAudioData` takes complete file data and resamples to the context rate. Media playback is
useful for long tracks but must not inherit the decoded-stem timing guarantee.
[MDN decoding](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)

Buffer source nodes are single-use. Reuse decoded samples and engine records; zero steady-state
engine allocations cannot honestly mean no browser allocations at playback boundaries.
[MDN buffer source](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode)

Gesture restrictions and host codec differences require explicit blocked/failed/readiness states
and testing on target browsers/webviews. A metadata parser accepting a codec does not certify
playback support. [MDN audio best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)

`OfflineAudioContext` renders samples without a hardware output. A browser-hosted offline runner
can produce WAV previews and signal assertions while pure Node tests remain lightweight. Browser
decoding/resampling/HRTF/effects output is tolerance-tested, not promised bit-identical.
[MDN offline context](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext)

Panning and convolution are useful building blocks, not geometry propagation. Start with authored
zones and an injected, budgeted obstruction provider. [MDN PannerNode](https://developer.mozilla.org/en-US/docs/Web/API/PannerNode),
[ConvolverNode](https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode)

AudioWorklet requires a secure context. SharedArrayBuffer transport additionally needs cross-origin
isolation; the worklet itself does not intrinsically require shared memory. These deployment and
underrun concerns belong to a later streaming/custom-DSP spec.
[MDN AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet),
[crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)

## Validation performed

- Audio correctness suite: **3 files, 30 tests passed**, invoked directly through the installed
  Vitest executable from `packages/audio`. Separate temporary runtime reproduction confirmed the
  live source update defect above. No repository implementation or tests were modified.
- Type checking: direct installed Turbo invocation completed **47/47 cached tasks**. This is a
  cache-backed result, not a fresh compiler pass over every package.
- Lint: direct installed Biome invocation completed successfully, **5 existing warnings**, no fixes.
- Required `pnpm typecheck`, `pnpm test` and `pnpm lint` were attempted. The installed package
  manager attempted to resolve `@pnpm/macos-x64@10.19.0` from npm and failed with
  `ERR_PNPM_BAD_CONFIG_DEP` / DNS failure in this environment. Direct Turbo's full test run hit
  the same package-manager bootstrap failure before test execution. **Full suite not validated.**
- No audible browser/Tauri listening test, offline signal render or strict performance benchmark
  was run. New budgets in the drafts are explicitly proposed targets, not measured achievements.

All three new specs remain **draft** for human acceptance. Existing implementation stays intact;
the design does not silently mark the accepted soundscape proposal or newly proposed work complete.
