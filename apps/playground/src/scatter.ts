import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineSystem,
  type Entity,
  quat,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { loadNoiseKernel, NoiseGraph, NoiseGraphs } from '@aethervtt/shard-noise'
import { createWebWorkers } from '@aethervtt/shard-platform-web'
import { configureProcgenHost, warmGeneratorWorkers } from '@aethervtt/shard-procgen'
import {
  AmbientLight,
  Camera3d,
  DebugOverlays,
  DirectionalLight,
  Exposure,
  FoliageLayers,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { Prop, Scatter, ScatterSet } from '@aethervtt/shard-scatter'
import {
  FOREST_SET,
  GRASSLAND_SET,
  placementChecksum,
  ROCK_SET,
  scatterPlanet,
  settleScatter,
  TEST_CLIMATE,
  TEST_HEIGHT,
  TEST_RADIUS,
} from '@aethervtt/shard-scatter/testing'
import {
  Biome,
  BiomeSet,
  Planet,
  planetHeightAt,
  Terrain,
  TerrainAnchor,
} from '@aethervtt/shard-terrain'
import { FloatingOrigin, lookAt, placeInGrid, Transform } from '@aethervtt/shard-transform'
import { hudExtras } from './hud'
import { memoryPlatform } from './memory'

/**
 * Scatter (spec 0045) on a small planet with three biomes: grassland (grass, bushes, boulders),
 * forest (trees, undergrowth) and rock (boulders, crystals). Props are entities spawned around the
 * camera; grass is GPU foliage. Walk with W/S and A/D, R/F to rise and sink, O and C for the
 * scatter and foliage-chunk overlays. The HUD shows the headless placement checksum next to the
 * one Node pins (packages/scatter checksum.test.ts): the same props on every host.
 */

const NODE_CHECKSUM = '9acc927a'

interface Demo {
  planet: Entity
  camera: Entity
  position: Float64Array
  heading: number
  pitch: number
  keys: Set<string>
  checksum: string
  status: string
  landed: boolean
}

let demo: Demo | undefined

const up = new Float64Array(3)
const east = new Float64Array(3)
const north = new Float64Array(3)
const forward = new Float64Array(3)

function basis(d: Demo): void {
  const p = d.position
  const l = Math.hypot(p[0]!, p[1]!, p[2]!)
  for (let k = 0; k < 3; k++) up[k] = p[k]! / l
  east[0] = up[2]!
  east[1] = 0
  east[2] = -up[0]!
  const el = Math.hypot(east[0]!, east[2]!) || 1
  east[0] = east[0]! / el
  east[2] = east[2]! / el
  north[0] = up[1]! * east[2]! - up[2]! * east[1]!
  north[1] = up[2]! * east[0]! - up[0]! * east[2]!
  north[2] = up[0]! * east[1]! - up[1]! * east[0]!
  const ch = Math.cos(d.heading)
  const sh = Math.sin(d.heading)
  const cp = Math.cos(d.pitch)
  const sp = Math.sin(d.pitch)
  for (let k = 0; k < 3; k++) forward[k] = (north[k]! * ch + east[k]! * sh) * cp + up[k]! * sp
}

function ground(world: World, d: Demo, p: ArrayLike<number>): number {
  try {
    return planetHeightAt(world, d.planet, p)
  } catch {
    return 0
  }
}

const walk = defineSystem({
  name: 'scatter-demo/walk',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const dt = world.resource(Time).delta
    const held = (code: string) => d.keys.has(code)
    d.heading += ((held('KeyD') ? 1 : 0) - (held('KeyA') ? 1 : 0)) * 1.1 * dt
    basis(d)
    const speed = ((held('KeyW') ? 1 : 0) - (held('KeyS') ? 1 : 0)) * (held('ShiftLeft') ? 40 : 6)
    // Walk along the ground: the horizontal part of forward.
    for (let k = 0; k < 3; k++) {
      const h = (north[k]! * Math.cos(d.heading) + east[k]! * Math.sin(d.heading)) * speed * dt
      d.position[k] = d.position[k]! + h
    }
    const l = Math.hypot(d.position[0]!, d.position[1]!, d.position[2]!)
    let height = l - TEST_RADIUS - ground(world, d, d.position)
    // Start on the ground once the planet's heights are ready.
    if (!d.landed && world.resource(Terrain).planets.get(d.planet)?.ready) {
      d.landed = true
      height = 1.7
    }
    const climb = ((held('KeyR') ? 1 : 0) - (held('KeyF') ? 1 : 0)) * Math.max(4, height) * dt
    const r = TEST_RADIUS + ground(world, d, d.position) + Math.max(1.7, height + climb)
    for (let k = 0; k < 3; k++) d.position[k] = (d.position[k]! / l) * r
    placeInGrid(world, d.camera, d.planet, d.position)
    const rotation = quat.lookRotation([0, 0, 0, 1], forward, up) as [
      number,
      number,
      number,
      number,
    ]
    world.set(d.camera, Transform, { rotation })
  },
})

function toggle(world: World, name: string): void {
  const o = world.resource(DebugOverlays)
  o.extra[name] = !o.extra[name]
}

/** The test planet (its noise, three biomes and their sets) in this app, as the tests build it. */
async function start(world: World): Promise<void> {
  await loadNoiseKernel()
  const workers = createWebWorkers()
  configureProcgenHost({
    workers,
    workerModule: new URL('./procgen-worker.ts', import.meta.url).href,
  })
  await warmGeneratorWorkers()
  await assetServer(world).configure({ platform: memoryPlatform() }).scan()
  const graphs = world.initResource(NoiseGraphs)
  const sets = world.initResource(ScatterSet.store)
  const json = (ref: AssetRef) => ({ guid: ref.guid, path: ref.path })
  const set = (value: unknown, name: string) =>
    json(sets.add(ScatterSet.deserialize(value as never), name))
  const biomes = world.initResource(Biome.store)
  const biome = (value: Record<string, unknown>) =>
    json(biomes.add(Biome.deserialize(value as never)))
  const biomeSet = world.initResource(BiomeSet.store).add(
    BiomeSet.deserialize({
      biomes: [
        biome({
          moisture: [-2, 0.15],
          slope: [0, 24],
          tint: [0.32, 0.5, 0.18, 1],
          scatter: set(GRASSLAND_SET, 'grassland.scatter'),
        }),
        biome({
          moisture: [0.15, 2],
          slope: [0, 24],
          tint: [0.12, 0.3, 0.1, 1],
          scatter: set(FOREST_SET, 'forest.scatter'),
        }),
        biome({
          slope: [24, 90],
          tint: [0.42, 0.4, 0.37, 1],
          scatter: set(ROCK_SET, 'rocks.scatter'),
        }),
      ],
      latitudeBias: 0,
    } as never),
  )
  const planet = world.spawn(
    [
      Planet,
      {
        radius: TEST_RADIUS,
        heightScale: 250,
        height: graphs.add(NoiseGraph.fromJson(TEST_HEIGHT, { name: 'hills' }), 'hills'),
        climate: graphs.add(NoiseGraph.fromJson(TEST_CLIMATE, { name: 'climate' }), 'climate'),
        biomes: biomeSet as AssetRef<'terrain/BiomeSet'>,
        seed: 3,
        ocean: false,
      },
    ],
    Transform,
  )
  world.resource(AmbientLight).brightness = 2500
  world.spawn(
    [DirectionalLight, { illuminance: 60_000, shadows: true }],
    [Transform, { rotation: lookAt([0, 0, 0], [-0.4, -0.7, -0.5]) }],
  )
  const camera = world.spawn(
    [Camera3d, { fovY: 60, near: 0.05, clearColor: [0.45, 0.6, 0.85, 1] }],
    [Exposure, { ev100: 13.5 }],
    Transform,
    FloatingOrigin,
  )
  // The forest viewpoint the planet tests render.
  const a = 18 * 0.157
  const d = [Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3]
  const l = Math.hypot(d[0]!, d[1]!, d[2]!)
  const position = new Float64Array(d.map((x) => (x / l) * (TEST_RADIUS + 300)))
  demo = {
    planet,
    camera,
    position,
    heading: 0.8,
    pitch: -0.1,
    keys: new Set(),
    checksum: '',
    status: '',
    landed: false,
  }
  placeInGrid(world, camera, planet, position)
  Object.assign(globalThis, { scatter: demo })
  // The headless checksum (its own app, no GPU): Chrome must print the one Node pins.
  setTimeout(() => void checksum(), 1500)
}

async function checksum(): Promise<void> {
  try {
    const p = await scatterPlanet(undefined, memoryPlatform())
    for (const angle of [3, 18, 35]) {
      const a = angle * 0.157
      const d0 = [Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3]
      const l = Math.hypot(d0[0]!, d0[1]!, d0[2]!)
      const d = d0.map((x) => x / l)
      const h = planetHeightAt(p.world, p.planet, d)
      const anchor = p.world.spawn([TerrainAnchor, { radius: 60 }], Transform)
      placeInGrid(
        p.world,
        anchor,
        p.planet,
        d.map((x) => x * (TEST_RADIUS + h + 1)),
      )
    }
    await settleScatter(p)
    if (demo) demo.checksum = placementChecksum(p.world).checksum
    await p.app.dispose()
  } catch (err) {
    console.error(err)
    if (demo) demo.checksum = 'failed'
  }
}

export const scatterDemoPlugin = definePlugin({
  name: 'scatter-demo',
  build(app) {
    app.addSystems(Update, walk)
    hudExtras.push((world) => {
      const d = demo
      if (!d) return ['', 'scatter   starting workers…']
      const ss = world.resource(Scatter).surfaces.get(d.planet)
      let props = 0
      for (const t of world.query({ with: [Prop] }).tables) props += t.count
      let blades = 0
      let chunks = 0
      for (const layer of world.resource(FoliageLayers).layers) {
        chunks += layer.chunkCount
        for (const view of layer.views.keys()) blades += layer.visible(view).drawn
      }
      const height =
        Math.hypot(d.position[0]!, d.position[1]!, d.position[2]!) -
        TEST_RADIUS -
        ground(world, d, d.position)
      const o = world.resource(DebugOverlays).extra
      const sum = d.checksum
      return [
        '',
        `scatter   ${ss ? (ss.ready ? 'ready' : `waiting for ${ss.waiting ?? 'its sets'}`) : 'starting'}${ss?.problem ? ` (${ss.problem.message})` : ''}`,
        `props     ${props.toLocaleString()} live, ${ss?.spawnedLast ?? 0} spawned this frame`,
        `foliage   ${blades.toLocaleString()} clumps drawn, ${chunks} GPU chunks`,
        `height    ${height.toFixed(1)} m`,
        `placement ${sum === '' ? 'running headless…' : `${sum} ${sum === NODE_CHECKSUM ? '= Node ✓' : `≠ Node ${NODE_CHECKSUM} ✗`}`}`,
        'w/s walk (shift: run)  a/d turn  r/f rise/sink',
        `o scatter dots ${o.scatter ? 'on' : 'off'}  c foliage chunks ${o['foliage-chunks'] ? 'on' : 'off'}`,
      ]
    })
  },
  async ready(app) {
    const world = app.world
    addEventListener('keydown', (e) => {
      demo?.keys.add(e.code)
      if (e.code === 'KeyO') toggle(world, 'scatter')
      if (e.code === 'KeyC') toggle(world, 'foliage-chunks')
    })
    addEventListener('keyup', (e) => demo?.keys.delete(e.code))
    await start(world)
  },
})
