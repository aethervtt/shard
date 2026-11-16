import { ShardError } from '@aethervtt/shard-core'
import type { KeyValueStorage } from '@aethervtt/shard-platform'

const STORE = 'files'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let persistAsked = false

/**
 * Asks the browser once per page to keep this origin's storage under pressure (and, in Safari,
 * past seven idle days): only on a secure page's main thread, and only if it isn't kept already.
 * Firefox may show a prompt; refusals and failures change nothing.
 */
function askToPersist(): void {
  if (persistAsked) return
  persistAsked = true
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
  if (typeof document === 'undefined' || !globalThis.isSecureContext || !storage?.persist) return
  void (async () => {
    if (await storage.persisted?.()) return
    await storage.persist()
  })().catch(() => {})
}

/**
 * Storage in an IndexedDB database (one object store of key → bytes): saves and settings survive
 * reloads and aren't limited to localStorage's few megabytes of strings. Opening it asks for
 * persistent storage once (`navigator.storage.persist()`), so the cache isn't evicted first.
 */
export function createIndexedDbStorage(name = 'shard'): KeyValueStorage {
  let db: Promise<IDBDatabase> | undefined
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(
          new ShardError('platform/no-storage', 'IndexedDB is not available here', {
            hint: 'Private browsing modes and some embedded webviews disable it.',
          }),
        )
        return
      }
      askToPersist()
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return db
  }
  const store = async (mode: IDBTransactionMode) =>
    (await open()).transaction(STORE, mode).objectStore(STORE)
  return {
    read: async (key) => {
      const value = await request((await store('readonly')).get(key))
      return value === undefined ? undefined : new Uint8Array(value as ArrayBuffer)
    },
    write: async (key, data) => {
      // Stored as an ArrayBuffer copy: the caller may reuse its array.
      await request((await store('readwrite')).put(data.slice().buffer, key))
    },
    list: async (prefix) => {
      const range = prefix === '' ? undefined : IDBKeyRange.bound(prefix, `${prefix}￿`)
      const keys = await request((await store('readonly')).getAllKeys(range))
      return (keys as string[]).filter((k) => k.startsWith(prefix)).sort()
    },
    delete: async (key) => {
      await request((await store('readwrite')).delete(key))
    },
  }
}
