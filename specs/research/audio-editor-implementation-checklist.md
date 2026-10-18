# Audio editor implementation checklist

Contract: [0080](../0080-audio-editor.md). PR: [#28](https://github.com/aethervtt/shard/pull/28).
This document maps acceptance to concrete evidence. Machine-readable measurements and artifact
hashes are in [audio-editor-evidence.json](audio-editor-evidence.json). Merge is gated on all PR
checks passing on the final head; the measurements below retain their exact tested provenance.

| Contract | Implementation and verification |
|---|---|
| Headless schema editing for all six types | `packages/audio-editor/src/model.test.ts`, `schema.test.ts`; runtime definitions/validators reused |
| No-op saves, inheritance, opaque IDs and unknown host fields | model/schema/project tests; authored source stays separate from resolved preview |
| Database-backed host | `sqlite.test.ts`: SQLite persistence, server-style revision check, reopen and conflict |
| History, drag transactions, failed writes and atomic changes | model tests; explicit batch capability and parameter rename |
| Six workflows and real previews | audio-lab assets in static demo; `audio-editor-preview.test.ts` renders actual WAVs through shared CLI renderer |
| Static web and independent/shared panels | `audio-editor.test.ts`, `audio-editor-scale.test.ts`; scoped DOM and explicit session lifetime |
| Aether asset identity and delivery | preview/schema/waveform tests; opaque catalog IDs; no URL/file fallback; resolver leases |
| Studio persistence and audition | `apps/studio/scripts/audio-webview.mjs` through real Tauri/WebKitGTK; durable -6 dB save, rendering voices and reopened value verified |
| Keyboard, accessibility, zoom, motion and narrow layout | Chromium, Firefox and WebKit keyboard/300 px journeys pass; native Orca announces Gain and Play through actual desktop keyboard navigation |
| Failure/cancellation and capability reporting | preview/waveform/model tests; per-browser capability artifacts |
| Disposal and sibling isolation | All three browsers pass 100 real play/dispose cycles; 100 mount/dispose cycles pass separately |
| Catalog scale and 300 px dark/light | 10,000 entries with bounded rows; screenshots and 200% zoom browser journey |
| Performance and size | Registered `audio-editor/edit` / `audio-editor/draw`; measured below proposed targets on hosted hardware; all bundle budgets pass |
| Repository validation | Typecheck, Linux/Windows unit shards, lint, audio regression and build/size/release pass; all final-head PR checks are a merge gate |

## Recorded evidence

Implementation checkpoint `36cb440ceb32ff2169ec8ed9e15f0c99b5121d52` was tested as GitHub's
synthetic merge `7d17b4f9d5112272269fd467accf31c7480d1c1e`. The
[editor run](https://github.com/aethervtt/shard/actions/runs/39104838287) has successful Chromium,
Firefox, WebKit and performance jobs; its native job failed and is not counted as native evidence.
The [audio/package run](https://github.com/aethervtt/shard/actions/runs/39104838432) is green.
Artifacts use the synthetic merge SHA in their names, as recorded in the JSON manifest.

- Each browser records dark/light 300 px screenshots, 200% zoom, accessible names, reduced-motion
  behavior, and keyboard-only create-layer/clip/curve/save/play/bus-route/music-marker operations.
- Chromium and WebKit each render eight WAV/trace pairs: engine, footsteps, spell, mixer, music,
  underwater, dialogue and pause. Every render has 24,000 stereo frames at 48 kHz, finite samples,
  nonzero RMS and zero clipped samples. Reports include seed and host asset IDs/revisions.
- Firefox passes live playback, waveforms, keyboard and lifecycle checks. Its tested
  `OfflineAudioContext` lacks suspend/resume, so offline WAV export is explicitly unavailable.
- All three browsers return owned PCM, encoded bytes, pins, URLs, voices and listeners to zero
  after disposal. The supplied backend retains its one root output node until its owner closes it;
  editor teardown leaves the sibling session rendering and the host context running.
- The 10,000-asset catalog mounts 60 rows, performs zero media resolutions while browsing, and
  leaves zero children after 100 mount/dispose cycles.

The hosted performance runner was an **Intel Xeon Platinum 8573C**, Linux `6.17.0-1022-azure`.
For 100 samples after warmup, edit median/p95 were **2.110/3.846 ms** and drawing median/p95 were
**1.535/1.660 ms**. Proposed medians are 4/8 ms. The report identifies the machine as unknown
and `enforced: false`; these are measured comparisons, not named laptop/desktop certification.

Compressed bundle measurements (Brotli bytes):

| Fixture | Entry | All JS | Budget |
|---|---:|---:|---:|
| Full editor | 44,949 | 44,949 | 256,000 |
| Mixer panel | 44,979 | 44,979 | 102,400 |
| Optional preview | 63,327 | 103,129 | Separately reported |
| Minimal renderer | 95,448 | 168,155 | Existing budget unchanged |

The baseline [main packaging job](https://github.com/aethervtt/shard/actions/runs/39081964185/job/117540583267)
and editor packaging report both emit renderer entry `index-NSRjFNio.js`, with the same reported
93.2 KiB entry and 164.2 KiB total JS. Editor fixtures enforce the absence of renderer/GPU/Tauri
dependencies. Builds, package installation smoke checks and benchmarks ran in Actions.

## Native Studio and accessibility

[Native job 117612664607](https://github.com/aethervtt/shard/actions/runs/39106268186/job/117612664607)
passed at `e4224ca5786f6526c92e176172c1b73b3fadd00f`, synthetic merge
`b174a75fefc5f3927764934ba2aa51cbcb604ff2`. Its artifact is
`audio-editor-studio-b174a75fefc5f3927764934ba2aa51cbcb604ff2`.

The actual Tauri/WebKitGTK app opened the audio-lab project, changed gain with verified native
keyboard focus, saved -6 dB to the source, auditioned with a running AudioContext and two rendering
voices, refreshed the native window, and reopened the persisted -6 dB value. The low-layer voice
reports gain 0.5012, consistent with the saved setting. `studio-webview.json` and its screenshot
record this separately from Playwright's WebKit engine.

Orca's real speech log records **“Gain Db -6 entry -6 selected.”** and **“Play push button.”**
The audit uses XTest desktop keyboard navigation and checks actual focus plus spoken output;
`screen-reader-audit.json` records field/action coverage. This is an automated audit, not a claim
of human listening or comprehensive accessibility certification. Chromium, Firefox, WebKit and
performance/scale jobs in that same editor run also passed.

## Integration limits

No Aether repository changes are part of this PR. The editor ports and database fixture establish
the integration boundary; Aether's production adapter/schema registration remain application work.
Project-file hosts cannot promise cross-process atomic replacement without host coordination.

Performance budgets are proposed for the named laptop/desktop machines. Hosted runner results
must report their actual hardware; do not relabel them as named-machine measurements. Drawing
measurements cover shared Canvas drawing commands and meter updates, excluding compositor/GPU
presentation. Browser audio renders do not establish device output timing.
