# Dice authored-audio evidence — 2026-10-18

Implementation: [PR #32](https://github.com/aethervtt/shard/pull/32), spec
[0084](../0084-dice-authored-audio.md). Runtime revision tested below:
`5c63993debd3b0ca633651666865bb565c4088ac` (Actions merge revision
`b676415d9f43b82139b1ae1a8df5b8d804245e20`). Later documentation/checklist commits do not
change this runtime. Usage and host integration are in [dice/AUDIO.md](../../packages/dice/AUDIO.md).

## Correctness and ownership

[Dice integration/performance job](https://github.com/aethervtt/shard/actions/runs/39158968054/job/117768131685):
44 tests passed across the dice audio, asset loading, actual table rendering and entrance suites.
This includes the existing procedural sounds and presentation allocation checks, plus:

- Schema round trips and null defaults for old skins/recipes.
- GUID catalog assets, preparation deduplication, parameter values, layer conditions,
  explicit seeds, per-roll gain and flat playback.
- Independent dice volume/mute and authored child-bus routing.
- Rejection of spatial/sustained events, incompatible inputs, and invalid mixer categories.
- Silent/no-audio hosts; lazy document loading; thumbnails load visual marks without audio.
- Cancellation while loading, replacement, dismissal, late lease release, partial load failure,
  saturated instances and unrelated ownership, and mid-roll document changes.
- Physics contact and result events; entrance cues play once; recipe cues win over skin cues.

The shared audio suites verify gain across multiple layers, exact zero gain, invalid gain
rejection, and gain preservation across checkpoint restore. The playground demo-document test
verifies serialized GUID bindings, all three strength layers and the high-roll accent.

## Real browser output

[Browser audio job](https://github.com/aethervtt/shard/actions/runs/39158968054/job/117768131716)
uses Chromium Web Audio with an `OfflineAudioContext`, the actual dice session bridge, and
host catalog assets. These are measured PCM samples, not just playback commands. A constant
0.25-amplitude PCM16 source is sampled after output gains have settled:

| Case | Measured sample | Remaining decode pins |
|---|---:|---:|
| Full dice gain | 0.250007570 | 0 |
| Quarter dice gain | 0.062501892 | 0 |
| Dice muted | 0 | 0 |
| Dice muted with unrelated SFX | 0.250007570 | 0 |

PCM16 quantization accounts for the small difference from exactly 0.25. The test also runs
the existing audio signal/lifecycle probes and audio preview/project validation.

## Hosted performance and packaging

The dice job measured **0.449175 ms median for four prepared event starts** on an AMD EPYC
7763 runner with Mesa llvmpipe. This includes parameter binding, event revision checks and
instance ownership maintenance. Decoding and physics preparation are outside the measured
command boundary. The benchmark runs 1,000 four-impact bursts and verifies completion/cleanup.

The [shared audio performance job](https://github.com/aethervtt/shard/actions/runs/39158968054/job/117768131434)
also passed: 128 four-layer event updates measured 0.191306 ms median, and the 48-source mixer
update measured 0.017483 ms. The report has no measured budget overruns.

These are hosted-machine observations. The runner does not match a named laptop/desktop
profile, so exact named-machine budgets are not enforced there. `dice/audio-onsets` retains
its proposed 1 ms target; no local build or benchmark was run for this change.

The same workflow's build/package job passed `pnpm build`, `pnpm size --check`, and
`pnpm release --check`, including installation and consumption of the packed packages.

## Reproduction and artifacts

The [audio evidence workflow](https://github.com/aethervtt/shard/actions/runs/39158968054)
publishes `audio-signals-*`, `dice-audio-performance-*`, `audio-performance-*` and
`audio-package-*`. Local copies are under `.shard/evidence/dice-audio/final/`, alongside the
final PR check record and artifact checksums. The signal JSON contains the `dice` measurements;
performance JSON records the detected hardware and whether budgets were enforced.

CI runs full typechecking/lint and the repository's Linux/Windows suites, browser backends,
audio editor browsers/native webview, and effect-sequence regression checks before merge.
The PR's final check list is the authority for the merged revision.
