# 0081 — Reusable effect sequences

- **Status:** draft (implementation authorized; CI evidence pending)
- **Packages:** `@aethervtt/shard-effects`, project, CLI, playground
- **Depends on:** 0026, 0032, 0061, 0074, 0075, 0077

## Context

A spell, door, ability telegraph or reward reveal coordinates several existing runtimes.
Today the author writes bespoke scheduling and cleanup code for each. An effect sequence is
an asset that composes those runtimes, with named target bindings and observable execution.
Gameplay remains authoritative: an impact marker describes presentation, never applies damage.

## Goals

- Reusable, schema-validated sequences for movement, lights, camera properties, animation,
  particles, audio and markers, with explicit timing and ownership.
- Host-owned catalog references, including GUID-only database assets; no file picker, fetch,
  URL interpreter or SQLite dependency in the runtime.
- Deterministic timeline decisions, preparation, cancellation, bounded diagnostics and a real
  browser spell proving the composition. Headless execution uses the same scheduler.

## Non-goals

Visual timeline editor, nested sequences, arbitrary script tracks, authoritative gameplay,
network transport, reverse playback, audio sample-accurate synchronization, ribbons/decals,
skeletal animation blending UI and production export are separate work.

## Design

### Documents and preparation

`EffectSequence` is a `defineDataType` (`effects/EffectSequence`, `*.effect-sequence.json`).
Its schema drives defaults, validation, JSON Schema, project import and protocol inputs.
Hosts may instead supply a JSON document directly and register its dependencies in their
existing AssetServer. Documents contain no platform assumptions. Prepared documents are
snapshots: edits affect the next preparation, not an active instance.

The document has `duration`, named numeric `parameters` (default/min/max), `targets`, and
`tracks`. A target has an `id` and optional `prefab` handle. Prefab targets are owned and
spawned per play; other targets must be supplied by the caller as entity bindings. Tracks
may address a relative child `path` under that target. Preparation loads and pins prefab,
animation, particle and authored audio assets; failures unwind all leases. No visible work
starts until preparation succeeds. Releasing a preparation is idempotent; active instances
retain it until they finish. Disposal invalidates pending preparation.

### Tracks

Every track has a unique `id`, `kind`, `target`, `path`, `start` and `duration` in seconds.
All times are finite and within the document duration. Markers have zero duration; other
tracks have positive duration. Starts and ends are ordered by time then document order;
ends precede starts at the same time (1 ns tolerance for decimal times), permitting adjacent tracks on one field.

| Kind | Payload and behavior |
| --- | --- |
| property | `component`, `field`, numeric `from`/`to` arrays, `easing` linear/smoothstep, optional numeric `parameter` multiplying values. Float scalar/vector/color fields only; schema bounds checked at play. Useful for transforms, light intensity and camera properties. |
| animation | `animation` clip handle on an owned target. Adds a sequence-controlled animation layer, sampled by the existing animation plugin; holds the exact final pose until replaced or cleaned up. |
| particles | `particles` effect handle on an owned target. Runs an existing ParticleSystem with a seed derived from instance seed and track index. |
| audio | `audio` authored AudioEvent handle. Prepared through the existing audio runtime; stopped at track end/cancellation. Spatial emitter follows the bound target. |
| marker | `marker` string. Recorded once when crossed, including a large frame step. No target required. |

Property tracks restore the field value captured before play on completion/cancellation.
Claims on the same entity/component/field cannot overlap across active instances; within a
sequence sequential tracks are allowed, overlapping tracks are rejected, including resolved animation channels and aliased bindings. External writers
must not write claimed fields until release. Animation and particle tracks require owned
targets so they cannot silently replace a host's player/emitter. A missing/deleted target
fails the whole instance and cleans up everything still owned.

### Runtime and lifetime

```ts
const prepared = await prepareEffect(world, documentOrAssetRef)
const instance = playEffect(world, prepared, {
  bindings: { caster, camera }, parameters: { power: 1.5 }, seed: 42,
})
prepared.release() // instance keeps its lease
cancelEffect(world, instance.id)
```

Property endpoints are local to the target; hosts using floating origins should bind targets in a stable local parent frame.

The optional `effects` plugin registers the system and protocol methods. Feature-specific
plugins are explicitly required by tracks, with structured errors when absent. The scheduler
advances in Update using simulation delta. No wall clock is consulted. Time zero executes
on play; crossing a whole track in a long frame executes its start/end once. Property tracks
sample at the resulting local time; transient audio/particles wholly missed by a frame are
skipped (and traced), avoiding a late burst. Markers still fire. Pause freezes sequence time
and pauses its continuous presentation; resume continues. Paused-only sequences release their frame demand. Cancellation is idempotent.

Completed instances leave the active list; a fixed-capacity trace retains starts, track
boundaries, markers, skips, failures and terminal reasons. Active capacity and preparation
capacity are bounded. App disposal cancels instances and releases preparations. Optional
owner entity binding cancels when that entity dies. Owned prefab trees are removed together.

Steady sampling uses cached schemas, numeric columns and preallocated state. Entity archetype
moves/table growth rebind columns. Spawn/despawn/audio admission and explicit commands are
lifecycle work and may allocate; the stable scheduler/property loop must not allocate.
No new renderer nodes or per-frame work when the plugin is absent.

### Agent surface

`effects.prepare`, `effects.release`, `effects.play`, `effects.cancel`, `effects.pause` and
`effects.inspect` are App methods and MCP tools. Inspection includes preparation IDs,
active instance time/state/seed, target IDs and a cursor-based bounded trace with truncation.
Errors use `effects/*` codes and document paths. Generated project schemas and authoring
instructions explain bindings, ownership and authoritative gameplay separation.

Preview is play/cancel/replay in an isolated host world, not a second evaluator. Arbitrary
backward scrubbing is deferred because audio and particles carry simulation state.

## Decisions

- **Composition over another renderer/mixer.** Existing feature runtimes own their work.
- **Restore borrowed fields; delete owned targets.** Predictable cleanup is more useful than
  implicitly leaving a cinematic pose behind. Hosts commit gameplay changes separately.
- **Frame-aligned presentation.** Audio has its own clock; this scheduler makes no sample-level
  or cross-device bit-exact promise. Seeds reproduce choices, not GPU floating-point bits.
- **No engine persistence backend.** Files are a project adapter; database documents use the
  same validated values and catalog identities.
- References: [Unity Timeline track types](https://docs.unity.cn/Packages/com.unity.timeline%401.8/manual/trk-add.html)
  and [Unreal state restoration](https://dev.epicgames.com/documentation/unreal-engine/keeping-or-restoring-changes-made-by-sequencer?application_version=4.27).

## Acceptance criteria

- [ ] Schema/default/semantic validation rejects duplicate IDs, bad targets, invalid times,
  incompatible fields and overlapping claims; generated schema/import uses the same definition.
- [ ] GUID-only and direct documents prepare; failure, disposal during load, release-before-end
  and repeated release leave no retained leases or spawned entities.
- [ ] Headless tests cover time zero, boundaries, large steps, markers, parameter overrides,
  deterministic replay, pause/resume, cancellation, dead targets, archetype moves and conflicts.
- [ ] Animation, particles, audio and field tracks use existing runtimes; cleanup restores
  borrowed state and removes only owned trees, including failure during activation.
- [ ] Protocol/MCP/project integration works, with bounded trace and useful errors.
- [ ] Browser spell demonstrates launch, flight, impact, animation, particles, light and audio;
  WebGPU and WebGL2 evidence includes screenshots, actual runtime states and cleanup assertions.
- [ ] `effects/update` measures 200 active sequences × 4 property tracks; proposed 1 ms/frame
  on named laptop/desktop budgets. CI reports its actual machine separately and checks stable
  sampling allocations. Builds, package/size checks and normal correctness/typecheck/lint pass.

## Open questions

None for this slice. Visual authoring, advanced VFX and export remain follow-up specifications.
