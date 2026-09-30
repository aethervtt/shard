import type { GpuContext } from '@aethervtt/shard-gpu'
import { createMirror } from '@aethervtt/shard-mirror'
import { RenderStats } from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { Structure } from './compile'
import { DoorLeaf } from './components'
import { maxScene, type SceneDocs, shadowStress } from './fixtures'
import { rig } from './harness'

/** One measurement against its budget (0055's acceptance criteria). */
export interface BenchResult {
  name: string
  value: number
  unit: 'ms' | 'bytes' | 'chunks' | 'maps'
  budget: number
  pass: boolean
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!

function result(
  name: string,
  value: number,
  unit: BenchResult['unit'],
  budget: number,
): BenchResult {
  return { name, value, unit, budget, pass: value <= budget }
}

function empty(docs: SceneDocs): SceneDocs {
  return { ...docs, materials: [], walls: [], openings: [], floors: [], props: [], tokens: [] }
}

/**
 * Runs the structure fixtures (Aether's shadow-stress and max scenes) and reports each budget:
 * mirror sync, max build, wall edit compile, token move and door swing uploads, and shadow maps
 * on a still frame. `shard bench structure` prints these.
 */
export async function runStructureBench(gpu: GpuContext): Promise<BenchResult[]> {
  const out: BenchResult[] = []

  // mirror.sync of 5,000 unchanged walls.
  {
    const r = await rig(gpu, { shadows: false })
    const docs = shadowStress()
    const mirror = createMirror(r.app.world, {
      key: (d: SceneDocs['walls'][number]) => d.id,
      rev: (d) => d.rev,
      spawn: (_d, w) => w.spawn(),
      apply() {},
    })
    mirror.sync(docs.walls)
    for (let i = 0; i < 200; i++) mirror.sync(docs.walls)
    const times: number[] = []
    for (let i = 0; i < 400; i++) {
      const t0 = performance.now()
      mirror.sync(docs.walls)
      times.push(performance.now() - t0)
    }
    out.push(result('mirror.sync of 5,000 unchanged walls', median(times), 'ms', 0.2))
    await r.dispose()
  }

  // The max fixture from nothing.
  {
    const r = await rig(gpu, { shadows: false })
    const docs = maxScene()
    const times: number[] = []
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now()
      r.host.sync(docs)
      r.frame()
      times.push(performance.now() - t0)
      r.host.sync(empty(docs))
      r.frame()
    }
    times.shift()
    out.push(result('max fixture build (sync, compile, first frame)', median(times), 'ms', 300))
    await r.dispose()
  }

  // Shadow-stress: wall edits, a token move, a door swing, still shadows.
  {
    const r = await rig(gpu, { shadowUpdate: 'on-change' })
    const docs = shadowStress()
    r.host.sync(docs)
    r.look([10, 20, 24], [10, 0, 8])
    await settle(r.app)
    for (let i = 0; i < 4; i++) r.frame()
    const world = r.app.world
    const stats = world.resource(RenderStats)
    const state = world.resource(Structure)
    r.frame()
    out.push(
      result('shadow maps drawn on a still frame', stats.lastFrame.shadowMapsRendered, 'maps', 0),
    )

    const token = docs.tokens[0]!
    docs.tokens[0] = { ...token, rev: token.rev + 1, x: token.x + 70 }
    r.host.sync(docs)
    r.frame()
    out.push(result('token move: scene bytes', stats.lastFrame.sceneBytes, 'bytes', 112))
    // The token's previous transform catches up on the next frame; let it before the door swings.
    r.frame()

    const door = docs.openings[0]!
    docs.openings[0] = { ...door, rev: door.rev + 1, state: 'open' }
    r.host.sync(docs)
    let worstBytes = 0
    let rebuilt = 0
    const leaf = world
      .query({ with: [DoorLeaf] })
      .entities()
      .find((e) => world.get(e, DoorLeaf).opening === r.host.openings.entity(door.id))!
    for (let i = 0; i < 40 && world.get(leaf, DoorLeaf).angle < 1; i++) {
      r.frame()
      worstBytes = Math.max(worstBytes, stats.lastFrame.sceneBytes)
      rebuilt += stats.lastFrame.chunksRebuilt
    }
    out.push(result('door swing: chunks rebuilt', rebuilt, 'chunks', 0))
    out.push(result('door swing: scene bytes per frame', worstBytes, 'bytes', 112))

    const k = r.host.k
    const times: number[] = []
    for (let i = 0; i < 12; i++) {
      const index = 100 + i * 211
      const old = docs.walls[index]!
      const ax = old.a.x + 35
      const ay = old.a.y + 20
      const angle = i * 0.61
      docs.walls[index] = {
        ...old,
        rev: old.rev + 1,
        a: { x: ax, y: ay },
        b: { x: ax + (Math.cos(angle) * 3) / k, y: ay + (Math.sin(angle) * 3) / k },
      }
      r.host.sync(docs)
      r.frame()
      times.push(state.last.ms)
    }
    out.push(result('3 m wall edit: compile', median(times), 'ms', 4))
    await r.dispose()
  }
  return out
}
