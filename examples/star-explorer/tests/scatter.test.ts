import { expect, test } from '@aethervtt/shard-testing'

interface Described {
  surfaces: {
    ready: boolean
    problem: unknown
    rules: { name: string; id: string; kind: string; spawned?: number }[]
  }[]
}

interface Sampled {
  count: number
  placements: { rule: string; item: string; distance: number }[]
}

test('the planet scatters its biomes’ sets around the lander, from the same CPU placement scatter.sample reads', async ({
  game,
}) => {
  await game.load('scenes/planet.scene.json')
  // Item meshes are generated on the worker pool: step until the props have spawned.
  let described: Described | undefined
  for (let i = 0; i < 300; i++) {
    await game.step(1)
    await new Promise((r) => setTimeout(r, 5))
    described = await game.call<Described>('scatter.describe')
    const s = described.surfaces[0]
    if (s?.ready && s.rules.some((r) => (r.spawned ?? 0) > 0)) break
  }
  const surface = described!.surfaces[0]!
  expect(surface.problem).toBeNull()
  expect(surface.rules.map((r) => r.id.split(':').at(-1))).toEqual([
    'boulders',
    'bushes',
    'grass',
    'trees',
    'bushes',
    'grass',
    'boulders',
    'crystals',
  ])
  expect(surface.rules.filter((r) => r.kind === 'foliage')).toHaveLength(2)
  const spawned = surface.rules.reduce((n, r) => n + (r.spawned ?? 0), 0)
  expect(spawned).toBeGreaterThan(0)
  // The lander stands on polar snow (no set); the rock biome's boulders start about 160 m away.
  const near = await game.call<Sampled>('scatter.sample', { entity: 'planet/lander', radius: 250 })
  expect(near.count).toBeGreaterThan(0)
  expect(near.placements[0]!.item).toBe('shard/Rock')
  expect(near.placements[0]!.distance).toBeGreaterThan(100)
  expect(near.placements[0]!.distance).toBeLessThanOrEqual(250)
})
