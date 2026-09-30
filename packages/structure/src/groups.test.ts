import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AssetRef, Children, type Entity, polygon, Rng } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import type { Mesh } from '@aethervtt/shard-mesh'
import {
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  RenderStats,
  Visibility,
  worldToScreen,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, renderView, settle } from '@aethervtt/shard-render/testing'
import { LogResource } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { roofAt, Structure } from './compile'
import { Cutout, DoorLeaf, Floor, Level, Roof, Wall } from './components'
import { chunkKey, insideRing } from './geometry'
import { type Rig, rig } from './harness'
import { planarBarriers } from './planar'

// Levels, roofs and cutouts (0067).

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** Bytes one instance slot writes: its 64-byte record and its 48-byte previous transform. */
const SLOT_BYTES = 64 + 48
/** A flags-only change (hiding, showing) rewrites the record alone. */
const RECORD_BYTES = 64

type World = Rig['app']['world']

async function still(r: Rig): Promise<void> {
  await settle(r.app)
  for (let i = 0; i < 4; i++) r.frame()
}

/** A square room of four walls and a floor, `size` metres from (x, z), on `level`. */
function room(
  world: World,
  x: number,
  z: number,
  size: number,
  level: Entity | null,
  extra: { material?: AssetRef<'Material'>; thickness?: number; height?: number } = {},
): { walls: Entity[]; floor: Entity } {
  const c: [number, number][] = [
    [x, z],
    [x + size, z],
    [x + size, z + size],
    [x, z + size],
  ]
  const walls = c.map((a, i) =>
    world.spawn([
      Wall,
      { a, b: c[(i + 1) % 4]!, height: extra.height ?? 2.8, thickness: 0.2, level },
    ]),
  )
  const floor = world.spawn([
    Floor,
    {
      points: c,
      level,
      thickness: extra.thickness ?? 0,
      ...(extra.material ? { material: extra.material } : {}),
    },
  ])
  return { walls, floor }
}

const square = (x: number, z: number, w: number, d = w): [number, number][] => [
  [x, z],
  [x + w, z],
  [x + w, z + d],
  [x, z + d],
]

/** The meshes under a group: its chunk meshes, and the leaves and panes of its pieces. */
function groupMeshes(world: World, group: Entity): Entity[] {
  return (world.tryGet(group, Children)?.entities ?? []).filter(
    (e): e is Entity => e !== null && world.has(e, Mesh3d),
  )
}

function flat(world: World, color: [number, number, number]): AssetRef<'Material'> {
  return world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [...color, 1], roughness: 1 })) as never
}

describe('levels and roofs', () => {
  it('hiding a level or a roof rebuilds nothing, uploads no geometry, writes one slot per mesh', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu)
    const world = r.app.world
    const upper = world.spawn([Level, { index: 1, elevation: 3, height: 3 }])
    room(world, 0, 0, 10, null)
    room(world, 0, 0, 10, upper, { thickness: 0.2 })
    const roof = world.spawn([Roof, { points: square(0, 0, 10), height: 2.8, level: upper }])
    r.look([5, 24, 22], [5, 0, 5])
    await still(r)
    const stats = world.resource(RenderStats)
    const state = world.resource(Structure)
    for (const group of [upper, roof]) {
      const meshes = groupMeshes(world, group)
      expect(meshes.length, `${group}`).toBeGreaterThan(1)
      const rebuilt = state.chunksRebuilt
      world.add(group, Visibility, { mode: 'hidden' })
      r.frame()
      expect(stats.lastFrame.chunksRebuilt).toBe(0)
      expect(stats.lastFrame.bytes.meshes).toBe(0)
      expect(stats.lastFrame.bytes.instances).toBe(meshes.length * RECORD_BYTES)
      world.set(group, Visibility, { mode: 'inherit' })
      r.frame()
      expect(stats.lastFrame.bytes.meshes).toBe(0)
      expect(stats.lastFrame.bytes.instances).toBe(meshes.length * RECORD_BYTES)
      expect(state.chunksRebuilt).toBe(rebuilt)
    }
    const described = state.describe()
    expect(described.levels).toBe(1)
    expect(described.roofs).toBe(1)
    expect(described.groups.map((g) => g.kind).sort()).toEqual(['ground', 'level', 'roof'])
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it("an edit on one level rebuilds only that level's (group, chunk) pairs", {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const upper = world.spawn([Level, { index: 1, elevation: 3 }])
    room(world, 1, 1, 14, null)
    const top = room(world, 1, 1, 14, upper)
    r.frame()
    const state = world.resource(Structure)
    world.set(top.walls[0]!, Wall, { a: [2, 1.5] })
    r.frame()
    expect(state.last.chunksRebuilt).toBeGreaterThan(0)
    expect(new Set(state.last.dirtyGroups)).toEqual(new Set([upper]))
    // Moving the level moves everything on it, and nothing else.
    world.set(upper, Level, { elevation: 3.2 })
    r.frame()
    expect(new Set(state.last.dirtyGroups)).toEqual(new Set([upper]))
    expect(state.last.chunksRebuilt).toBeGreaterThan(0)
    await r.dispose()
  })

  it('with the upper level hidden, a two-level tower shows its lower level as a one-level scene does', {
    timeout: timeout(60_000),
  }, async () => {
    const shot = async (upperLevel: boolean) => {
      const r = await rig(gpu, { width: 96, height: 96, orthoHeight: 14 })
      const world = r.app.world
      room(world, 0, 0, 10, null, { material: flat(world, [0.7, 0.3, 0.2]) })
      if (upperLevel) {
        const upper = world.spawn(
          [Level, { index: 1, elevation: 3 }],
          [Visibility, { mode: 'hidden' }],
        )
        room(world, 0, 0, 10, upper, { thickness: 0.2, material: flat(world, [0.2, 0.3, 0.8]) })
        // A hidden roof that still casts would darken the room: this one doesn't.
        world.spawn(
          [
            Roof,
            { points: square(-0.5, -0.5, 11), height: 2.8, level: upper, shadowWhenHidden: false },
          ],
          [Visibility, { mode: 'hidden' }],
        )
      }
      r.look([5, 30, 5.001], [5, 0, 5])
      await still(r)
      const image = await renderView(r.app, r.view)
      await r.dispose()
      return image
    }
    const one = await shot(false)
    const two = await shot(true)
    let differ = 0
    for (let i = 0; i < one.data.length; i++)
      if (Math.abs(one.data[i]! - two.data[i]!) > 1) differ++
    expect(differ).toBe(0)
    expect(compareGolden(here, 'levels-lower-top', two).mean).toBeLessThan(1.5)
  })

  it('a roof hidden with shadowWhenHidden draws nothing and keeps the interior dark', {
    timeout: timeout(60_000),
  }, async () => {
    const shot = async (shadowWhenHidden: boolean | null) => {
      const r = await rig(gpu, { width: 96, height: 64 })
      const world = r.app.world
      room(world, 0, 0, 8, null, {
        material: flat(world, [0.8, 0.8, 0.8]),
      })
      if (shadowWhenHidden !== null) {
        world.spawn(
          [Roof, { points: square(-0.3, -0.3, 8.6), height: 2.8, shadowWhenHidden }],
          [Visibility, { mode: 'hidden' }],
        )
      }
      r.look([4, 14, 16], [4, 0, 4])
      await still(r)
      const image = await renderView(r.app, r.view)
      const at = [0, 0]
      worldToScreen(world, r.camera, [4, 0, 4.5], at)
      const centre = pixel(image, Math.floor(at[0]!), Math.floor(at[1]!))
      await r.dispose()
      return { image, centre: centre[0]! + centre[1]! + centre[2]! }
    }
    const open = await shot(null)
    const dark = await shot(true)
    const lit = await shot(false)
    // Hidden without shadows, the roof leaves the room exactly as if it weren't there.
    let differ = 0
    for (let i = 0; i < open.image.data.length; i++)
      if (Math.abs(open.image.data[i]! - lit.image.data[i]!) > 1) differ++
    expect(differ).toBe(0)
    expect(dark.centre).toBeLessThan(lit.centre * 0.5)
    expect(compareGolden(here, 'roof-hidden-casting-30', dark.image).mean).toBeLessThan(1.5)
  })

  it('roofAt agrees with a point-in-polygon test over 10k points', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const upper = world.spawn([Level, { index: 1, elevation: 3 }])
    // A concave comb, a square sharing one of its edges, a triangle, and one on another level.
    const comb: [number, number][] = [
      [0, 0],
      [12, 0],
      [12, 9],
      [9, 9],
      [9, 3],
      [6, 3],
      [6, 9],
      [3, 9],
      [3, 3],
      [0, 3],
    ]
    const roofs: { entity: Entity; points: [number, number][]; level: Entity | null }[] = []
    const add = (points: [number, number][], level: Entity | null) =>
      roofs.push({ entity: world.spawn([Roof, { points, level }]), points, level })
    add(comb, null)
    add(square(12, 0, 5, 9), null)
    add(
      [
        [-6, 12],
        [4, 20],
        [-3, 25],
      ],
      null,
    )
    add(square(2, 2, 6), upper)
    r.frame()
    const brute = (x: number, z: number, level?: Entity | null) => {
      let best: Entity | undefined
      for (const roof of roofs) {
        if (level !== undefined && roof.level !== level) continue
        const flatPoints = roof.points.flat()
        if (!insideRing(flatPoints, 0, roof.points.length, x, z, true)) continue
        if (best === undefined || roof.entity < best) best = roof.entity
      }
      return best
    }
    const rng = new Rng(7)
    let hits = 0
    for (let i = 0; i < 10_000; i++) {
      // Every eighth point lies on the shared edge x = 12, or on a comb edge.
      const x = i % 8 === 0 ? 12 : i % 8 === 1 ? 6 : rng.range(-8, 20)
      const z = rng.range(-2, 27)
      const level = i % 3 === 0 ? undefined : i % 3 === 1 ? null : upper
      const expected = brute(x, z, level)
      if (expected !== undefined) hits++
      expect(roofAt(world, x, z, level), `${x}, ${z}, ${level}`).toBe(expected)
    }
    expect(hits).toBeGreaterThan(1000)
    await r.dispose()
  })
})

describe('barriers per level', () => {
  it("planarBarriers with level returns only that level's segments, each tagged", () => {
    const walls = [
      { id: 'g', a: [0, 0] as const, b: [4, 0] as const },
      { id: 'u', a: [0, 0] as const, b: [4, 0] as const, level: 'L1' },
      { id: 'u2', a: [4, 0] as const, b: [4, 4] as const, level: 'L1' },
    ]
    const openings = [
      {
        id: 'd',
        wall: 'u',
        kind: 'door' as const,
        offset: 1,
        width: 1,
        state: 'closed' as const,
        sight: 'normal' as const,
        movement: 'normal' as const,
      },
    ]
    const upper = planarBarriers(walls, openings, { level: 'L1' })
    expect(upper.map((s) => s.sourceWallId)).toEqual(['u', 'u', 'u', 'u2'])
    expect(upper.every((s) => s.level === 'L1')).toBe(true)
    const ground = planarBarriers(walls, openings, { level: null })
    expect(ground.map((s) => [s.sourceWallId, s.level])).toEqual([['g', null]])
    // Without the option, every wall; only those that name a level carry one.
    const all = planarBarriers(walls, openings)
    expect(all).toHaveLength(5)
    expect(all[0]).not.toHaveProperty('level')
  })
})

/** Area of the up-facing triangles in a set of meshes. */
function upArea(meshes: Mesh[]): number {
  let area = 0
  for (const mesh of meshes) {
    const d = mesh.data()
    const p = d.positions
    const n = d.normals!
    const idx = d.indices!
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k]! * 3
      if (n[a + 1]! < 0.5) continue
      const b = idx[k + 1]! * 3
      const c = idx[k + 2]! * 3
      const ux = p[b]! - p[a]!
      const uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!
      const vz = p[c + 2]! - p[a + 2]!
      area += Math.abs(ux * vz - uz * vx) / 2
    }
  }
  return area
}

function chunkMeshes(world: World): Mesh[] {
  const state = world.resource(Structure)
  const out: Mesh[] = []
  for (const c of state.chunks.values()) for (const cm of c.meshes.values()) out.push(cm.mesh)
  return out
}

describe('cutouts', () => {
  it('keep their host exact minus their area across chunks; a stairwell shows the level below', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { width: 96, height: 64, shadows: false })
    const world = r.app.world
    // A 20 × 12 floor across six chunks, two holes crossing chunk lines.
    const host = world.spawn([
      Floor,
      { points: square(0.5, 0.5, 20, 12), material: flat(world, [0.2, 0.3, 0.8]) },
    ])
    const a = square(6.5, 3, 3, 4)
    const b: [number, number][] = [
      [14, 7],
      [18, 8.5],
      [16.5, 11],
    ]
    world.spawn([Cutout, { host, points: a, kind: 'hole', frameWidth: 0 }])
    world.spawn([Cutout, { host, points: b, kind: 'hole', frameWidth: 0 }])
    r.frame()
    const area = (pts: [number, number][]) => Math.abs(polygon.signedArea(pts.flat()))
    const expected = 20 * 12 - area(a) - area(b)
    expect(Math.abs(upArea(chunkMeshes(world)) - expected) / expected).toBeLessThan(0.001)
    expect(world.resource(Structure).chunks.size).toBe(6)
    world.despawn(host)
    r.frame()
    expect(world.resource(Structure).chunks.size).toBe(0)

    // A stairwell: a lower room in red, an upper floor in blue with a framed hole.
    const upper = world.spawn([Level, { index: 1, elevation: 3 }])
    room(world, 0, 0, 8, null, { material: flat(world, [0.8, 0.15, 0.1]) })
    const floor = world.spawn([
      Floor,
      {
        points: square(0, 0, 8),
        level: upper,
        thickness: 0.25,
        material: flat(world, [0.15, 0.25, 0.8]),
      },
    ])
    world.spawn([Cutout, { host: floor, points: square(4.5, 2, 2, 3.5), kind: 'hole' }])
    r.look([4, 13, 14], [4, 2.5, 4])
    await still(r)
    const image = await renderView(r.app, r.view)
    const at = [0, 0]
    // Through the hole's centre, the camera sees the lower floor.
    worldToScreen(world, r.camera, [5.5, 3, 3.75], at)
    const below = pixel(image, Math.floor(at[0]!), Math.floor(at[1]!))
    expect(below[0]!).toBeGreaterThan(below[2]!)
    worldToScreen(world, r.camera, [2, 3, 5], at)
    const beside = pixel(image, Math.floor(at[0]!), Math.floor(at[1]!))
    expect(beside[2]!).toBeGreaterThan(beside[0]!)
    expect(compareGolden(here, 'stairwell-30', image).mean).toBeLessThan(1.5)
    await r.dispose()
  })

  it('a hatch toggle rebuilds nothing, and each frame of its swing writes only its leaf', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu)
    const world = r.app.world
    const floor = world.spawn([Floor, { points: square(0, 0, 8), thickness: 0.2 }])
    const hatch = world.spawn([
      Cutout,
      { host: floor, points: square(3, 3, 1.2, 1), kind: 'hatch', hinge: 0 },
    ])
    r.look([4, 8, 10], [4, 0, 4])
    await still(r)
    const stats = world.resource(RenderStats)
    const state = world.resource(Structure)
    const rebuilt = state.chunksRebuilt
    const leaf = world
      .query({ with: [DoorLeaf] })
      .entities()
      .find((e) => world.get(e, DoorLeaf).opening === hatch)!
    expect(leaf).toBeDefined()
    world.set(hatch, Cutout, { state: 'open' })
    let frames = 0
    for (let i = 0; i < 40 && world.get(leaf, DoorLeaf).angle < 1; i++) {
      r.frame()
      frames++
      expect(stats.lastFrame.chunksRebuilt, `frame ${i}`).toBe(0)
      expect(stats.lastFrame.bytes.instances, `frame ${i}`).toBe(SLOT_BYTES)
      expect(stats.lastFrame.sceneBytes, `frame ${i}`).toBe(SLOT_BYTES)
    }
    expect(frames).toBe(15)
    expect(state.chunksRebuilt).toBe(rebuilt)
    // Hinged on edge 0 (z = 3), the far edge (z = 4) now stands a metre up over the hinge.
    const t = world.get(leaf, Transform)
    const [qx, qy, qz, qw] = t.rotation
    // (0, 0, 1) rotated by q: its y is 2(qy·qz − qw·qx).
    expect(t.translation[1]! + 2 * (qy! * qz! - qw! * qx!)).toBeCloseTo(1, 3)
    await r.dispose()
  })

  it("moving a cutout rebuilds exactly its host's chunks that its old and new outlines cover", {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const host = world.spawn([Floor, { points: square(0.5, 0.5, 40, 30), thickness: 0.2 }])
    const w = 0.1
    const cut = world.spawn([
      Cutout,
      { host, points: square(5, 5, 2, 2), kind: 'skylight', frameWidth: w },
    ])
    r.frame()
    const state = world.resource(Structure)
    const chunksOf = (x: number, z: number, s: number) => {
      const out = new Set<number>()
      for (let cx = Math.floor((x - w) / 8); cx <= Math.floor((x + s + w) / 8); cx++)
        for (let cz = Math.floor((z - w) / 8); cz <= Math.floor((z + s + w) / 8); cz++)
          out.add(chunkKey(cx, cz))
      return out
    }
    let at: [number, number] = [5, 5]
    for (const next of [
      [6.5, 9],
      [20, 17.5],
      [30.5, 25],
    ] as [number, number][]) {
      world.set(cut, Cutout, { points: square(next[0], next[1], 2, 2) })
      r.frame()
      const expected = new Set([...chunksOf(at[0], at[1], 2), ...chunksOf(next[0], next[1], 2)])
      const rebuilt = new Set(state.last.dirtyChunks.map(([x, z]) => chunkKey(x, z)))
      expect([...rebuilt].sort(), `${next}`).toEqual([...expected].sort())
      at = next
    }
    await r.dispose()
  })

  it('a cutout outside its host, or overlapping another, reports its error and leaves the host whole', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const log = world.resource(LogResource)
    const host = world.spawn([Floor, { points: square(0, 0, 6) }])
    const outside = world.spawn([
      Cutout,
      { host, points: square(5, 2, 2, 1), kind: 'hole', frameWidth: 0 },
    ])
    r.frame()
    const err = log.errors().find((e) => e.code === 'structure/cutout-outside')!
    expect(err.path).toBe(`/entities/${outside}/structure/Cutout/points`)
    expect(upArea(chunkMeshes(world))).toBeCloseTo(36, 6)
    world.despawn(outside)
    const first = world.spawn([
      Cutout,
      { host, points: square(1, 1, 2, 2), kind: 'hole', frameWidth: 0 },
    ])
    r.frame()
    const second = world.spawn([
      Cutout,
      { host, points: square(2, 2, 2, 2), kind: 'hole', frameWidth: 0 },
    ])
    r.frame()
    const overlap = log.errors().find((e) => e.code === 'structure/cutout-overlap')!
    expect(overlap.path).toBe(`/entities/${second}/structure/Cutout/points`)
    // The first cutout stands; the second is skipped.
    expect(upArea(chunkMeshes(world))).toBeCloseTo(36 - 4, 6)
    expect(world.resource(Structure).cutoutWarned.has(first)).toBe(false)
    await r.dispose()
  })
})
