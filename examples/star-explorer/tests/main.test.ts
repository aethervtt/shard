import { loadAll } from '@aethervtt/shard-assets'
import { expect, test } from '@aethervtt/shard-testing'
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

test('firing plays the laser sound at the ship', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.patch('ship', { 'core/Transform': { translation: [3, -2, 7] } })
  game.input.hold('star-explorer/Controls.fire')
  // Half a second at 5 shots a second: shots at 0, 0.2, and 0.4 s.
  await game.step(30)
  game.input.release('star-explorer/Controls.fire')
  const shots = (await game.audioLog()).filter((e) => e.event === 'start')
  expect(shots).toHaveLength(3)
  for (const shot of shots) {
    expect(shot).toMatchObject({ clip: 'assets/sfx/laser.ogg', bus: 'sfx', position: [3, -2, 7] })
  }
  // The listener rides behind the ship, so the shot is centered and close.
  expect(shots[0]!.pan).toBeCloseTo(0, 3)
  expect(shots[0]!.gain).toBeGreaterThan(0.1)
  const describe = await game.call('audio.describe')
  expect(describe.listener.path).toBe('ship/camera')
})

test('the HUD shows speed and the planet marker, and the scan toggle clicks by path', async ({
  game,
}) => {
  await game.load('scenes/main.scene.json')
  game.input.hold('star-explorer/Controls.thrust')
  await game.step(60)
  game.input.release('star-explorer/Controls.thrust')
  await game.step(1)
  const speed = Math.round(game.get('ship', 'star-explorer/Ship').speed as number)
  expect(await game.ui.node('hud/speed/value')).toMatchObject({
    text: `${speed} m/s`,
    visible: true,
  })
  const marker = await game.ui.node('planet-marker')
  expect(marker).toMatchObject({ anchor: 'on-screen', visible: true })
  expect(marker!.distance).toBeGreaterThan(100)
  expect(await game.ui.node('planet-marker/distance')).toMatchObject({
    text: `${Math.round(marker!.distance as number)} m`,
  })
  await game.ui.click('scan')
  await game.step(1)
  expect(await game.ui.node('scan')).toMatchObject({ widget: 'toggle', on: true })
  expect(await game.ui.node('scan/label')).toMatchObject({ text: 'Scanning' })
})

test('loading a save puts the ship back where it was saved', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  game.input.hold('star-explorer/Controls.thrust')
  await game.step(60)
  game.input.release('star-explorer/Controls.thrust')
  await game.step(1)
  const saved = game.get('ship', 'core/Transform').translation as number[]
  const speed = game.get('ship', 'star-explorer/Ship').speed as number
  const described = await game.saves.write('slot1', { label: 'Leaving orbit' })
  expect(described.scenes['scenes/main.scene.json'].changed.ship).toEqual(
    expect.arrayContaining(['core/Transform', 'star-explorer/Ship']),
  )
  // Keep flying, then load.
  await game.step(120)
  expect(game.get('ship', 'core/Transform').translation).not.toEqual(saved)
  const report = await game.saves.load('slot1')
  expect(report.warnings).toEqual([])
  expect(game.get('ship', 'core/Transform').translation).toEqual(saved)
  expect(game.get('ship', 'star-explorer/Ship').speed).toBe(speed)
})

test('an edited save is a test fixture: a ship already at full speed', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  const save = await game.saves.read()
  save.scenes['scenes/main.scene.json'].changed.ship = { 'star-explorer/Ship': { speed: 40 } }
  await game.saves.load(save)
  expect(game.get('ship', 'star-explorer/Ship').speed).toBe(40)
})

test('the HUD speaks Portuguese', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.step(1)
  expect(await game.ui.node('hud/speed/caption')).toMatchObject({ key: 'hud.speed', text: 'SPEED' })
  await game.locale('pt-BR')
  await game.step(1)
  expect(await game.ui.node('hud/speed/caption')).toMatchObject({ text: 'VELOCIDADE' })
  expect(await game.ui.node('hud/scan/label')).toMatchObject({ text: 'Escanear' })
  // The choice is kept in the player's settings.
  expect(await game.settings.get()).toMatchObject({ locale: 'pt-BR' })
})
