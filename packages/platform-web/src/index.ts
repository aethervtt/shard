import { ShardError } from '@aethervtt/shard-core'
import {
  type AudioBackend,
  type BuildFiles,
  buildFs,
  type Platform,
  type PlatformFileSystem,
  type Workers,
} from '@aethervtt/shard-platform'
import { createWebAudioBackend } from './audio'
import { createWebPerformance } from './performance'
import { createIndexedDbStorage } from './storage'
import { createWebWorkers } from './workers'

export interface WebPlatformOptions {
  /** Base URL that project paths resolve against. Defaults to the document base. */
  baseUrl?: string
  /** IndexedDB database for `storage` (saves, settings). Default `shard`. */
  storageName?: string
  /** Web workers for `workers` (made on first use). 0 runs jobs inline. Default: cores − 1, 1 to 8. */
  workers?: number
  /** An export's files (0110): project paths read through `buildFs` from their hashed URLs. */
  files?: BuildFiles
  /** The export's `.shardpak` files, read by range, that packed `files` are in. */
  packs?: readonly string[]
}

export function createWebPlatform(options: WebPlatformOptions = {}): Platform {
  const baseUrl = options.baseUrl ?? document.baseURI

  const readOnly = (path: string): never => {
    throw new ShardError('platform/fs-read-only', `Cannot write "${path}" on the web platform`, {
      hint: 'Writes need a writable host such as Studio or the CLI.',
      path,
    })
  }

  const fetchOk = async (path: string) => {
    const res = await fetch(new URL(path, baseUrl))
    if (!res.ok) {
      throw new ShardError('platform/fs-not-found', `Failed to fetch "${path}" (${res.status})`, {
        path,
      })
    }
    return res
  }

  /**
   * Per file read by range: undefined once the host answered a range (206), or the whole file when
   * it ignored one (200), kept so later ranges of it (an export's pack, 0110) are slices instead
   * of whole downloads. The first ranged read of a file finds out; others of it wait for that.
   * Only hosts that ignore Range pay the memory, and they'd pay a download per read otherwise.
   */
  const whole = new Map<string, Promise<Uint8Array | undefined>>()

  const fs: PlatformFileSystem = {
    resolveUrl: (path) => new URL(path, baseUrl).href,
    writable: false,
    readText: async (path) => (await fetchOk(path)).text(),
    readBytes: async (path) => new Uint8Array(await (await fetchOk(path)).arrayBuffer()),
    readRange: async (path, offset, length) => {
      const url = new URL(path, baseUrl).href
      const known = whole.get(url)
      if (known) {
        const bytes = await known
        if (bytes) return bytes.subarray(offset, offset + length)
      }
      const fetching = fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      }).then(async (res) => {
        if (!res.ok) {
          throw new ShardError(
            'platform/fs-not-found',
            `Failed to fetch "${path}" (${res.status})`,
            {
              path,
            },
          )
        }
        return { ranged: res.status === 206, bytes: new Uint8Array(await res.arrayBuffer()) }
      })
      if (!known) {
        whole.set(
          url,
          fetching.then(
            (r) => (r.ranged ? undefined : r.bytes),
            () => {
              // A failed read says nothing about the host: the next one asks again.
              whole.delete(url)
              return undefined
            },
          ),
        )
      }
      const { ranged, bytes } = await fetching
      return ranged ? bytes : bytes.subarray(offset, offset + length)
    },
    writeText: async (path) => readOnly(path),
    writeBytes: async (path) => readOnly(path),
    exists: async (path) => (await fetch(new URL(path, baseUrl), { method: 'HEAD' })).ok,
  }

  let audio: AudioBackend | undefined
  let workers: Workers | undefined
  return {
    name: 'web',
    get workers() {
      workers ??= createWebWorkers(options.workers)
      return workers
    },
    // Made on first use, so pages that never play sound don't open an AudioContext.
    get audio() {
      audio ??= createWebAudioBackend()
      return audio
    },
    fs: options.files ? buildFs(fs, options.files, options.packs) : fs,
    storage: createIndexedDbStorage(options.storageName),
    performance: createWebPerformance(),
    clock: { now: () => performance.now() },
    log: {
      log: (level, message, data) => console[level](`[shard] ${message}`, data ?? ''),
    },
  }
}

export { createWebAudioBackend, type WebAudioBackend } from './audio'
export {
  type AudioRenderPlan,
  audioBufferWav,
  measureAudioBuffer,
  renderAudioPreview,
} from './audio-preview'
export { createDomInputSource, type DomInputOptions } from './input'
export { createWebPerformance } from './performance'
export { createIndexedDbStorage } from './storage'
export { createWebWorkers } from './workers'
