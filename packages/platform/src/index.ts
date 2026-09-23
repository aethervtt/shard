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
