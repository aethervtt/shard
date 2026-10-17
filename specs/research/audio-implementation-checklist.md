# Audio implementation evidence

Working checklist for 0077–0079. An implementation or a passing logical test alone does not
establish signal behavior. Acceptance checkboxes in the specs remain unchecked until the final
evidence review.

## Recorded checkpoints

- Branch: `feat/audio-events-mixing-music`.
- First implementation checkpoint: `290f1de`.
- First remote evidence run: https://github.com/aethervtt/shard/actions/runs/39073776316
  - Passed repository typecheck/lint, audio/assets/save correctness and Chromium signal probes.
  - Passed build.
  - Failed strict 48-source allocation assertion (one collection); investigating and fixing.
  - Full bundle 3722.5 KiB exceeded prior 3643.8 KiB allowance; renderer-min remained within its
    budget. Review optional loading and measured feature cost before updating the full allowance.
  - Packaging smoke was not reached after the size failure.
- Local correctness: 48 audio tests before lifecycle additions; five additional lifecycle tests
  pass (revision replacement, global release/cooldown bounds, delayed cancellation/disposal,
  sustained checkpoint restoration, no-render-frame realtime pumping).
- Local Chromium probes passed: hierarchical gain, low-pass rejection, delay timing, simultaneous
  decoded starts, equal-power fade and shared-session cache ownership.
- Builds and strict benchmarks run in Actions, per the user's preference. Hosted-machine numbers
  must retain the actual CPU identity; they are not measurements of the named laptop/desktop.

## Remaining implementation and evidence review

- [ ] Complete every acceptance scenario in 0077, 0078 and 0079, linking each to test/artifact.
- [ ] Event assets: surface switch, RPM blending, layered spell; all selectors/concurrency/gates.
- [ ] Validation parity and semantic importer checks, invalid hot-reload transaction preservation.
- [ ] Global parameter sharing in music/mixing; per-event send automation.
- [ ] Preparation deduplication, asset pins, in-flight revision ordering and all capacity races.
- [ ] Admission before side effects; layer-ID RNG independence and stable GUID cache keys.
- [ ] Autoplay expiry/restart/wait, codec failures, explicit listener selection, host arbitration.
- [ ] Default/pitch-linked clocks at 0/0.5/2; pause and virtualization without cursor/reroll errors.
- [ ] Session listener panning, 100-session disposal churn, Blob URL and lazy-media ownership.
- [ ] Tauri optional scoped media URL resolver; existing hosts must not advertise broken URLs.
- [ ] Full save integration tests and missing-revision diagnostic/fallback behavior.
- [ ] Ten-minute churn and packed legacy telemetry; no steady-state allocations.
- [ ] Mixer snapshot value validation, domains, return controls, aggregate parent compressor.
- [ ] Graph replacement input crossfade, bounded tails, meter reconnect and overlapping node caps.
- [ ] Finite effect-tail cap; pre/post sends and unrelated category tail mute signal tests.
- [ ] Four-zone hysteresis/handoff and floating-origin tests; bounded obstruction queries.
- [ ] CLI/MCP preview and all command wrappers; authored events/music timeline preview.
- [ ] Runnable room/underwater/dialogue/pause and exploration/combat demos with assets.
- [ ] Music authored predicate rules, queued destination markers, public-operation reconciliation.
- [ ] Music cancellation after promotion/stingers, pause guards, transactional automation rollback.
- [ ] Stinger readiness deadlines, overlap replacement, no-repeat and release semantics.
- [ ] Actual browser 123-BPM loop-period, transition-envelope and long-grid evidence.
- [ ] Music source/memory reservations and lazy candidate-section retirement.
- [ ] Register 0075 budget keys and meaningful warmed event/mix/acoustic/music benchmarks.
- [ ] Generated docs and gameplay assertions; schema/provides/dependency tests.
- [ ] Complete repository tests and all required CI; inspect artifacts against the final commit.
- [ ] Open PR after implementation checklist completion; green required checks, then merge.
