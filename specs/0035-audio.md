# 0035 — Audio

- **Status:** implemented
- **Packages:** `@aethervtt/shard-audio` (new), `@aethervtt/shard-platform`, `@aethervtt/shard-platform-web`, `@aethervtt/shard-project`
- **Depends on:** 0003, 0004, 0014

## Context

Engines hum, lasers zap, footsteps crunch, and music changes when you land. Audio is half of what
makes the proof project feel like a place. It needs sound assets, sources placed in the world,
a listener on the camera, mixing buses the player can turn down, and spatial panning and
attenuation.

Web Audio covers all of it in browsers and in the Tauri webview. It doesn't exist in Node, where
tests and the agent loop run. Headless audio has to be a real backend anyway: an agent can't hear,
so "did the laser play, where, and how loud" has to be something it can query.

## Goals

- Audio clips as assets: WAV, Ogg Vorbis, MP3, FLAC, and Opus, with import settings (streaming vs
  decoded, normalization).
- `AudioSource` components: clip, volume, pitch, loop, autoplay, bus, and spatial settings.
  `AudioListener` on the camera.
- One-shots from code without an entity: `playSound(world, clip, { position, bus, volume })`.
- Buses as data (master, music, sfx, ui, voice by default), with volume, mute, and ducking.
- Spatial audio: HRTF or equal-power panning, distance models, Doppler off by default, occlusion
  hook for physics raycasts later.
- A headless backend that mixes nothing but records every voice (clip, position, gain, start and
  stop frames), so tests and agents can assert on sound.
- Voice limits with priorities, so a thousand bullets don't make a thousand voices.

## Non-goals

- Effects chains, reverb zones, and procedural audio (VISION "Later").
- Offline rendering to a file, and audio in `render.capture`.
- Music sequencing or adaptive music systems beyond crossfading two sources.

## Design

### Assets

- The `audio` importer keeps compressed sources as-is (browsers decode them), and records
  duration, channels, and sample rate by parsing headers. It warns on formats a target can't
  decode (Opus on older Safari).
- Settings: `mode: 'decoded' | 'stream'` (streamed clips play through a media element; for music,
  and the default for new files under a `music/` or `ambience/` folder), `normalize: bool`,
  `loopStart` and `loopEnd` in seconds. Streamed clips loop the whole file.
- Durations: WAV from the data chunk, Ogg from the last page's granule position (Opus minus
  pre-skip, at 48 kHz), FLAC from STREAMINFO, MP3 from a Xing/Info or VBRI frame count (minus LAME's
  encoder delay and padding) or, without one, by counting frames.
- The `AudioClip` asset holds the bytes. The Web Audio backend decodes on first use and caches the
  `AudioBuffer`. `normalize` scales by the decoded peak there; the importer records the peak of PCM
  WAVs (`asset.get`).

### Components

```ts
AudioSource {
  clip: handle('AudioClip'), bus: string = 'sfx'
  volume: f32 = 1 (linear), pitch: f32 = 1, loop: bool, autoplay: bool = true, playing: bool
  pitchRandom: vec2 = [1, 1], volumeRandom: vec2 = [1, 1]   // factors picked in [min, max] per start
  spatial: bool = true, minDistance: f32 = 1, maxDistance: f32 = 100,
  rolloff: 'inverse' | 'linear' | 'exponential', rolloffFactor: f32 = 1
  panning: 'hrtf' | 'equal-power', doppler: f32 = 0, priority: u8 = 128, startTime: f32
}
AudioListener {}                                  // one active; the first found wins
AudioBuses (resource): { [name]: { volume, muted, parent = 'master', duck? } }
AudioConfig (resource): { maxVoices = 64, maxVoicesPerClip = 8, speedOfSound = 343, occlusion }
```

- `playing` is the source's state: set it to start or stop, and the system clears it when a
  non-looping clip ends (`AudioFinished { entity }`).
- Spatial sources follow their `GlobalTransform` each frame. The listener follows its own; without
  an `AudioListener` it sits at the origin facing -Z.
- `playSound(world, clip, options)` returns a voice id (`stopSound`, `isSoundPlaying`); `clip` is a
  ref, a path, or an `AudioClip` made in code. A clip still loading starts when it arrives.
- **Variation** (as Godot's random pitch): a sound played over and over (footsteps, impacts,
  shots) shouldn't sound identical. `playSound`'s `pitch` and `volume` take a `[min, max]` range
  instead of a number, and each play picks one: pitch evenly in log space (so `[0.8, 1.25]` is as
  likely below 1 as above), volume evenly. A source's `pitchRandom` and `volumeRandom` are factor
  ranges on its `pitch` and `volume`, picked each time it starts and kept while it plays. The picks
  come from the app's `GlobalRng` stream `audio`, so a replay (and a loaded save) picks the same.
  A range that isn't one (min above max, pitch at or below 0, volume below 0) throws
  `audio/invalid-range`.
- `preloadSound(world, clip)` gets a clip ready before its first play (a browser decodes it), so
  a sound that must land on its moment isn't started late into the clip. Backends that decode
  implement `preload`; the headless one records the clip ids (`preloaded`).
- `duck(world, 'music', { by: 0.7, attack: 0.1, release: 0.5, when: 'voice' })` lowers a bus while
  any voice plays on the `when` buses (default `voice`), for dialogue over music. `by` is the share
  of gain taken away (0.7 plays music at 30%). The rule is stored on the bus in `AudioBuses`, so
  scene files can set it too. `setBus(world, name, { volume, muted })` throws on unknown buses.
- `doppler` shifts pitch from last frame's relative motion (OpenAL's formula; Web Audio dropped its
  own). 0, the default, is off.
- `AudioConfig.occlusion` is the hook for physics raycasts: a gain multiplier per spatial voice per
  frame. Nothing sets it yet.

### Backends

```ts
interface AudioBackend {                          // in @aethervtt/shard-platform
  readonly kind: string
  readonly state: 'running' | 'suspended' | 'closed' | 'headless'
  play(voice: AudioVoiceDesc): number             // clip, bus, loop, offset, spatial (PannerNode params)
  preload?(clip: AudioClipSource): void           // decode ahead of the first play (optional)
  update(voice: number, params: AudioVoiceParams): void   // gain, pitch, x, y, z
  stop(voice: number, fade?: number): void
  setListener(matrix: ArrayLike<number>): void    // affine 3x4, as GlobalTransform
  setBus(name: string, gain: number): void        // final gain: volume, mute, duck, parents
  onError?: (error: ShardError) => void
}
```

- The plugin owns timing, voice limits, and virtual voices; a backend only makes the sound. It
  passes a voice's gain before distance (volume × occlusion) and the PannerNode parameters, so the
  panner attenuates and pans; the plugin computes the same values with Web Audio's formulas for
  `audio.describe`, virtualization, and stealing.

- **Web Audio** (`platform-web`, and Tauri through it): one `AudioContext` (made on first use of
  `platform.audio`), a gain node per bus, a `PannerNode` per spatial voice. The context resumes on
  the first user gesture; until then voices are queued and start in step (by wall clock) when it
  runs, and `audio.describe` says the context is suspended.
- **Headless** (Node, tests, and CLI; the plugin's default): voices are records, and
  `measure(voice)` gives the gain and pan the Web Audio graph would compute for them, so attenuation
  and panning are testable without a sound card. Start and end frames (clip duration over pitch,
  advanced by the plugin each frame) are in `audio.log`.
- Pan is Web Audio's equal-power azimuth: the source's angle in the listener's horizontal plane,
  folded front to back, ±90° → ±1.
- The platform provides the backend (`platform.audio`), and the engine never touches
  `AudioContext` directly.

### Voice management

- A global limit (default 64) and per-clip limit (default 8). Over the limit, the lowest priority
  (higher numbers win), then the quietest, then the oldest voice loses. A one-shot that loses is
  stopped (`stolen`), or `dropped` if it was starting that frame; an `AudioSource` goes virtual
  instead and gets a voice back when one frees up.
- Sources whose distance gain is zero (past `maxDistance` with `linear` rolloff) are virtualized:
  they keep time but don't hold a voice, and resume in step when they come back in range.

### Agent surface

- `audio.describe`: context state, buses with gains, and every active or virtual voice with clip
  path, entity path, bus, gain after attenuation, pan, and elapsed time.
- `audio.log { since }`: voices started and stopped, by frame, which gameplay tests use
  (`expect(audioLog).toContainEqual({ clip: 'assets/sfx/laser.ogg', ... })`).
- `asset.get` on a clip shows duration, channels, sample rate, and codec.
- `audio.log` entries: `{ frame, event: start | stop | dropped, voice, clip, entity, path, bus,
  position, gain, pan, reason: ended | stopped | stolen | removed | voice-limit }`. Gameplay tests
  read it with `game.audioLog()`. MCP: `audio_describe`, `audio_log`.
- **Errors:** `audio/decode-failed`, `audio/unsupported-format`, `audio/unknown-bus` (a source on
  an unknown bus is logged once and mixed on master; `playSound` throws), `audio/invalid-duck`,
  `audio/invalid-range`, `audio/no-plugin`.

## Decisions

- **Web Audio in the browser, records in Node.** A mixing backend in Node would produce samples
  nobody can hear. Records of what plays, with computed gain and pan, are what agents and tests
  can use.
- **Keep compressed sources.** Browsers decode every format we accept, and shipping WAVs would
  multiply export size.
- **The platform owns the context.** `AudioContext` is a host API like the canvas, and hosts
  decide when it can start (user gesture policies).
- **Buses are strings in data.** Games add buses in a resource without code, and settings
  (0038) persist their volumes by name.
- **The plugin computes gain and pan, the panner applies them.** Voice limits and virtualization
  need the numbers every frame on every backend, and the PannerNode still does HRTF.
- **Virtual sources, stolen one-shots.** A looping source that loses its voice should come back in
  step; a bullet that loses its voice is gone.

## Acceptance criteria

- [x] WAV, Ogg, and MP3 fixtures import with correct duration, channels, and sample rate.
- [x] An autoplaying spatial source 10 m to the listener's right records a gain matching the
      inverse distance model and a pan of +1 (equal-power), within 1%.
- [x] A non-looping clip ends at its duration divided by pitch and sends `AudioFinished`.
- [x] Muting the `sfx` bus zeroes the gain of every sfx voice and leaves music alone. Ducking
      lowers music while a voice plays and restores it after `release`.
- [x] Starting 100 one-shots of one clip holds at most 8 voices, stealing by priority.
- [x] In a browser (`#audio` playground demo), a source orbiting the camera pans audibly, and
      `audio.describe` matches the headless values for the same scene.
- [x] A gameplay test asserts that firing plays `laser.ogg` at the ship's position.
- [x] One-shots with pitch and volume ranges pick within them, pitch evenly in log space, the same
      under the same seed; a source picks new factors each start and keeps them while it plays;
      a range that isn't one throws `audio/invalid-range`. `preloadSound` reaches the backend.

## Open questions

- None blocking. Deferred: reverb zones and occlusion by physics raycasts.
