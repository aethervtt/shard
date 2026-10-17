import { Rng, ShardError } from '@aethervtt/shard-core'

export interface CardEntry {
  instanceId: string
  definition: string
  faceDown?: boolean
}

/** Logical cards have no entity, texture or per-frame work until a host exposes them. */
export class CardCollection {
  readonly id: string
  private readonly entries: CardEntry[] = []
  private readonly ids = new Set<string>()
  version = 0
  constructor(id: string, entries: readonly CardEntry[] = []) {
    this.id = id
    for (const entry of entries) this.insert(entry)
  }
  get count(): number {
    return this.entries.length
  }
  at(index: number): Readonly<CardEntry> | undefined {
    return this.entries[index]
  }
  insert(entry: CardEntry, index = this.count): void {
    if (!entry.instanceId || this.ids.has(entry.instanceId)) {
      throw new ShardError('cards/duplicate-id', `Duplicate or empty card ID: ${entry.instanceId}`)
    }
    this.checkIndex(index, true)
    this.entries.splice(index, 0, { ...entry })
    this.ids.add(entry.instanceId)
    this.version++
  }
  remove(index: number): CardEntry {
    this.checkIndex(index)
    const entry = this.entries.splice(index, 1)[0]!
    this.ids.delete(entry.instanceId)
    this.version++
    return entry
  }
  move(from: number, to: number): void {
    this.checkIndex(from)
    this.checkIndex(to)
    const entry = this.entries.splice(from, 1)[0]!
    this.entries.splice(to, 0, entry)
    this.version++
  }
  draw(count: number, destination: CardCollection): void {
    if (destination === this || !Number.isInteger(count) || count < 0 || count > this.count) {
      throw new ShardError(
        'cards/invalid-transfer',
        'Draw needs a distinct destination and an available card count',
      )
    }
    for (let i = 0; i < count; i++) {
      if (destination.ids.has(this.entries[i]!.instanceId)) {
        throw new ShardError(
          'cards/duplicate-id',
          `Destination already contains ${this.entries[i]!.instanceId}`,
        )
      }
    }
    const moved = this.entries.splice(0, count)
    for (const entry of moved) {
      this.ids.delete(entry.instanceId)
      destination.ids.add(entry.instanceId)
      destination.entries.push(entry)
    }
    this.version++
    destination.version++
  }
  shuffle(seed: number): void {
    const rng = new Rng(seed)
    for (let i = this.count - 1; i > 0; i--) {
      const range = i + 1
      const limit = Math.floor(4294967296 / range) * range
      let n: number
      do {
        n = rng.nextU32()
      } while (n >= limit)
      const j = n % range
      const a = this.entries[i]!
      this.entries[i] = this.entries[j]!
      this.entries[j] = a
    }
    this.version++
  }
  snapshot(): { id: string; entries: CardEntry[] } {
    return { id: this.id, entries: this.entries.map((entry) => ({ ...entry })) }
  }
  private checkIndex(index: number, end = false): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count + Number(end)) {
      throw new ShardError('cards/invalid-index', `Index ${index} is outside ${this.id}`)
    }
  }
}

export interface CardLayout {
  kind: 'stack' | 'fan' | 'grid'
  spacing?: number
  columns?: number
  angle?: number
  width?: number
  height?: number
}
/** Writes xyz, then rotation about Z in radians. No allocations. */
export function cardPose(
  layout: CardLayout,
  index: number,
  count: number,
  out: Float64Array,
): void {
  const width = layout.width ?? 0.063
  const height = layout.height ?? 0.088
  const spacing = layout.spacing ?? 0.008
  out[0] = out[1] = out[2] = out[3] = 0
  if (layout.kind === 'stack') {
    out[2] = index * (layout.spacing ?? 0.00035)
    return
  }
  if (layout.kind === 'grid') {
    const cols = Math.max(1, Math.floor(layout.columns ?? 5))
    out[0] = ((index % cols) - (Math.min(cols, count) - 1) / 2) * (width + spacing)
    out[1] = -Math.floor(index / cols) * (height + spacing)
    return
  }
  const a = ((count < 2 ? 0 : index / (count - 1) - 0.5) * (layout.angle ?? 45) * Math.PI) / 180
  const radius = Math.max(height, count * spacing)
  out[0] = Math.sin(a) * radius
  out[1] = (Math.cos(a) - 1) * radius
  out[2] = index * 0.0004
  out[3] = -a
}
