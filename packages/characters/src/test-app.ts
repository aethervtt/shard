/** A test app over the fixture project with the zombie rig (tests only; Node). */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AnimationPlayer, animationLayer, animationPlugin } from '@aethervtt/shard-animation'
import { type AssetServer, assetServer } from '@aethervtt/shard-assets'
import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { Camera3d, forwardPlugin, OffscreenTarget, renderPlugin } from '@aethervtt/shard-render'
import { App, type Plugin } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { TierSource } from './components'
import {
  FIXTURE_PATHS,
  FIXTURES,
  type FixtureAssets,
  fixtureProject,
  loadFixtureAssets,
} from './fixture-assets'
import { charactersPlugin } from './plugin'
import { type CharacterRig, createCharacterRig, type ShapeTable } from './rig'
import { partsOf, spawnCharacter } from './spawn'

export interface Ctx {
  app: App
  world: World
  assets: AssetServer
  fixture: FixtureAssets
  rig: CharacterRig
  model: AssetRef<'Scene'>
  camera: Entity
  root: string
}

/** An app with render, scenes, animation and characters over the fixture project, and its rig. */
export async function startCharacters(
  gpu: GpuContext,
  budget: Parameters<typeof charactersPlugin>[0] = {},
  size: [number, number] = [640, 360],
  plugins: Plugin[] = [],
): Promise<Ctx> {
  const root = fixtureProject()
  const target = new OffscreenTarget(gpu, {
    label: 'characters-test',
    width: size[0],
    height: size[1],
  })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin(),
    ScenePlugin,
    animationPlugin,
    charactersPlugin({ dwell: 0, ...budget }),
    ...plugins,
  )
  await app.init()
  const world = app.world
  const assets = assetServer(world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  const report = await assets.scan()
  if (report.failed.length) throw new Error(JSON.stringify(report.failed))
  const fixture = await loadFixtureAssets(world, assets)
  for (const sub of assets.info(FIXTURE_PATHS.body).subAssets ?? []) await assets.load(sub.path)
  const model = assets.resolve<'Scene'>(`${FIXTURE_PATHS.body}#Scene`)!
  const shapes = JSON.parse(readFileSync(join(FIXTURES, 'risen/body.json'), 'utf8')) as ShapeTable
  const rig = createCharacterRig(world, {
    name: 'zombie',
    model,
    shapes,
    builds: [
      { name: 'heavy', morphs: { 'weight-max': 1 } },
      { name: 'long-arms', morphs: { 'arms-long': 1 } },
    ],
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
    parts: {
      eyelashes: { minTier: 'near' },
      eyebrows: { minTier: 'mid' },
      eyes: { minTier: 'mid' },
    },
  })
  const camera = world.spawn(
    [Transform, { translation: [0, 1.5, 0] }],
    [Camera3d, { fovY: 60, near: 0.1, far: 2000 }],
    [TierSource, { viewer: true, player: true }],
  )
  const ctx = { app, world, assets, fixture, rig, model, camera, root }
  return ctx
}

/** A character `d` metres in front of the camera (which looks down -Z), walking. */
export function zombie(
  c: Ctx,
  d: number,
  options: { build?: string; morphs?: Record<string, number>; x?: number } = {},
) {
  const e = spawnCharacter(c.world, c.rig, {
    parts: partsOf(c.world, c.model),
    build: options.build,
    morphs: options.morphs,
    transform: { translation: [options.x ?? 0, 0, -d] },
  })
  c.world.set(e, AnimationPlayer, {
    layers: [animationLayer(c.fixture.clips.walk.clip, { time: 0.37 })],
  })
  return e
}

/** Disposes the app and removes its project directory. */
export async function stopCharacters(c: Ctx): Promise<void> {
  await c.app.dispose()
  rmSync(c.root, { recursive: true, force: true })
}
