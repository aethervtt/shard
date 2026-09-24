import type { ShardError } from '@shard/core'

/**
 * Everything the engine needs from its host. The engine only talks to this interface;
 * hosts (browser, Tauri, headless) provide an implementation at startup.
 */
export interface Platform {
  readonly name: string
  readonly fs: PlatformFileSystem
  readonly storage: KeyValueStorage
  readonly clock: Clock
  readonly log: Logger
  /** Where sound goes: Web Audio in a browser or webview. Absent when headless (the audio plugin records voices instead). */
  readonly audio?: AudioBackend
}

export type MouseButton = 'left' | 'middle' | 'right' | 'back' | 'forward'

/**
 * Raw input as the platform sees it. The input plugin drains these once per frame. `action` events
 * are synthetic (injected by tests or agents) and go through the same stream so they're recorded
 * and replayed like everything else.
 */
export type RawInputEvent =
  | { type: 'key'; code: string; pressed: boolean }
  | { type: 'mouse-button'; button: MouseButton; pressed: boolean }
  | { type: 'mouse-move'; x: number; y: number; dx: number; dy: number }
  | { type: 'wheel'; dx: number; dy: number }
  | { type: 'touch'; id: number; phase: 'start' | 'move' | 'end'; x: number; y: number }
  | { type: 'gamepad'; index: number; connected: boolean; buttons: number[]; axes: number[] }
  | { type: 'focus'; focused: boolean }
  | { type: 'action'; name: string; pressed: boolean; value?: number }

/** Where raw input comes from: DOM listeners in a browser or webview, nothing when headless. */
export interface InputSource {
  /** Appends events since the last drain (and polls devices like gamepads). */
  drain(out: RawInputEvent[]): void
  dispose(): void
}

export type FileChangeKind = 'create' | 'modify' | 'remove'

export interface FileChangeEvent {
  readonly kind: FileChangeKind
  readonly path: string
}

export interface PlatformFileSystem {
  /** False on hosts that can only read (for example a static web build). */
  readonly writable: boolean
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  writeText(path: string, data: string): Promise<void>
  writeBytes(path: string, data: Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
  /** Present only on hosts that can watch files. Returns an unsubscribe function. */
  watch?(path: string, onChange: (event: FileChangeEvent) => void): Promise<() => void>
  /** Entries directly inside a directory; empty if it doesn't exist. Absent on hosts that can't list. */
  list?(dir: string): Promise<DirEntry[]>
  /** Size and modification time, or undefined if the file doesn't exist. */
  stat?(path: string): Promise<FileStat | undefined>
  /** Moves a file, creating the target's directory. Writable hosts only. */
  move?(from: string, to: string): Promise<void>
  /** Deletes a file if it exists. Writable hosts only. */
  remove?(path: string): Promise<void>
}

export interface DirEntry {
  /** Name within the directory (not a path). */
  readonly name: string
  readonly kind: 'file' | 'dir'
}

export interface FileStat {
  readonly size: number
  /** Modification time in milliseconds. */
  readonly mtime: number
}

export interface KeyValueStorage {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface Clock {
  /** Monotonic time in milliseconds. */
  now(): number
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void
}

// --- audio -------------------------------------------------------------------------------------

/** Encoded sound the backend decodes (or streams) itself. An imported `AudioClip` is one. */
export interface AudioClipSource {
  /** Asset guid, for logs. */
  readonly id: string
  /** The file as imported (WAV, Ogg, MP3, FLAC). A new array means new contents. */
  readonly bytes: Uint8Array
  /** `wav`, `vorbis`, `opus`, `mp3`, or `flac`. */
  readonly codec: string
  /** Seconds. */
  readonly duration: number
  /** Play through a media element instead of decoding it all up front (music). */
  readonly stream: boolean
  /** Scale decoded samples so the peak is 1. */
  readonly normalize: boolean
  /** Loop region in seconds; `loopEnd` 0 means the end of the clip. */
  readonly loopStart: number
  readonly loopEnd: number
}

export type AudioPanningModel = 'hrtf' | 'equal-power'
export type AudioDistanceModel = 'inverse' | 'linear' | 'exponential'

/** How a spatial voice pans and fades with distance: the parameters of a Web Audio PannerNode. */
export interface AudioSpatialDesc {
  readonly panning: AudioPanningModel
  readonly distanceModel: AudioDistanceModel
  readonly refDistance: number
  readonly maxDistance: number
  readonly rolloffFactor: number
}

/** What changes while a voice plays. */
export interface AudioVoiceParams {
  /** Linear gain before the bus and distance: volume × occlusion. */
  gain: number
  /** Playback rate (pitch × Doppler). */
  pitch: number
  /** World position of a spatial voice (ignored for non-spatial ones). */
  x: number
  y: number
  z: number
}

export interface AudioVoiceDesc extends AudioVoiceParams {
  readonly clip: AudioClipSource
  /** Bus name; the backend mixes it at the gain last given to `setBus`. */
  readonly bus: string
  readonly loop: boolean
  /** Where playback starts, in seconds of clip time. */
  readonly offset: number
  /** Null for non-spatial voices (UI, music). */
  readonly spatial: AudioSpatialDesc | null
}

export type AudioContextState = 'running' | 'suspended' | 'closed' | 'headless'

/**
 * Plays voices the audio plugin decides on. The plugin owns timing, voice limits, and virtual
 * voices; a backend only makes the sound (or, headless, records it).
 */
export interface AudioBackend {
  /** `web`, `headless`, ... */
  readonly kind: string
  /** Browsers keep the context suspended until a user gesture; voices wait until then. */
  readonly state: AudioContextState
  /** Returns an id for `update` and `stop`. */
  play(voice: AudioVoiceDesc): number
  update(voice: number, params: AudioVoiceParams): void
  /** Stops a voice, fading out over `fade` seconds (default: at once). */
  stop(voice: number, fade?: number): void
  /** The listener's world matrix (affine 3x4, row by row, as in core/GlobalTransform). */
  setListener(matrix: ArrayLike<number>): void
  /** A bus's final gain: its volume, mute, ducking, and parents multiplied. */
  setBus(name: string, gain: number): void
  /** Called with decode failures and other problems the plugin should log. */
  onError?: (error: ShardError) => void
  dispose?(): void
}
