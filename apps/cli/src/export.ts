/**
 * `shard export --target web` (0110): a project as static files. Bakes and validates, keeps what
 * the game reaches, bundles engine and project with Vite (as `pnpm size` does), and lays the files
 * out under content-hashed names with a `build.json` that maps project paths to them.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { ShardError } from '@aethervtt/shard-core'
import { generatorCodeHashes, projectModuleGraph } from '@aethervtt/shard-node'
import type { BuildFile } from '@aethervtt/shard-platform'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  type BuildJson,
  enginePluginExport,
  enginePlugins,
  loadProject,
  type ManifestValue,
  resolvePlugins,
} from '@aethervtt/shard-project'
import { type InlineConfig, build as viteBuild } from 'vite'
import { packFiles } from './pack'

const here = dirname(fileURLToPath(import.meta.url))

/** A catalog source, as `.shard/catalog.json` stores it (the fields an export reads). */
export interface CatalogSource {
  path: string
  guid: string
  assets: {
    label: string
    type: string
    artifact: { json?: string; bytes?: string }
    dependencies?: string[]
  }[]
  error?: unknown
}

export interface Catalog {
  version: number
  cacheDir?: string
  sources: CatalogSource[]
}

export interface ExportReport {
  target: 'web' | 'server' | 'tauri'
  out: string
  build: string
  files: number
  /** `.shardpak` files the data went into; 0 when it shipped loose. */
  packs: number
  bytes: { raw: number; gzip: number; brotli: number }
  /** The page's code: the entry chunk and what loads later, brotli bytes. */
  code: { entry: number; lazy: number; worker: number; wasm: number }
  /** Every chunk and WASM file the page can load, largest first, with the packages in it. */
  chunks: {
    file: string
    kind: 'entry' | 'lazy' | 'worker' | 'wasm'
    brotli: number
    /** Rendered bytes (minified, before compression) per package, largest first. */
    packages: Record<string, number>
  }[]
  /** Shipped project files and why: `root` (a scene, prefab, include), or what referenced them. */
  included: { path: string; reason: string }[]
  /** Asset sources left out: nothing shipped references them. */
  excluded: string[]
  warnings: string[]
}

export interface ExportOptions {
  /** Project folder. */
  root: string
  /** What to build (0110, 0111). Default 'web'. */
  target?: 'web' | 'server' | 'tauri'
  /** The project calls `project.net`: the page joins a server or a room (0092). */
  multiplayer?: boolean
  /** Data in `.shardpak` files. Default `export.pack`, else true for a server, false for the web. */
  pack?: boolean
  /** Output folder, relative to the project. Default `dist/<target>`. */
  out?: string
  /** Stop after reachability and the plugin check; write nothing. */
  dryRun?: boolean
  sourcemap?: boolean
  /** Before bundling: translates the shipped scenes' shaders for WebGL2. Returns warnings. */
  prepareShaders?(scenes: readonly string[]): Promise<string[]>
  /**
   * Runs the built export headless to bake shader variants (0056): `bake(outDir, build)` returns
   * the bake, or undefined without a GPU. The CLI passes `bakeExportShaders`.
   */
  bake?(
    dataDir: string,
    build: BuildJson,
    scenes: readonly string[],
    codeDir: string,
  ): Promise<unknown | undefined>
  say?(message: string): void
}

/** `**` matches across folders, `*` within one, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const toPosix = (path: string) => path.split(sep).join('/')

/** Every file under `dir` (project-relative), skipping `.shard`, `node_modules`, `dist`. */
async function projectFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const path = dir ? `${dir}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.shard' || e.name === 'dist') continue
      if (e.name.startsWith('.')) continue
      out.push(...(await projectFiles(root, path)))
    } else out.push(path)
  }
  return out
}

/** Every string in a JSON value, and the component names under `components` objects. */
function walkJson(value: unknown, strings: Set<string>, components: Set<string>): void {
  if (typeof value === 'string') strings.add(value)
  else if (Array.isArray(value)) for (const v of value) walkJson(v, strings, components)
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'components' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const name of Object.keys(v)) components.add(name)
      }
      walkJson(v, strings, components)
    }
  }
}

/** String literals in source code: candidate asset paths a script loads. */
function literals(source: string): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(/(['"`])([^'"`\n\r]{3,300})\1/g)) out.add(m[2]!)
  return out
}

export interface Reach {
  sources: Map<string, CatalogSource>
  scenes: string[]
  /** Project path → why it ships. */
  reasons: Map<string, string>
  excluded: string[]
  /** Scenes and prefabs: component names, for the plugin check. */
  components: Map<string, Set<string>>
}

/**
 * What ships: every scene, prefab, string table, generator and project data asset, the files
 * `export.include` names, and everything those reference (strings equal to a source's path or
 * guid, in scenes, artifacts and scripts), following each asset's import dependencies.
 */
export async function reach(
  root: string,
  manifest: ManifestValue,
  catalog: Catalog,
): Promise<Reach> {
  const config = manifest.export
  const include = (config?.include ?? []).map(globToRegExp)
  const exclude = (config?.exclude ?? []).map(globToRegExp)
  const excluded = (path: string) => exclude.some((r) => r.test(path))
  const cacheDir = catalog.cacheDir ?? '.shard/cache'

  // A reference is a source's path or guid, with or without a sub-asset label.
  const byRef = new Map<string, CatalogSource>()
  for (const s of catalog.sources) {
    byRef.set(s.path, s)
    byRef.set(s.guid, s)
    for (const a of s.assets) {
      if (a.label === '') continue
      byRef.set(`${s.path}#${a.label}`, s)
      byRef.set(`${s.guid}/${a.label}`, s)
    }
  }

  const files = await projectFiles(root)
  const scenes = files.filter(
    (f) => (f.endsWith('.scene.json') || f === manifest.startScene) && !excluded(f),
  )
  const sources = new Map<string, CatalogSource>()
  const reasons = new Map<string, string>()
  const components = new Map<string, Set<string>>()
  const queue: CatalogSource[] = []
  const add = (s: CatalogSource | undefined, reason: string) => {
    if (!s || sources.has(s.path) || excluded(s.path)) return
    sources.set(s.path, s)
    reasons.set(s.path, reason)
    queue.push(s)
  }
  const refsIn = (strings: Iterable<string>, reason: string) => {
    for (const str of strings) add(byRef.get(str), reason)
  }

  for (const scene of scenes) {
    reasons.set(scene, 'root: scene')
    const strings = new Set<string>()
    const names = new Set<string>()
    walkJson(JSON.parse(await readFile(join(root, scene), 'utf8')), strings, names)
    components.set(scene, names)
    refsIn(strings, scene)
  }
  const always = new Set(['Prefab', 'StringTable', 'Generator'])
  for (const s of catalog.sources) {
    if (s.assets.some((a) => always.has(a.type) || a.type.startsWith(`${manifest.name}/`)))
      add(s, `root: ${s.assets[0]!.type}`)
    else if (include.some((r) => r.test(s.path))) add(s, 'root: export.include')
  }
  for (const f of files) {
    if (include.some((r) => r.test(f)) && !reasons.has(f) && !byRef.has(f) && !excluded(f)) {
      reasons.set(f, 'root: export.include')
    }
  }
  // Scripts: literal paths the code loads.
  const scriptsDir = toPosix(relative(root, dirname(resolve(root, manifest.entry))))
  for (const f of files) {
    if (!/\.(ts|tsx|js|mjs)$/.test(f) || (scriptsDir && !f.startsWith(`${scriptsDir}/`))) continue
    refsIn(literals(await readFile(join(root, f), 'utf8')), f)
  }

  while (queue.length > 0) {
    const s = queue.pop()!
    for (const a of s.assets) {
      for (const dep of a.dependencies ?? [])
        add(byRef.get(dep) ?? byRef.get(dep.split('#')[0]!), s.path)
      if (!a.artifact.json) continue
      const strings = new Set<string>()
      const names = new Set<string>()
      walkJson(
        JSON.parse(await readFile(join(root, cacheDir, a.artifact.json), 'utf8')),
        strings,
        names,
      )
      if (a.type === 'Prefab') components.set(s.path, names)
      refsIn(strings, s.path)
    }
  }

  return {
    sources,
    scenes,
    reasons,
    excluded: catalog.sources.map((s) => s.path).filter((p) => !sources.has(p)),
    components,
  }
}

/**
 * Fails when a scene or prefab uses a component whose plugin the manifest doesn't enable: the
 * export bundles only enabled plugins, so the component wouldn't exist (`export/plugin-missing`).
 */
export function checkPlugins(manifest: ManifestValue, components: Map<string, Set<string>>): void {
  const names = resolvePlugins(manifest)
  const errors: ShardError[] = []
  for (const [file, used] of components) {
    for (const component of used) {
      const namespace = component.split('/')[0]!
      const rows = enginePlugins.filter((p) => p.namespaces?.includes(namespace))
      if (rows.length === 0 || rows.some((p) => names.has(p.name))) continue
      errors.push(
        new ShardError(
          'export/plugin-missing',
          `${file} uses ${component}, but no plugin that brings it is enabled`,
          {
            path: file,
            hint: `Add ${rows.map((p) => `"${p.name}"`).join(' or ')} to plugins in shard.json.`,
          },
        ),
      )
    }
  }
  if (errors.length > 0) {
    throw new ShardError('export/plugin-missing', errors[0]!.message, {
      path: errors[0]!.path,
      hint: errors[0]!.hint,
      details: errors,
    })
  }
}

/** The engine plugin rows this project's export imports, as `import { … }` names in table order. */
function pluginImports(manifest: ManifestValue): string[] {
  const names = resolvePlugins(manifest)
  return enginePlugins
    .filter((p) => p.always || names.has(p.name))
    .map((p) => enginePluginExport(p.name))
}

function indexHtml(title: string): string {
  const escaped = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escaped}</title>
    <link rel="icon" href="data:," />
    <style>
      html, body { margin: 0; height: 100%; background: #05060a; color: #cfd6e4; font: 12px ui-monospace, monospace; }
      canvas { display: block; width: 100%; height: 100%; outline: none; }
      #status { position: fixed; left: 12px; bottom: 10px; padding: 6px 10px; border-radius: 6px; background: rgba(8, 10, 16, 0.72); white-space: pre-wrap; max-width: 70vw; }
      #status:empty { display: none; }
      #status.error { background: rgba(90, 16, 20, 0.9); }
      #room { position: fixed; left: 12px; top: 10px; padding: 6px 10px; border-radius: 6px; background: rgba(8, 10, 16, 0.72); }
      #room b { color: #ffd34d; letter-spacing: 0.08em; }
      #room a { color: #8fb4ff; }
    </style>
  </head>
  <body>
    <canvas id="viewport" tabindex="0"></canvas>
    <div id="status">loading…</div>
    <script type="module" src="./web.ts"></script>
  </body>
</html>
`
}

function webEntry(
  entry: string,
  rows: string[],
  audio: boolean,
  multiplayer: boolean,
  tauri = false,
): string {
  const plugins = `[${rows.join(', ')}]`
  // Multiplayer pages (0110): where to play, and the peer-to-peer host and join of `shard dev`.
  const net = multiplayer
    ? `
/**
 * Where to play: ?connect or ?lobby, then config.json (where "local" is the server bundled with a
 * desktop app, 0111), then this page's own server if it has one.
 */
async function netTarget(platform: Platform): Promise<{ url?: string; lobby?: string }> {
  const json = async (path: string) => {
    try {
      const res = await fetch(new URL(path, document.baseURI))
      return res.ok ? await res.json() : undefined
    } catch {
      return undefined
    }
  }
  const config = (await json('config.json'))?.net ?? {}
  const url = params.get('connect') ?? config.url
  const lobby = params.get('lobby') ?? config.lobby
  // "local" is this build's own server: a desktop app's sidecar, or on the web the server that
  // serves the page (found below), so one setting fits both.
  if (url === 'local' && platform.localServer) {
    return { url: (await platform.localServer.start()).url, lobby }
  }
  if ((url && url !== 'local') || lobby) return { url: url === 'local' ? undefined : url, lobby }
${
  tauri
    ? '  // A desktop app has no origin to ask (0111): alone, unless configured.\n  return {}'
    : `  // Served by its game server (shard export --target server --static): play there.
  if (!(await json('healthz'))?.build) return {}
  const own = new URL('net', document.baseURI)
  own.protocol = own.protocol === 'https:' ? 'wss:' : 'ws:'
  return { url: own.href }`
}
}

function showRoom(code: string, mode: 'hosting' | 'joined') {
  const badge = document.createElement('div')
  badge.id = 'room'
  const link = new URL(location.href)
  link.searchParams.delete('host')
  link.searchParams.set('join', code)
  badge.innerHTML =
    mode === 'hosting'
      ? \`Hosting room <b>\${code}</b> · <a href="\${link.href}" target="_blank">join link</a>\`
      : \`Room <b>\${code}</b>\`
  document.body.append(badge)
  ;(globalThis as { shardRoom?: object }).shardRoom = { code, mode }
}

async function joinGame(app: App, build: BuildJson, platform: Platform) {
  const net = projectNet(project)!
  const target = await netTarget(platform)
  const join = params.get('join')
  if (params.has('host') || join) {
    if (!target.lobby) {
      throw new ShardError('net/no-lobby', '?host and ?join need a lobby', {
        hint: 'Add ?lobby=<url>, or set export.net.lobby in shard.json (written to config.json).',
      })
    }
    const session = webRtcLobby({ url: target.lobby })
    if (join) {
      app.addPlugin(netPlugin({ ...net, role: 'client', session, code: join }))
      showRoom(join, 'joined')
      return
    }
    // The game's server runs in this page next to the player's own client (0091).
    const host = await startHost({
      net: { ...net, meta: { project: build.project.name } },
      session,
      createApp: () => exportServerApp(build, ${plugins}, project, platform),
      afterInit: (server) => prepareExportApp(server, platform, build),
    })
    addEventListener('pagehide', () => void host.stop())
    app.addPlugin(netPlugin({ ...net, role: 'client', ...host.local }))
    showRoom(host.code, 'hosting')
  } else if (target.url) {
    app.addPlugin(
      netPlugin({ ...net, role: 'client', transport: webSocketTransport(), address: target.url }),
    )
  }
}
`
    : ''
  return `// Generated by shard export (0110).
${
  multiplayer
    ? `import { ShardError } from '@aethervtt/shard-core'
import { netPlugin, startHost } from '@aethervtt/shard-net'
import { webRtcLobby } from '@aethervtt/shard-net-webrtc'
import { webSocketTransport } from '@aethervtt/shard-net-websocket'
import type { Platform } from '@aethervtt/shard-platform'
`
    : ''
}import { createDomInputSource${tauri ? '' : ', createWebPlatform'} } from '@aethervtt/shard-platform-web'${
    tauri
      ? "\nimport { createTauriGamePlatform, shardBase } from '@aethervtt/shard-platform-tauri/game'"
      : ''
  }
import {
  type BuildJson,
  ${multiplayer ? 'exportServerApp,\n  prepareExportApp,\n  projectNet,\n  ' : ''}startExport,
} from '@aethervtt/shard-project/export'
import { ${rows.join(', ')} } from '@aethervtt/shard-project/plugins'
import { ${multiplayer ? 'type App, ' : ''}animationFrameRunner } from '@aethervtt/shard-runtime'
import project from ${JSON.stringify(entry)}

const canvas = document.getElementById('viewport') as HTMLCanvasElement
const status = document.getElementById('status') as HTMLElement
// ?backend=webgpu|webgl2 insists on a graphics API, ?tier=baseline runs the baseline tier (0064).
const params = new URLSearchParams(location.search)
const backend = params.get('backend')
${net}
async function main() {
${
  tauri
    ? `  // The data is the app's resources, served by tauri-plugin-shard (0111).
  const base = await shardBase()
  const build = (await (await fetch(new URL('build.json', base))).json()) as BuildJson
  const platform = createTauriGamePlatform({ base, files: build.files, packs: build.packs })`
    : `  const build = (await (await fetch(new URL('build.json', document.baseURI))).json()) as BuildJson
  const platform = createWebPlatform({
    files: build.files,
    packs: build.packs,
    storageName: \`shard:\${build.project.name}\`,
  })`
}
  const { app } = await startExport({
    build,
    platform,
    plugins: ${plugins},
    project,
    canvas,
    backend: backend === 'webgpu' || backend === 'webgl2' ? backend : 'auto',
    tier: params.get('tier') === 'baseline' ? 'baseline' : undefined,
    inputSource: createDomInputSource(canvas),
    audio: ${audio ? 'platform.audio' : 'undefined'},
    procgenWorker: build.workers.procgen && new URL(build.workers.procgen, document.baseURI).href,${multiplayer ? '\n    configure: (a) => joinGame(a, build, platform),' : ''}
  })
  status.textContent = ''
  canvas.focus()
  app.markUsable()
  app.setRunner(animationFrameRunner())
  await app.run()
}

main().catch((err: unknown) => {
  const e = err as { code?: string; message?: string }
  status.textContent = e?.code ? \`\${e.code}: \${e.message}\` : String(err)
  status.classList.add('error')
  console.error(err)
})
`
}

function procgenWorkerEntry(entry: string): string {
  return `// Generated by shard export (0110): generator jobs on the worker pool, with the project's code.
import ${JSON.stringify(entry)}
export { runGeneratorJob, warmUp } from '@aethervtt/shard-procgen/worker'
`
}

function serverEntry(entry: string, rows: string[]): string {
  // Every row the page imports, so components of display plugins still exist as data (a prefab
  // naming sprite/Sprite loads); serveExport adds only the ones a server runs.
  return `// Generated by shard export (0110): the game's dedicated server. Flags: --port, --host, --data,
// --static, --json (or PORT, HOST, SHARD_DATA, SHARD_STATIC).
import { fileURLToPath } from 'node:url'
import { serverMain } from '@aethervtt/shard-node/serve'
import { ${rows.join(', ')} } from '@aethervtt/shard-project/plugins'
import project from ${JSON.stringify(entry)}

await serverMain({
  dir: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [${rows.join(', ')}],
  project,
})
`
}

const DOCKERFILE = `# Generated by shard export (0110). docker build -t game . && docker run -p 7000:7000 game
FROM node:22-slim
WORKDIR /game
COPY . .
ENV HOST=0.0.0.0 PORT=7000 SHARD_DATA=/game/data
EXPOSE 7000
CMD ["node", "server.mjs"]
`

function headlessEntry(entry: string, rows: string[]): string {
  return `// Generated by shard export (0110): what \`shard run --build\` and the shader bake run.
import { worldHashRows } from '@aethervtt/shard-core'
import { createGpuContext } from '@aethervtt/shard-gpu'
import type { Platform } from '@aethervtt/shard-platform'
import { type BuildJson, startExport } from '@aethervtt/shard-project/export'
import { ${rows.join(', ')} } from '@aethervtt/shard-project/plugins'
import { Gpu, OffscreenTarget, Shaders } from '@aethervtt/shard-render'
import { loadScene, unloadScene, whenSceneReady } from '@aethervtt/shard-scene'
import project from ${JSON.stringify(entry)}

export async function boot(options: {
  gpu: GPU
  platform: Platform
  build: BuildJson
  seed?: number
  startScene?: boolean
  procgenWorker?: string
  /** 'baseline': a compatibility-mode device, as WebGL2 and older GPUs run (0064). */
  tier?: 'baseline'
}) {
  const gpu = await createGpuContext({
    gpu: options.gpu,
    features: ['timestamp-query'],
    tier: options.tier,
  })
  const { width, height } = options.build.manifest.window
  const target = new OffscreenTarget(gpu, { label: 'headless', width, height })
  const { app } = await startExport({
    build: options.build,
    platform: options.platform,
    plugins: [${rows.join(', ')}],
    project,
    gpu,
    target,
    seed: options.seed,
    startScene: options.startScene,
    procgenWorker: options.procgenWorker,
  })
  return {
    frames(count: number) {
      for (let i = 0; i < count; i++) app.update(1 / app.fixedHz)
    },
    /** Frames that wait for shaders and pipelines to compile, so every variant is linked. */
    async settle(count: number) {
      for (let i = 0; i < count; i++) {
        app.update(1 / app.fixedHz)
        await app.world.tryResource(Shaders)?.whenIdle()
        await app.world.tryResource(Gpu)?.pipelines.whenIdle()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    entities: () => app.world.entityCount,
    hashRows: () => worldHashRows(app.world),
    async loadScene(path: string) {
      loadScene(app.world, JSON.parse(await options.platform.fs.readText(path)), { id: path })
      await whenSceneReady(app.world, path)
    },
    unloadScene: (path: string) => unloadScene(app.world, path),
    shaderBake: () => app.world.tryResource(Shaders)?.bake(),
    dispose() {
      target.destroy()
      gpu.destroy()
    },
  }
}
`
}

/** Resolves the generated entries' engine imports from the CLI's own dependencies. */
function engineResolver(generated: string) {
  const from = join(here, 'main.ts')
  return {
    name: 'shard-export-engine',
    enforce: 'pre' as const,
    async resolveId(
      this: { resolve(id: string, importer?: string, o?: object): Promise<unknown> },
      id: string,
      importer: string | undefined,
    ) {
      if (!importer?.startsWith(generated) || !id.startsWith('@aethervtt/')) return undefined
      return this.resolve(id, from, { skipSelf: true })
    },
  }
}

export interface BundleOutput {
  type: 'chunk' | 'asset'
  fileName: string
  name?: string
  isEntry?: boolean
  code: string
  source?: string | Uint8Array
  imports?: string[]
  dynamicImports?: string[]
  modules?: Record<string, { renderedLength: number }>
}

/**
 * What the page loads: `entry` is the entry chunk and everything it imports statically (loaded at
 * startup), `lazy` what it reaches through `import()`, `wasm` the binaries reachable code names.
 * Undefined for files only the headless module reaches.
 */
function pageKinds(outputs: readonly BundleOutput[]): Map<string, 'entry' | 'lazy' | 'wasm'> {
  const byFile = new Map(outputs.map((o) => [o.fileName, o]))
  const kinds = new Map<string, 'entry' | 'lazy' | 'wasm'>()
  const page = outputs.find((o) => o.type === 'chunk' && o.isEntry && o.name !== 'headless')
  const walk = (file: string, kind: 'entry' | 'lazy') => {
    if (kinds.has(file)) return
    const o = byFile.get(file)
    if (o?.type !== 'chunk') return
    kinds.set(file, kind)
    for (const i of o.imports ?? []) walk(i, kind)
    for (const i of o.dynamicImports ?? []) walk(i, 'lazy')
  }
  // Static imports first, so a chunk the entry needs counts as entry even if also lazy.
  const statics = (file: string) => {
    if (kinds.has(file)) return
    kinds.set(file, 'entry')
    for (const i of byFile.get(file)?.imports ?? []) statics(i)
  }
  if (page) {
    statics(page.fileName)
    for (const [file] of [...kinds])
      for (const i of byFile.get(file)?.dynamicImports ?? []) walk(i, 'lazy')
  }
  const code = [...kinds.keys()].map((f) => byFile.get(f)!.code).join('\n')
  for (const o of outputs) {
    if (
      o.type === 'asset' &&
      !o.fileName.endsWith('.html') &&
      code.includes(o.fileName.split('/').pop()!)
    ) {
      kinds.set(o.fileName, o.fileName.endsWith('.wasm') ? 'wasm' : 'lazy')
    }
  }
  return kinds
}

/** The package a module belongs to: an engine package by folder, an npm package, or the project. */
function packageOf(id: string): string {
  const path = id.replace(/^\0/, '').split('?')[0]!.replace(/\\/g, '/')
  const npm = path.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/)
  if (npm) return npm[1]!
  const engine = path.match(/\/packages\/([^/]+)\/(?:src|dist|wasm|vendor)\//)
  return engine ? `@aethervtt/shard-${engine[1]}` : 'project'
}

/**
 * Fails when the bundle holds one engine package from two folders: the CLI and the project
 * resolved different installs (two versions), so the game would run with two engines.
 */
export function checkOneEngine(outputs: readonly BundleOutput[]): void {
  const roots = new Map<string, Set<string>>()
  for (const o of outputs) {
    for (const id of Object.keys(o.modules ?? {})) {
      const path = id.replace(/^\0/, '').split('?')[0]!.replace(/\\/g, '/')
      const m =
        path.match(/^(.*\/node_modules\/@aethervtt\/(shard-[^/]+))\//) ??
        path.match(/^(.*\/packages\/([^/]+))\/(?:src|dist|wasm|vendor)\//)
      if (!m) continue
      const name = m[2]!.startsWith('shard-') ? m[2]! : `shard-${m[2]}`
      const set = roots.get(name) ?? new Set<string>()
      set.add(m[1]!)
      roots.set(name, set)
    }
  }
  for (const [name, set] of roots) {
    if (set.size < 2) continue
    throw new ShardError('export/two-engines', `@aethervtt/${name} is bundled from two installs`, {
      path: [...set].join(', '),
      hint: 'Install the same engine version as @aethervtt/shard-cli (one version of every @aethervtt/shard-* package).',
    })
  }
}

/** Rendered bytes per package in a chunk, largest first. */
function chunkPackages(o: BundleOutput): Record<string, number> {
  const sizes = new Map<string, number>()
  for (const [id, m] of Object.entries(o.modules ?? {})) {
    if (m.renderedLength === 0) continue
    const pkg = packageOf(id)
    sizes.set(pkg, (sizes.get(pkg) ?? 0) + m.renderedLength)
  }
  return Object.fromEntries([...sizes].sort((a, b) => b[1] - a[1]))
}

/**
 * Server builds: Vite leaves `new URL('./x', import.meta.url)` alone in SSR, so the WASM and worker
 * modules engine packages name that way would point nowhere. Emits each one (a module as its own
 * chunk, anything else as an asset) and points the URL at it, as the page build does.
 */
function serverFileUrls() {
  const pattern = /new URL\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g
  return {
    name: 'shard-export-file-urls',
    async transform(
      this: {
        resolve(id: string, importer: string): Promise<{ id: string } | null>
        emitFile(
          file: { type: 'chunk'; id: string } | { type: 'asset'; name: string; source: Uint8Array },
        ): string
      },
      code: string,
      id: string,
    ) {
      if (!code.includes('import.meta.url') || id.startsWith('\0')) return undefined
      let out = code
      for (const m of code.matchAll(pattern)) {
        const spec = m[2]!
        let ref: string
        if (/\.[mc]?[jt]s$/.test(spec)) {
          const resolved = await this.resolve(spec, id)
          if (!resolved) continue
          ref = this.emitFile({ type: 'chunk', id: resolved.id })
        } else {
          const file = resolve(dirname(id.split('?')[0]!), spec)
          if (!existsSync(file)) continue
          ref = this.emitFile({ type: 'asset', name: basename(file), source: await readFile(file) })
        }
        out = out.replace(m[0], `new URL("__shard_file_${ref}__", import.meta.url)`)
      }
      return out === code ? undefined : { code: out, map: null }
    },
    // Each placeholder becomes the emitted file's path relative to the chunk that names it.
    renderChunk(
      this: { getFileName(ref: string): string },
      code: string,
      chunk: { fileName: string },
    ) {
      if (!code.includes('__shard_file_')) return undefined
      const from = dirname(chunk.fileName)
      return code.replace(/__shard_file_([\w$-]+)__/g, (_, ref: string) => {
        const path = relative(from, this.getFileName(ref)).split(sep).join('/')
        return path.startsWith('.') ? path : `./${path}`
      })
    },
  }
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

function compress(bytes: Uint8Array) {
  return {
    gzip: gzipSync(bytes, { level: 9 }),
    brotli: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  }
}

/**
 * Writes `bytes` to `out/path`, with `.br` and `.gz` copies when they're smaller and `served` (a
 * server reads its own files from disk and needs none).
 */
async function writeShipped(
  out: string,
  path: string,
  bytes: Uint8Array,
  totals: ExportReport['bytes'],
  served = true,
): Promise<{ brotli: number }> {
  const file = join(out, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  totals.raw += bytes.length
  if (bytes.length < 1024) {
    totals.gzip += bytes.length
    totals.brotli += bytes.length
    return { brotli: bytes.length }
  }
  const { gzip, brotli } = compress(bytes)
  const keep = (c: Uint8Array) => served && c.length < bytes.length * 0.9
  if (keep(gzip)) await writeFile(`${file}.gz`, gzip)
  if (keep(brotli)) await writeFile(`${file}.br`, brotli)
  totals.gzip += Math.min(gzip.length, bytes.length)
  totals.brotli += Math.min(brotli.length, bytes.length)
  return { brotli: Math.min(brotli.length, bytes.length) }
}

/** `shard export --target web|server`. */
export async function exportBuild(options: ExportOptions): Promise<ExportReport> {
  const root = resolve(options.root)
  const target = options.target ?? 'web'
  const say = options.say ?? (() => {})
  const platform = createNodePlatform({ root })
  const { manifest } = await loadProject(platform)
  const outRel = options.out ?? `dist/${target}`
  const out = resolve(root, outRel)
  const warnings: string[] = []
  // The export replaces `out`: never the project or a folder holding it, never someone's files.
  const inside = relative(out, root)
  if (!inside.startsWith('..') && !isAbsolute(inside)) {
    throw new ShardError('export/bad-out', `--out ${outRel} would hold the project itself`, {
      hint: 'Export to a folder of its own, such as dist/web.',
    })
  }
  const existing = await readdir(out).catch(() => [] as string[])
  // An earlier export: build.json at its top, or in data/ for a desktop app's (0111).
  const earlier = existing.includes('build.json') || existsSync(join(out, 'data/build.json'))
  if (existing.length > 0 && !earlier) {
    throw new ShardError('export/bad-out', `${outRel} isn't empty and isn't an export`, {
      path: outRel,
      hint: 'Pass an empty folder, or one an earlier `shard export` wrote; it is replaced.',
    })
  }

  // A page is the web build. A desktop app's splits in two (0111): the page, compiled into the app
  // (frontendDist), and its data, beside it on disk (resources) and read by range.
  const hasPage = target !== 'server'
  const pageOut = target === 'tauri' ? join(out, 'page') : out
  const dataOut = target === 'tauri' ? join(out, 'data') : out
  // Pre-compressed copies are for web hosts; an app and a server read their own disk.
  const served = target === 'web'

  const catalogPath = join(root, '.shard/catalog.json')
  if (!existsSync(catalogPath)) {
    throw new ShardError('export/not-imported', 'The project has no asset catalog', {
      hint: 'Run `shard import` first.',
    })
  }
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Catalog
  const failed = catalog.sources.filter((s) => s.error)
  if (failed.length > 0) {
    throw new ShardError('export/validate-failed', `${failed.length} asset(s) failed to import`, {
      path: failed[0]!.path,
      hint: 'Run `shard validate` and fix every error first.',
    })
  }
  const reached = await reach(root, manifest, catalog)
  checkPlugins(manifest, reached.components)
  const included = [...reached.reasons].map(([path, reason]) => ({ path, reason }))
  included.sort((a, b) => a.path.localeCompare(b.path))
  if (options.dryRun) {
    return {
      target,
      out: outRel,
      build: '',
      files: 0,
      packs: 0,
      bytes: { raw: 0, gzip: 0, brotli: 0 },
      code: { entry: 0, lazy: 0, worker: 0, wasm: 0 },
      chunks: [],
      included,
      excluded: reached.excluded,
      warnings,
    }
  }

  // Nothing to translate or bake in a project that doesn't draw (an audio tool), or for a server.
  const draws = hasPage && resolvePlugins(manifest).has('render')
  if (draws && options.prepareShaders) {
    warnings.push(...(await options.prepareShaders(reached.scenes)))
  }

  // Code: the page, the headless entry and the procgen worker, or the server, from generated
  // sources.
  say('Bundling…')
  // Its own folder, so two exports of one project (parallel test runs) don't share sources.
  await mkdir(join(root, '.shard/export'), { recursive: true })
  const generated = await mkdtemp(join(root, '.shard/export/web-'))
  try {
    const entry = resolve(root, manifest.entry)
    const rows = pluginImports(manifest)
    const audio = [...resolvePlugins(manifest)].some((n) => n === 'audio' || n.startsWith('audio/'))
    if (hasPage) {
      await writeFile(
        join(generated, 'index.html'),
        // An unset title deserializes as ''.
        indexHtml(manifest.export?.app?.title || manifest.name),
      )
      await writeFile(
        join(generated, 'web.ts'),
        webEntry(toPosix(entry), rows, audio, options.multiplayer ?? false, target === 'tauri'),
      )
      await writeFile(join(generated, 'headless.ts'), headlessEntry(toPosix(entry), rows))
      await writeFile(join(generated, 'procgen-worker.ts'), procgenWorkerEntry(toPosix(entry)))
    } else {
      await writeFile(join(generated, 'server.ts'), serverEntry(toPosix(entry), rows))
    }
    await rm(out, { recursive: true, force: true })
    const vite = async (config: InlineConfig) => {
      const result = await viteBuild({
        root: generated,
        configFile: false,
        logLevel: 'silent',
        base: './',
        plugins: [engineResolver(generated)],
        ...config,
        build: {
          outDir: pageOut,
          write: false,
          minify: true,
          sourcemap: options.sourcemap ?? false,
          reportCompressedSize: false,
          chunkSizeWarningLimit: Number.POSITIVE_INFINITY,
          ...config.build,
        },
      }).catch((cause: unknown) => {
        throw new ShardError(
          'export/bundle-failed',
          `Couldn't bundle the export: ${(cause as Error).message}`,
          { cause },
        )
      })
      return (Array.isArray(result) ? result : [result]).flatMap(
        (r) => (r as { output: BundleOutput[] }).output,
      )
    }
    const page = (input: Record<string, string>, treeshake?: object) =>
      vite({
        worker: { format: 'es' },
        build: {
          target: 'es2023',
          // Vite's preload helper reads `document`, which the headless entry (the shader bake,
          // `shard run --build`) doesn't have when a lazy chunk loads.
          modulePreload: false,
          rolldownOptions: { input, preserveEntrySignatures: 'exports-only', treeshake },
        },
      })
    const outputs = hasPage
      ? await page({
          index: join(generated, 'index.html'),
          headless: join(generated, 'headless.ts'),
        })
      : // Everything inlined, so `node server.mjs` runs with nothing installed.
        await vite({
          plugins: [engineResolver(generated), serverFileUrls()],
          ssr: { noExternal: true, target: 'node' },
          build: {
            ssr: join(generated, 'server.ts'),
            // The WASM serverFileUrls emits: SSR builds drop assets otherwise.
            ssrEmitAssets: true,
            target: 'node22',
            rolldownOptions: {
              // ws's optional native speedups: it runs without them.
              external: [/^node:/, ...builtinModules, 'bufferutil', 'utf-8-validate'],
              output: {
                entryFileNames: 'server.mjs',
                chunkFileNames: 'server/[name]-[hash].mjs',
                assetFileNames: 'server/[name]-[hash][extname]',
              },
            },
          },
        })
    checkOneEngine(outputs)
    // Its own build: a worker runs no plugins, so their `provides` can't keep the definitions a job
    // loads alive; every module the worker imports is kept, as `shard dev`'s worker bundle does.
    const workerOutputs = hasPage
      ? await page(
          { 'procgen-worker': join(generated, 'procgen-worker.ts') },
          { moduleSideEffects: true },
        )
      : []

    // Code: chunks, workers and WASM as Vite named them; their sizes; their hashes for the build id.
    say('Writing files…')
    const totals = { raw: 0, gzip: 0, brotli: 0 }
    const code = { entry: 0, lazy: 0, worker: 0, wasm: 0 }
    const chunks: ExportReport['chunks'] = []
    const buildHash = createHash('sha256')
    let entryFile = ''
    let headlessFile = ''
    let workerFile = ''
    const kinds: Map<string, ExportReport['chunks'][number]['kind']> = hasPage
      ? pageKinds(outputs)
      : new Map(outputs.map((o) => [o.fileName, o.fileName.endsWith('.wasm') ? 'wasm' : 'entry']))
    for (const o of workerOutputs) {
      if (o.type === 'chunk' && o.isEntry) workerFile = o.fileName
      kinds.set(o.fileName, o.fileName.endsWith('.wasm') ? 'wasm' : 'worker')
    }
    const seen = new Set<string>()
    for (const o of [...outputs, ...workerOutputs]) {
      // The worker build emits some of the page build's files again (WASM): same name, same bytes.
      if (seen.has(o.fileName)) continue
      seen.add(o.fileName)
      const bytes =
        o.type === 'chunk' || typeof o.source === 'string'
          ? new TextEncoder().encode(o.type === 'chunk' ? o.code : (o.source as string))
          : o.source!
      buildHash.update(`${o.fileName}\n${sha256(bytes)}\n`)
      const { brotli } = await writeShipped(pageOut, o.fileName, bytes, totals, served)
      if (o.type === 'chunk' && o.isEntry) {
        if (o.name === 'headless') headlessFile = o.fileName
        else entryFile = o.fileName
      }
      const kind = kinds.get(o.fileName)
      if (!kind) continue
      code[kind] += brotli
      chunks.push({
        file: o.fileName,
        kind,
        brotli,
        packages: o.type === 'chunk' ? chunkPackages(o) : {},
      })
    }
    chunks.sort((a, b) => b.brotli - a.brotli)
    if (hasPage) {
      // Node reads the chunks as ES modules (`shard run --build`, the shader bake).
      await writeFile(join(pageOut, 'package.json'), '{ "type": "module", "private": true }\n')
      // Where the page plays, editable after export: one build, many deployments. Written even
      // empty, so a page without one doesn't log a 404 asking for it.
      if (options.multiplayer) {
        const { url, lobby } = manifest.export?.net ?? {}
        const net = { ...(url ? { url } : {}), ...(lobby ? { lobby } : {}) }
        await writeFile(join(pageOut, 'config.json'), `${JSON.stringify({ net }, null, 2)}\n`)
      }
    } else {
      const pkg = {
        name: `${manifest.name}-server`,
        version: manifest.version,
        private: true,
        type: 'module',
        engines: { node: '>=22' },
        scripts: { start: 'node server.mjs' },
      }
      await writeFile(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
      await writeFile(join(out, 'Dockerfile'), DOCKERFILE)
    }

    // Data: the trimmed catalog, scenes, artifacts, caches, project shaders.
    const files: Record<string, BuildFile> = {}
    const written = new Set<string>()
    // Packed (--pack, export.pack; servers by default): collected here, written before the bake.
    const setting = manifest.export?.pack ?? 'auto'
    const pack = options.pack ?? (setting === 'auto' ? target !== 'web' : setting === 'always')
    const toPack = new Map<string, Uint8Array>()
    const loose = async (path: string, bytes: Uint8Array) => {
      const hash = sha256(bytes)
      const url = `f/${hash.slice(0, 20)}${extname(path) || '.bin'}`
      if (!written.has(url)) await writeShipped(dataOut, url, bytes, totals, served)
      written.add(url)
      files[path] = { url, size: bytes.length, hash }
    }
    // The WebGL2 translations stay loose: the page hands the renderer their URL, so a WebGPU
    // session never downloads them, and a packed file has no URL.
    const ship = async (path: string, bytes: Uint8Array) =>
      pack && path !== '.shard/shaders/webgl2.json'
        ? void toPack.set(path, bytes)
        : loose(path, bytes)
    const cacheDir = catalog.cacheDir ?? '.shard/cache'
    const shippedSources = catalog.sources.filter((s) => reached.sources.has(s.path))
    const trimmed = { version: catalog.version, cacheDir, sources: shippedSources }
    await ship('.shard/catalog.json', new TextEncoder().encode(JSON.stringify(trimmed)))
    for (const s of shippedSources) {
      for (const a of s.assets) {
        for (const artifact of [a.artifact.json, a.artifact.bytes]) {
          if (artifact)
            await ship(`${cacheDir}/${artifact}`, await readFile(join(root, cacheDir, artifact)))
        }
      }
      // Heightfield terrains (0071) read their baked packs by path.
      const packs = `${cacheDir}/terrain/${s.guid.replace(/[^a-zA-Z0-9._-]/g, '-')}`
      for (const f of await projectFiles(root, packs).catch(() => [])) {
        await ship(f, await readFile(join(root, f)))
      }
    }
    for (const [path, reason] of reached.reasons) {
      if (reached.sources.has(path)) continue
      if (reason.startsWith('root')) await ship(path, await readFile(join(root, path)))
    }
    const nav = `${cacheDir}/nav/tiles.bin`
    if (existsSync(join(root, nav))) await ship(nav, await readFile(join(root, nav)))
    const shaders: BuildJson['shaders'] = {}
    const webgl2 = '.shard/shaders/webgl2.json'
    if (existsSync(join(root, webgl2))) {
      await ship(webgl2, await readFile(join(root, webgl2)))
      shaders.webgl2 = webgl2
    } else if (draws) {
      warnings.push('export/no-webgl2-bake: run `shard shaders bake` so WebGL2 needs no naga')
    }
    const projectShaders = (await projectFiles(root, 'shaders')).filter((f) =>
      /\.(wesl|wgsl)$/.test(f),
    )
    if (projectShaders.length > 0) {
      const list = await Promise.all(
        projectShaders.map(async (file) => ({
          file,
          source: await readFile(join(root, file), 'utf8'),
        })),
      )
      shaders.project = '.shard/export/project-shaders.json'
      await ship(shaders.project, new TextEncoder().encode(JSON.stringify(list)))
    }

    const packs: string[] = []
    if (toPack.size > 0) {
      const packed = packFiles(toPack)
      for (const bytes of packed.packs) {
        const url = `f/${sha256(bytes).slice(0, 20)}.shardpak`
        // Read by range: no .br/.gz copies (a compressed response has no byte ranges).
        await writeShipped(dataOut, url, bytes, totals, false)
        packs.push(url)
      }
      Object.assign(files, packed.entries)
    }

    const graph = await projectModuleGraph(root, manifest.entry)
    const { export: _export, ...shippedManifest } = manifest
    const build: BuildJson = {
      version: 1,
      build: '',
      engine: manifest.engine,
      project: { name: manifest.name, version: manifest.version },
      manifest: shippedManifest as ManifestValue,
      entry: hasPage ? entryFile : 'server.mjs',
      headless: headlessFile,
      generators: await generatorCodeHashes(root, manifest.name, manifest.entry, graph),
      workers: { procgen: workerFile },
      shaders,
      ...(packs.length > 0 ? { packs } : {}),
      files,
    }

    // The shader bake runs the export itself: what it links is what the page would.
    const frames = manifest.export?.bakeFrames ?? 60
    if (draws && frames > 0 && options.bake) {
      say('Baking shaders…')
      const bake = await options.bake(dataOut, build, reached.scenes, pageOut)
      if (bake) {
        shaders.bake = '.shard/export/shaders.bake.json'
        // Made after the packs were written: it ships loose.
        await loose(shaders.bake, new TextEncoder().encode(JSON.stringify(bake)))
      } else warnings.push('export/no-shader-bake: no GPU adapter; WESL loads at run time')
    }

    for (const path of Object.keys(files).sort())
      buildHash.update(`${path}\n${files[path]!.hash}\n`)
    build.build = buildHash.digest('hex').slice(0, 20)
    await writeFile(join(dataOut, 'build.json'), `${JSON.stringify(build)}\n`)

    return {
      target,
      out: outRel,
      build: build.build,
      files: Object.keys(files).length,
      packs: packs.length,
      bytes: totals,
      code,
      chunks,
      included,
      excluded: reached.excluded,
      warnings,
    }
  } finally {
    await rm(generated, { recursive: true, force: true })
  }
}
