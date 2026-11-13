import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { animationPlugin } from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import { NavAgent, NavTier } from '@aethervtt/shard-nav'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { Skins } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { CharacterTier, TierSource } from './components'
import { FIXTURE_PATHS, FIXTURES, fixtureProject, loadFixtureAssets } from './fixture-assets'
import { charactersPlugin } from './plugin'
import { createCharacterRig, type ShapeTable } from './rig'
import { jointEntityCount } from './rigs'
import { spawnCharacter } from './spawn'

async function server(serverRigs: boolean) {
  const root = fixtureProject()
  const app = new App().addPlugin(
    TransformPlugin,
    ScenePlugin,
    animationPlugin,
    charactersPlugin({ serverRigs }),
  )
  await app.init()
  const world = app.world
  world.initResource(Skins)
  const assets = assetServer(world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  await assets.scan()
  const fixture = await loadFixtureAssets(world, assets)
  for (const sub of assets.info(FIXTURE_PATHS.body).subAssets ?? []) {
    if (sub.type === 'Scene' || sub.type === 'Skin') await assets.load(sub.path)
  }
  const rig = createCharacterRig(world, {
    name: 'zombie',
    model: assets.resolve<'Scene'>(`${FIXTURE_PATHS.body}#Scene`)!,
    shapes: JSON.parse(readFileSync(join(FIXTURES, 'risen/body.json'), 'utf8')) as ShapeTable,
    clips: { walk: fixture.clips.walk.clip },
  })
  return { app, world, rig, root }
}

describe('characters on a headless server (0115)', () => {
  for (const serverRigs of [false, true]) {
    it(`tiers by player distance, no parts${serverRigs ? ', rigs near players' : ', no rigs'}`, async () => {
      const { app, world, rig, root } = await server(serverRigs)
      world.spawn([Transform, { translation: [0, 0, 0] }], [TierSource, { player: true }])
      const at = (d: number, pin = false) =>
        spawnCharacter(world, rig, { parts: [], pin, transform: { translation: [d, 0, 0] } })
      const near = at(10)
      const mid = at(50)
      const far = at(150)
      const pinned = at(400, true)
      for (let f = 0; f < 3; f++) app.update(1 / 60)
      const tier = (e: number) => world.get(e, CharacterTier)
      expect(tier(near).sim).toBe('near')
      expect(tier(mid).sim).toBe('mid')
      expect(tier(far).sim).toBe('far')
      expect(tier(near).tier).toBe(serverRigs ? 'near' : 'mid')
      expect(tier(pinned).tier).toBe(serverRigs ? 'near' : 'mid')
      expect(tier(far).tier).toBe('far')
      expect(jointEntityCount(world)).toBe(serverRigs ? 2 * 53 : 0)
      // Agents move by their sim tier: crowd near a player, steer further, coarse far away.
      for (const e of [near, mid, far]) world.add(e, NavAgent, {})
      app.update(1 / 60)
      expect([near, mid, far].map((e) => world.get(e, NavTier).tier)).toEqual([
        'crowd',
        'steer',
        'coarse',
      ])
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })
  }
})
