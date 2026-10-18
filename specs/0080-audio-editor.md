# 0080 — Embeddable audio editor

- **Status:** implemented
- **Packages:** new `@aethervtt/shard-audio-editor`, `@aethervtt/shard-audio-preview`, `@aethervtt/shard-audio`,
  `@aethervtt/shard-project`, `@aethervtt/shard-platform-tauri`, `apps/studio`, `apps/playground`
- **Depends on:** 0031, 0056, 0061, 0062, 0077, 0078, 0079

## Context

0077–0079 provide authored events, parameters, mixers, snapshots, acoustics and adaptive music.
People should be able to hear and adjust those assets visually, using the same data and runtime
as scripts and agents. Aaether needs a small ambience/mixer surface; game authors need detailed
event and music authoring; websites should embed either without installing Studio.

The current audio package exports data definitions, validators and runtime methods. It has no
editor document store or undo service. `apps/studio/src/main.ts` is still a placeholder scene,
not a project editor shell. This spec adds an independent SDK and an explicit Studio audio
workspace; it does not assume project opening or asset editing already exists there. This is a
scoped addition to VISION's tooling: APIs and schema-backed data remain primary, and audio never needs a GUI.

Sibling Aether inspection (2026-10-18): `packages/server/src/stores/sqlite.ts` stores JSON documents
by `(world_id, id)` and supports atomic batches; `mods/soundscapes/src/main.ts` saves definitions
using `documentId`/`baseRev`. Its ADR-0067 distinguishes Asset document IDs from media blob storage.
These establish adapter requirements; support for Shard mixer definitions in Aether is new work.

## Goals

- A framework-independent browser widget, plus separately mountable panels sharing one session.
- Author every 0077–0079 asset type using existing schemas, validators and source formats.
- Isolated audition, explicit live attachment, undo, conflict-safe saving and useful diagnostics.
- The same editor in a standalone web example and Studio, with host-supplied persistence.
- Keyboard-accessible controls, bounded visual work and evidence from real browser audio.

## Non-goals

- A DAW, destructive sample editing, recording, MIDI, arbitrary DSP/node scripting or FMOD imports.
- A general scene editor, 3D zone placement, cloud storage, collaboration/CRDTs or hosting service.
- New audio runtime guarantees, synthesis, loudness certification or sample-accurate streaming.
- Requiring React, WebGPU, Tauri, a Shard renderer or a running game to edit documents.

## Design

### Package and rendering boundaries

`shard-audio-editor/model` contains the DOM-free document session, commands and history. It
consumes audio data definitions and validators rather than duplicating them. The package's
`/dom` entry mounts the workspace; `/panels/event`, `/panels/mixer`, `/panels/music`,
`/panels/parameters`, `/panels/library` and `/panels/diagnostics` expose independent panels.
Panels receive the same session explicitly; there is no global editor or selection singleton.
Runtime packages never import the editor. Browser preview is an optional, lazy adapter using
`shard-platform-web`; attached-runtime preview uses the existing protocol.

Use DOM for forms, trees, tables, faders, menus, transport and timeline interaction targets.
Canvas 2D draws waveform envelopes, meters and dense timeline backgrounds; SVG draws optional
routing connections. Every graphical edit has a labeled DOM/numeric alternative. This is
tooling UI, distinct from 0036's engine-rendered game UI; no engine rendering dependency is added.

Mount an owned child with an open Shadow Root, scoped styles and documented CSS custom
properties for colors, typography, spacing and density. Popovers stay inside that root. Inherit
language/direction; accept string overrides and format numbers for display without changing
serialized numeric values. Provide a CSP-compatible stylesheet URL option. Shadow DOM isolates
styles, not untrusted code. Custom-element/framework wrappers are optional future conveniences.
Imports are safe without `window` or `document`; DOM access starts only at mount. No custom
elements, listeners, AudioContexts or styles register on import.

300 px is a supported dock width. At that width, panels stack controls, wrap action groups and
use one active view at a time. Dense timelines scroll inside the panel. No field or save/play
action becomes unreachable; enlarging the dock improves overview without being required to edit.
The host owns dragging, docking and resizing; every panel responds to its container, not the viewport.

### Panels and authoring workflows

| Panel | Required authoring and inspection |
|---|---|
| Library | Search/filter clips and all audio data types; create, duplicate and open assets; inspect references, preparation state and decoded memory; edit collection membership and preparation modes. Import delegates to an optional host capability. |
| Event | Named layers, selectors/weights/switch defaults, timing, envelopes, looping, concurrency, spatial fields, sends and parameter curves. Seconds timeline and waveforms visualize existing layer semantics; they do not introduce arbitrary timeline execution. |
| Parameters | Local/global definitions, labels/ranges/defaults, gates and curve points; clearly separate authored defaults from audition values. Renaming reports affected references rather than silently breaking assets. |
| Mixer | Bus hierarchy, routing/sends, ordered built-in inserts, user category controls and snapshot targets/weights. Display authored versus effective values and measured meters when available. Reject graph cycles before apply. |
| Music | BPM/meter, sections, stems, source-sample trim/loop markers, conformity settings, intensity curves, transitions, entry markers and stingers. Show bars/beats/ticks and exact numeric sample fields; expose readiness, chosen boundaries and missed deadlines. |
| Diagnostics | Schema/reference errors linked to fields; logical/presentation states, virtual voices, capacity decisions, memory, active revisions, bounded logs and preview measurements. |

Reverb-zone and obstruction settings use schema-derived property forms in the diagnostics panel
when a scene host supplies component selection/edit commands. Without that capability, offer an
audition listener/emitter position form and inspection only. Author mixer returns and IR references
in the mixer panel; do not claim scene editing from an audio-document host alone.

Built-in examples demonstrate surface footsteps, an RPM engine, a layered spell, a tavern/cave
ambience mix, underwater/dialogue/pause snapshots and exploration/combat music. A compact preset
mounts the mixer, snapshot controls and parameter sliders; the full preset mounts every panel.
Both use the same APIs and asset definitions. Presets are layouts, not separate implementations.

### Audio sources: the host asset catalog

The `assets` adapter is the sole source of playable content: clips, music stems and impulse
responses. In Aether, it connects to Aether's existing user-asset system. The library browses
that catalog (or invokes Aether's asset picker); selecting an audio asset stores its stable
host asset ID and resolves metadata/content through the adapter. The editor does not offer
computer-file selection, arbitrary URL entry or file-drop playback in this integration.

The flow is **Aether asset catalog → asset ID in the authored document → host resolver →
preview/runtime playback**. The adapter maps opaque host IDs into Shard asset handles without
requiring local project paths or copying user audio into a separate Shard library. Resolution
carries the host's access scope and asset revision. A signed URL or bytes may be an internal
delivery mechanism, but neither becomes the saved identity or an alternate user-facing source.
An unknown, deleted or inaccessible asset produces an actionable error; there is no fallback
to interpreting its ID as a URL or filesystem path.

Waveform generation, preparation, audition and export all use this same resolver and its
capabilities. Cache keys include host scope, asset ID and revision; release on scope change and
honor host invalidation. URL renewal/authentication belongs to the adapter. Capability checks
apply to API/JSON edits as well as the picker, so pasted references cannot bypass host resolution.
If a host enables uploads, its own import flow must create a catalog asset before selection or
playback. Aether-specific catalog APIs remain in Aether's adapter; no backend shape is assumed.

### Documents, validation, history and persistence

The `documents` adapter loads/saves authored events, mixers and music definitions; `assets`
supplies the audio they reference. A document is an opaque ID, revision, explicit schema/type
identity and JSON-compatible value. No filename, extension, directory, `.meta` sidecar, filesystem
watcher or `shard.json` is required. An optional source-text representation supports file hosts.
`open(id)` passes the ID unchanged to the adapter; types come from metadata, never ID suffixes.
Only the project-file adapter applies 0077's path/GUID conventions and source serialization.

Aether's adapter maps document values to its server-authoritative document APIs and SQLite
persistence. It preserves host envelopes, ownership and revisions; the widget neither opens
SQLite nor writes around server validation. Updates/subscriptions replace filesystem watching.
Expected revisions and atomic batches must be enforced by the host server; low-level SQLite
batch support alone does not supply authorization or compare-and-swap. Schema registration for
mixers/events/music and any required host API changes belong in Aether's integration work.

References stay as stable host IDs, never temporary preview URLs. Preserve `$extends`, unrelated
fields and authored overrides; show inherited values and explicit override/reset actions. Never
flatten inheritance on save. No-op saves issue no write or revision bump; file adapters additionally
preserve original bytes. A newer unsupported schema version opens read-only.

Schema reflection generates property controls, defaults and validation paths. Domain views
(curves, routing, timeline) emit commands over those same fields; they do not own parallel
serializers or validation rules. Cross-field/dependency checks reuse the runtime validators.
Invalid local drafts remain editable, but cannot replace last-good preview data or be published
as valid runtime assets. Raw JSON editing is an optional view with the same validation boundary.

A document session owns selection, dirty state and bounded undo/redo. A drag is one transaction;
Escape restores its initial value. Keyboard/numeric edits use the same command path. Default
history limits are 200 transactions or 16 MiB, whichever comes first; report eviction and keep
the saved baseline separately. Document edits, audition controls and host settings are distinct:
undoing an authored gain never undoes a player's volume preference or a live game command.

Saving is explicit by default. Adapter commits compare expected revisions; a multi-document
transaction is atomic or returns unsupported before writing anything. A reference rename uses
that transaction boundary; hosts without atomic support disable cross-document rename. Save
returns new revisions only after durable host acknowledgement. Failure keeps drafts/history.
An external update reloads a clean document; a dirty one enters conflict state with local and
remote versions available. Reload/discard or save-as are explicit actions; no silent overwrite
or automatic conflict merge. Undo after save is a new dirty edit, never a rollback of host storage.

Asset watchers, requests and preview work carry generation tokens and cancellation. A late read
cannot overwrite a newly selected document. Optional draft recovery storage belongs to the host.
Widget unmount never implicitly saves; the host can inspect dirty state before navigation.

### Audition and live runtime attachment

Opening/mounting is silent. Play starts or resumes audio inside a user gesture and shows
blocked/preparing/rendering/failed states from 0077. Default audition owns an isolated session
and read-only base catalog with a validated in-memory draft overlay. Resolve dependencies through
the host; no save, import or game mutation is needed to hear an unsaved draft. New preview
instances use the latest valid draft revision; running instances retain their pinned revision.
An explicit Restart/Apply action uses the existing runtime reload/configure boundaries.
Ordinary catalog updates invalidate pending/future work while running voices retain their pins;
immediate access revocation uses a host scope change or session disposal to stop owned audio.
Isolated audition bounds retained requests and document revisions to 256 each; Stop releases
those pins, and capacity errors explain that recovery action. Failed starts release partial ownership.

Attachment to a running game is a distinct mode naming its target/session. Read-only inspection
is the default; the host grants live-control capability explicitly. Commands reuse `audio.play`,
`audio.stop`, `audio.parameter.set`, snapshot and music methods. Missing draft-apply capabilities
are reported, not emulated by silently saving files. Audition Stop All affects only editor-owned
instances; attachment never gains a global stop or context-close privilege by implication.

Meter reads are capped at the backend's 20 Hz, with timestamp and measured/unavailable status.
Waveform envelopes are cached by clip revision/channel/resolution; they are not decoded every
frame. A worker can derive envelopes from explicitly requested data; metadata-only catalog
listing never decodes the library. Default editor envelope cache is 32 MiB with LRU eviction;
runtime PCM retains 0077's separate accounting. Cancel jobs and release leases on close.

The optional `shard-audio-preview` browser-tooling package shares the offline renderer between
the CLI and editor without depending on editor/model/DOM packages. Engine runtimes never import it.
Preview export reuses 0078's render plan and produces WAV plus trace/measurement JSON through
a host export adapter. Capability absence disables export with a reason. Reports preserve seed,
asset revisions and controls, and distinguish rendered measurements from logical assertions.
Canvas position or a play callback never claims sample-accurate speaker output.

### Host contract and API sketch

`AudioDocumentStore`, `AudioAssetCatalog` and `AudioPreviewAdapter` are proposed new contracts.

```ts
import { createAudioEditorSession } from '@aethervtt/shard-audio-editor/model'
import { mountAudioEditor } from '@aethervtt/shard-audio-editor/dom'
import { mountAudioMixer } from '@aethervtt/shard-audio-editor/panels/mixer'

const session = createAudioEditorSession({
  documents, // read/subscribe by opaque ID; host-authoritative commit with expected revisions
  assets, // host catalog/picker, stable IDs and authorized content resolution; sole audio source
  preview, // optional owned audition or capability-limited attached runtime
})
const editor = mountAudioEditor(container, { session, layout: 'full', theme: 'dark' })
// A second view can share history/selection without opening another audio session.
const mixer = mountAudioMixer(sidebar, { session })
await session.open(selectedMixer.id) // e.g. an Aether document ID, not a file path
await session.save() // validates; returns revisions or structured conflict/error
mixer.dispose()
editor.dispose() // removes only this view, listeners, observers and animation callbacks
await session.dispose() // cancels work and releases editor-owned preview resources
```

Disposal is idempotent and a pending operation cannot resurrect a disposed view/session. The
caller owns session lifetime when multiple panels share it. Supplied contexts, host storage,
host styles and unrelated audio remain untouched. Host authentication, URL authorization and
storage policy remain in adapters; the editor renders asset names/errors as text, never HTML.
The widget opens no sockets or filesystem paths on its own. Read-only hosts omit commit capability.

Ship an in-memory adapter with JSON import/download for a static website and a project adapter
using existing project validation/import services. Studio adds an explicit audio-project opener
and passes file access through platform services; Tauri SDK calls stay in `platform-tauri`.
Website embedding needs neither a local hub nor a desktop shell. Aaether's application-specific
document and audio-asset adapters belong in Aaether; an Aaether-like fixture in this repo proves
the contract. JSON import in the standalone demo grants no alternate audio-source capability;
every referenced clip must still resolve through that demo host's catalog.

### Agent surface

The DOM-free session exposes schema-backed edit/validate/history/commit commands and serializable
state (document revisions, dirty/conflict state, diagnostics and preview ownership). GUI and agent
calls use the same commands. An optional host registration exposes `audio.editor.describe`,
`edit`, `validate`, `undo`, `redo` and `commit` through protocol/MCP with existing authorization;
no editor server is started implicitly. Assets remain directly editable without this package.
Errors are `ShardError` with `audio-editor/*` codes, asset/JSON path and a corrective hint:
`conflict`, `read-only`, `invalid-document`, `unsupported-schema`, `unsupported-capability`,
`disposed` and `asset-unavailable`. Preserve underlying audio error details.

### Delivery and performance

Deliver A: model/adapters, history, conflicts and library/event/parameter panels; B: mixer/music,
snapshots, diagnostics and waveforms; C: static embed, Studio and evidence. All three are required.

Virtualize catalog rows and draw visible waveform ranges on changes/transport animation. Hidden
or idle panels stop visual callbacks/polling; audio scheduling and engine update loops are independent.

Proposed 0075 unit keys on both named machines: `audio-editor/edit` median <= 4 ms for a curve
edit/validation in a 16-layer event; `audio-editor/draw` median <= 8 ms for a 1280×720, DPR 2 view
with 16 visible waveform lanes and 32 bus meters. Basis: one quarter/half of a 60 Hz UI frame;
these are proposed targets, not measurements. Register keys on implementation and record p95
and machine identity separately. Add 0056 compressed-size fixtures with proposed budgets of
100 KiB for mixer-only and 250 KiB for full editor (including transitive model/DOM code, excluding
lazy preview runtime and source maps); measure preview chunks separately. Renderer-min is unchanged.

## Decisions

- **DOM with targeted drawing.** Accessible controls and web embedding with bounded waveform work.
- **Framework-independent panels.** Studio and websites compose the same editor without a UI framework mandate.
- **One data model.** Visual authoring remains an optional client of Shard's text/schema APIs.
- **Host-owned storage and explicit preview ownership.** Embedding does not seize the host's project or audio.
- **Drafts are separate from live execution.** Incomplete edits cannot corrupt running audio or saved assets.
- **CI measurement provenance.** Builds and benchmarks run in Actions. Hosted measurements are
  compared with the proposed unit targets and record actual hardware; named laptop/desktop
  certification remains unclaimed until those machines are measured. Size budgets are enforced.

## Acceptance criteria

- [x] Node can import/model-edit/validate/undo/save every audio asset type without DOM or Web Audio;
      equivalent GUI/API edits produce equivalent JSON and runtime validation errors.
- [x] No-op saves perform no write/revision bump; file sources remain byte-identical. Round trips
      preserve host IDs, inheritance and unrelated fields; validation errors have actionable paths.
- [x] A database-backed adapter fixture creates/edits/saves/reopens a mixer by opaque ID without
      filenames or a project filesystem; server revision conflicts and remote updates reach the UI.
- [x] Drag cancel/grouping, bounded history, failed saves, external changes, atomic rename and
      stale revision conflicts pass tests; no conflict path silently overwrites remote data.
- [x] Author and audition all six example workflows above; exported files load in the existing
      CLI/runtime without editor packages. Preview WAV/trace probes verify event, mixer and music results.
- [x] A plain static website mounts the full editor and a mixer-only widget; two independent
      sessions have isolated styles, shortcuts, storage and audio. A shared-session pair shares history.
- [x] An Aether-like host browses/picks, previews and reopens audio by opaque host asset IDs with
      no local paths. Waveforms/export use its resolver; unavailable assets and pasted arbitrary
      URLs fail without fallback. Scope changes isolate caches; renewed delivery URLs do not
      change saved references. No computer picker, URL field or file-drop playback is exposed.
- [x] Studio opens an audio project, edits/saves/reopens an event and auditions it through the
      same panels; filesystem operations use platform services. Read-only hosting also works.
- [x] Keyboard-only users can create a layer, edit curve points, route a bus, edit music sample
      markers, save and audition; controls have accessible names, focus visibility and numeric
      alternatives. Check focus/zoom/reduced-motion and perform a recorded screen-reader audit.
- [x] Browser tests cover unlock, missing capabilities, denied access, lost attachment and pending
      loads during close. Late completions cause no sound or DOM resurrection.
- [x] Repeating mount/play/dispose 100 times returns owned leases/nodes/URLs/listeners/workers to
      baseline while another host session keeps playing. Inspecting/mounting alone stays silent.
- [x] At 300 px width and 200% zoom, controls remain reachable; large timelines scroll within
      their panel. Hidden/idle views cease visual work; a 10,000-asset catalog keeps <= 100 mounted rows.
- [x] Registered unit measurements meet proposed targets on the measured CI hardware and size
      budgets pass; capture actual machine identity, median/p95 and before/after bundles without
      claiming named-machine certification. Existing audio correctness/signal suites remain green;
      run strict benches if runtime changes.
- [x] CI records browser journeys, preview artifacts and adapter tests; typecheck/test/lint pass.
      Chromium, Firefox and WebKit cover DOM journeys; report audio capabilities per tested browser
      and verify the Studio webview separately rather than inferring support from Chromium.

Implementation and evidence: [acceptance checklist](research/audio-editor-implementation-checklist.md).

## Open questions

- None blocking delivery. Deferred: collaborative editing, framework/custom-element wrappers,
  an iframe messaging bridge, 3D zone gizmos and arbitrary DSP graphs.

## References

- [Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)
  supports the chosen style boundary and explicit theming; it is not a security boundary.
- [Canvas accessibility](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas)
  motivates DOM controls and equivalent numeric editing alongside graphics.
- [Web Audio best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
  inform gesture-started previews and explicit playback controls.
