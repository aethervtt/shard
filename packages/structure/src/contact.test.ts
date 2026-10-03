import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AssetRef, ChildOf, type Entity, type World } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  AmbientLight,
  ComputedVisibility,
  Gpu,
  MaterialAsset,
  Materials,
  MeshMaterial,
  NotShadowCaster,
  RenderStats,
  Visibility,
} from '@aethervtt/shard-render'
import { SURFACE_PRESETS, SurfaceMaterial } from '@aethervtt/shard-render/surface'
import { compareGolden, renderView, settle } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Structure } from './compile'
import { ContactMesh, Floor, Level, Opening, StructureSettings, Wall } from './components'
import {
  CONTACT_LIFT,
  CONTACT_STRIDE,
  type ContactEnv,
  ContactQuads,
  contactAlpha,
  contactQuads,
} from './contact'
import { sampleWall } from './curve'
import type { OpeningShape, WallShape } from './geometry'
import { rig } from './harness'

const here = dirname(fileURLToPath(import.meta.url))

// --- geometry, headless ---------------------------------------------------------------------------

function wall(
  a: [number, number],
  b: [number, number],
  extra: { shape?: 'straight' | 'arc'; bow?: number } = {},
): WallShape {
  return {
    ax: a[0],
    az: a[1],
    bx: b[0],
    bz: b[1],
    height: 3,
    thickness: 0.2,
    elevation: 0,
    line: sampleWall({ a, b, ...extra }, 0.01),
  }
}

/** Floors as axis-aligned rectangles [x0, z0, x1, z1] at y 0; joints as given per end. */
function env(
  floors: [number, number, number, number][],
  joints: ([number, number, number] | null)[] = [null, null],
): ContactEnv {
  return {
    floorTop: (x, z) =>
      floors.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1) ? 0 : Number.NaN,
    joint(end, out) {
      const j = joints[end]
      if (!j) return false
      out.set(j)
      return true
    },
  }
}

const REACH = { floorReach: 0.7, cornerReach: 0.43 }

/** Each quad: whether it's a floor strip, and its corners. */
function read(q: ContactQuads) {
  const out: { floor: boolean; corners: number[][] }[] = []
  for (let i = 0; i < q.count; i++) {
    const o = i * CONTACT_STRIDE
    const corners: number[][] = []
    for (let k = 0; k < 4; k++) corners.push([...q.data.subarray(o + 4 + k * 4, o + 8 + k * 4)])
    out.push({ floor: q.data[o + 1] === 1, corners })
  }
  return out
}

function quads(w: WallShape, e: ContactEnv, openings: OpeningShape[] = []) {
  const q = new ContactQuads()
  contactQuads(w, openings, REACH, e, q)
  return read(q)
}

const opening = (kind: 'door' | 'window', offset: number, width: number): OpeningShape => ({
  kind,
  offset,
  width,
  height: kind === 'door' ? 2.1 : 1,
  sill: kind === 'door' ? 0 : 1,
  frameWidth: 0.08,
  frameDepth: 0.04,
})

describe('contact quads', () => {
  it('shade only the sides that face a floor, only where it does, and nothing without one', () => {
    // A wall along +x: its left (+z) side faces the floor; its right side faces nothing.
    const w = wall([0, 0], [6, 0])
    const one = quads(w, env([[-10, 0, 10, 10]]))
    expect(one.length).toBeGreaterThan(0)
    for (const q of one) {
      expect(q.floor).toBe(true)
      for (const [, y, z, fade] of q.corners) {
        expect(y).toBeCloseTo(CONTACT_LIFT, 12)
        // From the face (fade 0) out to the reach (fade 1).
        expect(z).toBeCloseTo(0.1 + fade! * 0.7, 9)
      }
    }
    // A floor under half the wall: only that half is shaded.
    const half = quads(w, env([[-10, 0, 3, 10]]))
    expect(half.length).toBeGreaterThan(0)
    expect(Math.max(...half.flatMap((q) => q.corners.map((c) => c[0]!)))).toBeLessThanOrEqual(3)
    // Floors on both sides: both are shaded.
    const both = quads(w, env([[-10, -10, 10, 10]]))
    expect(both.some((q) => q.corners[2]![2]! < 0)).toBe(true)
    expect(both.some((q) => q.corners[2]![2]! > 0)).toBe(true)
    expect(quads(w, env([]))).toEqual([])
  })

  it('skip a doorway, and keep the strip under a window', () => {
    const w = wall([0, 0], [6, 0])
    const q = quads(w, env([[-10, 0, 10, 10]]), [opening('door', 1, 1), opening('window', 3, 1)])
    const covers = (x: number) =>
      q.some((s) => {
        const xs = s.corners.map((c) => c[0]!)
        return Math.min(...xs) < x && Math.max(...xs) > x
      })
    expect(covers(1.5)).toBe(false)
    expect(covers(0.5)).toBe(true)
    expect(covers(3.5)).toBe(true)
    expect(covers(5.5)).toBe(true)
  })

  it('put corner strips only at joined ends, over the shared height less the insets', () => {
    const w = wall([0, 0], [6, 0])
    const floor: [number, number, number, number][] = [[-10, 0, 10, 10]]
    expect(quads(w, env(floor)).every((q) => q.floor)).toBe(true)
    // The end at x = 6 meets a wall 0.2 thick that covers the last 0.1 m.
    const q = quads(w, env(floor, [null, [0, 2.5, 0.1]])).filter((s) => !s.floor)
    expect(q.length).toBeGreaterThan(0)
    for (const s of q) {
      for (const [x, y, z, fade] of s.corners) {
        expect(x).toBeGreaterThanOrEqual(6 - 0.1 - 0.43 - 1e-9)
        expect(z).toBeCloseTo(0.1 + CONTACT_LIFT, 12)
        expect([0.2, 2.3]).toContainEqual(Number(y!.toFixed(9)))
        // Fade 0 where the joined wall's face is, 1 at the reach.
        expect(fade).toBeCloseTo((6 - x! - 0.1) / 0.43, 9)
      }
    }
    // A shared height under the insets leaves nothing.
    expect(quads(w, env(floor, [null, [0, 0.3, 0.1]])).every((s) => s.floor)).toBe(true)
  })

  it('follow a curved wall', () => {
    // A half circle of radius 3 about the origin, bulging toward −z.
    const w = wall([-3, 0], [3, 0], { shape: 'arc', bow: -3 })
    const q = quads(w, env([[-10, -10, 10, 10]]))
    let inner = 0
    for (const s of q)
      for (const [x, , z, fade] of s.corners) {
        const r = Math.sqrt(x! * x! + z! * z!)
        const off = 0.1 + fade! * 0.7
        // On the face (fade 0) or at the reach (fade 1), inside or outside the arc, within the
        // centreline's chord tolerance.
        expect(Math.min(Math.abs(r - (3 - off)), Math.abs(r - (3 + off)))).toBeLessThan(0.0101)
        if (fade === 0) inner++
      }
    expect(inner).toBeGreaterThan(40)
  })
})

describe('the contact alpha', () => {
  it('never rises with fade, for any noise, and is gone at the reach', () => {
    for (const wobble of [0, 0.2, 0.5, 1]) {
      const look = { opacity: 0.2, maxAlpha: 0.42, wobble }
      for (let n = 0; n <= 1.0001; n += 0.05) {
        let last = Infinity
        for (let f = 0; f <= 1.0001; f += 0.005) {
          const a = contactAlpha(f, n, look)
          expect(a).toBeLessThanOrEqual(last + 1e-12)
          expect(a).toBeLessThanOrEqual(0.42)
          last = a
        }
        expect(contactAlpha(1, n, look)).toBe(0)
        expect(contactAlpha(0, n, look)).toBeGreaterThan(0.2)
      }
    }
  })
})

// --- in the engine --------------------------------------------------------------------------------

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const square = (x: number, z: number, size: number): [number, number][] => [
  [x, z],
  [x + size, z],
  [x + size, z + size],
  [x, z + size],
]

/** A room: a floor and four walls joined at the corners, with a door in the south wall. */
function room(
  world: World,
  x: number,
  z: number,
  size: number,
  options: {
    level?: Entity | null
    wall?: AssetRef<'Material'>
    floor?: AssetRef<'Material'>
  } = {},
): { floor: Entity; walls: Entity[] } {
  const level = options.level ?? null
  const floor = world.spawn([
    Floor,
    { points: square(x, z, size), level, material: options.floor ?? null },
  ])
  const c = square(x, z, size)
  const walls = c.map((a, i) =>
    world.spawn([
      Wall,
      { a, b: c[(i + 1) % 4]!, height: 2.6, level, material: options.wall ?? null },
    ]),
  )
  world.spawn([Opening, { wall: walls[0]!, kind: 'door', offset: size / 2 - 0.5, width: 1 }])
  return { floor, walls }
}

const contactMeshes = (world: World) => world.query({ with: [ContactMesh] }).entities()

describe('contact shade in structure', () => {
  it('hides with its level, casts no shadow, and turns off to nothing and back', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu)
    const world = r.app.world
    const upper = world.spawn([Level, { index: 1, elevation: 3, height: 3 }])
    room(world, 0, 0, 6)
    room(world, 0, 0, 6, { level: upper })
    r.look([3, 16, 14], [3, 0, 3])
    await settle(r.app)
    const state = world.resource(Structure)
    const meshes = contactMeshes(world)
    expect(meshes.length).toBeGreaterThan(1)
    for (const e of meshes) expect(world.has(e, NotShadowCaster)).toBe(true)
    expect(state.describe().contact).toMatchObject({ enabled: true, meshes: meshes.length })
    // Hiding the level hides its contact meshes, rebuilding nothing.
    const upperContact = meshes.filter((e) => isChild(world, e, upper))
    expect(upperContact.length).toBeGreaterThan(0)
    const rebuilt = state.chunksRebuilt
    world.add(upper, Visibility, { mode: 'hidden' })
    r.frame()
    for (const e of upperContact) expect(world.get(e, ComputedVisibility).visible).toBe(false)
    expect(state.chunksRebuilt).toBe(rebuilt)
    world.set(upper, Visibility, { mode: 'inherit' })
    r.frame()

    const view = r.view
    const stats = world.resource(RenderStats)
    r.frame()
    const withContact = stats.get(view)!.drawCalls
    const before = state.chunksRebuilt
    world.patchResource(StructureSettings, { contact: { enabled: false } } as never)
    r.frame()
    r.frame()
    expect(contactMeshes(world)).toEqual([])
    expect(stats.get(view)!.drawCalls).toBe(withContact - meshes.length)
    expect(state.chunksRebuilt).toBe(before)
    // A partial patch keeps the other fields.
    expect(world.resource(StructureSettings).contact.floorReach).toBe(0.7)
    world.patchResource(StructureSettings, { contact: { enabled: true } } as never)
    r.frame()
    expect(state.chunksRebuilt).toBe(before)
    expect(state.last.contactRebuilt).toBe(meshes.length)
    expect(contactMeshes(world)).toHaveLength(meshes.length)
    // A look change sets the material: nothing rebuilds.
    const compiles = state.compiles
    world.patchResource(StructureSettings, { contact: { opacity: 0.3, wobble: 0.4 } } as never)
    r.frame()
    expect(state.compiles).toBe(compiles)
    const material = world
      .resource(Materials)
      .get(world.get(contactMeshes(world)[0]!, MeshMaterial).material!)!
    expect(material.value).toMatchObject({ opacity: 0.3, wobble: 0.4 })
    // A reach rebuilds the contact meshes only.
    world.patchResource(StructureSettings, { contact: { floorReach: 1 } } as never)
    r.frame()
    expect(state.chunksRebuilt).toBe(before)
    expect(state.last.contactRebuilt).toBe(meshes.length)
    expect(world.resource(StructureSettings).contact.opacity).toBe(0.3)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('rebuilds only the contact meshes near a floor edit', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const a = room(world, 1, 1, 5)
    room(world, 33, 1, 5)
    r.frame()
    const state = world.resource(Structure)
    // Shrink room A's floor to its north half: its south walls' strips go.
    world.set(a.floor, Floor, {
      points: [
        [1, 3.5],
        [6, 3.5],
        [6, 6],
        [1, 6],
      ],
    })
    r.frame()
    const touched = [...state.last.dirtyChunks, ...state.last.contactChunks]
    expect(touched.length).toBeGreaterThan(0)
    // Every chunk touched is room A's (chunks of 8 m); room B's are not.
    for (const [x] of touched) expect(x).toBe(0)
    expect(state.last.contactRebuilt + state.last.chunksRebuilt).toBe(touched.length)
    await r.dispose()
  })
})

function isChild(world: World, e: Entity, parent: Entity): boolean {
  return world.tryGet(e, ChildOf)?.parent === parent
}

function surface(
  world: World,
  color: [number, number, number],
  preset: string,
  seed: number,
): AssetRef<'Material'> {
  return world.resource(Materials).add(
    new MaterialAsset(
      {
        baseColor: [...color, 1],
        roughness: 0.85,
        variation: { ...SURFACE_PRESETS[preset]!, seed, strength: 1 },
        projection: 'uv',
      },
      SurfaceMaterial,
    ),
  ) as AssetRef<'Material'>
}

function maxDiff(a: { data: Uint8Array }, b: { data: Uint8Array }): number {
  let max = 0
  for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i]! - b.data[i]!))
  return max
}

describe('surface variation and contact shade, rendered', () => {
  it('a brick room and a plaster room at 30°', { timeout: timeout(60_000) }, async () => {
    const r = await rig(gpu, { surface: true, width: 160, height: 120 })
    const world = r.app.world
    world.resource(AmbientLight).brightness = 2000
    const ground = surface(world, [0.55, 0.52, 0.47], 'ground', 3)
    room(world, -6.5, -3, 6, {
      wall: surface(world, [0.56, 0.27, 0.19], 'brick', 11),
      floor: ground,
    })
    room(world, 0.5, -3, 6, {
      wall: surface(world, [0.86, 0.82, 0.74], 'plaster', 5),
      floor: ground,
    })
    r.look([0, 7.5, 9], [0, 0, 0])
    await settle(r.app)
    const image = await renderView(r.app, r.view)
    expect(compareGolden(here, 'contact-rooms-30', image).mean).toBeLessThan(1.5)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('a wall across a chunk edge draws as it does inside one chunk; an arc shows no seam', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { surface: true, width: 160, height: 120 })
    const world = r.app.world
    world.resource(AmbientLight).brightness = 2000
    const stone = surface(world, [0.62, 0.6, 0.56], 'stone', 21)
    world.spawn([
      Floor,
      { points: square(2, 2, 12), material: surface(world, [0.5, 0.48, 0.44], 'tile', 8) },
    ])
    // Across x = 8, the edge of the default 8 m chunks.
    world.spawn([Wall, { a: [4, 10], b: [12, 10], height: 2.4, thickness: 0.3, material: stone }])
    world.spawn([
      Wall,
      { a: [5, 6], b: [11, 6], shape: 'arc', bow: 2.2, height: 2, thickness: 0.3, material: stone },
    ])
    r.look([8, 6, 18], [8, 0.8, 8])
    await settle(r.app)
    const chunked = await renderView(r.app, r.view)
    expect(world.resource(Structure).describe().chunks).toBeGreaterThan(1)
    world.patchResource(StructureSettings, { chunkSize: 64 })
    await settle(r.app)
    const whole = await renderView(r.app, r.view)
    expect(world.resource(Structure).describe().chunks).toBe(1)
    expect(maxDiff(chunked, whole)).toBeLessThanOrEqual(2)
    expect(compareGolden(here, 'contact-seams-30', chunked).mean).toBeLessThan(1.5)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })
})
