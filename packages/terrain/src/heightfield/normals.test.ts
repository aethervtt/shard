import { quat } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Gpu } from '@aethervtt/shard-render'
import { Texture } from '@aethervtt/shard-texture'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HeightfieldDebug } from './render'
import {
  capture,
  EDIT_HILLS,
  type HeightfieldApp,
  heightfieldApp,
  lookAt,
  settleHeightfield,
  untilStreaming,
} from './testing'

// 0105: layer normal maps, OpenGL convention, on top of the page normals, planar and triplanar.

let full: GpuContext
let compat: GpuContext
let hills: NoiseGraph

beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
  await loadNoiseKernel()
  hills = await NoiseGraph.create(EDIT_HILLS)
})

afterAll(async () => {
  for (const g of [full, compat]) {
    await g?.device.queue.onSubmittedWorkDone()
    g?.destroy()
  }
}, timeout(120_000))

/** A texture array of 4 × 4 layers, each one color (RGBA8). */
function array(layers: number[][], usage: 'color' | 'normal') {
  const data = new Uint8Array(4 * 4 * 4 * layers.length)
  layers.forEach((c, l) => {
    for (let i = 0; i < 16; i++) data.set(c, (l * 16 + i) * 4)
  })
  return Texture.create({ width: 4, height: 4, layers: layers.length, usage, mips: [data] })
}

/** Normal map layers: flat, leaning +X (red high), leaning +Y (green high, OpenGL: up the image). */
const FLAT = 0
const LEAN_X = 1
const LEAN_Y = 2

/** 256 m of ground at 0 m, or with a cliff facing +X: 30 m over 10 m at x 120–130. */
async function scene(gpu: GpuContext, normal: number, cliff: boolean): Promise<HeightfieldApp> {
  const ramp = new Float32Array(16 * 16)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) ramp[y * 16 + x] = 1 - x / 15
  const p = await heightfieldApp(gpu, {
    source: {
      size: [256, 256],
      spacing: 0.5,
      heightRange: [-20, 60],
      height: [
        { noise: { path: 'hills' }, scale: 0 },
        ...(cliff
          ? [
              { image: { path: 'ramp' }, at: [125, 128], size: [10.7, 400], range: [0, 30] },
              { image: { path: 'ramp' }, at: [60, 128], size: [120, 400], range: [30, 30] },
            ]
          : []),
      ],
      layers: [{ name: 'a', albedo: 0, normal, scale: 4, triplanar: cliff, tint: [1, 1, 1] }],
      textures: { albedo: { path: 'albedo' }, normal: { path: 'normal' } },
    },
    noise: { hills },
    heightmaps: { ramp: { width: 16, height: 16, data: ramp } },
    textures: {
      albedo: array([[150, 150, 150, 255]], 'color'),
      normal: array(
        [
          [128, 128, 255, 255],
          [180, 128, 226, 255],
          [128, 180, 226, 255],
        ],
        'normal',
      ),
    },
    width: 64,
    heightPx: 48,
    clearColor: [0, 0, 0, 1],
  })
  await untilStreaming(p)
  return p
}

/** Mean brightness of the middle of the view, with the sun travelling along `toward`. */
async function lit(p: HeightfieldApp, toward: [number, number, number]): Promise<number> {
  const rotation = quat.lookRotation([0, 0, 0, 1], toward, [0, 1, 0]) as [
    number,
    number,
    number,
    number,
  ]
  p.world.set(p.sun, Transform, { ...p.world.get(p.sun, Transform), rotation })
  await settleHeightfield(p)
  const shot = await capture(p)
  let sum = 0
  let n = 0
  for (let y = 12; y < 36; y++) {
    for (let x = 16; x < 48; x++) {
      const o = (y * shot.width + x) * 4
      sum += shot.data[o]! + shot.data[o + 1]! + shot.data[o + 2]!
      n += 3
    }
  }
  return sum / n
}

const fromAbove = (p: HeightfieldApp) => lookAt(p, [128, 40, 118], [128, 0, 128])

describe('terrain layer normal maps (0105)', () => {
  it(
    'leaves flat ground as it was under a flat map',
    async () => {
      const p = await scene(full, FLAT, false)
      fromAbove(p)
      const sun: [number, number, number] = [-1, -1, 0.3]
      const on = await lit(p, sun)
      HeightfieldDebug.normalMaps = false
      const off = await lit(p, sun)
      HeightfieldDebug.normalMaps = true
      expect(Math.abs(on - off)).toBeLessThan(1)
      await p.app.dispose()
    },
    timeout(120_000),
  )

  it(
    'leans +X (red) toward +X and +Y (green, OpenGL) toward −Z, on both tiers',
    async () => {
      for (const gpu of [full, compat]) {
        const errors = gpu.errors.length
        const x = await scene(gpu, LEAN_X, false)
        fromAbove(x)
        // Sun from +X travels toward −X.
        const fromPlusX = await lit(x, [-1, -1, 0])
        const fromMinusX = await lit(x, [1, -1, 0])
        expect(fromPlusX, `${gpu.tier}`).toBeGreaterThan(fromMinusX + 5)
        await x.app.dispose()
        const y = await scene(gpu, LEAN_Y, false)
        fromAbove(y)
        const fromMinusZ = await lit(y, [0, -1, 1])
        const fromPlusZ = await lit(y, [0, -1, -1])
        expect(fromMinusZ, `${gpu.tier}`).toBeGreaterThan(fromPlusZ + 5)
        expect(y.world.resource(Gpu).tier).toBe(gpu === compat ? 'baseline' : 'full')
        await y.app.dispose()
        expect(gpu.errors.slice(errors)).toEqual([])
      }
    },
    timeout(300_000),
  )

  it(
    'leans a triplanar cliff facing +X along its own face (+X red is world +Z there)',
    async () => {
      const p = await scene(full, LEAN_X, true)
      // Looking at the cliff (x 120–130, facing +X) from the east.
      lookAt(p, [175, 15, 128], [125, 15, 128])
      const fromPlusZ = await lit(p, [-0.6, -0.5, -1])
      const fromMinusZ = await lit(p, [-0.6, -0.5, 1])
      expect(fromPlusZ).toBeGreaterThan(fromMinusZ + 5)
      await p.app.dispose()
    },
    timeout(120_000),
  )
})
