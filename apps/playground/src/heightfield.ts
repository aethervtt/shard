import { defineSystem, type Entity, quat, Update, type World } from '@aethervtt/shard-core'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import {
  AmbientLight,
  Camera3d,
  DebugOverlays,
  DirectionalLight,
  Exposure,
} from '@aethervtt/shard-render'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import {
  type HeightfieldRender,
  packHash,
  Terrain,
  TerrainBudget,
  TerrainSources,
  TerrainWorld,
} from '@aethervtt/shard-terrain'
import { sourceAsset, VALLEY_HILLS, valleySource } from '@aethervtt/shard-terrain/testing'
import { FloatingOrigin, Grid, lookAt, placeInGrid, Transform } from '@aethervtt/shard-transform'
import { hudExtras } from './hud'

/**
 * Heightfield terrain (spec 0071): a 2 km landscape at 0.5 m from a layer stack (hills, a valley
 * image, a road flattened through them and painted gravel), baked in memory on the worker pool
 * and streamed through the quadtree. W/S change speed, A/D turn, R/F pitch, L shades by depth, P
 * by page. The HUD prints the pack hash Node pins (packages/terrain heightfield tests), so the
 * bake is byte-identical in Chrome.
 */

/** The pack hash Node bakes for this terrain (packages/terrain heightfield/determinism.test.ts). */
export const NODE_PACK_HASH = '0bf43d2057b24cdb'
const SPEEDS = [0, 5, 20, 80, 300, 1000]

interface Demo {
  terrain: Entity
  camera: Entity
  position: Float64Array
  heading: number
  pitch: number
  gear: number
  keys: Set<string>
  hash: string
}

let demo: Demo | undefined

const forward = new Float64Array(3)

function ground(world: World, d: Demo): number {
  const rt = world.resource(TerrainWorld).heightfields.get(d.terrain)
  const page = rt?.pages
  if (!rt?.layout || !page) return 0
  // The finest page in the CPU cache under the camera.
  let best = 0
  for (const p of page.pages()) {
    const size = rt.nodeSize(p.depth)
    const x = d.position[0]! / size - p.x
    const z = d.position[2]! / size - p.z
    if (x < 0 || z < 0 || x > 1 || z > 1) continue
    const side = p.leaf ? 67 : 65
    const off = p.leaf ? 1 : 0
    const i = Math.round(x * 64) + off
    const j = Math.round(z * 64) + off
    best = rt.lo + (p.heights[j * side + i]! * (rt.hi - rt.lo)) / 65535
  }
  return best
}

export const flyHeightfield = defineSystem({
  name: 'heightfield-demo/fly',
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
    forward[0] = Math.sin(d.heading) * Math.cos(d.pitch)
    forward[1] = Math.sin(d.pitch)
    forward[2] = Math.cos(d.heading) * Math.cos(d.pitch)
    const speed = SPEEDS[d.gear]!
    for (let k = 0; k < 3; k++) d.position[k] = d.position[k]! + forward[k]! * speed * dt
    d.position[1] = Math.max(ground(world, d) + 1.7, d.position[1]!)
    placeInGrid(world, d.camera, d.terrain, d.position)
    const rotation = quat.lookRotation([0, 0, 0, 1], forward, [0, 1, 0]) as [
      number,
      number,
      number,
      number,
    ]
    world.set(d.camera, Transform, { ...world.get(d.camera, Transform), rotation })
  },
})

function toggle(world: World, name: string): void {
  const o = world.resource(DebugOverlays)
  o.extra[name] = !o.extra[name]
}

export const heightfieldDemoPlugin = definePlugin({
  name: 'heightfield-demo',
  build(app) {
    app.addSystems(Update, flyHeightfield)
    hudExtras.push((world) => {
      const d = demo
      if (!d) return []
      const rt = world.resource(TerrainWorld).heightfields.get(d.terrain)
      if (!rt?.ready || !rt.streaming)
        return [
          '',
          `terrain   ${rt?.problem?.message ?? `bake ${rt?.bake ?? 'starting'}${rt?.waiting ? `, waiting for ${rt.waiting}` : ''}`}`,
        ]
      const r = rt.parts.get('render') as HeightfieldRender | undefined
      let lo = 99
      let hi = 0
      for (let i = 0; i < rt.selection.renderedCount; i++) {
        const depth = rt.tree.depth[rt.selection.rendered[i]!]!
        lo = Math.min(lo, depth)
        hi = Math.max(hi, depth)
      }
      const budget = world.resource(TerrainBudget)
      const o = world.resource(DebugOverlays).extra
      return [
        '',
        `altitude  ${(d.position[1]! - ground(world, d)).toFixed(1)} m   speed ${SPEEDS[d.gear]} m/s`,
        `chunks    ${rt.selection.renderedCount} drawn, depth ${lo}–${hi} of ${rt.layout!.depth}, ${rt.selection.waiting} waiting`,
        `pages     ${r?.used ?? 0}/${budget.pages} in the pool, ${r?.stats.uploadedLastFrame ?? 0} uploaded, ${rt.pages?.pendingReads ?? 0} reading`,
        `bake      ${rt.lastBake ? `${rt.lastBake.blocks} blocks in ${Math.round(rt.lastBake.ms)} ms` : rt.bake}`,
        `packs     ${d.hash || 'hashing…'}`,
        'w/s speed  a/d turn  r/f pitch',
        `l lod ${o['terrain-lod'] ? 'on' : 'off'}  p pages ${o['terrain-pages'] ? 'on' : 'off'}`,
      ]
    })
  },
  async ready(app) {
    const world = app.world
    await loadNoiseKernel()
    const hills = await NoiseGraph.create(VALLEY_HILLS)
    const valley = valleySource()
    const asset = sourceAsset(world, { ...valley, noise: { hills } })
    const ref = world.initResource(TerrainSources).add(asset, 'valley.terrain.json')
    const terrain = world.spawn([Grid, { cellSize: 2000 }], [Terrain, { source: ref }], Transform)
    world.resource(AmbientLight).brightness = 1500
    world.spawn(
      [DirectionalLight, { illuminance: 100_000 }],
      [Transform, { rotation: lookAt([0, 0, 0], [-0.5, -0.6, -0.4]) }],
    )
    const camera = world.spawn(
      [Camera3d, { fovY: 60, near: 0.1, far: 20_000, clearColor: [0.45, 0.6, 0.85, 1] }],
      [Exposure, { ev100: 14.5 }],
      Transform,
      FloatingOrigin,
    )
    demo = {
      terrain,
      camera,
      position: new Float64Array([200, 600, 200]),
      heading: Math.PI / 4,
      pitch: -0.5,
      gear: 3,
      keys: new Set(),
      hash: '',
    }
    placeInGrid(world, camera, terrain, demo.position)
    Object.assign(globalThis, { heightfield: demo })
    // The pack hash once the bake is done (Node's must match).
    const poll = setInterval(() => {
      const rt = world.resource(TerrainWorld).heightfields.get(terrain)
      const files = (rt?.store as { files?: Map<string, Uint8Array> } | undefined)?.files
      if (!rt?.streaming || !files || !demo) return
      clearInterval(poll)
      void packHash(files).then((h) => {
        if (demo) {
          const short = h.slice(0, 16)
          demo.hash = `${short} ${short === NODE_PACK_HASH ? '= Node ✓' : `≠ Node ${NODE_PACK_HASH} ✗`}`
        }
      })
    }, 250)
    window.addEventListener('keydown', (e) => {
      const d = demo
      if (!d) return
      d.keys.add(e.code)
      if (e.code === 'KeyW') d.gear = Math.min(SPEEDS.length - 1, d.gear + 1)
      if (e.code === 'KeyS') d.gear = Math.max(0, d.gear - 1)
      if (e.code === 'KeyL') toggle(world, 'terrain-lod')
      if (e.code === 'KeyP') toggle(world, 'terrain-pages')
    })
    window.addEventListener('keyup', (e) => demo?.keys.delete(e.code))
  },
})
