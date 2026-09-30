import { ChildOf, type Entity, ShardError, type World } from '@aethervtt/shard-core'

export interface MirrorOptions<D, K = string> {
  /** The host's id for a document. Stable across revisions. */
  key(doc: D): K
  /**
   * The document's revision: a number that changes whenever the document does. An unchanged
   * revision skips the document for one map lookup and one compare.
   */
  rev?(doc: D): number
  /** Without `rev`: whether a document changed since `prev` was applied. Never stringify here. */
  equal?(prev: D, next: D): boolean
  /** Makes the entity (or the root of the entities) for a new document. `apply` runs next. */
  spawn(doc: D, world: World): Entity
  /** Writes a new or changed document onto its entity. Write only the fields that moved. */
  apply(entity: Entity, doc: D, world: World): void
  /**
   * Takes a document's entity away (`key` is the document's). Default: `world.despawn` (the entity
   * and its descendants).
   */
  despawn?(entity: Entity, world: World, key: K): void
}

/** What one `sync`, `upsert` or `remove` did, for tests and `describe`. */
export interface MirrorCounts {
  spawned: number
  applied: number
  removed: number
}

interface Row<D> {
  entity: Entity
  rev: number
  /** The last document applied, kept only for `equal`. */
  doc: D | undefined
  /** The `sync` pass that last saw this document. */
  mark: number
}

/**
 * Keyed sync from a host's documents to entities (0055). `sync` walks the host's full list once:
 * a document whose revision is unchanged costs one map lookup and one number compare, and nothing
 * allocates when nothing changed. A host that knows what changed calls `upsert` and `remove`.
 */
export class Mirror<D, K = string> {
  /** What the last call did. */
  readonly last: MirrorCounts = { spawned: 0, applied: 0, removed: 0 }
  private readonly world: World
  private readonly options: MirrorOptions<D, K>
  private readonly rows = new Map<K, Row<D>>()
  private readonly keys = new Map<Entity, K>()
  private pass = 0
  /** Bound once, so the removal sweep allocates no closure. */
  private readonly sweep = (row: Row<D>, key: K): void => {
    if (row.mark !== this.pass) this.drop(key, row)
  }

  constructor(world: World, options: MirrorOptions<D, K>) {
    if (!options.rev && !options.equal) {
      throw new ShardError(
        'mirror/no-diff',
        'A mirror needs `rev` or `equal` to tell what changed',
        {
          hint: 'Pass rev: (doc) => doc.rev when documents carry a revision (cheapest), or equal(prev, next).',
        },
      )
    }
    this.world = world
    this.options = options
  }

  /** Documents mirrored. */
  get size(): number {
    return this.rows.size
  }

  /**
   * Applies the host's full list: spawns new documents, applies changed ones, and despawns the
   * ones missing from `docs`.
   */
  sync(docs: readonly D[]): MirrorCounts {
    const last = this.last
    last.spawned = last.applied = last.removed = 0
    const pass = ++this.pass
    const { key, rev } = this.options
    let seen = 0
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!
      const k = key(doc)
      const row = this.rows.get(k)
      if (row) {
        if (row.mark === pass) duplicate(k)
        row.mark = pass
        seen++
        if (rev ? row.rev !== rev(doc) : !this.options.equal!(row.doc!, doc)) this.update(row, doc)
      } else {
        this.create(k, doc).mark = pass
        seen++
      }
    }
    // Every stored document was seen: nothing to remove, and no sweep.
    if (seen !== this.rows.size) this.rows.forEach(this.sweep)
    return last
  }

  /** Applies one document the host knows is new or changed (unchanged revisions are skipped). */
  upsert(doc: D): Entity {
    const last = this.last
    last.spawned = last.applied = last.removed = 0
    const k = this.options.key(doc)
    const row = this.rows.get(k)
    if (!row) return this.create(k, doc).entity
    const rev = this.options.rev
    if (rev ? row.rev !== rev(doc) : !this.options.equal!(row.doc!, doc)) this.update(row, doc)
    return row.entity
  }

  /** Despawns a document's entity. Returns whether it was mirrored. */
  remove(key: K): boolean {
    const last = this.last
    last.spawned = last.applied = last.removed = 0
    const row = this.rows.get(key)
    if (!row) return false
    this.drop(key, row)
    return true
  }

  /** The entity mirroring a document. */
  entity(key: K): Entity | undefined {
    return this.rows.get(key)?.entity
  }

  /**
   * The host id for an entity or any of its descendants: a pick hit on a token's visual child
   * resolves to the token's document.
   */
  keyOf(entity: Entity): K | undefined {
    const world = this.world
    let e: Entity | null = entity
    while (e !== null && world.isAlive(e)) {
      const k = this.keys.get(e)
      if (k !== undefined) return k
      e = world.tryGet(e, ChildOf)?.parent ?? null
    }
    return undefined
  }

  /** Every mirrored document's key, in the order they were first seen. */
  keysInOrder(): K[] {
    return [...this.rows.keys()]
  }

  /** Despawns every mirrored entity. */
  clear(): void {
    const last = this.last
    last.spawned = last.applied = last.removed = 0
    this.pass++
    this.rows.forEach(this.sweep)
  }

  private create(k: K, doc: D): Row<D> {
    const { spawn, apply, rev, equal } = this.options
    const entity = spawn(doc, this.world)
    const row: Row<D> = { entity, rev: rev ? rev(doc) : 0, doc: equal ? doc : undefined, mark: 0 }
    this.rows.set(k, row)
    this.keys.set(entity, k)
    apply(entity, doc, this.world)
    this.last.spawned++
    return row
  }

  private update(row: Row<D>, doc: D): void {
    const { apply, rev, equal } = this.options
    if (rev) row.rev = rev(doc)
    if (equal) row.doc = doc
    apply(row.entity, doc, this.world)
    this.last.applied++
  }

  private drop(k: K, row: Row<D>): void {
    this.rows.delete(k)
    this.keys.delete(row.entity)
    const world = this.world
    if (world.isAlive(row.entity)) {
      if (this.options.despawn) this.options.despawn(row.entity, world, k)
      else world.despawn(row.entity)
    }
    this.last.removed++
  }
}

function duplicate(key: unknown): never {
  throw new ShardError('mirror/duplicate-key', `Two documents in one sync share the key ${key}`, {
    hint: 'Keys are the host ids of documents: each may appear once per list.',
  })
}

/** A mirror of host documents onto `world` (0055). */
export function createMirror<D, K = string>(
  world: World,
  options: MirrorOptions<D, K>,
): Mirror<D, K> {
  return new Mirror(world, options)
}
