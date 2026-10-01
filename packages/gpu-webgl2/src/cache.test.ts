import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type BakedTranslations,
  NAGA_VERSION,
  SHIM_VERSION,
  Translator,
  translationKey,
} from './cache'
import { loadNaga, type Naga } from './naga'

// The translation cache (0064): what a key depends on, and the lookup order (memory, the baked set,
// IndexedDB, naga), with naga loaded only on a real miss.

const SHADER = `@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  return vec4f(f32(v), 0.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`

/** naga, counting how often it's loaded and asked. */
function countingNaga() {
  const counts = { loads: 0, translations: 0 }
  const load = async (): Promise<Naga> => {
    counts.loads++
    const naga = await loadNaga()
    return {
      version: naga.version,
      translate: (...args) => {
        counts.translations++
        return naga.translate(...args)
      },
    }
  }
  return { counts, load }
}

/** Just enough IndexedDB for the cache: one database of one store, in memory, shared. */
function fakeIndexedDb(): IDBFactory {
  const data = new Map<string, unknown>()
  const request = <T>(result: () => T) => {
    const r = {
      result: undefined as T | undefined,
      onsuccess: null as null | (() => void),
      onerror: null,
    }
    queueMicrotask(() => {
      r.result = result()
      r.onsuccess?.()
    })
    return r
  }
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: (key: string) => request(() => data.get(key)),
        put: (value: unknown, key: string) => request(() => data.set(key, value)),
      }),
    }),
  }
  return {
    open: () => {
      const r = {
        result: db,
        onsuccess: null as null | (() => void),
        onupgradeneeded: null,
        onerror: null,
        onblocked: null,
      }
      queueMicrotask(() => r.onsuccess?.())
      return r
    },
  } as unknown as IDBFactory
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebGL2 translation cache (0064)', () => {
  it('keys a translation by its WGSL, entry, stage and clip mode, and nothing else', () => {
    const key = translationKey(SHADER, 'vs', 'vertex', true)
    expect(key).toMatch(/^[0-9a-f]{28}$/)
    expect(translationKey(SHADER, 'vs', 'vertex', true)).toBe(key)
    const others = [
      translationKey(`const FLAG = 1;\n${SHADER}`, 'vs', 'vertex', true), // a define
      translationKey(SHADER.replace('0.0, 0.0', '0.0, 0.5'), 'vs', 'vertex', true),
      translationKey(SHADER, 'fs', 'vertex', true),
      translationKey(SHADER, 'vs', 'fragment', true),
      translationKey(SHADER, 'vs', 'vertex', false),
    ]
    expect(new Set([key, ...others]).size).toBe(others.length + 1)
    expect(NAGA_VERSION).toBe('30.0.1')
  })

  it('translates with naga once, then answers from memory', async () => {
    const naga = countingNaga()
    const t = new Translator({ clipControl: true, persist: false, naga: naga.load })
    expect(t.cached(SHADER, 'vs', 'vertex')).toBeUndefined()
    const first = await t.translate(SHADER, 'vs', 'vertex')
    expect(first.glsl).toContain('#version 300 es')
    await t.translate(SHADER, 'vs', 'vertex')
    expect(t.cached(SHADER, 'vs', 'vertex')).toBe(first)
    expect(naga.counts).toEqual({ loads: 1, translations: 1 })
    expect(t.stats.hits.memory).toBe(2)
    expect(t.stats.misses).toEqual([{ entry: 'vs', stage: 'vertex', ms: expect.any(Number) }])
    expect(t.stats.nagaLoadMs).toBeGreaterThanOrEqual(0)
  })

  it('serves a baked set without loading naga, and ignores one baked for another naga', async () => {
    const real = await loadNaga()
    const vs = real.translate(SHADER, 'vs', 'vertex', { clipControl: true })
    const fs = real.translate(SHADER, 'fs', 'fragment', { clipControl: true })
    const set: BakedTranslations = {
      format: 'shard-webgl2-glsl',
      naga: NAGA_VERSION,
      shim: SHIM_VERSION,
      entries: {
        [translationKey(SHADER, 'vs', 'vertex', true)]: vs,
        [translationKey(SHADER, 'fs', 'fragment', true)]: fs,
      },
    }
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url))
      return new Response(JSON.stringify(url.includes('old') ? { ...set, naga: '29.0.0' } : set))
    })
    const naga = countingNaga()
    const t = new Translator({
      clipControl: true,
      persist: false,
      baked: '/webgl2.json',
      naga: naga.load,
    })
    expect(await t.translate(SHADER, 'vs', 'vertex')).toEqual(vs)
    expect(await t.translate(SHADER, 'fs', 'fragment')).toEqual(fs)
    // Once fetched, the set answers synchronous lookups too.
    expect(t.cached(SHADER, 'fs', 'fragment')).toEqual(fs)
    expect(naga.counts.loads).toBe(0)
    expect(fetched).toEqual(['/webgl2.json'])
    expect(t.stats).toMatchObject({ baked: 2, misses: [], nagaLoadMs: undefined })

    const stale = new Translator({
      clipControl: true,
      persist: false,
      baked: '/old.json',
      naga: naga.load,
    })
    await stale.translate(SHADER, 'vs', 'vertex')
    expect(stale.stats.baked).toBe(0)
    expect(naga.counts.loads).toBe(1)
    // A set baked with clip control doesn't serve a device without it.
    const remap = new Translator({
      clipControl: false,
      persist: false,
      baked: '/webgl2.json',
      naga: naga.load,
    })
    const translated = await remap.translate(SHADER, 'vs', 'vertex')
    expect(translated.glsl).toContain('gl_Position.z * 2.0')
    expect(remap.stats.misses).toHaveLength(1)
  })

  it('keeps translations in IndexedDB: the next session needs no naga', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb())
    const naga = countingNaga()
    const first = new Translator({ clipControl: true, naga: naga.load })
    const made = await first.translate(SHADER, 'vs', 'vertex')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const next = new Translator({ clipControl: true, naga: naga.load })
    expect(await next.translate(SHADER, 'vs', 'vertex')).toEqual(made)
    expect(next.stats).toMatchObject({ hits: { stored: 1 }, misses: [], nagaLoadMs: undefined })
    expect(naga.counts.loads).toBe(1)
  })
})
