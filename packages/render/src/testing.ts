/**
 * Test helpers for GPU tests (Node only; exported as `@aethervtt/shard-render/testing`): render until
 * shaders and pipelines are ready, and compare against golden images.
 *
 * Goldens are raw RGBA8 files in `__golden__/`. `SHARD_UPDATE_GOLDEN=1` rewrites them;
 * `SHARD_GOLDEN_OUT=<dir>` writes PNGs of the actual and expected images for inspection.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import { Mesh, type MeshData, simplifyMesh } from '@aethervtt/shard-mesh'
import type { App } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { Meshes } from './assets'
import { Culler } from './culling'
import type { CapturedImage } from './graph'
import { Lod, Mesh3d, MeshMaterial, SkinnedMesh } from './instances'
import { captureView, Gpu, Shaders } from './plugin'
import { Skins } from './skin-asset'

export {
  type BakedFramesMirror,
  bakedFrames,
  bakedRow,
  deformedPositions,
} from './deform-mirror'
export {
  expectScenario,
  measureScenario,
  type ScenarioOptions,
  type ScenarioRun,
  type ScenarioSlice,
} from './scenario'

/** Renders frames until shaders and pipelines are compiled and nothing is skipped. */
export async function settle(app: App, frames = 40): Promise<void> {
  const gpu = app.world.resource(Gpu)
  for (let i = 0; i < frames; i++) {
    app.update(1 / 60)
    await app.world.resource(Shaders).whenIdle()
    await gpu.pipelines.whenIdle()
    // Let async readbacks (GPU culling counts, cluster stats) resolve: Dawn maps between tasks.
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (i >= 3 && gpu.pipelines.skipped === 0 && gpu.pipelines.pending === 0) {
      // One more frame so everything compiled last frame draws, with stats from the GPU cull of
      // this complete frame.
      await app.world.tryResource(Culler)?.whenIdle()
      app.update(1 / 60)
      await gpu.pipelines.whenIdle()
      if (gpu.pipelines.skipped === 0) return
    }
  }
}

/** Settles, then captures a view. */
export async function renderView(app: App, view: string): Promise<CapturedImage> {
  await settle(app)
  const shot = captureView(app.world, view)
  app.update(1 / 60)
  return shot
}

export function pixel(image: { width: number; data: ArrayLike<number> }, x: number, y: number) {
  const o = (y * image.width + x) * 4
  return [image.data[o]!, image.data[o + 1]!, image.data[o + 2]!, image.data[o + 3]!]
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/** RGBA8 → PNG bytes (sync, zlib), for debugging output. */
export function pngBytes(data: Uint8Array, width: number, height: number): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    )
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const td = Buffer.concat([Buffer.from(type), body])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Expected | actual | difference × 4, scaled up by `scale` (nearest). */
export function comparePng(
  expected: Uint8Array,
  image: { width: number; height: number; data: Uint8Array },
  scale: number,
): Uint8Array {
  const { width, height } = image
  const gap = 2
  const W = (width * 3 + gap * 2) * scale
  const H = height * scale
  const out = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const panel = Math.floor(x / scale / (width + gap))
      const px = Math.floor(x / scale) - panel * (width + gap)
      const o = (y * W + x) * 4
      out[o + 3] = 255
      if (px >= width) continue
      const s = (Math.floor(y / scale) * width + px) * 4
      for (let c = 0; c < 3; c++) {
        const e = expected[s + c]!
        const a = image.data[s + c]!
        out[o + c] = panel === 0 ? e : panel === 1 ? a : Math.min(255, Math.abs(e - a) * 4)
      }
    }
  }
  return pngBytes(out, W, H)
}

export interface GoldenResult {
  /** Mean absolute difference per channel, in 8-bit levels. */
  mean: number
  max: number
  /** Whether the golden was just written (first run or SHARD_UPDATE_GOLDEN). */
  written: boolean
}

/**
 * Compares an image with `<dir>/__golden__/<name>.rgba`. Writes it when missing (or when
 * SHARD_UPDATE_GOLDEN is set), so a new golden appears on the first run.
 */
export function compareGolden(
  dir: string,
  name: string,
  image: { width: number; height: number; data: Uint8Array },
): GoldenResult {
  const file = join(dir, '__golden__', `${name}.rgba`)
  const out = process.env.SHARD_GOLDEN_OUT
  if (out) {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, `${name}.png`), pngBytes(image.data, image.width, image.height))
  }
  if (!existsSync(file) || process.env.SHARD_UPDATE_GOLDEN) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, image.data)
    return { mean: 0, max: 0, written: true }
  }
  const expected = new Uint8Array(readFileSync(file))
  if (out && expected.length === image.data.length) {
    writeFileSync(join(out, `${name}.compare.png`), comparePng(expected, image, 4))
  }
  if (expected.length !== image.data.length) return { mean: 255, max: 255, written: false }
  let sum = 0
  let max = 0
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(expected[i]! - image.data[i]!)
    sum += d
    if (d > max) max = d
  }
  return { mean: sum / expected.length, max, written: false }
}

/**
 * Watches a device for what the baseline tier (0064) must never ask for: compute passes, and
 * storage buffers visible to the vertex or fragment stage. Counts from now on.
 */
export function watchBaseline(gpu: import('@aethervtt/shard-gpu').GpuContext): {
  computePasses: number
  renderStorage: string[]
} {
  const found = { computePasses: 0, renderStorage: [] as string[] }
  const device = gpu.device
  const createEncoder = device.createCommandEncoder.bind(device)
  device.createCommandEncoder = (descriptor) => {
    const encoder = createEncoder(descriptor)
    const begin = encoder.beginComputePass.bind(encoder)
    encoder.beginComputePass = (d) => {
      found.computePasses++
      return begin(d)
    }
    return encoder
  }
  const createLayout = device.createBindGroupLayout.bind(device)
  device.createBindGroupLayout = (descriptor) => {
    for (const e of descriptor.entries) {
      const render = e.visibility & (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT)
      const t = e.buffer?.type
      if (render && (t === 'storage' || t === 'read-only-storage'))
        found.renderStorage.push(`${descriptor.label ?? '?'}#${e.binding}`)
    }
    return createLayout(descriptor)
  }
  return found
}

/** Mean absolute difference of two images' bytes. */
export function meanDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

/** A 2 m tube on two joints (the upper one at 1 m), as the skinning tests build it. */
function tube(): MeshData {
  const rings = 41
  const sides = 24
  const n = rings * (sides + 1)
  const positions = new Float32Array(n * 3)
  const normals = new Float32Array(n * 3)
  const uvs = new Float32Array(n * 2)
  const joints = new Uint16Array(n * 4)
  const weights = new Float32Array(n * 4)
  for (let r = 0; r < rings; r++) {
    const y = (r / (rings - 1)) * 2
    const upper = Math.min(1, Math.max(0, (y - 0.8) / 0.4))
    for (let s = 0; s <= sides; s++) {
      const v = r * (sides + 1) + s
      const a = (s / sides) * Math.PI * 2
      positions.set([Math.cos(a) * 0.15, y, Math.sin(a) * 0.15], v * 3)
      normals.set([Math.cos(a), 0, Math.sin(a)], v * 3)
      uvs.set([s / sides, y / 2], v * 2)
      joints.set([0, 1, 0, 0], v * 4)
      weights.set([1 - upper, upper, 0, 0], v * 4)
    }
  }
  const indices: number[] = []
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * (sides + 1) + s
      const b = a + sides + 1
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { positions, normals, uvs, joints, weights, indices: Uint32Array.from(indices) }
}

/**
 * A skinned 2 m tube standing at the origin, bent 45° toward -x at its upper joint (1 m up); with
 * `lod`, drawn through a Lod whose second level is simplified (for pose-following checks).
 */
export function bentTube(world: World, material: AssetRef<'Material'>, lod: boolean): Entity {
  const meshes = world.resource(Meshes)
  const source = tube()
  const l0 = meshes.add(Mesh.create(source))
  const l1 = meshes.add(Mesh.create(simplifyMesh(source, 0.3, { keepSeams: true }).mesh))
  const skin = world.resource(Skins).add({
    name: 'tube',
    joints: ['j0', 'j1'],
    restPose: [
      { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ],
    inverseBindMatrices: Float32Array.from([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0,
      1,
    ]),
  })
  const j0 = world.spawn([Transform, {}])
  const half = Math.PI / 8
  const j1 = world.spawn([
    Transform,
    { translation: [0, 1, 0], rotation: [0, 0, Math.sin(half), Math.cos(half)] },
  ])
  return world.spawn(
    [Mesh3d, { mesh: l0 }],
    [MeshMaterial, { material }],
    [Transform, {}],
    [SkinnedMesh, { skin, joints: [j0, j1] }],
    ...(lod
      ? [
          [
            Lod,
            {
              levels: [
                { mesh: l0, screenSize: 1000 },
                { mesh: l1, screenSize: 0 },
              ],
            },
          ] as const,
        ]
      : []),
  )
}
