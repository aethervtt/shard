# Authoring audio

Enable `audio/events` for layered events and parameters, `audio/mixer` for effects and snapshots,
`audio/acoustics` for zones/obstruction, and `audio/music` for adaptive music. Their dependencies
are enabled automatically. Base `audio` keeps AudioSource/playSound for simple clips.

Assets are ordinary JSON: `.audio-event.json`, `.audio-parameters.json`, `.audio-collection.json`,
`.audio-mixer.json`, `.audio-snapshot.json` and `.audio-music.json`. Use their generated schemas
under `.shard/schemas`. Import edits with `shard import`; references can use paths or stable GUIDs.
Authored gains use dB and pitches use semitones. Legacy volume/gain use linear multipliers.

Prepare a collection with `await prepareAudio(world, ref)`, play its events with `playAudioEvent`,
and release the returned lease when its scope ends. Active instances retain their own pins.
Use local `parameters` for surface labels, RPM or intensity; shared parameter assets connect
weather/environment values to events, music and mixer curves. Built-in distance/speed are readonly.
Sequence/no-repeat selectors retain bounded session history. Layers have independent RNG streams.

Simulation event decisions follow timeScale and pause. Their samples normally follow audio time;
`pitchLinked` opts into scaled playback. Realtime UI/ambience can continue without visual frames.
Transient blocked events expire after 250 ms by default. `wait` preserves their phase; `restart`
starts their timeline again after unlock. Choose an explicit AudioListener with setAudioListener;
the fallback is the lowest live listener entity ID. There is one audio session per app/protocol target.

Mixer domain buses (music/sfx/ui/voice) are direct children of master. Put submixes below them.
Each event layer can declare up to eight `sends` with `target`, `gainDb`, and an optional
parameter/points curve. Declare those routes in its mixer bus first. Per-instance sends tap after
spatialization and preserve the originating category's user gate. Event `tags` can drive ducking;
only physically rendering voices trigger it by default. Duck rules also include descendant buses.

Parent inserts process the summed children once. Pre/post sends feed named returns, and user
category mute gates that category's dry and wet output. Apply imported mixer edits with
`await configureAudioMixer(world, ref)`: scalar edits preserve effect history; topology/IR
changes crossfade within the overlap budget. Delay and convolution tails are finite;
decoded PCM and generated DSP kernels have separate bounded memory budgets. Snapshots compose
by priority and stable identity; they do not overwrite user volume settings.
Player controls apply to master and ordinary direct-child categories; nested/return controls reject.
Use `setAudioUserBus(world, 'music', { volume: 0.5, muted: false })` for player settings;
`setBus` remains the independent gameplay fader. Effect target fields
are `effectId/parameter` (for example `water/frequency`), and send fields are `send/returnBus`.
Zones use spheres or world-axis boxes and at most four smoothly handed-off returns. Obstruction
comes from an injected bounded query provider; headless tests can supply deterministic queries.
Optional `gainCurve` and `lowpassCurve` map transmission to dB and Hz.

Music programs use decoded stems, fixed tempo/meter, source sample markers and a 960-PPQ grid.
Rate conform is explicit and pitch changing, bounded by authored cents. Prepare then start a
program, request beat/bar/marker transitions, and set intensity parameters. Current, incoming and
crossfading sections own PCM; retired sections are released. Entire stem groups reserve voices.
Pause/seek cancel future sources, and resume creates fresh scheduled sources at the saved phase.
Cancelling an already audible destination pauses it and releases both sides of its crossfade.
Replacing a stinger reserves overlap capacity first; failure preserves the existing stinger.
Persist only intentional sustained events/music; save restoration diagnoses changed revisions.

Use `audio.describe` and `audio.log` (cursor plus truncation metadata), `audio.events.inspect`,
`audio.mix.inspect`, `audio.music.inspect`, and `audio.meters`. Headless gains are modeled; meters
must say unavailable there. Gameplay tests expose `game.audio.describe/events/music/mix/log`.
CLI: `shard audio call audio.parameter.set --attach --params '{"instance":1,"name":"rpm","value":0.8}'`.
Without --attach, the CLI uses a temporary headless target. MCP exposes matching audio_* tools.

`shard audio preview plans/showcase.json --out captures/mix.wav --json` runs Chromium's offline
renderer through the same event/music/mixer implementations. The preview schema accepts clips,
authored events/music, seed, controls, movement, duration, rate and tails. Controls evaluate at
60 Hz aligned upward to 128-sample render quanta; the trace includes requested/actual times.
Music timestamps are scheduled natively. Output includes WAV, decisions, peak/RMS/clipping,
backend and capabilities. Limits: 60 seconds including tails and 64 MiB each for input/PCM/output.
No audio device, microphone or GPU is needed. Install Playwright Chromium in the CLI package.
See `examples/audio-lab` for a complete authored showcase and original synthetic assets.
