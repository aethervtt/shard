import { loadAll } from '@shard/assets'
import { expect, test } from '@shard/testing'
import { Weapon } from '../scripts/main'

test('holding thrust flies the ship forward', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  game.input.hold('star-explorer/Controls.thrust')
  await game.step(120)
  const ship = game.get('ship', 'star-explorer/Ship')
  expect(ship.speed).toBeGreaterThan(10)
  expect(game.get('ship', 'core/Transform').translation[2]).toBeLessThan(-10)
  await game.screenshot('thrust.png')
})

test('the ship coasts to a stop without thrust', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.step(60)
  expect(game.get('ship', 'star-explorer/Ship').speed).toBe(0)
})

test('the ship carries a laser; the heavy laser is a variant of it', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  const world = game.app.world
  const weapons = world.resource(Weapon.store)
  const laser = weapons.get(game.get('ship', 'star-explorer/Ship').weapon as { guid: string })
  expect(laser).toMatchObject({ damage: 12, fireRate: 5, energyCost: 1 })
  const heavy = weapons.get(laser?.upgradesTo)
  // Its own damage, energy cost, and color; the laser's fire rate.
  expect(heavy).toMatchObject({ damage: 30, fireRate: 5, energyCost: 3, upgradesTo: null })
  expect((await loadAll(world, Weapon)).length).toBe(2)
})
