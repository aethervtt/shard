import type { ShardError } from '@aethervtt/shard-core'
import type { Workers } from './workers'

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
  /**
   * Background threads: web workers in a browser or webview, `worker_threads` in Node. Made on
   * first use. Absent on hosts without threads; `workersOf` falls back to running jobs inline.
   */
  readonly workers?: Workers
  /** The host's own performance instruments (long tasks, downloads), for 0062's metrics. */
  readonly performance?: HostPerformance
}

/**
 * What the host itself can measure about a page or process (0062). Browsers report long tasks and
 * resource timing; Node and Tauri report what they can, and leave out what they can't.
 */
export interface HostPerformance {
  /** The user agent, or the runtime's name and version. */
  readonly userAgent: string
  /**
   * Main-thread tasks of 50 ms or more, as the host reports them: start (on the `clock`'s timeline)
   * and duration, in ms. Returns an unsubscribe function. Absent where the host can't see them.
   */
  onLongTask?(listener: (startMs: number, durationMs: number) => void): () => void
  /** Bytes fetched so far (scripts, WASM, assets), over the wire and decoded. Absent without resource timing. */
  downloads?(): HostDownloads
}

export interface HostDownloads {
  /** Bytes over the wire, headers included. Cached responses add nothing. */
  transferred: number
  /** Bytes after decoding (decompression). */
  decoded: number
}

export * from './workers'

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
  /**
   * Wheel movement in pixels (line and page deltas already converted). `x`/`y` (CSS pixels, from
   * the element's top left) and `modifiers` come from sources that know them; a ctrl wheel is a
   * trackpad pinch.
   */
  | { type: 'wheel'; dx: number; dy: number; x?: number; y?: number; modifiers?: number }
  /**
   * One pointer (0060): mouse, pen or touch, in CSS pixels from the element's top left. Gestures
   * read these; `mouse-*` and `touch` events still feed the device resources and action maps.
   */
  | {
      type: 'pointer'
      id: number
      phase: PointerPhase
      pointer: PointerKind
      /** The button that went down (`down`/`up`), or the one held since (`move`). */
      button: MouseButton
      x: number
      y: number
      /** `MODIFIERS` bits held: shift, ctrl, alt, meta. */
      modifiers: number
    }
  | { type: 'touch'; id: number; phase: 'start' | 'move' | 'end'; x: number; y: number }
  | { type: 'gamepad'; index: number; connected: boolean; buttons: number[]; axes: number[] }
  | { type: 'focus'; focused: boolean }
  | { type: 'action'; name: string; pressed: boolean; value?: number }
  /** Typed characters, key repeats included; "\b" is a backspace. Text fields read these. */
  | { type: 'text'; text: string }

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel'
export type PointerKind = 'mouse' | 'pen' | 'touch'

/** Bits of a pointer or wheel event's `modifiers`. */
export const MODIFIERS = { shift: 1, ctrl: 2, alt: 4, meta: 8 } as const

/**
 * What the scene takes from the pointer while a control is enabled (0060). A source stops the
 * host's default handling (`preventDefault`) only for what's listed here and for claimed pointers;
 * everything else passes through to the page.
 */
export interface PointerPolicy {
  /** Mouse buttons enabled controls drag with: presses with them, and the context menu for 'right'. */
  buttons: readonly MouseButton[]
  /** Wheel events zoom a control. */
  wheel: boolean
  /** Touches drive a control: the element gets `touch-action: none`. */
  touch: boolean
}

/** Where raw input comes from: DOM listeners in a browser or webview, nothing when headless. */
export interface InputSource {
  /** Appends events since the last drain (and polls devices like gamepads). */
  drain(out: RawInputEvent[]): void
  /**
   * Calls `listener` whenever an event arrives, so an on-demand app wakes to drain it (0052).
   * Returns an unsubscribe function. Polled devices (gamepads) don't call it.
   */
  onInput?(listener: () => void): () => void
  /**
   * A consumer took this pointer's gesture (0060): its later events are the scene's
   * (`preventDefault`), and it keeps reporting outside the element (pointer capture) until it ends.
   */
  claimPointer?(id: number): void
  /** What enabled controls take; see `PointerPolicy`. Called when it changes. */
  setPointerPolicy?(policy: PointerPolicy): void
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

/**
 * The player's own data: saved games and settings, kept per user rather than in the project.
 * Keys are paths (`saves/slot1.json`, `settings.json`). Node and Tauri write files under a user
 * data folder, browsers use IndexedDB, and headless tests use `createMemoryStorage`.
 */
export interface KeyValueStorage {
  /** The stored bytes, or undefined if nothing is stored under the key. */
  read(key: string): Promise<Uint8Array | undefined>
  write(key: string, data: Uint8Array): Promise<void>
  /** Keys that start with `prefix`, sorted. */
  list(prefix: string): Promise<string[]>
  /** Removes the key if it exists. */
  delete(key: string): Promise<void>
}

/** Storage that lives as long as the process: headless runs and tests. Writes are copied. */
export function createMemoryStorage(): KeyValueStorage {
  const data = new Map<string, Uint8Array>()
  return {
    read: async (key) => {
      const bytes = data.get(key)
      return bytes?.slice()
    },
    write: async (key, bytes) => void data.set(key, bytes.slice()),
    list: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
    delete: async (key) => void data.delete(key),
  }
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
  /**
   * Gets a clip ready to play (a browser decodes it), so its first play starts on time instead of
   * starting late into the clip. Optional: backends with nothing to prepare leave it out.
   */
  preload?(clip: AudioClipSource): void
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
