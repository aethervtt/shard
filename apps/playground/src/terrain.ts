import { defineSystem, type Entity, quat, Update, type World } from '@shard/core'
import { loadNoiseKernel, NoiseGraph, NoiseGraphs } from '@shard/noise'
import { AmbientLight, Camera3d, DebugOverlays, DirectionalLight, Exposure } from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import {
  Biome,
  BiomeSet,
  Planet,
  type PlanetRender,
  planetHeightAt,
  Terrain,
  TerrainBudget,
} from '@shard/terrain'
import { walkChecksum } from '@shard/terrain/testing'
import { FloatingOrigin, lookAt, placeInGrid, Transform } from '@shard/transform'
import { hudExtras } from './hud'

/**
 * Planet terrain (spec 0043): an Earth-sized planet with continents, mountains, biomes, and an
 * ocean, from orbit to the ground. The camera flies in the planet's grid as the floating origin;
 * chunks are generated on the GPU within TerrainBudget. L shades chunks by LOD depth, B by biome, E
 * edits the height graph (everything visible regenerates together), and the HUD shows the headless
 * walk checksum next to the one Node pins (packages/terrain walk.test.ts).
 */

const R = 6_371_000
const NODE_CHECKSUM = '0da23929'
const SPEEDS = [0, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 3_000_000]

const planetGraph = (ridges: number) => ({
  output: 'h',
  nodes: {
    continents: { fbm: { source: 'simplex', octaves: 7, frequency: 2.5e-7, seed: 4 } },
    mountains: { ridged: { source: 'simplex', octaves: 8, frequency: 2e-5, seed: 5 } },
    hills: { fbm: { source: 'simplex', octaves: 6, frequency: 1.5e-3, seed: 6 } },
    h: {
      add: [
        { add: ['continents', 0.08] },
        { multiply: ['mountains', ridges] },
        { multiply: ['hills', 0.01] },
      ],
    },
  },
})

const CLIMATE = {
  output: 'temperature',
  nodes: {
    temperature: { add: [{ fbm: { octaves: 3, frequency: 4e-7, seed: 7 } }, 0.6] },
    moisture: { fbm: { octaves: 3, frequency: 6e-7, seed: 8 } },
  },
}

interface Demo {
  planet: Entity
  camera: Entity
  height: NoiseGraph
  ridges: number
  /** Planet-frame position (f64), heading and pitch in the local tangent frame (radians). */
  position: Float64Array
  heading: number
  pitch: number
  gear: number
  keys: Set<string>
  checksum: string
}

let demo: Demo | undefined

const up = new Float64Array(3)
const east = new Float64Array(3)
const north = new Float64Array(3)
const forward = new Float64Array(3)

/** The camera's basis at its position: up radial, forward from heading (from north) and pitch. */
function basis(d: Demo): void {
  const p = d.position
  const l = Math.hypot(p[0]!, p[1]!, p[2]!)
  up[0] = p[0]! / l
  up[1] = p[1]! / l
  up[2] = p[2]! / l
  // East: the pole axis (+Y) × up, then north = up × east.
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

/** Ground height under a planet-frame point (sea level while the planet's graphs load). */
function ground(world: World, d: Demo, p: ArrayLike<number>): number {
  if (!world.resource(Terrain).planets.get(d.planet)?.ready) return 0
  return Math.max(0, planetHeightAt(world, d.planet, p))
}

function altitude(world: World, d: Demo): number {
  const l = Math.hypot(d.position[0]!, d.position[1]!, d.position[2]!)
  return l - R - ground(world, d, d.position)
}

const fly = defineSystem({
  name: 'terrain-demo/fly',
  run: (_, world) => {
    const d = demo
    if (!d) return
    const dt = world.resource(Time).delta
    const held = (code: string) => d.keys.has(code)
    d.heading += ((held('KeyD') ? 1 : 0) - (held('KeyA') ? 1 : 0)) * 0.9 * dt
    d.pitch = Math.max(
      -1.5,
      Math.min(1.5, d.pitch + ((held('KeyR') ? 1 : 0) - (held('KeyF') ? 1 : 0)) * 0.7 * dt),
    )
    basis(d)
    // Never faster than the altitude allows (a second to the ground), never into it.
    const alt = altitude(world, d)
    const speed = Math.min(SPEEDS[d.gear]!, Math.max(5, alt * 1.5))
    for (let k = 0; k < 3; k++) d.position[k] = d.position[k]! + forward[k]! * speed * dt
    if (altitude(world, d) < 1.7) {
      const l = Math.hypot(d.position[0]!, d.position[1]!, d.position[2]!)
      const r = R + ground(world, d, d.position) + 1.7
      for (let k = 0; k < 3; k++) d.position[k] = (d.position[k]! / l) * r
    }
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

export const terrainDemoPlugin = definePlugin({
  name: 'terrain-demo',
  build(app) {
    app.addSystems(Update, fly)
    hudExtras.push((world) => {
      const d = demo
      if (!d) return []
      const rt = world.resource(Terrain).planets.get(d.planet)
      if (!rt?.ready) return ['', `planet    waiting for ${rt?.waiting ?? 'its runtime'}`]
      const pr = rt.parts.get('render') as PlanetRender | undefined
      let lo = 99
      let hi = 0
      for (let i = 0; i < rt.selection.renderedCount; i++) {
        const depth = rt.tree.depth[rt.selection.rendered[i]!]!
        lo = Math.min(lo, depth)
        hi = Math.max(hi, depth)
      }
      const alt = altitude(world, d)
      const speed = Math.min(SPEEDS[d.gear]!, Math.max(5, alt * 1.5))
      const km = (m: number) =>
        m >= 1000
          ? `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`
          : `${m.toFixed(1)} m`
      const budget = world.resource(TerrainBudget)
      const o = world.resource(DebugOverlays).extra
      const sum = d.checksum
      return [
        '',
        `altitude  ${km(alt)}   speed ${km(speed)}/s (gear ${d.gear})`,
        `chunks    ${rt.selection.renderedCount} drawn, depth ${lo}–${hi} of ${rt.maxDepth}, ${rt.oceanSelection.renderedCount} ocean`,
        `generate  ${pr?.stats.lastFrameJobs ?? 0}/${budget.chunksPerFrame} this frame, ${pr?.stats.generated ?? 0} total, ${pr?.slots.length ?? 0}/${budget.pool} slots`,
        `graph     v${rt.version}, ridges ${d.ridges}`,
        `walk      ${sum === '' ? 'running headless walk…' : `${sum} ${sum === NODE_CHECKSUM ? '= Node ✓' : `≠ Node ${NODE_CHECKSUM} ✗`}`}`,
        'w/s speed  a/d turn  r/f pitch',
        `l lod ${o['terrain-lod'] ? 'on' : 'off'}  b biomes ${o['terrain-biomes'] ? 'on' : 'off'}  e edit the height graph`,
      ]
    })
  },
  async ready(app) {
    const world = app.world
    await loadNoiseKernel()
    const graphs = world.initResource(NoiseGraphs)
    const height = NoiseGraph.fromJson(planetGraph(0.3), { name: 'planet' })
    const climate = NoiseGraph.fromJson(CLIMATE, { name: 'climate' })
    const biomes = world.initResource(Biome.store)
    const make = (name: string, v: Partial<ReturnType<typeof Biome.defaults>>) =>
      biomes.add({ ...Biome.defaults(), ...v }, name)
    const warm = [-0.35, 3] as [number, number]
    const flat = [0, 28] as [number, number]
    const set = world.initResource(BiomeSet.store).add(
      {
        ...BiomeSet.defaults(),
        biomes: [
          make('grass', {
            temperature: warm,
            moisture: [-2, 0.1],
            slope: flat,
            tint: [0.25, 0.5, 0.15, 1],
          }),
          make('beach', {
            temperature: warm,
            height: [-400, 30],
            slope: flat,
            tint: [0.8, 0.72, 0.5, 1],
          }),
          make('forest', {
            temperature: warm,
            moisture: [0.1, 2],
            slope: flat,
            tint: [0.08, 0.3, 0.08, 1],
          }),
          make('rock', { temperature: warm, slope: [28, 90], tint: [0.35, 0.33, 0.3, 1] }),
          make('snow', { temperature: [-3, -0.35], tint: [0.95, 0.95, 1, 1], blend: 0.05 }),
        ],
        latitudeBias: 1.2,
        snowLine: 9000,
      },
      'planet',
    )
    const planet = world.spawn(
      [
        Planet,
        {
          radius: R,
          heightScale: 6000,
          height: graphs.add(height, 'planet'),
          climate: graphs.add(climate, 'climate'),
          biomes: set,
          ocean: true,
          seaLevel: 0,
        },
      ],
      Transform,
    )
    world.resource(AmbientLight).brightness = 800
    world.spawn(
      [DirectionalLight, { illuminance: 100_000 }],
      [Transform, { rotation: lookAt([0, 0, 0], [-0.5, -0.4, -0.75]) }],
    )
    const camera = world.spawn(
      [Camera3d, { fovY: 60, near: 0.1, clearColor: [0.01, 0.015, 0.03, 1] }],
      [Exposure, { ev100: 14.5 }],
      Transform,
      FloatingOrigin,
    )
    // Start in orbit over the day side, looking down at the horizon.
    const start = [-0.45, 0.35, 0.82].map(
      (v, _, a) => (v / Math.hypot(a[0]!, a[1]!, a[2]!)) * R * 3,
    )
    demo = {
      planet,
      camera,
      height,
      ridges: 0.3,
      position: new Float64Array(start),
      heading: 0,
      pitch: -1.2,
      gear: 6,
      keys: new Set(),
      checksum: '',
    }
    placeInGrid(world, camera, planet, demo.position)
    window.addEventListener('keydown', (e) => {
      const d = demo
      if (!d) return
      d.keys.add(e.code)
      if (e.code === 'KeyW') d.gear = Math.min(SPEEDS.length - 1, d.gear + 1)
      if (e.code === 'KeyS') d.gear = Math.max(0, d.gear - 1)
      if (e.code === 'KeyL') toggle(world, 'terrain-lod')
      if (e.code === 'KeyB') toggle(world, 'terrain-biomes')
      if (e.code === 'KeyE') {
        // What the asset server does when a .noise.json changes: the graph updates in place.
        d.ridges = d.ridges === 0.3 ? 0.6 : 0.3
        d.height.copyFrom(NoiseGraph.fromJson(planetGraph(d.ridges), { name: 'planet' }))
      }
    })
    window.addEventListener('keyup', (e) => demo?.keys.delete(e.code))
    // The headless walk (its own app, no GPU): Chrome must print the checksum Node pins.
    setTimeout(() => {
      walkChecksum().then(
        (r) => {
          if (demo) demo.checksum = r.checksum
        },
        (err) => {
          console.error(err)
          if (demo) demo.checksum = 'failed'
        },
      )
    }, 500)
  },
})
