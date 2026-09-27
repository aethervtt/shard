# Add sound

Add `"audio"` to `plugins` in `shard.json`. Drop `.ogg`, `.mp3`, `.wav`, or `.flac` files under
`assets/` and run `shard import`: each is an `AudioClip` (MCP `get_asset` shows duration, channels,
sample rate, codec). Files stay compressed. Clips under `music/` stream; set `"mode": "stream"` in
the `.meta` for other long files, and `loopStart`/`loopEnd` (seconds) for loop points.

```json
{ "name": "camera", "components": { "core/Transform": {}, "render/Camera3d": {},
    "audio/AudioListener": {} } },
{ "name": "reactor", "components": { "core/Transform": { "translation": [4, 0, -10] },
    "audio/AudioSource": { "clip": { "path": "assets/sfx/hum.ogg" }, "loop": true,
      "rolloff": "linear", "maxDistance": 30 } } },
{ "name": "music", "components": { "core/Transform": {},
    "audio/AudioSource": { "clip": { "path": "assets/music/theme.ogg" }, "bus": "music",
      "loop": true, "spatial": false, "volume": 0.6 } } }
```

- Sources autoplay; set `playing` to start or stop one. A clip that doesn't loop clears
  `playing` at its end and sends `audio/AudioFinished`. Spatial sources follow their transform;
  the listener is the first `audio/AudioListener` (put it on the camera).
- `rolloff`: `inverse` (default, natural), `linear` (silent at `maxDistance`; past it the source
  goes virtual and holds no voice), `exponential`. `panning`: `equal-power` or `hrtf`.
- One-shots from code: `playSound(world, weapon.sound, { position: muzzle, bus: 'sfx' })` from
  `@aethervtt/shard-audio` returns a voice id for `stopSound`. A handle field
  (`t.handle('AudioClip')`) on a data asset keeps sounds in data.
- Buses are data (`audio/Buses`: master, music, sfx, ui, voice). Add one in a scene's
  `"resources": { "audio/Buses": { "engines": { "volume": 0.7, "parent": "sfx" } } }`; change them
  with `setBus(world, 'sfx', { muted: true })`. `duck(world, 'music', { by: 0.7, release: 0.5 })`
  lowers music while a voice-bus line plays.
- Over 64 voices (8 per clip) the lowest `priority`, then the quietest, lose theirs.
- Check it: `audio_describe` lists every voice with gain and pan (-1 left, +1 right); gameplay tests
  read `await game.audioLog()`:

```ts
expect(await game.audioLog()).toContainEqual(
  expect.objectContaining({ event: 'start', clip: 'assets/sfx/laser.ogg', position: [0, 0, 0] }),
)
```

Browsers start audio after the first click or key press; until then `audio_describe` says
`"context": "suspended"` and voices wait. Headless runs record voices without sound.
