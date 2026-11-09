import type { Entity } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, loadMeshSimplifier, type Mesh, plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import type { CapturedImage } from './graph'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight, PointLight } from './lights'
import { captureBuffer, Gpu, renderPlugin } from './plugin'
import { worldToScreen } from './projection'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { bentTube, pixel, renderView, settle } from './testing'
import { Ink, Toon } from './toon'
import { RenderPath, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadMeshSimplifier()
})
afterAll(() => gpu.destroy())

type Vec3 = [number, number, number]

async function scene(size = 64) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  world.resource(AmbientLight).brightness = 0
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const white = materials.add(new MaterialAsset({ baseColor: [1, 1, 1, 1], roughness: 1 }))
  const camera = (eye: Vec3, at: Vec3, extra: Record<string, unknown> = {}) => {
    const target = new OffscreenTarget(gpu, { label: 'toon', width: size, height: size })
    const ref = world.resource(RenderTargets).add(target, `toon-${Math.random()}`)
    return world.spawn(
      [
        Camera3d,
        {
          target: ref as never,
          projection: 'orthographic',
          orthoHeight: 2.4,
          clearColor: [0, 0, 0, 1],
          ...extra,
        },
      ],
      // ev100 0: exposure 1 / 1.2, divided out again by captureBuffer.
      [Exposure, { ev100: 0 }],
      [Tonemapping, { curve: 'none', dither: false }],
      [Transform, { translation: eye, rotation: lookAt(eye, at) }],
    )
  }
  return { app, world, meshes, materials, white, camera }
}

/** Radiance at every pixel, in cd/m²: one channel (red by default) of the view's HDR image. */
async function radiance(app: App, cam: Entity, channel = 0): Promise<number[]> {
  await settle(app)
  const pending = captureBuffer(app.world, `camera:${cam}`, 'hdr')
  app.update(1 / 60)
  const hdr = await pending
  const out: number[] = []
  for (let i = 0; i < hdr.width * hdr.height; i++) out.push(hdr.data[i * 4 + channel]!)
  return out
}

/** How many of `values` fall within `tolerance` of each of `levels`. */
function near(values: number[], levels: number[], tolerance = 0.02): number[] {
  return levels.map((l) => values.filter((v) => Math.abs(v - l) <= tolerance).length)
}

describe('toon shading', () => {
  it('bands a sun on a sphere into its tones, and softness widens the steps', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, meshes, white, camera } = await scene()
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 1 })) }],
      [MeshMaterial, { material: white }],
      [Transform, {}],
    )
    // Illuminance π: a white surface facing the sun has radiance 1 cd/m².
    world.spawn(
      [DirectionalLight, { illuminance: Math.PI }],
      [Transform, { rotation: lookAt([1, 0, 0.4], [0, 0, 0]) }],
    )
    const cam = camera([0, 0, 5], [0, 0, 0])
    const pbr = await radiance(app, cam)
    world.add(cam, Toon, { bands: 3, softness: 0 })
    const banded = await radiance(app, cam)
    const covered = banded.filter((v, i) => v > 0 || pbr[i]! > 0).length
    const [dark, half, full] = near(banded, [0, 0.5, 1])
    // Hard steps: every pixel takes one of the three tones.
    expect(dark! + half! + full!).toBeGreaterThan(banded.length * 0.97)
    expect(half).toBeGreaterThan(covered * 0.1)
    expect(full).toBeGreaterThan(covered * 0.1)
    // Physically based shading is smooth: few pixels sit exactly on those tones.
    const [, pbrHalf] = near(pbr, [0, 0.5, 1], 0.005)
    expect(pbrHalf).toBeLessThan(covered * 0.05)
    // A smooth ramp: in-between values come back.
    world.set(cam, Toon, { bands: 3, softness: 1 })
    const smooth = await radiance(app, cam)
    const between = smooth.filter((v) => v > 0.03 && Math.abs(v - 0.5) > 0.03 && v < 0.97)
    expect(between.length).toBeGreaterThan(covered * 0.2)
    await app.dispose()
  })

  it('bands point lights too, and a ramp sets the tones, the shadow side included', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, meshes, white, camera } = await scene()
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 1 })) }],
      [MeshMaterial, { material: white }],
      [Transform, {}],
    )
    // Tabletop falloff, full inside 20 m: π cd everywhere, so a facing white surface is 1 cd/m².
    world.spawn(
      [
        PointLight,
        { intensity: 4 * Math.PI * Math.PI, falloff: 'tabletop', bright: 20, range: 30 },
      ],
      [Transform, { translation: [3, 0, 1.2] }],
    )
    const cam = camera([0, 0, 5], [0, 0, 0])
    world.add(cam, Toon, {
      softness: 0,
      ramp: [
        [0.1, 0.1, 0.1, 1],
        [0.6, 0.3, 0.3, 1],
        [1, 1, 1, 1],
      ],
    })
    const red = await radiance(app, cam)
    const green = await radiance(app, cam, 1)
    const [none, dark, mid, full] = near(red, [0, 0.1, 0.6, 1])
    expect(none! + dark! + mid! + full!).toBeGreaterThan(red.length * 0.97)
    for (const n of [dark, mid, full]) expect(n).toBeGreaterThan(100)
    // The middle tone's own color: green at 0.3 where red is at 0.6.
    const midGreen = green.filter((_, i) => Math.abs(red[i]! - 0.6) < 0.02)
    expect(near(midGreen, [0.3])[0]).toBe(midGreen.length)
    await app.dispose()
  })

  it('gives a received shadow the shadow tone', { timeout: timeout(60_000) }, async () => {
    const { app, world, meshes, white, camera } = await scene()
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 10 })) }],
      [MeshMaterial, { material: white }],
      [Transform, {}],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: 0.8, y: 0.8, z: 0.8 })) }],
      [MeshMaterial, { material: white }],
      [Transform, { translation: [0, 1.5, 0] }],
    )
    world.spawn(
      [DirectionalLight, { illuminance: Math.PI, shadows: true }],
      [Transform, { rotation: lookAt([1.5, 4, 0.3], [0, 0, 0]) }],
    )
    const cam = camera([0, 10, 0.0001], [0, 0, 0], { orthoHeight: 4 })
    world.add(cam, Toon, { bands: 2, softness: 0, shadowColor: [0.25, 0.25, 0.25, 1] })
    const values = await radiance(app, cam)
    // The ground: lit (1) around the box's shadow (0.25); the box's top faces the sun (1).
    const [shadow, lit] = near(values, [0.25, 1])
    expect(shadow).toBeGreaterThan(100)
    expect(lit).toBeGreaterThan(1000)
    expect(shadow! + lit!).toBeGreaterThan(values.length * 0.97)
    await app.dispose()
  })

  it('leaves another camera exactly as it was', { timeout: timeout(60_000) }, async () => {
    const { app, world, meshes, materials, camera } = await scene()
    const shiny = materials.add(
      new MaterialAsset({ baseColor: [0.8, 0.5, 0.2, 1], roughness: 0.3, metallic: 0.5 }),
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 1 })) }],
      [MeshMaterial, { material: shiny }],
      [Transform, {}],
    )
    world.spawn(
      [DirectionalLight, { illuminance: Math.PI }],
      [Transform, { rotation: lookAt([1, 0.5, 0.4], [0, 0, 0]) }],
    )
    const duel = camera([0, 0, 5], [0, 0, 0])
    const comic = camera([0, 0, 5], [0, 0, 0])
    const before = await radiance(app, duel)
    world.add(comic, Toon, { bands: 3 })
    world.add(comic, Ink, {})
    const after = await radiance(app, duel)
    expect(after).toEqual(before)
    // While the toon camera's own picture did change.
    expect(await radiance(app, comic)).not.toEqual(before)
    await app.dispose()
  })

  it('shades skinned meshes and deferred views in the same bands', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, meshes, white, camera } = await scene()
    bentTube(world, white, false)
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 0.6 })) }],
      [MeshMaterial, { material: white }],
      [Transform, { translation: [0.8, 0.6, 0] }],
    )
    world.spawn(
      [DirectionalLight, { illuminance: Math.PI }],
      [Transform, { rotation: lookAt([1, 0.3, 0.6], [0, 0, 0]) }],
    )
    const forward = camera([0, 1, 5], [0, 1, 0], { orthoHeight: 3 })
    const deferred = camera([0, 1, 5], [0, 1, 0], { orthoHeight: 3 })
    world.add(deferred, RenderPath, { mode: 'deferred' })
    for (const cam of [forward, deferred]) world.add(cam, Toon, { bands: 3, softness: 0 })
    const f = await radiance(app, forward)
    const d = await radiance(app, deferred)
    for (const values of [f, d]) {
      const [none, half, full] = near(values, [0, 0.5, 1])
      expect(none! + half! + full!).toBeGreaterThan(values.length * 0.97)
      expect(half).toBeGreaterThan(50)
      expect(full).toBeGreaterThan(50)
    }
    let differ = 0
    for (let i = 0; i < f.length; i++) if (Math.abs(f[i]! - d[i]!) > 0.02) differ++
    expect(differ).toBeLessThan(f.length * 0.01)
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
  })
})

/**
 * A flat world under ambient light alone: a green ground, gray boxes. Ink is the only thing darker
 * than the surfaces.
 */
async function inkScene(size = 128) {
  const r = await scene(size)
  r.world.resource(AmbientLight).brightness = 1.5
  const gray = r.materials.add(new MaterialAsset({ baseColor: [0.6, 0.6, 0.6, 1] }))
  const green = r.materials.add(new MaterialAsset({ baseColor: [0.15, 0.6, 0.15, 1] }))
  const at = (mesh: Mesh, material: typeof gray, translation: Vec3) =>
    r.world.spawn(
      [Mesh3d, { mesh: r.meshes.add(mesh) }],
      [MeshMaterial, { material }],
      [Transform, { translation }],
    )
  at(plane({ size: 40 }), green, [0, 0, 0])
  at(box({ x: 1, y: 1, z: 1 }), gray, [-1.2, 0.5, 0])
  at(box({ x: 3, y: 2, z: 0.3 }), gray, [0.5, 1, -1.5])
  /** Two cameras at one place: one with Ink, one without. */
  const pair = (eye: Vec3, at: Vec3, extra: Record<string, unknown> = {}) => {
    const inked = r.camera(eye, at, extra)
    r.world.add(inked, Ink, { width: 2, color: [0, 0, 0, 1] })
    return [inked, r.camera(eye, at, extra)] as const
  }
  const move = (cams: readonly Entity[], eye: Vec3, at: Vec3) => {
    for (const c of cams) r.world.set(c, Transform, { translation: eye, rotation: lookAt(eye, at) })
  }
  return { ...r, pair, move }
}

const screen = new Float32Array(3)

const dark = (image: CapturedImage, x: number, y: number) =>
  x >= 0 && y >= 0 && x < image.width && y < image.height && pixel(image, x, y)[0]! < 60

const isGround = (p: number[]) => p[1]! > p[0]! + 40

/** Whether a pixel within `radius` of a world point's projection is ink. */
function inkNear(world: App['world'], cam: Entity, image: CapturedImage, p: Vec3, radius = 1) {
  worldToScreen(world, cam, p, screen)
  const cx = Math.round(screen[0]! - 0.5)
  const cy = Math.round(screen[1]! - 0.5)
  for (let y = cy - radius; y <= cy + radius; y++)
    for (let x = cx - radius; x <= cx + radius; x++) if (dark(image, x, y)) return true
  return false
}

/** Ink pixels over open ground: where the un-inked image shows ground 2 px around. */
function groundInk(inked: CapturedImage, plain: CapturedImage): number {
  let n = 0
  for (let y = 2; y < plain.height - 2; y++) {
    for (let x = 2; x < plain.width - 2; x++) {
      let open = true
      for (let dy = -2; dy <= 2 && open; dy++)
        for (let dx = -2; dx <= 2 && open; dx++) open = isGround(pixel(plain, x + dx, y + dy))
      if (open && dark(inked, x, y)) n++
    }
  }
  return n
}

function inkCount(image: CapturedImage): number {
  let n = 0
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) if (dark(image, x, y)) n++
  return n
}

describe('ink', () => {
  it('draws silhouettes, creases and edges facing the camera, and nothing on planes', {
    timeout: timeout(120_000),
  }, async () => {
    const { app, world, pair, move } = await inkScene()
    const eye: Vec3 = [6, 5, 7]
    const cams = pair(eye, [0, 0.5, 0], { orthoHeight: 6 })
    const [inked, plain] = cams
    const shots = async () =>
      [await renderView(app, `camera:${inked}`), await renderView(app, `camera:${plain}`)] as const
    const [image, base] = await shots()
    // The box's vertical edge between its two faces in view (direction turns).
    expect(inkNear(world, inked, image, [-0.7, 0.5, 0.5])).toBe(true)
    // Its top's far edge against the ground behind (depth jumps).
    expect(inkNear(world, inked, image, [-1.2, 1, -0.5])).toBe(true)
    // The crease along the wall's foot.
    expect(inkNear(world, inked, image, [1.5, 0, -1.35])).toBe(true)
    // None of that without Ink, and no ink on the open ground.
    expect(inkCount(base)).toBe(0)
    expect(groundInk(image, base)).toBe(0)
    // Panned by fractions of a pixel: as many lines, moving with the scene, none on the ground.
    const lines = inkCount(image)
    for (const shift of [0.013, 0.029, 0.041]) {
      move(cams, [eye[0] + shift, eye[1], eye[2] - shift], [shift, 0.5, -shift])
      const [moved, movedBase] = await shots()
      expect(Math.abs(inkCount(moved) - lines) / lines).toBeLessThan(0.1)
      expect(groundInk(moved, movedBase)).toBe(0)
    }
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
  })

  it('draws no line on the ground at any angle, perspective or orthographic', {
    timeout: timeout(120_000),
  }, async () => {
    const { app, world, pair } = await inkScene()
    for (const projection of ['orthographic', 'perspective'] as const) {
      for (const [eye, at] of [
        [
          [0, 9, 0.001],
          [0, 0, 0],
        ],
        [
          [7, 3, 7],
          [0, 0.5, 0],
        ],
        [
          [0, 0.6, 9],
          [0, 0.3, 0],
        ],
        [
          [-8, 1.2, 3],
          [0, 0, 0],
        ],
      ] as [Vec3, Vec3][]) {
        const [inked, plain] = pair(eye, at, { projection, orthoHeight: 7, fovY: 50 })
        const image = await renderView(app, `camera:${inked}`)
        const base = await renderView(app, `camera:${plain}`)
        expect(groundInk(image, base), `${projection} from ${eye}`).toBe(0)
        expect(inkCount(image), `${projection} from ${eye}`).toBeGreaterThan(20)
        world.despawn(inked)
        world.despawn(plain)
      }
    }
    await app.dispose()
  })

  it("follows a skinned mesh's pose", { timeout: timeout(60_000) }, async () => {
    const { app, world, meshes, white, camera } = await scene(96)
    world.resource(AmbientLight).brightness = 1.5
    // A backdrop behind the tube, so every line is ink against a surface.
    world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: 6, y: 6, z: 0.1 })) }],
      [MeshMaterial, { material: white }],
      [Transform, { translation: [0, 1, -1] }],
    )
    bentTube(world, white, true)
    const cam = camera([0, 1, 5], [0, 1, 0], { orthoHeight: 3 })
    world.add(cam, Ink, { width: 2, color: [0, 0, 0, 1] })
    const image = await renderView(app, `camera:${cam}`)
    let rest = 0
    let tip = 0
    for (let y = 0; y < 36; y++) {
      for (let x = 0; x < 96; x++) {
        if (!dark(image, x, y)) continue
        if (x >= 40 && x < 56 && y < 20) rest++
        if (x >= 14 && x < 36 && y >= 14) tip++
      }
    }
    expect(rest).toBe(0)
    expect(tip).toBeGreaterThan(10)
    await app.dispose()
  })
})
