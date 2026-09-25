import { ShardError } from '@shard/core'
import type { AudioBackend, Platform, PlatformFileSystem } from '@shard/platform'
import { createWebAudioBackend } from './audio'
import { createIndexedDbStorage } from './storage'

export interface WebPlatformOptions {
  /** Base URL that project paths resolve against. Defaults to the document base. */
  baseUrl?: string
  /** IndexedDB database for `storage` (saves, settings). Default `shard`. */
  storageName?: string
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

  const fs: PlatformFileSystem = {
    writable: false,
    readText: async (path) => (await fetchOk(path)).text(),
    readBytes: async (path) => new Uint8Array(await (await fetchOk(path)).arrayBuffer()),
    writeText: async (path) => readOnly(path),
    writeBytes: async (path) => readOnly(path),
    exists: async (path) => (await fetch(new URL(path, baseUrl), { method: 'HEAD' })).ok,
  }

  let audio: AudioBackend | undefined
  return {
    name: 'web',
    // Made on first use, so pages that never play sound don't open an AudioContext.
    get audio() {
      audio ??= createWebAudioBackend()
      return audio
    },
    fs,
    storage: createIndexedDbStorage(options.storageName),
    clock: { now: () => performance.now() },
    log: {
      log: (level, message, data) => console[level](`[shard] ${message}`, data ?? ''),
    },
  }
}

export { createWebAudioBackend, type WebAudioBackend } from './audio'
export { createDomInputSource } from './input'
export { createIndexedDbStorage } from './storage'
