import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@aethervtt/shard-assets'
import { beginRedefinition, endRedefinition, quat, type ShardError, t } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { App } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { defineMaterial } from './materials'
import { captureBuffer, Gpu, renderPlugin, Shaders } from './plugin'
import { forwardPlugin } from './standard'
import { RenderStats } from './stats'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { RenderPath, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

async function scene(width = 64, height = width) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin(),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'materials-target', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'materials-target')
  return { app, world: app.world, targetRef }
}

// A lava material as a project would write it (project.material is defineMaterial, namespaced).
const Lava = defineMaterial('test/Lava', {
  fields: {
    crackColor: t.color({ default: [1, 0.3, 0.05, 1] }),
    crackLuminance: t.f32({ default: 20000, unit: 'cd/m²' }),
    flow: t.vec2({ default: [0.02, 0], description: 'UV scroll per second.' }),
    cracks: t.handle('Texture', { description: 'Crack mask (R).' }),
  },
  shader: 'project::lava',
})

const LAVA_WESL = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::globals::globals;
import material::lava::{ Lava, Lava_cracks, Lava_cracks_sampler };

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let uv = in.uv + Lava.flow * globals.time;
  let crack = textureSample(Lava_cracks, Lava_cracks_sampler, uv).r;
  p.emissive += Lava.crackColor.rgb * Lava.crackLuminance * crack;
  return p;
}
`

/** A crack pattern: bright lines on black, in R. */
function cracks(size = 64): Texture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const line = (x + y * 3) % 17 < 2 || (x * 5 - y) % 23 < 2
      const o = (y * size + x) * 4
      data[o] = line ? 255 : 0
      data[o + 1] = data[o + 2] = 0
      data[o + 3] = 255
    }
  }
  return Texture.create({ width: size, height: size, usage: 'data', mips: [data], mipmaps: true })
}

function stage(world: App['world']) {
  const floor = world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 0.8 }))
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 20 })) }],
    [MeshMaterial, { material: floor }],
    Transform,
  )
  world.spawn(
    [DirectionalLight, { illuminance: 3000, shadows: true }],
    [Transform, { rotation: q(-1.0, 0.4, 0) }],
  )
}

describe('extensible materials', () => {
  it('renders a project material (fields, a texture, a pbr_input override) as a golden image', async () => {
    const { app, world, targetRef } = await scene(96, 64)
    world.resource(Shaders).register('project::lava', LAVA_WESL, 'shaders/lava.wesl')
    stage(world)
    const tex = world.resource(Textures).add(cracks())
    const lava = world.resource(Materials).add(
      new MaterialAsset(
        {
          baseColor: [0.08, 0.05, 0.04, 1],
          roughness: 0.7,
          flow: [0, 0],
          cracks: tex,
          crackLuminance: 2500,
        },
        Lava,
      ),
    )
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(sphere({ radius: 1, segments: 48 })) }],
      [MeshMaterial, { material: lava }],
      [Transform, { translation: [0, 1, 0] }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef, fovY: 40 }],
      [Exposure, { ev100: 10 }],
      [Transform, { translation: [0, 2.5, 5], rotation: lookAt([0, 2.5, 5], [0, 0.8, 0]) }],
    )
    const image = await renderView(app, `camera:${cam}`)
    expect(compareGolden(here, 'material-lava', image).mean).toBeLessThan(1.5)
    // The cracks glow: some pixels on the ball are far brighter than the dark rock.
    let bright = 0
    for (let y = 10; y < 50; y++)
      for (let x = 30; x < 66; x++) if (pixel(image, x, y)[0]! > 200) bright++
    expect(bright).toBeGreaterThan(20)
  })

  it('renders the same project material in a deferred view (golden image)', async () => {
    const { app, world, targetRef } = await scene(96, 64)
    world.resource(Shaders).register('project::lava', LAVA_WESL, 'shaders/lava.wesl')
    stage(world)
    const tex = world.resource(Textures).add(cracks())
    const lava = world.resource(Materials).add(
      new MaterialAsset(
        {
          baseColor: [0.08, 0.05, 0.04, 1],
          roughness: 0.7,
          flow: [0, 0],
          cracks: tex,
          crackLuminance: 2500,
        },
        Lava,
      ),
    )
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(sphere({ radius: 1, segments: 48 })) }],
      [MeshMaterial, { material: lava }],
      [Transform, { translation: [0, 1, 0] }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef, fovY: 40 }],
      [Exposure, { ev100: 10 }],
      [RenderPath, { mode: 'deferred' }],
      [Transform, { translation: [0, 2.5, 5], rotation: lookAt([0, 2.5, 5], [0, 0.8, 0]) }],
    )
    const image = await renderView(app, `camera:${cam}`)
    expect(compareGolden(here, 'material-lava-deferred', image).mean).toBeLessThan(1.5)
    // The same material through the G-buffer matches the forward golden (edges differ: no MSAA).
    const forward = new Uint8Array(readFileSync(join(here, '__golden__', 'material-lava.rgba')))
    let sum = 0
    for (let i = 0; i < forward.length; i++) sum += Math.abs(forward[i]! - image.data[i]!)
    expect(sum / forward.length).toBeLessThan(3)
  })

  it('displaces the mesh and its shadow identically with vertex_position', async () => {
    const Float = defineMaterial('test/Float', { shader: 'project::float' })
    const render = async (displaced: boolean) => {
      const { app, world, targetRef } = await scene(96, 64)
      world.resource(Shaders).register(
        'project::float',
        `override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  return position + vec3f(0.0, 1.0, 0.0);
}`,
        'shaders/float.wesl',
      )
      stage(world)
      const value = { baseColor: [0.2, 0.5, 0.9, 1], roughness: 0.4 }
      const material = world
        .resource(Materials)
        .add(displaced ? new MaterialAsset(value, Float) : new MaterialAsset(value))
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1 })) }],
        [MeshMaterial, { material }],
        [Transform, { translation: [0, displaced ? 0.6 : 1.6, 0], rotation: q(0, 0.5, 0) }],
      )
      const cam = world.spawn(
        [Camera3d, { target: targetRef, fovY: 45 }],
        [Exposure, { ev100: 10 }],
        [Tonemapping, { dither: false }],
        [Transform, { translation: [0, 3, 5], rotation: lookAt([0, 3, 5], [0, 0.8, 0]) }],
      )
      return renderView(app, `camera:${cam}`)
    }
    const moved = await render(true)
    const reference = await render(false)
    let sum = 0
    for (let i = 0; i < moved.data.length; i++) sum += Math.abs(moved.data[i]! - reference.data[i]!)
    // Same image: the displaced cube and its shadow sit exactly where the translated one's do.
    expect(sum / moved.data.length).toBeLessThan(0.1)
    expect(compareGolden(here, 'material-displaced', moved).mean).toBeLessThan(1.5)
  })

  it("renders an extends: 'none' material with a shade hook, and a fragment_output override in HDR", async () => {
    const Unlit = defineMaterial('test/Unlit', {
      extends: 'none',
      fields: {
        color: t.color({ default: [1, 0.5, 0.25, 1] }),
        luminance: t.f32({ default: 1000, unit: 'cd/m²' }),
      },
      shader: 'project::unlit',
    })
    const Doubled = defineMaterial('test/Doubled', { shader: 'project::doubled' })
    const { app, world, targetRef } = await scene(48, 16)
    const shaders = world.resource(Shaders)
    shaders.register(
      'project::unlit',
      `import shard::pbr::types::VertexOutput;
import material::unlit::Unlit;
override fn shade(in: VertexOutput) -> vec4f {
  return vec4f(Unlit.color.rgb * Unlit.luminance, 1.0);
}`,
      'shaders/unlit.wesl',
    )
    shaders.register(
      'project::doubled',
      `override fn fragment_output(color: vec4f) -> vec4f {
  return vec4f(color.rgb * 2.0, color.a);
}`,
      'shaders/doubled.wesl',
    )
    world.spawn(
      [DirectionalLight, { illuminance: 2000 }],
      [Transform, { rotation: q(0, 0, 0) }], // shines along -Z, onto the quads facing +Z
    )
    const materials = world.resource(Materials)
    const quad = world.resource(Meshes).add(plane({ size: 1 }))
    const flat = { baseColor: [0.5, 0.5, 0.5, 1], roughness: 1 }
    for (const [i, material] of [
      new MaterialAsset({}, Unlit),
      new MaterialAsset(flat),
      new MaterialAsset(flat, Doubled),
    ].entries()) {
      world.spawn(
        [Mesh3d, { mesh: quad }],
        [MeshMaterial, { material: materials.add(material) }],
        // Planes face +Y; turn them to face the camera (+Z).
        [Transform, { translation: [(i - 1) * 1.05, 0, 0], rotation: q(Math.PI / 2, 0, 0) }],
      )
    }
    const cam = world.spawn(
      [Camera3d, { target: targetRef, projection: 'orthographic', orthoHeight: 1 }],
      [Exposure, { ev100: 8 }],
      [Transform, { translation: [0, 0, 5] }],
    )
    await settle(app)
    const shot = captureBuffer(world, `camera:${cam}`, 'hdr')
    app.update(1 / 60)
    const hdr = await shot
    const unlit = pixel(hdr, 8, 8)
    expect(unlit[0]).toBeCloseTo(1000, -1)
    expect(unlit[1]).toBeCloseTo(500, -1)
    expect(unlit[2]).toBeCloseTo(250, -1)
    const standard = pixel(hdr, 24, 8)[0]!
    const doubled = pixel(hdr, 40, 8)[0]!
    expect(standard).toBeGreaterThan(10)
    expect(doubled / standard).toBeCloseTo(2, 2)
  })

  it('validates *.material.json files against their type, and old files load as standard', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-materials-'))
    roots.push(root)
    mkdirSync(join(root, 'materials'))
    writeFileSync(
      join(root, 'materials/lava.material.json'),
      JSON.stringify({ type: 'test/Lava', crackLuminance: 30000 }),
    )
    writeFileSync(
      join(root, 'materials/bad.material.json'),
      JSON.stringify({ type: 'test/Lava', crackLuminance: 'hot' }),
    )
    writeFileSync(
      join(root, 'materials/old.material.json'),
      JSON.stringify({ baseColor: [1, 0, 0, 1], roughness: 0.3 }),
    )
    const { world } = await scene(8)
    const server = assetServer(world).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
      roots: ['materials'],
    })
    const report = await server.scan()
    const bad = report.failed.find((f) => f.path === 'materials/bad.material.json')
    expect(bad?.error).toMatchObject({ path: '/crackLuminance' })
    await server.load('materials/lava.material.json')
    await server.load('materials/old.material.json')
    const lava = world.resource(Materials).get(server.resolve('materials/lava.material.json'))!
    expect(lava.type).toBe(Lava)
    expect(lava.value.crackLuminance).toBe(30000)
    expect(lava.value.roughness).toBe(0.5) // a standard field's default
    const old = world.resource(Materials).get(server.resolve('materials/old.material.json'))!
    expect(old.type.name).toBe('render/StandardMaterial')
    expect(old.value.roughness).toBeCloseTo(0.3)
  })

  it('reloads an edited shader within a frame of compiling, and keeps the old one when broken', async () => {
    const Tint = defineMaterial('test/Tint', { shader: 'project::tint' })
    const { app, world, targetRef } = await scene(8)
    const shaders = world.resource(Shaders)
    const tint = (rgb: string) => `import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  p.base_color = vec3f(0.0);
  p.emissive = vec3f(${rgb}) * 2000.0;
  return p;
}`
    shaders.register('project::tint', tint('1.0, 0.0, 0.0'), 'shaders/tint.wesl')
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 10 })) }],
      [MeshMaterial, { material: world.resource(Materials).add(new MaterialAsset({}, Tint)) }],
      [Transform, { rotation: q(Math.PI / 2, 0, 0) }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef }],
      [Exposure, { ev100: 10 }],
      [Transform, { translation: [0, 0, 3] }],
    )
    const center = async () => pixel(await renderView(app, `camera:${cam}`), 4, 4)
    const red = await center()
    expect(red[0]!).toBeGreaterThan(red[1]! + 100)
    shaders.register('project::tint', tint('0.0, 1.0, 0.0'), 'shaders/tint.wesl')
    await shaders.whenIdle()
    const green = await center()
    expect(green[1]!).toBeGreaterThan(green[0]! + 100)
    const errorsBefore = world.resource(Gpu).errors.length
    shaders.register(
      'project::tint',
      tint('0.0, 1.0, 0.0').replace('p.base_color = vec3f(0.0);', 'p.base_color = vec3f(0.0) +;'),
      'shaders/tint.wesl',
    )
    const still = await center()
    expect(still).toEqual(green)
    const error = world.resource(Gpu).errors.slice(errorsBefore).at(-1) as ShardError
    expect(error.message).toContain('material test/Tint')
    expect(error.path).toMatch(/^shaders\/tint\.wesl:\d+:\d+$/)
  })

  it('migrates existing assets when a material type gains a field (hot reload)', async () => {
    const make = (extra: boolean) =>
      defineMaterial('test/Grow', {
        fields: {
          glow: t.f32({ default: 1 }),
          ...(extra ? { pulse: t.f32({ default: 3 }) } : {}),
        },
      })
    const Grow = make(false)
    const { app, world, targetRef } = await scene(8)
    const asset = new MaterialAsset({ glow: 5 }, Grow)
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(cube()) }],
      [MeshMaterial, { material: world.resource(Materials).add(asset) }],
      Transform,
    )
    world.spawn([Camera3d, { target: targetRef }], [Transform, { translation: [0, 0, 5] }])
    app.update(1 / 60)
    beginRedefinition('test')
    const again = make(true)
    endRedefinition()
    expect(again).toBe(Grow) // redefinition updates the type in place
    app.update(1 / 60)
    expect(asset.value.glow).toBe(5)
    expect(asset.value.pulse).toBe(3)
  })

  it('draws 10 material types × 1000 meshes with at most 10 pipeline switches', async () => {
    const types = Array.from({ length: 10 }, (_, i) =>
      defineMaterial(`test/Kind${String.fromCharCode(65 + i)}`, {
        fields: { weight: t.f32({ default: i }) },
      }),
    )
    const { app, world, targetRef } = await scene(32)
    const materials = types.map((type) =>
      world.resource(Materials).add(new MaterialAsset({ baseColor: [0.5, 0.5, 0.5, 1] }, type)),
    )
    const mesh = world.resource(Meshes).add(cube({ size: 0.1 }))
    for (let i = 0; i < 10_000; i++) {
      world.spawn(
        [Mesh3d, { mesh }],
        // Interleaved on purpose: sorting, not spawn order, groups them.
        [MeshMaterial, { material: materials[i % 10]! }],
        [Transform, { translation: [(i % 100) * 0.2 - 10, Math.floor(i / 100) * 0.2 - 10, -20] }],
      )
    }
    const cam = world.spawn([Camera3d, { target: targetRef, fovY: 90 }], Transform)
    await settle(app)
    app.update(1 / 60)
    const stats = world.resource(RenderStats).get(`camera:${cam}`)!
    expect(stats.visible).toBe(10_000)
    expect(stats.drawCalls).toBe(10)
    expect(stats.pipelineSwitches).toBeLessThanOrEqual(10)
  })
})

describe('the material registry (0052)', () => {
  it('treats the same definition twice as one type, and a different one as a conflict', () => {
    const define = (glow: number) =>
      defineMaterial('test/Shared', {
        fields: { glow: t.f32({ default: glow }) },
        shader: 'project::shared',
      })
    const first = define(1)
    expect(define(1)).toBe(first) // a second app registering the same type
    expect(() => define(2)).toThrow(expect.objectContaining({ code: 'render/registry-conflict' }))
    beginRedefinition('test')
    expect(define(2)).toBe(first) // hot reload still updates in place
    endRedefinition()
  })
})
