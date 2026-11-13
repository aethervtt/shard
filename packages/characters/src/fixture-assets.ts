/**
 * Test fixtures (Node only): Risen's MakeHuman body (`fixtures/risen/base.glb`) and three CMU
 * motion-capture clips (`fixtures/cmu/{walk,idle,attack}.glb`, a bare skeleton and one animation
 * each) with the joint map from the CMU skeleton onto the body's (`cmu-risen.jointmap.json`).
 * See `fixtures/README.md` for where they come from.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AnimationClips, animationPlugin } from '@aethervtt/shard-animation'
import { type AssetServer, assetServer } from '@aethervtt/shard-assets'
import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import { gltfPlugin } from '@aethervtt/shard-gltf'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { forwardPlugin, OffscreenTarget, renderPlugin, Skins } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { findEntityByPath, loadScene, type SceneEntity, ScenePlugin } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'

export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')

export const FIXTURE_CLIPS = ['walk', 'idle', 'attack'] as const
export type FixtureClip = (typeof FIXTURE_CLIPS)[number]

/** Project paths of the fixtures once `fixtureProject` copied them. */
export const FIXTURE_PATHS = {
  body: 'assets/risen/base.glb',
  map: 'assets/cmu/cmu-risen.jointmap.json',
  clip: (name: FixtureClip) => `assets/cmu/${name}.glb`,
} as const

/**
 * A new project directory under the OS temp dir with the body under `assets/risen/` and the clips
 * and joint map under `assets/cmu/` (with their `.meta` files). The caller removes it.
 */
export function fixtureProject(extra: Record<string, object> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shard-characters-'))
  const assets = join(root, 'assets')
  mkdirSync(join(assets, 'risen'), { recursive: true })
  for (const f of ['base.glb', 'base.glb.meta', 'body.json']) {
    cpSync(join(FIXTURES, 'risen', f), join(assets, 'risen', f))
  }
  cpSync(join(FIXTURES, 'cmu'), join(assets, 'cmu'), { recursive: true })
  for (const [path, json] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), JSON.stringify(json))
  }
  return root
}

/**
 * An app with transforms, render (offscreen, `size` px), scenes, animation, and the glTF importer,
 * scanning `root`.
 */
export async function startFixtureApp(
  gpu: GpuContext,
  root: string,
  size = 64,
): Promise<{ app: App; assets: AssetServer }> {
  const target = new OffscreenTarget(gpu, {
    label: 'characters-fixture',
    width: size,
    height: size,
  })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin(),
    ScenePlugin,
    animationPlugin,
    gltfPlugin,
  )
  await app.init()
  const assets = assetServer(app.world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  const report = await assets.scan()
  if (report.failed.length) throw new Error(JSON.stringify(report.failed))
  return { app, assets }
}

export interface FixtureClipAssets {
  /** The clip's `#AnimationClip` sub-asset path and its loaded handle. */
  clipPath: string
  clip: AssetRef<'AnimationClip'>
  /** The clip's skeleton (`#Skin`): Retarget's source. */
  skinPath: string
  skin: AssetRef<'Skin'>
  duration: number
}

export interface FixtureAssets {
  /** The body's skin: its joint paths under the body's instance. */
  bodySkin: AssetRef<'Skin'>
  clips: Record<FixtureClip, FixtureClipAssets>
}

function subAsset(assets: AssetServer, path: string, type: string): string {
  const sub = assets.info(path).subAssets?.find((a) => a.type === type)
  if (!sub) throw new Error(`${path} has no ${type}`)
  return sub.path
}

/** Loads the body's skin, every clip and its skin, and the joint map. */
export async function loadFixtureAssets(world: World, assets: AssetServer): Promise<FixtureAssets> {
  const bodySkinPath = subAsset(assets, FIXTURE_PATHS.body, 'Skin')
  await assets.load(bodySkinPath)
  await assets.load(FIXTURE_PATHS.map)
  const clips = {} as Record<FixtureClip, FixtureClipAssets>
  for (const name of FIXTURE_CLIPS) {
    const clipPath = subAsset(assets, FIXTURE_PATHS.clip(name), 'AnimationClip')
    const skinPath = subAsset(assets, FIXTURE_PATHS.clip(name), 'Skin')
    await assets.load(clipPath)
    await assets.load(skinPath)
    const clip = assets.resolve<'AnimationClip'>(clipPath)!
    clips[name] = {
      clipPath,
      clip,
      skinPath,
      skin: assets.resolve<'Skin'>(skinPath)!,
      duration: world.resource(AnimationClips).get(clip)!.duration,
    }
  }
  return { bodySkin: assets.resolve<'Skin'>(bodySkinPath)!, clips }
}

/**
 * A scene entity: the body (SceneInstance of base.glb) playing `clip` through Retarget
 * (rotation-and-root, align) with the CMU joint map, paused at `time`.
 */
export function fixtureBodyEntity(
  name: string,
  clip: FixtureClipAssets,
  options: { time?: number; translation?: number[] } = {},
): SceneEntity {
  return {
    name,
    components: {
      'core/Transform': { translation: options.translation ?? [0, 0, 0] },
      'scene/SceneInstance': { scene: { path: `${FIXTURE_PATHS.body}#Scene` } },
      'animation/AnimationPlayer': {
        layers: [{ clip: { path: clip.clipPath }, time: options.time ?? 0, playing: false }],
      },
      'animation/Retarget': {
        source: { path: clip.skinPath },
        map: { path: FIXTURE_PATHS.map },
        mode: 'rotation-and-root',
        align: true,
      },
    },
  }
}

/** Spawns `fixtureBodyEntity` in its own scene `id`; wait with `whenSceneReady(world, id)`. */
export function spawnFixtureBody(
  world: World,
  id: string,
  clip: FixtureClipAssets,
  options: { time?: number; translation?: number[] } = {},
): Entity {
  const { entities } = loadScene(
    world,
    { version: 1, entities: [fixtureBodyEntity('body', clip, options)] },
    { id },
  )
  return entities.get('body')!
}

/** The body's joint entities under an instance, by joint name (the last path segment). */
export function fixtureJoints(
  world: World,
  instance: string,
  bodySkin: AssetRef<'Skin'>,
): Map<string, Entity> {
  const skin = world.resource(Skins).get(bodySkin)
  if (!skin) throw new Error('the body skin is not loaded')
  const out = new Map<string, Entity>()
  for (const path of skin.joints) {
    const e = findEntityByPath(world, `${instance}/${path}`)
    if (e !== undefined) out.set(path.slice(path.lastIndexOf('/') + 1), e)
  }
  return out
}
