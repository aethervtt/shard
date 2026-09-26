import { expect, test } from '@shard/testing'

test('the boulder prefab uses its generator file; the field spawns generated rocks', async ({
  game,
}) => {
  await game.load('scenes/rocks.scene.json')
  expect(game.get('boulder', 'render/Mesh3d').mesh).toMatchObject({
    path: 'generators/boulder.gen.json',
  })
  const rock = game.get('field/rock-0', 'render/Mesh3d').mesh as { path: string }
  expect(rock.path).toMatch(/^procedural:star-explorer\/Rock\?/)
  const summary = await game.call<{ vertices: number; triangles: number }>('procgen.run', {
    generator: 'generators/boulder.gen.json',
  })
  expect(summary).toMatchObject({ vertices: 2562, triangles: 5120 })
  await game.screenshot('rocks.png')
})

test('a new seed regenerates the field and keeps the rocks at unchanged paths', async ({
  game,
}) => {
  await game.load('scenes/rocks.scene.json')
  const before = await game.entity('field/rock-3')
  await game.patch('field', { 'procgen/GeneratorInstance': { seed: 99 } })
  await game.call('procgen.run', {
    generator: 'star-explorer/AsteroidField',
    seed: 99,
    params: { count: 24, radius: 14, material: { path: 'assets/materials/stone.material.json' } },
  })
  await game.step(1)
  const after = await game.entity('field/rock-3')
  expect(after['core/Transform']).not.toEqual(before['core/Transform'])
})
