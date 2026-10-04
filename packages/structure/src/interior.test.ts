import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetRef, Entity } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Gpu,
  InteriorLightingResource,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  PointLight,
  Visibility,
  worldToScreen,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, renderView, settle } from '@aethervtt/shard-render/testing'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Structure } from './compile'
import { Floor, Level, Opening, Roof, StructureSettings, Wall } from './components'
import { type Rig, rig } from './harness'
import { Interior, skyAt } from './interior-plugin'

// Interior lighting from the plan (0069).

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

type World = Rig['app']['world']

const square = (x: number, z: number, w: number, d = w): [number, number][] => [
  [x, z],
  [x + w, z],
  [x + w, z + d],
  [x, z + d],
]

function color(world: World, c: [number, number, number]): AssetRef<'Material'> {
  return world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [...c, 1], roughness: 1 })) as never
}

interface RoomOptions {
  /** A window in the south wall (z = z0), this wide, centred; sight none so light comes in. */
  window?: number
  /** A door in the east wall, at this offset, 1 m wide. */
  door?: number
  roof?: boolean
  height?: number
  material?: AssetRef<'Material'>
}

/** Four walls (south, east, north, west), a floor, and a roof overhanging 0.5 m. */
function room(world: World, x: number, z: number, size: number, o: RoomOptions = {}) {
  const c = square(x, z, size)
  const height = o.height ?? 2.8
  const walls = c.map((a, i) =>
    world.spawn([
      Wall,
      {
        a,
        b: c[(i + 1) % 4]!,
        height,
        thickness: 0.2,
        ...(o.material ? { material: o.material } : {}),
      },
    ]),
  )
  const window =
    o.window !== undefined
      ? world.spawn([
          Opening,
          {
            wall: walls[0]!,
            kind: 'window',
            offset: (size - o.window) / 2,
            width: o.window,
            height: 1.2,
            sill: 0.9,
            sight: 'none',
          },
        ])
      : undefined
  const door =
    o.door !== undefined
      ? world.spawn([
          Opening,
          { wall: walls[1]!, kind: 'door', offset: o.door, width: 1, height: 2.1 },
        ])
      : undefined
  const floor = world.spawn([
    Floor,
    { points: c, thickness: 0, ...(o.material ? { material: o.material } : {}) },
  ])
  const roof =
    o.roof === false
      ? undefined
      : world.spawn([Roof, { points: square(x - 0.5, z - 0.5, size + 1), height, thickness: 0.2 }])
  return { walls, window, door, floor, roof }
}

/** Sky visibility at every texel centre strictly inside [x0, x1] × [z0, z1], at floor height. */
function samples(world: World, x0: number, z0: number, x1: number, z1: number, step = 0.25) {
  const out: number[] = []
  for (let z = z0 + step / 2; z < z1; z += step)
    for (let x = x0 + step / 2; x < x1; x += step) out.push(skyAt(world, x, 0.01, z))
  return out
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length

describe('sky visibility', () => {
  it('is 0 in a sealed roofed room, and 1 without its roof', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    const a = room(world, 0, 0, 6)
    r.frame()
    // Inside the walls' inner faces.
    const inside = samples(world, 0.2, 0.2, 5.8, 5.8)
    expect(Math.max(...inside)).toBe(0)
    expect(skyAt(world, -3, 0.01, 3)).toBe(1)
    world.despawn(a.roof!)
    r.frame()
    expect(Math.min(...samples(world, 0.2, 0.2, 5.8, 5.8))).toBe(1)
    await r.dispose()
  })

  it('falls with distance from a window; a wider one lets in more', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    const a = room(world, 0, 0, 10, { window: 1 })
    r.frame()
    let last = 1
    for (let z = 0.3; z < 9.7; z += 0.25) {
      const v = skyAt(world, 5, 0.01, z)
      expect(v).toBeLessThanOrEqual(last + 1e-6)
      last = v
    }
    expect(skyAt(world, 5, 0.01, 0.3)).toBeGreaterThan(0.2)
    const narrow = mean(samples(world, 0.2, 0.2, 9.8, 9.8))
    world.set(a.window!, Opening, { width: 2, offset: 4 })
    r.frame()
    expect(mean(samples(world, 0.2, 0.2, 9.8, 9.8))).toBeGreaterThan(narrow * 1.3)
    await r.dispose()
  })

  it('re-solves only near a toggled door, rebuilding no chunk', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    // A row of rooms, the middle one's door opening onto the outside.
    room(world, 0, 0, 6, { window: 1 })
    const mid = room(world, 8, 0, 6, { door: 2.5 })
    room(world, 16, 0, 6, { window: 1 })
    r.frame()
    const interior = world.resource(Interior)
    expect(interior.last?.full).toBe(true)
    const field = interior.grid!
    const before = interior.layers[0]!.packed.slice()
    const rebuilt = world.resource(Structure).chunksRebuilt
    world.set(mid.door!, Opening, { state: 'open' })
    r.frame()
    const last = interior.last!
    expect(last.full).toBe(false)
    expect(world.resource(Structure).chunksRebuilt).toBe(rebuilt)
    // The region: the door's opening (x = 14, z 2.5 to 3.5) grown by 2 × spillReach (6 m), plus
    // a texel of blur.
    const reach = 2 * world.resource(StructureSettings).interior.spillReach
    for (const region of last.regions) {
      expect(region.bounds[0]).toBeGreaterThanOrEqual(14 - 0.1 - reach - 0.5)
      expect(region.bounds[2]).toBeLessThanOrEqual(14 + 0.1 + reach + 0.5)
      expect(region.bounds[1]).toBeGreaterThanOrEqual(2.5 - reach - 0.5)
      expect(region.bounds[3]).toBeLessThanOrEqual(3.5 + reach + 0.5)
    }
    const side = Math.ceil((2 * reach + 1.2) / field.texel) + 4
    expect(last.uploaded).toBeLessThanOrEqual(side * side)
    // Texels outside the uploaded region kept their values; inside, the room brightened.
    const after = interior.layers[0]!.packed
    let changedFar = 0
    for (let j = 0; j < field.height; j++)
      for (let i = 0; i < field.width; i++) {
        const x = field.ox + (i + 0.5) * field.texel
        const z = field.oz + (j + 0.5) * field.texel
        const far = Math.abs(x - 14) > reach + 1 || Math.abs(z - 3) > reach + 1
        if (far && after[j * field.width + i] !== before[j * field.width + i]) changedFar++
      }
    expect(changedFar).toBe(0)
    expect(skyAt(world, 12, 0.01, 3)).toBeGreaterThan(0.05)
    await r.dispose()
  })

  it('leaves the field unchanged, byte for byte, when a roof hides or is cut away', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    const a = room(world, 0, 0, 8, { window: 1.5 })
    r.frame()
    const interior = world.resource(Interior)
    const before = interior.layers[0]!.packed.slice()
    const solves = interior.last
    world.add(a.roof!, Visibility, { mode: 'hidden' })
    world.set(a.roof!, Roof, { shadowWhenHidden: false })
    r.frame()
    r.frame()
    expect(interior.layers[0]!.packed).toEqual(before)
    expect(interior.last).toBe(solves)
    // A cutaway roof (0070) counts whole too.
    world.set(a.roof!, Roof, { cutaway: true })
    r.frame()
    expect(interior.layers[0]!.packed).toEqual(before)
    expect(interior.last).toBe(solves)
    await r.dispose()
  })

  it('treats skylights as full sources and closed hatches as cover', {
    timeout: timeout(60_000),
  }, async () => {
    const { Cutout } = await import('./components')
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    const a = room(world, 0, 0, 8)
    r.frame()
    expect(skyAt(world, 4, 0.01, 4)).toBe(0)
    const skylight = world.spawn([
      Cutout,
      { host: a.roof!, points: square(3, 3, 2), kind: 'skylight' },
    ])
    r.frame()
    // Under the skylight: open sky (the field's floor reads the texel straight up).
    expect(skyAt(world, 4, 0.01, 4)).toBe(1)
    expect(skyAt(world, 1, 0.01, 1)).toBeGreaterThan(0.01)
    world.set(skylight, Cutout, { kind: 'hatch', state: 'closed' })
    r.frame()
    // Sealed again, to the region solve's precision.
    expect(skyAt(world, 4, 0.01, 4)).toBeLessThan(1e-3)
    world.set(skylight, Cutout, { state: 'open' })
    r.frame()
    expect(skyAt(world, 4, 0.01, 4)).toBe(1)
    await r.dispose()
  })

  it('reads a level’s own layer; a floor above covers the one below', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    const ground = world.spawn([Level, { index: 0, elevation: 0, height: 3 }], Transform)
    const upper = world.spawn([Level, { index: 1, elevation: 3, height: 3 }], Transform)
    const c = square(0, 0, 6)
    for (let i = 0; i < 4; i++)
      world.spawn([Wall, { a: c[i]!, b: c[(i + 1) % 4]!, height: 3, level: ground }])
    world.spawn([Floor, { points: c, level: upper }])
    r.frame()
    // Under the upper floor: sealed. On top of it (upper level, no roof): outdoors.
    expect(skyAt(world, 3, 0.5, 3)).toBe(0)
    expect(skyAt(world, 3, 3.5, 3)).toBe(1)
    const described = world.resource(Structure).describe() as { interior: { levels: unknown[] } }
    expect(described.interior.levels).toHaveLength(2)
    await r.dispose()
  })
})

describe('sky visibility, rendered', () => {
  it('lights an interior wall face by the room, not the sky outside it (30°)', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: true, interior: true, width: 128, height: 96 })
    const world = r.app.world
    Object.assign(world.resource(AmbientLight), { brightness: 4000 })
    const white = color(world, [0.8, 0.8, 0.8])
    const a = room(world, -3, -3, 6, { window: 1, material: white })
    // Hidden, still casting: the view sees in, the room stays dark.
    world.add(a.roof!, Visibility, { mode: 'hidden' })
    // Looking at the north wall's inside face (z = 3, far from the window) from the south, about
    // 30° above the horizon, over the window wall.
    r.look([1.5, 6, -7], [0, 0.8, 2.6])
    await settle(r.app)
    const image = await renderView(r.app, r.view)
    expect(world.resource(Gpu).errors).toEqual([])
    expect(compareGolden(here, 'interior-wall-30', image).mean).toBeLessThan(1.5)
    // The north wall's inside face (the field there is near 0) is darker than its top, outdoors.
    const face = pixel(image, 64, 40)
    const sky = skyAt(world, 0, 1, 2.7)
    expect(sky).toBeLessThan(0.2)
    expect(face[0]!).toBeLessThan(120)
    await r.dispose()
  })

  it('frees the field with sky off, and the rows with blockLights off', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    room(world, 0, 0, 6, { window: 1 })
    torch(world, 3, 1.5, 3)
    r.frame()
    const lighting = world.resource(InteriorLightingResource)
    expect(lighting.fieldLayers).toBe(1)
    expect(lighting.rowCount).toBe(256)
    expect([lighting.sky, lighting.blocked]).toEqual([true, true])
    const both = lighting.bytes
    world.patchResource(StructureSettings, { interior: { sky: false } } as never)
    r.frame()
    expect(lighting.fieldLayers).toBe(0)
    expect(lighting.sky).toBe(false)
    expect(world.resource(Interior).grid).toBeUndefined()
    expect(lighting.bytes).toBeLessThan(both)
    world.patchResource(StructureSettings, { interior: { sky: true, blockLights: false } } as never)
    r.frame()
    expect(lighting.fieldLayers).toBe(1)
    expect(lighting.rowCount).toBe(0)
    expect(lighting.blocked).toBe(false)
    expect(world.resource(Interior).lights.size).toBe(0)
    world.patchResource(StructureSettings, { interior: { sky: false } } as never)
    r.frame()
    expect(lighting.bytes).toBe(0)
    expect(lighting.mode).toBe(0)
    // Back on: built again.
    world.patchResource(StructureSettings, { interior: { sky: true, blockLights: true } } as never)
    r.frame()
    expect(lighting.mode).toBe(3)
    expect(skyAt(world, 3, 0.01, 5.5)).toBeLessThan(0.1)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('renders byte-identical without the plugin when both parts are off', {
    timeout: timeout(60_000),
  }, async () => {
    const shoot = async (interior: boolean, off: boolean) => {
      const r = await rig(gpu, { shadows: true, interior, width: 96, height: 64 })
      const world = r.app.world
      Object.assign(world.resource(AmbientLight), { brightness: 4000 })
      if (off)
        world.patchResource(StructureSettings, {
          interior: { sky: false, blockLights: false },
        } as never)
      const a = room(world, -3, -3, 6, { window: 1, door: 2 })
      world.add(a.roof!, Visibility, { mode: 'hidden' })
      world.spawn(
        [PointLight, { intensity: 20_000, range: 8, blockedByWalls: true }],
        [Transform, { translation: [0, 1.5, 0] }],
      )
      r.look([2, 6, 7], [0, 0, 0])
      await settle(r.app)
      const image = await renderView(r.app, r.view)
      const lighting = world.tryResource(InteriorLightingResource)
      const bytes = lighting?.bytes ?? 0
      await r.dispose()
      return { image, bytes }
    }
    const without = await shoot(false, false)
    const off = await shoot(true, true)
    const on = await shoot(true, false)
    expect(off.bytes).toBe(0)
    expect(off.image.data).toEqual(without.image.data)
    expect(on.bytes).toBeGreaterThan(0)
    expect(on.image.data).not.toEqual(without.image.data)
  })
})

/** A torch: tabletop falloff, 2 m bright, 7 m range, blocked by walls. */
function torch(world: World, x: number, y: number, z: number): Entity {
  return world.spawn(
    [
      PointLight,
      {
        intensity: 40_000,
        range: 7,
        falloff: 'tabletop',
        bright: 2,
        blockedByWalls: true,
        color: [1, 0.75, 0.45, 1],
      },
    ],
    [Transform, { translation: [x, y, z] }],
  )
}

describe('wall-blocked lights', () => {
  it('light their room, not the next, and go through an open door (top-down)', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, {
      shadows: false,
      interior: true,
      width: 128,
      height: 64,
      orthoHeight: 8,
    })
    const world = r.app.world
    world.despawn(r.sun)
    const white = color(world, [0.8, 0.8, 0.8])
    // Two rooms side by side sharing a wall at x = 0, a door in it; no roofs, no sky light.
    const west = room(world, -6, -3, 6, { roof: false, door: 2.5, material: white })
    // The east room shares the west room's east wall.
    const east = square(0, -3, 6)
    for (let i = 0; i < 3; i++)
      world.spawn([
        Wall,
        { a: east[i]!, b: east[i + 1]!, height: 2.8, thickness: 0.2, material: white },
      ])
    world.spawn([Floor, { points: east, thickness: 0, material: white }])
    torch(world, -3, 1.5, 0)
    r.look([0, 20, 0.0001], [0, 0, 0])
    world.patchResource(StructureSettings, { interior: { sky: false } } as never)
    await settle(r.app)
    const closed = await renderView(r.app, r.view)
    expect(world.resource(Gpu).errors).toEqual([])
    expect(compareGolden(here, 'interior-torch-closed', closed).mean).toBeLessThan(1.5)
    // Lit in its room (left), dark in the next (right).
    const lit = pixel(closed, 32, 32)
    const next = pixel(closed, 96, 32)
    expect(lit[0]!).toBeGreaterThan(60)
    expect(next[0]! + next[1]! + next[2]!).toBe(0)
    world.set(west.door!, Opening, { state: 'open' })
    await settle(r.app)
    const open = await renderView(r.app, r.view)
    expect(compareGolden(here, 'interior-torch-open', open).mean).toBeLessThan(1.5)
    // Through the doorway (east wall at z 2.5..3.5 from z0 = -3, so z -0.5..0.5): a lit wedge.
    const through = pixel(open, 72, 32)
    expect(through[0]!).toBeGreaterThan(20)
    // Beside the wedge, behind the wall, still dark.
    const beside = pixel(open, 72, 16)
    expect(beside[0]! + beside[1]! + beside[2]!).toBe(0)
    await r.dispose()
  })

  it('a low wall blocks the floor behind it, not a tall pillar’s top', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true, width: 128, height: 96 })
    const world = r.app.world
    world.despawn(r.sun)
    world.patchResource(StructureSettings, { interior: { sky: false } } as never)
    const white = color(world, [0.8, 0.8, 0.8])
    world.spawn([Floor, { points: square(-6, -6, 12), material: white }])
    // A 1.2 m garden wall along z at x = 1; the torch 1.5 m up, 2 m west of it; a 2 m pillar
    // 2 m east of it. From the torch the wall's top hides the floor behind it, and the pillar's
    // face below about y = 1.
    world.spawn([Wall, { a: [1, -5], b: [1, 5], height: 1.2, thickness: 0.2, material: white }])
    torch(world, -1, 1.5, 0)
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 0.4, y: 2, z: 0.4 })) }],
      [MeshMaterial, { material: white }],
      [Transform, { translation: [3, 1, 0] }],
    )
    r.look([0.5, 8, -7], [1.5, 0.5, 0])
    await settle(r.app)
    const image = await renderView(r.app, r.view)
    expect(world.resource(Gpu).errors).toEqual([])
    expect(compareGolden(here, 'interior-garden-wall', image).mean).toBeLessThan(1.5)
    const at = (p: [number, number, number]) => {
      const out = [0, 0]
      worldToScreen(world, r.camera, p, out)
      const c = pixel(image, Math.round(out[0]!), Math.round(out[1]!))
      return c[0]! + c[1]! + c[2]!
    }
    // The floor in front of the wall is lit, behind it dark.
    expect(at([-0.5, 0, -1])).toBeGreaterThan(150)
    expect(at([2.2, 0, -1])).toBe(0)
    // The pillar's face toward the torch: its top clears the wall, its foot doesn't.
    expect(at([2.8, 1.8, 0])).toBeGreaterThan(60)
    expect(at([2.8, 0.4, 0])).toBe(0)
    await r.dispose()
  })

  it('rebuilds only a moved light’s row, and only the rows a door toggle reaches', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    const a = room(world, 0, 0, 6, { door: 2.5 })
    room(world, 20, 0, 6)
    const near = torch(world, 3, 1.5, 3)
    const far = torch(world, 23, 1.5, 3)
    r.frame()
    const interior = world.resource(Interior)
    const rebuilt = () => [interior.lights.get(near)!.rebuilt, interior.lights.get(far)!.rebuilt]
    const [n0, f0] = rebuilt()
    world.set(near, Transform, { translation: [3.5, 1.5, 3] })
    r.frame()
    const [n1, f1] = rebuilt()
    expect(n1).toBeGreaterThan(n0!)
    expect(f1).toBe(f0)
    expect(interior.lastRows.lights).toBe(1)
    world.set(a.door!, Opening, { state: 'open' })
    r.frame()
    const [n2, f2] = rebuilt()
    expect(n2).toBeGreaterThan(n1!)
    expect(f2).toBe(f1)
    // A still frame rebuilds nothing.
    r.frame()
    expect(rebuilt()).toEqual([n2, f2])
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('reports too many blocked lights once, and lights the rest unblocked', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false, interior: true })
    const world = r.app.world
    world.patchResource(StructureSettings, { interior: { maxBlockedLights: 2 } } as never)
    room(world, 0, 0, 6)
    const lights = [0, 1, 2].map((i) => torch(world, 1 + i * 2, 1.5, 3))
    r.frame()
    r.frame()
    const interior = world.resource(Interior)
    const rows = lights.map((l) => interior.lights.get(l)!.row)
    expect(rows.filter((row) => row >= 0)).toHaveLength(2)
    const { LogResource } = await import('@aethervtt/shard-runtime')
    const log = world.resource(LogResource)
    const errors = log.tail(500).filter((e) => e.code === 'structure/too-many-blocked-lights')
    expect(errors).toHaveLength(1)
    // One goes, the third takes its row.
    world.despawn(lights[0]!)
    r.frame()
    expect(interior.lights.get(lights[2]!)!.row).toBeGreaterThanOrEqual(0)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })
})
