import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineComponent, type ShardError, t } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { netPlugin, netSession, replicate } from '@aethervtt/shard-net'
import { webSocketTransport } from '@aethervtt/shard-net-websocket'
import { loadHeadlessCode } from '@aethervtt/shard-node'
import { Manifest, projectNet } from '@aethervtt/shard-project'
import { afterAll, describe, expect, it, onTestFinished } from 'vitest'
import {
  type BundleOutput,
  type Catalog,
  checkOneEngine,
  checkPlugins,
  type ExportReport,
  globToRegExp,
  reach,
} from './export'

const here = dirname(fileURLToPath(import.meta.url))
const bin = resolve(here, '../bin/shard.mjs')
const mazeChase = resolve(here, '../../../examples/maze-chase')
const starExplorer = resolve(here, '../../../examples/star-explorer')
const coinRush = resolve(here, '../../../examples/coin-rush')

function shard(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeout(300_000),
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) }
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shard-export-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function write(root: string, path: string, value: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
}

/**
 * A project on disk with what reachability reads: a catalog with artifacts, scenes and a script.
 * `assets/a.png` is in the scene, `b.png` only in the script, `c.png` nowhere, and the material
 * `m.material.json` depends on `d.png`.
 */
function reachFixture(): { root: string; catalog: Catalog } {
  const root = tempDir()
  const source = (path: string, guid: string, type: string, extra = {}) => ({
    path,
    guid,
    assets: [{ label: '', type, artifact: { json: `artifacts/${guid}.json` }, ...extra }],
  })
  const catalog: Catalog = {
    version: 1,
    cacheDir: '.shard/cache',
    sources: [
      source('assets/a.png', 'aaaa', 'Texture'),
      source('assets/b.png', 'bbbb', 'Texture'),
      source('assets/c.png', 'cccc', 'Texture'),
      source('assets/d.png', 'dddd', 'Texture'),
      source('assets/m.material.json', 'mmmm', 'Material', { dependencies: ['assets/d.png'] }),
      source('data/x.weapon.json', 'xxxx', 'demo/Weapon'),
    ],
  }
  for (const s of catalog.sources) write(root, `.shard/cache/artifacts/${s.guid}.json`, {})
  write(root, 'scenes/main.scene.json', {
    version: 1,
    entities: [
      {
        name: 'a',
        components: {
          'sprite/Sprite': { atlas: { path: 'assets/a.png' } },
          'render/MeshMaterial': { material: { guid: 'mmmm' } },
        },
      },
    ],
  })
  write(root, 'scripts/main.ts', `export const icon = 'assets/b.png'\n`)
  return { root, catalog }
}

const manifest = (json: object) => Manifest.deserialize({ name: 'demo', ...json })

describe('reachability', () => {
  it('ships what scenes, scripts and dependencies reach, and project data; leaves out the rest', async () => {
    const { root, catalog } = reachFixture()
    const r = await reach(root, manifest({ plugins: ['sprite'] }), catalog)
    expect([...r.sources.keys()].sort()).toEqual([
      'assets/a.png',
      'assets/b.png',
      'assets/d.png',
      'assets/m.material.json',
      'data/x.weapon.json',
    ])
    expect(r.excluded).toEqual(['assets/c.png'])
    expect(r.reasons.get('assets/b.png')).toBe('scripts/main.ts')
    expect(r.reasons.get('assets/d.png')).toBe('assets/m.material.json')
    expect(r.scenes).toEqual(['scenes/main.scene.json'])
  })

  it('export.include ships an unreferenced asset; export.exclude wins over a reference', async () => {
    const { root, catalog } = reachFixture()
    const r = await reach(
      root,
      manifest({
        plugins: ['sprite'],
        export: { include: ['assets/c.*'], exclude: ['assets/a.png'] },
      }),
      catalog,
    )
    expect(r.sources.has('assets/c.png')).toBe(true)
    expect(r.reasons.get('assets/c.png')).toBe('root: export.include')
    expect(r.sources.has('assets/a.png')).toBe(false)
    expect(r.excluded).toEqual(['assets/a.png'])
  })

  it('a bundle holding one engine package from two installs fails with export/two-engines', () => {
    const chunk = (...ids: string[]): BundleOutput => ({
      type: 'chunk',
      fileName: 'assets/a.js',
      code: '',
      modules: Object.fromEntries(ids.map((id) => [id, { renderedLength: 1 }])),
    })
    const one = '/game/node_modules/@aethervtt/shard-core/dist/index.js'
    const other =
      '/game/node_modules/.pnpm/@aethervtt+shard-core@0.4.0/node_modules/@aethervtt/shard-core/dist/index.js'
    expect(() =>
      checkOneEngine([chunk(one, '/game/node_modules/@aethervtt/shard-core/dist/world.js')]),
    ).not.toThrow()
    let error: ShardError | undefined
    try {
      checkOneEngine([chunk(one), chunk(other)])
    } catch (err) {
      error = err as ShardError
    }
    expect(error?.code).toBe('export/two-engines')
    expect(error?.message).toContain('@aethervtt/shard-core')
  })

  it('globs: ** crosses folders, * stays in one', () => {
    expect(globToRegExp('assets/**/*.png').test('assets/ui/icons/x.png')).toBe(true)
    expect(globToRegExp('assets/**/*.png').test('assets/x.png')).toBe(true)
    expect(globToRegExp('assets/*.png').test('assets/ui/x.png')).toBe(false)
    expect(globToRegExp('levels/level?.scene.json').test('levels/level2.scene.json')).toBe(true)
  })

  it('a scene using a component whose plugin is off fails with export/plugin-missing, naming both', async () => {
    const { root, catalog } = reachFixture()
    const r = await reach(root, manifest({ plugins: ['input'] }), catalog)
    let error: ShardError | undefined
    try {
      checkPlugins(manifest({ plugins: ['input'] }), r.components)
    } catch (err) {
      error = err as ShardError
    }
    expect(error?.code).toBe('export/plugin-missing')
    expect(error?.message).toContain('scenes/main.scene.json')
    expect(error?.message).toContain('sprite/Sprite')
    expect(error?.hint).toContain('"sprite"')
    // sprite brings render/forward and render: enabling it fixes both.
    expect(() => checkPlugins(manifest({ plugins: ['sprite'] }), r.components)).not.toThrow()
  })
})

describe('shard export --target web (0110)', () => {
  it(
    'maze-chase exports to static files that run headless to the same world hash as the project',
    () => {
      const out = tempDir()
      const exported = shard(['export', '--out', out, '--json'], mazeChase)
      expect(exported.code, exported.stderr).toBe(0)
      const report = exported.json() as ExportReport
      expect(report.build).toMatch(/^[0-9a-f]{20}$/)
      const build = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'))
      for (const file of Object.values(build.files) as { url: string }[]) {
        expect(existsSync(join(out, file.url))).toBe(true)
      }
      expect(existsSync(join(out, 'index.html'))).toBe(true)
      expect(build.shaders.bake).toBeDefined()

      // What the page loads at startup: no protocol, capture hooks or shader linker.
      const entry = report.chunks
        .filter((c) => c.kind === 'entry')
        .flatMap((c) => Object.keys(c.packages))
      expect(entry).not.toContain('@aethervtt/shard-protocol')
      expect(entry).not.toContain('@aethervtt/shard-verify')
      expect(entry).not.toContain('wesl')

      const args = ['--frames', '300', '--seed', '5', '--json']
      const project = shard(['run', ...args], mazeChase).json()
      const built = shard(['run', '--build', out, ...args], mazeChase)
      expect(built.code, built.stderr).toBe(0)
      expect(built.json().hash).toBe(project.hash)
    },
    timeout(600_000),
  )

  it(
    'star-explorer (3D, fonts, UI, generators) runs from its export to the same hash',
    () => {
      const out = tempDir()
      const exported = shard(['export', '--out', out, '--json'], starExplorer)
      expect(exported.code, exported.stderr).toBe(0)
      for (const scene of ['scenes/main.scene.json', 'scenes/rocks.scene.json']) {
        const args = ['--scene', scene, '--frames', '120', '--seed', '3', '--json']
        const project = shard(['run', ...args], starExplorer).json()
        const built = shard(['run', '--build', out, ...args], starExplorer)
        expect(built.code, built.stderr).toBe(0)
        expect(built.json().hash, scene).toBe(project.hash)
      }
    },
    timeout(900_000),
  )

  it(
    'with --pack, the data is one .shardpak (the WebGL2 translations and bake loose) and hashes the same',
    () => {
      const out = tempDir()
      const exported = shard(['export', '--pack', '--out', out, '--json'], mazeChase)
      expect(exported.code, exported.stderr).toBe(0)
      expect((exported.json() as ExportReport).packs).toBe(1)
      const build = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'))
      expect(build.packs).toHaveLength(1)
      expect(existsSync(join(out, build.packs[0]))).toBe(true)
      const loose = Object.entries(build.files)
        .filter(([, f]) => (f as { pack?: number }).pack === undefined)
        .map(([path]) => path)
        .sort()
      expect(loose).toEqual(['.shard/export/shaders.bake.json', '.shard/shaders/webgl2.json'])
      const args = ['--frames', '300', '--seed', '5', '--json']
      const project = shard(['run', ...args], mazeChase).json()
      const built = shard(['run', '--build', out, ...args], mazeChase)
      expect(built.code, built.stderr).toBe(0)
      expect(built.json().hash).toBe(project.hash)
    },
    timeout(600_000),
  )

  it(
    '--dry-run lists what would ship and writes nothing',
    () => {
      const out = join(tempDir(), 'web')
      const r = shard(['export', '--dry-run', '--out', out, '--json'], mazeChase)
      expect(r.code, r.stderr).toBe(0)
      const report = r.json() as ExportReport
      expect(report.included.map((i) => i.path)).toContain('scenes/main.scene.json')
      expect(existsSync(out)).toBe(false)
    },
    timeout(300_000),
  )
})

// A component only a mismatched client replicates.
const Extra = defineComponent('exporttest/Extra', { n: t.u32() })

describe('shard export --target server (0110)', () => {
  it(
    'coin-rush runs from its server export outside the repository: page, health, players, refusal, SIGTERM',
    async () => {
      // A temporary folder: no node_modules above it, so server.mjs can only use what it ships.
      const out = tempDir()
      const exported = shard(
        ['export', '--target', 'server', '--static', '--out', out, '--json'],
        coinRush,
      )
      expect(exported.code, exported.stderr).toBe(0)
      expect(existsSync(join(out, 'node_modules'))).toBe(false)
      expect(existsSync(join(out, 'Dockerfile'))).toBe(true)

      const child = spawn(process.execPath, ['server.mjs', '--port', '0', '--json'], { cwd: out })
      onTestFinished(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      })
      const info = await new Promise<{ url: string; http: string; build: string }>((done, fail) => {
        let text = ''
        child.stdout.on('data', (d) => {
          text += d
          try {
            done(JSON.parse(text))
          } catch {}
        })
        let err = ''
        child.stderr.on('data', (d) => {
          err += d
        })
        child.on('exit', (code) => fail(new Error(`server exited ${code}: ${err}`)))
      })
      expect(info.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/net$/)
      expect(await (await fetch(`${info.http}/`)).text()).toContain('<canvas')

      // Two clients of the same game join and see both players and the ten coins.
      const code = await loadHeadlessCode({ root: coinRush, code: 'source' })
      const net = projectNet(code.project)!
      const player = (replicated = net.replicate) =>
        code.build([
          netPlugin({
            ...net,
            replicate: replicated,
            role: 'client',
            transport: webSocketTransport(),
            address: info.url,
          }),
        ])
      const players = [player(), player()]
      for (const app of players) await app.init()
      const seen = (app: (typeof players)[number]) => netSession(app.world).client!.byNetId.size
      for (let i = 0; i < 600 && players.some((p) => seen(p) < 12); i++) {
        for (const p of players) p.update(1 / 60)
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(players.map(seen)).toEqual([12, 12])
      const health = await (await fetch(`${info.http}/healthz`)).json()
      expect(health).toMatchObject({ build: info.build, players: 2 })

      // A client whose replicated components differ is refused, naming the component.
      const other = player([...net.replicate!, replicate(Extra)])
      await other.init()
      // The socket's close can arrive before the refusal it follows is read: wait for the refusal.
      const refused = () => netSession(other.world).client!.lastError
      for (let i = 0; i < 400 && refused()?.code !== 'net/schema-mismatch'; i++) {
        other.update(1 / 60)
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(refused()).toMatchObject({
        code: 'net/schema-mismatch',
        message: expect.stringContaining('exporttest/Extra'),
      })
      for (const app of [...players, other]) await app.dispose()
      await code.close()

      const exited = new Promise<number | null>((r) => child.on('exit', r))
      child.kill('SIGTERM')
      const exitCode = await exited
      // Windows can't deliver SIGTERM to a child: kill() terminates it.
      if (process.platform !== 'win32') expect(exitCode).toBe(0)
    },
    timeout(600_000),
  )
})

/** A server process's ready line (the launch contract, 0111): `{ url, http }` on stdout. */
function readyLine(child: ReturnType<typeof spawn>): Promise<{ url: string; http: string }> {
  return new Promise((done, fail) => {
    let text = ''
    let err = ''
    child.stdout!.on('data', (d) => {
      text += d
      const line = text.split('\n').find((l) => l.startsWith('{'))
      if (line) {
        try {
          done(JSON.parse(line))
        } catch {}
      }
    })
    child.stderr!.on('data', (d) => {
      err += d
    })
    child.on('exit', (code) => fail(new Error(`exited ${code}: ${err}`)))
  })
}

/** A coin-rush client from source joins `url` and sees the player and the ten coins. */
async function joins(url: string): Promise<number> {
  const code = await loadHeadlessCode({ root: coinRush, code: 'source' })
  const net = projectNet(code.project)!
  const app = code.build([
    netPlugin({ ...net, role: 'client', transport: webSocketTransport(), address: url }),
  ])
  await app.init()
  const seen = () => netSession(app.world).client!.byNetId.size
  for (let i = 0; i < 600 && seen() < 11; i++) {
    app.update(1 / 60)
    await new Promise((r) => setTimeout(r, 5))
  }
  const n = seen()
  await app.dispose()
  await code.close()
  return n
}

// Compiling needs Bun; CI installs it, so there a missing Bun fails instead of skipping.
const noBun = spawnSync('bun', ['--version']).error !== undefined && !process.env.SHARD_CI

describe('servers compiled with Bun (0111)', () => {
  it.skipIf(noBun)(
    'the generated server and a custom one (risen-shaped) meet the launch contract as executables',
    async () => {
      const out = tempDir()
      const exported = shard(
        ['export', '--target', 'server', '--compile', '--out', out, '--json'],
        coinRush,
      )
      expect(exported.code, exported.stderr).toBe(0)
      const binary = exported.json().binary.file as string

      // From another folder: the executable finds its data beside itself. Started as a sidecar,
      // it also stops when its stdin closes, as when the app that started it dies.
      const generated = spawn(binary, ['--port', '0', '--json'], {
        cwd: tempDir(),
        env: { ...process.env, SHARD_SIDECAR: '1' },
      })
      onTestFinished(() => {
        if (generated.exitCode === null) generated.kill('SIGKILL')
      })
      const g = await readyLine(generated)
      expect(await joins(g.url)).toBe(11)
      const gExit = new Promise<number | null>((r) => generated.on('exit', r))
      generated.stdin!.end()
      expect(await gExit).toBe(0)

      // A project's own server, compiled from its source, opening the export via SHARD_DIR.
      const { compileServer } = await import('./sidecar')
      const custom = compileServer({
        entry: join(here, '../fixtures/custom-server/main.ts'),
        outfile: join(tempDir(), 'custom-server'),
      })
      const child = spawn(custom.file, ['--json'], {
        cwd: tempDir(),
        env: { ...process.env, SHARD_DIR: out, PORT: '0', SHARD_DATA: tempDir() },
      })
      onTestFinished(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      })
      const c = await readyLine(child)
      expect(await (await fetch(`${c.http}/health`)).json()).toMatchObject({ custom: true })
      expect(await joins(c.url)).toBe(11)
      const cExit = new Promise<number | null>((r) => child.on('exit', r))
      child.kill('SIGTERM')
      if (process.platform !== 'win32') expect(await cExit).toBe(0)
    },
    timeout(900_000),
  )
})

describe('shard export --target tauri (0111)', () => {
  it(
    '--init scaffolds the app once; later exports rewrite the export, check the app, and never edit it',
    () => {
      const dir = tempDir()
      const app = join(dir, 'src-tauri')
      const out = join(dir, 'tauri')
      const args = ['export', '--target', 'tauri', '--init', '--app', app, '--out', out, '--json']
      const first = shard(args, mazeChase)
      expect(first.code, first.stderr).toBe(0)
      const report = first.json()
      expect(report.app.scaffolded).toEqual(
        expect.arrayContaining(['Cargo.toml', 'src/lib.rs', 'tauri.conf.json', 'icons/icon.png']),
      )
      expect(report.warnings.filter((w: string) => w.startsWith('export/tauri-mismatch'))).toEqual(
        [],
      )
      // The page and its data apart; the data packed (desktop exports pack by default).
      expect(existsSync(join(out, 'page/index.html'))).toBe(true)
      const build = JSON.parse(readFileSync(join(out, 'data/build.json'), 'utf8'))
      expect(build.packs).toHaveLength(1)
      const conf = JSON.parse(readFileSync(join(app, 'tauri.conf.json'), 'utf8'))
      expect(conf.build.frontendDist).toBe('../tauri/page')
      expect(conf.bundle.resources).toEqual({ '../tauri/data/': 'game/' })
      expect(readFileSync(join(app, 'src/lib.rs'), 'utf8')).toContain('tauri_plugin_shard::init()')

      const files = ['Cargo.toml', 'src/lib.rs', 'tauri.conf.json', 'capabilities/default.json']
      const before = files.map((f) => readFileSync(join(app, f), 'utf8'))
      const second = shard(args, mazeChase)
      expect(second.code, second.stderr).toBe(0)
      expect(second.json().app.scaffolded).toEqual([])
      expect(files.map((f) => readFileSync(join(app, f), 'utf8'))).toEqual(before)

      // The developer's app drifts: the export says so and leaves it alone.
      const drifted = before[2]!.replace('"../tauri/page"', '"../elsewhere"')
      writeFileSync(join(app, 'tauri.conf.json'), drifted)
      const third = shard(args, mazeChase)
      expect(third.code, third.stderr).toBe(0)
      expect(third.json().warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('build.frontendDist')]),
      )
      expect(readFileSync(join(app, 'tauri.conf.json'), 'utf8')).toBe(drifted)

      // The split layout runs headless like the project.
      const run = ['--frames', '120', '--seed', '2', '--json']
      expect(shard(['run', '--build', out, ...run], mazeChase).json().hash).toBe(
        shard(['run', ...run], mazeChase).json().hash,
      )
    },
    timeout(900_000),
  )

  it('a multiplayer app set to play "local" needs its server bundled (--sidecar)', () => {
    const dir = tempDir()
    const r = shard(
      [
        'export',
        '--target',
        'tauri',
        '--app',
        join(dir, 'app'),
        '--out',
        join(dir, 'out'),
        '--json',
      ],
      coinRush,
    )
    expect(r.code).not.toBe(0)
    expect(JSON.parse(r.stdout).error.code).toBe('export/net-url-missing')
  })
})
