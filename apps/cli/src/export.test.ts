import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ShardError } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { Manifest } from '@aethervtt/shard-project'
import { afterAll, describe, expect, it } from 'vitest'
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

function shard(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: 300_000 })
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
