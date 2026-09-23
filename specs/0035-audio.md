# 0035 — Audio

- **Status:** accepted
- **Packages:** `@shard/audio` (new), `@shard/platform`, `@shard/platform-web`, `@shard/project`
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
- Settings: `mode: 'decoded' | 'stream'` (streamed clips play through a media element; for music),
  `normalize: bool`, `loopStart` and `loopEnd` in seconds.
- The `AudioClip` asset holds the bytes. The Web Audio backend decodes on first use and caches the
  `AudioBuffer`.

### Components

```ts
AudioSource {
  clip: handle('AudioClip'), bus: string = 'sfx'
  volume: f32 = 1 (linear), pitch: f32 = 1, loop: bool, autoplay: bool = true, playing: bool
  spatial: bool = true, minDistance: f32 = 1, maxDistance: f32 = 100,
  rolloff: 'inverse' | 'linear' | 'exponential', rolloffFactor: f32 = 1
  panning: 'hrtf' | 'equal-power', priority: u8 = 128, startTime: f32
}
AudioListener {}                                  // one active; the first found wins
AudioBuses (resource): { [name]: { volume, muted, parent = 'master' } }
```

- `playing` is the source's state: set it to start or stop, and the system clears it when a
  non-looping clip ends (`AudioFinished { entity }`).
- Spatial sources follow their `GlobalTransform` each frame. The listener follows its own.
- `duck(world, 'music', { by: 0.3, attack: 0.1, release: 0.5 })` lowers a bus while a voice on
  another bus plays, for dialogue over music.

### Backends

```ts
interface AudioBackend {
  play(voice: VoiceDesc): VoiceId
  update(voice: VoiceId, params): void            // position, gain, pitch
  stop(voice: VoiceId, fade?: number): void
  setListener(matrix): void
  setBus(name, gain): void
}
```

- **Web Audio** (`platform-web`, and Tauri through it): one `AudioContext`, a gain node per bus,
  a `PannerNode` per spatial voice. The context resumes on the first user gesture; until then
  voices are queued and `audio.describe` says the context is suspended.
- **Headless** (Node, tests, and CLI): voices are records with start frame, end frame (from clip
  duration and pitch), and the gain and pan the Web Audio graph would compute for them, so
  attenuation and panning are testable without a sound card.
- The platform provides the backend (`platform.audio`), and the engine never touches
  `AudioContext` directly.

### Voice management

- A global limit (default 64) and per-clip limit (default 8). Over the limit, the lowest priority
  and then the quietest voice is stolen.
- Sources past `maxDistance` with a `rolloff` that reaches zero are virtualized: they keep time but
  don't hold a voice, and resume in step when they come back in range.

### Agent surface

- `audio.describe`: context state, buses with gains, and every active or virtual voice with clip
  path, entity path, bus, gain after attenuation, pan, and elapsed time.
- `audio.log { since }`: voices started and stopped, by frame, which gameplay tests use
  (`expect(audioLog).toContainEqual({ clip: 'assets/sfx/laser.ogg', ... })`).
- `asset.get` on a clip shows duration, channels, sample rate, and codec.
- **Errors:** `audio/decode-failed`, `audio/unsupported-format`, `audio/unknown-bus`.

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

## Acceptance criteria

- [ ] WAV, Ogg, and MP3 fixtures import with correct duration, channels, and sample rate.
- [ ] An autoplaying spatial source 10 m to the listener's right records a gain matching the
      inverse distance model and a pan of +1 (equal-power), within 1%.
- [ ] A non-looping clip ends at its duration divided by pitch and sends `AudioFinished`.
- [ ] Muting the `sfx` bus zeroes the gain of every sfx voice and leaves music alone. Ducking
      lowers music while a voice plays and restores it after `release`.
- [ ] Starting 100 one-shots of one clip holds at most 8 voices, stealing by priority.
- [ ] In a browser (`#audio` playground demo), a source orbiting the camera pans audibly, and
      `audio.describe` matches the headless values for the same scene.
- [ ] A gameplay test asserts that firing plays `laser.ogg` at the ship's position.

## Open questions

- None blocking. Deferred: reverb zones and occlusion by physics raycasts.
