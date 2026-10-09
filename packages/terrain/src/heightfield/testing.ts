/**
 * Test helpers (not a test) for heightfield terrain (spec 0071): an app with a terrain baked in
 * memory from a source object, a camera placed in the terrain's frame, a loop that runs frames until
 * streaming settles, and hole detection against the sky color.
 */
import { type Entity, hash32, quat, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { loadNoiseKernel, NoiseGraph, NoiseGraphs } from '@aethervtt/shard-noise'
import {
  CharacterController,
  CharacterIntent,
  CharacterState,
  PhysicsConfig,
  physics3dPlugin,
} from '@aethervtt/shard-physics'
import type { PlatformFileSystem, Workers } from '@aethervtt/shard-platform'
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
} from '@aethervtt/shard-render'
import { App, type Plugin } from '@aethervtt/shard-runtime'
import {
  FloatingOrigin,
  Grid,
  placeInGrid,
  Transform,
  TransformPlugin,
  worldPosition64,
} from '@aethervtt/shard-transform'
import { TerrainBudget } from '../components'
import { lockCode } from '../grid-mesh'
import { TerrainWorld } from '../heights'
import { morphFactor } from '../lod'
import { terrainPlugin } from '../plugin'
import { tilesOf } from './colliders'
import { Terrain } from './component'
import { type Heightmap, Heightmaps } from './heightmap'
import { dequantize, LEAF_SIDE, PAGE, SIDE } from './kernel'
import { nodeKey } from './pages'
import { pageHeight } from './queries'
import type { HeightfieldRender } from './render'
import type { HeightfieldRuntime } from './runtime'
import { parseTerrainSource, terrainLayout } from './source'
import { type SourceDependency, TerrainSourceAsset, TerrainSources } from './source-asset'
import { mainNoise } from './stack'

export interface HeightfieldOptions {
  /** A `*.terrain.json` object; asset paths name entries of `noise` and `heightmaps`. */
  source: unknown
  noise?: Record<string, NoiseGraph>
  heightmaps?: Record<string, { width: number; height: number; data: Float32Array }>
  /** Blocks per side override (tests: small blocks). */
  block?: number
  workers?: Workers
  width?: number
  heightPx?: number
  fovY?: number
  clearColor?: [number, number, number, number]
  physics?: boolean
  skirts?: boolean
  errorPixels?: number
  vertexPixels?: number
  extra?: Plugin[]
  pages?: number
  pagesPerFrame?: number
  /** Where the terrain's corner sits in the world (its Transform). */
  at?: [number, number, number]
  /** Bake into (and read packs from) this file service's `.shard/cache/terrain`; memory without. */
  fs?: PlatformFileSystem
  /** The source asset's guid (its cache directory), default `mem:…`. */
  name?: string
}

export interface HeightfieldApp {
  app: App
  world: World
  terrain: Entity
  camera: Entity
  sun: Entity
  view: string
  runtime(): HeightfieldRuntime
  render(): HeightfieldRender | undefined
}

/** A terrain source asset made in memory, its assets in the world's stores. */
export function sourceAsset(world: World, o: HeightfieldOptions): TerrainSourceAsset {
  const source = parseTerrainSource(o.source)
  const layout = terrainLayout(source, o.block)
  const deps: Record<string, SourceDependency> = {}
  const graphs = world.initResource(NoiseGraphs)
  for (const [path, graph] of Object.entries(o.noise ?? {})) {
    const ref = graphs.add(graph, path)
    deps[path] = { guid: ref.guid!, type: 'NoiseGraph', hash: graph.hash }
  }
  const maps = world.initResource(Heightmaps)
  for (const [path, map] of Object.entries(o.heightmaps ?? {})) {
    const ref = maps.add({ ...map, version: 0 } as Heightmap, path)
    deps[path] = { guid: ref.guid!, type: 'Heightmap', hash: path }
  }
  return new TerrainSourceAsset({
    format: 1,
    source,
    layout,
    deps,
    hash: JSON.stringify([o.source, Object.keys(deps)]),
  })
}

export async function heightfieldApp(
  gpu: GpuContext | undefined,
  o: HeightfieldOptions,
): Promise<HeightfieldApp> {
  const app = new App().addPlugin(TransformPlugin)
  if (gpu) app.addPlugin(renderPlugin({ gpu, windowView: false }), forwardPlugin({ msaa: 1 }))
  if (o.physics) app.addPlugin(physics3dPlugin())
  app.addPlugin(terrainPlugin({ workers: o.workers, fs: o.fs }), ...(o.extra ?? []))
  await app.init()
  const world = app.world
  if (o.physics) world.resource(PhysicsConfig).gravity = [0, -9.81, 0]
  if (o.pages !== undefined) world.resource(TerrainBudget).pages = o.pages
  if (o.pagesPerFrame !== undefined) world.resource(TerrainBudget).pagesPerFrame = o.pagesPerFrame
  const asset = sourceAsset(world, o)
  const sources = world.initResource(TerrainSources)
  let ref = sources.add(asset, 'test.terrain.json')
  if (o.name) {
    sources.set(o.name, asset)
    ref = { type: 'terrain/TerrainSource', guid: o.name, path: `${o.name}.terrain.json` }
  }
  const terrain = world.spawn(
    [Grid, { cellSize: 2000 }],
    [
      Terrain,
      {
        source: ref,
        skirts: o.skirts ?? true,
        errorPixels: o.errorPixels ?? 2,
        ...(o.vertexPixels !== undefined ? { vertexPixels: o.vertexPixels } : {}),
      },
    ],
    [Transform, { translation: o.at ?? [0, 0, 0] }],
  )
  let view = ''
  let camera = -1 as Entity
  let sun = -1 as Entity
  if (gpu) {
    const target = new OffscreenTarget(gpu, {
      label: 'heightfield-test',
      width: o.width ?? 96,
      height: o.heightPx ?? 64,
    })
    const targetRef = world.resource(RenderTargets).add(target, 'heightfield-test')
    camera = world.spawn(
      [
        Camera3d,
        {
          target: targetRef,
          fovY: o.fovY ?? 60,
          near: 0.05,
          far: 1e6,
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
  app.update(1 / 60)
  return {
    app,
    world,
    terrain,
    camera,
    sun,
    view,
    runtime: () => world.resource(TerrainWorld).heightfields.get(terrain)!,
    render: () =>
      world.resource(TerrainWorld).heightfields.get(terrain)?.parts.get('render') as
        | HeightfieldRender
        | undefined,
  }
}

/** Puts the camera at `eye` (terrain frame) looking at `target`, up +Y. */
export function lookAt(p: HeightfieldApp, eye: ArrayLike<number>, target: ArrayLike<number>) {
  const f = [target[0]! - eye[0]!, target[1]! - eye[1]!, target[2]! - eye[2]!]
  const rotation = quat.lookRotation([0, 0, 0, 1], f, [0, 1, 0]) as [number, number, number, number]
  placeInGrid(p.world, p.camera, p.terrain, eye)
  p.world.set(p.camera, Transform, { ...p.world.get(p.camera, Transform), rotation })
}

/** Waits until the terrain is streaming (its bake done and coarse levels loaded). */
export async function untilStreaming(p: HeightfieldApp, maxMs = 120_000): Promise<void> {
  const start = performance.now()
  while (performance.now() - start < maxMs) {
    p.app.update(1 / 60)
    const rt = p.runtime()
    if (rt?.problem) throw rt.problem
    if (rt?.streaming) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(
    `terrain not streaming after ${maxMs} ms (bake: ${p.runtime()?.bake}, waiting: ${p.runtime()?.waiting})`,
  )
}

/** Runs frames (awaiting pipelines and reads) until nothing is requested, read or uploading. */
export async function settleHeightfield(p: HeightfieldApp, maxFrames = 600): Promise<number> {
  const gpu = p.world.tryResource(Gpu)
  let quiet = 0
  for (let f = 0; f < maxFrames; f++) {
    p.app.update(1 / 60)
    const rt = p.runtime()
    const r = p.render()
    if (gpu) {
      await p.world.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
    }
    await new Promise((res) => setTimeout(res, 1))
    const busy =
      !rt?.streaming ||
      rt.selection.requestedCount > 0 ||
      (rt.pages?.pendingReads ?? 0) > 0 ||
      (r ? r.arrived.length > 0 || r.pending.size > 0 : true) ||
      (gpu ? gpu.pipelines.pending > 0 : false)
    quiet = busy ? 0 : quiet + 1
    if (quiet >= 3) return f
  }
  return maxFrames
}

/** Renders one more frame and captures the camera's view. */
export async function capture(p: HeightfieldApp) {
  const shot = captureView(p.world, p.view)
  p.app.update(1 / 60)
  return shot
}

/**
 * Sky-colored pixels (the magenta clear color) whose ray from the camera reaches the plane of the
 * lowest possible ground (`lowest`) inside the terrain's rectangle (less `margin`): the ground is
 * above that plane everywhere, so the ray must have hit it.
 */
export function holes(
  data: Uint8Array,
  W: number,
  H: number,
  fov: number,
  eye: ArrayLike<number>,
  right: number[],
  up: number[],
  forward: number[],
  lowest: number,
  rect: [number, number, number, number],
): number {
  let count = 0
  const ty = Math.tan(((fov / 2) * Math.PI) / 180)
  const tx = ty * (W / H)
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const a = ((px + 0.5) / W) * 2 - 1
      const b = 1 - ((py + 0.5) / H) * 2
      const d = [0, 1, 2].map((k) => forward[k]! + right[k]! * a * tx + up[k]! * b * ty)
      if (d[1]! >= -1e-6) continue
      const t = (lowest - eye[1]!) / d[1]!
      if (t <= 0) continue
      const x = eye[0]! + d[0]! * t
      const z = eye[2]! + d[2]! * t
      if (x < rect[0] || z < rect[1] || x > rect[2] || z > rect[3]) continue
      const o = (py * W + px) * 4
      if (data[o]! > 200 && data[o + 1]! < 60 && data[o + 2]! > 200) count++
    }
  }
  return count
}

/** 0071's 2 km test terrain at 0.5 m: hills, a valley image, and a road flattened through them. */
export function valleySource(size = 2048, spacing = 0.5) {
  const bowl = new Float32Array(64 * 64)
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      bowl[y * 64 + x] = Math.max(0, 1 - Math.hypot(x - 31.5, y - 31.5) / 32)
  return {
    source: {
      size: [size, size],
      spacing,
      heightRange: [-150, 350],
      seed: 7,
      splines: {
        road: {
          points: [
            [size * 0.05, 'ground', size * 0.1],
            [size * 0.45, 'ground', size * 0.35],
            [size * 0.7, 'ground', size * 0.85],
          ],
          width: 8,
          falloff: 14,
        },
      },
      height: [
        { noise: { path: 'hills' }, scale: 80 },
        {
          image: { path: 'valley' },
          at: [size * 0.6, size * 0.45],
          size: [size * 0.3, size * 0.22],
          rotation: 20,
          range: [0, -60],
          blend: 'add',
          falloff: 80,
        },
        { spline: 'road', mode: 'flatten' },
      ],
      layers: [{ name: 'grass' }, { name: 'rock', triplanar: true }, { name: 'gravel' }],
      paint: [
        { layer: 'grass' },
        { layer: 'rock', slope: [32, 90], blend: 6 },
        { layer: 'gravel', spline: 'road', blend: 2 },
      ],
    },
    heightmaps: { valley: { width: 64, height: 64, data: bowl } },
  }
}

/** The hills graph of the valley terrain (the playground's #heightfield page uses it too). */
export const VALLEY_HILLS = {
  output: 'h',
  nodes: {
    base: { fbm: { source: 'simplex', octaves: 6, frequency: 0.0012, seed: 1 } },
    ridges: { ridged: { source: 'simplex', octaves: 4, frequency: 0.005, seed: 2 } },
    h: { add: ['base', { multiply: ['ridges', 0.12] }] },
  },
}

/** What was drawn in one frame: rendered nodes (by key) and the morph camera. */
export interface DrawnFrame {
  nodes: Map<
    number,
    {
      depth: number
      x: number
      z: number
      locks: number[]
      mask: number
      fade: number
      anchored: boolean
    }
  >
  /** Camera position in the terrain's frame. */
  camera: number[]
  /** pixelsPerRadian / (errorPixels × lodBias): a depth's split distance per metre of error. */
  splitScale: number
  errors: Float32Array
}

export function snapshotDrawn(p: HeightfieldApp): DrawnFrame {
  const rt = p.runtime()
  const r = p.render()!
  const t = rt.tree
  const nodes: DrawnFrame['nodes'] = new Map()
  const g = new Float64Array(2)
  for (let i = 0; i < rt.selection.renderedCount; i++) {
    const n = rt.selection.rendered[i]!
    rt.grid.globalOf(t, n, g)
    const slot = t.slot[n]!
    nodes.set(nodeKey(t.depth[n]!, g[0]!, g[1]!), {
      depth: t.depth[n]!,
      x: g[0]!,
      z: g[1]!,
      locks: Array.from(t.locks.subarray(n * 4, n * 4 + 4)),
      mask: t.mask[n]!,
      fade: slot >= 0 ? r.table[slot * 4 + 2]! / 255 : 0,
      anchored: slot >= 0 && r.table[slot * 4 + 3]! >= 128,
    })
  }
  return {
    nodes,
    camera: Array.from(r.view.position),
    splitScale: r.camera[3]!,
    errors: Float32Array.from(rt.errors),
  }
}

/**
 * The drawn ground's height at terrain point (x, z) in a frame, as the vertex stage puts it: the
 * rendered node there, its page's heights morphed toward the parent level (odd vertices to their
 * even neighbors' average, odd-odd along the anti-diagonal) by distance, edge locks, quadrants and
 * fade, then the anti-diagonal triangle under the point. Undefined where nothing drawn covers it
 * or its page isn't in the CPU cache. `edge` skips points within a cell of a stitched edge (its
 * triangles are zipped, not quads).
 */
export function drawnHeightAt(
  rt: HeightfieldRuntime,
  f: DrawnFrame,
  x: number,
  z: number,
  skipStitched = true,
): number | undefined {
  const layout = rt.layout!
  for (let depth = layout.depth; depth >= 0; depth--) {
    const size = rt.nodeSize(depth)
    const nx = Math.floor(x / size)
    const nz = Math.floor(z / size)
    const node = f.nodes.get(nodeKey(depth, nx, nz))
    if (!node) continue
    const page = rt.pages?.get(nodeKey(depth, nx, nz))
    if (!page) return undefined
    const side = page.leaf ? LEAF_SIDE : SIDE
    const off = page.leaf ? 1 : 0
    const spacing = size / PAGE
    const fx = (x - nx * size) / spacing
    const fz = (z - nz * size) / spacing
    const ci = Math.min(PAGE - 1, Math.floor(fx))
    const cj = Math.min(PAGE - 1, Math.floor(fz))
    if (skipStitched) {
      const near = [cj === 0, ci === PAGE - 1, cj === PAGE - 1, ci === 0]
      for (let e = 0; e < 4; e++) if (near[e] && node.locks[e] === 1) return undefined
    }
    const h = (i: number, j: number) =>
      dequantize(page.heights[(j + off) * side + i + off]!, rt.lo, rt.hi)
    const vertex = (i: number, j: number) => {
      const own = h(i, j)
      const oi = (i & 1) === 1
      const oj = (j & 1) === 1
      const parent =
        oi && oj
          ? 0.5 * (h(i + 1, j - 1) + h(i - 1, j + 1))
          : oi
            ? 0.5 * (h(i - 1, j) + h(i + 1, j))
            : oj
              ? 0.5 * (h(i, j - 1) + h(i, j + 1))
              : own
      const wx = nx * size + i * spacing
      const wz = nz * size + j * spacing
      const split = depth === 0 || node.anchored ? 0 : f.errors[depth]! * f.splitScale
      const d = Math.hypot(wx - f.camera[0]!, own - f.camera[1]!, wz - f.camera[2]!)
      let t = morphFactor(d, split)
      const code = lockCode(
        i,
        j,
        PAGE + 1,
        i === 0 || j === 0 || i === PAGE || j === PAGE ? ringIndex(i, j) : PAGE * 4,
        PAGE * 4,
      )
      if (code >= 0 && code < 4) {
        const lock = node.locks[code]!
        if (lock >= 0) t = lock === 1 ? 1 : 0
      } else if (code >= 4 && node.mask !== 15) {
        const [qa, qb] = code === 5 ? [2, 3] : code === 6 ? [0, 2] : code === 7 ? [1, 3] : [0, 1]
        const differ = ((node.mask >> qa!) & 1) !== ((node.mask >> qb!) & 1)
        t = differ || (code === 8 && node.mask !== 0) ? 0 : Math.max(t, node.fade)
      } else t = Math.max(t, node.fade)
      return own + (parent - own) * t
    }
    const u = fx - ci
    const v = fz - cj
    const h00 = vertex(ci, cj)
    const h10 = vertex(ci + 1, cj)
    const h01 = vertex(ci, cj + 1)
    const h11 = vertex(ci + 1, cj + 1)
    return u + v <= 1
      ? h00 + u * (h10 - h00) + v * (h01 - h00)
      : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11)
  }
  return undefined
}

/** A border vertex's position in the ring (grid-mesh.ts chunkLayout's order). */
function ringIndex(i: number, j: number): number {
  const s = PAGE
  if (j === 0 && i < s) return i
  if (i === s && j < s) return s + j
  if (j === s && i > 0) return 2 * s + (s - i)
  return 3 * s + (s - j)
}

export interface HeightfieldWalk {
  /** FNV-1a over the characters' final terrain-frame positions (f64 bytes) and the tile count. */
  checksum: string
  walked: number[]
  /** The lowest the feet got under the collider surface (m, negative is below). */
  lowest: number
  tiles: number
  ms: number
}

/**
 * Drops `characters` capsules at deterministic points on the valley terrain and walks each for
 * `seconds` headless (no GPU, colliders only). Node (packages/terrain tests) and Chrome (the
 * playground's #heightfield page) must print the same checksum: the bake, the collider tiles and
 * physics are deterministic.
 */
export async function heightfieldWalk(
  characters = 4,
  seconds = 3,
  workers?: Workers,
): Promise<HeightfieldWalk> {
  const t0 = performance.now()
  await loadNoiseKernel()
  const hills = await NoiseGraph.create(VALLEY_HILLS)
  const p = await heightfieldApp(undefined, {
    ...valleySource(),
    noise: { hills },
    physics: true,
    ...(workers ? { workers } : {}),
  })
  const w = p.world
  const rt = p.runtime()
  const walked: number[] = []
  const bytes = new Uint8Array(characters * 24 + 4)
  const f64 = new Float64Array(bytes.buffer, 0, characters * 3)
  const p0 = new Float64Array(3)
  const pos = new Float64Array(3)
  let lowest = Infinity
  const ground = (x: number, z: number) => {
    const size = rt.layout!.leafSize
    const page = rt.pages!.leafNow(
      mainNoise(),
      rt.stack!,
      Math.floor(x / size),
      Math.floor(z / size),
    )
    return pageHeight(rt, page, x, z)
  }
  for (let k = 0; k < characters; k++) {
    const x = 200 + (hash32(71, k) / 2 ** 32) * 1600
    const z = 400 + (hash32(72, k) / 2 ** 32) * 1400
    const c = w.spawn(
      [CharacterController, { radius: 0.35, height: 1.8 }],
      [CharacterIntent, {}],
      [CharacterState, {}],
      Transform,
      FloatingOrigin,
    )
    placeInGrid(w, c, p.terrain, [x, ground(x, z) + 1.2, z])
    for (let f = 0; f < 60; f++) p.app.update(1 / 60)
    worldPosition64(w, c, p0, p.terrain)
    w.set(c, CharacterIntent, { move: [0, 0, -5] })
    for (let f = 0; f < seconds * 60; f++) {
      p.app.update(1 / 60)
      worldPosition64(w, c, pos, p.terrain)
      if (pos[0]! > 0 && pos[2]! > 0 && pos[0]! < 2048 && pos[2]! < 2048)
        lowest = Math.min(lowest, pos[1]! - 0.9 - ground(pos[0]!, pos[2]!))
    }
    walked.push(Math.hypot(pos[0]! - p0[0]!, pos[2]! - p0[2]!))
    f64.set(pos, k * 3)
    w.despawn(c)
  }
  const tiles = tilesOf(rt).tiles.size
  new DataView(bytes.buffer).setUint32(characters * 24, tiles, true)
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i]!, 0x01000193)
  await p.app.dispose()
  return {
    checksum: (hash >>> 0).toString(16).padStart(8, '0'),
    walked,
    lowest,
    tiles,
    ms: performance.now() - t0,
  }
}

/**
 * 0071's 16 km terrain at 1 m (benches only: about 600 MB of packs): the valley terrain's layers
 * spread over 16 km, with a 12 km road.
 */
export function openWorldSource() {
  const v = valleySource(16384, 1)
  const height = v.source.height as Record<string, unknown>[]
  height[0] = { noise: { path: 'hills' }, scale: 260 }
  return { ...v, source: { ...v.source, heightRange: [-300, 700] } }
}
