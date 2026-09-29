import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import { defineComponent, type Entity, type ShardError, t, World } from '@aethervtt/shard-core'
import { decodeMesh } from '@aethervtt/shard-mesh'
import { loadNoiseKernel, type NoiseGraph } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { Mesh3d, Meshes } from '@aethervtt/shard-render'
import {
  hookInstances,
  instanceEntities,
  loadScene,
  saveScene,
  settleInstances,
  validateScene,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import { Transform } from '@aethervtt/shard-transform'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalParams,
  decodeRecord,
  defineGenerator,
  encodeRecord,
  executeJob,
  findNondeterminism,
  Generated,
  GeneratorInstance,
  generate,
  guidOf,
  identityOf,
  meshBuilder,
  parseProceduralRef,
  proceduralPath,
  procgen,
  requestOf,
} from '.'

beforeAll(async () => {
  await loadNoiseKernel()
})

async function errorOf(f: () => unknown): Promise<ShardError> {
  try {
    await f()
  } catch (err) {
    return err as ShardError
  }
  throw new Error('expected an error')
}

function checksum(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

let rockRuns = 0
const Rock = defineGenerator('test/Rock', {
  params: {
    radius: t.f32({ default: 1, min: 0.05, unit: 'm' }),
    roughness: t.f32({ default: 0.3, min: 0, max: 1 }),
    detail: t.u8({ default: 2, min: 0, max: 6 }),
    shape: t.handle('NoiseGraph'),
  },
  output: 'mesh',
  run(ctx, p) {
    rockRuns++
    const mesh = ctx.mesh.icosphere(p.detail)
    const pos = mesh.positions
    const graph = p.shape ? ctx.load<NoiseGraph>(p.shape) : undefined
    const values = new Float32Array(pos.length / 3)
    if (graph) ctx.noise.sample(graph, ctx.seed, pos, values)
    else for (let i = 0; i < values.length; i++) values[i] = ctx.rng.range(-1, 1)
    for (let i = 0; i < values.length; i++) {
      const s = p.radius * (1 + p.roughness * values[i]!)
      pos[i * 3] = pos[i * 3]! * s
      pos[i * 3 + 1] = pos[i * 3 + 1]! * s
      pos[i * 3 + 2] = pos[i * 3 + 2]! * s
    }
    return ctx.mesh.finish(mesh, { normals: true, tangents: true, lods: [0.5, 0.2] })
  },
})

describe('definitions and params', () => {
  it('canonicalizes params: defaults, sorted keys, f32 precision, handles by path', () => {
    const a = canonicalParams(Rock, { radius: 1.0000000001 })
    const b = canonicalParams(Rock, { detail: 2, radius: 1 })
    expect(a).toEqual(b)
    expect(Object.keys(a)).toEqual(['detail', 'radius', 'roughness', 'shape'])
    expect(canonicalParams(Rock, { shape: { guid: 'g1', path: 'n.noise.json' } }).shape).toEqual({
      path: 'n.noise.json',
    })
  })

  it('rejects bad params with pointers', async () => {
    const err = await errorOf(() => canonicalParams(Rock, { radius: 'big' }))
    expect(err.code).toBe('procgen/bad-params')
    expect(err.path).toBe('/radius')
    expect((await errorOf(() => requestOf(Rock, {}, -1))).code).toBe('procgen/bad-params')
  })

  it('round-trips requests through procedural paths', () => {
    const request = requestOf(Rock, { radius: 2, roughness: 0.6 }, 3)
    const path = proceduralPath(request)
    expect(path).toBe('procedural:test/Rock?radius=2&roughness=0.6&seed=3')
    const back = parseProceduralRef(path.slice('procedural:'.length))
    expect(identityOf(back)).toBe(identityOf(request))
    expect(guidOf(back)).toBe(guidOf(request))
    const bad = (() => {
      try {
        parseProceduralRef('test/Rock?size=2', '/x')
      } catch (e) {
        return e as ShardError
      }
    })()!
    expect(bad.code).toBe('procgen/bad-params')
    expect(bad.path).toBe('/x')
    expect(() => parseProceduralRef('test/Nope')).toThrow(/No generator/)
  })
})

describe('mesh builder', () => {
  it('builds deterministic icospheres with LODs and tangents', () => {
    const ico = meshBuilder.icosphere(3)
    expect(ico.positions.length / 3).toBe(10 * 4 ** 3 + 2)
    const done = meshBuilder.finish(ico, { tangents: true, lods: [0.5, 0.2] })
    expect(done.lods).toHaveLength(2)
    const tris = (m: { indices?: ArrayLike<number> }) => m.indices!.length / 3
    expect(tris(done.lods[0]!)).toBeLessThanOrEqual(tris(ico) * 0.5)
    expect(tris(done.lods[1]!)).toBeLessThan(tris(done.lods[0]!))
    expect(done.mesh.tangents!.length).toBe((ico.positions.length / 3) * 4)
    const again = meshBuilder.finish(meshBuilder.icosphere(3), { tangents: true, lods: [0.5, 0.2] })
    expect(again.lods[1]!.positions).toEqual(done.lods[1]!.positions)
  })
})

describe('jobs', () => {
  it('runs the same bytes for the same seed, different for another', async () => {
    const one = await executeJob({ ...requestOf(Rock, {}, 7), deps: [], chain: [] })
    const two = await executeJob({ ...requestOf(Rock, {}, 7), deps: [], chain: [] })
    const other = await executeJob({ ...requestOf(Rock, {}, 8), deps: [], chain: [] })
    expect(one.assets.map((a) => a.label)).toEqual(['', 'LOD1', 'LOD2'])
    expect(checksum(one.assets[0]!.bytes!)).toBe(checksum(two.assets[0]!.bytes!))
    expect(checksum(one.assets[0]!.bytes!)).not.toBe(checksum(other.assets[0]!.bytes!))
    expect(decodeMesh(one.assets[0]!.bytes!).vertexCount).toBe(162)
    expect(one.assets[0]!.info).toMatchObject({
      vertices: 162,
      triangles: 320,
      lods: [expect.any(Number), expect.any(Number)],
    })
  })

  it('throws procgen/nondeterministic on Math.random and the clock, naming the generator', async () => {
    const Bad = defineGenerator('test/Bad', {
      params: { clock: t.bool() },
      output: 'data',
      run: (_ctx, p) => (p.clock ? Date.now() : Math.random()),
    })
    const err = await errorOf(() => executeJob({ ...requestOf(Bad, {}, 0), deps: [], chain: [] }))
    expect(err.code).toBe('procgen/nondeterministic')
    expect(err.message).toContain('test/Bad')
    expect(err.message).toContain('Math.random()')
    const clock = await errorOf(() =>
      executeJob({ ...requestOf(Bad, { clock: true }, 0), deps: [], chain: [] }),
    )
    expect(clock.message).toContain('Date.now()')
    // Restored afterwards.
    expect(typeof Math.random()).toBe('number')
    expect(performance.now()).toBeGreaterThan(0)
  })

  it('wraps other errors with the generator, seed, and params; checks output types', async () => {
    const Throws = defineGenerator('test/Throws', {
      params: { n: t.u32() },
      output: 'mesh',
      run: () => {
        throw new Error('boom')
      },
    })
    const err = await errorOf(() =>
      executeJob({ ...requestOf(Throws, { n: 4 }, 9), deps: [], chain: [] }),
    )
    expect(err.code).toBe('procgen/generator-failed')
    expect(err.message).toMatch(/test\/Throws failed \(seed 9, params \{"n":4\}\): boom/)
    const Wrong = defineGenerator('test/Wrong', {
      params: {},
      output: 'mesh',
      run: () => ({ nope: 1 }) as never,
    })
    const mismatch = await errorOf(() =>
      executeJob({ ...requestOf(Wrong, {}, 0), deps: [], chain: [] }),
    )
    expect(mismatch.code).toBe('procgen/output-mismatch')
  })

  it('encodes records that decode to the same assets', async () => {
    const result = await executeJob({ ...requestOf(Rock, {}, 1), deps: [], chain: [] })
    const record = { key: 'k', assets: result.assets, children: [], warnings: [], ms: 1, bytes: 0 }
    const back = decodeRecord(encodeRecord(record))!
    expect(back.assets.map((a) => checksum(a.bytes!))).toEqual(
      result.assets.map((a) => checksum(a.bytes!)),
    )
    expect(back.assets[0]!.info).toEqual(result.assets[0]!.info)
  })

  it('finds nondeterministic calls statically in generator modules', () => {
    const src = [
      "const Rock = project.generator('Rock', {",
      '  // Math.random() in a comment is fine',
      '  run: (ctx) => Math.random() + Date.now(),',
      '})',
    ].join('\n')
    expect(findNondeterminism('scripts/rock.ts', src)).toEqual([
      { file: 'scripts/rock.ts', line: 3, column: 17, call: 'Math.random()' },
      { file: 'scripts/rock.ts', line: 3, column: 33, call: 'Date.now()' },
    ])
    expect(findNondeterminism('scripts/main.ts', 'Math.random()')).toEqual([])
  })
})

describe('runtime', () => {
  it('generates meshes as virtual assets and caches them by input hash', async () => {
    const world = new World()
    rockRuns = 0
    const ref = await generate(world, Rock, { radius: 2 }, 42)
    expect(ref.type).toBe('Mesh')
    expect(ref.guid).toMatch(/^gen:/)
    const mesh = world.resource(Meshes).get(ref)!
    expect(mesh.vertexCount).toBe(162)
    const again = await generate(world, Rock, { radius: 2.0000000001 }, 42)
    expect(again.guid).toBe(ref.guid)
    expect(rockRuns).toBe(1)
    // A second world with the same records in memory is a memory hit, not a run.
    const lod = assetServer(world).entry(`${ref.guid}/LOD1`)!
    await assetServer(world).load(lod.guid)
    expect(world.resource(Meshes).get(lod)!.vertexCount).toBeLessThan(162)
    expect(rockRuns).toBe(1)
    expect(procgen(world).lastResult(ref.guid!)!.hit).toBe('run')
  })

  it('writes records to disk and reads them back in a new world', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-procgen-'))
    try {
      const platform = createNodePlatform({ root, logTo: () => {} })
      const first = new World()
      procgen(first).configure({ fs: platform.fs })
      rockRuns = 0
      const ref = await generate(first, Rock, { detail: 1 }, 5)
      // Writes are async; wait for the record.
      for (let i = 0; i < 50 && rockRuns === 1; i++) {
        const key = procgen(first).lastResult(ref.guid!)!.key!
        if (await platform.fs.exists(`.shard/cache/generated/${key.slice(0, 2)}/${key}`)) break
        await new Promise((r) => setTimeout(r, 10))
      }
      const second = new World()
      procgen(second).configure({ fs: platform.fs })
      const back = await generate(second, Rock, { detail: 1 }, 5)
      expect(rockRuns).toBe(1)
      expect(procgen(second).lastResult(back.guid!)!.hit).toBe('disk')
      expect(world2Positions(second, back.guid!)).toEqual(world2Positions(first, ref.guid!))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reruns only changed children of a generator that generates eight', async () => {
    const runs: string[] = []
    const Planet = defineGenerator('test/Planet', {
      params: { size: t.f32({ default: 1 }) },
      output: 'mesh',
      run(ctx, p) {
        runs.push(`planet ${p.size}`)
        const m = ctx.mesh.icosphere(0)
        for (let i = 0; i < m.positions.length; i++) m.positions[i]! *= p.size
        return m
      },
    })
    const System = defineGenerator('test/System', {
      params: { sizes: t.list(t.f32) },
      output: 'entities',
      async run(ctx, p) {
        runs.push('system')
        const planets = []
        for (let i = 0; i < p.sizes.length; i++) {
          const mesh = await ctx.generate(Planet, { size: p.sizes[i]! }, ctx.childSeed(i))
          planets.push({
            name: `planet-${i}`,
            components: {
              'core/Transform': { translation: [i * 4, 0, 0] },
              'render/Mesh3d': { mesh },
            },
          })
        }
        return planets
      },
    })
    const world = new World()
    hookInstances(world)
    const sizes = [1, 2, 3, 4, 5, 6, 7, 8]
    const spawnAndSettle = async (list: number[]) => {
      const e = world.spawn([
        GeneratorInstance,
        { generator: System, params: { sizes: list }, seed: 1 },
      ])
      await settleInstances(world)
      await assetServer(world).whenSettled(
        [...instanceEntities(world, e).values()].map((c) => world.get(c, Mesh3d).mesh!),
      )
      return e
    }
    const e = await spawnAndSettle(sizes)
    expect(runs.filter((r) => r === 'system')).toHaveLength(1)
    expect(runs.filter((r) => r.startsWith('planet'))).toHaveLength(8)
    expect(instanceEntities(world, e).size).toBe(8)
    runs.length = 0
    world.despawn(e)
    await spawnAndSettle([1, 2, 3, 4, 5, 6, 7, 9])
    expect(runs).toEqual(['system', 'planet 9'])
  })

  it("doesn't count an output regenerating for a dependency as stale again", async () => {
    let gate = Promise.resolve()
    let runs = 0
    const Slow = defineGenerator('test/SlowRock', {
      params: { shape: t.handle('NoiseGraph') },
      output: 'mesh',
      async run(ctx, p) {
        await gate
        runs++
        const mesh = ctx.mesh.icosphere(0)
        if (p.shape) ctx.load<NoiseGraph>(p.shape)
        return mesh
      },
    })
    const root = mkdtempSync(join(tmpdir(), 'shard-procgen-stale-'))
    try {
      mkdirSync(join(root, 'assets/noise'), { recursive: true })
      const noise = join(root, 'assets/noise/shape.noise.json')
      const graph = (frequency: number) =>
        JSON.stringify({ output: 'n', nodes: { n: { perlin: { frequency } } } })
      writeFileSync(noise, graph(2))
      const world = new World()
      const server = assetServer(world).configure({
        platform: createNodePlatform({ root, logTo: () => {} }),
        roots: ['assets'],
      })
      await server.scan()
      const shape = { path: 'assets/noise/shape.noise.json' }
      const ref = await generate(world, Slow, { shape }, 1)
      expect(runs).toBe(1)
      // The graph changes; its regeneration waits on the gate, as a slow job would.
      let open = () => {}
      gate = new Promise((resolve) => (open = resolve))
      await new Promise((r) => setTimeout(r, 20))
      writeFileSync(noise, graph(3))
      await server.scan()
      // A reload now (a script edit) must not start a second one for the same change.
      expect(procgen(world).regenerateStale()).toEqual([])
      open()
      for (let i = 0; i < 100 && runs < 2; i++) await new Promise((r) => setTimeout(r, 5))
      expect(runs).toBe(2)
      expect(procgen(world).regenerateStale()).toEqual([])
      expect(server.entry(ref.guid!)!.state).toBe('loaded')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function world2Positions(world: World, guid: string): number[] {
  return Array.from(world.resource(Meshes).byGuid(guid)!.positions)
}

describe('GeneratorInstance', () => {
  const Field = defineGenerator('test/Field', {
    params: { count: t.u32({ default: 3, max: 64 }) },
    output: 'entities',
    run(ctx, p) {
      const out = []
      for (let i = 0; i < p.count; i++)
        out.push({
          name: `rock-${i}`,
          components: {
            'core/Transform': { translation: [ctx.rng.range(-10, 10), 0, 0] },
          },
        })
      return out
    },
  })
  const Target = defineComponent('test/Target', { target: t.entity() })

  it('spawns the fragment, regenerates on patch, and keeps ids of unchanged paths', async () => {
    const world = new World()
    hookInstances(world)
    const e = world.spawn([GeneratorInstance, { generator: Field, seed: 1 }], [Transform, {}])
    await settleInstances(world)
    const first = instanceEntities(world, e)
    expect([...first.keys()]).toEqual(['rock-0', 'rock-1', 'rock-2'])
    expect(world.has(first.get('rock-0')!, Generated)).toBe(true)
    const pointer = world.spawn([Target, { target: first.get('rock-1')! }])
    const x0 = world.get(first.get('rock-0')!, Transform).translation[0]
    world.set(e, GeneratorInstance, { seed: 2, params: { count: 4 } })
    await settleInstances(world)
    const second = instanceEntities(world, e)
    expect([...second.keys()]).toEqual(['rock-0', 'rock-1', 'rock-2', 'rock-3'])
    expect(second.get('rock-1')).toBe(first.get('rock-1'))
    expect(world.get(pointer, Target).target).toBe(first.get('rock-1'))
    expect(world.get(second.get('rock-0')!, Transform).translation[0]).not.toBe(x0)
    world.set(e, GeneratorInstance, { params: { count: 2 } })
    await settleInstances(world)
    const third = instanceEntities(world, e)
    expect([...third.keys()]).toEqual(['rock-0', 'rock-1'])
    expect(world.isAlive(second.get('rock-3')! as Entity)).toBe(false)
  })

  it('validates params in scenes and saves no generated children', async () => {
    const world = new World()
    const bad = validateScene(world, {
      version: 1,
      entities: [
        {
          name: 'field',
          components: {
            'procgen/GeneratorInstance': {
              generator: { path: 'test/Field' },
              params: { count: 999 },
            },
          },
        },
      ],
    })
    expect(bad.map((e) => e.code)).toEqual(['procgen/bad-params'])
    expect(bad[0]!.path).toBe('/entities/0/components/procgen~1GeneratorInstance/params/count')
    const scene = {
      version: 1,
      entities: [
        {
          name: 'field',
          components: {
            'procgen/GeneratorInstance': { generator: { path: 'test/Field' }, seed: 3 },
          },
        },
      ],
    }
    expect(validateScene(world, scene)).toEqual([])
    loadScene(world, scene, { id: 's' })
    await whenSceneReady(world, 's')
    const field = [...world.query({ with: [GeneratorInstance] }).tables[0]!.entities][0]! as Entity
    expect(instanceEntities(world, field).size).toBe(3)
    const saved = saveScene(world, 's')
    expect(saved.entities).toHaveLength(1)
    expect(saved.entities[0]!.children).toBeUndefined()
    expect(saved.entities[0]!.components!['procgen/GeneratorInstance']).toEqual({
      generator: { path: 'test/Field' },
      seed: 3,
    })
  })
})

describe('procedural refs', () => {
  it('resolves generator refs in scenes; equal canonical params share one asset', async () => {
    const world = new World()
    const scene = {
      version: 1,
      entities: [
        {
          name: 'a',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:test/Rock?seed=3&radius=2' } },
          },
        },
        {
          name: 'b',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:test/Rock?radius=2.0000000001&seed=3' } },
          },
        },
      ],
    }
    expect(validateScene(world, scene)).toEqual([])
    const bad = validateScene(world, {
      version: 1,
      entities: [
        {
          name: 'a',
          components: { 'render/Mesh3d': { mesh: { path: 'procedural:test/Rock?size=1' } } },
        },
      ],
    })
    expect(bad.map((e) => e.code)).toEqual(['procgen/bad-params'])
    const handle = loadScene(world, scene, { id: 'p' })
    await whenSceneReady(world, 'p')
    const a = world.get(handle.entities.get('a')!, Mesh3d).mesh!
    const b = world.get(handle.entities.get('b')!, Mesh3d).mesh!
    expect(a.guid).toBe(b.guid)
    expect(world.resource(Meshes).get(a)!.vertexCount).toBe(162)
  })
})

describe('importer', () => {
  it('imports *.gen.json as the output type; cache hits and re-imports on inputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-gen-import-'))
    try {
      mkdirSync(join(root, 'generators'), { recursive: true })
      mkdirSync(join(root, 'assets/noise'), { recursive: true })
      writeFileSync(
        join(root, 'assets/noise/shape.noise.json'),
        JSON.stringify({ output: 'n', nodes: { n: { perlin: { frequency: 2 } } } }),
      )
      const file = join(root, 'generators/boulder.gen.json')
      writeFileSync(
        file,
        JSON.stringify({
          generator: 'test/Rock',
          seed: 4,
          params: { radius: 2, shape: { path: 'assets/noise/shape.noise.json' } },
        }),
      )
      const platform = createNodePlatform({ root, logTo: () => {} })
      const world = new World()
      const server = assetServer(world).configure({ platform, roots: ['assets', 'generators'] })
      rockRuns = 0
      const report = await server.scan()
      expect(report.failed).toEqual([])
      expect(report.imported).toContain('generators/boulder.gen.json')
      expect(rockRuns).toBe(1)
      const entry = server.entry('generators/boulder.gen.json')!
      expect(entry.type).toBe('Mesh')
      expect(server.entry('generators/boulder.gen.json#LOD1')!.type).toBe('Mesh')
      expect(server.entry('generators/boulder.gen.json#Generator')!.type).toBe('Generator')
      await server.load(entry.guid)
      expect(world.resource(Meshes).get(entry)!.vertexCount).toBe(162)
      // Unchanged: no run.
      await server.scan()
      expect(rockRuns).toBe(1)
      // The noise graph changed: re-run.
      await new Promise((r) => setTimeout(r, 20))
      writeFileSync(
        join(root, 'assets/noise/shape.noise.json'),
        JSON.stringify({ output: 'n', nodes: { n: { perlin: { frequency: 3 } } } }),
      )
      await server.scan()
      expect(rockRuns).toBe(2)
      // A param changed: re-run.
      writeFileSync(
        file,
        JSON.stringify({ generator: 'test/Rock', seed: 4, params: { radius: 3 } }),
      )
      await server.scan()
      expect(rockRuns).toBe(3)
      // Bad params fail with a pointer into the file.
      writeFileSync(file, JSON.stringify({ generator: 'test/Rock', params: { radius: -1 } }))
      const failed = await server.scan()
      expect(failed.failed[0]!.error).toMatchObject({
        code: 'procgen/bad-params',
        path: '/params/radius',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
