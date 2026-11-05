import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createRayHit, Physics } from '@aethervtt/shard-physics'
import { placeInGrid, Transform } from '@aethervtt/shard-transform'
import { beforeAll, describe, expect, it } from 'vitest'
import { TerrainAnchor, TerrainBudget } from '../components'
import { bakeTerrain } from './bake'
import { tilesOf } from './colliders'
import { TerrainEdited, terrainEditor } from './editor'
import { dequantize, LEAF_SIDE, PAGE } from './kernel'
import { memoryPackStore } from './pack'
import { type LoadedPage, nodeKey, PageStore } from './pages'
import { heightfieldSample, terrainHeightAt } from './queries'
import {
  EDIT_HILLS,
  editSource,
  type HeightfieldApp,
  heightfieldApp,
  untilEdited,
  untilStreaming,
} from './testing'

let hills: NoiseGraph

beforeAll(async () => {
  await loadNoiseKernel()
  hills = await NoiseGraph.create(EDIT_HILLS)
})

async function editable(extra: Parameters<typeof heightfieldApp>[1] | object = {}) {
  const p = await heightfieldApp(undefined, {
    ...editSource(),
    noise: { hills },
    block: 4,
    ...extra,
  })
  await untilStreaming(p)
  return p
}

/** Every page of the terrain, as its runtime holds it (edits' pages first, then the packs). */
async function livePages(p: HeightfieldApp): Promise<Map<number, LoadedPage>> {
  const rt = p.runtime()
  const out = new Map<number, LoadedPage>()
  for (let d = 0; d <= rt.layout!.depth; d++) {
    const [nx, nz] = rt.pages!.nodesAt(d)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) out.set(nodeKey(d, x, z), (await rt.pages!.load(d, x, z))!)
  }
  return out
}

/** Every page of a fresh bake of the runtime's source with its current edits. */
async function freshPages(p: HeightfieldApp): Promise<Map<number, LoadedPage>> {
  const rt = p.runtime()
  const store = memoryPackStore()
  await bakeTerrain(rt.asset!, rt.stack!, store)
  const pages = new PageStore(store, rt.layout!, rt.lo, rt.hi)
  const out = new Map<number, LoadedPage>()
  for (let d = 0; d <= rt.layout!.depth; d++) {
    const [nx, nz] = pages.nodesAt(d)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) out.set(nodeKey(d, x, z), (await pages.load(d, x, z))!)
  }
  return out
}

const equalBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Pages whose heights or control differ, and the largest normal byte difference. */
function differences(a: Map<number, LoadedPage>, b: Map<number, LoadedPage>) {
  const heights: number[] = []
  const control: number[] = []
  let normals = 0
  for (const [key, pa] of a) {
    const pb = b.get(key)!
    if (!equalBytes(pa.heights, pb.heights)) heights.push(key)
    if (!equalBytes(pa.control, pb.control)) control.push(key)
    for (let i = 0; i < pa.normals.length; i++)
      normals = Math.max(normals, Math.abs(pa.normals[i]! - pb.normals[i]!))
  }
  return { heights, control, normals }
}

/** One of every brush and shape, sculpting and painting. */
function editEverything(p: HeightfieldApp) {
  const ed = terrainEditor(p.world, p.terrain)
  const drag = (o: Parameters<typeof ed.stroke>[0], a: [number, number], b: [number, number]) => {
    const s = ed.stroke(o, a[0], a[1])
    s.to(b[0], b[1])
    s.end()
  }
  drag({ brush: 'raise', radius: 10, strength: 0.4 }, [100, 100], [130, 120])
  drag({ brush: 'lower', radius: 8, strength: 0.5, falloff: 0.2 }, [300, 100], [320, 150])
  drag({ brush: 'smooth', radius: 12, strength: 0.6 }, [110, 110], [125, 118])
  drag({ brush: 'flatten', radius: 9, strength: 0.8 }, [200, 400], [230, 420])
  drag({ brush: 'roughen', radius: 10, strength: 0.3 }, [400, 400], [420, 380])
  ed.shape({ shape: { circle: { at: [80, 300], radius: 15 } }, set: 2 })
  ed.shape({
    shape: { rect: { at: [350, 250], size: [40, 20], rotation: 30 } },
    raise: 3,
    edge: { angle: 35 },
  })
  ed.shape({
    shape: {
      polygon: [
        [150, 150],
        [190, 160],
        [180, 200],
        [140, 190],
      ],
    },
    slope: [1, 6],
    from: [150, 150],
    to: [180, 200],
    edge: { falloff: 5 },
  })
  ed.shape({
    shape: {
      spline: {
        points: [
          [260, 60],
          [300, 90],
          [340, 80],
        ],
        width: 5,
      },
    },
    slope: [0, 4],
    edge: { angle: 30 },
  })
  drag({ paint: 'sand', radius: 8, strength: 0.7 }, [120, 300], [160, 330])
  drag({ paint: null, radius: 4, strength: 1 }, [140, 315], [141, 315])
  ed.shape({
    shape: {
      polygon: [
        [420, 120],
        [470, 130],
        [450, 170],
      ],
    },
    paint: 'rock',
    strength: 0.6,
    edge: { falloff: 3 },
  })
  return ed
}

describe('terrain edits (0104)', () => {
  it('leaves the pages a fresh bake with the same edits writes', async () => {
    const p = await editable()
    editEverything(p)
    untilEdited(p)
    const live = await livePages(p)
    const fresh = await freshPages(p)
    const d = differences(live, fresh)
    expect(d.heights).toEqual([])
    expect(d.control).toEqual([])
    // Edited parents' normals come from their children's bytes rather than the bake's f64 chain.
    expect(d.normals).toBeLessThanOrEqual(2)
    expect(p.runtime().pages!.overrideCount).toBeGreaterThan(0)
  }, 120_000)

  it('saves and loads: the same pages, heights and colliders, now or ahead of the bake', async () => {
    const p = await editable()
    const ed = editEverything(p)
    untilEdited(p)
    const data = JSON.parse(JSON.stringify(ed.save()))
    const live = await livePages(p)
    // Ahead of the first bake: baked in, nothing queued.
    const ahead = await editable({ edits: data })
    expect(terrainEditor(ahead.world, ahead.terrain).pending).toBe(0)
    expect(differences(await livePages(ahead), live).heights).toEqual([])
    // Into a running terrain: rebaked on the runtime path.
    const later = await editable()
    terrainEditor(later.world, later.terrain).load(data)
    untilEdited(later)
    const after = await livePages(later)
    const d = differences(after, live)
    expect(d.heights).toEqual([])
    expect(d.control).toEqual([])
    for (let k = 0; k < 50; k++) {
      const x = (k * 97.3) % 512
      const z = (k * 53.9) % 512
      expect(terrainHeightAt(later.world, later.terrain, x, z).height).toBe(
        terrainHeightAt(p.world, p.terrain, x, z).height,
      )
    }
  }, 180_000)

  it('undoes and redoes a step byte for byte', async () => {
    const p = await editable()
    const ed = terrainEditor(p.world, p.terrain)
    const before = await livePages(p)
    const s = ed.stroke({ brush: 'raise', radius: 12, strength: 0.5 }, 200, 200)
    s.to(240, 230)
    s.end()
    ed.shape({ shape: { circle: { at: [220, 215], radius: 8 } }, paint: 'sand' })
    untilEdited(p)
    const edited = await livePages(p)
    expect(ed.undo()).not.toBeNull()
    expect(ed.undo()).not.toBeNull()
    untilEdited(p)
    let d = differences(await livePages(p), before)
    expect(d.heights).toEqual([])
    expect(d.control).toEqual([])
    ed.redo()
    ed.redo()
    untilEdited(p)
    d = differences(await livePages(p), edited)
    expect(d.heights).toEqual([])
    expect(d.control).toEqual([])
    expect(ed.canRedo).toBe(false)
  }, 120_000)

  it('rebakes exactly the leaves a dab changed, samples or border', async () => {
    const p = await editable()
    const ed = terrainEditor(p.world, p.terrain)
    const rt = p.runtime()
    // A dab of 3 m at (64.5, 96.5): samples 123–135 × 187–199; leaves are 32 m (64 samples).
    ed.stroke({ brush: 'raise', radius: 3, strength: 1, falloff: 0 }, 64.5, 96.5).end()
    const editor = rt.parts.get('editor') as { lastLeaves: number[] }
    untilEdited(p)
    const D = rt.layout!.depth
    const leaves = editor.lastLeaves.map((k) => [k % 2 ** 20, Math.floor(k / 2 ** 20) % 2 ** 20])
    // x: samples 123–135 are in leaves 1 (64–128, border to 129) and 2 (128–192, border from 127).
    // z: 187–199 lie in leaf 2 (128–192, border to 193) and 3 (192–256, border from 191).
    expect(leaves.sort()).toEqual([
      [1, 2],
      [1, 3],
      [2, 2],
      [2, 3],
    ])
    expect(D).toBe(1)
  }, 60_000)

  it('shows an edit to height queries and colliders within two frames', async () => {
    const p = await editable({ physics: true })
    // Correctness: every queued leaf in one frame (the bench holds TerrainBudget.editMs).
    p.world.resource(TerrainBudget).editMs = Number.POSITIVE_INFINITY
    const anchor = p.world.spawn([TerrainAnchor, { radius: 40 }], Transform)
    placeInGrid(p.world, anchor, p.terrain, [300, 20, 300])
    for (let f = 0; f < 6; f++) p.app.update(1 / 60)
    const before = terrainHeightAt(p.world, p.terrain, 300, 300).height
    const ed = terrainEditor(p.world, p.terrain)
    const s = ed.stroke({ brush: 'raise', radius: 10, strength: 2, falloff: 0.3 }, 295, 300)
    s.to(305, 300)
    p.app.update(1 / 60)
    p.app.update(1 / 60)
    const after = terrainHeightAt(p.world, p.terrain, 300, 300).height
    expect(after).toBeGreaterThan(before + 1)
    // Rapier straight down onto the collider tile under the brush.
    const hit = createRayHit()
    const physics = p.world.resource(Physics)
    expect(physics.raycast([300, 80, 300], [0, -1, 0], { maxDistance: 200 }, hit)).toBe(true)
    expect(Math.abs(80 - hit.distance - after)).toBeLessThan(0.01)
    s.end()
    expect(tilesOf(p.runtime()).tiles.size).toBeGreaterThan(0)
  }, 60_000)

  it('keeps a flattened path over a raised patch, and its gravel', async () => {
    const p = await editable()
    const rt = p.runtime()
    // The path's centerline runs through (250, 260).
    const before = heightfieldSample(rt, 250, 260)
    const beside = heightfieldSample(rt, 262, 245).height
    terrainEditor(p.world, p.terrain).shape({
      shape: { circle: { at: [250, 260], radius: 20 } },
      raise: 4,
    })
    untilEdited(p)
    const after = heightfieldSample(rt, 250, 260)
    expect(Math.abs(after.height - before.height)).toBeLessThan(0.01)
    expect(after.layers).toContain('gravel')
    // Beside the path (past its width and falloff), the patch is raised.
    expect(heightfieldSample(rt, 262, 245).height).toBeCloseTo(beside + 4, 2)
  }, 60_000)

  it('holds hard edges to the shape, and walls to their angle', async () => {
    const p = await editable()
    const rt = p.runtime()
    const ed = terrainEditor(p.world, p.terrain)
    const sample = (gi: number, gj: number) => {
      const page = rt.pages!.get(nodeKey(rt.layout!.depth, gi >> 6, gj >> 6))!
      return dequantize(page.heights[((gj % 64) + 1) * LEAF_SIDE + (gi % 64) + 1]!, rt.lo, rt.hi)
    }
    for (let gi = 0; gi < 1024; gi += 3) sample(gi, 700) // leaves held (pinned with the coarse levels)
    const before = new Float64Array(160 * 160)
    for (let j = 0; j < 160; j++)
      for (let i = 0; i < 160; i++) before[j * 160 + i] = sample(560 + i, 560 + j)
    // A 20 m square cut to −5 m, hard: nothing outside it moves.
    ed.shape({ shape: { rect: { at: [320, 320], size: [20, 20] } }, set: -5 })
    untilEdited(p)
    for (let j = 0; j < 160; j++) {
      for (let i = 0; i < 160; i++) {
        const x = (560 + i) * 0.5
        const z = (560 + j) * 0.5
        const inside = Math.abs(x - 320) <= 10 && Math.abs(z - 320) <= 10
        if (!inside) expect(sample(560 + i, 560 + j)).toBe(before[j * 160 + i])
        else expect(Math.abs(sample(560 + i, 560 + j) + 5)).toBeLessThan(0.002)
      }
    }
    // A pond at 35°: its banks are never steeper.
    ed.shape({ shape: { circle: { at: [150, 420], radius: 12 } }, set: -6, edge: { angle: 35 } })
    untilEdited(p)
    let steepest = 0
    for (let j = 780; j < 900; j++) {
      for (let i = 240; i < 360; i++) {
        const x = i * 0.5
        const z = j * 0.5
        if (Math.hypot(x - 150, z - 420) < 13) continue
        const dx = (sample(i + 1, j) - sample(i - 1, j)) / 1
        const dz = (sample(i, j + 1) - sample(i, j - 1)) / 1
        steepest = Math.max(steepest, (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI)
      }
    }
    expect(steepest).toBeGreaterThan(25)
    expect(steepest).toBeLessThan(36)
  }, 60_000)

  it('paints a third layer over two by keeping the heaviest, and erases back to the source', async () => {
    const p = await editable()
    const rt = p.runtime()
    const ed = terrainEditor(p.world, p.terrain)
    const at = (x: number, z: number) => {
      const page = rt.pages!.get(nodeKey(1, Math.floor(x / 32), Math.floor(z / 32)))!
      const c = rt.layout!.cells
      const o = ((Math.round(z) % 32) * (c + 1) + (Math.round(x) % 32)) * 4
      return [...page.control.subarray(o, o + 4)]
    }
    const source = at(400, 450)
    // Grass is the source here. Sand at 1 covers it; rock at 0.4 leaves sand 0.6, rock 0.4.
    const square = {
      rect: { at: [400, 450] as [number, number], size: [6, 6] as [number, number] },
    }
    ed.shape({ shape: square, paint: 'sand', strength: 1 })
    ed.shape({ shape: square, paint: 'rock', strength: 0.4 })
    // A third, gravel at 0.5: sand 0.3, rock 0.2 and gravel 0.5. Rock, the lightest, drops; its
    // 0.2 lets the source's grass back, which stays below the two kept.
    ed.shape({ shape: square, paint: 'gravel', strength: 0.5 })
    untilEdited(p)
    const names = rt.asset!.source.layers.map((l) => l.name)
    const [a, b] = at(400, 450)
    expect([names[a!], names[b!]].sort()).toEqual(['gravel', 'sand'])
    // At strength 1 the new layer stands alone.
    ed.shape({ shape: square, paint: 'rock', strength: 1 })
    untilEdited(p)
    expect(at(400, 450).slice(0, 3)).toEqual([1, 1, 0])
    // Erasing goes back to what the source's rules give.
    ed.shape({ shape: square, paint: null, edge: { falloff: 2 } })
    untilEdited(p)
    expect(at(400, 450)).toEqual(source)
  }, 60_000)

  it('sends one event per edit, and one per stroke frame, covering what changed', async () => {
    const p = await editable()
    const reader = p.world.reader(TerrainEdited)
    reader.clear()
    const ed = terrainEditor(p.world, p.terrain)
    ed.shape({ shape: { circle: { at: [100, 400], radius: 10 } }, raise: 2 })
    untilEdited(p)
    let events = [...reader.read()]
    expect(events.length).toBe(1)
    expect(events[0]!.height).toBe(true)
    expect(events[0]!.paint).toBe(false)
    expect(events[0]!.cause).toBe('shape')
    const [x0, z0, x1, z1] = events[0]!.rect
    expect(x0).toBeLessThanOrEqual(90.5)
    expect(z0).toBeLessThanOrEqual(390.5)
    expect(x1).toBeGreaterThanOrEqual(109.5)
    expect(z1).toBeGreaterThanOrEqual(409.5)
    const s = ed.stroke({ paint: 'sand', radius: 5, strength: 0.5 }, 200, 100)
    let frames = 0
    for (let k = 1; k <= 3; k++) {
      s.to(200 + k * 5, 100)
      p.app.update(1 / 60)
      frames++
      events = [...reader.read()]
      expect(events.length).toBe(1)
      expect(events[0]!.cause).toBe('stroke')
      expect(events[0]!.paint).toBe(true)
    }
    s.end()
    expect(frames).toBe(3)
  }, 60_000)

  it('edits, undoes and redoes through terrain.edit, terrain.undo and terrain.redo', async () => {
    const p = await editable()
    const call = async (method: string, params: Record<string, unknown>) => {
      const m = p.app.methods.find((x) => x.name === method)!
      const done = m.handler({ world: p.world, app: p.app } as never, params as never)
      // The handler waits for the edit to show: frames have to run meanwhile.
      let settled = false
      void Promise.resolve(done).finally(() => {
        settled = true
      })
      while (!settled) {
        p.app.update(1 / 60)
        await new Promise((r) => setTimeout(r, 1))
      }
      return (await done) as Record<string, unknown>
    }
    const before = terrainHeightAt(p.world, p.terrain, 300, 120).height
    const edited = await call('terrain.edit', {
      edit: { shape: { circle: { at: [300, 120], radius: 6 } }, raise: 3 },
    })
    expect(edited.pending).toBe(0)
    expect(edited.rebakedLeaves).toBeGreaterThan(0)
    expect(terrainHeightAt(p.world, p.terrain, 300, 120).height).toBeCloseTo(before + 3, 2)
    const stroked = await call('terrain.edit', {
      stroke: {
        paint: 'sand',
        radius: 4,
        strength: 1,
        points: [
          [300, 120],
          [310, 125],
        ],
      },
    })
    expect(stroked.pending).toBe(0)
    const described = (await call('terrain.describe', {})) as {
      terrains: { edits: { sculptTiles: number; paintTiles: number; undo: number } }[]
    }
    expect(described.terrains[0]!.edits).toMatchObject({ undo: 2 })
    expect(described.terrains[0]!.edits.sculptTiles).toBeGreaterThan(0)
    await call('terrain.undo', {})
    const undone = await call('terrain.undo', {})
    expect(undone).toMatchObject({ done: true, undo: 0, redo: 2 })
    expect(terrainHeightAt(p.world, p.terrain, 300, 120).height).toBe(before)
    await call('terrain.redo', {})
    expect(terrainHeightAt(p.world, p.terrain, 300, 120).height).toBeCloseTo(before + 3, 2)
  }, 60_000)

  it('rejects bad edits with a pointer', async () => {
    const p = await editable()
    const ed = terrainEditor(p.world, p.terrain)
    expect(() => ed.shape({ shape: { circle: { at: [1, 2], radius: -1 } }, set: 2 })).toThrow(
      expect.objectContaining({ code: 'terrain/bad-edit', path: '/shape/circle/radius' }),
    )
    expect(() => ed.stroke({ paint: 'lava', radius: 3, strength: 1 }, 0, 0)).toThrow(
      expect.objectContaining({ code: 'terrain/unknown-layer' }),
    )
    const data = ed.save()
    expect(() => ed.load({ ...data, grid: { ...data.grid, spacing: 1 } })).toThrow(
      expect.objectContaining({ code: 'terrain/edits-mismatch' }),
    )
    expect(PAGE).toBe(64)
  }, 60_000)
})
