import { findEntityByPath } from '@aethervtt/shard-scene'
import { tileAt } from '@aethervtt/shard-sprite'
import { expect, test } from '@aethervtt/shard-testing'

type Vec3 = [number, number, number]
const at = (game: { get(e: string, c: string): unknown }, path: string) =>
  (game.get(path, 'core/Transform') as { translation: Vec3 }).translation

test('the maze connects the enemy to the player', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.step(1)
  const path = await game.nav.path(at(game, 'enemy'), at(game, 'player'))
  expect(path.status).toBe('complete')
  // Corridors, not a straight line: many corners, far longer than the 22 m between them.
  expect(path.corners.length).toBeGreaterThan(8)
  expect(path.length).toBeGreaterThan(28)
})

test('the enemy chases the running player through the maze and catches them', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  const world = game.app.world
  // Frame 1 builds the grid from the tilemap; the enemy sets off on frame 2.
  await game.step(2)
  expect(await game.nav.agent('enemy')).toMatchObject({ status: 'moving' })
  const maze = findEntityByPath(world, 'maze')!
  const start = at(game, 'player')
  // The player runs up the east corridor while the enemy is on its way.
  game.input.hold('maze-chase/Controls.up')
  let caught = false
  for (let f = 0; f < 60 * 30 && !caught; f += 10) {
    await game.step(10)
    if (f === 90) game.input.release('maze-chase/Controls.up')
    // Never inside a wall.
    const [x, y] = at(game, 'enemy')
    expect(tileAt(world, maze, Math.floor(x), Math.floor(15 - y), 'walls')).toBe(0)
    caught = (game.get('enemy', 'maze-chase/Enemy') as { caught: boolean }).caught
  }
  // The player really moved: six cells up the corridor.
  expect(at(game, 'player')[1]).toBeGreaterThan(start[1] + 4)
  expect(caught).toBe(true)
  expect(await game.nav.agent('enemy')).toMatchObject({ status: 'idle' })
})
