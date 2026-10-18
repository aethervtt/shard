# Audio editor implementation checklist

Contract: [0080](../0080-audio-editor.md). PR: [#28](https://github.com/aethervtt/shard/pull/28).
This document maps acceptance to concrete evidence. Pending CI results are not passes.

| Contract | Implementation and verification |
|---|---|
| Headless schema editing for all six types | `packages/audio-editor/src/model.test.ts`, `schema.test.ts`; runtime definitions/validators reused |
| No-op saves, inheritance, opaque IDs and unknown host fields | model/schema/project tests; authored source stays separate from resolved preview |
| Database-backed host | `sqlite.test.ts`: SQLite persistence, server-style revision check, reopen and conflict |
| History, drag transactions, failed writes and atomic changes | model tests; explicit batch capability and parameter rename |
| Six workflows and real previews | audio-lab assets in static demo; `audio-editor-preview.test.ts` renders actual WAVs through shared CLI renderer |
| Static web and independent/shared panels | `audio-editor.test.ts`, `audio-editor-scale.test.ts`; scoped DOM and explicit session lifetime |
| Aether asset identity and delivery | preview/schema/waveform tests; opaque catalog IDs; no URL/file fallback; resolver leases |
| Studio persistence and audition | `apps/studio/scripts/audio-webview.mjs` through real Tauri/WebKitGTK, pending CI |
| Keyboard, accessibility, zoom, motion and narrow layout | browser keyboard/300 px journeys; native Orca speech log, pending CI |
| Failure/cancellation and capability reporting | preview/waveform/model tests; per-browser capability artifacts |
| Disposal and sibling isolation | 100 real play/dispose cycles plus 100 mount/dispose cycles; pending CI |
| Catalog scale and 300 px dark/light | 10,000 entries with bounded rows; screenshots and 200% zoom browser journey |
| Performance and size | registered `audio-editor/edit` / `audio-editor/draw`; full/mixer-only bundle fixtures, pending CI |
| Repository validation | typecheck, tests, lint, audio regression, build/size/release, pending final head |

No Aether repository changes are part of this PR. The editor ports and database fixture establish
the integration boundary; Aether's production adapter/schema registration remain application work.
Project-file hosts cannot promise cross-process atomic replacement without host coordination.

Performance budgets are proposed for the named laptop/desktop machines. Hosted runner results
must report their actual hardware; do not relabel them as named-machine measurements. Drawing
measurements cover shared Canvas drawing commands and meter updates, excluding compositor/GPU
presentation. Browser audio renders do not establish device output timing.
