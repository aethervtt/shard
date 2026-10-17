# Audio lab

Original synthetic test tones, released under this repository’s MIT license. No recordings or external sound libraries are required.

From this directory after the workspace install:

```sh
pnpm exec shard import
pnpm exec shard audio preview plans/showcase.json --out captures/showcase.wav --json
pnpm exec shard dev
```

Preview needs Playwright Chromium (`pnpm --filter @aethervtt/shard-cli exec playwright install chromium`).
It needs no GPU or audio output. Listen to the WAV and inspect its adjacent `.wav.json` evidence.
`shard dev` starts an automatic tour; click the page to unlock browser audio.

The assets demonstrate surface-selected footsteps, two RPM layers with smoothed gain/pitch,
a delayed two-layer spell, a room return, underwater/dialogue/pause snapshots, and four decoded
123-BPM stems transitioning between exploration and combat with a beat-aligned stinger.
The scene includes a box reverb zone. Its box is aligned to world axes.

The preview applies controls at a deterministic 60-Hz evaluation rate, rounded upward to the
128-sample browser render quantum; its trace records requested and actual control times.
Music starts and transitions use native sample timestamps. The preview moves both the listener
and engine emitter, pauses simulation events, and renders a finite one-second tail.

Live tools target one app/session:

```sh
pnpm exec shard audio describe --attach --json
pnpm exec shard audio call audio.parameter.set --attach --params '{"instance":1,"name":"rpm","value":0.8}' --json
pnpm exec shard audio call audio.music.inspect --attach --params '{}' --json
```

Without `--attach`, commands run against a temporary headless project and its mutations end when
the command exits. Headless gains are analytical; only offline/browser evidence measures samples.
