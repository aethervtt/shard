// Measurements for Risen's regions (specs/research/regions-terrain-2026-11-15.md): the bake at
// 20 480 × 16 384 m at 1 m (near and ahead), many anchors kilometres apart, f32 precision 10 km
// out, and colliders and nav for agents 160 m from a player. Not a test: run it on a quiet machine
// with `SHARD_MEASURE=regions SHARD_MEASURE_OUT=<file.json> pnpm exec vitest run
// src/regions.measure.test.ts` in apps/cli. It writes what it measured to the file.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProfilerResource, type World } from '@aethervtt/shard-core'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { findPath, NavAgent, NavAgentState, NavMesh, navPlugin } from '@aethervtt/shard-nav'
import { buildGeneratorWorker } from '@aethervtt/shard-node'
import { NoiseGraph } from '@aethervtt/shard-noise'
import { CharacterController, CharacterIntent, CharacterState } from '@aethervtt/shard-physics'
import { createNodePlatform, createNodeWorkers } from '@aethervtt/shard-platform-node'
import { configureProcgenHost } from '@aethervtt/shard-procgen'
import { captureView } from '@aethervtt/shard-render'
import {
  bakeNearPage,
  bakeTerrain,
  fsPackStore,
  mainNoise,
  parseTerrainSource,
  terrainHeightAt,
  terrainLayout,
  tilesOf,
} from '@aethervtt/shard-terrain'
import {
  groundSource,
  groundStack,
  heightfieldApp,
  lookAtTerrain,
  NEAR_GRAIN,
  settleHeightfield,
  untilStreaming,
} from '@aethervtt/shard-terrain/testing'
import { FloatingOrigin, placeInGrid, Transform, worldPosition64 } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const skip = process.env.SHARD_MEASURE !== 'regions'
const results: Record<string, unknown> = {}
const threads = Math.max(1, availableParallelism() - 1)
const workers = createNodeWorkers(threads)
const scratch = mkdtempSync(join(tmpdir(), 'shard-regions-'))
let grain: NoiseGraph

const REGION = { ...groundSource(), size: [20480, 16384] }
const mb = (bytes: number) => Math.round((bytes / 1e6) * 10) / 10
const ms = (v: number) => Math.round(v * 100) / 100

beforeAll(async () => {
  if (skip) return
  await groundStack()
  grain = await NoiseGraph.create(NEAR_GRAIN)
  const bundle = await buildGeneratorWorker({
    root: join(here, '../../../packages/terrain'),
    entry: 'src/heightfield/fixtures/ground.ts',
    outDir: join(scratch, 'build'),
  })
  configureProcgenHost({ workers, workerModule: bundle.url })
}, 120_000)

afterAll(() => {
  configureProcgenHost({ workers: undefined, workerModule: undefined })
  workers.dispose()
  rmSync(scratch, { recursive: true, force: true })
  if (!skip && process.env.SHARD_MEASURE_OUT)
    writeFileSync(process.env.SHARD_MEASURE_OUT, `${JSON.stringify(results, null, 2)}\n`)
})

async function frames(p: { app: { update(dt: number): void } }, n: number, yieldEvery = 4) {
  for (let f = 0; f < n; f++) {
    p.app.update(1 / 60)
    if (f % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0))
  }
}

function walker(w: World, terrain: number, at: [number, number, number], floating = true) {
  const c = w.spawn(
    [CharacterController, { radius: 0.35, height: 1.8 }],
    [CharacterIntent, {}],
    [CharacterState, {}],
    Transform,
    ...(floating ? [FloatingOrigin] : []),
  )
  placeInGrid(w, c, terrain as never, at)
  return c
}

describe.skipIf(skip)('regions: measurements', () => {
  it('the bake at 20 480 × 16 384 m, 1 m: near and ahead', async () => {
    const { source, stack } = await groundStack(REGION)
    const layout = terrainLayout(source)
    const noise = mainNoise()
    // Per page on this thread: the generator alone, then a leaf and a parent.
    const area = new Float64Array(67 * 67)
    let t = performance.now()
    for (let k = 0; k < 50; k++)
      noise.generator!(stack.generators[0]!).heights(k * 64, 0, 1, 67, 67, area)
    const generatorNs = ((performance.now() - t) * 1e6) / (50 * 67 * 67)
    t = performance.now()
    for (let k = 0; k < 50; k++) bakeNearPage(noise, stack, layout, layout.depth, k, 7)
    const leafMs = (performance.now() - t) / 50
    t = performance.now()
    for (let k = 0; k < 20; k++) bakeNearPage(noise, stack, layout, layout.depth - 2, k, 3)
    const parentMs = (performance.now() - t) / 20
    // Near: from nothing to streaming (the resident levels), then a character's ground.
    const rss0 = process.memoryUsage().rss
    t = performance.now()
    const p = await heightfieldApp(undefined, {
      source: REGION,
      noise: { grain },
      physics: true,
      workers,
    })
    await untilStreaming(p)
    const toStream = performance.now() - t
    const rt = p.runtime()
    const near = rt.pages!.near!
    const resident = { depth: rt.residentDepth, pages: near.stats.parents }
    const h = terrainHeightAt(p.world, p.terrain, 12_345, 9_876).height
    const c = walker(p.world, p.terrain, [12_345, h + 1.5, 9_876])
    t = performance.now()
    await frames(p, 3, 1)
    const firstTileMs = performance.now() - t
    // A minute of walking at 6 m/s, then what's held.
    p.world.set(c, CharacterIntent, { move: [6, 0, 0] })
    await frames(p, 3600)
    const pages = [...rt.pages!.pages()]
    let pageBytes = 0
    for (const page of pages)
      pageBytes +=
        page.heights.byteLength +
        page.normals.byteLength +
        page.control.byteLength +
        (page.texels?.byteLength ?? 0)
    const nearResult = {
      toStreamingMs: Math.round(toStream),
      resident,
      firstTileFrames: 3,
      firstTileMs: Math.round(firstTileMs),
      afterWalk: {
        leaves: near.stats.leaves,
        parents: near.stats.parents,
        bakedInline: tilesOf(rt).bakedInline,
        queuedPeak: near.stats.queuedPeak,
        msPerLeafOnPool: ms(near.stats.leafMs / Math.max(1, near.stats.leaves)),
        msPerParentOnPool: ms(near.stats.parentMs / Math.max(1, near.stats.parents)),
        pagesHeld: pages.length,
        pageMB: mb(pageBytes),
        rssMB: mb(process.memoryUsage().rss - rss0),
      },
    }
    await p.app.dispose()
    // Ahead: the whole terrain into packs, on the pool.
    const platform = createNodePlatform({ root: scratch, logTo: () => {} })
    const store = fsPackStore(platform.fs, 'packs')
    const rss1 = process.memoryUsage().rss
    let peak = rss1
    const watch = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 200)
    t = performance.now()
    const report = await bakeTerrain({ source, layout, deps: {}, hash: 'region' }, stack, store, {
      workers,
    })
    const aheadMs = performance.now() - t
    clearInterval(watch)
    let disk = 0
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const f = join(dir, e.name)
        if (e.isDirectory()) await walk(f)
        else disk += statSync(f).size
      }
    }
    await walk(join(scratch, 'packs'))
    results.bake = {
      size: source.size,
      spacing: source.spacing,
      depth: layout.depth,
      leaves: layout.leavesX * layout.leavesZ,
      threads,
      generatorNsPerSample: ms(generatorNs),
      inline: { msPerLeaf: ms(leafMs), msPerParent: ms(parentMs) },
      near: nearResult,
      ahead: {
        blocks: report.blocks,
        ms: Math.round(aheadMs),
        msPerBlockOnPool: Math.round(report.msPerBlock),
        diskMB: mb(disk),
        peakRssMB: mb(peak - rss1),
      },
    }
  }, 3_600_000)

  it('survivors kilometres apart as anchors', async () => {
    const out: Record<string, unknown> = {}
    for (const count of [1, 8]) {
      const p = await heightfieldApp(undefined, {
        source: REGION,
        noise: { grain },
        physics: true,
        workers,
      })
      await untilStreaming(p)
      const w = p.world
      const rt = p.runtime()
      const chars = []
      for (let i = 0; i < count; i++) {
        // On a 4 × 2 grid 4 km apart, each walking its own way.
        const x = 2_500 + (i % 4) * 4_000
        const z = 4_000 + Math.floor(i / 4) * 8_000
        const h = terrainHeightAt(w, p.terrain, x, z).height
        const c = walker(w, p.terrain, [x, h + 1.5, z], i === 0)
        chars.push(c)
      }
      await frames(p, 120)
      for (const [i, c] of chars.entries()) {
        const a = (i / count) * Math.PI * 2
        w.set(c, CharacterIntent, { move: [6 * Math.cos(a), 0, 6 * Math.sin(a)] })
      }
      const profiler = w.resource(ProfilerResource)
      const spans = ['terrain/heightfields', 'physics/step', 'frame']
      const sums = Object.fromEntries(spans.map((s) => [s, 0]))
      const worst = Object.fromEntries(spans.map((s) => [s, 0]))
      const n = 1800
      const t = performance.now()
      for (let f = 0; f < n; f++) {
        const f0 = performance.now()
        p.app.update(1 / 60)
        const frame = performance.now() - f0
        for (const s of spans) {
          const v = s === 'frame' ? frame : (profiler.timing(s)?.last ?? 0)
          sums[s]! += v
          worst[s] = Math.max(worst[s]!, v)
        }
        if (f % 4 === 0) await new Promise((r) => setTimeout(r, 0))
      }
      const wall = performance.now() - t
      const near = rt.pages!.near!
      const tiles = tilesOf(rt)
      out[`${count}`] = {
        frames: n,
        wallMsPerFrame: ms(wall / n),
        meanMs: Object.fromEntries(spans.map((s) => [s, ms(sums[s]! / n)])),
        worstMs: Object.fromEntries(spans.map((s) => [s, ms(worst[s]!)])),
        colliderTiles: [...tiles.tiles.values()].filter((t) => t.entity >= 0).length,
        tilesBakedInline: tiles.bakedInline,
        leavesBaked: near.stats.leaves,
        leafMsOnPool: ms(near.stats.leafMs),
        pagesHeld: rt.pages!.cached,
      }
      await p.app.dispose()
    }
    results.anchors = out
  }, 1_800_000)

  it('f32 precision 10 km from the origin', async () => {
    // Physics: a character standing, then walking, on the same ground at the origin and 10 km and
    // 20 km out, with and without a floating origin.
    const physics: Record<string, unknown> = {}
    for (const [label, at, floating] of [
      ['origin', [0, 0, 0], false],
      ['10km', [10_000, 0, 10_000], false],
      ['20km', [20_000, 0, 10_000], false],
      ['10km, floating origin', [10_000, 0, 10_000], true],
    ] as const) {
      const p = await heightfieldApp(undefined, {
        source: groundSource(),
        noise: { grain },
        physics: true,
        at: [at[0], 0, at[2]],
      })
      await untilStreaming(p)
      const w = p.world
      // The terrain's own point (300, 300) is world (at + 300).
      const h = terrainHeightAt(w, p.terrain, 300, 300).height
      const c = walker(w, p.terrain, [300, h + 1.2, 300], floating)
      await frames(p, 120)
      const pos = new Float64Array(3)
      const ys: number[] = []
      for (let f = 0; f < 120; f++) {
        p.app.update(1 / 60)
        worldPosition64(w, c, pos, p.terrain)
        ys.push(pos[1]! - terrainHeightAt(w, p.terrain, pos[0]!, pos[2]!).height)
      }
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length
      const jitter = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length)
      w.set(c, CharacterIntent, { move: [0, 0, 4] })
      await frames(p, 600)
      worldPosition64(w, c, pos, p.terrain)
      physics[label] = {
        worldX: at[0] + 300,
        standing: {
          aboveGround: Number(mean.toFixed(5)),
          jitterMm: Number((jitter * 1000).toFixed(3)),
        },
        afterWalk: [
          Number(pos[0]!.toFixed(4)),
          Number(pos[1]!.toFixed(4)),
          Number(pos[2]!.toFixed(4)),
        ],
      }
      await p.app.dispose()
    }
    // Rendering: the same view at the origin and 10 km out, with and without a floating origin on
    // the camera (heightfieldApp's camera has one; without it, the camera's Transform is raw f32).
    const gpu = await createNodeGpuContext()
    const shots: Record<string, Uint8Array> = {}
    for (const [label, offset, floating] of [
      ['origin', 0, true],
      ['10km, floating origin', 10_000, true],
      ['10km, no floating origin', 10_000, false],
    ] as const) {
      const p = await heightfieldApp(gpu, {
        source: groundSource(),
        noise: { grain },
        width: 160,
        heightPx: 96,
        at: [offset, 0, offset],
      })
      if (!floating) p.world.remove(p.camera, FloatingOrigin)
      await untilStreaming(p)
      const h = terrainHeightAt(p.world, p.terrain, 1000, 1000).height
      lookAtTerrain(p, [990, h + 3, 990], [1010, h, 1010])
      await settleHeightfield(p)
      const shot = captureView(p.world, p.view)
      p.app.update(1 / 60)
      shots[label] = (await shot).data
      await p.app.dispose()
    }
    const diff = (a: Uint8Array, b: Uint8Array) => {
      let sum = 0
      let max = 0
      let n = 0
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i]! - b[i]!),
          Math.abs(a[i + 1]! - b[i + 1]!),
          Math.abs(a[i + 2]! - b[i + 2]!),
        )
        sum += d
        max = Math.max(max, d)
        if (d > 8) n++
      }
      return { mean: Number((sum / (a.length / 4)).toFixed(3)), max, pixelsOver8: n }
    }
    results.precision = {
      physics,
      render: {
        '10km, floating origin vs origin': diff(shots.origin!, shots['10km, floating origin']!),
        '10km, no floating origin vs origin': diff(
          shots.origin!,
          shots['10km, no floating origin']!,
        ),
      },
    }
    await gpu.device.queue.onSubmittedWorkDone()
    gpu.destroy()
  }, 600_000)

  it('colliders and nav for agents 160 m from a player', async () => {
    results.reach = {}
    // Across the 1 000 m line between two 2 km grid cells (centred cells: 0 spans ±1 000 m), and
    // all inside one cell.
    for (const centre of [
      [1024, 1024],
      [500, 500],
    ] as [number, number][])
      await reachFrom(centre)
  }, 600_000)
})

async function reachFrom(centre: [number, number]) {
  {
    const p = await heightfieldApp(undefined, {
      source: groundSource(),
      noise: { grain },
      physics: true,
      workers,
      extra: [navPlugin],
    })
    await untilStreaming(p)
    const w = p.world
    const rt = p.runtime()
    const hp = terrainHeightAt(w, p.terrain, centre[0], centre[1]).height
    walker(w, p.terrain, [centre[0], hp + 1.2, centre[1]])
    const agents = []
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      const x = centre[0] + 160 * Math.cos(a)
      const z = centre[1] + 160 * Math.sin(a)
      const h = terrainHeightAt(w, p.terrain, x, z).height
      const e = w.spawn(
        [CharacterController, { radius: 0.35, height: 1.8 }],
        [CharacterIntent, {}],
        [CharacterState, {}],
        [NavAgent, { speed: 3, stoppingDistance: 2, drive: 'character' }],
        [NavAgentState, {}],
        Transform,
      )
      placeInGrid(w, e, p.terrain, [x, h + 1.2, z])
      agents.push(e)
    }
    await frames(p, 10)
    const tilesBefore = [...tilesOf(rt).tiles.values()].filter((t) => t.entity >= 0).length
    const lo = new Float64Array(3)
    const hi = new Float64Array(3)
    rt.frame.pointToOrigin(centre[0] - 260, 0, centre[1] - 260, lo)
    rt.frame.pointToOrigin(centre[0] + 260, 300, centre[1] + 260, hi)
    w.spawn([
      NavMesh,
      {
        agentRadius: 0.4,
        agentHeight: 1.8,
        maxSlope: 40,
        maxClimb: 0.5,
        cellSize: 0.3,
        cellHeight: 0.15,
        tileSize: 64,
        boundsMin: [lo[0]!, lo[1]!, lo[2]!],
        boundsMax: [hi[0]!, hi[1]!, hi[2]!],
      },
    ])
    const t0 = performance.now()
    await frames(p, 240)
    const navMs = performance.now() - t0
    const goal = new Float64Array(3)
    rt.frame.pointToOrigin(centre[0], hp, centre[1], goal)
    const start = new Float64Array(3)
    const paths = agents.map((e) => {
      worldPosition64(w, e, start)
      return findPath(w, start, goal).status
    })
    for (const e of agents)
      w.set(e, NavAgent, { ...w.get(e, NavAgent), destination: [goal[0]!, goal[1]!, goal[2]!] })
    await frames(p, 60 * 80)
    const arrived = agents.filter((e) => w.get(e, NavAgentState).status === 'arrived').length
    const fell = agents.filter((e) => {
      const pos = worldPosition64(w, e, new Float64Array(3), p.terrain)
      return pos[1]! < terrainHeightAt(w, p.terrain, pos[0]!, pos[2]!).height - 1
    }).length
    const remaining = agents.map((e) => {
      const pos = worldPosition64(w, e, new Float64Array(3), p.terrain)
      return Math.round(Math.hypot(pos[0]! - centre[0], pos[2]! - centre[1]) * 10) / 10
    })
    ;(results.reach as Record<string, unknown>)[centre.join(',')] = {
      remainingM: remaining,
      states: agents.map((e) => w.get(e, NavAgentState).status),
      colliderRadius: rt.settings!.colliderRadius,
      agents: agents.length,
      ring: 160,
      colliderTilesWithAgents: tilesBefore,
      pathsFound: paths.filter((s) => s === 'complete').length,
      arrivedIn80s: arrived,
      fellThrough: fell,
      navWarmupMs: Math.round(navMs),
    }
    await p.app.dispose()
  }
}

// Keep the source parse here, so a bad REGION fails loudly before minutes of baking.
if (!skip) parseTerrainSource(REGION)
