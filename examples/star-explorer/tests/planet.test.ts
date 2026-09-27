import { expect, test } from '@shard/testing'

interface Described {
  planets: {
    ready: boolean
    maxDepth: number
    colliderDepth: number
    colliders: { chunks: number; active: number; anchors: number }
  }[]
}

interface Sampled {
  samples: { height: number; underwater: boolean; biome: number }[]
}

test('the planet loads its graphs and biomes, keeps colliders under the lander, and has sea and polar snow', async ({
  game,
}) => {
  await game.load('scenes/planet.scene.json')
  await game.step(10)
  const { planets } = await game.call<Described>('terrain.describe')
  expect(planets).toHaveLength(1)
  expect(planets[0]).toMatchObject({ ready: true, maxDepth: 17, colliders: { anchors: 1 } })
  expect(planets[0]!.colliders.active).toBeGreaterThan(0)
  // The equator and mid-latitudes have both land and sea; the pole is snow.
  const lats: number[][] = []
  for (let lon = -180; lon < 180; lon += 10) lats.push([0, lon], [30, lon])
  const { samples } = await game.call<Sampled>('terrain.sample', { latlon: lats })
  expect(samples.some((s) => s.underwater)).toBe(true)
  expect(samples.some((s) => !s.underwater)).toBe(true)
  // Snow (biome 4) covers much of the polar ring and none of the equator.
  const ring: number[][] = []
  for (let lon = -180; lon < 180; lon += 10) ring.push([85, lon])
  const polar = (await game.call<Sampled>('terrain.sample', { latlon: ring })).samples
  const snowy = (list: Sampled['samples']) =>
    list.filter((s) => !s.underwater && s.biome === 4).length
  expect(snowy(polar)).toBeGreaterThan(polar.length / 3)
  expect(snowy(samples.filter((_, i) => i % 2 === 0))).toBe(0)
})

interface Sky {
  luminance: number
  transmittance: number[]
  inside: boolean
  altitude: number
}

test('the planet has an atmosphere: a blue sky over the lander that thins to space above it', async ({
  game,
}) => {
  await game.load('scenes/planet.scene.json')
  await game.step(2)
  const up = [0, 1, 0]
  const low = await game.call<Sky>('atmosphere.sample', { direction: up })
  expect(low.inside).toBe(true)
  // 600 km radius (the Planet's), 40 km of air.
  const high = await game.call<Sky>('atmosphere.sample', {
    position: [0, 300 * 2000 + 45_000 - 600_000, 0],
    direction: up,
  })
  expect(high.inside).toBe(false)
  expect(high.luminance).toBe(0)
  // A 10 000 lux 'daylight' sun 30° up: tens of cd/m² overhead.
  expect(low.luminance).toBeGreaterThan(30)
  expect(low.transmittance[2]).toBeLessThan(low.transmittance[0]!)
})
