import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@shard/assets'
import { beginRedefinition, endRedefinition, type ShardError, World } from '@shard/core'
import { type BuiltBundle, createBundler } from '@shard/node'
import { createNodePlatform } from '@shard/platform-node'
import { loadProject } from '@shard/project'
import { DEFAULT_HUB_PORT } from '@shard/protocol'
import { createServer, type ViteDevServer, type Plugin as VitePlugin } from 'vite'
import type { CommandContext } from './commands'
import { EXIT } from './output'

const here = dirname(fileURLToPath(import.meta.url))
const runnerDir = resolve(here, '../runner')

/** Every shader file under the project's `shaders/`, with its source. */
function projectShaders(root: string): { file: string; source: string }[] {
  const dir = join(root, 'shaders')
  if (!existsSync(dir)) return []
  const out: { file: string; source: string }[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(wesl|wgsl)$/.test(entry.name)) {
        out.push({
          file: relative(root, full).split(sep).join('/'),
          source: readFileSync(full, 'utf8'),
        })
      }
    }
  }
  walk(dir)
  return out
}

/** The engine's packages folder, found through `@shard/core`'s location. */
function packagesDir(): string {
  const require = createRequire(import.meta.url)
  // @shard/core resolves to packages/core/src/index.ts.
  return dirname(dirname(dirname(require.resolve('@shard/core'))))
}

/**
 * An import map pointing every `@shard/<pkg>` at the URL Vite serves that package's entry from, so
 * the project bundle (which leaves `@shard/*` external) shares the page's module instances.
 */
function engineImportMap(): Record<string, string> {
  const dir = packagesDir()
  const imports: Record<string, string> = {}
  for (const name of readdirSync(dir)) {
    const pkgFile = join(dir, name, 'package.json')
    if (!existsSync(pkgFile)) continue
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
      name: string
      exports?: Record<string, string>
    }
    const entry = pkg.exports?.['.']
    if (!pkg.name.startsWith('@shard/') || typeof entry !== 'string') continue
    imports[pkg.name] = `/@fs${resolve(dir, name, entry).split(sep).join('/')}`
  }
  return imports
}

function errorPayload(err: ShardError & { source?: string }) {
  return {
    code: err.code,
    message: err.message,
    path: err.path,
    hint: err.hint,
    source: err.source,
  }
}

export async function dev(ctx: CommandContext): Promise<number> {
  const root = resolve(ctx.project)
  const platform = createNodePlatform({ root })
  const { manifest } = await loadProject(platform)
  const bundler = await createBundler({ root, entry: manifest.entry })
  const bundles = new Map<string, BuiltBundle>()
  let current = await bundler.build()
  bundles.set(current.hash, current)
  const bundleUrl = (b: BuiltBundle) => `/@shard/bundle/${b.hash}.mjs`
  let reloads = 0

  // The Node side owns the asset database: it imports and watches, and the page reads its catalog.
  // It evaluates the project bundle too, so the project's data types have importers here.
  const defineProjectTypes = async (bundle: BuiltBundle, reload: boolean) => {
    if (reload) beginRedefinition(manifest.name)
    try {
      await import(bundler.importUrl(bundle))
    } catch (err) {
      ctx.out.say(`project types failed to load: ${(err as Error).message}`)
    } finally {
      if (reload) endRedefinition()
    }
  }
  await defineProjectTypes(current, false)
  const assets = assetServer(new World()).configure({ platform, roots: manifest.assetRoots })
  const firstScan = await assets.scan()
  for (const f of firstScan.failed)
    ctx.out.say(`asset import failed: ${f.path}: ${f.error.message}`)

  const hubPort = Number(ctx.flags.hub ?? process.env.SHARD_HUB_PORT ?? DEFAULT_HUB_PORT)
  const shardDev: VitePlugin = {
    name: 'shard-dev',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'script',
          attrs: { type: 'importmap' },
          children: JSON.stringify({ imports: engineImportMap() }),
          injectTo: 'head-prepend',
        },
      ],
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === '/@shard/project.json') {
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              manifest,
              bundle: bundleUrl(current),
              hub: `ws://127.0.0.1:${hubPort}`,
            }),
          )
          return
        }
        const bundle = /^\/@shard\/bundle\/([0-9a-f]+)\.mjs$/.exec(url.pathname)
        if (bundle) {
          const b = bundles.get(bundle[1]!)
          if (!b) {
            res.statusCode = 404
            res.end()
            return
          }
          res.setHeader('content-type', 'text/javascript')
          res.setHeader('cache-control', 'no-store')
          res.end(b.code)
          return
        }
        if (url.pathname === '/@shard/shaders.json') {
          res.setHeader('content-type', 'application/json')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(projectShaders(root)))
          return
        }
        if (url.pathname.startsWith('/@shard/files/')) {
          const rel = decodeURIComponent(url.pathname.slice('/@shard/files/'.length))
          const file = resolve(root, rel)
          if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404
            res.end()
            return
          }
          res.setHeader('cache-control', 'no-store')
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          res.end(await readFile(file))
          return
        }
        next()
      })
    },
  }

  const port = Number(ctx.flags.port ?? 5190)
  const server: ViteDevServer = await createServer({
    configFile: false,
    root: runnerDir,
    logLevel: 'warn',
    clearScreen: false,
    server: {
      port,
      fs: { allow: [runnerDir, dirname(packagesDir()), root] },
    },
    plugins: [shardDev],
  })
  await server.listen()
  const address = server.resolvedUrls?.local[0] ?? `http://localhost:${port}/`

  const send = (event: string, data: unknown) => server.ws.send(event, data)
  const stopCode = bundler.watch((result) => {
    if (result instanceof Error) {
      ctx.out.say(`build failed: ${result.message}`)
      send('shard:project', { error: errorPayload(result) })
      return
    }
    current = result
    bundles.set(result.hash, result)
    ctx.out.say(`rebuilt in ${Math.round(result.ms)} ms`)
    // A fresh query per reload, so reverting to identical code still evaluates a new module.
    send('shard:project', { url: `${bundleUrl(result)}?r=${++reloads}`, ms: result.ms })
    // A changed data type re-imports its files; the page picks them up from the catalog.
    void defineProjectTypes(result, true)
      .then(() => assets.scan())
      .then((report) => {
        for (const f of report.failed)
          ctx.out.say(`asset import failed: ${f.path}: ${f.error.message}`)
        if (report.imported.length + report.failed.length > 0)
          send('shard:assets', { imported: report.imported, removed: report.removed })
      })
  })
  const stopAssets = await assets.watch({
    onScan: (report) => {
      if (report.imported.length + report.removed.length + report.failed.length === 0) return
      for (const f of report.failed)
        ctx.out.say(`asset import failed: ${f.path}: ${f.error.message}`)
      send('shard:assets', { imported: report.imported, removed: report.removed })
    },
  })

  // Shader edits go to the page as they're saved; it relinks and keeps the old one if broken.
  const shaderDir = join(root, 'shaders')
  const shaderWatcher = existsSync(shaderDir)
    ? watch(shaderDir, { recursive: true }, (_, name) => {
        if (!name || !/\.(wesl|wgsl)$/.test(name)) return
        const full = join(shaderDir, name)
        if (!existsSync(full)) return
        send('shard:shader', {
          file: relative(root, full).split(sep).join('/'),
          source: readFileSync(full, 'utf8'),
        })
      })
    : undefined

  ctx.out.result(
    { url: address, hub: `ws://127.0.0.1:${hubPort}`, project: manifest.name },
    `shard dev: ${manifest.name} at ${address}\nThe page connects to the tool hub at ws://127.0.0.1:${hubPort} (run \`shard mcp --attach\` to drive it).\nSaving a script or asset reloads it in place.`,
  )
  await new Promise<void>((done) => {
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
  stopCode()
  stopAssets()
  shaderWatcher?.close()
  await bundler.dispose()
  await server.close()
  return EXIT.ok
}
