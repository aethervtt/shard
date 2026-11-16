import type { KeyValueStorage } from '@aethervtt/shard-platform'

/** Where records live in platform storage, and the ledger's own key (outside that prefix). */
export const STORED_PREFIX = 'procgen/'
export const LEDGER_KEY = 'procgen-index'
/** The index is written this long after the change that dirtied it: one write per burst. */
const FLUSH_MS = 2000

interface LedgerFile {
  version: 1
  /** Key and stored bytes, least recently used first. */
  records: [string, number][]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The records in a `KeyValueStorage` (0125): their stored sizes, least recently used first, kept in
 * the storage itself so the cap holds across page loads. Every change waits for the load, so
 * ordering is kept; the index is written in batches and reconciled with the store on load.
 */
export class StoredLedger {
  readonly storage: KeyValueStorage
  private readonly limit: () => number
  /** Record key (without the prefix) → stored bytes, least recently used first. */
  private readonly records = new Map<string, number>()
  private total = 0
  private loaded: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(storage: KeyValueStorage, limit: () => number) {
    this.storage = storage
    this.limit = limit
  }

  /** Records and stored bytes counted (after the load, once something used the ledger). */
  stats(): { records: number; bytes: number } {
    return { records: this.records.size, bytes: this.total }
  }

  /** Loads and reconciles the index with what the storage holds; once. */
  ready(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  /** A read found the record: it moves last. */
  async touch(key: string): Promise<void> {
    await this.ready()
    const bytes = this.records.get(key)
    if (bytes === undefined) return
    this.records.delete(key)
    this.records.set(key, bytes)
    this.dirty()
  }

  /** A read found nothing: drop it if counted. */
  async forget(key: string): Promise<void> {
    await this.ready()
    const bytes = this.records.get(key)
    if (bytes === undefined) return
    this.records.delete(key)
    this.total -= bytes
    this.dirty()
  }

  /** A record was written: counted last, then the oldest go while over the limit. */
  async add(key: string, bytes: number): Promise<void> {
    await this.ready()
    this.set(key, bytes)
    const victims: string[] = []
    for (const [k, b] of this.records) {
      if (this.total <= this.limit() || k === key) break
      this.records.delete(k)
      this.total -= b
      victims.push(k)
    }
    this.dirty()
    for (const k of victims) await this.storage.delete(STORED_PREFIX + k)
  }

  /** Writes the index now. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.loaded) return
    await this.loaded
    const file: LedgerFile = { version: 1, records: [...this.records] }
    await this.storage.write(LEDGER_KEY, encoder.encode(JSON.stringify(file)))
  }

  private set(key: string, bytes: number): void {
    const old = this.records.get(key)
    if (old !== undefined) {
      this.records.delete(key)
      this.total -= old
    }
    this.records.set(key, bytes)
    this.total += bytes
  }

  private dirty(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => {})
    }, FLUSH_MS)
    // Never keeps a Node process alive.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private async load(): Promise<void> {
    let indexed: [string, number][] = []
    try {
      const raw = await this.storage.read(LEDGER_KEY)
      const file = raw && (JSON.parse(decoder.decode(raw)) as LedgerFile)
      if (file && file.version === 1 && Array.isArray(file.records)) indexed = file.records
    } catch {
      // A damaged index is rebuilt from the store below.
    }
    const present = new Set(
      (await this.storage.list(STORED_PREFIX)).map((k) => k.slice(STORED_PREFIX.length)),
    )
    const counted = new Set<string>()
    for (const [key, bytes] of indexed) {
      if (present.has(key) && typeof bytes === 'number') counted.add(key)
    }
    // Records the index doesn't list (written after its last flush, or before ledgers) count as
    // the least recently used: they're read once for their size.
    let changed = counted.size !== indexed.length
    for (const key of present) {
      if (counted.has(key)) continue
      const bytes = await this.storage.read(STORED_PREFIX + key).catch(() => undefined)
      if (bytes) this.set(key, bytes.byteLength)
      changed = true
    }
    for (const [key, bytes] of indexed) if (counted.has(key)) this.set(key, bytes)
    if (changed) this.dirty()
  }
}
