import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetServer } from '@aethervtt/shard-assets'
import { AudioClips, AudioEvent } from '@aethervtt/shard-audio'
import { World } from '@aethervtt/shard-core'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { expect, it } from 'vitest'
import { DiceEffectRecipe } from './effects'
import { DiceSkin } from './skin'
import { wavBytes } from './sound'

it('loads skin and recipe documents without eagerly loading their audio dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shard-dice-audio-'))
  try {
    mkdirSync(join(root, 'data'))
    const write = (name: string, value: unknown) =>
      writeFileSync(join(root, 'data', name), JSON.stringify(value))
    writeFileSync(join(root, 'data', 'hit.wav'), wavBytes(new Float32Array(320)))
    write('hit.audio-event.json', {
      bus: 'dice',
      layers: [{ id: 'hit', choices: [{ clip: { path: 'data/hit.wav' } }] }],
    })
    write('crit.dice-effect.json', {
      id: 'crit',
      effects: [{ kind: 'sound-accent', event: { path: 'data/hit.audio-event.json' } }],
    })
    write('skin.dice-skin.json', {
      id: 'lazy',
      sounds: { impactEvent: { path: 'data/hit.audio-event.json' } },
      effects: [{ path: 'data/crit.dice-effect.json' }],
    })
    const world = new World()
    const server = new AssetServer(world).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    expect((await server.scan()).failed).toEqual([])
    await server.load('data/skin.dice-skin.json')
    const skin = world.resource(DiceSkin.store).get(server.resolve('data/skin.dice-skin.json'))!
    expect(skin.sounds.impactEvent!.guid).toBeTruthy()
    expect(world.tryResource(AudioEvent.store)?.get(skin.sounds.impactEvent!)).toBeUndefined()
    await server.load(skin.effects[0]!)
    const recipe = world.resource(DiceEffectRecipe.store).get(skin.effects[0]!)!
    expect(world.tryResource(AudioEvent.store)?.get(recipe.effects[0]!.event!)).toBeUndefined()
    expect(world.tryResource(AudioClips)?.get(server.resolve('data/hit.wav'))).toBeUndefined()
    // Ordinary explicit loading still works; dependency GUID metadata was retained.
    await server.load(skin.sounds.impactEvent!)
    expect(world.resource(AudioEvent.store).get(skin.sounds.impactEvent!)).toBeDefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
