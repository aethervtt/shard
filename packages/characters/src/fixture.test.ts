import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnimationPlayer, describePlayer } from '@aethervtt/shard-animation'
import { type Entity, quat, type World } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { captureView } from '@aethervtt/shard-render'
import { pngBytes, settle } from '@aethervtt/shard-render/testing'
import type { App } from '@aethervtt/shard-runtime'
import { LogResource } from '@aethervtt/shard-runtime'
import { loadScene, unloadScene, whenSceneReady } from '@aethervtt/shard-scene'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FIXTURE_CLIPS,
  type FixtureAssets,
  fixtureJoints,
  fixtureProject,
  loadFixtureAssets,
  spawnFixtureBody,
  startFixtureApp,
} from './fixture-assets'

// `SHARD_FIXTURE_SHOTS=<dir>` writes one frame of each clip, mid-way, as a PNG there.
const SHOTS = process.env.SHARD_FIXTURE_SHOTS
const SIZE = SHOTS ? 384 : 64

const FEET = ['foot_l', 'foot_r', 'ball_l', 'ball_r'] as const

let gpu: GpuContext
let app: App
let fx: FixtureAssets
let root: string
/** Rest heights (world y) of the body's foot joints. */
const restHeight = new Map<string, number>()

function position(world: World, e: Entity): [number, number, number] {
  const m = world.get(e, GlobalTransform).matrix
  return [m[3]!, m[7]!, m[11]!]
}

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  root = fixtureProject({
    'materials/ground.material.json': { baseColor: [0.5, 0.52, 0.55, 1], roughness: 0.9 },
  })
  const started = await startFixtureApp(gpu, root, SIZE)
  app = started.app
  fx = await loadFixtureAssets(app.world, started.assets)
  // The body at rest (no player), for the foot joints' heights.
  loadScene(
    app.world,
    {
      version: 1,
      entities: [
        {
          name: 'rest',
          components: {
            'core/Transform': {},
            'scene/SceneInstance': { scene: { path: 'assets/risen/base.glb#Scene' } },
          },
        },
      ],
    },
    { id: 'rest' },
  )
  await whenSceneReady(app.world, 'rest')
  app.update(1 / 60)
  const joints = fixtureJoints(app.world, 'rest:rest', fx.bodySkin)
  for (const name of FEET) restHeight.set(name, position(app.world, joints.get(name)!)[1])
  unloadScene(app.world, 'rest')
}, timeout(60_000))

afterAll(() => {
  gpu?.destroy()
  if (root) rmSync(root, { recursive: true, force: true })
})

const lookAt = (eye: number[], target: number[]) => {
  const d = [target[0]! - eye[0]!, target[1]! - eye[1]!, target[2]! - eye[2]!]
  return [...quat.lookRotation([0, 0, 0, 1], d, [0, 1, 0])]
}

async function shoot(name: string, time: number): Promise<void> {
  if (!SHOTS) return
  const w = app.world
  const eye = [2.2, 1.3, 2.6]
  const { entities } = loadScene(
    w,
    {
      version: 1,
      resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 1500 } },
      entities: [
        {
          name: 'sun',
          components: {
            'render/DirectionalLight': { illuminance: 'daylight', shadows: true },
            'core/Transform': { rotationEuler: [-55, -35, 0] },
          },
        },
        {
          name: 'ground',
          components: {
            'core/Transform': {},
            'render/Mesh3d': { mesh: { path: 'procedural:plane?size=6' } },
            'render/MeshMaterial': { material: { path: 'materials/ground.material.json' } },
          },
        },
        {
          name: 'camera',
          components: {
            'render/Camera3d': { fovY: 40 },
            'core/Transform': { translation: eye, rotation: lookAt(eye, [0, 0.85, 0]) },
          },
        },
      ],
    },
    { id: 'stage' },
  )
  await whenSceneReady(w, 'stage')
  await settle(app)
  const shot = captureView(w, `camera:${entities.get('camera')!}`)
  app.update(1 / 60)
  const image = await shot
  mkdirSync(SHOTS, { recursive: true })
  const file = join(SHOTS, `${name}-${time.toFixed(2)}s.png`)
  writeFileSync(file, pngBytes(image.data, image.width, image.height))
  unloadScene(w, 'stage')
}

describe('CMU clips on the Risen body (Retarget rotation-and-root, align)', () => {
  for (const name of FIXTURE_CLIPS) {
    it(
      `${name}: feet on the ground, pelvis at standing height, nothing flies off`,
      async () => {
        const w = app.world
        const clip = fx.clips[name]
        const id = `clip-${name}`
        const body = spawnFixtureBody(w, id, clip)
        await whenSceneReady(w, id)
        app.update(1 / 60)
        const d = describePlayer(w, body)
        expect(d.retarget!.problem).toBeNull()
        const joints = fixtureJoints(w, `${id}:body`, fx.bodySkin)
        expect(joints.size).toBe(53)
        const pelvis = joints.get('pelvis')!
        const head = joints.get('head')!
        const frames = Math.round(clip.duration * 30)
        let lowestContact = Number.POSITIVE_INFINITY
        let highestContact = Number.NEGATIVE_INFINITY
        let pelvisMin = Number.POSITIVE_INFINITY
        let pelvisMax = Number.NEGATIVE_INFINITY
        let farthest = 0
        let toesForward = 0
        for (let k = 0; k <= frames; k++) {
          const layers = w.get(body, AnimationPlayer).layers
          layers[0]!.time = (k * clip.duration) / frames
          w.set(body, AnimationPlayer, { layers })
          app.update(1 / 60)
          const origin = position(w, body)
          // Contact: the lowest foot joint relative to its rest height. Through a stance phase it
          // sits near rest; no foot joint sinks into the ground.
          let contact = Number.POSITIVE_INFINITY
          for (const f of FEET) {
            const dy = position(w, joints.get(f)!)[1] - restHeight.get(f)!
            contact = Math.min(contact, dy)
          }
          lowestContact = Math.min(lowestContact, contact)
          highestContact = Math.max(highestContact, contact)
          const p = position(w, pelvis)
          pelvisMin = Math.min(pelvisMin, p[1])
          pelvisMax = Math.max(pelvisMax, p[1])
          expect(position(w, head)[1]).toBeGreaterThan(p[1] + 0.4)
          for (const e of joints.values()) {
            const q = position(w, e)
            farthest = Math.max(
              farthest,
              Math.sqrt(
                (q[0] - origin[0]) ** 2 + (q[1] - origin[1]) ** 2 + (q[2] - origin[2]) ** 2,
              ),
            )
          }
          for (const side of ['l', 'r']) {
            toesForward +=
              position(w, joints.get(`ball_${side}`)!)[2] -
              position(w, joints.get(`foot_${side}`)!)[2]
          }
        }
        expect(lowestContact).toBeGreaterThan(-0.05)
        expect(highestContact).toBeLessThan(0.05)
        expect(pelvisMin).toBeGreaterThan(0.75)
        expect(pelvisMax).toBeLessThan(1.0)
        expect(farthest).toBeLessThan(2)
        // Facing +Z: the balls of the feet are in front of the ankles.
        expect(toesForward / (2 * (frames + 1))).toBeGreaterThan(0.05)
        expect(w.resource(LogResource).errors()).toEqual([])

        const mid = clip.duration / 2
        const layers = w.get(body, AnimationPlayer).layers
        layers[0]!.time = mid
        w.set(body, AnimationPlayer, { layers })
        await shoot(name, mid)
        unloadScene(w, id)
      },
      timeout(60_000),
    )
  }
})
