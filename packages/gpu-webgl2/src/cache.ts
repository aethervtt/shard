import { type GlslStage, type GlslTranslation, loadNaga, type Naga } from './naga'

// Translations (0064), looked up in order: this session's memory, a baked set (`shard shaders
// bake`, fetched once), IndexedDB (earlier sessions), then naga, which loads only then. A session
// whose every shader is baked or stored never downloads naga. Every miss is counted with its
// time, for `render.describe → shaderCache`.

/** The naga build in `wasm/shard_naga.wasm` (crates/shard-naga): part of every key. */
export const NAGA_VERSION = '30.0.1'

/**
 * The shim's own version, also in every key: bump it when what the shim asks naga for, or does to
 * its GLSL, changes.
 */
export const SHIM_VERSION = 1

/** What a baked set holds (`.shard/shaders/webgl2.json`). */
export interface BakedTranslations {
  format: 'shard-webgl2-glsl'
  naga: string
  shim: number
  /** By key (`translationKey`). */
  entries: Record<string, GlslTranslation>
}

export interface ShaderCacheStats {
  /** Translations found without naga, by where. */
  hits: { memory: number; baked: number; stored: number }
  /** What naga translated this session, and how long each took (ms). */
  misses: { entry: string; stage: GlslStage; ms: number }[]
  /** How long loading naga took, or undefined if this session never needed it. */
  nagaLoadMs: number | undefined
  /** Translations in the baked set (0 without one, or if it was for another naga or shim). */
  baked: number
}

export interface TranslatorOptions {
  /** EXT_clip_control is on: only y is flipped in the vertex stage. */
  clipControl: boolean
  /** Where a baked set is served. */
  baked?: string | URL
  /** Keeps translations in IndexedDB across sessions. Default true where there is IndexedDB. */
  persist?: boolean
  /** Loads naga. Tests stub it. */
  naga?: () => Promise<Naga>
}

/** 106 bits of a string hash (two 53-bit cyrb53 lanes), as hex. */
function hash(text: string): string {
  const lane = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 2654435761)
      h2 = Math.imul(h2 ^ c, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
  }
  return lane(1) + lane(2)
}

/**
 * A translation's key: naga's and the shim's versions, the clip mode, the stage and entry point,
 * and the linked WGSL. A define or a data layout changes the WGSL, so the key; nothing else does.
 */
export function translationKey(
  code: string,
  entry: string,
  stage: GlslStage,
  clipControl: boolean,
): string {
  return hash(
    `${NAGA_VERSION}|${SHIM_VERSION}|${clipControl ? 'clip' : 'remap'}|${stage}|${entry}|${code}`,
  )
}

const DB = 'shard'
const STORE = 'webgl2-glsl'

/** IndexedDB, or undefined where there's none (Node) or it won't open (private windows). */
function openStore(): Promise<IDBDatabase | undefined> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (!idb) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    try {
      const request = idb.open(DB, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
      request.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

export class Translator {
  readonly stats: ShaderCacheStats = {
    hits: { memory: 0, baked: 0, stored: 0 },
    misses: [],
    nagaLoadMs: undefined,
    baked: 0,
  }
  private readonly options: TranslatorOptions
  private readonly memory = new Map<string, GlslTranslation>()
  private bakedSet: Promise<Record<string, GlslTranslation> | undefined> | undefined
  private bakedEntries: Record<string, GlslTranslation> | undefined
  private store: Promise<IDBDatabase | undefined> | undefined
  private naga: Promise<Naga> | undefined

  constructor(options: TranslatorOptions) {
    this.options = options
  }

  /** From memory or the (already fetched) baked set; undefined otherwise. Never loads anything. */
  cached(code: string, entry: string, stage: GlslStage): GlslTranslation | undefined {
    const key = translationKey(code, entry, stage, this.options.clipControl)
    const hit = this.memory.get(key)
    if (hit) {
      this.stats.hits.memory++
      return hit
    }
    const baked = this.bakedEntries?.[key]
    if (baked) {
      this.memory.set(key, baked)
      this.stats.hits.baked++
    }
    return baked
  }

  async translate(code: string, entry: string, stage: GlslStage): Promise<GlslTranslation> {
    const key = translationKey(code, entry, stage, this.options.clipControl)
    const hit = this.memory.get(key)
    if (hit) {
      this.stats.hits.memory++
      return hit
    }
    const baked = (await this.loadBaked())?.[key]
    if (baked) {
      this.memory.set(key, baked)
      this.stats.hits.baked++
      return baked
    }
    const stored = await this.read(key)
    if (stored) {
      this.memory.set(key, stored)
      this.stats.hits.stored++
      return stored
    }
    const naga = await this.loadNaga()
    const start = performance.now()
    const made = naga.translate(code, entry, stage, { clipControl: this.options.clipControl })
    this.stats.misses.push({ entry, stage, ms: performance.now() - start })
    this.memory.set(key, made)
    void this.write(key, made)
    return made
  }

  /** Fetches the baked set once; a set for another naga or shim counts as none. */
  private loadBaked(): Promise<Record<string, GlslTranslation> | undefined> {
    const url = this.options.baked
    if (!url) return Promise.resolve(undefined)
    this.bakedSet ??= (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) return undefined
        const set = (await response.json()) as BakedTranslations
        if (
          set.format !== 'shard-webgl2-glsl' ||
          set.naga !== NAGA_VERSION ||
          set.shim !== SHIM_VERSION
        ) {
          return undefined
        }
        this.stats.baked = Object.keys(set.entries).length
        this.bakedEntries = set.entries
        return set.entries
      } catch {
        return undefined
      }
    })()
    return this.bakedSet
  }

  private loadNaga(): Promise<Naga> {
    this.naga ??= (async () => {
      const start = performance.now()
      const naga = await (this.options.naga ?? loadNaga)()
      this.stats.nagaLoadMs = performance.now() - start
      return naga
    })()
    this.naga.catch(() => {
      this.naga = undefined
    })
    return this.naga
  }

  private db(): Promise<IDBDatabase | undefined> {
    if (this.options.persist === false) return Promise.resolve(undefined)
    this.store ??= openStore()
    return this.store
  }

  private async read(key: string): Promise<GlslTranslation | undefined> {
    const db = await this.db()
    if (!db) return undefined
    return new Promise((resolve) => {
      try {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
        request.onsuccess = () => resolve(request.result as GlslTranslation | undefined)
        request.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }

  private async write(key: string, value: GlslTranslation): Promise<void> {
    const db = await this.db()
    if (!db) return
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key)
    } catch {
      // Full or closing: the next session translates it again.
    }
  }
}
