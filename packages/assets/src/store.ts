import { type AssetRef, ShardError } from '@shard/core'

/**
 * Runtime objects of one asset type, by guid. File-backed assets are put here by the asset server
 * once loaded; runtime-made ones (`add`) get `mem:` guids. `get` is a map lookup and never
 * allocates, so render and gameplay code can call it per entity per frame.
 */
export class AssetStore<T, K extends string = string> {
  readonly type: K
  private readonly items = new Map<string, T>()
  private next = 0

  constructor(type: K) {
    this.type = type
  }

  /** Adds a runtime-made asset. An optional name becomes the ref's path. */
  add(item: T, name?: string): AssetRef<K> {
    const guid = `mem:${this.type.toLowerCase()}:${this.next++}`
    this.items.set(guid, item)
    return { type: this.type, guid, path: name }
  }

  /** Puts an asset under a known guid (the asset server does this after a load). */
  set(guid: string, item: T): void {
    this.items.set(guid, item)
  }

  delete(guid: string): boolean {
    return this.items.delete(guid)
  }

  has(guid: string): boolean {
    return this.items.has(guid)
  }

  /** The asset for a ref, or undefined. Hot path: a map lookup by guid, no allocation. */
  get(ref: { readonly guid: string | undefined } | null | undefined): T | undefined {
    return ref?.guid === undefined ? undefined : this.items.get(ref.guid)
  }

  byGuid(guid: string): T | undefined {
    return this.items.get(guid)
  }

  require(ref: { readonly guid: string | undefined } | null | undefined): T {
    const item = this.get(ref)
    if (!item) {
      throw new ShardError(
        'assets/not-loaded',
        `No ${this.type} asset for ${JSON.stringify(ref)}`,
        { hint: `Load it first (assets.load), or add it to the ${this.type} store.` },
      )
    }
    return item
  }

  get size(): number {
    return this.items.size
  }

  /** Every loaded asset with its guid. */
  entries(): IterableIterator<[string, T]> {
    return this.items.entries()
  }

  values(): IterableIterator<T> {
    return this.items.values()
  }
}
