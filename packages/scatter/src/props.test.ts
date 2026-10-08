import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import { ChildOf, type Entity, type World } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { plane } from '@aethervtt/shard-mesh'
import { loadNoiseKernel, NoiseGraph, NoiseGraphs } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import { Camera3d, Mesh3d, Meshes } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { captureGame, loadGame, savePlugin } from '@aethervtt/shard-save'
import { SceneIndex, ScenePlugin } from '@aethervtt/shard-scene'
import { Planet, planetHeightAt, terrainPlugin } from '@aethervtt/shard-terrain'
import {
  Grid,
  placeInGrid,
  Transform,
  TransformPlugin,
  worldPosition64,
} from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isRemoved,
  Prop,
  propIdentity,
  Removed,
  removedKey,
  ScatterChunk,
  ScatterSurface,
} from './components'
import { scatterPlugin } from './plugin'
import { Scatter } from './runtime'
import { ScatterSet } from './set'

const R = 600_000
const DT = 1 / 60
const roots: string[] = []

let graph: NoiseGraph

beforeAll(async () => {
  await loadNoiseKernel()
  graph = await NoiseGraph.create({
    output: 'h',
    nodes: { h: { fbm: { source: 'simplex', octaves: 4, frequency: 1e-3, seed: 3 } } },
  })
})

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const SET = {
  rules: [
    {
      name: 'boulders',
      items: [{ generator: 'shard/Rock', params: { detail: 2 }, variants: 3 }],
      density: 0.004,
      spacing: 6,
      align: 0.7,
      scale: [0.6, 1.6],
      sink: 0.2,
      collider: 'ball',
      range: 250,
    },
    {
      name: 'bushes',
      items: [{ generator: 'shard/Bush', params: { stems: 3 }, variants: 2 }],
      density: 0.02,
      spacing: 2,
      avoid: ['boulders'],
      range: 120,
    },
  ],
}

interface Scene {
  app: App
  world: World
  planet: Entity
  camera: Entity
}

async function scene(): Promise<Scene> {
  const root = mkdtempSync(join(tmpdir(), 'shard-scatter-'))
  roots.push(root)
  const app = new App().addPlugin(
    TransformPlugin,
    terrainPlugin(),
    ScenePlugin,
    procgenPlugin(),
    scatterPlugin(),
    savePlugin(),
  )
  await app.init()
  await assetServer(app.world)
    .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
    .scan()
  const w = app.world
  const height = w.initResource(NoiseGraphs).add(graph, 'hills')
  const scatter = w.initResource(ScatterSet.store).add(ScatterSet.deserialize(SET as never), 'set')
  const planet = w.spawn(
    [Grid, { cellSize: 2000 }],
    [Planet, { radius: R, height, heightScale: 120, seed: 5, ocean: false, scatter }],
    Transform,
  )
  app.update(DT)
  const camera = w.spawn([Camera3d, {}], Transform)
  moveTo(w, planet, camera, [0.3, 0.9, 0.2])
  return { app, world: w, planet, camera }
}

/** Puts the camera 2 m above the ground in `direction`. */
function moveTo(w: World, planet: Entity, camera: Entity, direction: number[]): void {
  const l = Math.hypot(direction[0]!, direction[1]!, direction[2]!)
  const d = direction.map((x) => x / l)
  const h = planetHeightAt(w, planet, d)
  placeInGrid(
    w,
    camera,
    planet,
    d.map((x) => x * (R + h + 2)),
  )
}

/** Steps until `done` or the deadline (generation is async: meshes come from the procgen runtime). */
async function until(app: App, done: () => boolean, frames = 600): Promise<void> {
  for (let i = 0; i < frames && !done(); i++) {
    app.update(DT)
    await new Promise((r) => setTimeout(r, 1))
  }
}

/** Steps until no surface spawned or despawned anything for a few frames (the budget spreads it). */
async function settleProps(app: App): Promise<void> {
  let quiet = 0
  for (let i = 0; i < 600 && quiet < 3; i++) {
    app.update(DT)
    await new Promise((r) => setTimeout(r, 1))
    let busy = false
    for (const ss of app.world.resource(Scatter).surfaces.values())
      if (!ss.ready || ss.spawnedLast > 0 || ss.despawnedLast > 0) busy = true
    quiet = busy ? 0 : quiet + 1
  }
}

function props(w: World): Entity[] {
  const out: Entity[] = []
  for (const table of w.query({ with: [Prop] }).tables)
    for (let row = 0; row < table.count; row++) out.push(table.entities[row]!)
  return out
}

describe('props on a planet', () => {
  it('spawn around the camera, avoid boulders, and despawn out of range', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world: w, planet, camera } = await scene()
    await until(app, () => props(w).length > 0 && w.resource(Scatter).surfaces.get(planet)!.ready)
    await settleProps(app)
    const ss = w.resource(Scatter).surfaces.get(planet)!
    expect(ss.problem).toBeNull()
    const all = props(w)
    const boulders = all.filter((e) => propIdentity(w, e)!.rule.endsWith(':boulders'))
    const bushes = all.filter((e) => propIdentity(w, e)!.rule.endsWith(':bushes'))
    expect(boulders.length).toBeGreaterThan(20)
    expect(bushes.length).toBeGreaterThan(50)
    expect(w.has(boulders[0]!, Mesh3d)).toBe(true)
    // Every prop is under a chunk root under the planet.
    const parent = w.get(all[0]!, ChildOf).parent!
    expect(w.has(parent, ScatterChunk)).toBe(true)
    expect(w.get(parent, ChildOf).parent).toBe(planet)
    // Bushes keep out of boulders' footprints.
    expect(ss.stats[1]!.spawned).toBe(bushes.length)
    // Far away: everything here despawns.
    const chunk = propIdentity(w, boulders[0]!)!.chunk
    moveTo(w, planet, camera, [-0.5, 0.2, 0.8])
    for (let i = 0; i < 4; i++) app.update(DT)
    expect(props(w).filter((e) => propIdentity(w, e)!.chunk === chunk)).toHaveLength(0)
    expect(w.isAlive(boulders[0]!)).toBe(false)
  })

  it('remembers a removed prop: after walking away and back, and through a save', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world: w, planet, camera } = await scene()
    await until(app, () => props(w).length > 0)
    await settleProps(app)
    const victim = props(w)[0]!
    const p = propIdentity(w, victim)!
    const key = removedKey(p.rule, p.chunk, p.index)
    w.despawn(victim)
    app.update(DT)
    expect(isRemoved(w.resource(Removed), key)).toBe(true)
    const count = props(w).length
    moveTo(w, planet, camera, [-0.5, 0.2, 0.8])
    for (let i = 0; i < 4; i++) app.update(DT)
    moveTo(w, planet, camera, [0.3, 0.9, 0.2])
    await until(app, () => props(w).length >= count)
    await settleProps(app)
    const same = (e: Entity) => {
      const q = propIdentity(w, e)!
      return q.rule === p.rule && q.chunk === p.chunk && q.index === p.index
    }
    expect(props(w).some(same)).toBe(false)
    expect(props(w).length).toBe(count)
    // The save holds the removal, and nothing about props themselves.
    const save = captureGame(w)
    expect(JSON.stringify(save)).not.toContain('scatter/Prop')
    const other = await scene()
    other.world.initResource(SceneIndex)
    await loadGame(other.world, save)
    expect(isRemoved(other.world.resource(Removed), key)).toBe(true)
  })
})

describe('props on a mesh (ScatterSurface)', () => {
  it('places the same set on a flat plane, standing on it, within range of the camera', {
    timeout: timeout(60_000),
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-scatter-'))
    roots.push(root)
    const app = new App().addPlugin(TransformPlugin, ScenePlugin, procgenPlugin(), scatterPlugin())
    await app.init()
    await assetServer(app.world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      .scan()
    const w = app.world
    const set = w.initResource(ScatterSet.store).add(ScatterSet.deserialize(SET as never), 'set')
    const mesh = w.initResource(Meshes).add(plane({ size: 1, subdivisions: 4 }), 'plane')
    // A unit plane scaled to 600 m, lifted 5 m: placement works in the surface's metres.
    const ground = w.spawn(
      [Mesh3d, { mesh }],
      [ScatterSurface, { set, seed: 3 }],
      [Transform, { translation: [0, 5, 0], scale: [600, 600, 600] }],
    )
    w.spawn([Camera3d, {}], [Transform, { translation: [20, 7, -10] }])
    await until(app, () => props(w).length > 0)
    await settleProps(app)
    const all = props(w)
    expect(all.length).toBeGreaterThan(30)
    const p = new Float64Array(3)
    for (const e of all) {
      worldPosition64(w, e, p)
      // Within range (250 m for boulders, plus a chunk), and on the plane (sunk a little).
      expect(Math.hypot(p[0]! - 20, p[2]! + 10)).toBeLessThan(250 * 1.15 + 120)
      expect(p[1]!).toBeLessThanOrEqual(5.0001)
      expect(p[1]!).toBeGreaterThan(3)
      expect(w.get(e, Transform).scale[0]).toBeGreaterThan(0.5)
    }
    expect(w.resource(Scatter).surfaces.get(ground)!.problem).toBeNull()
  })
})
