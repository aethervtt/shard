import { expect, test } from '@shard/testing'

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
