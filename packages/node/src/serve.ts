/**
 * An exported game server (0110): the project's dedicated server (0092) over an export's files,
 * its WebSocket at `/net`, `/healthz`, and optionally a web export, all on one port. What a
 * server export's `server.mjs` runs; it imports nothing that needs installing.
 */
import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { ShardError } from '@aethervtt/shard-core'
import { netPlugin, netSession } from '@aethervtt/shard-net'
import { webSocketServer } from '@aethervtt/shard-net-websocket/server'
import { buildFs, type Platform } from '@aethervtt/shard-platform'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { type BuildJson, projectNet, startExport } from '@aethervtt/shard-project/export'
import type { EnginePlugin } from '@aethervtt/shard-project/plugins'
import { type App, intervalRunner, type Plugin } from '@aethervtt/shard-runtime'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
}

/** Content-hashed names (`assets/`, `f/`) never change; everything else is checked each time. */
function cacheControl(path: string): string {
  return /^\/(assets|f)\//.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache'
}

/**
 * Serves a web export (0110) as a static host should: pre-compressed `.br` or `.gz` copies by
 * `Accept-Encoding`, immutable caching on hashed files, and `Range` requests. False when the path
 * isn't a file there.
 */
export async function serveStatic(
  dir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const root = resolve(dir)
  let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  if (path.endsWith('/')) path += 'index.html'
  const file = resolve(root, `.${path}`)
  if (file !== root && !file.startsWith(root + sep)) return false
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return false
  const headers: Record<string, string | number> = {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': cacheControl(path),
    vary: 'accept-encoding',
    'accept-ranges': 'bytes',
  }
  const accepts = String(req.headers['accept-encoding'] ?? '')
  const range = req.headers.range
  if (!range) {
    for (const [encoding, ext] of [
      ['br', '.br'],
      ['gzip', '.gz'],
    ] as const) {
      if (!accepts.includes(encoding)) continue
      const packed = await stat(file + ext).catch(() => undefined)
      if (!packed) continue
      res.writeHead(200, {
        ...headers,
        'content-encoding': encoding,
        'content-length': packed.size,
      })
      if (req.method === 'HEAD') res.end()
      else createReadStream(file + ext).pipe(res)
      return true
    }
  }
  let start = 0
  let end = info.size - 1
  let status = 200
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    const from = m?.[1] ? Number(m[1]) : undefined
    const to = m?.[2] ? Number(m[2]) : undefined
    if (from === undefined && to !== undefined) start = Math.max(0, info.size - to)
    else if (from !== undefined) {
      start = from
      if (to !== undefined) end = Math.min(to, info.size - 1)
    }
    if (!m || start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      res.end()
      return true
    }
    status = 206
    headers['content-range'] = `bytes ${start}-${end}/${info.size}`
  }
  res.writeHead(status, { ...headers, 'content-length': end - start + 1 })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file, { start, end }).pipe(res)
  return true
}

export interface ServeExportOptions {
  /** The server export's folder, with its `build.json`. */
  dir: string
  /** The engine plugins its entry imported, in `enginePlugins` order. */
  plugins: readonly EnginePlugin[]
  project: Plugin
  /** Default 7000; 0 picks a free port. */
  port?: number
  /** Default 127.0.0.1: only this machine. 0.0.0.0 listens on every interface. */
  host?: string
  /** Where player saves and settings go. Default `data/` in the export. */
  dataDir?: string
  /** A web export to serve from the same port (`public/` of `--static` exports). */
  staticDir?: string
  seed?: number
}

export interface ServedExport {
  /** The game's WebSocket: `ws://host:port/net`. */
  url: string
  /** The page, health and files: `http://host:port`. */
  http: string
  port: number
  build: BuildJson
  app: App
  /** Stops the game (storing every connected player, 0090) and the HTTP server. */
  close(): Promise<void>
}

/** Runs an exported server until `close` (0110). */
export async function serveExport(options: ServeExportOptions): Promise<ServedExport> {
  const dir = resolve(options.dir)
  const build = JSON.parse(await readFile(join(dir, 'build.json'), 'utf8')) as BuildJson
  const net = projectNet(options.project)
  if (!net) {
    throw new ShardError(
      'project/not-multiplayer',
      `${build.project.name} has no project.net(...)`,
      {
        hint: 'Call project.net({ replicate, commands, … }) in the entry to make it multiplayer.',
      },
    )
  }
  const started = Date.now()
  let app: App | undefined
  const http: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/healthz') {
      const players = app ? (netSession(app.world).server?.peers.size ?? 0) : 0
      const body = JSON.stringify({
        build: build.build,
        project: build.project,
        players,
        uptime: Math.round((Date.now() - started) / 1000),
      })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
      res.end(body)
      return
    }
    const served = options.staticDir ? serveStatic(options.staticDir, req, res) : false
    void Promise.resolve(served).then(
      (ok) => {
        if (!ok) res.writeHead(404).end()
      },
      () => res.writeHead(500).end(),
    )
  })
  await new Promise<void>((done, fail) => {
    http.once('error', fail)
    http.listen(options.port ?? 7000, options.host ?? '127.0.0.1', done)
  })
  const files = createNodePlatform({ root: dir, dataDir: options.dataDir ?? join(dir, 'data') })
  const platform: Platform = { ...files, fs: buildFs(files.fs, build.files, build.packs) }
  try {
    ;({ app } = await startExport({
      build,
      platform,
      plugins: options.plugins,
      project: options.project,
      seed: options.seed,
      display: false,
      startScene: false,
      configure(a) {
        a.addPlugin(
          netPlugin({ ...net, role: 'server', transport: webSocketServer({ server: http }) }),
        )
      },
    }))
    await netSession(app.world).ready
  } catch (err) {
    http.close()
    throw err
  }
  const game = app
  game.setRunner(intervalRunner())
  const running = game.run()
  const { port } = http.address() as { port: number }
  const host = options.host ?? '127.0.0.1'
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host
  return {
    url: `ws://${shown}:${port}/net`,
    http: `http://${shown}:${port}`,
    port,
    build,
    app: game,
    async close() {
      await game.dispose()
      await running
      platform.workers?.dispose()
      http.closeAllConnections()
      await new Promise((done) => http.close(done))
    },
  }
}

/**
 * `node server.mjs [--port 7000] [--host 0.0.0.0] [--data ./data] [--static ./public] [--json]`:
 * flags, or PORT, HOST, SHARD_DATA and SHARD_STATIC. Serves until SIGINT or SIGTERM, then stores
 * every player and exits 0.
 */
export async function serverMain(
  entry: Omit<ServeExportOptions, 'port' | 'host' | 'dataDir' | 'staticDir' | 'seed'>,
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      data: { type: 'string' },
      static: { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const port = Number(values.port ?? env.PORT ?? 7000)
  if (!Number.isInteger(port) || port < 0) {
    process.stderr.write(`--port ${values.port ?? env.PORT} isn't a port\n`)
    process.exit(3)
  }
  const dir = resolve(entry.dir)
  const staticDir =
    values.static ??
    env.SHARD_STATIC ??
    (existsSync(join(dir, 'public')) ? join(dir, 'public') : undefined)
  let served: ServedExport
  try {
    served = await serveExport({
      ...entry,
      port,
      host: values.host ?? env.HOST,
      dataDir: values.data ?? env.SHARD_DATA,
      staticDir,
      seed: values.seed === undefined ? undefined : Number(values.seed),
    })
  } catch (err) {
    const e = err as { code?: string; message?: string; hint?: string }
    process.stderr.write(`error[${e.code ?? 'server/failed'}]: ${e.message ?? String(err)}\n`)
    if (e.hint) process.stderr.write(`  hint: ${e.hint}\n`)
    process.exit(1)
  }
  const info = {
    url: served.url,
    http: served.http,
    port: served.port,
    build: served.build.build,
    project: served.build.project.name,
    static: staticDir ?? null,
  }
  if (values.json) process.stdout.write(`${JSON.stringify(info)}\n`)
  else {
    process.stderr.write(
      `Serving ${info.project} (build ${info.build}): the game at ${info.url}` +
        (staticDir ? `, the page at ${info.http}` : '') +
        '. Ctrl-C stops.\n',
    )
  }
  await new Promise<void>((done) => {
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
  process.stderr.write('Stopping: saving players…\n')
  await served.close()
  process.exit(0)
}
