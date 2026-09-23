import { defineResource, ShardError } from '@shard/core'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  /** Monotonic sequence number, for subscribers that resume. */
  seq: number
  level: LogLevel
  message: string
  /** App time in seconds when logged. */
  time: number
  code?: string
  path?: string
  hint?: string
  data?: unknown
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Structured log, kept as a ring buffer. Errors from systems, the GPU, and shaders land here, so
 * tools (and agents) can read what happened without scraping a console.
 */
export class Log {
  readonly capacity: number
  private readonly entries: LogEntry[] = []
  private readonly listeners = new Set<(entry: LogEntry) => void>()
  private seq = 0
  /** App time source; set by the app. */
  now: () => number = () => 0

  constructor(capacity = 500) {
    this.capacity = capacity
  }

  log(
    level: LogLevel,
    message: string,
    extra: Partial<Omit<LogEntry, 'seq' | 'level' | 'message' | 'time'>> = {},
  ): LogEntry {
    const entry: LogEntry = { seq: this.seq++, level, message, time: this.now(), ...extra }
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.shift()
    for (const listener of this.listeners) listener(entry)
    return entry
  }

  debug(message: string, data?: unknown) {
    return this.log('debug', message, data === undefined ? {} : { data })
  }
  info(message: string, data?: unknown) {
    return this.log('info', message, data === undefined ? {} : { data })
  }
  warn(message: string, data?: unknown) {
    return this.log('warn', message, data === undefined ? {} : { data })
  }

  /** Logs any thrown value; ShardErrors keep their code, path, and hint. */
  error(error: unknown): LogEntry {
    if (error instanceof ShardError) {
      return this.log('error', error.message, {
        code: error.code,
        path: error.path,
        hint: error.hint,
      })
    }
    return this.log('error', error instanceof Error ? error.message : String(error))
  }

  /** The last `count` entries at or above `level`, oldest first. */
  tail(count = 50, level: LogLevel = 'debug'): LogEntry[] {
    const min = LEVELS[level]
    return this.entries.filter((e) => LEVELS[e.level] >= min).slice(-count)
  }

  errors(count = 20): LogEntry[] {
    return this.tail(count, 'error')
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const LogResource = defineResource<Log>('core/Log', {
  description: 'Structured log ring buffer: system, GPU, and shader errors land here.',
})
