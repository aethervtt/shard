import { defineSystem, quat, Update } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import { cube, plane } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  captureBuffer,
  DirectionalLight,
  defineMaterial,
  Exposure,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  ShaderData,
  ShaderGlobals,
  Shaders,
  Ssao,
  Tonemapping,
} from '@aethervtt/shard-render'
import { pixel, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { windPlugin } from './plugin'
import { WIND_SLOTS } from './shaders'
import { Wind } from './wind'
import { WindField } from './zones'

// shard::shader_data (0127) with the wind plugin on: wind fills most of shard::globals, and a
// material still reads 256 vec4s a system rewrites each frame, in the forward pass, the prepass
// and the shadow pass. It lives here because render can't depend on wind.

let full: GpuContext
let compat: GpuContext
beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  full?.destroy()
  compat?.destroy()
})

/** Slots reserved before the readout's, so its block sits near the top of the 1024. */
const PADDING = 700
/** vec4s the readout averages. */
const READ = 256

/** One frame's data: the readout's offset (every pass) and the color its 256 slots average to. */
interface Frame {
  offset: [number, number, number]
  color: [number, number, number]
}

const Readout = defineMaterial('test/Readout', {
  extends: 'none',
  shader: 'project::readout',
  animatesVertices: true,
})

const readoutWesl = (block: number) => `
import shard::pbr::types::VertexOutput;
import shard::shader_data::shader_data;
import shard::wind::{ wind_at, wind_time };

const BLOCK: u32 = ${block}u;

override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  return position + shader_data[BLOCK].xyz;
}

override fn shade(in: VertexOutput) -> vec4f {
  var sum = vec4f(0.0);
  for (var i = 1u; i <= ${READ}u; i++) {
    sum += shader_data[BLOCK + i];
  }
  let wind = wind_at(vec3f(0.0), wind_time()).x;
  return vec4f(sum.rgb / ${READ}.0 * 1000.0 + vec3f(wind * 10.0, 0.0, 0.0), 1.0);
}`

/** Slot i's weight: they average to 1, and a slot that reads zero shows in the mean. */
const weight = (i: number) => (2 * (i + 1)) / (READ + 1)

async function scene(gpu: GpuContext) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin(),
    windPlugin,
  )
  await app.init()
  const world = app.world
  Object.assign(world.resource(Wind), { direction: [1, 0, 0], speed: 3, gustiness: 0 })
  const data = world.resource(ShaderData)
  data.reserve('test/padding', PADDING)
  const block = data.reserve('test/readout', 1 + READ)
  world.resource(Shaders).register('project::readout', readoutWesl(block), 'shaders/readout.wesl')

  const state: { next: Frame } = { next: { offset: [0, 0, 0], color: [0, 0, 0] } }
  const write = defineSystem({
    name: 'test/write-readout',
    run(_, w) {
      const values = w.resource(ShaderData).values
      const { offset, color } = state.next
      values.set(offset, block * 4)
      for (let i = 0; i < READ; i++) {
        const o = (block + 1 + i) * 4
        for (let c = 0; c < 3; c++) values[o + c] = color[c]! * weight(i)
      }
    },
  })
  app.addSystems(Update, write)

  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 20 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.5, 0.5, 0.5, 1] })) },
    ],
    Transform,
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(cube({ size: 1 })) }],
    [MeshMaterial, { material: materials.add(new MaterialAsset({}, Readout)) }],
    [Transform, { translation: [0, 2, 0] }],
  )
  // Shines along (1, -1, 0): the cube's shadow falls 2 m to its +x.
  world.spawn(
    [DirectionalLight, { illuminance: 10_000, shadows: true }],
    [Transform, { rotation: lookAt([-3, 3, 0], [0, 0, 0]) }],
  )
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { label: 'shader-data', width: 96, height: 64 }), 'shader-data')
  // Straight down, orthographic: 18 × 12 m, screen x along world x, the cube's center at (48, 32).
  const cam = world.spawn(
    [Camera3d, { target, projection: 'orthographic', orthoHeight: 12 }],
    [Exposure, { ev100: 10 }],
    [Tonemapping, { dither: false }],
    // SSAO runs the prepass (depth, normals, velocity), which draws the cube too.
    [Ssao, { intensity: 0 }],
    [Transform, { translation: [0, 10, 0], rotation: DOWN }],
  )
  return { app, world, state, block, view: `camera:${cam}` }
}

/** Looking along -y, screen up along -z. */
const DOWN = quat.fromEuler([0, 0, 0, 1], -Math.PI / 2, 0, 0) as [number, number, number, number]

/** Screen x of world x on the 96-wide, 18 m view. */
const px = (x: number) => Math.round(((x + 9) / 18) * 96)
const luminance = (p: number[]) => p[0]! + p[1]! + p[2]!

const A: Frame = { offset: [0, 0, 0], color: [0.2, 0.5, 0.8] }
const B: Frame = { offset: [-4, 0, 0], color: [0.7, 0.4, 0.1] }

describe('shard::shader_data with the wind plugin on (0127)', () => {
  for (const tier of ['full', 'baseline'] as const) {
    it(`reads 256 vec4s a system rewrites each frame, in every pass (${tier} tier)`, {
      timeout: timeout(60_000),
    }, async () => {
      const gpu = tier === 'full' ? full : compat
      const s = await scene(gpu)
      // Wind holds most of shard::globals; the readout's slots are elsewhere.
      expect(s.world.resource(WindField).slot).toBeGreaterThanOrEqual(0)
      expect(s.world.resource(ShaderGlobals).length).toBeGreaterThanOrEqual(4 + WIND_SLOTS * 4)
      expect(s.block).toBe(PADDING)
      s.state.next = A
      await settle(s.app)

      const shotA = captureBuffer(s.world, s.view, 'hdr')
      const depthA = captureBuffer(s.world, s.view, 'prepass-depth')
      s.app.update(1 / 60)
      const a = await shotA
      const da = await depthA
      s.state.next = B
      const shotB = captureBuffer(s.world, s.view, 'hdr')
      const depthB = captureBuffer(s.world, s.view, 'prepass-depth')
      s.app.update(1 / 60)
      const b = await shotB
      const db = await depthB

      // The forward pass: the mean of the 256 slots this frame, plus wind_at's 3 m/s × 10.
      const seen = (image: typeof a, frame: Frame, x: number) => {
        const p = pixel(image, px(x), 32)
        for (let c = 0; c < 3; c++)
          expect(p[c], `${tier} ${c}`).toBeCloseTo(frame.color[c]! * 1000 + (c === 0 ? 30 : 0), -1)
      }
      seen(a, A, 0)
      seen(b, B, -4)
      // The shadow pass: the cube's shadow at x = 2 in frame A, gone with the cube in frame B.
      const shade = luminance(pixel(a, px(2), 32))
      const lit = luminance(pixel(b, px(2), 32))
      expect(shade, tier).toBeLessThan(lit * 0.5)
      // Where the cube was is ground now, lit like the rest.
      expect(luminance(pixel(b, px(0), 32)) / lit).toBeCloseTo(1, 1)
      // The prepass: the cube's top (reverse Z, nearer is larger) where the block put it.
      const depth = (image: typeof da, x: number) => pixel(image, px(x), 32)[0]!
      expect(depth(da, 0), tier).toBeGreaterThan(depth(da, -4))
      expect(depth(db, -4), tier).toBeGreaterThan(depth(db, 0))
      expect(gpu.errors.map((e) => e.message)).toEqual([])
      await s.app.dispose()
    })
  }

  it("translates for WebGL2 at its floor, and binds this frame's slots to every pass", {
    timeout: timeout(60_000),
  }, async () => {
    const fake = new FakeGl()
    const gpu = await createGpuContext({
      backend: 'webgl2',
      webgl2: { context: fake.context, persist: false, profile: 'minimum' },
    })
    try {
      const s = await scene(gpu)
      s.state.next = A
      await settle(s.app)
      // Every program that reads the block declares it as a plain 1024-vec4 array: 16 KiB.
      const readers = (from: number) =>
        fake.draws.slice(from).filter((d) => d.program.sources.some((g) => /_binding_18_/.test(g)))
      const holds = (draw: ReturnType<typeof readers>[number], frame: Frame) =>
        [...draw.blocks.values()].some((r) => {
          if (!r.buffer || r.buffer.data.byteLength < (s.block + 1 + READ) * 16) return false
          const f = new Float32Array(r.buffer.data.buffer, r.buffer.data.byteOffset)
          if (f[s.block * 4] !== frame.offset[0]) return false
          for (let i = 0; i < READ; i++) {
            const o = (s.block + 1 + i) * 4
            if (Math.abs(f[o]! - frame.color[0] * weight(i)) > 1e-6) return false
          }
          return true
        })
      for (const frame of [A, B]) {
        s.state.next = frame
        const mark = fake.draws.length
        s.app.update(1 / 60)
        const draws = readers(mark)
        // The forward pass, the prepass and the four shadow cascades: three programs.
        expect(new Set(draws.map((d) => d.program)).size).toBe(3)
        expect(draws.length).toBe(6)
        for (const d of draws) expect(holds(d, frame)).toBe(true)
        for (const d of draws) {
          for (const g of d.program.sources) {
            if (/_binding_18_/.test(g)) expect(g).toMatch(/vec4 _group_0_binding_18_\w+\[1024\]/)
          }
        }
      }
      expect(gpu.errors.map((e) => e.message)).toEqual([])
      await s.app.dispose()
    } finally {
      gpu.destroy()
    }
  })
})
