/**
 * Test helpers (not a test): a planet app on a GPU (Dawn in Node) or headless, a camera placed in
 * the planet's frame, and a loop that runs frames until the terrain stops generating.
 */
import type { Entity, World } from '@shard/core'
import { quat } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { type NoiseGraph, NoiseGraphs } from '@shard/noise'
import { GravitySource, PhysicsConfig, physics3dPlugin } from '@shard/physics'
import {
  Camera3d,
  captureView,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Shaders,
  Tonemapping,
} from '@shard/render'
import { App, type Plugin } from '@shard/runtime'
import { FloatingOrigin, Grid, placeInGrid, Transform, TransformPlugin } from '@shard/transform'
import { Planet, TerrainBudget } from './components'
import { Terrain } from './heights'
import type { PlanetRuntime } from './planet'
import { terrainPlugin } from './plugin'
import type { renderOf } from './render'

export interface PlanetOptions {
  radius: number
  heightScale?: number
  height?: NoiseGraph
  climate?: NoiseGraph
  seed?: number
  ocean?: boolean
  seaLevel?: number
  skirts?: boolean
  errorPixels?: number
  /** MSAA samples (default 1). */
  msaa?: 1 | 4
  /** Planet.vertexPixels (default: the component's). */
  vertexPixels?: number
  minSpacing?: number
  width?: number
  heightPx?: number
  fovY?: number
  clearColor?: [number, number, number, number]
  physics?: boolean
  extra?: Plugin[]
  /** Chunk generations per frame (TerrainBudget.chunksPerFrame). */
  chunksPerFrame?: number
}

export interface PlanetApp {
  app: App
  world: World
  planet: Entity
  camera: Entity
  /** The sun (a DirectionalLight), when there's a GPU. */
  sun: Entity
  view: string
  runtime(): PlanetRuntime
}

export async function planetApp(gpu: GpuContext | undefined, o: PlanetOptions): Promise<PlanetApp> {
  const app = new App().addPlugin(TransformPlugin)
  if (gpu)
    app.addPlugin(renderPlugin({ gpu, windowView: false }), forwardPlugin({ msaa: o.msaa ?? 1 }))
  if (o.physics) app.addPlugin(physics3dPlugin)
  app.addPlugin(terrainPlugin(), ...(o.extra ?? []))
  await app.init()
  const world = app.world
  if (o.physics) world.resource(PhysicsConfig).gravity = [0, 0, 0]
  if (o.chunksPerFrame !== undefined)
    world.resource(TerrainBudget).chunksPerFrame = o.chunksPerFrame
  const graphs = world.initResource(NoiseGraphs)
  const planet = world.spawn(
    [Grid, { cellSize: 2000 }],
    [
      Planet,
      {
        radius: o.radius,
        heightScale: o.heightScale ?? 0,
        height: o.height ? graphs.add(o.height, 'height') : null,
        climate: o.climate ? graphs.add(o.climate, 'climate') : null,
        seed: o.seed ?? 1,
        ocean: o.ocean ?? false,
        seaLevel: o.seaLevel ?? 0,
        skirts: o.skirts ?? true,
        errorPixels: o.errorPixels ?? 2,
        ...(o.vertexPixels !== undefined ? { vertexPixels: o.vertexPixels } : {}),
        minSpacing: o.minSpacing ?? 0.4,
      },
    ],
    [GravitySource, { strength: 9.81, radius: o.radius }],
    Transform,
  )
  let view = ''
  let camera = -1 as Entity
  let sun = -1 as Entity
  if (gpu) {
    const target = new OffscreenTarget(gpu, {
      label: 'terrain-test',
      width: o.width ?? 96,
      height: o.heightPx ?? 64,
    })
    const targetRef = world.resource(RenderTargets).add(target, 'terrain-test')
    camera = world.spawn(
      [
        Camera3d,
        {
          target: targetRef,
          fovY: o.fovY ?? 60,
          near: 0.05,
          clearColor: o.clearColor ?? [1, 0, 1, 1],
        },
      ],
      [Exposure, { ev100: 14 }],
      [Tonemapping, { curve: 'none', dither: false }],
      Transform,
      FloatingOrigin,
    )
    view = `camera:${camera}`
    sun = world.spawn(
      [DirectionalLight, { illuminance: 50000, shadows: false }],
      [
        Transform,
        {
          rotation: quat.fromEuler([0, 0, 0, 1], -0.8, 0.4, 0) as [number, number, number, number],
        },
      ],
    )
  }
  // One frame so the planet's runtime exists (graphs resolved, errors measured).
  app.update(1 / 60)
  return {
    app,
    world,
    planet,
    camera,
    sun,
    view,
    runtime: () => world.resource(Terrain).planets.get(planet)!,
  }
}

/** Puts the camera at `eye` (planet frame, f64) looking at `target`, up roughly radial. */
export function placeCamera(p: PlanetApp, eye: ArrayLike<number>, target: ArrayLike<number>): void {
  const f = [target[0]! - eye[0]!, target[1]! - eye[1]!, target[2]! - eye[2]!]
  const l = Math.hypot(eye[0]!, eye[1]!, eye[2]!) || 1
  const upv = [eye[0]! / l, eye[1]! / l, eye[2]! / l]
  const rotation = quat.lookRotation([0, 0, 0, 1], f, upv) as [number, number, number, number]
  placeInGrid(p.world, p.camera, p.planet, eye)
  p.world.set(p.camera, Transform, { rotation })
}

/** Runs frames (awaiting pipelines) until nothing is requested, queued, or compiling. */
export async function settleTerrain(p: PlanetApp, maxFrames = 400): Promise<number> {
  const gpu = p.world.tryResource(Gpu)
  let quiet = 0
  for (let f = 0; f < maxFrames; f++) {
    p.app.update(1 / 60)
    const rt = p.runtime()
    const pr = rt?.parts.get('render') as ReturnType<typeof renderOf> | undefined
    if (gpu) {
      await p.world.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
      await new Promise((r) => setTimeout(r, 0))
      // Every frame's bounds readbacks land before the next frame, however loaded the machine
      // is: selection then takes the same path every run.
      for (let k = 0; pr && pr.stats.readbacks < pr.stats.generated && k < 500; k++) {
        await new Promise((r) => setTimeout(r, 1))
      }
    }
    const busy =
      !rt?.ready ||
      rt.selection.requestedCount > 0 ||
      rt.oceanSelection.requestedCount > 0 ||
      (pr?.jobs.length ?? 0) > 0 ||
      // Bounds from generation readbacks still on the way would change culling.
      (pr ? pr.stats.readbacks < pr.stats.generated : false) ||
      (gpu ? gpu.pipelines.pending > 0 : false)
    quiet = busy ? 0 : quiet + 1
    if (quiet >= 3) return f
  }
  return maxFrames
}

/** Renders one more frame and captures the camera's view. */
export async function capture(p: PlanetApp) {
  const shot = captureView(p.world, p.view)
  p.app.update(1 / 60)
  return shot
}

/** Points the sun at a spot on the planet (planet frame direction) from `elevation` degrees up. */
export function sunOver(p: PlanetApp, direction: ArrayLike<number>, elevation = 35): void {
  const l = Math.hypot(direction[0]!, direction[1]!, direction[2]!)
  const up = [direction[0]! / l, direction[1]! / l, direction[2]! / l]
  const side = Math.abs(up[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  // A horizontal direction at the spot, then tilt down by the elevation: the light travels along it.
  const h = [
    side[1]! * up[2]! - side[2]! * up[1]!,
    side[2]! * up[0]! - side[0]! * up[2]!,
    side[0]! * up[1]! - side[1]! * up[0]!,
  ]
  const hl = Math.hypot(h[0]!, h[1]!, h[2]!)
  const e = (elevation * Math.PI) / 180
  const travel = [0, 1, 2].map((k) => (h[k]! / hl) * Math.cos(e) - up[k]! * Math.sin(e))
  const rotation = quat.lookRotation([0, 0, 0, 1], travel, up) as [number, number, number, number]
  p.world.set(p.sun, Transform, { rotation })
}

/**
 * Pixels that show sky where the ray from the camera must hit the planet: anything inside the
 * sphere of the lowest possible surface (radius − heightScale) is terrain whatever the LOD.
 */
export function holes(
  data: Uint8Array,
  W: number,
  H: number,
  FOV: number,
  eye: ArrayLike<number>,
  right: number[],
  up: number[],
  forward: number[],
  lowest: number,
): number {
  let count = 0
  const ty = Math.tan(((FOV / 2) * Math.PI) / 180)
  const tx = ty * (W / H)
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const a = ((px + 0.5) / W) * 2 - 1
      const b = 1 - ((py + 0.5) / H) * 2
      const d = [0, 1, 2].map((k) => forward[k]! + right[k]! * a * tx + up[k]! * b * ty)
      const dl = Math.hypot(d[0]!, d[1]!, d[2]!)
      const dx = d[0]! / dl
      const dy = d[1]! / dl
      const dz = d[2]! / dl
      const bq = eye[0]! * dx + eye[1]! * dy + eye[2]! * dz
      const c = eye[0]! ** 2 + eye[1]! ** 2 + eye[2]! ** 2 - lowest * lowest
      const disc = bq * bq - c
      // Well inside the silhouette only: a pixel whose ray grazes the edge can be either.
      if (disc <= lowest * lowest * 0.02 || -bq - Math.sqrt(disc) < 0) continue
      const o = (py * W + px) * 4
      if (data[o]! > 200 && data[o + 1]! < 60 && data[o + 2]! > 200) count++
    }
  }
  return count
}
