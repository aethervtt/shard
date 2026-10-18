# Audio editor

Embeddable audio authoring for Shard events, parameters, collections, mixers, snapshots and music.
The editor uses DOM controls and Canvas waveforms. It needs no renderer, GPU, UI framework,
filesystem or desktop application. Every panel supports a 300 px container; detailed timelines
scroll within the panel. A larger dock exposes more controls at once.

```ts
import { createAudioEditorSession } from '@aethervtt/shard-audio-editor/model'
import { mountAudioEditor } from '@aethervtt/shard-audio-editor/dom'
import { createIsolatedAudioPreview } from '@aethervtt/shard-audio-editor/preview'

// Implement these ports using your application's existing document and asset services.
const preview = createIsolatedAudioPreview({ documents, assets })
const session = createAudioEditorSession({ documents, assets, preview })
const view = mountAudioEditor(container, { session, theme: 'dark' })
await session.open(selectedMixer.id)

view.setTheme('light')
// Set host theme tokens on this owned element; other widgets remain independent.
view.element.style.setProperty('--ae-accent', '#19766d')

// The host controls navigation and can inspect session.state.dirty before closing.
view.dispose()
await session.dispose()
```

`documents` and `assets` are host implementations of the interfaces exported by `/model`.
They are not globals supplied by Shard. Mounting and inspecting the editor are silent; **Play**
unlocks browser audio through a gesture. The preview loads optional runtime code separately.
If a browser remains suspended, the UI reports it and a subsequent Play gesture can resume it.

## Database and asset integration

`AudioDocumentStore.read(id)` returns `{ id, name, type, revision, value }`, with optional
`schemaVersion` and `sourceText`. `value` is the schema-backed JSON definition; `type` names an
audio schema such as `audio/AudioMixer`. IDs and revisions are opaque strings. A SQLite-backed
website sends the ID to its server, which reads and updates the database. Shard never opens the
database, requires a file extension or substitutes a directory for that ID.

`commit(changes)` validates expected revisions and permissions at the host's authoritative write
boundary. `expectedRevision: null` creates a new document; a string replaces precisely that
revision. Return all acknowledged documents with new revisions. Advertise `atomic: true` only
when the entire batch commits or none does. `subscribe` announces changed IDs. Omit `commit`
for read-only embedding. The model retains dirty drafts on rejection and exposes remote conflicts.
No-op saves issue no write; undo after save creates a new dirty draft.

`AudioAssetCatalog` lists and resolves the host's existing assets. `get` supplies metadata and
revision; `resolve` supplies authorized encoded bytes and an optional release callback. It never
interprets unknown IDs as URLs. Audio references in definition values use `{ guid: assetId }`;
host scope is part of cache identity. Events can reference other audio data assets through the
same catalog. The document store reads those definitions, while the catalog resolves clip bytes.
Scope/authentication changes should create a fresh editor session; never reuse old drafts in a
different world. Ordinary asset invalidation cancels pending loads and clears waveform caches;
running voices keep their pinned revisions and new auditions resolve current metadata. For
immediate access revocation, the host changes scope or disposes the session to stop owned audio.

An optional `pick(type)` opens the host's own picker. Otherwise the editor uses the paginated
catalog. There is no computer file picker, arbitrary media URL field or file-drop playback.
Waveforms and offline export require encoded bytes from the authorized resolver. A resolver may
expose a URL for a host-specific preview adapter, but the built-in decoded audition uses bytes.

`createMemoryAudioHost` supplies a revisioned in-memory host for a static website or tests.
`openAudioProject` from `/project` adapts a Shard project using `Platform.fs`. Its file writes
detect changed sources and serialize within the adapter; external writers must be coordinated
by the host because the platform has no cross-process compare-and-swap. It advertises no atomic
multi-document support. These adapters are examples of the same host boundary, not prerequisites.

## Panels, styling and interaction

Mount only the desired surface from `/panels/event`, `/panels/mixer`, `/panels/music`,
`/panels/parameters`, `/panels/library` or `/panels/diagnostics`. Their exports are
`mountAudioEvent`, `mountAudioMixer`, `mountAudioMusic`, `mountAudioParameters`,
`mountAudioLibrary` and `mountAudioDiagnostics`. Views can share one session/history; dispose the
session only after all its views are closed. The host owns the dock grip, resizing and pop-outs.
Set the container's height; the editor scrolls its own body and responds to its container width.

Every mount has a separate Shadow Root. `theme: 'dark' | 'light'` selects defaults; host CSS tokens
include `--ae-background`, `--ae-surface`, `--ae-input`, `--ae-text`, `--ae-muted`, `--ae-border`,
`--ae-accent`, `--ae-danger`, `--ae-radius`, `--ae-font`, `--ae-space` and `--ae-control-height`.
Additional palette tokens are `--ae-on-accent`, `--ae-hover`, `--ae-subtle` and `--ae-track`.
Wide panels place the authoring surface beside the properties inspector. Narrow docks stack
them; mixer faders change from vertical strips to horizontal rows. Select an event layer name
to open and focus its schema controls. Opening a document selects its corresponding view.
Waveforms show source audio; the expandable seconds view shows authored timing, with dots
for source-length layers whose end cannot be inferred from their authored duration.
`strings` overrides UI text. A `stylesheetUrl` can serve the exported `audioEditorStyles` under a
strict CSP. It is a host-owned style resource, never an alternate audio source.

Forms are generated from runtime schemas. Lists support add/remove/reorder, curves have exact
numeric point controls, and asset handles use the catalog picker. Parameter renaming reports
dependent documents and uses an atomic host transaction. Graphical controls have numeric
alternatives; drag operations are one undo transaction and Escape cancels them. Ctrl/Cmd+Z and
save shortcuts are scoped to the focused editor. Diagnostics expose invalid drafts, actual
backend states, measured meters and capabilities. Optional scene hosts can supply schema-backed
component selection/editing through the mount's `scene` adapter and call `view.refresh()`.

## Preview, export and agent tools

Audition owns a separate runtime session. Valid unsaved definitions can play without saving.
Stop and disposal only affect editor-owned instances; borrowed host audio roots remain alive.
An audition retains at most 256 requests and 256 document revisions; **Stop** releases those
pins before further preparation. Failed or cancelled starts release their partial ownership.
The optional attached preview adapter defaults to inspection; live commands and applying drafts
require explicit host capabilities. The host supplies its existing authenticated protocol call.

Offline preview and the CLI share the optional `@aethervtt/shard-audio-preview` renderer;
neither the CLI nor engine runtime depends on editor UI packages. Export produces a WAV plus
measured peak/RMS, control trace, seed and asset revisions. Event and music documents have default
plans. A mixer needs a plan naming test voices/events to produce sound; the mixer alone is silent.
Browser support is capability checked, including scheduled offline suspend/resume; an unavailable
backend does not fabricate measurements. This is rendered-signal evidence, not speaker latency.

`audioEditorMethods(session)` from the package root returns methods for explicit registration
with the existing protocol: describe, edit, validate, undo, redo and commit. Host authorization
still applies. The model's edit/history/save APIs work headlessly and do not require mounted views.

## Try and verify

From this workspace, run `pnpm playground` and open `/audio-editor.html`. The example offers full
and compact widgets, six audio workflows, dark/light themes and a **300 px panels** control.
Its data is tab-local; download a definition to retain it. Studio's **Audio workspace** opens
project documents and persists edits through its platform adapter.

Spec [0080](../../specs/0080-audio-editor.md) is the acceptance contract. CI collects browser
journeys, actual audio renders, native Studio screenshots/accessibility logs, teardown/scale
checks and performance/package reports. See the
[implementation checklist](../../specs/research/audio-editor-implementation-checklist.md) for recorded results.
