import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProject } from '@aethervtt/shard-node'
import { connectToHub, createProtocolServer, decodePng } from '@aethervtt/shard-protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { Hub, localTarget } from './hub'
import { createMcpServer } from './mcp'

const here = dirname(fileURLToPath(import.meta.url))
const bin = resolve(here, '../bin/shard.mjs')
const example = resolve(here, '../../../examples/star-explorer')

function shard(args: string[], cwd = example) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: 180_000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) }
}

/** Writes a file into the example for one test and removes it afterwards. */
function temp(path: string, content: string) {
  const file = join(example, path)
  writeFileSync(file, content)
  return () => rmSync(file, { force: true })
}

describe('commands', () => {
  it('init scaffolds a project with every file and next steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-init-'))
    const r = shard(['init', join(dir, 'my-game'), '--template', 'empty', '--json'], dir)
    expect(r.code).toBe(0)
    const result = r.json()
    expect(result.name).toBe('my-game')
    expect(result.files).toEqual(
      expect.arrayContaining([
        'shard.json',
        'scripts/main.ts',
        'scenes/main.scene.json',
        '.mcp.json',
      ]),
    )
    const manifest = JSON.parse(readFileSync(join(dir, 'my-game', 'shard.json'), 'utf8'))
    expect(manifest.name).toBe('my-game')
    expect(shard(['init', join(dir, 'my-game')], dir).code).toBe(2) // not empty
    rmSync(dir, { recursive: true, force: true })
  })

  it('validate passes on the example and lists every error in a broken scene (exit 1)', () => {
    expect(shard(['validate', '--json']).json()).toMatchObject({ valid: true })
    const cleanup = temp(
      'scenes/zz-broken.scene.json',
      JSON.stringify({
        version: 1,
        entities: [
          {
            name: 'a',
            components: {
              'render/Camera3d': { fovY: 'wide' },
              'star-explorer/Ship': { speed: -5 },
            },
          },
          { name: 'a', components: { 'core/Nope': {} } },
        ],
      }),
    )
    try {
      const r = shard(['validate', '--json'])
      expect(r.code).toBe(1)
      const errors = r
        .json()
        .scenes['scenes/zz-broken.scene.json'].map((e: { code: string; path: string }) => [
          e.code,
          e.path,
        ])
      expect(errors).toEqual(
        expect.arrayContaining([
          ['schema/type-mismatch', '/entities/0/components/render~1Camera3d/fovY'],
          ['schema/out-of-range', '/entities/0/components/star-explorer~1Ship/speed'],
          ['scene/duplicate-name', '/entities/1/name'],
          ['scene/unknown-component', '/entities/1/components/core~1Nope'],
        ]),
      )
      // Without --json the same report is written for humans, on stderr.
      const human = shard(['validate'])
      expect(human.code).toBe(1)
      expect(human.stdout).toBe('')
      expect(human.stderr).toContain(
        'scenes/zz-broken.scene.json/entities/0/components/render~1Camera3d/fovY',
      )
    } finally {
      cleanup()
    }
  })

  it('validate checks data files: fields, $extends, and handle types', () => {
    const files = [
      'data/weapons/zz-wrong-handle.weapon.json',
      'data/weapons/zz-loop-a.weapon.json',
      'data/weapons/zz-loop-b.weapon.json',
    ]
    writeFileSync(
      join(example, files[0]!),
      JSON.stringify({ damage: -1, upgradesTo: { path: 'scenes/main.scene.json' } }),
    )
    writeFileSync(
      join(example, files[1]!),
      JSON.stringify({ $extends: { path: 'data/weapons/zz-loop-b.weapon.json' } }),
    )
    writeFileSync(
      join(example, files[2]!),
      JSON.stringify({ $extends: { path: 'data/weapons/zz-loop-a.weapon.json' } }),
    )
    const heavy = join(example, 'data/weapons/heavy-laser.weapon.json')
    const original = readFileSync(heavy, 'utf8')
    try {
      let r = shard(['validate', '--json'])
      expect(r.code).toBe(1)
      const byFile = (report: { assets: { source: string; code: string; path: string }[] }) =>
        report.assets.map((e) => [e.source, e.code, e.path])
      expect(byFile(r.json())).toEqual(
        expect.arrayContaining([
          [files[0], 'assets/import-failed', '/damage'],
          [files[1], 'data/extends-cycle', '/$extends'],
          [files[2], 'data/extends-cycle', '/$extends'],
        ]),
      )
      // A handle to an asset of the wrong type (checked against the catalog after importing).
      writeFileSync(
        heavy,
        JSON.stringify({
          $extends: { path: 'data/weapons/laser.weapon.json' },
          upgradesTo: { path: 'materials/zz-paint.material.json' },
        }),
      )
      mkdirSync(join(example, 'materials'), { recursive: true })
      writeFileSync(join(example, 'materials/zz-paint.material.json'), '{}')
      writeFileSync(join(example, files[0]!), JSON.stringify({}))
      writeFileSync(join(example, files[1]!), JSON.stringify({}))
      writeFileSync(join(example, files[2]!), JSON.stringify({ upgradesTo: { path: 'x.png' } }))
      r = shard(['validate', '--json'])
      expect(byFile(r.json())).toEqual([
        ['data/weapons/heavy-laser.weapon.json', 'schema/asset-type-mismatch', '/upgradesTo'],
        [files[2], 'schema/asset-not-found', '/upgradesTo'],
      ])
    } finally {
      writeFileSync(heavy, original)
      rmSync(join(example, 'materials'), { recursive: true, force: true })
      for (const f of files) {
        rmSync(join(example, f), { force: true })
        rmSync(join(example, `${f}.meta`), { force: true })
      }
    }
  })

  it('validate checks animation graphs: conditions with the column, states, clips, reachability', () => {
    const file = 'data/zz-hero.animgraph.json'
    writeFileSync(
      join(example, file),
      JSON.stringify({
        parameters: { grounded: { type: 'bool' } },
        layers: [
          {
            states: { idle: {}, fall: {}, lost: {} },
            transitions: [{ from: 'idle', to: 'fall', when: 'grounded &&& true' }],
          },
        ],
      }),
    )
    try {
      let r = shard(['validate', '--json'])
      expect(r.code).toBe(1)
      const graphErrors = (report: {
        assets: { source: string; code: string; path: string; message: string }[]
      }) => report.assets.filter((e) => e.source === file)
      const [bad] = graphErrors(r.json())
      expect(bad).toMatchObject({
        code: 'animgraph/bad-condition',
        path: '/layers/0/transitions/0/when',
      })
      expect(bad!.message).toContain('column 12')
      writeFileSync(
        join(example, file),
        JSON.stringify({
          layers: [
            { states: { idle: { clip: { path: 'assets/nope.glb#Animation/Idle' } }, lost: {} } },
          ],
        }),
      )
      r = shard(['validate', '--json'])
      expect(graphErrors(r.json()).map((e) => [e.code, e.path])).toEqual([
        ['animgraph/unknown-clip', '/layers/0/states/idle'],
      ])
      expect(r.json().warnings).toContain(
        `${file} /layers/0/states/lost: [animgraph/unreachable-state] State "lost" in layer "layer0" can't be reached from "idle"`,
      )
    } finally {
      rmSync(join(example, file), { force: true })
      rmSync(join(example, `${file}.meta`), { force: true })
    }
  })

  it('validate checks localization: keys a locale lacks and keys no table defines', () => {
    const table = 'locales/zz.en.strings.json'
    const scene = 'scenes/zz-keys.scene.json'
    writeFileSync(join(example, table), JSON.stringify({ 'zz.only-english': 'Only English' }))
    const cleanScene = temp(
      scene,
      JSON.stringify({
        version: 1,
        entities: [
          { name: 'ok', components: { 'ui/UiText': { key: 'zz.only-english' } } },
          { name: 'bad', components: { 'ui/UiText': { key: 'zz.nowhere' } } },
        ],
      }),
    )
    try {
      const r = shard(['validate', '--json'])
      expect(r.code).toBe(1)
      const report = r.json()
      expect(report.assets.filter((e: { code: string }) => e.code.startsWith('locale/'))).toEqual([
        expect.objectContaining({
          code: 'locale/missing-key',
          source: 'locales/pt-BR.strings.json',
          path: '/zz.only-english',
          message: '"zz.only-english" is missing in pt-BR',
        }),
      ])
      expect(report.scenes[scene]).toEqual([
        expect.objectContaining({
          code: 'locale/missing-key',
          path: '/entities/1/components/ui~1UiText/key',
        }),
      ])
    } finally {
      cleanScene()
      rmSync(join(example, table), { force: true })
      rmSync(join(example, `${table}.meta`), { force: true })
    }
  })

  it('run is deterministic', () => {
    const a = shard(['run', '--frames', '300', '--seed', '7', '--json']).json()
    const b = shard(['run', '--frames', '300', '--seed', '7', '--json']).json()
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.hash).toBe(a.hash)
    expect(a.seed).toBe(7)
  })

  it('screenshot writes a PNG matching a golden image, with no window', async () => {
    const out = join(example, '.shard', 'cli-test-shot.png')
    const r = shard([
      'screenshot',
      'scenes/main.scene.json',
      '--out',
      out,
      '--size',
      '64x36',
      '--frames',
      '1',
      '--json',
    ])
    expect(r.code).toBe(0)
    const png = await decodePng(new Uint8Array(readFileSync(out)))
    expect([png.width, png.height]).toEqual([64, 36])
    const golden = join(here, '__golden__', 'example-screenshot.rgba')
    if (!existsSync(golden)) {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(dirname(golden), { recursive: true })
      writeFileSync(golden, png.data)
    }
    const expected = new Uint8Array(readFileSync(golden))
    let sum = 0
    for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i]! - png.data[i]!)
    expect(sum / expected.length).toBeLessThan(1.5)
  })

  it('gen writes a labelled 3×3 contact sheet matching a golden; --json reports keys and cache hits', async () => {
    const out = join(example, '.shard', 'cli-test-gen.png')
    const args = ['gen', 'scripts:Rock', '--seeds', '1-9', '--size', '64', '--out', out, '--json']
    const r = shard(args)
    expect(r.code).toBe(0)
    const result = r.json()
    expect(result.generator).toBe('star-explorer/Rock')
    expect(result.results).toHaveLength(9)
    expect(result.results.map((x: { seed: number }) => x.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const keys = result.results.map((x: { key: string }) => x.key)
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(keys).size).toBe(9)
    expect(result.results[0]).toMatchObject({ output: 'Mesh', vertices: 642, triangles: 1280 })
    // Same inputs again: the same keys, all from the cache.
    const again = shard(args).json()
    expect(again.results.map((x: { key: string }) => x.key)).toEqual(keys)
    expect(again.results.every((x: { cacheHit: boolean }) => x.cacheHit)).toBe(true)
    const png = await decodePng(new Uint8Array(readFileSync(out)))
    // Three 64 px cells a side, 2 px apart.
    expect([png.width, png.height]).toEqual([200, 200])
    const golden = join(here, '__golden__', 'gen-rock-sheet.rgba')
    if (!existsSync(golden)) writeFileSync(golden, png.data)
    const expected = new Uint8Array(readFileSync(golden))
    let sum = 0
    for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i]! - png.data[i]!)
    expect(sum / expected.length).toBeLessThan(1.5)
  })

  it('check reports Math.random in a generator module with file, line, and column', () => {
    const cleanup = temp(
      'scripts/zz-random.ts',
      `import { t } from '@aethervtt/shard-core'\nimport { defineGenerator } from '@aethervtt/shard-procgen'\n\nexport const Noisy = defineGenerator('star-explorer/Noisy', {\n  params: { n: t.u32() },\n  output: 'data',\n  run: (_ctx, p) => p.n + Math.random(),\n})\n`,
    )
    try {
      const r = shard(['check', '--json'])
      expect(r.code).toBe(1)
      expect(r.json().diagnostics).toEqual([
        expect.objectContaining({
          file: 'scripts/zz-random.ts',
          line: 7,
          column: 27,
          code: 'procgen/nondeterministic',
        }),
      ])
    } finally {
      cleanup()
    }
  })

  it('test passes on the example, and a failing test exits 1 with the failure', () => {
    const ok = shard(['test', '--json'])
    expect(ok.code).toBe(0)
    expect(ok.json()).toMatchObject({ passed: 12, failed: 0 })
    const cleanup = temp(
      'tests/zz-fail.test.ts',
      `import { expect, test } from '@aethervtt/shard-testing'\ntest('ships can teleport', async ({ game }) => {\n  await game.step(1)\n  expect(game.get('ship', 'core/Transform').translation[1]).toBe(999)\n})\n`,
    )
    try {
      const r = shard(['test', 'zz-fail', '--json'])
      expect(r.code).toBe(1)
      expect(r.json().tests[0]).toMatchObject({
        name: 'ships can teleport',
        state: 'fail',
        error: expect.stringContaining('999'),
      })
    } finally {
      cleanup()
    }
  })

  it('docs regenerates agent docs from the project registry', () => {
    const r = shard(['docs', '--json'])
    expect(r.code).toBe(0)
    expect(r.json().written).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        '.agents/components.md',
        '.shard/schemas/scene.schema.json',
      ]),
    )
    expect(readFileSync(join(example, '.agents/components.md'), 'utf8')).toContain(
      '## `star-explorer/Ship`',
    )
  })

  it('import lists failures, mv moves an asset and rewrites references', () => {
    const files = [
      'materials/zz-test.material.json',
      'materials/zz-test.material.json.meta',
      'materials/zz-moved.material.json',
      'materials/zz-moved.material.json.meta',
      'materials/zz-bad.material.json',
      'materials/zz-bad.material.json.meta',
      'scenes/zz-assets.scene.json',
    ]
    const cleanup = () => {
      for (const f of files) rmSync(join(example, f), { force: true })
    }
    try {
      mkdirSync(join(example, 'materials'), { recursive: true })
      writeFileSync(join(example, 'materials/zz-test.material.json'), '{ "baseColor": "#8e44ad" }')
      writeFileSync(join(example, 'materials/zz-bad.material.json'), '{ "metallic": 3 }')
      writeFileSync(
        join(example, 'scenes/zz-assets.scene.json'),
        JSON.stringify({
          version: 1,
          entities: [
            {
              name: 'thing',
              components: {
                'render/Mesh3d': { mesh: { path: 'procedural:cube' } },
                'render/MeshMaterial': { material: { path: 'materials/zz-test.material.json' } },
              },
            },
          ],
        }),
      )
      const imported = shard(['import', '--json'])
      expect(imported.code).toBe(1)
      const report = imported.json()
      expect(report.imported).toContain('materials/zz-test.material.json')
      expect(report.failed).toEqual([
        expect.objectContaining({
          path: 'materials/zz-bad.material.json',
          error: expect.objectContaining({ path: '/metallic' }),
        }),
      ])
      rmSync(join(example, 'materials/zz-bad.material.json'))
      rmSync(join(example, 'materials/zz-bad.material.json.meta'))

      const moved = shard([
        'mv',
        'materials/zz-test.material.json',
        'materials/zz-moved.material.json',
        '--json',
      ])
      expect(moved.code).toBe(0)
      expect(moved.json().rewritten).toEqual(['scenes/zz-assets.scene.json'])
      expect(readFileSync(join(example, 'scenes/zz-assets.scene.json'), 'utf8')).toContain(
        'materials/zz-moved.material.json',
      )
      expect(shard(['validate', '--json']).json()).toMatchObject({ valid: true })
    } finally {
      cleanup()
      shard(['import', '--json']) // drop the removed test files from the cache index
      try {
        rmdirSync(join(example, 'materials')) // only if empty
      } catch {}
    }
  })

  it('check reports type errors with file, line, and column', () => {
    expect(shard(['check', '--json']).json()).toMatchObject({ diagnostics: [] })
    const cleanup = temp('scripts/zz-bad-types.ts', 'export const n: number = "not a number"\n')
    try {
      const r = shard(['check', '--json'])
      expect(r.code).toBe(1)
      expect(r.json().diagnostics).toEqual([
        expect.objectContaining({
          file: 'scripts/zz-bad-types.ts',
          line: 1,
          column: 14,
          code: 'TS2322',
        }),
      ])
    } finally {
      cleanup()
    }
  })

  it('dev serves the runner with an engine import map, the bundle, and project files', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [bin, 'dev', '--port', '5199', '--json'], {
      cwd: example,
    })
    // Stops the server even when the test times out (a `finally` after a hung await never runs,
    // and the orphan outlives the worker).
    onTestFinished(() => {
      if (child.exitCode !== null) return
      child.kill('SIGINT')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 1000).unref()
    })
    try {
      const info = await new Promise<{ url: string }>((resolveInfo, reject) => {
        let out = ''
        child.stdout.on('data', (d) => {
          out += d
          try {
            resolveInfo(JSON.parse(out))
          } catch {}
        })
        child.on('exit', (code) => reject(new Error(`dev exited ${code}`)))
      })
      const html = await (await fetch(info.url)).text()
      const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)![1]!)
      expect(map.imports['@aethervtt/shard-core']).toMatch(
        /^\/@fs\/.*\/packages\/core\/src\/index\.ts$/,
      )
      const project = await (
        await fetch(new URL('/@aethervtt/shard-project.json', info.url))
      ).json()
      expect(project.manifest.name).toBe('star-explorer')
      const bundle = await (await fetch(new URL(project.bundle, info.url))).text()
      expect(bundle).toContain('from "@aethervtt/shard-core"')
      const scene = await fetch(new URL('/@aethervtt/shard-files/scenes/main.scene.json', info.url))
      expect(scene.status).toBe(200)
      // Encoded so it isn't normalized away: the files route must not serve outside the project.
      const outside = await fetch(
        new URL('/@aethervtt/shard-files/%2e%2e%2f%2e%2e%2fpackage.json', info.url),
      )
      expect(outside.status).toBe(404)
    } finally {
      child.kill('SIGINT')
    }
  })

  it('uses the documented exit codes and --json errors', () => {
    expect(shard(['nonsense']).code).toBe(3)
    expect(shard(['screenshot']).code).toBe(3)
    const missing = shard(['describe', '--json', '--project', tmpdir()])
    expect(missing.code).toBe(2)
    expect(missing.json().error.code).toBe('project/not-found')
  })
})

describe('MCP server', () => {
  let project: Awaited<ReturnType<typeof openProject>>
  let client: Client

  beforeAll(async () => {
    project = await openProject({ root: example, width: 320, height: 180 })
    const server = createMcpServer({
      root: example,
      target: () => localTarget('headless', project.server),
      runTests: async () => ({ skipped: 'not in this test' }),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: 'test', version: '0' })
    await client.connect(clientTransport)
  })
  afterAll(() => project.close())

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string }[]
      isError?: boolean
    }
    return { ...r, json: () => JSON.parse(r.content[0]!.text!) }
  }

  it('lists tools and resources', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'describe_project',
        'validate_scene',
        'screenshot',
        'patch_entity',
        'list_assets',
        'get_asset',
        'reimport_asset',
        'move_asset',
        'hold',
        'step',
        'run_tests',
        'project_status',
        'reload_project',
        'typecheck',
        'physics_raycast',
        'spawn_prefab',
        'prefab_overrides',
        'run_generator',
        'preview_generator',
        'describe_generators',
      ]),
    )
    expect(tools.find((t) => t.name === 'physics_raycast')!.inputSchema).toMatchObject({
      required: ['origin', 'direction'],
    })
    expect(tools.find((t) => t.name === 'patch_entity')!.inputSchema).toMatchObject({
      required: ['entity'],
    })
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['shard://docs/agents', 'shard://scenes/scenes/main.scene.json']),
    )
    const schema = await client.readResource({ uri: 'shard://schemas/star-explorer/Ship' })
    expect((schema.contents[0] as { text: string }).text).toContain('Speed cap')
  })

  it('runs a whole agent loop: fix a scene, load, step, look, fly, check', async () => {
    const scene = JSON.parse(readFileSync(join(example, 'scenes/main.scene.json'), 'utf8'))
    scene.entities[2].components['star-explorer/Ship'] = { acceleration: 'fast' } // a mistake to fix

    const checked = (await call('validate_scene', { json: scene })).json()
    expect(checked.valid).toBe(false)
    expect(checked.errors[0]).toMatchObject({
      path: '/entities/2/components/star-explorer~1Ship/acceleration',
    })

    scene.entities[2].components['star-explorer/Ship'] = { acceleration: 25 } // fixed from the pointer
    expect((await call('validate_scene', { json: scene })).json().valid).toBe(true)
    const loaded = (await call('load_scene', { json: scene, id: 'scenes/main.scene.json' })).json()
    expect(Object.keys(loaded.entities)).toContain('ship/camera')

    await call('step', { frames: 60 })
    const shot = await call('screenshot', { width: 160, height: 90 })
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })

    const before = (await call('get_entity', { entity: 'ship' })).json().components[
      'core/Transform'
    ].translation[2]
    await call('hold', { name: 'star-explorer/Controls.thrust' })
    await call('step', { frames: 90 })
    await call('release', { name: 'star-explorer/Controls.thrust' })
    const ship = (await call('get_entity', { entity: 'ship' })).json().components
    expect(ship['star-explorer/Ship'].speed).toBeGreaterThan(20)
    expect(ship['core/Transform'].translation[2]).toBeLessThan(before - 10)

    const patched = await call('patch_entity', {
      entity: 'ship',
      components: { 'star-explorer/Ship': { maxSpeed: -1 } },
    })
    expect(patched.isError).toBe(true)
    expect(patched.json()).toMatchObject({ code: 'protocol/invalid-components' })
  })

  it('tunes a generator: describe_generators, run_generator, preview_generator', async () => {
    const described = (await call('describe_generators')).json()
    const rock = described.generators.find((g: { name: string }) => g.name === 'star-explorer/Rock')
    expect(rock).toMatchObject({ output: 'Mesh', version: 1 })
    expect(rock.params.properties.radius).toMatchObject({ minimum: 0.05, 'x-unit': 'm' })
    const ran = (
      await call('run_generator', {
        generator: 'star-explorer/Rock',
        params: { detail: 1 },
        seed: 5,
      })
    ).json()
    expect(ran).toMatchObject({ output: 'Mesh', vertices: 42, triangles: 80, seed: 5 })
    expect(ran.path).toBe('procedural:star-explorer/Rock?detail=1&seed=5')
    const again = (
      await call('run_generator', { generator: 'Rock', params: { detail: 1 }, seed: 5 })
    ).json()
    expect(again).toMatchObject({ key: ran.key, cacheHit: true })
    const sheet = await call('preview_generator', {
      generator: 'star-explorer/Rock',
      seeds: '1-4',
      size: 64,
      params: { detail: 1 },
    })
    expect(sheet.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    const png = await decodePng(Buffer.from(sheet.content[0]!.data!, 'base64'))
    expect([png.width, png.height]).toEqual([134, 134])
    const bad = await call('run_generator', {
      generator: 'star-explorer/Rock',
      params: { radius: 0 },
    })
    expect(bad.isError).toBe(true)
    expect(bad.json()).toMatchObject({ code: 'procgen/bad-params', path: '/radius' })
  })

  it('saves and loads the game: save_game, then load_game puts it back', async () => {
    await call('load_scene', { file: 'scenes/main.scene.json', id: 'scenes/main.scene.json' })
    await call('patch_entity', {
      entity: 'ship',
      components: { 'core/Transform': { translation: [7, 8, 9] } },
    })
    const saved = (await call('save_game', { slot: 'mcp', meta: { note: 'test' } })).json()
    expect(saved.scenes['scenes/main.scene.json'].changed.ship).toEqual(['core/Transform'])
    await call('patch_entity', {
      entity: 'ship',
      components: { 'core/Transform': { translation: [0, 0, 0] } },
    })
    const loaded = (await call('load_game', { slot: 'mcp' })).json()
    expect(loaded).toMatchObject({ scenes: ['scenes/main.scene.json'], warnings: [] })
    const ship = (await call('get_entity', { entity: 'ship' })).json().components
    expect(ship['core/Transform'].translation).toEqual([7, 8, 9])
  })

  it('routes tools to a live app when one attaches (--attach)', async () => {
    const hub = new Hub()
    const port = await hub.start(0)
    const live = await openProject({ root: example, width: 64, height: 64 })
    const liveServer = createProtocolServer(live.app, { frames: 'manual' })
    const attached = new Promise<void>((resolveAttach) =>
      hub.onAttach((_, on) => on && resolveAttach()),
    )
    const disconnect = connectToHub(`ws://127.0.0.1:${port}`, liveServer, {
      name: 'playground',
      reconnect: false,
    })
    await attached
    const server = createMcpServer({
      root: example,
      target: () => hub.current() ?? localTarget('headless', project.server),
      runTests: async () => ({}),
    })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const attachedClient = new Client({ name: 'attach-test', version: '0' })
    await attachedClient.connect(c)
    const r = (await attachedClient.callTool({ name: 'describe_project', arguments: {} })) as {
      content: { text: string }[]
    }
    expect(JSON.parse(r.content[0]!.text).target).toBe('playground')
    disconnect()
    hub.close()
    live.close()
  })
})
