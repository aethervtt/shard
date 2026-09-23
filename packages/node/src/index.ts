import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type AssetServer, assetServer, type ScanReport } from '@shard/assets'
import { ChildOf, ShardError, type World } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import type { Platform } from '@shard/platform'
import { createNodePlatform } from '@shard/platform-node'
import {
  buildApp,
  type ErrorCode,
  loadProject,
  locateInBundle,
  type ManifestValue,
  ProjectSession,
} from '@shard/project'
import { createProtocolServer, type ProtocolServer } from '@shard/protocol'
import { OffscreenTarget } from '@shard/render'
import { type App, LogResource, type Plugin } from '@shard/runtime'
import { type LoadedSceneHandle, loadScene, whenSceneReady } from '@shard/scene'
import { type BuiltBundle, type Bundler, createBundler } from './bundle'

export { createNodePlatform } from '@shard/platform-node'

export interface OpenProjectOptions {
  /** Project folder (with shard.json). */
  root: string
  /** Headless render size; defaults to the manifest's window. */
  width?: number
  height?: number
  /** Load the manifest's start scene (default true). */
  loadStartScene?: boolean
  /** Share a GPU context across projects (tests); otherwise one is created. */
  gpu?: GpuContext
  /** Overrides the manifest's `seed`. */
  seed?: number
  /** Hot reload assets and project code when files change (default false). */
  watch?: boolean
  /**
   * 'bundle' (default): esbuild bundles `entry` and hot reload works. 'source': imports `entry`
   * directly (gameplay tests, where test files import the same modules).
   */
  code?: 'bundle' | 'source'
}

export interface HeadlessProject {
  root: string
  manifest: ManifestValue
  platform: Platform
  app: App
  server: ProtocolServer
  gpu: GpuContext
  target: OffscreenTarget
  scene: LoadedSceneHandle | undefined
  assets: AssetServer
  /** What the startup scan imported, skipped, and failed. */
  imports: ScanReport
  /** The project's code: reloads, status, errors. */
  session: ProjectSession
  /** The bundler, in 'bundle' mode. */
  bundler: Bundler | undefined
  close(): void
}

/** Imports the project plugin (default export of `entry`). */
export async function importProjectPlugin(root: string, manifest: ManifestValue): Promise<Plugin> {
  const file = resolve(root, manifest.entry)
  let mod: { default?: Plugin }
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (cause) {
    throw new ShardError(
      'project/entry-failed',
      `Couldn't load ${manifest.entry}: ${(cause as Error).message}`,
      {
        path: manifest.entry,
        hint: 'The entry must be a module whose default export is defineProject({...}).',
        cause,
      },
    )
  }
  const plugin = mod.default
  if (!plugin || typeof plugin.build !== 'function' || typeof plugin.name !== 'string') {
    throw new ShardError(
      'project/entry-invalid',
      `${manifest.entry} has no project plugin as its default export`,
      {
        path: manifest.entry,
        hint: 'End the file with `export default project`, where project = defineProject({...}).',
      },
    )
  }
  return plugin
}

/** Opens a project headless: manifest, project code, Dawn GPU, offscreen target, protocol server. */
export async function openProject(options: OpenProjectOptions): Promise<HeadlessProject> {
  const root = resolve(options.root)
  const platform = createNodePlatform({ root })
  const loaded = (await loadProject(platform)).manifest
  const manifest = options.seed === undefined ? loaded : { ...loaded, seed: options.seed }
  const code = options.code ?? 'bundle'
  let bundler: Bundler | undefined
  let project: Plugin
  if (code === 'bundle') {
    bundler = await createBundler({ root, entry: manifest.entry })
    let built: BuiltBundle
    try {
      built = await bundler.build()
    } catch (err) {
      await bundler.dispose()
      throw err
    }
    project = await importBundle(built, manifest)
  } else {
    project = await importProjectPlugin(root, manifest)
  }
  const ownGpu = !options.gpu
  const gpu = options.gpu ?? (await createNodeGpuContext({ features: ['timestamp-query'] }))
  const target = new OffscreenTarget(gpu, {
    label: 'headless',
    width: options.width ?? manifest.window.width,
    height: options.height ?? manifest.window.height,
  })
  const app = buildApp({ manifest, project, gpu, target })
  await app.init()
  const assets = assetServer(app.world).configure({ platform, roots: manifest.assetRoots })
  const imports = await assets.scan()
  const stopWatching = options.watch ? await assets.watch() : () => {}
  let scene: LoadedSceneHandle | undefined
  if (options.loadStartScene ?? true) {
    const json = JSON.parse(await platform.fs.readText(manifest.startScene))
    scene = loadScene(app.world, json, { id: manifest.startScene })
    await whenSceneReady(app.world, manifest.startScene)
  }
  const log = app.world.resource(LogResource)
  log.annotate = (err) => {
    const last = bundler?.last
    // Wrapped errors (e.g. app/system-failed) carry the thrown one as `cause`: look through it.
    for (
      let e: unknown = err, depth = 0;
      e && depth < 5;
      e = (e as { cause?: unknown }).cause, depth++
    ) {
      const mapped =
        last?.map &&
        locateInBundle(e, last.url, last.map, (s) =>
          relative(root, resolve(dirname(last.file), s))
            .split('\\')
            .join('/'),
        )
      const source = mapped || locateInProject(e, root)
      if (source) return { source }
    }
    return undefined
  }
  const session = new ProjectSession(app, {
    namespace: manifest.name,
    current: project,
    ...(bundler?.last ? { bundle: { hash: bundler.last.hash, ms: bundler.last.ms } } : {}),
  })
  if (bundler) {
    const b = bundler
    session.rebuild = async () => {
      const built = await b.build()
      return { load: () => import(b.importUrl(built)), hash: built.hash, ms: built.ms }
    }
  }
  const server = createProtocolServer(app, {
    frames: 'manual',
    platform,
    methods: session.methods(),
  })
  session.onChange((status) => server.publish('project', status))
  let stopCode = () => {}
  if (options.watch && bundler) {
    session.watching = true
    stopCode = bundler.watch((result) => {
      if (result instanceof Error) session.buildFailed(result)
      else
        void session.reload(() => import(bundler!.importUrl(result)), {
          hash: result.hash,
          ms: result.ms,
        })
    })
  }
  return {
    root,
    manifest,
    platform,
    app,
    server,
    gpu,
    target,
    scene,
    assets,
    imports,
    session,
    bundler,
    close() {
      stopWatching()
      stopCode()
      void bundler?.dispose()
      server.close()
      target.destroy()
      if (ownGpu) gpu.destroy()
    },
  }
}

async function importBundle(built: BuiltBundle, manifest: ManifestValue): Promise<Plugin> {
  let mod: { default?: Plugin }
  try {
    mod = await import(built.url)
  } catch (cause) {
    const source = built.map ? locateInBundle(cause, built.url, built.map) : undefined
    throw Object.assign(
      new ShardError(
        'project/entry-failed',
        `Couldn't start ${manifest.entry}: ${(cause as Error).message}`,
        {
          path: manifest.entry,
          hint: 'The error is in the project code; see "source" for where.',
          cause,
        },
      ),
      { source },
    )
  }
  const plugin = mod.default
  if (!plugin || typeof plugin.build !== 'function' || typeof plugin.name !== 'string') {
    throw new ShardError(
      'project/entry-invalid',
      `${manifest.entry} has no project plugin as its default export`,
      {
        path: manifest.entry,
        hint: 'End the file with `export default project`, where project = defineProject({...}).',
      },
    )
  }
  return plugin
}

/** The first stack frame in project source (not node_modules or .shard), as `path:line:col`. */
export function locateInProject(error: unknown, root: string): string | undefined {
  const stack = (error as { stack?: unknown })?.stack
  if (typeof stack !== 'string') return undefined
  const prefix = resolve(root)
  for (const line of stack.split('\n')) {
    const m = /(?:file:\/\/)?(\/[^\s():]+):(\d+):(\d+)/.exec(line)
    if (!m) continue
    const file = decodeURIComponent(m[1]!)
    if (!file.startsWith(`${prefix}/`)) continue
    const rel = relative(prefix, file).split('\\').join('/')
    if (rel.startsWith('.shard/') || rel.includes('node_modules/')) continue
    return `${rel}:${m[2]}:${m[3]}`
  }
  return undefined
}

/** Scene files under `scenes/`, as project-relative paths. */
export async function listScenes(root: string): Promise<string[]> {
  const dir = join(resolve(root), 'scenes')
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  return entries
    .filter((f) => f.endsWith('.scene.json'))
    .map((f) => relative(resolve(root), join(dir, f)).split('\\').join('/'))
    .sort()
}

/**
 * A stable hash of every entity's serializable components (and parents). Equal worlds hash equal,
 * so determinism checks compare one string.
 */
export function worldHash(world: World): string {
  const rows: string[] = []
  for (const table of world.allTables()) {
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      const values = table.components
        .filter((c) => c.serializable || c === ChildOf)
        .map((c) => [c.name, c.serialize(table.readComponent(c, row))])
      rows.push(JSON.stringify([entity, values]))
    }
  }
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}

/**
 * Error codes the engine can raise, scanned from the engine packages' sources (with the hint written
 * next to each). Feeds `.agents/errors.md`.
 */
export async function collectErrorCodes(): Promise<ErrorCode[]> {
  const require = createRequire(import.meta.url)
  // @shard/core resolves to packages/core/src/index.ts; the packages dir is three levels up.
  const packagesDir = dirname(dirname(dirname(require.resolve('@shard/core'))))
  const found = new Map<string, ErrorCode>()
  const pkgs = await readdir(packagesDir).catch(() => [] as string[])
  for (const pkg of pkgs) {
    const src = join(packagesDir, pkg, 'src')
    const files = await readdir(src, { recursive: true }).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const text = await readFile(join(src, file), 'utf8')
      const re = /new ShardError\(\s*['"]([a-z0-9-]+\/[a-z0-9-]+)['"]/g
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const code = m[1]!
        const window = text.slice(m.index, m.index + 700)
        const next = window.indexOf('new ShardError', 10)
        const hint = /hint:\s*(['"`])((?:(?!\1).)+)\1/.exec(
          next === -1 ? window : window.slice(0, next),
        )?.[2]
        if (!found.has(code) || (!found.get(code)!.hint && hint)) {
          found.set(code, {
            code,
            source: `@shard/${pkg}`,
            ...(hint && !hint.includes('${') ? { hint } : {}),
          })
        }
      }
    }
  }
  return [...found.values()]
}

export { type BuiltBundle, type Bundler, createBundler } from './bundle'
