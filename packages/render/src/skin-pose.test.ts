import { ChildOf } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import { Mesh, type MeshData, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { Culler } from './culling'
import { DataStore } from './data-store'
import { BAKED_BIT, DEFORM_WORDS, type DeformStore } from './deform'
import {
  INSTANCE_FLOATS,
  InstanceSlot,
  Instances,
  Mesh3d,
  MeshMaterial,
  MorphWeights,
  SkinnedMesh,
  SkinPose,
} from './instances'
import { DirectionalLight } from './lights'
import { renderPlugin, Shaders } from './plugin'
import { Skins } from './skin-asset'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { deformedPositions, meanDifference, renderView, settle } from './testing'
import { Visibility } from './visibility'

// Pose sources (spec 0115): persistent poses and baked playback draw what the joint path draws,
// and `deformedPositions` (the CPU mirror) matches `deform_vertex` itself, run in a compute probe
// that links the real WGSL against the store's buffers.

let full: GpuContext
let compat: GpuContext
beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  full.destroy()
  compat.destroy()
})

const BEND = Math.PI / 3

/** A 2 m tube on two joints (the upper at 1 m), with a bulge target and a 0.3 m +x shift target. */
function tube(): MeshData {
  const rings = 21
  const sides = 12
  const n = rings * (sides + 1)
  const positions = new Float32Array(n * 3)
  const normals = new Float32Array(n * 3)
  const uvs = new Float32Array(n * 2)
  const joints = new Uint16Array(n * 4)
  const weights = new Float32Array(n * 4)
  const bulge = new Float32Array(n * 3)
  const shift = new Float32Array(n * 3)
  for (let r = 0; r < rings; r++) {
    const y = (r / (rings - 1)) * 2
    const upper = Math.min(1, Math.max(0, (y - 0.8) / 0.4))
    for (let s = 0; s <= sides; s++) {
      const v = r * (sides + 1) + s
      const a = (s / sides) * Math.PI * 2
      const x = Math.cos(a)
      const z = Math.sin(a)
      positions.set([x * 0.15, y, z * 0.15], v * 3)
      normals.set([x, 0, z], v * 3)
      uvs.set([s / sides, y / 2], v * 2)
      joints.set([0, 1, 0, 0], v * 4)
      weights.set([1 - upper, upper, 0, 0], v * 4)
      const b = 0.08 * Math.exp(-(((y - 0.5) / 0.2) ** 2))
      bulge.set([x * b, 0, z * b], v * 3)
      shift[v * 3] = 0.3
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
  return {
    positions,
    normals,
    uvs,
    joints,
    weights,
    indices: Uint32Array.from(indices),
    targets: [{ positions: bulge }, { positions: shift }],
  }
}

/**
 * Two joints' rows (`jointModel × inverseBind`, 3x4 row-major): joint 0 moved by `t0`, joint 1
 * bent by `angle` about z around (0, 1, 0) and moved by `t1`.
 */
function rows(angle: number, t0: number[] = [0, 0, 0], t1: number[] = t0): number[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  // T(0,1,0) R T(0,-1,0): translation (0,1,0) - R(0,1,0) = (s, 1 - c, 0).
  return [
    1,
    0,
    0,
    t0[0]!,
    0,
    1,
    0,
    t0[1]!,
    0,
    0,
    1,
    t0[2]!,
    c,
    -s,
    0,
    s + t1[0]!,
    s,
    c,
    0,
    1 - c + t1[1]!,
    0,
    0,
    1,
    t1[2]!,
  ]
}

async function scene(gpu: GpuContext) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'pose', width: 96, height: 96 })
  const ref = world.resource(RenderTargets).add(target, 'pose')
  const eye: [number, number, number] = [0.5, 1.6, 5]
  const camera = world.spawn(
    [Camera3d, { target: ref as never, fovY: 40 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [-0.6, 0.8, 0]) }],
  )
  const materials = world.resource(Materials)
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 10 })) }],
    [MeshMaterial, { material: materials.add(new MaterialAsset({ roughness: 0.9 })) }],
    [Transform, {}],
  )
  world.spawn(
    [DirectionalLight, { illuminance: 20000, shadows: true }],
    [Transform, { rotation: lookAt([5, 3.5, 0], [0, 0, 0]) }],
  )
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
  const mesh = world.resource(Meshes).add(Mesh.create(tube()))
  const material = materials.add(new MaterialAsset({ roughness: 0.5 }))
  const entity = world.spawn([Mesh3d, { mesh }], [MeshMaterial, { material }], [Transform, {}])
  // The joints are the mesh's children, so its pose follows it as a model's does.
  const j0 = world.spawn([Transform, {}], [ChildOf, { parent: entity }])
  const half = BEND / 2
  const j1 = world.spawn(
    [Transform, { translation: [0, 1, 0], rotation: [0, 0, Math.sin(half), Math.cos(half)] }],
    [ChildOf, { parent: j0 }],
  )
  world.add(entity, SkinnedMesh, { skin, joints: [j0, j1] })
  const store = (): DeformStore => world.resource(Instances).deform
  return { app, world, entity, view: `camera:${camera}`, store }
}

type Scene = Awaited<ReturnType<typeof scene>>

/** Writes floats into the store's persistent region at vec4 `base` and marks them. */
function put(store: DeformStore, base: number, values: readonly number[]): void {
  store.poses.set(values, base * 4)
  store.markPersistent(base, Math.ceil(values.length / 4))
}

/** A persistent block holding `values` (vec4-padded); returns its first vec4. */
function block(store: DeformStore, values: readonly number[]): number {
  const base = store.allocPersistent(Math.ceil(values.length / 4))
  put(store, base, values)
  return base
}

const SPHERE: [number, number, number, number] = [0, 1, 0, 1.3]

/**
 * Baked clips for the probe: every frame translates both joints (bent like the scene's pose), A
 * along x by `A_X[f]`, B along z by `B_Z[f]`, so a vertex's offset from the bent pose is
 * ((1 - wB) × A's x, 0, wB × B's z) and the header math can be checked in closed form.
 */
const A_X = [0, 0.2, 0.5, 0.1, 0]
const B_Z = [0, 0.3, 0.6]
const FPS = 10

function bake(store: DeformStore): { a: number; b: number } {
  const clip = (offsets: number[], axis: 0 | 2) =>
    block(
      store,
      offsets.flatMap((o) => {
        const t = [0, 0, 0]
        t[axis] = o
        return rows(BEND, t)
      }),
    )
  return { a: clip(A_X, 0), b: clip(B_Z, 2) }
}

interface Header {
  startA: number
  speedA: number
  startB?: number
  speedB?: number
  framesB?: number
  fadeStart?: number
  fadeDuration?: number
  flags?: number
}

function header(clips: { a: number; b: number }, h: Header): number[] {
  return [
    clips.a,
    A_X.length,
    h.startA,
    h.speedA,
    clips.b,
    h.framesB ?? 0,
    h.startB ?? 0,
    h.speedB ?? 1,
    FPS,
    h.fadeStart ?? 0,
    h.fadeDuration ?? 0,
    h.flags ?? 0,
  ]
}

/** A clip's offset at the clock, from the header's definition (not the mirror's code). */
function clipOffset(table: number[], start: number, speed: number, once: boolean, clock: number) {
  const x = (start + clock * speed) * FPS
  const last = table.length - 1
  const p = once ? Math.min(Math.max(x, 0), last) : ((x % last) + last) % last
  const f = Math.min(Math.floor(p), last)
  const k = p - f
  return table[f]! * (1 - k) + table[Math.min(f + 1, last)]! * k
}

function expectedOffset(h: Header, clock: number): [number, number, number] {
  const flags = h.flags ?? 0
  const ax = clipOffset(A_X, h.startA, h.speedA, (flags & 1) !== 0, clock)
  if (!h.framesB) return [ax, 0, 0]
  const bz = clipOffset(B_Z, h.startB ?? 0, h.speedB ?? 1, (flags & 2) !== 0, clock)
  const d = h.fadeDuration ?? 0
  const w = d <= 0 ? 1 : Math.min(Math.max((clock - (h.fadeStart ?? 0)) / d, 0), 1)
  return [(1 - w) * ax, 0, w * bz]
}

const PROBE = `
import shard::mesh::{ deform_vertex, instance_at, instance_world };

struct Probe { count: u32, _a: u32, _b: u32, _c: u32 }
@group(3) @binding(0) var<storage, read> source: array<f32>;
@group(3) @binding(1) var<storage, read_write> result: array<f32>;
@group(3) @binding(2) var<uniform> probe: Probe;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let v = id.x;
  if (v >= probe.count) { return; }
  let p = vec3f(source[v * 3u], source[v * 3u + 1u], source[v * 3u + 2u]);
  let d = deform_vertex(0u, v, p, vec3f(0.0, 1.0, 0.0), vec4f(1.0, 0.0, 0.0, 1.0));
  let w = instance_world(instance_at(0u), d.position);
  result[v * 3u] = w.x;
  result[v * 3u + 1u] = w.y;
  result[v * 3u + 2u] = w.z;
}`

/**
 * Runs `deform_vertex` (and the instance transform) on the GPU for the entity's slot, over the
 * buffers the frame uploaded: world positions of its level-0 vertices.
 */
async function gpuPositions(s: Scene, gpu: GpuContext): Promise<Float32Array> {
  const world = s.world
  const shaders = world.resource(Shaders)
  shaders.register('test::deform_probe', PROBE)
  const request = { root: 'test::deform_probe' }
  let module = shaders.module(gpu, request)
  while (!module) {
    await shaders.whenIdle()
    const failure = shaders.failure(request, gpu)
    if (failure) throw failure
    module = shaders.module(gpu, request)
  }
  const store = world.resource(Instances)
  const slot = world.get(s.entity, InstanceSlot).slot - 1
  const mesh = world.resource(Meshes).get(world.get(s.entity, Mesh3d).mesh)!
  const n = mesh.vertexCount
  gpu.device.pushErrorScope('validation')
  const pipeline = gpu.device.createComputePipeline({
    label: 'deform-probe',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  // The slot's instance record and a one-entry visible list, as the draw would see them.
  const instances = new DataStore(gpu, { label: 'probe/instances' })
  instances.write(store.u32, 0, 0, (slot + 1) * INSTANCE_FLOATS)
  const visible = new DataStore(gpu, { label: 'probe/visible' })
  visible.write(Uint32Array.of(slot, 0, 0, 0))
  instances.flush()
  visible.flush()
  const buffer = (data: ArrayBufferView & ArrayLike<number>, usage: number, size: number) => {
    const b = gpu.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST })
    gpu.device.queue.writeBuffer(b, 0, data)
    return b
  }
  const source = buffer(mesh.positions, GPUBufferUsage.STORAGE, n * 12)
  const result = gpu.device.createBuffer({
    size: n * 12,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const params = buffer(Uint32Array.of(n, 0, 0, 0), GPUBufferUsage.UNIFORM, 16)
  const d = store.deform
  const group = (index: number, entries: GPUBindGroupEntry[]) =>
    gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries })
  const encoder = gpu.device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, group(0, []))
  pass.setBindGroup(1, group(1, []))
  pass.setBindGroup(
    2,
    group(2, [
      { binding: 0, resource: instances.resource() },
      { binding: 1, resource: visible.resource() },
      { binding: 3, resource: d.recordBuffer.resource() },
      { binding: 4, resource: d.poseBuffer.resource() },
      { binding: 5, resource: d.vertexBuffer.resource() },
    ]),
  )
  pass.setBindGroup(
    3,
    group(3, [
      { binding: 0, resource: { buffer: source } },
      { binding: 1, resource: { buffer: result } },
      { binding: 2, resource: { buffer: params } },
    ]),
  )
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  const read = gpu.device.createBuffer({
    size: n * 12,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  encoder.copyBufferToBuffer(result, 0, read, 0, n * 12)
  gpu.device.queue.submit([encoder.finish()])
  const error = await gpu.device.popErrorScope()
  if (error) throw new Error(error.message)
  await read.mapAsync(GPUMapMode.READ)
  const out = new Float32Array(read.getMappedRange().slice(0))
  read.unmap()
  for (const b of [source, result, params, read]) b.destroy()
  instances.destroy()
  visible.destroy()
  return out
}

/** The mirror's positions this frame. */
function cpuPositions(s: Scene): Float32Array {
  const out = new Float32Array(4096 * 3)
  const n = deformedPositions(s.world, s.entity, out)
  return out.subarray(0, n * 3)
}

function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length)
  let max = 0
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!))
  return max
}

/** One frame (no render needed: the store uploads in finishFrame of a drawn view). */
async function frame(s: Scene): Promise<void> {
  await settle(s.app, 6)
}

const TIERS = [
  ['full', () => full],
  ['baseline', () => compat],
] as const

for (const [tier, gpuOf] of TIERS) {
  describe(`pose sources (${tier} tier)`, () => {
    it('pose and baked draw what the joint path draws, in view and in shadow', {
      timeout: timeout(60_000),
    }, async () => {
      const s = await scene(gpuOf())
      const joints = (await renderView(s.app, s.view)).data
      const store = s.store()
      const pose = block(store, rows(BEND))
      s.world.add(s.entity, SkinPose, { source: 'pose', base: pose, joints: 2, sphere: SPHERE })
      const posed = (await renderView(s.app, s.view)).data
      expect(meanDifference(posed, joints)).toBeLessThan(0.05)
      // Baked: two identical frames, looping, at any clock.
      const clip = block(store, [...rows(BEND), ...rows(BEND)])
      const h = block(store, [clip, 2, 0, 1, 0, 0, 0, 1, 30, 0, 0, 0])
      store.setClock(12.34)
      s.world.set(s.entity, SkinPose, { source: 'baked', base: h, joints: 2, sphere: SPHERE })
      const baked = (await renderView(s.app, s.view)).data
      expect(meanDifference(baked, joints)).toBeLessThan(0.05)
      // And the pose shows: straight, the tube and its shadow move.
      put(store, pose, rows(0))
      s.world.set(s.entity, SkinPose, { source: 'pose', base: pose, joints: 2, sphere: SPHERE })
      const straight = (await renderView(s.app, s.view)).data
      expect(meanDifference(straight, joints)).toBeGreaterThan(1)
      await s.app.dispose()
    })

    it('the mirror matches deform_vertex for joints, pose, baked, and morphs', {
      timeout: timeout(60_000),
    }, async () => {
      const gpu = gpuOf()
      const s = await scene(gpu)
      const { world, entity } = s
      // Off the origin and scaled, so the instance transform and sphere scale show.
      world.set(entity, Transform, { translation: [0.4, 0, -0.3], scale: [1.5, 1.5, 1.5] })
      const check = async (label: string) => {
        await frame(s)
        const cpu = cpuPositions(s)
        const gpuOut = await gpuPositions(s, gpu)
        expect(maxDifference(cpu, gpuOut), label).toBeLessThan(1e-4)
        return cpu
      }
      const jointsOut = Float32Array.from(await check('joints'))
      const store = s.store()
      const pose = block(store, rows(BEND))
      world.add(entity, SkinPose, { source: 'pose', base: pose, joints: 2, sphere: SPHERE })
      const poseOut = await check('pose')
      expect(maxDifference(poseOut, jointsOut)).toBeLessThan(1e-4)
      // Morphs: per frame from MorphWeights, then a persistent block.
      world.add(entity, MorphWeights, { weights: [1, 0.5] })
      const weighted = Float32Array.from(await check('pose + MorphWeights'))
      // The shift target moved every vertex 0.15 m along +x before skinning; the bottom ring
      // (joint 0 only, the bulge a hair) shows it scaled by 1.5.
      expect(weighted[0]! - poseOut[0]!).toBeCloseTo(0.15 * 1.5, 3)
      world.remove(entity, MorphWeights)
      const morphs = block(store, [1, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
      world.set(entity, SkinPose, {
        source: 'pose',
        base: pose,
        joints: 2,
        morphBase: morphs,
        morphCount: 2,
        sphere: SPHERE,
      })
      const blockOut = await check('pose + morph block')
      expect(maxDifference(blockOut, weighted)).toBeLessThan(1e-4)
      // Baked, against the header's definition in closed form.
      const clips = bake(store)
      const h = store.allocPersistent(3)
      const cases: [string, Header, number][] = [
        ['A looping', { startA: 0, speedA: 1 }, 0.13],
        ['A wrapped twice', { startA: 0, speedA: 1 }, 0.937],
        ['A before its start (negative time)', { startA: -0.5, speedA: 1 }, 0.27],
        ['A at speed 1.5 from 0.2', { startA: 0.2, speedA: 1.5 }, 0.31],
        ['A paused at 0.25', { startA: 0.25, speedA: 0 }, 7.7],
        ['A once, clamped', { startA: 0, speedA: 1, flags: 1 }, 3.3],
        [
          'B once, before its start',
          { startA: 0, speedA: 1, framesB: 3, startB: -1, flags: 2, fadeStart: 0, fadeDuration: 1 },
          0.4,
        ],
        [
          'fade A to B, midway',
          { startA: 0, speedA: 1, framesB: 3, startB: 0.05, fadeStart: 0.1, fadeDuration: 0.4 },
          0.26,
        ],
        [
          'fade done',
          { startA: 0, speedA: 1, framesB: 3, fadeStart: 0.1, fadeDuration: 0.4 },
          0.72,
        ],
        ['no fade duration: B', { startA: 0, speedA: 1, framesB: 3, fadeStart: 5 }, 0.17],
      ]
      world.set(entity, SkinPose, {
        source: 'baked',
        base: h,
        joints: 2,
        morphBase: 0,
        morphCount: 0,
        sphere: SPHERE,
      })
      for (const [label, hd, clock] of cases) {
        put(store, h, header(clips, hd))
        store.setClock(clock)
        const out = await check(label)
        const [ox, oy, oz] = expectedOffset(hd, clock)
        let max = 0
        for (let i = 0; i < out.length; i += 3) {
          // The bent pose, moved by the offset, then scaled 1.5 and placed.
          const ex = jointsOut[i]! + ox * 1.5
          const ey = jointsOut[i + 1]! + oy * 1.5
          const ez = jointsOut[i + 2]! + oz * 1.5
          max = Math.max(
            max,
            Math.abs(out[i]! - ex),
            Math.abs(out[i + 1]! - ey),
            Math.abs(out[i + 2]! - ez),
          )
        }
        expect(max, label).toBeLessThan(1e-4)
      }
      // Baked with the morph block too.
      world.set(entity, SkinPose, {
        source: 'baked',
        base: h,
        joints: 2,
        morphBase: morphs,
        morphCount: 2,
        sphere: SPHERE,
      })
      await check('baked + morph block')
      await s.app.dispose()
    })
  })
}

describe('pose source records', () => {
  it('write base, joint count with BAKED_BIT, the morph block, and the placed sphere', {
    timeout: timeout(30_000),
  }, async () => {
    const s = await scene(full)
    const { world, entity } = s
    world.set(entity, Transform, { translation: [2, 0, 1], scale: [1, 2, 1] })
    await frame(s)
    const store = s.store()
    expect(store.deforming).toBe(true)
    const pose = block(store, rows(BEND))
    const morphs = block(store, [1, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    world.add(entity, SkinPose, {
      source: 'baked',
      base: pose,
      joints: 2,
      morphBase: morphs,
      morphCount: 2,
      sphere: [0, 1, 0.5, 1.2],
    })
    await frame(s)
    const slot = world.get(entity, InstanceSlot).slot - 1
    const o = slot * DEFORM_WORDS
    const r = store.records
    const f = store.recordF32
    expect(r[o + 4]).toBe(pose)
    expect(r[o + 5]).toBe((2 | BAKED_BIT) >>> 0)
    expect(r[o + 9]).toBe(2)
    expect(r[o + 10]).toBe(morphs)
    expect([f[o], f[o + 1], f[o + 2]]).toEqual([2, 2, 1.5])
    expect(f[o + 3]).toBeCloseTo(2.4, 5)
    // Baked slots animate every frame: shadows redraw.
    expect(store.deforming).toBe(true)
    world.set(entity, SkinPose, {
      source: 'pose',
      base: pose,
      joints: 2,
      morphBase: 0,
      morphCount: 0,
      sphere: [0, 1, 0, 1],
    })
    await frame(s)
    expect(r[o + 5]).toBe(2)
    expect(r[o + 9]).toBe(0)
    // Nothing per frame and nothing written: poses are still.
    expect(store.poseCount).toBe(store.persistentEnd)
    expect(store.deforming).toBe(false)
    put(store, pose, rows(0))
    s.app.update(1 / 60)
    expect(store.deforming).toBe(true)
    await s.app.dispose()
  })

  it('culls baked slots by their sphere, on the CPU and the GPU', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene(full)
    const { world, entity } = s
    const store = s.store()
    const clip = block(store, [...rows(BEND), ...rows(BEND)])
    const h = block(store, [clip, 2, 0, 1, 0, 0, 0, 1, 30, 0, 0, 0])
    world.add(entity, SkinPose, { source: 'baked', base: h, joints: 2, sphere: SPHERE })
    for (const gpuCull of [true, false]) {
      world.resource(Culler).enabled = gpuCull
      world.set(entity, Visibility, { mode: 'visible' })
      const seen = (await renderView(s.app, s.view)).data
      world.set(entity, Visibility, { mode: 'hidden' })
      const none = (await renderView(s.app, s.view)).data
      world.set(entity, Visibility, { mode: 'visible' })
      // A sphere far behind the camera: culled, though the mesh would draw.
      world.set(entity, SkinPose, { source: 'baked', base: h, joints: 2, sphere: [0, 0, 100, 1] })
      const away = (await renderView(s.app, s.view)).data
      world.set(entity, SkinPose, { source: 'baked', base: h, joints: 2, sphere: SPHERE })
      expect(meanDifference(seen, none), `gpu ${gpuCull}`).toBeGreaterThan(1)
      expect(meanDifference(away, none), `gpu ${gpuCull}`).toBeLessThan(0.05)
    }
    await s.app.dispose()
  })

  it('baked playback translates for WebGL2 and draws without errors', {
    timeout: timeout(60_000),
  }, async () => {
    const fake = new FakeGl()
    const gpu = await createGpuContext({
      backend: 'webgl2',
      webgl2: { context: fake.context, persist: false },
    })
    try {
      const s = await scene(gpu)
      const store = s.store()
      const clip = block(store, [...rows(BEND), ...rows(0)])
      const h = block(store, [clip, 2, 0, 1, 0, 0, 0, 1, 30, 0, 0, 0])
      store.setClock(0.01)
      s.world.add(s.entity, SkinPose, { source: 'baked', base: h, joints: 2, sphere: SPHERE })
      await settle(s.app)
      const draws = fake.draws.length
      s.app.update(1 / 60)
      expect(fake.draws.length).toBeGreaterThan(draws)
      expect(gpu.errors.map((e) => e.message)).toEqual([])
      await s.app.dispose()
    } finally {
      gpu.destroy()
    }
  })
})
