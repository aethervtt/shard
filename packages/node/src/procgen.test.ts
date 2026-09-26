import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PerformanceObserver } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@shard/assets'
import { ChildOf, type Entity, type World } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { encodeMesh } from '@shard/mesh'
import {
  executeJob,
  findGenerator,
  GeneratorInstance,
  procgen,
  procgenHost,
  procgenMainThreadMs,
  requestOf,
  warmGeneratorWorkers,
} from '@shard/procgen'
import { Meshes } from '@shard/render'
import { captureGame, loadGame } from '@shard/save'
import {
  currentOverrides,
  instanceEntities,
  loadScene,
  SceneMember,
  settleInstances,
  whenSceneReady,
} from '@shard/scene'
import { GlobalTransform } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type HeadlessProject, openProject } from './index'

/**
 * The world by scene path (ids differ after a load): saved components with parents as paths,
 * instances' overrides as a save would write them, and world transforms.
 */
function stateHash(world: World): string {
  const rows: string[] = []
  for (const table of world.allTables()) {
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]! as Entity
      const path = world.tryGet(e, SceneMember)?.path
      if (!path) continue
      const out: Record<string, unknown> = {}
      for (const def of table.components) {
        if (!def.saved && def !== GlobalTransform && def !== ChildOf) continue
        const json = def.serialize(table.readComponent(def, row)) as Record<string, unknown>
        if (def === ChildOf) json.parent = world.tryGet(json.parent as Entity, SceneMember)?.path
        if (def === GeneratorInstance) json.overrides = currentOverrides(world, e)
        if (def === GlobalTransform) json.matrix = Array.from(world.get(e, GlobalTransform).matrix)
        out[def.name] = json
      }
      // A scene's own assets (`#stone`) get new runtime guids each load: compare them by path.
      rows.push(
        JSON.stringify([path, out], (k, v) =>
          k === 'guid' && typeof v === 'string' && v.startsWith('mem:') ? undefined : v,
        ),
      )
    }
  }
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

const example = resolve(fileURLToPath(import.meta.url), '../../../../examples/star-explorer')

let gpu: GpuContext
let root: string
let project: HeadlessProject

const call = async (method: string, params?: unknown) => {
  const r = await project.server.handle({ jsonrpc: '2.0', id: 1, method, params })
  if (r!.error) throw new Error(JSON.stringify(r!.error))
  return r!.result as never
}
const edit = (file: string, from: string, to: string) => {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) throw new Error(`"${from}" not in ${file}`)
  writeFileSync(path, text.replace(from, to))
}

function checksum(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  // Inside the example, so `@shard/*` resolves through its node_modules.
  root = mkdtempSync(join(example, '.shard', 'procgen-'))
  for (const dir of [
    'scripts',
    'scenes',
    'data',
    'prefabs',
    'assets',
    'generators',
    'locales',
    'shard.json',
    'package.json',
    'tsconfig.json',
  ]) {
    cpSync(join(example, dir), join(root, dir), { recursive: true })
  }
  project = await openProject({ root, gpu, width: 64, height: 36, loadStartScene: false })
})
afterAll(() => {
  project?.close()
  gpu.destroy()
  rmSync(root, { recursive: true, force: true })
})

describe('generators in a project', () => {
  it('imports generators/boulder.gen.json on the worker pool, the same bytes as inline', async () => {
    expect(procgenHost().workerModule).toMatch(/procgen-worker\.[0-9a-f]+\.mjs$/)
    expect(project.platform.workers!.size).toBeGreaterThan(0)
    const server = project.assets
    const entry = server.entry('generators/boulder.gen.json')!
    expect(entry.type).toBe('Mesh')
    await server.load(entry.guid)
    const mesh = project.app.world.resource(Meshes).get(entry)!
    expect(mesh.vertexCount).toBe(10 * 4 ** 4 + 2)
    const pooled = (await server.artifact(entry.guid)).bytes!
    // The same job inline, on this thread.
    const Rock = findGenerator('star-explorer/Rock')!
    const noise = server.entry('assets/noise/rock.noise.json')!
    const inline = await executeJob({
      ...requestOf(Rock, { radius: 2, roughness: 0.45, detail: 4 }, 3),
      deps: [
        {
          guid: noise.guid,
          path: noise.path,
          type: 'NoiseGraph',
          artifact: await server.artifact(noise.guid),
        },
      ],
      chain: [],
    })
    expect(checksum(inline.assets[0]!.bytes!)).toBe(checksum(pooled))
    expect(checksum(encodeMesh(mesh))).toBe(checksum(pooled))
  })

  it('a prefab uses the generated mesh', async () => {
    loadScene(
      project.app.world,
      JSON.parse(readFileSync(join(root, 'scenes/rocks.scene.json'), 'utf8')),
      {
        id: 'rocks',
      },
    )
    await whenSceneReady(project.app.world, 'rocks')
    const boulder = (await call('entity.get', { entity: 'boulder' })) as {
      components: Record<string, { mesh?: { path: string } }>
    }
    expect(boulder.components['render/Mesh3d']!.mesh!.path).toBe('generators/boulder.gen.json')
  })

  it('re-imports on a param, the seed, a helper module, or the noise graph, and not otherwise', async () => {
    const server = project.assets
    const runs = () => server.info('generators/boulder.gen.json').key
    const before = runs()
    expect((await server.scan()).imported).toEqual([])
    edit('generators/boulder.gen.json', '"roughness": 0.45', '"roughness": 0.5')
    expect((await server.scan()).imported).toEqual(['generators/boulder.gen.json'])
    edit('generators/boulder.gen.json', '"seed": 3', '"seed": 4')
    expect((await server.scan()).imported).toEqual(['generators/boulder.gen.json'])
    edit('assets/noise/rock.noise.json', '"frequency": 3.5', '"frequency": 3.6')
    const noise = await server.scan()
    expect(noise.imported).toEqual(['assets/noise/rock.noise.json', 'generators/boulder.gen.json'])
    expect(runs()).not.toBe(before)
    // An unrelated script (the entry's systems): code hashes don't change, nothing regenerates.
    edit(
      'scripts/main.ts',
      'speed[i]! + acceleration[i]! * dt',
      'speed[i]! + acceleration[i]! * dt * 2',
    )
    const unrelated = (await call('project.reload')) as {
      ok: boolean
      procgen: { regenerated: string[] }
    }
    expect(unrelated.ok).toBe(true)
    expect(unrelated.procgen.regenerated).toEqual([])
    // A helper Rock imports: every Rock output regenerates.
    edit(
      'scripts/displace.ts',
      'radius * (1 + roughness * n[i]!)',
      'radius * (1 + roughness * n[i]! * 0.9)',
    )
    const helper = (await call('project.reload')) as {
      ok: boolean
      procgen: { regenerated: string[] }
    }
    expect(helper.ok).toBe(true)
    expect(helper.procgen.regenerated).toContain('generators/boulder.gen.json')
    expect(
      helper.procgen.regenerated.some((p) => p.startsWith('procedural:star-explorer/Rock?')),
    ).toBe(true)
  })

  it('patching a GeneratorInstance seed over the protocol regenerates it, keeping ids', async () => {
    const world = project.app.world
    await settleInstances(world)
    const field = (await call('entity.get', { entity: 'field' })) as { id: Entity }
    const before = instanceEntities(world, field.id)
    expect(before.size).toBe(24)
    await call('entity.patch', {
      entity: 'field',
      components: {
        'procgen/GeneratorInstance': {
          seed: 8,
          params: {
            count: 20,
            radius: 14,
            material: { path: 'assets/materials/stone.material.json' },
          },
        },
      },
    })
    const request = requestOf(
      findGenerator('star-explorer/AsteroidField')!,
      { count: 20, radius: 14, material: { path: 'assets/materials/stone.material.json' } },
      8,
    )
    const entry = procgen(world).entryFor(request)
    await assetServer(world).load(entry.guid)
    // The instance respawned as the output loaded: within the frame, before any update.
    const after = instanceEntities(world, field.id)
    expect(after.size).toBe(20)
    for (const [path, id] of after) expect(before.get(path)).toBe(id)
    expect(world.get(field.id, GeneratorInstance).seed).toBe(8)
  })

  it('saves the instance without its generated children and loads to the same world state', async () => {
    const world = project.app.world
    await settleInstances(world)
    // A runtime change to a generated rock is saved as the instance's override.
    await call('entity.patch', {
      entity: 'field/rock-2',
      components: { 'core/Transform': { translation: [1, 2, 3] } },
    })
    project.app.update(1 / 60)
    const save = captureGame(world)
    const changed = save.scenes.rocks!.changed.field!['procgen/GeneratorInstance'] as {
      seed: number
      overrides: Record<string, unknown>
    }
    expect(changed.seed).toBe(8)
    expect(changed.overrides).toEqual({
      'rock-2': { 'core/Transform': { translation: [1, 2, 3] } },
    })
    expect(Object.keys(save.scenes.rocks!.changed).some((p) => p.startsWith('field/'))).toBe(false)
    expect(save.spawned.some((e) => JSON.stringify(e).includes('rock-'))).toBe(false)
    const before = stateHash(world)
    await loadGame(world, JSON.parse(JSON.stringify(save)))
    await settleInstances(world)
    project.app.update(1 / 60)
    expect(stateHash(world)).toBe(before)
    const rock = (await call('entity.get', { entity: 'field/rock-2' })) as {
      components: Record<string, { translation: number[] }>
    }
    expect(rock.components['core/Transform']!.translation).toEqual([1, 2, 3])
  })

  it('generates 200 rocks on the pool with under 2 ms of main-thread procgen work per frame', async () => {
    const world = project.app.world
    const Rock = findGenerator('star-explorer/Rock')!
    // Thread startup and first-use compilation of the result path happen once per process; the
    // budget is for steady state.
    await warmGeneratorWorkers()
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => procgen(world).generate(Rock, { detail: 4 }, 500 + i)),
    )
    // GC pauses land in whatever runs when they strike: they're the VM's, not procgen's.
    const gcs: [number, number][] = []
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) gcs.push([e.startTime, e.startTime + e.duration])
    })
    observer.observe({ entryTypes: ['gc'] })
    const gcWithin = (from: number, to: number) => {
      // Entries arrive asynchronously; take the ones not yet delivered too.
      for (const e of observer.takeRecords()) gcs.push([e.startTime, e.startTime + e.duration])
      let ms = 0
      for (const [a, b] of gcs) ms += Math.max(0, Math.min(b, to) - Math.max(a, from))
      return ms
    }
    const runs = procgen(world).stats.runs
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < 200; i++) {
      pending.push(procgen(world).generate(Rock, { detail: 4, radius: 1 + i * 0.001 }, 1000 + i))
    }
    let done = false
    void Promise.all(pending).then(() => {
      done = true
    })
    const perFrame: number[] = []
    let frames = 0
    let last = procgenMainThreadMs()
    while (!done && frames < 10_000) {
      project.app.update(1 / 60)
      // Between two frames: job results arrive, get hashed, cached, and turned into meshes.
      const from = performance.now()
      await new Promise((r) => setImmediate(r))
      const now = procgenMainThreadMs()
      perFrame.push(now - last - gcWithin(from, performance.now()))
      last = now
      frames++
    }
    observer.disconnect()
    await Promise.all(pending)
    expect(procgen(world).stats.runs - runs).toBe(200)
    expect(frames).toBeGreaterThan(10) // spread over frames, not done in one
    const sorted = perFrame.sort((a, b) => a - b)
    if (process.env.SHARD_BENCH) {
      // Serial, cores to itself: every frame.
      expect(sorted.at(-1)!).toBeLessThan(2)
    } else {
      // Parallel runs share cores with other files' workers, which stretches a step now and then.
      expect(sorted[Math.floor(sorted.length * 0.99)]!).toBeLessThan(budget(2))
      expect(sorted.at(-1)!).toBeLessThan(30)
    }
  })
})
