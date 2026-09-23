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
