import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box } from '@aethervtt/shard-mesh'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import {
  type CapturedImage,
  Ink,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
} from '@aethervtt/shard-render'
import { placeInGrid } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evalHeightPoints } from './kernel'
import { mainNoise } from './stack'
import {
  capture,
  heightfieldApp,
  lookAt,
  settleHeightfield,
  untilStreaming,
  VALLEY_HILLS,
  valleySource,
} from './testing'

let gpu: GpuContext
let hills: NoiseGraph
const workers = createNodeWorkers(3)

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
})

afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  workers.dispose()
}, timeout(120_000))

const W = 480
const H = 270
const FOV = 60

type Vec3 = [number, number, number]

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const unit = (a: Vec3): Vec3 => {
  const l = Math.sqrt(dot(a, a))
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Pixel coordinates of a terrain-frame point for a camera at `eye` looking at `target`, +Y up. */
function projector(eye: Vec3, target: Vec3) {
  const forward = unit(sub(target, eye))
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const scale = H / 2 / Math.tan((FOV * Math.PI) / 360)
  return (point: Vec3): [number, number] => {
    const v = sub(point, eye)
    const depth = dot(v, forward)
    return [W / 2 + (dot(v, right) / depth) * scale, H / 2 - (dot(v, up) / depth) * scale]
  }
}

const luma = (image: CapturedImage, i: number) =>
  image.data[i * 4]! * 0.3 + image.data[i * 4 + 1]! * 0.6 + image.data[i * 4 + 2]! * 0.1

/** Whether ink darkens pixel (x, y) by more than a quarter. */
function isInk(image: CapturedImage, plain: CapturedImage, x: number, y: number) {
  const i = y * W + x
  return luma(image, i) < luma(plain, i) * 0.75
}

/** Inked pixels in the first `rows` rows. */
function inkAbove(image: CapturedImage, plain: CapturedImage, rows: number) {
  let n = 0
  for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) if (isInk(image, plain, x, y)) n++
  return n
}

describe('ink on heightfield terrain (0108)', () => {
  it('fades out on far ground at a grazing angle; a box 300 m away keeps its silhouette', {
    timeout: timeout(240_000),
  }, async () => {
    const p = await heightfieldApp(gpu, {
      ...valleySource(),
      noise: { hills },
      workers,
      width: W,
      heightPx: H,
      fovY: FOV,
      clearColor: [0.4, 0.55, 0.8, 1],
    })
    await untilStreaming(p)
    const rt = p.runtime()
    const height = new Float64Array(1)
    /** The ground `d` m ahead (plus `up` m), along the view's heading from the terrain's corner. */
    const along = (d: number, up = 0): Vec3 => {
      const x = 40 + Math.cos(1.1) * d
      const z = 40 + Math.sin(1.1) * d
      evalHeightPoints(mainNoise(), rt.stack!, [x, z], 1, rt.stack!.height.length, height)
      return [x, height[0]! + up, z]
    }
    // 60 m over the ground, looking 2.7 km across the terrain, at the ground 150 m ahead: the
    // upper half of the frame is ground from about 250 m out to the far edge, at a grazing angle.
    const eye = along(0, 60)
    const target = along(150)
    lookAt(p, eye, target)
    const project = projector(eye, target)
    // A 10 × 12 × 10 m box on the ground 300 m ahead, in clear view, glowing white.
    const { world } = p
    const material = world.resource(Materials).add(
      new MaterialAsset({
        baseColor: [0, 0, 0, 1],
        emissive: [0.9, 0.85, 0.8, 1],
        emissiveLuminance: 40_000,
      }),
    )
    const house = world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 10, y: 12, z: 10 })) }],
      [MeshMaterial, { material }],
    )
    const at = along(300, 5)
    placeInGrid(world, house, p.terrain, at)

    // The same passes with clear ink, ink as it was before the fade, then the defaults.
    world.add(p.camera, Ink, { width: 2, color: [0, 0, 0, 0] })
    await settleHeightfield(p)
    const plain = await capture(p)
    world.set(p.camera, Ink, { width: 2, color: [0, 0, 0, 1], fade: [0, 0] })
    const before = await capture(p)
    world.set(p.camera, Ink, { width: 2, color: [0, 0, 0, 1], fade: [60, 250] })
    const after = await capture(p)
    // The far half of the frame: mostly ground, which ink as it was covered in lines.
    const half = H / 2
    let ground = 0
    for (let i = 0; i < half * W; i++)
      if (Math.abs(plain.data[i * 4 + 2]! - plain.data[2]!) > 20) ground++
    expect(ground).toBeGreaterThan(half * W * 0.5)
    const was = inkAbove(before, plain, half)
    const now = inkAbove(after, plain, half)
    expect(was).toBeGreaterThan(ground * 0.4)
    // What's left is ridges against the ground behind them and the terrain's edge against the sky.
    expect(now).toBeLessThan(was * 0.4)
    expect(now).toBeLessThan(ground * 0.3)

    // The box's top edges farthest from the camera, against the ground behind: ink on the box
    // itself (the line sits on the nearer surface), with the fade and without.
    const inkNear = (image: CapturedImage, point: Vec3) => {
      const [px, py] = project(point)
      for (let y = Math.round(py) - 2; y <= Math.round(py) + 2; y++)
        for (let x = Math.round(px) - 2; x <= Math.round(px) + 2; x++)
          if (plain.data[(y * W + x) * 4]! > 240 && isInk(image, plain, x, y)) return true
      return false
    }
    const top = at[1] + 6
    for (const point of [
      [at[0] + 5, top, at[2] + 5],
      [at[0], top, at[2] + 5],
      [at[0] + 5, top, at[2]],
    ] as Vec3[]) {
      expect(inkNear(before, point)).toBe(true)
      expect(inkNear(after, point)).toBe(true)
    }
    await p.app.dispose()
  })
})
