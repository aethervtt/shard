import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ShardError } from '@aethervtt/shard-core'
import { nodeGpu } from '@aethervtt/shard-gpu/node'
import { buildFs, createMemoryStorage, type Platform } from '@aethervtt/shard-platform'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import type { BuildJson } from '@aethervtt/shard-project'

/** What an export's headless entry returns from `boot` (0110). Its engine is the export's own. */
export interface BuildHandle {
  frames(count: number): void
  /** Frames that wait for shaders and pipelines to compile (the shader bake). */
  settle(count: number): Promise<void>
  entities(): number
  hashRows(): string[]
  loadScene(path: string): Promise<void>
  unloadScene(path: string): void
  shaderBake(): unknown
  dispose(): void
}

export interface OpenBuildOptions {
  /** Overrides the manifest's seed. */
  seed?: number
  /** Load the start scene (default true). */
  startScene?: boolean
  /** The build, when the caller has it before `build.json` is written (the export's shader bake). */
  build?: BuildJson
  /** 'baseline': a compatibility-mode device (0064). */
  tier?: 'baseline'
  /** Where the code is, when it isn't beside the data (a desktop export's `page/`, 0111). */
  codeDir?: string
}

export interface OpenedBuild {
  dir: string
  build: BuildJson
  handle: BuildHandle
  /** sha256 of the world's rows: the same as `worldHash` on a project run. */
  hash(): string
  close(): void
}

let fileFetch = false

/**
 * Lets `fetch` read `file:` URLs, as an export's code does for its WASM next to its chunks. Node's
 * own fetch can't; a browser serving the export over HTTP never needs this.
 */
export function installFileFetch(): void {
  if (fileFetch) return
  fileFetch = true
  const fetchUrl = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('file:')) return fetchUrl(input, init)
    const type = url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
    return new Response(await readFile(fileURLToPath(url)), { headers: { 'content-type': type } })
  }) as typeof fetch
}

/**
 * Runs an export headless (0110): its own bundled engine and project code over its files, on Dawn.
 * What `shard run --build` and the export's shader bake use.
 */
export async function openBuild(dir: string, options: OpenBuildOptions = {}): Promise<OpenedBuild> {
  // A desktop export (0111) keeps its page and its data apart: dist/tauri/page and /data.
  const split = !existsSync(join(dir, 'build.json')) && existsSync(join(dir, 'data/build.json'))
  const root = resolve(split ? join(dir, 'data') : dir)
  const code = resolve(options.codeDir ?? (split ? join(dir, 'page') : root))
  let build = options.build
  if (!build) {
    try {
      build = JSON.parse(await readFile(join(root, 'build.json'), 'utf8')) as BuildJson
    } catch (cause) {
      throw new ShardError('export/not-a-build', `${dir} has no readable build.json`, {
        hint: 'Pass the folder `shard export` wrote (dist/web by default).',
        cause,
      })
    }
  }
  installFileFetch()
  const files = createNodePlatform({ root })
  const platform: Platform = {
    ...files,
    storage: createMemoryStorage(),
    fs: buildFs(files.fs, build.files, build.packs),
  }
  const mod = (await import(pathToFileURL(join(code, build.headless)).href)) as {
    boot(o: object): Promise<BuildHandle>
  }
  const handle = await mod.boot({
    gpu: nodeGpu(),
    platform,
    build,
    seed: options.seed,
    startScene: options.startScene,
    tier: options.tier,
    // Generator jobs on worker threads, as `shard run` runs them.
    procgenWorker: build.workers.procgen && pathToFileURL(join(code, build.workers.procgen)).href,
  })
  return {
    dir: root,
    build,
    handle,
    hash: () => createHash('sha256').update(handle.hashRows().join('\n')).digest('hex'),
    close() {
      handle.dispose()
      platform.workers?.dispose()
    },
  }
}

/**
 * The export's shader bake (0056): loads each scene in the built export, settles `frames` frames,
 * and keeps every variant it linked, once on a full-tier device and once on the baseline tier
 * (what WebGL2 runs, 0064). Undefined when Dawn finds no adapter.
 */
export async function bakeBuildShaders(
  dir: string,
  build: BuildJson,
  scenes: readonly string[],
  frames: number,
  codeDir?: string,
): Promise<{ version: 1; shaders: { key: string }[] } | undefined> {
  const shaders = new Map<string, { key: string }>()
  for (const tier of [undefined, 'baseline'] as const) {
    let opened: OpenedBuild
    try {
      opened = await openBuild(dir, { build, startScene: false, tier, codeDir })
    } catch (err) {
      // The export's own ShardError, not this one: match the code.
      if ((err as { code?: string }).code === 'gpu/no-adapter') return undefined
      throw err
    }
    try {
      for (const scene of scenes) {
        await opened.handle.loadScene(scene)
        await opened.handle.settle(frames)
        opened.handle.unloadScene(scene)
      }
      const bake = opened.handle.shaderBake() as { shaders: { key: string }[] } | undefined
      for (const entry of bake?.shaders ?? []) shaders.set(entry.key, entry)
    } finally {
      opened.close()
    }
  }
  const sorted = [...shaders.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
  return { version: 1, shaders: sorted }
}
