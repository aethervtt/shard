import { type AssetRef, ChildOf } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, loadMeshSimplifier, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight } from './lights'
import { Outline } from './outline'
import { Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { bentTube, meanDifference, pixel, renderView } from './testing'
import { Ink } from './toon'
import { Tonemapping } from './view'

// Outlines (0057) as 0108 left them: skinned rings follow the pose on any LOD level with several
// styles in view, rings draw over other outlined surfaces behind them, nested Outlines follow
// priority then nearness, and a hover ring draws over ink.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadMeshSimplifier()
})
afterAll(() => gpu.destroy())

type Vec3 = [number, number, number]
type Rgba = [number, number, number, number]

/** A gray world under uniform ambient light, seen through orthographic cameras. */
async function scene(size = 96) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  // Ambient alone: every surface the same flat gray, whatever way it faces.
  world.resource(AmbientLight).brightness = 1
  const meshes = world.resource(Meshes)
  const gray = world.resource(Materials).add(new MaterialAsset({ baseColor: [0.4, 0.4, 0.4, 1] }))
  const camera = (eye: Vec3, at: Vec3, orthoHeight: number) => {
    const target = new OffscreenTarget(gpu, { label: 'outline', width: size, height: size })
    const ref = world.resource(RenderTargets).add(target, `outline-${eye}`)
    return world.spawn(
      [
        Camera3d,
        {
          target: ref as AssetRef<'RenderTarget'>,
          projection: 'orthographic',
          orthoHeight,
          clearColor: [0, 0, 0, 1],
        },
      ],
      [Exposure, { ev100: 0 }],
      [Tonemapping, { curve: 'none', dither: false }],
      [Transform, { translation: eye, rotation: lookAt(eye, at) }],
    )
  }
  return { app, world, meshes, gray, camera }
}

/** Pixels whose color is mostly `c`'s dominant channel: rings in pure red, green or blue. */
function count(
  image: { width: number; height: number; data: Uint8Array },
  channel: 0 | 1 | 2,
  x0 = 0,
  y0 = 0,
  x1 = image.width,
  y1 = image.height,
): number {
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = pixel(image, x, y)
      if (p[channel]! > 150 && p[(channel + 1) % 3]! < 90 && p[(channel + 2) % 3]! < 90) n++
    }
  }
  return n
}

const GREEN: Rgba = [0, 1, 0, 1]
const RED: Rgba = [1, 0, 0, 1]
const BLUE: Rgba = [0, 0, 1, 1]

describe('outlines (0108)', () => {
  it('follow a skinned pose, on a LOD level and with several styles in view', {
    timeout: timeout(120_000),
  }, async () => {
    for (const lod of [false, true]) {
      for (const styles of [1, 2]) {
        const { app, world, meshes, gray, camera } = await scene()
        // Looking along -z at the tube, 3 m tall: 32 px a meter, (0, 1) at the centre.
        const cam = camera([0, 1, 5], [0, 1, 0], 3)
        const tubeEntity = bentTube(world, gray, lod)
        world.add(tubeEntity, Outline, { color: GREEN, width: 2, occluded: 'show' })
        if (styles === 2) {
          const other = world.spawn(
            [Mesh3d, { mesh: meshes.add(box({ x: 0.2, y: 0.2, z: 0.2 })) }],
            [MeshMaterial, { material: gray }],
            [Transform, { translation: [1.2, 0.2, 0] }],
          )
          world.add(other, Outline, { color: RED, width: 2, occluded: 'show' })
        }
        const image = await renderView(app, `camera:${cam}`)
        const label = `lod ${lod}, ${styles} styles`
        // The rest pose would stand straight up to (0, 2): nothing outlines there.
        expect(count(image, 1, 40, 0, 56, 20), label).toBe(0)
        // The bent tip, at about (-0.7, 1.7), is ringed.
        expect(count(image, 1, 14, 14, 36, 36), label).toBeGreaterThan(10)
        expect(world.resource(Gpu).errors).toEqual([])
        await app.dispose()
      }
    }
  })

  it('draw over an outlined ground, and nested Outlines follow priority, then nearness', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, meshes, gray, camera } = await scene()
    // Top down: 8 m tall, 12 px a meter.
    const cam = camera([0, 10, 0.0001], [0, 0, 0], 8)
    const ground = world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 6 })) }],
      [MeshMaterial, { material: gray }],
      [Transform, {}],
    )
    const parent = world.spawn([Transform, { translation: [0, 0.25, 0] }])
    const child = world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: 2, y: 0.5, z: 2 })) }],
      [MeshMaterial, { material: gray }],
      [Transform, {}],
      [ChildOf, { parent }],
    )
    world.add(ground, Outline, { color: BLUE, width: 3, occluded: 'show' })
    // The box's ring, around a 24 px square, lies over the ground's silhouette.
    world.add(child, Outline, { color: GREEN, width: 3, occluded: 'show' })
    let image = await renderView(app, `camera:${cam}`)
    const ring = count(image, 1)
    expect(ring).toBeGreaterThan(4 * 24 * 2)
    // The ground's own ring stays outside it: 6 m, 72 px.
    expect(count(image, 2)).toBeGreaterThan(4 * 72 * 2)
    expect(count(image, 2, 24, 24, 72, 72)).toBe(0)
    // The parent's Outline at the same priority: the child's, nearer, still wins.
    world.add(parent, Outline, { color: RED, width: 3, occluded: 'show' })
    image = await renderView(app, `camera:${cam}`)
    expect(count(image, 1)).toBe(ring)
    expect(count(image, 0)).toBe(0)
    // A higher priority on the parent wins, whatever was added first.
    world.set(parent, Outline, { color: RED, width: 3, occluded: 'show', priority: 1 })
    image = await renderView(app, `camera:${cam}`)
    expect(count(image, 0)).toBe(ring)
    expect(count(image, 1)).toBe(0)
    world.remove(child, Outline)
    world.add(child, Outline, { color: GREEN, width: 3, occluded: 'show' })
    image = await renderView(app, `camera:${cam}`)
    expect(count(image, 0)).toBe(ring)
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
  })

  it('draw a hover ring over ink, and leave the inked image as it was', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, meshes, gray, camera } = await scene()
    const cam = camera([0, 10, 0.0001], [0, 0, 0], 8)
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 20 })) }],
      [MeshMaterial, { material: gray }],
      [Transform, {}],
    )
    const target = world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: 2, y: 0.5, z: 2 })) }],
      [MeshMaterial, { material: gray }],
      [Transform, { translation: [0, 0.25, 0] }],
    )
    world.add(cam, Ink, { width: 3, color: [0, 0, 0, 1] })
    const inked = await renderView(app, `camera:${cam}`)
    // The box spans pixels 36–59; ink 3 px wide straddles its edge, on the ground at x = 35.
    const y = 48
    expect(pixel(inked, 35, y)[0]!).toBeLessThan(40)
    expect(pixel(inked, 30, y)[0]!).toBeGreaterThan(80)
    world.add(target, Outline, { color: GREEN, width: 3, occluded: 'show' })
    const hovered = await renderView(app, `camera:${cam}`)
    const p = pixel(hovered, 35, y)
    expect(p[1]!).toBeGreaterThan(200)
    expect(p[0]!).toBeLessThan(40)
    world.remove(target, Outline)
    const after = await renderView(app, `camera:${cam}`)
    expect(meanDifference(after.data, inked.data)).toBe(0)
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
  })
})
