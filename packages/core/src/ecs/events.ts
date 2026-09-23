import type { EventDef } from '../schema/resource'

/**
 * Double-buffered event storage. Events sent during frame N are readable during frames N and
 * N+1, then dropped. Every event has a sequence number so readers can track what they've seen.
 */
export class EventQueue<T> {
  private older: T[] = []
  private newer: T[] = []
  private olderStart = 0
  private newerStart = 0
  private sent = 0
  readonly def: EventDef<T>

  constructor(def: EventDef<T>) {
    this.def = def
  }

  send(event: T): void {
    this.newer.push(event)
    this.sent++
  }

  /** Called once per frame by the app. Drops events older than one frame. */
  update(): void {
    const dropped = this.older
    this.older = this.newer
    this.olderStart = this.newerStart
    dropped.length = 0
    this.newer = dropped
    this.newerStart = this.sent
  }

  /** Events currently buffered (both frames). */
  get length(): number {
    return this.older.length + this.newer.length
  }

  /** @internal Copies events with sequence >= cursor into `out`. Returns the new cursor. */
  readFrom(cursor: number, out: T[]): number {
    const start = Math.max(cursor, this.olderStart)
    for (let i = start - this.olderStart; i < this.older.length; i++) out.push(this.older[i]!)
    const newerFrom = Math.max(cursor, this.newerStart)
    for (let i = newerFrom - this.newerStart; i < this.newer.length; i++) out.push(this.newer[i]!)
    return this.sent
  }

  /** @internal */
  get oldestSequence(): number {
    return this.olderStart
  }
}

/** Independent cursor over an event queue. Several readers can consume the same events. */
export class EventReader<T> {
  private cursor: number
  private readonly scratch: T[] = []
  private readonly queue: EventQueue<T>

  constructor(queue: EventQueue<T>) {
    this.queue = queue
    this.cursor = queue.oldestSequence
  }

  /** Events not yet seen by this reader. The array is reused: copy it to keep it. */
  read(): readonly T[] {
    this.scratch.length = 0
    this.cursor = this.queue.readFrom(this.cursor, this.scratch)
    return this.scratch
  }

  /** Marks everything as seen without returning it. */
  clear(): void {
    this.scratch.length = 0
    this.cursor = this.queue.readFrom(this.cursor, this.scratch)
    this.scratch.length = 0
  }
}
