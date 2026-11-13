import { rmSync } from 'node:fs'
import { AnimationPlayer, animationLayer, animationPlugin } from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { Camera3d, forwardPlugin, OffscreenTarget, renderPlugin } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Character, CharacterTier, TierSource } from '../components'
import { spawnLook } from '../compose'
import { FIXTURE_PATHS, fixtureProject, loadFixtureAssets } from '../fixture-assets'
import { characterLooks } from '../looks'
import { charactersPlugin } from '../plugin'
import { createCharacterRig } from '../rig'
import { CharacterStates, partsOf } from '../spawn'
import { HordeProxy } from '../tiers'

let gpu: GpuContext | undefined
let root: string | undefined
let app: App | undefined

beforeAll(async () => {
  gpu = await createNodeGpuContext().catch(() => undefined)
})

afterAll(async () => {
  await app?.dispose()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('horde proxies and composed looks on the fixture rig (0115)', () => {
  it('never draws a proxy finer than far, and composes a replicated root from its look', {
    timeout: timeout(60_000),
  }, async () => {
    if (!gpu) return
    root = fixtureProject()
    const target = new OffscreenTarget(gpu, { label: 'hordes-test', width: 640, height: 360 })
    app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, target }),
      forwardPlugin(),
      ScenePlugin,
      animationPlugin,
      charactersPlugin({ dwell: 0 }),
    )
    await app.init()
    const world = app.world
    const assets = assetServer(world).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    await assets.scan()
    const fixture = await loadFixtureAssets(world, assets)
    for (const sub of assets.info(FIXTURE_PATHS.body).subAssets ?? []) await assets.load(sub.path)
    const model = assets.resolve<'Scene'>(`${FIXTURE_PATHS.body}#Scene`)!
    createCharacterRig(world, {
      name: 'zombie',
      model,
      clips: {
        walk: fixture.clips.walk.clip,
        idle: fixture.clips.idle.clip,
        attack: fixture.clips.attack.clip,
      },
      retarget: {
        source: fixture.clips.walk.skin,
        map: assets.resolve<'JointMap'>(FIXTURE_PATHS.map)!,
        mode: 'rotation-and-root',
        align: true,
      },
      far: { merge: ['body-*'] },
    })
    characterLooks(world, [{ rig: 'zombie', parts: partsOf(world, model) }])
    world.spawn(
      [Transform, { translation: [0, 1.5, 0] }],
      [Camera3d, { fovY: 60, near: 0.1, far: 2000 }],
      [TierSource, { viewer: true, player: true }],
    )
    const walk = [animationLayer(fixture.clips.walk.clip)]
    const plain = spawnLook(world, 0, { transform: { translation: [-0.6, 0, -3] } })
    const proxy = spawnLook(world, 0, { transform: { translation: [0.6, 0, -3] } })
    world.add(proxy, HordeProxy)
    world.set(plain, AnimationPlayer, { layers: walk })
    world.set(proxy, AnimationPlayer, { layers: walk })
    // A replicated root: Transform and Character with a look, nothing else.
    const replicated = world.spawn(
      [Transform, { translation: [0, 0, -6] }],
      [Character, { rig: 'zombie', build: 0, look: 0 }],
    )
    for (let f = 0; f < 4; f++) app.update(1 / 60)
    const states = world.resource(CharacterStates)
    expect(world.get(plain, CharacterTier).tier).toBe('near')
    // 3 m away and large on screen, still far: no rig, no pose range.
    expect(world.get(proxy, CharacterTier).tier).toBe('far')
    expect(states.get(proxy)!.rigInstance).toBeNull()
    expect(states.get(proxy)!.poseBase).toBe(-1)
    const composed = states.get(replicated)
    expect(composed).toBeDefined()
    expect(composed!.parts.length).toBe(partsOf(world, model).length)
    expect(world.get(replicated, Transform).translation).toEqual([0, 0, -6])
  })
})
