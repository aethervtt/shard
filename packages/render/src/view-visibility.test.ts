import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AssetRef, ChildOf, type Entity } from '@aethervtt/shard-core'
import { allocationChecks, gcWindow, timeout } from '@aethervtt/shard-core/test-env'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Culler, readVisibleSlots, visibleSlots } from './culling'
import { InstanceSlot, Instances, Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { describeRender, Gpu, renderPlugin } from './plugin'
import { worldToScreen } from './projection'
import { forwardPlugin } from './standard'
import { RenderStats } from './stats'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { Cameras, Tonemapping } from './view'
import { HiddenSetsResource, ViewVisibility } from './view-visibility'
import { resolveViewVisibility } from './view-visibility-plugin'
import { Visibility } from './visibility'

// Per-view hiding (0070).

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const W = 96
const H = 64

/**
 * A lit floor, a pillar, and a group (a root with two boxes under it) for one camera to hide. Two
 * cameras on separate targets see it from the same place.
 */
async function scene(gpuCull: boolean, options: { group?: boolean } = {}) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  world.resource(Culler).enabled = gpuCull
  const targets = [0, 1].map(
    (i) => new OffscreenTarget(gpu, { label: `vv${i}`, width: W, height: H }),
  )
  const refs = targets.map(
    (t, i) => world.resource(RenderTargets).add(t, `vv${i}`) as AssetRef<'RenderTarget'>,
  )
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const color = (c: [number, number, number]) =>
    materials.add(new MaterialAsset({ baseColor: [...c, 1], roughness: 1 }))
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 16 })) }],
    [MeshMaterial, { material: color([0.8, 0.8, 0.8]) }],
    Transform,
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 0.6, y: 2, z: 0.6 })) }],
    [MeshMaterial, { material: color([0.2, 0.3, 0.9]) }],
    [Transform, { translation: [-3, 1, -1] }],
  )
  const group = world.spawn([Transform, { translation: [1, 0, 0] }])
  const parts: Entity[] = []
  if (options.group !== false) {
    const red = color([0.9, 0.15, 0.1])
    const tall = meshes.add(box({ x: 0.8, y: 3, z: 0.8 }))
    parts.push(
      world.spawn(
        [Mesh3d, { mesh: tall }],
        [MeshMaterial, { material: red }],
        [Transform, { translation: [0, 1.5, 0] }],
        [ChildOf, { parent: group }],
      ),
    )
    const top = world.spawn([Transform, { translation: [0, 3, 0] }], [ChildOf, { parent: group }])
    parts.push(
      world.spawn(
        [Mesh3d, { mesh: meshes.add(box({ x: 1.2, y: 1.2, z: 1.2 })) }],
        [MeshMaterial, { material: red }],
        [Transform, { translation: [0, 0.6, 0] }],
        [ChildOf, { parent: top }],
      ),
    )
  }
  world.spawn(
    [DirectionalLight, { illuminance: 20_000, shadows: true }],
    [Transform, { rotation: lookAt([-4, 8, 3], [0, 0, 0]) }],
  )
  const eye: [number, number, number] = [0, 9, 11]
  const camera = (i: number) =>
    world.spawn(
      [Camera3d, { target: refs[i]!, fovY: 50 }],
      [Exposure, { ev100: 12 }],
      [Tonemapping, { dither: false }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
    )
  const hider = camera(0)
  const other = camera(1)
  return {
    app,
    world,
    group,
    parts,
    hider,
    other,
    refs,
    async dispose() {
      await app.dispose()
      for (const t of targets) t.destroy()
    },
  }
}

const slotOf = (world: App['world'], e: Entity) => world.get(e, InstanceSlot).slot - 1

/** The slots a camera's opaque list drew last frame, from the GPU cull or the CPU one. */
async function drawn(world: App['world'], camera: Entity): Promise<Set<number>> {
  const cam = world.resource(Cameras).get(camera)!
  return cam.draws.cullView >= 0
    ? readVisibleSlots(gpu, world.resource(Culler), cam.draws)
    : visibleSlots(world.resource(Instances), cam.draws)
}

describe('ViewVisibility', () => {
  for (const gpuCull of [false, true]) {
    it(`the hiding camera never draws the group and the other always does (${gpuCull ? 'GPU' : 'CPU'} culling)`, {
      timeout: timeout(60_000),
    }, async () => {
      const s = await scene(gpuCull)
      const { world } = s
      world.add(s.hider, ViewVisibility, { hide: [s.group] })
      await settle(s.app)
      for (let i = 0; i < 3; i++) s.app.update(1 / 60)
      const slots = s.parts.map((p) => slotOf(world, p))
      const hidden = await drawn(world, s.hider)
      const shown = await drawn(world, s.other)
      // The baseline tier (0064) culls on the CPU only.
      expect(world.resource(Culler).active).toBe(gpuCull && world.resource(Culler).supported)
      for (const slot of slots) {
        expect(hidden.has(slot)).toBe(false)
        expect(shown.has(slot)).toBe(true)
      }
      // Everything else draws in both.
      expect(hidden.size).toBe(shown.size - slots.length)
      expect(world.resource(Gpu).errors).toEqual([])
      await s.dispose()
    })
  }

  it("keeps the hidden group's shadow in both views, and drops it from the hider's with shadows: 'hide'", {
    timeout: timeout(60_000),
  }, async () => {
    const shot = async (mode: 'keep' | 'hide' | 'absent') => {
      const s = await scene(true, { group: mode !== 'absent' })
      const { world } = s
      world.add(s.hider, ViewVisibility, {
        hide: [s.group],
        shadows: mode === 'hide' ? 'hide' : 'keep',
      })
      await settle(s.app)
      const hider = await renderView(s.app, `camera:${s.hider}`)
      const other = await renderView(s.app, `camera:${s.other}`)
      // A floor point in the tall box's shadow (the sun shines from -x, +y, +z).
      const at = [0, 0]
      worldToScreen(world, s.hider, [2.2, 0, -0.8], at)
      const shade = (img: typeof hider) => {
        const p = pixel(img, Math.round(at[0]!), Math.round(at[1]!))
        return p[0]! + p[1]! + p[2]!
      }
      const tower = [0, 0]
      worldToScreen(world, s.hider, [1, 1.5, 0.4], tower)
      const red = (img: typeof hider) => {
        const p = pixel(img, Math.round(tower[0]!), Math.round(tower[1]!))
        return p[0]! > p[1]! * 1.5 && p[0]! > p[2]! * 1.5
      }
      expect(world.resource(Gpu).errors).toEqual([])
      await s.dispose()
      return { hider, other, shadow: [shade(hider), shade(other)], red: [red(hider), red(other)] }
    }
    const keep = await shot('keep')
    const hide = await shot('hide')
    const absent = await shot('absent')
    // The hider doesn't draw the group; the other camera does.
    expect(keep.red).toEqual([false, true])
    expect(hide.red).toEqual([false, true])
    // Kept: its shadow falls in both views, as dark as where nothing hides it.
    expect(keep.shadow[0]!).toBeLessThan(absent.shadow[0]! * 0.6)
    expect(keep.shadow[1]!).toBeLessThan(absent.shadow[1]! * 0.6)
    expect(Math.abs(keep.shadow[0]! - keep.shadow[1]!)).toBeLessThanOrEqual(6)
    // Hidden from the hider's cascades: its floor is lit; the other camera's cascades keep it.
    expect(hide.shadow[0]!).toBeGreaterThan(absent.shadow[0]! * 0.9)
    expect(hide.shadow[1]!).toBeLessThan(absent.shadow[1]! * 0.6)
    expect(compareGolden(here, 'view-visibility-hider', keep.hider).mean).toBeLessThan(1.5)
    expect(compareGolden(here, 'view-visibility-other', keep.other).mean).toBeLessThan(1.5)
  })

  it('a camera with an empty list, or none, renders the same; another camera hiding things changes nothing in it', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene(true)
    await settle(s.app)
    const before = await renderView(s.app, `camera:${s.other}`)
    s.world.add(s.other, ViewVisibility, { hide: [] })
    s.world.add(s.hider, ViewVisibility, { hide: [s.group] })
    await settle(s.app, 4)
    const after = await renderView(s.app, `camera:${s.other}`)
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(true)
    await s.dispose()
  })

  it('follows the hierarchy: a child added, moved in or out, or despawned', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene(false)
    const { world } = s
    world.add(s.hider, ViewVisibility, { hide: [s.group] })
    await settle(s.app)
    const sets = world.resource(HiddenSetsResource)
    const set = sets.sets.get(s.hider)!
    expect(set.slots).toBe(2)
    const meshes = world.resource(Meshes)
    const material = world.resource(Materials).add(new MaterialAsset({}))
    const late = world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: 0.5, y: 0.5, z: 0.5 })) }],
      [MeshMaterial, { material }],
      [Transform, { translation: [4, 0.25, 2] }],
      [ChildOf, { parent: s.group }],
    )
    s.app.update(1 / 60)
    expect(set.slots).toBe(3)
    expect((await drawn(world, s.hider)).has(slotOf(world, late))).toBe(false)
    world.remove(late, ChildOf)
    s.app.update(1 / 60)
    expect(set.slots).toBe(2)
    expect((await drawn(world, s.hider)).has(slotOf(world, late))).toBe(true)
    world.add(late, ChildOf, { parent: s.parts[0]! })
    s.app.update(1 / 60)
    expect(set.slots).toBe(3)
    world.despawn(s.parts[1]!)
    s.app.update(1 / 60)
    expect(set.slots).toBe(2)
    // The list itself: a part listed alone, then nothing.
    world.set(s.hider, ViewVisibility, { hide: [late] })
    s.app.update(1 / 60)
    expect(set.slots).toBe(1)
    world.remove(s.hider, ViewVisibility)
    s.app.update(1 / 60)
    expect(sets.sets.size).toBe(0)
    expect(world.resource(Cameras).get(s.hider)!.hidden).toBeUndefined()
    expect(world.resource(Gpu).errors).toEqual([])
    await s.dispose()
  })

  it('uploads only the words that change; a still frame with lists on three cameras uploads nothing and allocates nothing', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene(true)
    const { world } = s
    // 256 more slots, under one root, so the group's slots span many words.
    const meshes = world.resource(Meshes)
    const material = world.resource(Materials).add(new MaterialAsset({}))
    const cube = meshes.add(box({ x: 0.1, y: 0.1, z: 0.1 }))
    const crowd = world.spawn(Transform)
    const members: Entity[] = []
    for (let i = 0; i < 256; i++)
      members.push(
        world.spawn(
          [Mesh3d, { mesh: cube }],
          [MeshMaterial, { material }],
          [Transform, { translation: [(i % 16) * 0.3 - 2.4, 0.05, Math.floor(i / 16) * 0.3] }],
          [ChildOf, { parent: crowd }],
        ),
      )
    const third = world.spawn(
      [Camera3d, { target: s.refs[1]!, order: 1 }],
      [Transform, { translation: [0, 12, 0.01], rotation: lookAt([0, 12, 0.01], [0, 0, 0]) }],
    )
    world.add(s.hider, ViewVisibility, { hide: [crowd] })
    world.add(s.other, ViewVisibility, { hide: [s.group] })
    world.add(third, ViewVisibility, { hide: [s.group, crowd] })
    await settle(s.app)
    for (let i = 0; i < 3; i++) s.app.update(1 / 60)
    const sets = world.resource(HiddenSetsResource)
    const stats = world.resource(RenderStats)
    // Only the GPU cull reads the sets from a buffer (the baseline tier culls on the CPU).
    const uploads = world.resource(Culler).active
    const uploaded = (bytes: number) => {
      if (uploads) expect(sets.uploadedBytes).toBe(bytes)
    }
    const resolves = sets.resolves
    s.app.update(1 / 60)
    expect(sets.resolves).toBe(resolves)
    uploaded(0)
    expect(stats.lastFrame.bytes.instances).toBe(0)
    // One member's slot leaves the hider's list: one word changes.
    const one = members[100]!
    world.remove(one, ChildOf)
    s.app.update(1 / 60)
    // Two cameras list the crowd: one word each. The third's set resolves too (the hierarchy
    // changed) but none of its words change.
    uploaded(8)
    // A new list: exactly the words that differ.
    world.set(s.other, ViewVisibility, { hide: [s.group, crowd] })
    s.app.update(1 / 60)
    const changed = new Set<number>()
    for (const m of members) if (m !== one) changed.add(slotOf(world, m) >>> 5)
    uploaded(changed.size * 4)
    s.app.update(1 / 60)
    uploaded(0)
    // The resolve and upload alone, frame after frame: nothing to do, nothing allocated.
    const local = resolveViewVisibility.setup!(world)
    const buffer = new GpuBuffer(gpu, { label: 'test/hidden', usage: GPUBufferUsage.STORAGE })
    const tick = () => {
      world.incrementTick()
      resolveViewVisibility.run(local, world, {
        lastRunTick: world.tick - 1,
        thisRunTick: world.tick,
      } as never)
      sets.upload(buffer, 0)
    }
    for (let i = 0; i < 200; i++) tick()
    const before = sets.resolves
    if (allocationChecks) {
      globalThis.gc?.()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const window = gcWindow()
      for (let i = 0; i < 2000; i++) tick()
      expect(await window.end()).toBe(0)
    }
    expect(sets.resolves).toBe(before)
    expect(sets.uploadedBytes).toBe(0)
    buffer.destroy()
    const described = describeRender(world).viewVisibility as Record<
      string,
      { hide: number[]; slots: number }
    >
    expect(described[`camera:${third}`]!.slots).toBe(2 + 255)
    expect(world.resource(Gpu).errors).toEqual([])
    await s.dispose()
  })

  it('Visibility still hides from every camera', { timeout: timeout(60_000) }, async () => {
    const s = await scene(false)
    const { world } = s
    world.add(s.hider, ViewVisibility, { hide: [s.parts[0]!] })
    world.add(s.group, Visibility, { mode: 'hidden' })
    await settle(s.app)
    for (const camera of [s.hider, s.other]) {
      const set = await drawn(world, camera)
      for (const p of s.parts) expect(set.has(slotOf(world, p))).toBe(false)
    }
    await s.dispose()
  })
})
