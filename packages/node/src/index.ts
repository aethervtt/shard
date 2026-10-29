import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type AssetServer, assetServer, type ScanReport } from '@aethervtt/shard-assets'
import {
  type AnyField,
  ChildOf,
  Derived,
  type Entity,
  type Fields,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createMemoryStorage, type Platform } from '@aethervtt/shard-platform'
import { createNodePlatform, loadPerfBudgets } from '@aethervtt/shard-platform-node'
import { configureProcgenHost, procgenHost } from '@aethervtt/shard-procgen'
import {
  buildApp,
  type ErrorCode,
  loadProject,
  loadProjectNavCache,
  loadProjectShaders,
  loadProjectStrings,
  locateInBundle,
  type ManifestValue,
  ProjectSession,
} from '@aethervtt/shard-project'
import { createProtocolServer, type ProtocolServer } from '@aethervtt/shard-protocol'
import { OffscreenTarget } from '@aethervtt/shard-render'
import {
  type App,
  LogResource,
  PerfBudgets,
  type PerfBudgetsData,
  type Plugin,
} from '@aethervtt/shard-runtime'
import { type LoadedSceneHandle, loadScene, whenSceneReady } from '@aethervtt/shard-scene'
import { type BuiltBundle, type Bundler, createBundler } from './bundle'
import { prepareGenerators } from './generators'

export { createNodePlatform } from '@aethervtt/shard-platform-node'

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
  /**
   * Run generator jobs on worker threads (default true): the project's code is bundled with the
   * engine into `.shard/build/procgen-worker.<hash>.mjs`. False runs them inline.
   */
  generatorWorkers?: boolean
  /**
   * Where saves and settings go. 'memory' (default): gone when the process exits, so runs, tests,
   * and screenshots never depend on what an earlier session saved. 'files': `.shard/user` in the
   * project, kept across sessions (`shard serve`, `shard mcp`).
   */
  userData?: 'memory' | 'files'
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
  const files = createNodePlatform({ root })
  const platform =
    options.userData === 'files' ? files : { ...files, storage: createMemoryStorage() }
  const loaded = (await loadProject(platform)).manifest
  const manifest = options.seed === undefined ? loaded : { ...loaded, seed: options.seed }
  const { project, bundler } = await loadProjectCode(root, manifest, options.code ?? 'bundle')
  const generators = {
    root,
    namespace: manifest.name,
    entry: manifest.entry,
    workers: platform.workers,
    worker: options.generatorWorkers ?? true,
  }
  await prepareGenerators({ ...generators, graph: bundler?.last?.graph })
  const ownGpu = !options.gpu
  const gpu = options.gpu ?? (await createNodeGpuContext({ features: ['timestamp-query'] }))
  const target = new OffscreenTarget(gpu, {
    label: 'headless',
    width: options.width ?? manifest.window.width,
    height: options.height ?? manifest.window.height,
  })
  const app = buildApp({ manifest, project, gpu, target, platform })
  // Budgets (0075) for perf.budgets and features that adapt: the project's perf/, or the repo's.
  const budgets = loadPerfBudgets(root)
  if (budgets) app.insertResource(PerfBudgets, budgets as unknown as PerfBudgetsData)
  await app.init()
  await loadProjectNavCache(app, platform)
  const stopShaders = await loadProjectShaders(app, platform, { watch: options.watch })
  const assets = assetServer(app.world).configure({ platform, roots: manifest.assetRoots })
  const imports = await assets.scan()
  await loadProjectStrings(app)
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
      await prepareGenerators({ ...generators, graph: built.graph, background: true })
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
        void prepareGenerators({ ...generators, graph: result.graph, background: true })
          .then(() =>
            session.reload(() => import(bundler!.importUrl(result)), {
              hash: result.hash,
              ms: result.ms,
            }),
          )
          .catch((err) => session.buildFailed(err))
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
      stopShaders()
      stopCode()
      void bundler?.dispose()
      server.close()
      target.destroy()
      if (ownGpu) gpu.destroy()
      // The pool's threads hold the project's code; a closed project frees them.
      if (procgenHost().workers === platform.workers)
        configureProcgenHost({ workers: undefined, workerModule: undefined })
      platform.workers?.dispose()
    },
  }
}

/** Bundles (or imports) the project's entry: its default export, and the bundler if any. */
async function loadProjectCode(
  root: string,
  manifest: ManifestValue,
  code: 'bundle' | 'source',
): Promise<{ project: Plugin; bundler: Bundler | undefined }> {
  if (code === 'source')
    return { project: await importProjectPlugin(root, manifest), bundler: undefined }
  const bundler = await createBundler({ root, entry: manifest.entry })
  let built: BuiltBundle
  try {
    built = await bundler.build()
  } catch (err) {
    await bundler.dispose()
    throw err
  }
  return { project: await importBundle(built, manifest), bundler }
}

export interface HeadlessCodeOptions {
  root: string
  /** Overrides the manifest's `seed`. */
  seed?: number
  /** Default 'bundle'. */
  code?: 'bundle' | 'source'
}

/** A project's manifest and code, loaded once, for building GPU-less apps (0092). */
export interface HeadlessCode {
  root: string
  manifest: ManifestValue
  platform: Platform
  project: Plugin
  /** Builds an app without display plugins or a GPU, with `plugins` added; not initialized. */
  build(plugins?: readonly Plugin[]): App
  /** After `init`: scans assets and loads string tables, like `openProject` (no start scene). */
  prepare(app: App): Promise<void>
  close(): Promise<void>
}

/**
 * Loads a project for servers and headless clients (0092): no GPU, no render target, no start
 * scene. One load can build several apps (a server and its clients).
 */
export async function loadHeadlessCode(options: HeadlessCodeOptions): Promise<HeadlessCode> {
  const root = resolve(options.root)
  const files = createNodePlatform({ root })
  const platform = { ...files, storage: createMemoryStorage() }
  const loaded = (await loadProject(platform)).manifest
  const manifest = options.seed === undefined ? loaded : { ...loaded, seed: options.seed }
  const { project, bundler } = await loadProjectCode(root, manifest, options.code ?? 'bundle')
  await prepareGenerators({
    root,
    namespace: manifest.name,
    entry: manifest.entry,
    workers: platform.workers,
    worker: false,
    graph: bundler?.last?.graph,
  })
  return {
    root,
    manifest,
    platform,
    project,
    build(plugins = []) {
      const app = buildApp({ manifest, project, platform, display: false })
      for (const p of plugins) app.addPlugin(p)
      return app
    },
    async prepare(app) {
      await loadProjectNavCache(app, platform)
      await assetServer(app.world).configure({ platform, roots: manifest.assetRoots }).scan()
      await loadProjectStrings(app)
    },
    async close() {
      await bundler?.dispose()
      platform.workers?.dispose()
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
    // A file URL, or a path: `/home/…` on POSIX, `C:\…` or `C:/…` on Windows.
    const m = /(file:\/\/[^\s()]+|(?:[A-Za-z]:)?[\\/][^\s():]+):(\d+):(\d+)/.exec(line)
    if (!m) continue
    const file = m[1]!.startsWith('file:') ? fileURLToPath(m[1]!) : m[1]!
    const rel = relative(prefix, file).split('\\').join('/')
    if (rel.startsWith('../') || isAbsolute(rel)) continue
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
 * so determinism checks compare one string. `core/Derived` entities (rebuilt from other state, like
 * terrain chunks) are left out, and entity ids are numbered by rank among the rest, so a run that
 * spawns render-only chunks (a GPU) hashes like one that doesn't (headless).
 */
export function worldHash(world: World): string {
  const kept: Entity[] = []
  for (const table of world.allTables()) {
    if (table.has(Derived)) continue
    for (let row = 0; row < table.count; row++) kept.push(table.entities[row]!)
  }
  kept.sort((a, b) => a - b)
  const rank = new Map<number, number>()
  for (let i = 0; i < kept.length; i++) rank.set(kept[i]!, i)
  const id = (e: unknown) => (typeof e === 'number' && e >= 0 ? (rank.get(e) ?? -1) : e)
  const remap = (field: AnyField, value: unknown): unknown => {
    if (value === null || value === undefined) return value
    if (field.kind === 'entity') return id(value)
    if (field.kind === 'list' && field.item && Array.isArray(value))
      return value.map((v) => remap(field.item!, v))
    if (field.kind === 'struct' && field.fields && typeof value === 'object')
      return remapFields(field.fields, value as Record<string, unknown>)
    return value
  }
  const remapFields = (fields: Fields, value: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...value }
    for (const key in fields) if (key in out) out[key] = remap(fields[key]!, out[key])
    return out
  }
  const rows: string[] = []
  for (const table of world.allTables()) {
    if (table.has(Derived)) continue
    const components = table.components.filter((c) => c.serializable || c === ChildOf)
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      const values = components.map((c) => [
        c.name,
        remapFields(c.fields, c.serialize(table.readComponent(c, row)) as Record<string, unknown>),
      ])
      rows.push(JSON.stringify([rank.get(entity), values]))
    }
  }
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}

/** An engine package as installed: in the repository (source) or from npm (dist). */
export interface EnginePackage {
  /** `@aethervtt/shard-core` */
  name: string
  /** The package folder. */
  root: string
  /** Absolute path of its main entry: `src/index.ts` in the repository, `dist/index.js` published. */
  entry: string | undefined
  /** Where its code is: `src` in the repository, `dist` published. */
  code: string
}

/** The folder holding the nearest package.json at or above `path`. */
function packageRoot(path: string): string {
  let dir = path
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir)
    if (up === dir) return dirname(path)
    dir = up
  }
  return dir
}

interface PackageJson {
  name?: string
  exports?: Record<string, string | { default?: string }>
  dependencies?: Record<string, string>
}

const readJson = (file: string): PackageJson =>
  JSON.parse(readFileSync(file, 'utf8')) as PackageJson

/**
 * The installed `@aethervtt/shard-*` packages (0093): the repository's `packages/`, or a project's
 * dependencies from npm in any layout (hoisted or pnpm's). Found from this package's and `from`'s
 * dependencies, following each engine package's own, plus the core's siblings.
 */
export function enginePackages(from: readonly string[] = []): EnginePackage[] {
  const found = new Map<string, EnginePackage>()
  const add = (root: string): PackageJson | undefined => {
    const pkg = readJson(join(root, 'package.json'))
    if (!pkg.name?.startsWith('@aethervtt/shard-') || found.has(pkg.name)) return undefined
    const main = pkg.exports?.['.']
    const entry = typeof main === 'string' ? main : main?.default
    found.set(pkg.name, {
      name: pkg.name,
      root,
      entry: entry ? resolve(root, entry) : undefined,
      code: existsSync(join(root, 'src')) ? join(root, 'src') : join(root, 'dist'),
    })
    return pkg
  }
  const follow = (dir: string) => {
    const deps = existsSync(join(dir, 'package.json'))
      ? Object.keys(readJson(join(dir, 'package.json')).dependencies ?? {})
      : []
    const require = createRequire(join(dir, 'package.json'))
    for (const name of deps) {
      if (!name.startsWith('@aethervtt/shard-') || found.has(name)) continue
      let root: string
      try {
        root = packageRoot(dirname(require.resolve(name)))
      } catch {
        continue
      }
      if (add(root)) follow(root)
    }
  }
  const self = packageRoot(dirname(fileURLToPath(import.meta.url)))
  add(self)
  follow(self)
  for (const dir of from) follow(dir)
  // The repository's packages/ (or a hoisted node_modules/@aethervtt): every sibling of the core.
  const core = found.get('@aethervtt/shard-core')
  if (core) {
    const parent = dirname(core.root)
    for (const name of readdirSync(parent)) {
      const root = join(parent, name)
      if (existsSync(join(root, 'package.json')) && add(root)) follow(root)
    }
  }
  return [...found.values()]
}

/**
 * Error codes the engine can raise, scanned from the engine packages' code (with the hint written
 * next to each): their TypeScript in the repository, their JavaScript when installed from npm.
 * Feeds `.agents/errors.md`.
 */
export async function collectErrorCodes(from: readonly string[] = []): Promise<ErrorCode[]> {
  const found = new Map<string, ErrorCode>()
  for (const pkg of enginePackages(from)) {
    const files = await readdir(pkg.code, { recursive: true }).catch(() => [] as string[])
    for (const file of files) {
      if (
        !/\.(ts|js)$/.test(file) ||
        /\.(test|bench)\.(ts|js)$/.test(file) ||
        file.endsWith('.d.ts')
      )
        continue
      const text = await readFile(join(pkg.code, file), 'utf8')
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
            source: pkg.name,
            ...(hint && !hint.includes('${') ? { hint } : {}),
          })
        }
      }
    }
  }
  return [...found.values()]
}

export { type BuiltBundle, type Bundler, createBundler } from './bundle'
export {
  buildGeneratorWorker,
  type GeneratorWorkerBundle,
  generatorCodeHashes,
  type ModuleGraph,
  prepareGenerators,
  projectModuleGraph,
} from './generators'
